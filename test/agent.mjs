// The agent kit against the gateway on a Hardhat fork of Robinhood Chain: SDK, CLI and MCP paying real USDG.
// Start the fork first: cd contracts && npx hardhat node --config hardhat.config.cjs --port 8548
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http as viemHttp, parseEther, parseUnits, keccak256, encodeAbiParameters, toHex, pad, erc20Abi, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { chain as rhChain, USDG } from '../core/hawker.mjs';
import worker from '../worker/src/index.js';
import { sqliteD1 } from '../worker/d1-sqlite.mjs';
import { init, loadConfig, stalls, balance, call, verify, listStall } from '../agent/hawker-agent.mjs';

const RPC = process.env.RPC || 'http://127.0.0.1:8548';
const { abi, bytecode } = JSON.parse(fs.readFileSync(new URL('../contracts/build/HawkerTill.json', import.meta.url)));
const chain = { ...rhChain, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: viemHttp(RPC) });
const raw = (method, params = []) => pub.request({ method, params });
let fails = 0;
const ok = (name, good, detail = '') => { if (!good) fails++; console.log(`${good ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`); };
const usd = (n) => parseUnits(String(n), 6);
const bal = (a) => pub.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
const give = (who, amount) => raw('hardhat_setStorageAt', [USDG, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, 1n])), pad(toHex(amount))]);
const refused = async (f) => { try { await f(); return 'no error'; } catch (e) { return e.message; } };

// ---- chain and gateway
const fund = async (key) => { const a = privateKeyToAccount(key); await raw('hardhat_setBalance', [a.address, toHex(parseEther('10'))]); return createWalletClient({ account: a, chain, transport: viemHttp(RPC) }); };
const settlerKey = generatePrivateKey(), deployer = await fund(generatePrivateKey());
await fund(settlerKey);
const sink = privateKeyToAccount(generatePrivateKey()).address, house = privateKeyToAccount(generatePrivateKey()).address;
const till = getAddress((await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi, bytecode, args: [USDG, sink, 300n] }) })).contractAddress);
const SELLER_PORT = 8863, GATE_PORT = 8864;
const sellerApi = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ echo: JSON.parse(body || '{}'), signed: !!req.headers['x-hawker-signature'] }));
}).listen(SELLER_PORT);
const env = { DB: sqliteD1(':memory:'), RH_RPC_URL: RPC, TILL: till, GAS_KEY: settlerKey, HOUSE_PAY_TO: house, ALLOW_HTTP_UPSTREAM: '1' };
const gate = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request(`http://localhost:${GATE_PORT}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)).end(Buffer.from(await r.arrayBuffer()));
}).listen(GATE_PORT);

// ---- the agent's own home, key and limits
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hawker-agent-'));
const agentEnv = { HAWKER_HOME: HOME, HAWKER_API: `http://localhost:${GATE_PORT}`, RH_RPC_URL: RPC, HAWKER_MAX_PER_CALL: '0.05', HAWKER_MAX_PER_DAY: '0.2' };

// 1 the key
const made = init(agentEnv), again = init(agentEnv);
ok('1a init makes a key file once and keeps it', made.created && !again.created && made.address === again.address && fs.existsSync(made.keyFile), made.address);
ok('1b without a key the kit says what to do', /hawker init/.test(await refused(() => loadConfig({ HAWKER_HOME: path.join(HOME, 'none') }))));
const cfg = loadConfig(agentEnv);
await give(cfg.account.address, usd(1));

// 2 SDK
{
  const b = await balance(cfg);
  ok('2a balance: 1 USDG, nothing spent, limits from the environment', b.usdg === 1 && b.spentToday === 0 && b.maxPerCall === 0.05 && b.maxPerDay === 0.2);
  const list = await stalls(cfg);
  ok('2b the catalog lists five stalls with prices and inputs', list.length === 5 && list.every((s) => s.priceUsd > 0 && s.input?.length));
  const r = await call(cfg, 'rh-wallet', { address: cfg.account.address });
  ok('2c a call is paid and answered', r.result.usdg === '1' && r.receipt.paidUsd === 0.02 && r.receipt.buyer === cfg.account.address && (await bal(cfg.account.address)) === usd(0.98));
  ok('2d the receipt checks out on chain', await verify(cfg, r.receipt, till) && !(await verify(cfg, { ...r.receipt, paidUsd: 0.5 }, till)));
  ok('2e the spend is on disk', (await balance(cfg)).spentToday === 0.02 && JSON.parse(fs.readFileSync(cfg.spendFile, 'utf8')).calls === 1);
  ok('2f a failed call is not counted', /unknown_transaction/.test(await refused(() => call(cfg, 'rh-tx', { hash: `0x${'00'.repeat(32)}` }))) && (await balance(cfg)).spentToday === 0.02 && (await bal(cfg.account.address)) === usd(0.98));
}

// 3 limits: nothing is signed above them
{
  const b0 = await bal(cfg.account.address);
  ok('3a max_usd under the price refuses the call', /per-call limit/.test(await refused(() => call(cfg, 'rh-wallet', { address: house }, { maxUsd: 0.01 }))));
  const seller = loadConfig({ ...agentEnv, HAWKER_KEY: generatePrivateKey() });
  const listed = await listStall(seller, { slug: 'pricey', url: `http://127.0.0.1:${SELLER_PORT}/x`, priceUsd: 0.5, name: 'Pricey', summary: 'Costs more than the agent may spend on one call.' });
  ok('3b a seller opens a stall from the kit', /^[0-9a-f]{64}$/.test(listed.signingSecret));
  ok('3c a stall over the per-call limit is refused', /per-call limit/.test(await refused(() => call(cfg, 'pricey', {}))));
  ok('3d an agent pinned to one till refuses another', /only pays/.test(await refused(() => call(loadConfig({ ...agentEnv, HAWKER_TILL: sink }), 'rh-wallet', { address: house }))));
  ok('3e none of that moved money', (await bal(cfg.account.address)) === b0);
  await listStall(seller, { slug: 'echo', url: `http://127.0.0.1:${SELLER_PORT}/echo`, priceUsd: 0.05, name: 'Echo', summary: 'Returns what it gets.' });
  const s0 = await bal(seller.account.address);
  const r = await call(cfg, 'echo', { hello: 'stall' });
  ok('3f the agent buys from a seller\'s stall, the seller is paid on chain', r.result.echo.hello === 'stall' && r.result.signed && (await bal(seller.account.address)) - s0 === usd(0.0485));
  await call(cfg, 'echo', {});
  await call(cfg, 'echo', {});
  const left = await balance(cfg);
  ok('3g spent 0.17 of 0.20 today', left.spentToday === 0.17 && left.leftToday === 0.03, JSON.stringify(left));
  ok('3h the day limit refuses the next 0.05 call', /day limit/.test(await refused(() => call(cfg, 'echo', {}))) && (await bal(cfg.account.address)) === usd(0.83));
  ok('3i a 0.02 call still fits', (await call(cfg, 'rh-wallet', { address: house })).receipt.paidUsd === 0.02);
}

// 4 CLI
const bin = fileURLToPath(new URL('../agent/cli.mjs', import.meta.url));
const run = (args, extra = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...agentEnv, ...extra } });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (status) => resolve({ status, out, err }));
});
{
  const b = await run(['balance']);
  ok('4a `hawker balance` prints the wallet', b.status === 0 && JSON.parse(b.out).address === cfg.account.address && JSON.parse(b.out).spentToday === 0.19);
  const over = await run(['call', 'rh-wallet', JSON.stringify({ address: house })]);
  ok('4b `hawker call` over the day limit exits with the reason', over.status === 1 && /day limit/.test(over.err));
  const c = await run(['call', 'rh-token', JSON.stringify({ token: USDG }), '--max', '0.02'], { HAWKER_MAX_PER_DAY: '1' });
  ok('4c `hawker call` pays and prints the answer with the receipt', c.status === 0 && JSON.parse(c.out).result.symbol === 'USDG' && /^0x[0-9a-f]{64}$/.test(JSON.parse(c.out).receipt.tx), c.err.slice(0, 120));
  ok('4d `hawker stalls` lists the seller\'s stalls too', JSON.parse((await run(['stalls'])).out).length === 7);
}

// 5 MCP over stdio
{
  const p = spawn(process.execPath, [bin, 'mcp'], { env: { ...process.env, ...agentEnv, HAWKER_MAX_PER_DAY: '1' } });
  const waiting = new Map();
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) { const m = JSON.parse(buf.slice(0, i)); waiting.get(m.id)?.(m); }
  });
  let id = 0;
  const ask = (method, params) => new Promise((resolve) => { waiting.set(++id, resolve); p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const hello = await ask('initialize', { protocolVersion: '2025-06-18' });
  ok('5a initialize names the server and warns that calls cost money', hello.result.serverInfo.name === 'hawker' && /real money/.test(hello.result.instructions));
  const tools = (await ask('tools/list')).result.tools;
  ok('5b three tools', tools.map((t) => t.name).join() === 'hawker_stalls,hawker_call,hawker_balance');
  const b0 = await bal(cfg.account.address);
  const paid = await ask('tools/call', { name: 'hawker_call', arguments: { stall: 'rh-wallet', input: { address: house } } });
  const body = JSON.parse(paid.result.content[0].text);
  ok('5c hawker_call pays and returns the answer with the receipt', !paid.result.isError && body.result.address === house && body.receipt.paidUsd === 0.02 && b0 - (await bal(cfg.account.address)) === usd(0.02));
  const no = await ask('tools/call', { name: 'hawker_call', arguments: { stall: 'rh-wallet', input: { address: house }, max_usd: 0.001 } });
  ok('5d a refused call comes back as an error, with the reason', no.result.isError && /per-call limit/.test(no.result.content[0].text));
  const w = JSON.parse((await ask('tools/call', { name: 'hawker_balance', arguments: {} })).result.content[0].text);
  ok('5e hawker_balance shows the wallet and never the key', w.address === cfg.account.address && !JSON.stringify(w).includes(fs.readFileSync(made.keyFile, 'utf8').slice(2)));
  p.kill();
}

ok('6 the agent never held any ETH', (await pub.getBalance({ address: cfg.account.address })) === 0n);

sellerApi.close();
gate.close();
fs.rmSync(HOME, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
