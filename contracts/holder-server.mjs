// Serves holder.html on localhost (wallets do not inject into file:// pages); exits after the page reports the tx.
// Run: node holder-server.mjs [port]
import http from 'node:http';
import { readFileSync } from 'node:fs';

const port = Number(process.argv[2] || 47242);
http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/set') {
    let body = '';
    for await (const c of req) body += c;
    console.log('SET', body);
    res.writeHead(200).end('ok');
    setTimeout(() => process.exit(0), 300);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(new URL('./holder.html', import.meta.url)));
}).listen(port, () => console.log(`holder page on http://localhost:${port}/`));
