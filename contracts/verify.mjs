// Sends HawkerTill's source to Sourcify for the address in deployed.json. node verify.mjs
import { readFileSync } from 'node:fs';
import solc from 'solc';
const d = JSON.parse(readFileSync(new URL('./deployed.json', import.meta.url)));
const input = JSON.parse(readFileSync(new URL('./HawkerTill.standard-input.json', import.meta.url)));
const compilerVersion = solc.version().replace('.Emscripten.clang', '');
const r = await fetch(`https://sourcify.dev/server/v2/verify/4663/${d.address}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stdJsonInput: input, compilerVersion, contractIdentifier: 'HawkerTill.sol:HawkerTill', creationTransactionHash: d.tx }),
});
const j = await r.json();
console.log(r.status, JSON.stringify(j));
for (let i = 0; i < 30 && j.verificationId; i++) {
  await new Promise((ok) => setTimeout(ok, 3000));
  const s = await (await fetch(`https://sourcify.dev/server/v2/verify/${j.verificationId}`)).json();
  if (s.isJobCompleted) { console.log(JSON.stringify(s.contract || s.error)); break; }
}
