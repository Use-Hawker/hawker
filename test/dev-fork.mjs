// A whole HAWKER on localhost for looking at the site: a Hardhat fork of Robinhood Chain (started here if it is not up),
// the till, the gateway with the site on :8867, a seller's stall and a few paid calls so the ledger has rows.
// Also a test signer on :8868 that stands in for a wallet when the listing form is tried without one.
// node test/dev-fork.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http as viemHttp, parseEther, parseUnits, keccak256, encodeAbiParameters, toHex, pad, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { chain as rhChain, USDG } from '../core/hawker.mjs';
import worker from '../worker/src/index.js';
import { sqliteD1 } from '../worker/d1-sqlite.mjs';
import { loadConfig, call, listStall } from '../agent/hawker-agent.mjs';

const RPC = 'http://127.0.0.1:8548', PORT = 8867, SIGNER = 8868, SELLER = 8869;
const chain = { ...rhChain, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: viemHttp(RPC) });
const raw = (method, params = []) => pub.request({ method, params });
const up = () => raw('eth_chainId').then(() => true, () => false);
if (!await up()) {
  spawn('npx hardhat node --config hardhat.config.cjs --port 8548', { cwd: fileURLToPath(new URL('../contracts/', import.meta.url)), shell: true, stdio: 'ignore' });
  for (let i = 0; i < 60 && !await up(); i++) await new Promise((r) => setTimeout(r, 1000));
}
const fund = async (key) => { const a = privateKeyToAccount(key); await raw('hardhat_setBalance', [a.address, toHex(parseEther('10'))]); return createWalletClient({ account: a, chain, transport: viemHttp(RPC) }); };
const give = (who, usd) => raw('hardhat_setStorageAt', [USDG, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, 1n])), pad(toHex(parseUnits(String(usd), 6)))]);

const { abi, bytecode } = JSON.parse(fs.readFileSync(new URL('../contracts/build/HawkerTill.json', import.meta.url)));
const settlerKey = generatePrivateKey(), deployer = await fund(generatePrivateKey());
await fund(settlerKey);
const sink = privateKeyToAccount(generatePrivateKey()).address, house = privateKeyToAccount(generatePrivateKey()).address;
const till = getAddress((await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi, bytecode, args: [USDG, sink, 300n] }) })).contractAddress);

// a seller's API, and a signer that plays the wallet for the listing form
http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ city: JSON.parse(body || '{}').city || 'Paris', tempC: 21, windKmh: 9 }));
}).listen(SELLER);
const walletKey = privateKeyToAccount(generatePrivateKey());
http.createServer(async (req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  let body = '';
  for await (const c of req) body += c;
  const out = req.url === '/address' ? { address: walletKey.address.toLowerCase() } : { signature: await walletKey.signMessage({ message: { raw: JSON.parse(body).hex } }) };
  res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(out));
}).listen(SIGNER);

const TYPES = { html: 'text/html; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', js: 'text/javascript', css: 'text/css' };
const ASSETS = { fetch: async (request) => {
  let p = new URL(request.url).pathname.replace(/\/$/, '/index.html').replace(/\.\./g, '');
  // like Cloudflare's assets: /stalls serves stalls/index.html
  if (!p.split('/').pop().includes('.')) p += '/index.html';
  const f = new URL(`../site${p}`, import.meta.url);
  return fs.existsSync(f) ? new Response(fs.readFileSync(f), { headers: { 'content-type': TYPES[p.split('.').pop()] || 'application/octet-stream' } }) : new Response('not found', { status: 404 });
} };
const env = { DB: sqliteD1(':memory:'), ASSETS, RH_RPC_URL: RPC, TILL: till, GAS_KEY: settlerKey, HOUSE_PAY_TO: house, ALLOW_HTTP_UPSTREAM: '1', DEMO_PER_IP: '50' };
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)).end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT);

// seed: one seller stall, a handful of paid calls from two buyers
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hawker-dev-'));
const agent = (key) => loadConfig({ HAWKER_HOME: home, HAWKER_KEY: key, HAWKER_API: `http://localhost:${PORT}`, RH_RPC_URL: RPC });
const seller = agent(generatePrivateKey()), a = agent(generatePrivateKey()), b = agent(generatePrivateKey());
await give(a.account.address, 5);
await give(b.account.address, 5);
await listStall(seller, { slug: 'weather-now', url: `http://127.0.0.1:${SELLER}/weather`, priceUsd: 0.05, name: 'Weather Now', summary: 'Current temperature and wind for a city.', docs: 'POST {"city":"Paris"}' });
await call(a, 'rh-wallet', { address: house });
await call(b, 'weather-now', { city: 'Oslo' });
await call(a, 'rh-token', { token: USDG });
await call(b, 'coin-price', { ids: 'ethereum,bitcoin' }).catch(() => {});
await call(a, 'weather-now', { city: 'Lima' });
console.log(`hawker dev on http://localhost:${PORT}  till ${till}  test wallet ${walletKey.address}`);
