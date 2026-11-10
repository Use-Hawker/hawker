// Serves deploy.html on localhost (wallets do not inject into file:// pages) and waits for the page to report the new till.
// The address is checked on chain (receipt, USDG, fee, fee wallet) before it is written to deployed.json; then the server exits.
// Run: node deploy-server.mjs [port]
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

const port = Number(process.argv[2] || 47241);
const RPC = process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const read = (to, selector) => rpc('eth_call', [{ to, data: selector }, 'latest']);
const asAddr = (word) => `0x${word.slice(-40)}`;

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/deployed') {
    let body = '';
    for await (const c of req) body += c;
    try {
      const { address, tx, from } = JSON.parse(body);
      const receipt = await rpc('eth_getTransactionReceipt', [tx]);
      if (!receipt || receipt.status !== '0x1' || receipt.contractAddress?.toLowerCase() !== String(address).toLowerCase()) throw new Error('receipt does not match');
      const till = receipt.contractAddress;
      // usdg(), feeSink(), feeBps(), owner()
      const [usdg, feeSink, feeBps, owner] = await Promise.all([read(till, '0xf5b91b7b'), read(till, '0x4b38474d'), read(till, '0x24a9d853'), read(till, '0x8da5cb5b')]);
      if (asAddr(usdg) !== USDG) throw new Error('the till is not on the real USDG');
      writeFileSync(new URL('./deployed.json', import.meta.url), JSON.stringify({ address: till, tx, owner: asAddr(owner), feeSink: asAddr(feeSink), feeBps: Number(BigInt(feeBps)), block: Number(BigInt(receipt.blockNumber)) }, null, 2));
      res.writeHead(200).end('ok');
      console.log('DEPLOYED', till, 'tx', tx, 'owner', from, 'feeSink', asAddr(feeSink), 'feeBps', Number(BigInt(feeBps)));
      setTimeout(() => process.exit(0), 300);
    } catch (e) { res.writeHead(400).end(e.message); console.log('bad report:', e.message); }
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(new URL('./deploy.html', import.meta.url)));
});
server.listen(port, () => console.log(`deploy page on http://localhost:${port}/`));
