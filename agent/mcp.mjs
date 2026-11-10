// Local MCP server over stdio. The agent's key stays in this process; the model only sees stalls, prices and answers.
import readline from 'node:readline';
import { loadConfig, stalls, balance, call } from './hawker-agent.mjs';

const TOOLS = [
  { name: 'hawker_stalls', description: 'The HAWKER catalog on Robinhood Chain: paid APIs ("stalls") with their price per call in USDG and the input each one takes. Read it before calling a stall.', inputSchema: { type: 'object', properties: {} } },
  { name: 'hawker_call', description: 'Call one stall and pay for it in USDG from the agent\'s wallet. The price is the one in the catalog; a call that fails is not charged. Returns the stall\'s answer and a receipt with the transaction. max_usd refuses the call if it costs more.', inputSchema: { type: 'object', properties: { stall: { type: 'string', description: 'The stall\'s slug, e.g. rh-wallet' }, input: { type: 'object', description: 'The JSON the stall takes' }, max_usd: { type: 'number' } }, required: ['stall'] } },
  { name: 'hawker_balance', description: 'The agent wallet\'s USDG balance, what it spent today and its per-call and per-day limits.', inputSchema: { type: 'object', properties: {} } },
];

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const text = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)) }] });

async function runTool(name, a) {
  const cfg = loadConfig();
  if (name === 'hawker_stalls') return stalls(cfg);
  if (name === 'hawker_call') return call(cfg, String(a.stall || ''), a.input || {}, { maxUsd: a.max_usd });
  if (name === 'hawker_balance') return balance(cfg);
  throw new Error('unknown tool');
}

export function serve() {
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id === undefined) return;
    const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') {
      return ok({
        protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hawker', version: '0.1.0' },
        instructions: 'You can buy API calls on HAWKER with USDG on Robinhood Chain. Each hawker_call spends real money from the owner\'s budget: read hawker_stalls for prices first, call only what the task needs, and stop when a limit refuses a call instead of looking for a way around it.',
      });
    }
    if (m.method === 'ping') return ok({});
    if (m.method === 'tools/list') return ok({ tools: TOOLS });
    if (m.method === 'tools/call') {
      try { return ok(text(await runTool(m.params.name, m.params.arguments || {}))); } catch (e) {
        return ok({ ...text({ error: e.message }), isError: true });
      }
    }
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown method' } });
  });
}
