// HAWKER core: what the gateway, the agent kit and the tests share.
// A payment is a USDG ReceiveWithAuthorization made out to the till, with the seller and the call ref folded into its nonce.
import { createPublicClient, http, keccak256, encodeAbiParameters, getAddress, recoverTypedDataAddress, parseSignature, parseAbi } from 'viem';

export const CHAIN_ID = 4663;
export const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const EXPLORER = 'https://robinhoodchain.blockscout.com';
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'; // Global Dollar, 6 decimals
export const chain = { id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [PUBLIC_RPC] } } };
export const client = (rpc) => createPublicClient({ chain, transport: http(rpc || PUBLIC_RPC) });

export const TILL_ABI = parseAbi([
  'struct Payment { address from; address seller; uint256 value; uint256 validAfter; uint256 validBefore; bytes32 ref; uint8 v; bytes32 r; bytes32 s; }',
  'function settle(Payment p)',
  'function feeFor(address seller, uint256 value) view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'event Paid(bytes32 indexed ref, address indexed buyer, address indexed seller, uint256 value, uint256 fee)',
  'error NotPaid()',
  'error NoSeller()',
  'error TransferFailed()',
]);

export const addr = (a) => {
  try { return getAddress(a); } catch { throw Object.assign(new Error('not an address'), { status: 400 }); }
};
// USDG units (6 decimals) from a dollar price, and back
export const toUnits = (usd) => BigInt(Math.round(Number(usd) * 1e6));
export const fromUnits = (units) => Number(units) / 1e6;

export const nonceFor = (seller, ref) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [seller, ref]));
export const newRef = () => `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

const DOMAIN = { name: 'Global Dollar', version: '1', chainId: CHAIN_ID, verifyingContract: USDG };
const TYPES = { ReceiveWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };
const typed = (p, till) => ({
  domain: DOMAIN, types: TYPES, primaryType: 'ReceiveWithAuthorization',
  message: { from: p.from, to: till, value: BigInt(p.value), validAfter: BigInt(p.validAfter), validBefore: BigInt(p.validBefore), nonce: nonceFor(p.seller, p.ref) },
});

/// The buyer's side: sign one payment. `account` is a viem account, value is USDG units.
export async function signPayment(account, { till, seller, value, ref = newRef(), validAfter = 0, validBefore }) {
  const p = { from: account.address, seller, value: String(value), validAfter: String(validAfter), validBefore: String(validBefore ?? Math.floor(Date.now() / 1000) + 300), ref };
  return { ...p, signature: await account.signTypedData(typed(p, till)) };
}

// The payment travels in the X-Payment header as base64 JSON.
export const encodePayment = (p) => btoa(JSON.stringify(p));
export function decodePayment(header) {
  try {
    const p = JSON.parse(atob(header));
    const out = { from: getAddress(p.from), seller: getAddress(p.seller), value: BigInt(p.value), validAfter: BigInt(p.validAfter), validBefore: BigInt(p.validBefore), ref: p.ref, signature: p.signature };
    if (!/^0x[0-9a-fA-F]{64}$/.test(out.ref) || !/^0x[0-9a-fA-F]{130}$/.test(out.signature) || out.value < 0n) return null;
    return out;
  } catch { return null; }
}

export const signerOf = (p, till) => recoverTypedDataAddress({ ...typed(p, till), signature: p.signature });

/// The struct HawkerTill.settle takes.
export function toStruct(p) {
  const s = parseSignature(p.signature);
  return { from: p.from, seller: p.seller, value: BigInt(p.value), validAfter: BigInt(p.validAfter), validBefore: BigInt(p.validBefore), ref: p.ref, v: Number(s.v ?? 27n + BigInt(s.yParity)), r: s.r, s: s.s };
}

/// What a seller signs with the payout wallet to open, change or close a stall.
export const stallMessage = ({ slug, url, priceUsd, payTo, open = true, at }) =>
  `HAWKER stall\nslug: ${slug}\nurl: ${url}\nprice: ${priceUsd} USDG per call\npay to: ${payTo}\nopen: ${open ? 'yes' : 'no'}\nat: ${at}`;

/// A URL the gateway is willing to fetch: https on a public host name, default port, no credentials.
export function publicUrl(raw, allowHttp = false) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password) return null;
  if (allowHttp) return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  const h = u.hostname;
  if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return null;
  if (h === 'localhost' || !h.includes('.') || h.includes(':') || /^[\d.]+$/.test(h) || /\.(local|internal|localhost|test|lan|home)$/.test(h)) return null;
  return u;
}
