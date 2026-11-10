// Draws the HAWKER mark (a hawk's head, flat, three colours) and renders avatar.png, favicon and a check sheet.
// node render.mjs [variant]
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
const sharp = createRequire(import.meta.url)('sharp');

import { mark } from './mark.mjs';

const png = (svg, size) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
const out = (name) => new URL(`./${name}`, import.meta.url);
const variants = ['a', 'b', 'c'];
// sheet: each variant at 400, in a circle crop at 200, and at 48
const tiles = [];
for (const [i, v] of variants.entries()) {
  const big = await png(mark(v), 400);
  const round = await sharp(big).resize(200, 200).composite([{ input: Buffer.from('<svg width="200" height="200"><circle cx="100" cy="100" r="100"/></svg>'), blend: 'dest-in' }]).png().toBuffer();
  tiles.push({ input: big, left: i * 420 + 10, top: 10 }, { input: round, left: i * 420 + 10, top: 430 }, { input: await png(mark(v), 48), left: i * 420 + 240, top: 430 }, { input: await png(mark(v), 24), left: i * 420 + 310, top: 430 });
}
await sharp({ create: { width: 1270, height: 640, channels: 3, background: '#777' } }).composite(tiles).png().toFile(fileURLToPath(out('sheet.png')));

const pick = process.argv[2] || 'b';
writeFileSync(out('logo.svg'), mark(pick));
writeFileSync(out('avatar.png'), await png(mark(pick), 800));
writeFileSync(out('small48.png'), await png(mark(pick), 48));
writeFileSync(new URL('../site/favicon.png', import.meta.url), await png(mark(pick), 64));
writeFileSync(new URL('../site/logo.svg', import.meta.url), mark(pick));
console.log('rendered variant', pick);
