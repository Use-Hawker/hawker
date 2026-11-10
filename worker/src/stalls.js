// The house stalls: HAWKER's own listings, so a call can be paid for on day one. Open data and the chain itself, no AI.
// They are paid through the till like any other stall; the seller is HOUSE_PAY_TO.
import { erc20Abi, formatEther, formatUnits, decodeEventLog } from 'viem';
import { client, addr, USDG, TILL_ABI, publicUrl } from '../../core/hawker.mjs';

const fail = (code) => Object.assign(new Error(code), { input: true });
const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const HEX64 = /^0x[0-9a-fA-F]{64}$/;

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.json();
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const plain = (html) => html
  .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>|<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : entities[e.toLowerCase()] ?? m))
  .replace(/[ \t\r\f]+/g, ' ').replace(/ ?\n[ \n]*/g, '\n').trim();

export const HOUSE = [
  {
    slug: 'page-text', name: 'Page Text', price: 0.02, summary: 'Fetches a web page and returns its title and readable text, without the markup.',
    input: [{ name: 'url', type: 'string', required: true, description: 'Public https page.', example: 'https://docs.robinhood.com/chain/bridging' }],
    run: async (env, { url }) => {
      const u = publicUrl(url, env.ALLOW_HTTP_UPSTREAM === '1');
      if (!u) throw fail('invalid_url');
      const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'HawkerBot/0.1 (+page-text stall)', accept: 'text/html,text/plain;q=0.9' } }).catch(() => null);
      if (!r || !r.ok) throw fail('fetch_failed');
      if (!/text\/|json|xml/.test(r.headers.get('content-type') || 'text/html')) throw fail('not_text');
      const html = (await r.text()).slice(0, 1_500_000);
      const text = plain(html);
      return { url: r.url || String(u), title: plain(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''), chars: text.length, truncated: text.length > 20000, text: text.slice(0, 20000) };
    },
  },
  {
    slug: 'coin-price', name: 'Coin Price', price: 0.02, summary: 'Current USD prices for up to 20 coins by CoinGecko id, from DefiLlama.',
    input: [{ name: 'ids', type: 'string', required: true, pattern: /^[a-z0-9-]+(,[a-z0-9-]+){0,19}$/, description: 'CoinGecko ids, comma separated.', example: 'ethereum,bitcoin' }],
    run: async (_env, { ids }) => {
      const j = await getJson(`https://coins.llama.fi/prices/current/${ids.split(',').map((i) => `coingecko:${i}`).join(',')}`);
      const prices = Object.fromEntries(ids.split(',').map((i) => [i, j.coins?.[`coingecko:${i}`] ? { usd: j.coins[`coingecko:${i}`].price, symbol: j.coins[`coingecko:${i}`].symbol, at: j.coins[`coingecko:${i}`].timestamp } : null]));
      if (Object.values(prices).every((p) => !p)) throw fail('unknown_coin');
      return { prices, source: 'DefiLlama' };
    },
  },
  {
    slug: 'rh-wallet', name: 'Robinhood Chain Wallet', price: 0.02, summary: 'ETH and USDG balance, transactions sent and whether the address is a contract.',
    input: [{ name: 'address', type: 'string', required: true, pattern: HEX40, description: 'Wallet or contract on Robinhood Chain.', example: USDG }],
    run: async (env, { address }) => {
      const pub = client(env.RH_RPC_URL), a = addr(address);
      const [eth, usdg, sent, code] = await Promise.all([
        pub.getBalance({ address: a }), pub.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [a] }),
        pub.getTransactionCount({ address: a }), pub.getCode({ address: a }),
      ]);
      return { address: a, eth: formatEther(eth), usdg: formatUnits(usdg, 6), transactionsSent: sent, contract: !!code && code !== '0x' };
    },
  },
  {
    slug: 'rh-token', name: 'Robinhood Chain Token', price: 0.02, summary: 'Name, symbol, decimals and supply of an ERC-20 on Robinhood Chain, plus one holder\'s balance.',
    input: [
      { name: 'token', type: 'string', required: true, pattern: HEX40, description: 'Token contract.', example: USDG },
      { name: 'holder', type: 'string', required: false, pattern: HEX40, description: 'Wallet to read the balance of.' },
    ],
    run: async (env, { token, holder }) => {
      const pub = client(env.RH_RPC_URL), t = addr(token);
      const read = (functionName, args) => pub.readContract({ address: t, abi: erc20Abi, functionName, args }).catch(() => null);
      const [name, symbol, decimals, supply, bal] = await Promise.all([read('name'), read('symbol'), read('decimals'), read('totalSupply'), holder ? read('balanceOf', [addr(holder)]) : null]);
      if (decimals === null || supply === null) throw fail('not_a_token');
      return { token: t, name, symbol, decimals, totalSupply: formatUnits(supply, decimals), ...(holder ? { holder: addr(holder), balance: bal === null ? null : formatUnits(bal, decimals) } : {}) };
    },
  },
  {
    slug: 'rh-tx', name: 'Robinhood Chain Transaction', price: 0.03, summary: 'What a transaction did: status, fee, USDG transfers and any HAWKER payment in it.',
    input: [{ name: 'hash', type: 'string', required: true, pattern: HEX64, description: 'Transaction hash.' }],
    run: async (env, { hash }) => {
      const pub = client(env.RH_RPC_URL);
      const [tx, r] = await Promise.all([pub.getTransaction({ hash }).catch(() => null), pub.getTransactionReceipt({ hash }).catch(() => null)]);
      if (!tx || !r) throw fail('unknown_transaction');
      const logs = (abi, at) => r.logs.filter((l) => l.address.toLowerCase() === at.toLowerCase()).map((l) => { try { return decodeEventLog({ abi, data: l.data, topics: l.topics }); } catch { return null; } }).filter(Boolean);
      return {
        hash, status: r.status, block: Number(r.blockNumber), from: tx.from, to: tx.to, valueEth: formatEther(tx.value),
        feeEth: formatEther(r.gasUsed * (r.effectiveGasPrice ?? 0n)), gasUsed: Number(r.gasUsed), logs: r.logs.length,
        usdgTransfers: logs(erc20Abi, USDG).filter((e) => e.eventName === 'Transfer').map((e) => ({ from: e.args.from, to: e.args.to, usdg: formatUnits(e.args.value, 6) })),
        hawkerPayments: env.TILL ? logs(TILL_ABI, env.TILL).filter((e) => e.eventName === 'Paid').map((e) => ({ ref: e.args.ref, buyer: e.args.buyer, seller: e.args.seller, usdg: formatUnits(e.args.value, 6), fee: formatUnits(e.args.fee, 6) })) : [],
      };
    },
  },
];

export const houseBy = (slug) => HOUSE.find((s) => s.slug === slug);

/// Checks a house stall's input before any payment is asked for.
export function checkInput(stall, body) {
  const input = {};
  for (const f of stall.input) {
    const v = body?.[f.name];
    if (v === undefined || v === null || v === '') {
      if (f.required) return { error: `missing_${f.name}` };
      continue;
    }
    if (typeof v !== 'string' || v.length > 2000 || (f.pattern && !f.pattern.test(v))) return { error: `invalid_${f.name}` };
    input[f.name] = v;
  }
  return { input };
}
