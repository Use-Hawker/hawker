// HAWKER agent kit for Robinhood Chain. Holds the agent's key locally and pays for calls with it: asks a stall,
// reads the 402 quote, signs a USDG authorization for exactly that price and sends the request again.
// The key never leaves this machine and the wallet needs no ETH. What the agent can spend is capped twice:
// by the USDG in its wallet, and by the per-call and per-day limits kept here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { erc20Abi, decodeEventLog } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { client, addr, USDG, CHAIN_ID, TILL_ABI, toUnits, fromUnits, signPayment, encodePayment, stallMessage } from '../core/hawker.mjs';

export const DEFAULT_API = 'https://usehawker.fun';
const home = (env) => env.HAWKER_HOME || path.join(os.homedir(), '.hawker');
const keyFile = (env) => path.join(home(env), 'key');

/// Makes a fresh key for the agent in ~/.hawker/key. Fund its address with USDG on Robinhood Chain; it needs no ETH.
export function init(env = process.env) {
  const file = keyFile(env);
  if (fs.existsSync(file)) return { address: privateKeyToAccount(fs.readFileSync(file, 'utf8').trim()).address, keyFile: file, created: false };
  fs.mkdirSync(home(env), { recursive: true });
  const key = generatePrivateKey();
  fs.writeFileSync(file, key, { mode: 0o600 });
  return { address: privateKeyToAccount(key).address, keyFile: file, created: true };
}

export function loadConfig(env = process.env) {
  const raw = env.HAWKER_KEY || (fs.existsSync(keyFile(env)) ? keyFile(env) : '');
  if (!raw) throw new Error('No key: run `hawker init`, or set HAWKER_KEY (hex private key, or a file that holds one)');
  const key = (fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : raw).trim();
  const num = (v, d) => (Number(v) >= 0 && v !== undefined && v !== '' ? Number(v) : d);
  return {
    account: privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`),
    api: (env.HAWKER_API || DEFAULT_API).replace(/\/+$/, ''),
    pub: client(env.RH_RPC_URL),
    // set HAWKER_TILL to refuse a quote that names any other contract
    till: env.HAWKER_TILL ? addr(env.HAWKER_TILL) : null,
    maxPerCall: num(env.HAWKER_MAX_PER_CALL, 1), // USDG
    maxPerDay: num(env.HAWKER_MAX_PER_DAY, 5),
    spendFile: path.join(home(env), 'spend.json'),
  };
}

// what this key paid today (UTC), kept on disk so the day cap survives restarts
const today = () => new Date().toISOString().slice(0, 10);
function spent(cfg) {
  try {
    const j = JSON.parse(fs.readFileSync(cfg.spendFile, 'utf8'));
    return j.day === today() && j.address === cfg.account.address ? j : { day: today(), address: cfg.account.address, units: 0, calls: 0 };
  } catch { return { day: today(), address: cfg.account.address, units: 0, calls: 0 }; }
}
function record(cfg, units) {
  const s = spent(cfg);
  fs.mkdirSync(path.dirname(cfg.spendFile), { recursive: true });
  fs.writeFileSync(cfg.spendFile, JSON.stringify({ ...s, units: s.units + Number(units), calls: s.calls + 1 }));
}

async function api(cfg, method, route, { body, payment } = {}) {
  const res = await fetch(cfg.api + route, {
    method, headers: { 'content-type': 'application/json', ...(payment ? { 'x-payment': encodePayment(payment) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const problem = (r) => new Error(`${r.body?.error?.code || r.status}: ${r.body?.error?.message || 'the gateway refused'}`);

export async function stalls(cfg) {
  const r = await api(cfg, 'GET', '/v1/stalls');
  if (r.status !== 200) throw problem(r);
  return r.body.data.map((s) => ({ slug: s.slug, name: s.name, summary: s.summary, priceUsd: s.priceUsd, house: s.house, seller: s.seller, ...(s.input ? { input: s.input } : { docs: s.docs }) }));
}

export async function balance(cfg) {
  const units = await cfg.pub.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [cfg.account.address] });
  const s = spent(cfg);
  return { address: cfg.account.address, usdg: fromUnits(units), spentToday: fromUnits(s.units), callsToday: s.calls, maxPerCall: cfg.maxPerCall, maxPerDay: cfg.maxPerDay, leftToday: Math.max(0, +(cfg.maxPerDay - fromUnits(s.units)).toFixed(6)) };
}

/// Pays for one call and returns the stall's answer with the receipt. Nothing is signed above the limits.
export async function call(cfg, slug, input = {}, { maxUsd } = {}) {
  const asked = await api(cfg, 'POST', `/v1/call/${slug}`, { body: input });
  if (asked.status !== 402 || !asked.body.accepts) throw problem(asked);
  const q = asked.body.accepts[0];
  if (q.scheme !== 'hawker-till' || q.chainId !== CHAIN_ID || addr(q.asset) !== USDG) throw new Error('the quote is not a USDG payment through a HAWKER till on Robinhood Chain');
  if (cfg.till && addr(q.till) !== cfg.till) throw new Error(`the quote names till ${q.till}, this agent only pays ${cfg.till}`);
  const units = BigInt(q.value), cap = Math.min(cfg.maxPerCall, maxUsd ?? Infinity), s = spent(cfg);
  if (units > toUnits(cap)) throw new Error(`over the per-call limit: this call costs ${fromUnits(units)} USDG, the limit is ${cap}`);
  if (BigInt(s.units) + units > toUnits(cfg.maxPerDay)) throw new Error(`over the day limit: ${fromUnits(s.units)} of ${cfg.maxPerDay} USDG already spent today`);

  const payment = await signPayment(cfg.account, { till: addr(q.till), seller: addr(q.seller), value: units, ref: q.ref, validBefore: Math.floor(Date.now() / 1000) + (q.validSeconds || 300) });
  const r = await api(cfg, 'POST', `/v1/call/${slug}`, { body: input, payment });
  if (r.status !== 200) throw problem(r);
  record(cfg, units);
  return { result: r.body.result, receipt: r.body.receipt };
}

/// Checks a receipt against the chain: the transaction holds a Paid event from the till for this buyer and amount.
export async function verify(cfg, receipt, till) {
  const r = await cfg.pub.getTransactionReceipt({ hash: receipt.tx });
  const paid = r.logs.filter((l) => l.address.toLowerCase() === addr(till).toLowerCase())
    .map((l) => { try { return decodeEventLog({ abi: TILL_ABI, data: l.data, topics: l.topics }); } catch { return null; } })
    .find((e) => e?.eventName === 'Paid' && e.args.ref === receipt.ref);
  return !!paid && r.status === 'success' && paid.args.buyer === cfg.account.address && paid.args.value === toUnits(receipt.paidUsd);
}

/// The seller's side: open, change or close a stall, signed with this key. The key's address is the payout wallet.
export async function listStall(cfg, { slug, url, priceUsd, name, summary, docs = '', open = true, rotate = false }) {
  const b = { slug, url, priceUsd: Number(priceUsd), payTo: cfg.account.address, open, at: Math.floor(Date.now() / 1000) };
  const signature = await cfg.account.signMessage({ message: stallMessage(b) });
  const r = await api(cfg, 'POST', '/v1/stalls', { body: { ...b, name, summary, docs, rotate, signature } });
  if (r.status > 299) throw problem(r);
  return r.body;
}
