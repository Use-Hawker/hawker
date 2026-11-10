// HawkerTill on a Hardhat fork of Robinhood Chain with the real USDG.
// Start the fork first: npx hardhat node --config hardhat.config.cjs --port 8548
// Fresh wallets only: well-known Hardhat accounts carry EIP-7702 delegations on Robinhood Chain.
import { createPublicClient, createWalletClient, http, parseEther, parseUnits, encodeFunctionData, decodeErrorResult, decodeEventLog, keccak256, encodeAbiParameters, toHex, pad, parseSignature } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const RPC = process.env.RPC || 'http://127.0.0.1:8548';
const { abi, bytecode } = JSON.parse(readFileSync(new URL('./build/HawkerTill.json', import.meta.url)));
const chain = { id: 4663, name: 'rh-fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const raw = (method, params = []) => pub.request({ method, params });
const ERC20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
const USDG_ABI = [
  ...ERC20,
  { type: 'function', name: 'receiveWithAuthorization', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'authorizationState', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'bool' }] },
];
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const HOLDER_TOKEN = '0x2fe05351f36c229651ebbc7a95dddea00eb3f709'; // a real Pons token ($DIGGD) standing in for $HAWKER
const usd = (n) => parseUnits(String(n), 6);

let fails = 0;
const ok = (name, good, detail = '') => { if (!good) fails++; console.log(`${good ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`); };
const wallet = async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  await raw('hardhat_setBalance', [account.address, '0x' + parseEther('100').toString(16)]);
  return { account, w: createWalletClient({ account, chain, transport: http(RPC) }) };
};
const send = async (who, to, data, gas = 600000n) => {
  const hash = await who.w.sendTransaction({ to, data, gas });
  return pub.waitForTransactionReceipt({ hash });
};
// the revert reason of a call that should fail: our error name, or "token" when USDG itself refused
const reason = async (who, to, data) => {
  try { await pub.call({ account: who.account.address, to, data }); return 'no revert'; }
  catch (e) {
    const d = e?.cause?.data || e?.data || e?.details?.match(/0x[0-9a-f]+/)?.[0] || e?.walk?.((x) => x?.data)?.data;
    try { return decodeErrorResult({ abi, data: typeof d === 'string' ? d : d?.data }).errorName; } catch { if (process.env.DEBUG) console.log('  revert:', (e.shortMessage || e.message).slice(0, 160)); return 'token'; }
  }
};
const bal = (a, t = USDG) => pub.readContract({ address: t, abi: ERC20, functionName: 'balanceOf', args: [a] });
// writes a token balance by finding which mapping slot holds it
const give = async (token, who, amount) => {
  for (let slot = 0; slot < 400; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, BigInt(slot)]));
    const old = await raw('eth_getStorageAt', [token, key, 'latest']);
    await raw('hardhat_setStorageAt', [token, key, pad(toHex(amount))]);
    if ((await bal(who, token)) === amount) return slot;
    await raw('hardhat_setStorageAt', [token, key, old]);
  }
  return -1;
};

// setup: the till at 3%, a fee sink, a buyer with real USDG, sellers
const deployer = await wallet(), sink = privateKeyToAccount(generatePrivateKey()).address;
const hash = await deployer.w.deployContract({ abi, bytecode, args: [USDG, sink, 300n] });
const till = (await pub.waitForTransactionReceipt({ hash })).contractAddress;
const buyer = await wallet(), seller = await wallet(), other = await wallet(), stranger = await wallet(), poor = await wallet();
const slot = await give(USDG, buyer.account.address, usd(100));
ok('setup: buyer holds 100 USDG', (await bal(buyer.account.address)) === usd(100), `balance slot ${slot}, till ${till}`);

const now = BigInt((await pub.getBlock()).timestamp);
const domain = { name: 'Global Dollar', version: '1', chainId: 4663, verifyingContract: USDG };
const types = { ReceiveWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };
const nonceFor = (sellerAddr, ref) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [sellerAddr, ref]));
let n = 1;
// a payment the buyer signs for one call: only the fields in the USDG authorization are signed, the seller and ref ride in the nonce
const pay = async (o = {}, by = buyer) => {
  const p = { from: by.account.address, seller: seller.account.address, value: usd(1), validAfter: 0n, validBefore: now + 3600n, ref: keccak256(toHex('call-' + n++)), ...o };
  const sig = parseSignature(await by.account.signTypedData({ domain, types, primaryType: 'ReceiveWithAuthorization', message: { from: p.from, to: till, value: p.value, validAfter: p.validAfter, validBefore: p.validBefore, nonce: nonceFor(p.seller, p.ref) } }));
  return { ...p, v: Number(sig.v ?? 27n + BigInt(sig.yParity)), r: sig.r, s: sig.s };
};
const settleData = (p) => encodeFunctionData({ abi, functionName: 'settle', args: [p] });
const read = (functionName, args = []) => pub.readContract({ address: till, abi, functionName, args });
const events = (r) => r.logs.filter((l) => l.address.toLowerCase() === till.toLowerCase()).map((l) => decodeEventLog({ abi, data: l.data, topics: l.topics }));

// 1 one paid call
{
  const p = await pay();
  ok('1a the nonce matches the off-chain one', (await read('nonceFor', [p.seller, p.ref])) === nonceFor(p.seller, p.ref));
  ok('1b fee is 3%', (await read('feeFor', [p.seller, p.value])) === usd(0.03));
  const [b0, s0, k0] = await Promise.all([bal(p.from), bal(p.seller), bal(sink)]);
  const r = await send(stranger, till, settleData(p));
  const [b1, s1, k1] = await Promise.all([bal(p.from), bal(p.seller), bal(sink)]);
  ok('1c payment lands: 1.00 from the buyer, 0.97 to the seller, 0.03 to the sink', r.status === 'success' && b0 - b1 === usd(1) && s1 - s0 === usd(0.97) && k1 - k0 === usd(0.03), `gas ${r.gasUsed}`);
  const ev = events(r)[0];
  ok('1d Paid event carries ref, buyer, seller, value, fee', ev?.eventName === 'Paid' && ev.args.ref === p.ref && ev.args.value === usd(1) && ev.args.fee === usd(0.03) && ev.args.seller.toLowerCase() === p.seller.toLowerCase());
  const again = await reason(stranger, till, settleData(p));
  ok('1e the same signature cannot land twice', again === 'NotPaid', again);
  ok('1f USDG marks the nonce as used', await pub.readContract({ address: USDG, abi: USDG_ABI, functionName: 'authorizationState', args: [p.from, nonceFor(p.seller, p.ref)] }));
  ok('1g the till keeps nothing', (await bal(till)) === 0n);
}

// 2 tampering
{
  const p = await pay();
  ok('2a pointing it at another seller breaks the signature', (await reason(stranger, till, settleData({ ...p, seller: other.account.address }))) === 'token');
  ok('2b a higher value breaks the signature', (await reason(stranger, till, settleData({ ...p, value: usd(50) }))) === 'token');
  ok('2c another ref breaks the signature', (await reason(stranger, till, settleData({ ...p, ref: keccak256(toHex('x')) }))) === 'token');
  ok('2d naming another buyer breaks the signature', (await reason(stranger, till, settleData({ ...p, from: other.account.address }))) === 'token');
  ok('2e no seller refused', (await reason(stranger, till, settleData(await pay({ seller: '0x0000000000000000000000000000000000000000' })))) === 'NoSeller');
  // the signature is made out to the till, so nobody can pull the money with it past the till
  const direct = encodeFunctionData({ abi: USDG_ABI, functionName: 'receiveWithAuthorization', args: [p.from, till, p.value, p.validAfter, p.validBefore, nonceFor(p.seller, p.ref), p.v, p.r, p.s] });
  ok('2f the signature is useless outside the till', (await reason(stranger, USDG, direct)) === 'token');
  ok('2g untouched after all that, it still lands', (await send(stranger, till, settleData(p))).status === 'success');
}

// 3 time window and empty wallet
{
  ok('3a past validBefore refused', (await reason(stranger, till, settleData(await pay({ validBefore: now - 1n })))) === 'token');
  ok('3b before validAfter refused', (await reason(stranger, till, settleData(await pay({ validAfter: now + 86400n })))) === 'token');
  ok('3c a buyer without USDG refused', (await reason(stranger, till, settleData(await pay({}, poor)))) === 'token');
  ok('3d more than the balance refused', (await reason(stranger, till, settleData(await pay({ value: usd(1000) })))) === 'token');
}

// 4 small amounts round the fee down, never the seller's part
{
  const p = await pay({ value: 33n });
  const [s0, k0] = await Promise.all([bal(p.seller), bal(sink)]);
  await send(stranger, till, settleData(p));
  const [s1, k1] = await Promise.all([bal(p.seller), bal(sink)]);
  ok('4a 33 units: 33 to the seller, 0 fee', s1 - s0 === 33n && k1 - k0 === 0n);
  const z = await pay({ value: 0n });
  ok('4b a zero payment moves nothing', (await send(stranger, till, settleData(z))).status === 'success' && (await bal(p.seller)) === s1);
}

// 5 owner: fee capped, nothing else to touch
{
  const call = (functionName, args) => encodeFunctionData({ abi, functionName, args });
  ok('5a a stranger cannot set the fee', (await reason(stranger, till, call('setFee', [0n]))) === 'NotOwner');
  ok('5b a stranger cannot move the sink', (await reason(stranger, till, call('setFeeSink', [stranger.account.address]))) === 'NotOwner');
  ok('5c a stranger cannot set the holder token', (await reason(stranger, till, call('setHolderToken', [HOLDER_TOKEN, 1n]))) === 'NotOwner');
  ok('5d a stranger cannot take ownership', (await reason(stranger, till, call('setOwner', [stranger.account.address]))) === 'NotOwner');
  ok('5e the owner cannot go above 5%', (await reason(deployer, till, call('setFee', [501n]))) === 'FeeTooHigh');
  await send(deployer, till, call('setFee', [500n]));
  const p = await pay({ value: usd(2) }), s0 = await bal(p.seller), k0 = await bal(sink);
  await send(stranger, till, settleData(p));
  ok('5f at 5% a 2.00 call pays 1.90 + 0.10', (await bal(p.seller)) - s0 === usd(1.9) && (await bal(sink)) - k0 === usd(0.1));
  await send(deployer, till, call('setFee', [300n]));
  const sink2 = privateKeyToAccount(generatePrivateKey()).address;
  await send(deployer, till, call('setFeeSink', [sink2]));
  const q = await pay();
  await send(stranger, till, settleData(q));
  ok('5g a new sink gets the next fee', (await bal(sink2)) === usd(0.03));
  await send(deployer, till, call('setFeeSink', [sink]));
  let threw = false;
  try { await deployer.w.deployContract({ abi, bytecode, args: [USDG, sink, 501n], gas: 2000000n }).then((h) => pub.waitForTransactionReceipt({ hash: h })).then((r) => { threw = r.status !== 'success'; }); } catch { threw = true; }
  ok('5h cannot deploy above 5%', threw);
}

// 6 holders of the token sell with no fee
{
  const call = (functionName, args) => encodeFunctionData({ abi, functionName, args });
  await send(deployer, till, call('setHolderToken', [HOLDER_TOKEN, parseEther('1000000')]));
  ok('6a a seller without the token still pays 3%', (await read('feeFor', [seller.account.address, usd(1)])) === usd(0.03));
  const s = await give(HOLDER_TOKEN, other.account.address, parseEther('1000000'));
  ok('6b a seller holding 1M pays no fee', s >= 0 && (await read('feeFor', [other.account.address, usd(1)])) === 0n);
  const p = await pay({ seller: other.account.address }), s0 = await bal(p.seller), k0 = await bal(sink);
  const r = await send(stranger, till, settleData(p));
  ok('6c the whole 1.00 reaches a holder', (await bal(p.seller)) - s0 === usd(1) && (await bal(sink)) === k0 && events(r)[0].args.fee === 0n);
  await give(HOLDER_TOKEN, other.account.address, parseEther('999999'));
  ok('6d under 1M the fee is back', (await read('feeFor', [other.account.address, usd(1)])) === usd(0.03));
  await send(deployer, till, call('setHolderToken', [stranger.account.address, 1n])); // not a token at all
  ok('6e a broken holder token cannot block payments', (await read('feeFor', [seller.account.address, usd(1)])) === usd(0.03) && (await send(stranger, till, settleData(await pay()))).status === 'success');
  await send(deployer, till, call('setHolderToken', ['0x0000000000000000000000000000000000000000', 0n]));
}

// 7 many payments in one transaction
{
  const good1 = await pay({ value: usd(0.5) }), spent = await pay(), good2 = await pay({ seller: other.account.address, value: usd(0.25) }), late = await pay({ validBefore: now - 1n });
  await send(stranger, till, settleData(spent));
  const [s0, o0, k0] = await Promise.all([bal(seller.account.address), bal(other.account.address), bal(sink)]);
  const r = await send(stranger, till, encodeFunctionData({ abi, functionName: 'settleMany', args: [[good1, spent, good2, late]] }), 2000000n);
  const [s1, o1, k1] = await Promise.all([bal(seller.account.address), bal(other.account.address), bal(sink)]);
  const ev = events(r);
  ok('7a two good ones land, the spent and the late one are skipped', r.status === 'success' && s1 - s0 === usd(0.485) && o1 - o0 === usd(0.2425) && k1 - k0 === usd(0.0225), `gas ${r.gasUsed}`);
  ok('7b events: Paid, Skipped, Paid, Skipped', ev.map((e) => e.eventName).join() === 'Paid,Skipped,Paid,Skipped' && ev[1].args.ref === spent.ref && ev[3].args.ref === late.ref);
  const ten = [];
  for (let i = 0; i < 10; i++) ten.push(await pay({ value: usd(0.01) }));
  const r10 = await send(stranger, till, encodeFunctionData({ abi, functionName: 'settleMany', args: [ten] }), 3000000n);
  ok('7c ten payments in one transaction', events(r10).filter((e) => e.eventName === 'Paid').length === 10, `gas ${r10.gasUsed}, ${r10.gasUsed / 10n} each`);
  ok('7d the till still keeps nothing', (await bal(till)) === 0n);
}

// 8 USDG does not revert on a used nonce, it moves nothing: stray money in the till must not pay a replay
{
  const p = await pay(), s0 = await bal(p.seller);
  await send(stranger, till, settleData(p));
  await give(USDG, till, usd(5));
  ok('8a a replay cannot be paid from money sitting in the till', (await reason(stranger, till, settleData(p))) === 'NotPaid' && (await bal(p.seller)) - s0 === usd(0.97));
  const r = await send(stranger, till, encodeFunctionData({ abi, functionName: 'settleMany', args: [[p]] }), 1000000n);
  ok('8b in a batch the replay is skipped, the money stays', events(r)[0].eventName === 'Skipped' && (await bal(till)) === usd(5));
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
