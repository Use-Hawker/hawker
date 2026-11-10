// Runs the gateway under Node with SQLite in place of D1, and serves ../site next to it. node dev.mjs [port]
// Settings come from .dev.vars (TILL, GAS_KEY, RH_RPC_URL, HOUSE_PAY_TO, ...); the environment wins over the file.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import worker from './src/index.js';
import { sqliteD1 } from './d1-sqlite.mjs';

const file = new URL('./.dev.vars', import.meta.url);
const vars = existsSync(file) ? Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])) : {};
for (const k of ['TILL', 'GAS_KEY', 'RH_RPC_URL', 'HOUSE_PAY_TO', 'FEE_BPS', 'MIN_PRICE', 'ALLOW_HTTP_UPSTREAM', 'ADMIN_KEY', 'TOKEN_ADDRESS']) if (process.env[k]) vars[k] = process.env[k];
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', png: 'image/png', svg: 'image/svg+xml', json: 'application/json', ico: 'image/x-icon' };
const ASSETS = {
  fetch: async (request) => {
    let p = new URL(request.url).pathname.replace(/\/$/, '/index.html').replace(/\.\./g, '');
    // like Cloudflare's assets: /stalls serves stalls/index.html
    if (!p.split('/').pop().includes('.')) p += '/index.html';
    const f = new URL(`../site${p}`, import.meta.url);
    return existsSync(f) ? new Response(readFileSync(f), { headers: { 'content-type': TYPES[p.split('.').pop()] || 'application/octet-stream' } }) : new Response('not found', { status: 404 });
  },
};
const env = { ...vars, DB: sqliteD1(process.env.DB_FILE || ':memory:'), ASSETS };
const port = Number(process.argv[2] || 8862);
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`hawker dev on http://localhost:${port}`));
