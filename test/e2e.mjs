// End to end on a Hardhat fork of Robinhood Chain: the till on chain with the real USDG, the gateway in this process
// on SQLite, a seller's API on localhost, and buyers signing real payments.
// Start the fork first: cd contracts && npx hardhat node --config hardhat.config.cjs --port 8548
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { createPublicClient, createWalletClient, http as viemHttp, parseEther, parseUnits, keccak256, encodeAbiParameters, toHex, pad, erc20Abi, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { chain as rhChain, USDG, signPayment, encodePayment, stallMessage, toStruct } from '../core/hawker.mjs';
import worker from '../worker/src/index.js';
import { sqliteD1 } from '../worker/d1-sqlite.mjs';

const RPC = process.env.RPC || 'http://127.0.0.1:8548';
const { abi, bytecode } = JSON.parse(readFileSync(new URL('../contracts/build/HawkerTill.json', import.meta.url)));
const chain = { ...rhChain, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: viemHttp(RPC) });
const raw = (method, params = []) => pub.request({ method, params });
let fails = 0;
const ok = (name, good, detail = '') => { if (!good) fails++; console.log(`${good ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`); };
const usd = (n) => parseUnits(String(n), 6);
const wallet = async (eth = '10') => {
  const key = generatePrivateKey(), account = privateKeyToAccount(key);
  if (eth !== '0') await raw('hardhat_setBalance', [account.address, toHex(parseEther(eth))]);
  return { key, account, address: account.address, w: createWalletClient({ account, chain, transport: viemHttp(RPC) }) };
};
const bal = (a) => pub.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
// USDG balances live in mapping slot 1
const give = (who, amount) => raw('hardhat_setStorageAt', [USDG, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, 1n])), pad(toHex(amount))]);

// ---- chain side: the till at 3%, wallets
const [deployer, settler, buyer, poor, seller, thief] = await Promise.all([wallet(), wallet(), wallet('0'), wallet('0'), wallet('0'), wallet('0')]);
const sink = privateKeyToAccount(generatePrivateKey()).address, house = privateKeyToAccount(generatePrivateKey()).address;
const till = getAddress((await pub.waitForTransactionReceipt({ hash: await deployer.w.deployContract({ abi, bytecode, args: [USDG, sink, 300n] }) })).contractAddress);
await give(buyer.address, usd(10));
ok('setup: till deployed, buyer holds 10 USDG and no ETH', (await bal(buyer.address)) === usd(10) && (await pub.getBalance({ address: buyer.address })) === 0n, till);

// ---- a seller's API on localhost: checks the gateway's signature, can be switched to fail
const PORT = 8861;
let sellerMode = 'ok', sellerSecret = '', lastSeen = null;
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  const ts = req.headers['x-hawker-timestamp'];
  const good = req.headers['x-hawker-signature'] === `sha256=${createHmac('sha256', sellerSecret).update(`${ts}.${body}`).digest('hex')}` && Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  lastSeen = { good, body, buyer: req.headers['x-hawker-buyer'], call: req.headers['x-hawker-call'], path: req.url };
  if (!good) { res.writeHead(401); return res.end('bad signature'); }
  if (sellerMode === 'down') { res.writeHead(503); return res.end('down'); }
  if (sellerMode === 'refuse') { res.writeHead(422, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'no such city' })); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ city: JSON.parse(body).city, tempC: 21 }));
}).listen(PORT);

// ---- the gateway
const env = {
  DB: sqliteD1(':memory:'), RH_RPC_URL: RPC, TILL: till, GAS_KEY: settler.key, HOUSE_PAY_TO: house, FEE_BPS: '300', MIN_PRICE: '0.02',
  ALLOW_HTTP_UPSTREAM: '1', DEMO_PER_IP: '3', DEMO_PER_DAY: '500', LIST_PER_DAY: '5', ADMIN_KEY: 'admin-test',
};
const api = async (method, path, { body, payment, headers = {} } = {}) => {
  const r = await worker.fetch(new Request(`https://hawker.test${path}`, {
    method, headers: { 'content-type': 'application/json', ...(payment ? { 'x-payment': typeof payment === 'string' ? payment : encodePayment(payment) } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }), env);
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};
const code = (r) => r.body?.error?.code;
// what an agent does: ask, read the quote, sign it
const payFor = async (who, slug, body, over = {}) => {
  const q = (await api('POST', `/v1/call/${slug}`, { body })).body.accepts[0];
  return signPayment(who.account, { till: q.till, seller: q.seller, value: q.value, ref: q.ref, ...over });
};

// 1 the catalog
{
  const info = await api('GET', '/v1');
  ok('1a /v1 names the till, USDG, the settler and the fee', info.body.till === till && info.body.asset === USDG && info.body.settler === settler.address && info.body.feeBps === 300 && info.body.minPriceUsd === 0.02);
  const list = (await api('GET', '/v1/stalls')).body.data;
  ok('1b five house stalls, paid to the house wallet', list.length === 5 && list.every((s) => s.house && s.seller === house && s.priceUsd >= 0.02), list.map((s) => s.slug).join(' '));
  ok('1c one stall by name, an unknown one is 404', (await api('GET', '/v1/stalls/rh-wallet')).body.value === '20000' && (await api('GET', '/v1/stalls/nope')).status === 404);
}

// 2 a paid call to a house stall
{
  const input = { address: buyer.address };
  const q = await api('POST', '/v1/call/rh-wallet', { body: input });
  const a = q.body.accepts?.[0];
  ok('2a no payment: 402 with what to sign', q.status === 402 && a.till === till && a.seller === house && a.value === '20000' && /^0x[0-9a-f]{64}$/.test(a.ref) && a.asset === USDG);
  ok('2b bad input is refused before any payment is asked', (await api('POST', '/v1/call/rh-wallet', { body: { address: 'x' } })).status === 400 && (await api('POST', '/v1/call/rh-wallet', { body: '{' })).status === 400);
  const p = await signPayment(buyer.account, { till, seller: a.seller, value: a.value, ref: a.ref });
  const [b0, h0, k0] = await Promise.all([bal(buyer.address), bal(house), bal(sink)]);
  const r = await api('POST', '/v1/call/rh-wallet', { body: input, payment: p });
  const [b1, h1, k1] = await Promise.all([bal(buyer.address), bal(house), bal(sink)]);
  ok('2c paid: the result comes back with a receipt', r.status === 200 && r.body.result.usdg === '10' && r.body.result.address === buyer.address && /^0x[0-9a-f]{64}$/.test(r.body.receipt.tx), `${r.body.receipt?.ms} ms`);
  ok('2d on chain: 0.02 left the buyer, 0.0194 reached the seller, 0.0006 the fee sink', b0 - b1 === usd(0.02) && h1 - h0 === usd(0.0194) && k1 - k0 === usd(0.0006));
  ok('2e the receipt says the same', r.body.receipt.paidUsd === 0.02 && r.body.receipt.sellerGotUsd === 0.0194 && r.body.receipt.feeUsd === 0.0006 && r.body.receipt.buyer === buyer.address && JSON.parse(atob(r.headers.get('x-payment-response'))).tx === r.body.receipt.tx);
  const tx = await pub.getTransaction({ hash: r.body.receipt.tx });
  ok('2f the settler paid the gas, the buyer has no ETH at all', getAddress(tx.from) === settler.address && (await pub.getBalance({ address: buyer.address })) === 0n);
  const again = await api('POST', '/v1/call/rh-wallet', { body: input, payment: p });
  ok('2g the same payment buys nothing twice', again.status === 402 && code(again) === 'payment_used' && (await bal(buyer.address)) === b1);
  // rh-tx reads that very payment back from the chain
  const t = await api('POST', '/v1/call/rh-tx', { body: { hash: r.body.receipt.tx }, payment: await payFor(buyer, 'rh-tx', { hash: r.body.receipt.tx }) });
  ok('2h rh-tx shows the payment inside that transaction', t.status === 200 && t.body.result.hawkerPayments[0]?.usdg === '0.02' && t.body.result.usdgTransfers.length === 3 && t.body.receipt.paidUsd === 0.03);
}

// 3 payments that must not pass
{
  const input = { address: buyer.address }, b0 = await bal(buyer.address);
  const tryPay = async (over, who = buyer) => api('POST', '/v1/call/rh-wallet', { body: input, payment: await payFor(who, 'rh-wallet', input, over) });
  ok('3a paying less is refused', code(await tryPay({ value: 1000 })) === 'wrong_value');
  ok('3b paying another seller is refused', code(await tryPay({ seller: thief.address })) === 'wrong_seller');
  ok('3c an expired payment is refused', code(await tryPay({ validBefore: Math.floor(Date.now() / 1000) - 5 })) === 'expired');
  const forged = { ...(await payFor(thief, 'rh-wallet', input)), from: buyer.address };
  ok('3d a signature from another wallet is refused', code(await api('POST', '/v1/call/rh-wallet', { body: input, payment: forged })) === 'bad_signature');
  ok('3e a garbage header is refused', code(await api('POST', '/v1/call/rh-wallet', { body: input, payment: 'bm9wZQ==' })) === 'bad_payment');
  const made = await payFor(buyer, 'rh-wallet', input);
  const otherTill = await signPayment(buyer.account, { till: sink, seller: made.seller, value: made.value, ref: made.ref });
  ok('3f a payment signed to another till is refused', code(await api('POST', '/v1/call/rh-wallet', { body: input, payment: otherTill })) === 'bad_signature');
  ok('3g none of that moved money', (await bal(buyer.address)) === b0);
  const pp = await payFor(poor, 'rh-wallet', input);
  const empty = await api('POST', '/v1/call/rh-wallet', { body: input, payment: pp });
  ok('3h an empty wallet is told so, nothing is run', empty.status === 402 && code(empty) === 'would_not_settle');
  await give(poor.address, usd(1));
  ok('3i once funded, the very same signature works', (await api('POST', '/v1/call/rh-wallet', { body: input, payment: pp })).status === 200 && (await bal(poor.address)) === usd(0.98));
  // the buyer spends the authorization on chain behind the gateway's back: the call must not be served
  const sneaky = await payFor(buyer, 'rh-wallet', input);
  await pub.waitForTransactionReceipt({ hash: await deployer.w.writeContract({ address: till, abi, functionName: 'settle', args: [toStruct(sneaky)] }) });
  ok('3j a payment already landed elsewhere is not served again', code(await api('POST', '/v1/call/rh-wallet', { body: input, payment: sneaky })) === 'payment_used');
  const two = await payFor(buyer, 'rh-wallet', input), b2 = await bal(buyer.address);
  const both = await Promise.all([api('POST', '/v1/call/rh-wallet', { body: input, payment: two }), api('POST', '/v1/call/rh-wallet', { body: input, payment: two })]);
  ok('3k the same payment sent twice at once: one result, one charge', both.filter((r) => r.status === 200).length === 1 && both.filter((r) => code(r) === 'payment_used').length === 1 && b2 - (await bal(buyer.address)) === usd(0.02));
  const b3 = await bal(buyer.address);
  const bad = await api('POST', '/v1/call/rh-tx', { body: { hash: `0x${'00'.repeat(32)}` }, payment: await payFor(buyer, 'rh-tx', { hash: `0x${'00'.repeat(32)}` }) });
  ok('3l a call the stall cannot answer is not charged', bad.status === 422 && code(bad) === 'unknown_transaction' && b3 === (await bal(buyer.address)));
}

// 4 a seller lists a stall
const listing = async (who, over = {}, signOver = {}) => {
  const b = { slug: 'weather', name: 'Weather', summary: 'Current temperature for a city.', docs: 'POST {"city":"Paris"}', url: `http://127.0.0.1:${PORT}/weather`, priceUsd: 0.05, payTo: who.address, at: Math.floor(Date.now() / 1000), ...over };
  return { ...b, signature: await who.account.signMessage({ message: stallMessage({ ...b, ...signOver }) }) };
};
const at = Math.floor(Date.now() / 1000);
{
  ok('4a a listing signed by another wallet is refused', code(await api('POST', '/v1/stalls', { body: { ...(await listing(thief)), payTo: seller.address } })) === 'bad_signature');
  ok('4b a listing whose price was changed after signing is refused', code(await api('POST', '/v1/stalls', { body: await listing(seller, { priceUsd: 0.5 }, { priceUsd: 0.05 }) })) === 'bad_signature');
  ok('4c under the minimum price is refused', code(await api('POST', '/v1/stalls', { body: await listing(seller, { priceUsd: 0.001 }) })) === 'invalid_price');
  ok('4d a house stall name cannot be taken', code(await api('POST', '/v1/stalls', { body: await listing(seller, { slug: 'rh-wallet' }) })) === 'slug_taken');
  ok('4e a stale signature is refused', code(await api('POST', '/v1/stalls', { body: await listing(seller, { at: at - 3600 }) })) === 'stale');
  env.ALLOW_HTTP_UPSTREAM = '0';
  const urls = ['http://example.com/a', 'https://127.0.0.1/a', 'https://localhost/a', 'https://user:pw@example.com/a', 'https://example.com:8443/a', 'https://box.internal/a', 'ftp://example.com/a'];
  const refused = [];
  for (const url of urls) refused.push(code(await api('POST', '/v1/stalls', { body: await listing(seller, { url }) })));
  ok('4f only https on a public host is accepted as a stall URL', refused.every((c) => c === 'invalid_url'), refused.join(' '));
  env.ALLOW_HTTP_UPSTREAM = '1';
  const made = await api('POST', '/v1/stalls', { body: await listing(seller, { at }) });
  sellerSecret = made.body.signingSecret;
  ok('4g the seller opens a stall and gets a signing secret once', made.status === 201 && /^[0-9a-f]{64}$/.test(sellerSecret) && made.body.call.endsWith('/v1/call/weather'));
  const list = (await api('GET', '/v1/stalls')).body.data, mine = list.find((s) => s.slug === 'weather');
  ok('4h it is in the catalog, without its URL or secret', list.length === 6 && mine.seller === seller.address && mine.priceUsd === 0.05 && !mine.house && !('url' in mine) && !JSON.stringify(list).includes(sellerSecret) && !JSON.stringify(list).includes('127.0.0.1'));
  ok('4i another wallet cannot change it', code(await api('POST', '/v1/stalls', { body: await listing(thief, { at: at + 1 }) })) === 'not_yours');
  ok('4j it has no free demo', (await api('POST', '/v1/demo/weather', { body: {} })).status === 403);
}

// 5 a paid call to the seller's stall
{
  const input = { city: 'Paris' };
  const [b0, s0, k0] = await Promise.all([bal(buyer.address), bal(seller.address), bal(sink)]);
  const p = await payFor(buyer, 'weather', input);
  const r = await api('POST', '/v1/call/weather', { body: input, payment: p });
  const [b1, s1, k1] = await Promise.all([bal(buyer.address), bal(seller.address), bal(sink)]);
  ok('5a the seller\'s answer comes back', r.status === 200 && r.body.result.city === 'Paris' && r.body.result.tempC === 21);
  ok('5b the seller got a signed request with the buyer and the call ref', lastSeen.good && lastSeen.buyer === buyer.address && lastSeen.call === p.ref && JSON.parse(lastSeen.body).city === 'Paris');
  ok('5c 0.05 left the buyer, 0.0485 is in the seller\'s wallet, 0.0015 fee', b0 - b1 === usd(0.05) && s1 - s0 === usd(0.0485) && k1 - k0 === usd(0.0015));
  sellerMode = 'down';
  const p2 = await payFor(buyer, 'weather', input);
  const down = await api('POST', '/v1/call/weather', { body: input, payment: p2 });
  ok('5d the seller is down: 502, not charged', down.status === 502 && code(down) === 'seller_failed' && (await bal(buyer.address)) === b1 && (await bal(seller.address)) === s1);
  sellerMode = 'refuse';
  const no = await api('POST', '/v1/call/weather', { body: input, payment: p2 });
  ok('5e the seller turns the input down: its reply is passed on, not charged', no.status === 422 && code(no) === 'seller_refused' && no.body.sellerReply.error === 'no such city' && (await bal(buyer.address)) === b1);
  sellerMode = 'ok';
  ok('5f when the seller is back, the same signature pays', (await api('POST', '/v1/call/weather', { body: input, payment: p2 })).status === 200 && b1 - (await bal(buyer.address)) === usd(0.05));
}

// 6 changing, closing and hiding a stall
{
  const up = await api('POST', '/v1/stalls', { body: await listing(seller, { priceUsd: 0.08, at: at + 2 }) });
  ok('6a the owner changes the price, the secret stays', up.status === 200 && !up.body.signingSecret && (await api('GET', '/v1/stalls/weather')).body.priceUsd === 0.08);
  const stale = await payFor(buyer, 'weather', {}, { value: 50000 });
  ok('6b a payment at the old price no longer fits', code(await api('POST', '/v1/call/weather', { body: {}, payment: stale })) === 'wrong_value');
  ok('6c an older signed change cannot be replayed over a newer one', code(await api('POST', '/v1/stalls', { body: await listing(seller, { at: at + 1 }) })) === 'stale');
  const rot = await api('POST', '/v1/stalls', { body: { ...(await listing(seller, { priceUsd: 0.08, at: at + 3 })), rotate: true } });
  ok('6d the owner can rotate the secret', rot.body.signingSecret && rot.body.signingSecret !== sellerSecret);
  sellerSecret = rot.body.signingSecret;
  ok('6e calls are signed with the new secret', (await api('POST', '/v1/call/weather', { body: { city: 'Oslo' }, payment: await payFor(buyer, 'weather', { city: 'Oslo' }) })).status === 200 && lastSeen.good);
  ok('6f hiding needs the admin key', (await api('POST', '/v1/admin/hide', { body: { slug: 'weather' } })).status === 401);
  await api('POST', '/v1/admin/hide', { body: { slug: 'weather' }, headers: { 'x-admin-key': 'admin-test' } });
  await api('POST', '/v1/stalls', { body: await listing(seller, { priceUsd: 0.08, at: at + 4 }) });
  ok('6g a hidden stall is gone and its owner cannot bring it back', (await api('GET', '/v1/stalls/weather')).status === 404 && (await api('POST', '/v1/call/weather', { body: {} })).status === 404);
  await api('POST', '/v1/admin/hide', { body: { slug: 'weather', hidden: false }, headers: { 'x-admin-key': 'admin-test' } });
  const shut = await api('POST', '/v1/stalls', { body: await listing(seller, { priceUsd: 0.08, open: false, at: at + 5 }) });
  ok('6h the owner closes the stall', shut.body.open === false && (await api('GET', '/v1/stalls/weather')).status === 404 && (await api('GET', '/v1/stalls')).body.data.length === 5);
}

// 7 demo, ledger, stats
{
  const d = await api('POST', '/v1/demo/rh-token', { body: { token: USDG, holder: buyer.address } });
  ok('7a a free demo call reads the real USDG', d.status === 200 && d.body.demo && d.body.result.symbol === 'USDG' && d.body.result.decimals === 6 && Number(d.body.result.balance) > 0, `${d.body.result?.name}, supply ${d.body.result?.totalSupply}`);
  await api('POST', '/v1/demo/rh-wallet', { body: { address: house } });
  await api('POST', '/v1/demo/rh-wallet', { body: { address: house } });
  ok('7b the demo is limited per visitor', code(await api('POST', '/v1/demo/rh-wallet', { body: { address: house } })) === 'demo_limit');
  const live = await api('POST', '/v1/call/coin-price', { body: { ids: 'ethereum,bitcoin' }, payment: await payFor(buyer, 'coin-price', { ids: 'ethereum,bitcoin' }) });
  ok('7c coin-price answers from the live source', live.status === 200 ? live.body.result.prices.ethereum.usd > 0 : code(live) === 'stall_failed', live.status === 200 ? `ETH $${live.body.result.prices.ethereum.usd}` : 'source unreachable from here, not charged');
  const ledger = (await api('GET', '/v1/ledger')).body.data, s = (await api('GET', '/v1/stats')).body;
  const paidOut = ledger.reduce((n, r) => n + r.value, 0);
  ok('7d every ledger row is a transaction with a Paid event', ledger.length === s.paidCalls && ledger.every((r) => /^0x[0-9a-f]{64}$/.test(r.tx) && r.explorer.includes(r.tx)), `${ledger.length} rows`);
  ok('7e stats add up to the ledger', s.volumeUsd === paidOut / 1e6 && s.buyers === 2 && s.callsToSellerStalls === 3 && s.houseStalls === 5 && s.sellerStalls === 0, JSON.stringify(s));
  const [h, sl, k, t] = await Promise.all([bal(house), bal(seller.address), bal(sink), bal(till)]);
  // the chain also holds the payment landed directly on the till in 3j, which the gateway never served
  ok('7f the chain agrees: sellers + fee sink hold what the ledger says, the till holds nothing', h + sl + k === BigInt(paidOut) + usd(0.02) && t === 0n, `house ${h}, seller ${sl}, sink ${k}`);
}

upstream.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
