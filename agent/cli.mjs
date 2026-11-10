#!/usr/bin/env node
// hawker init | balance | stalls | call <stall> [json] [--max usd] | list <slug> <url> <price> <name> <summary> | close <slug> <url> <price> | mcp
import { init, loadConfig, stalls, balance, call, listStall } from './hawker-agent.mjs';
import { serve } from './mcp.mjs';

const [cmd, ...args] = process.argv.slice(2);
const out = (v) => console.log(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2));
const usage = `hawker init                                  make the agent's key, print the address to fund with USDG
hawker balance                               USDG in the wallet, spent today, limits
hawker stalls                                the catalog with prices
hawker call <stall> [json] [--max usd]       pay for one call, print the answer and the receipt
hawker list <slug> <url> <price> <name> <summary>   open or change your own stall, paid to this key's address
hawker close <slug> <url> <price>            close your stall
hawker mcp                                   MCP server over stdio`;

try {
  if (cmd === 'mcp') serve();
  else if (cmd === 'init') out(init());
  else if (!cmd || cmd === 'help') console.log(usage);
  else {
    const cfg = loadConfig();
    if (cmd === 'balance') out(await balance(cfg));
    else if (cmd === 'stalls') out(await stalls(cfg));
    else if (cmd === 'call') {
      const max = args.indexOf('--max');
      const maxUsd = max >= 0 ? Number(args.splice(max, 2)[1]) : undefined;
      out(await call(cfg, args[0], args[1] ? JSON.parse(args[1]) : {}, { maxUsd }));
    } else if (cmd === 'list') out(await listStall(cfg, { slug: args[0], url: args[1], priceUsd: args[2], name: args[3], summary: args[4], docs: args[5] || '' }));
    else if (cmd === 'close') out(await listStall(cfg, { slug: args[0], url: args[1], priceUsd: args[2], name: args[0], summary: 'closed', open: false }));
    else console.log(usage);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
