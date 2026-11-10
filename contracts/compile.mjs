// Compiles HawkerTill.sol with solc 0.8.24 (optimizer 200, viaIR, cancun) into build/HawkerTill.json and the Standard JSON input for Sourcify.
import solc from 'solc';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const input = {
  language: 'Solidity',
  sources: { 'HawkerTill.sol': { content: readFileSync(new URL('./HawkerTill.sol', import.meta.url), 'utf8') } },
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.methodIdentifiers'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors || []) console.log(e.severity, e.formattedMessage);
if ((out.errors || []).some((e) => e.severity === 'error')) process.exit(1);
const c = out.contracts['HawkerTill.sol'].HawkerTill;
mkdirSync(new URL('./build/', import.meta.url), { recursive: true });
writeFileSync(new URL('./build/HawkerTill.json', import.meta.url), JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, selectors: c.evm.methodIdentifiers }, null, 1));
writeFileSync(new URL('./HawkerTill.standard-input.json', import.meta.url), JSON.stringify({ ...input, settings: { ...input.settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } } } }, null, 2));
console.log('compiled, runtime', c.evm.deployedBytecode.object.length / 2, 'bytes');
console.log(c.evm.methodIdentifiers);
const template = new URL('./deploy.template.html', import.meta.url);
if (existsSync(template)) {
  writeFileSync(new URL('./deploy.html', import.meta.url), readFileSync(template, 'utf8').replace('__BYTECODE__', '0x' + c.evm.bytecode.object));
  console.log('wrote deploy.html');
}
