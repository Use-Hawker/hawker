// HAWKER gateway on Robinhood Chain: APIs sold to AI agents per call, paid in USDG through HawkerTill.
//   GET  /v1                     the till, USDG, the fee, the minimum price
//   GET  /v1/stalls, /v1/stalls/:slug   the catalog: house stalls and the ones sellers listed
//   POST /v1/stalls              a seller opens, changes or closes a stall, signed with the payout wallet
//   POST /v1/call/:slug          no X-Payment header -> 402 with what to sign; with it -> the result and the receipt
//   POST /v1/demo/:slug          a free call to a house stall, limited per day
//   GET  /v1/ledger, /v1/stats   settled payments, each with its transaction
// HAWKER never holds the money: the buyer signs a USDG authorization to the till, the gateway runs the call,
// then lands the payment on chain, and the seller is paid in that transaction. A call that fails is not charged.
import { createWalletClient, http, decodeEventLog, recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, client, addr, USDG, CHAIN_ID, EXPLORER, TILL_ABI, toUnits, fromUnits, nonceFor, newRef, decodePayment, signerOf, toStruct, stallMessage, publicUrl } from '../../core/hawker.mjs';
import { HOUSE, houseBy, checkInput } from './stalls.js';

export const VERSION = '0.1.0';
const CORS = {
  'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-payment',
  'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'x-payment-response',
};
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), {
  status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
});
const stop = (status, code, message, extra = {}) => ({ status, body: { error: { code, message }, ...extra } });
const fail = (status, code, message) => json({ error: { code, message } }, status);

const SLUG = /^[a-z0-9][a-z0-9-]{2,31}$/;
const MAX_BODY = 64 * 1024, MAX_REPLY = 1024 * 1024, MAX_PRICE = 100;
const minPrice = (env) => Number(env.MIN_PRICE || 0.02);
const till = (env) => (env.TILL ? addr(env.TILL) : null);
const gasAccount = (env) => (env.GAS_KEY ? privateKeyToAccount(env.GAS_KEY.startsWith('0x') ? env.GAS_KEY : `0x${env.GAS_KEY}`) : null);
const changed = (r) => (r.meta?.changes ?? r.changes ?? 0) > 0;
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------- the catalog ----------
const houseStall = (env, s) => ({ ...s, house: true, seller: env.HOUSE_PAY_TO ? addr(env.HOUSE_PAY_TO) : null, value: toUnits(s.price) });
const sellerStall = (r) => ({ slug: r.slug, name: r.name, summary: r.summary, docs: r.docs, house: false, seller: r.pay_to, value: BigInt(r.value), url: r.url, secret: r.secret, at: r.at });
async function stallBy(env, slug) {
  const h = houseBy(slug);
  if (h) return houseStall(env, h);
  const r = await env.DB.prepare('SELECT * FROM stalls WHERE slug = ? AND open = 1 AND hidden = 0').bind(slug).first();
  return r ? sellerStall(r) : null;
}
const show = (s, origin) => ({
  slug: s.slug, name: s.name, summary: s.summary, priceUsd: fromUnits(s.value), value: s.value, seller: s.seller, house: s.house,
  call: `${origin}/v1/call/${s.slug}`,
  ...(s.house ? { input: s.input.map(({ pattern, ...f }) => f), demo: `${origin}/v1/demo/${s.slug}` } : { docs: s.docs || null, listedAt: s.at }),
});
async function catalog(env, origin) {
  const { results } = await env.DB.prepare('SELECT * FROM stalls WHERE open = 1 AND hidden = 0 ORDER BY at DESC LIMIT 200').all();
  return [...HOUSE.map((s) => houseStall(env, s)), ...results.map(sellerStall)].map((s) => show(s, origin));
}

// ---------- a seller's stall ----------
async function bump(env, kind, who) {
  const day = new Date().toISOString().slice(0, 10);
  const r = await env.DB.prepare('INSERT INTO uses (day, who, kind, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, who, kind) DO UPDATE SET n = n + 1 RETURNING n').bind(day, who, kind).first();
  return r.n;
}
async function visitor(request) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${new Date().toISOString().slice(0, 10)}:${ip}`))).slice(0, 12));
}

async function listStall(request, env, body, origin) {
  const slug = String(body.slug || ''), name = String(body.name || '').trim(), summary = String(body.summary || '').trim(), docs = String(body.docs || '').trim();
  const open = body.open !== false, price = Number(body.priceUsd), at = Number(body.at);
  if (!SLUG.test(slug)) return fail(400, 'invalid_slug', '3 to 32 characters: a-z, 0-9 and dashes.');
  if (houseBy(slug)) return fail(409, 'slug_taken', 'That name belongs to a house stall.');
  if (!name || name.length > 60 || !summary || summary.length > 200 || docs.length > 2000) return fail(400, 'invalid_text', 'name up to 60, summary up to 200, docs up to 2000 characters.');
  if (!(price >= minPrice(env) && price <= MAX_PRICE) || toUnits(price) !== toUnits(price.toFixed(6))) return fail(400, 'invalid_price', `Price per call is ${minPrice(env)} to ${MAX_PRICE} USDG.`);
  const url = publicUrl(body.url, env.ALLOW_HTTP_UPSTREAM === '1');
  if (!url) return fail(400, 'invalid_url', 'The stall URL must be https on a public host.');
  let payTo;
  try { payTo = addr(body.payTo); } catch { return fail(400, 'invalid_pay_to', 'payTo is the wallet that gets paid.'); }
  if (!(Math.abs(Date.now() / 1000 - at) < 600)) return fail(400, 'stale', 'Sign again: `at` is unix seconds, within ten minutes of now.');
  const signer = await recoverMessageAddress({ message: stallMessage({ slug, url: body.url, priceUsd: body.priceUsd, payTo: body.payTo, open, at }), signature: body.signature }).catch(() => null);
  if (signer !== payTo) return fail(401, 'bad_signature', 'Sign the stall message with the payout wallet.');

  const old = await env.DB.prepare('SELECT pay_to, secret, hidden, updated FROM stalls WHERE slug = ?').bind(slug).first();
  if (old && old.pay_to !== payTo) return fail(403, 'not_yours', 'That stall belongs to another wallet.');
  if (old && at * 1000 <= old.updated) return fail(400, 'stale', 'A newer signed change is already in.');
  if (!old && await bump(env, 'list', await visitor(request)) > Number(env.LIST_PER_DAY || 5)) return fail(429, 'too_many', 'Too many new stalls from here today.');
  const secret = old && !body.rotate ? old.secret : hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare(`INSERT INTO stalls (slug, name, summary, docs, url, value, pay_to, secret, open, hidden, at, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11)
    ON CONFLICT (slug) DO UPDATE SET name = ?2, summary = ?3, docs = ?4, url = ?5, value = ?6, secret = ?8, open = ?9, updated = ?11`)
    .bind(slug, name, summary, docs, String(url), Number(toUnits(price)), payTo, secret, open ? 1 : 0, Date.now(), at * 1000).run();
  return json({
    slug, open, hidden: !!old?.hidden, call: `${origin}/v1/call/${slug}`,
    // shown when the stall is made or the secret is rotated: the seller checks X-Hawker-Signature with it
    ...(!old || body.rotate ? { signingSecret: secret } : {}),
  }, old ? 200 : 201);
}

// ---------- a call ----------
const quote = (env, s) => ({
  error: { code: 'payment_required', message: 'Sign the payment and send the same request again with it in the X-Payment header.' },
  accepts: [{
    scheme: 'hawker-till', chainId: CHAIN_ID, asset: USDG, till: till(env), seller: s.seller, value: s.value, priceUsd: fromUnits(s.value),
    ref: newRef(), validSeconds: 300,
    sign: { domain: { name: 'Global Dollar', version: '1', chainId: CHAIN_ID, verifyingContract: USDG }, primaryType: 'ReceiveWithAuthorization', to: till(env), nonce: 'keccak256(abi.encode(seller, ref))' },
  }],
});

async function forward(env, s, raw, p) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(s.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${raw}`))));
  const r = await fetch(s.url, {
    method: 'POST', body: raw, redirect: 'manual', signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json', 'x-hawker-timestamp': ts, 'x-hawker-call': p.ref, 'x-hawker-buyer': p.from, 'x-hawker-signature': `sha256=${mac}` },
  }).catch(() => null);
  if (!r) return { ok: false, status: 502, code: 'seller_unreachable' };
  const text = (await r.text().catch(() => '')).slice(0, MAX_REPLY + 1);
  if (text.length > MAX_REPLY) return { ok: false, status: 502, code: 'reply_too_large' };
  let result = text;
  try { result = JSON.parse(text); } catch { /* plain text is a fine answer */ }
  if (r.status < 200 || r.status > 299) return { ok: false, status: r.status >= 500 || r.status < 400 ? 502 : r.status, code: r.status >= 400 && r.status < 500 ? 'seller_refused' : 'seller_failed', result };
  return { ok: true, result };
}

// Lands the payment. USDG answers a spent authorization with success and moves nothing, so only the Paid event counts.
async function land(env, pub, gas, struct) {
  const wallet = createWalletClient({ account: gas, chain, transport: http(env.RH_RPC_URL) });
  const write = () => wallet.writeContract({ address: till(env), abi: TILL_ABI, functionName: 'settle', args: [struct] });
  // two calls landing at once can pick the same nonce; the second one tries again
  const hash = await write().catch((e) => (/nonce|already known|underpriced/i.test(e.message) ? write() : Promise.reject(e)));
  const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 300, timeout: 30000 });
  const paid = receipt.logs.filter((l) => l.address.toLowerCase() === till(env).toLowerCase())
    .map((l) => { try { return decodeEventLog({ abi: TILL_ABI, data: l.data, topics: l.topics }); } catch { return null; } })
    .find((e) => e?.eventName === 'Paid' && e.args.ref === struct.ref);
  return receipt.status === 'success' && paid ? { tx: hash, fee: paid.args.fee, block: receipt.blockNumber } : null;
}

async function paidCall(env, s, raw, input, p) {
  const started = Date.now(), now = BigInt(Math.floor(started / 1000));
  const gas = gasAccount(env);
  if (!till(env) || !gas || !s.seller) return stop(503, 'not_open', 'The till is not set up yet.');
  if (p.seller !== s.seller) return stop(402, 'wrong_seller', 'The payment names another seller.');
  if (p.value !== s.value) return stop(402, 'wrong_value', `This call costs exactly ${s.value} USDG units.`);
  if (p.validAfter > now || p.validBefore < now + 20n) return stop(402, 'expired', 'The payment is outside its time window. Sign a new one.');
  if (await signerOf(p, till(env)).catch(() => null) !== p.from) return stop(402, 'bad_signature', 'The signature is not from the paying wallet.');

  // one payment buys one result, even when it arrives twice at once
  const claim = `${p.from.toLowerCase()}:${nonceFor(p.seller, p.ref)}`;
  if (!changed(await env.DB.prepare('INSERT OR IGNORE INTO claims (key, at) VALUES (?, ?)').bind(claim, started).run())) return stop(402, 'payment_used', 'That payment was already used. Sign a new one.');
  const release = () => env.DB.prepare('DELETE FROM claims WHERE key = ?').bind(claim).run();

  const pub = client(env.RH_RPC_URL), struct = toStruct(p);
  try {
    await pub.simulateContract({ address: till(env), abi: TILL_ABI, functionName: 'settle', args: [struct], account: gas.address });
  } catch (e) {
    await release();
    const spent = /NotPaid/.test(e.message);
    return stop(402, spent ? 'payment_used' : 'would_not_settle', spent ? 'That payment was already used. Sign a new one.' : 'The payment would not go through: check the wallet\'s USDG balance.');
  }

  let result;
  if (s.house) {
    try { result = await s.run(env, input); } catch (e) {
      await release();
      if (e.input) return stop(422, e.message, 'Not charged.');
      console.error('house stall failed:', s.slug, e.message);
      return stop(502, 'stall_failed', 'A data source failed. Not charged.');
    }
  } else {
    const f = await forward(env, s, raw, p);
    if (!f.ok) {
      await release();
      return stop(f.status, f.code, 'The seller did not answer the call. Not charged.', f.result === undefined ? {} : { sellerReply: f.result });
    }
    result = f.result;
  }

  // the result leaves only after the money has reached the seller
  let landed;
  try { landed = await land(env, pub, gas, struct); } catch (e) { console.error('settle failed:', e.message); }
  if (!landed) return stop(402, 'settle_failed', 'The payment did not land. No result returned.');
  const ms = Date.now() - started;
  const own = (env.OWN_PAYERS || '').toLowerCase().split(',').includes(p.from.toLowerCase()) ? 1 : 0;
  await env.DB.prepare('INSERT OR IGNORE INTO payments (tx, stall, house, seller, buyer, value, fee, own, ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(landed.tx, s.slug, s.house ? 1 : 0, s.seller, p.from, Number(p.value), Number(landed.fee), own, ms, Date.now()).run();
  const receipt = { tx: landed.tx, explorer: `${EXPLORER}/tx/${landed.tx}`, chainId: CHAIN_ID, asset: 'USDG', paidUsd: fromUnits(p.value), sellerGotUsd: fromUnits(p.value - landed.fee), feeUsd: fromUnits(landed.fee), buyer: p.from, seller: s.seller, ref: p.ref, ms };
  return { status: 200, receipt, body: { stall: s.slug, result, receipt } };
}

async function call(request, env, slug) {
  const s = await stallBy(env, slug);
  if (!s) return fail(404, 'unknown_stall', 'No such stall.');
  const raw = await request.text();
  if (raw.length > MAX_BODY) return fail(413, 'too_large', 'The request body is over 64 KB.');
  let body = {};
  try { if (raw) body = JSON.parse(raw); } catch { return fail(400, 'invalid_json', 'Send JSON. Not charged.'); }
  let input = body;
  if (s.house) {
    const c = checkInput(s, body);
    if (c.error) return fail(400, c.error, 'Check your input. Not charged.');
    input = c.input;
  }
  const header = request.headers.get('x-payment');
  if (!header) return json(quote(env, s), 402);
  const p = decodePayment(header);
  if (!p) return fail(402, 'bad_payment', 'Could not read the X-Payment header.');
  const out = await paidCall(env, s, raw || '{}', input, p);
  return json(out.body, out.status, out.receipt ? { 'x-payment-response': btoa(JSON.stringify(out.receipt)) } : {});
}

// Lets a visitor see a real answer with no wallet. House stalls only, limited per visitor and per day.
async function demo(request, env, slug) {
  const h = houseBy(slug);
  if (!h) return fail(403, 'not_in_demo', 'Only house stalls have a free demo.');
  const c = checkInput(h, await request.json().catch(() => ({})));
  if (c.error) return fail(400, c.error, 'Check your input.');
  if (await bump(env, 'demo', '*') > Number(env.DEMO_PER_DAY || 500)) return fail(429, 'demo_full', 'Demo calls are used up for today.');
  if (await bump(env, 'demo', await visitor(request)) > Number(env.DEMO_PER_IP || 10)) return fail(429, 'demo_limit', 'Demo limit reached for today.');
  try { return json({ stall: slug, demo: true, result: await h.run(env, c.input) }); } catch (e) {
    if (e.input) return fail(422, e.message, 'Check your input.');
    console.error('demo failed:', slug, e.message);
    return fail(502, 'stall_failed', 'A data source failed.');
  }
}

async function stats(env) {
  const r = await env.DB.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(value), 0) value, COALESCE(SUM(value - fee), 0) toSellers, COUNT(DISTINCT buyer) buyers,
    COALESCE(SUM(CASE WHEN own = 0 THEN 1 ELSE 0 END), 0) outside, COALESCE(SUM(CASE WHEN house = 0 THEN 1 ELSE 0 END), 0) toOutsideSellers FROM payments`).first();
  const listed = await env.DB.prepare('SELECT COUNT(*) n FROM stalls WHERE open = 1 AND hidden = 0').first();
  return {
    houseStalls: HOUSE.length, sellerStalls: listed.n, paidCalls: r.calls, volumeUsd: fromUnits(r.value), paidToSellersUsd: fromUnits(r.toSellers), buyers: r.buyers,
    // calls not made by the team's own wallets, and calls that paid a seller other than the house
    outsideCalls: r.outside, callsToSellerStalls: r.toOutsideSellers, token: env.TOKEN_ADDRESS || null,
  };
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/', { origin } = url;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const post = request.method === 'POST';

  if (path === '/v1') {
    return json({
      name: 'HAWKER', version: VERSION, chainId: CHAIN_ID, asset: USDG, till: till(env), settler: gasAccount(env)?.address || null,
      feeBps: Number(env.FEE_BPS || 300), minPriceUsd: minPrice(env), token: env.TOKEN_ADDRESS || null,
      endpoints: ['/v1/stalls', '/v1/stalls/:slug', '/v1/call/:slug', '/v1/demo/:slug', '/v1/ledger', '/v1/stats'],
    });
  }
  if (path === '/v1/stalls') {
    if (post) return listStall(request, env, await request.json().catch(() => ({})), origin);
    return json({ data: await catalog(env, origin) });
  }
  const one = path.match(/^\/v1\/stalls\/([a-z0-9-]+)$/);
  if (one) {
    const s = await stallBy(env, one[1]);
    return s ? json(show(s, origin)) : fail(404, 'unknown_stall', 'No such stall.');
  }
  const c = path.match(/^\/v1\/(call|demo)\/([a-z0-9-]+)$/);
  if (c) {
    if (!post) return fail(405, 'use_post', 'POST JSON here.');
    return c[1] === 'demo' ? demo(request, env, c[2]) : call(request, env, c[2]);
  }
  if (path === '/v1/stats') return json(await stats(env));
  if (path === '/v1/ledger') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const { results } = await env.DB.prepare('SELECT tx, stall, house, seller, buyer, value, fee, own, ms, at FROM payments ORDER BY at DESC LIMIT ?').bind(limit).all();
    return json({ data: results.map((r) => ({ ...r, house: !!r.house, own: !!r.own, paidUsd: fromUnits(r.value), feeUsd: fromUnits(r.fee), explorer: `${EXPLORER}/tx/${r.tx}` })) });
  }
  // takes a stall off the catalog; its owner cannot bring it back
  if (path === '/v1/admin/hide' && post) {
    if (!env.ADMIN_KEY || request.headers.get('x-admin-key') !== env.ADMIN_KEY) return fail(401, 'no', 'Not allowed.');
    const b = await request.json().catch(() => ({}));
    const r = await env.DB.prepare('UPDATE stalls SET hidden = ? WHERE slug = ?').bind(b.hidden === false ? 0 : 1, String(b.slug || '')).run();
    return json({ slug: b.slug, changed: changed(r) });
  }
  if (path.startsWith('/v1')) return fail(404, 'not_found', 'Nothing here.');
  return env.ASSETS ? env.ASSETS.fetch(request) : fail(404, 'not_found', 'Nothing here.');
}

export default {
  async fetch(request, env) {
    try { return await route(request, env); } catch (e) {
      if (e.status) return fail(e.status, 'bad_request', e.message);
      console.error(e);
      return fail(500, 'server_error', 'Something failed. Not charged.');
    }
  },
};
