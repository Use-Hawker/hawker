// The share card for every page: site/og-image.png, 1200x630. node og.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mark } from './mark.mjs';
const sharp = createRequire(import.meta.url)('sharp');

const INK = '#17130d', GOLD = '#f0b429', PAPER = '#f4ecdc';
const stripes = Array.from({ length: 12 }, (_, i) => `<rect x="${i * 112 + 56}" y="0" width="56" height="54" fill="${INK}"/><circle cx="${i * 112 + 84}" cy="54" r="28" fill="${INK}"/><circle cx="${i * 112 + 28}" cy="54" r="28" fill="${GOLD}"/>`).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="${PAPER}"/>
  <rect width="1200" height="54" fill="${GOLD}"/>${stripes}
  <g font-family="Arial Black, Arial, sans-serif" font-weight="900" fill="${INK}">
    <text x="80" y="250" font-size="86" letter-spacing="-2">APIs sold</text>
    <rect x="72" y="282" width="500" height="100" fill="${GOLD}"/>
    <text x="80" y="360" font-size="86" letter-spacing="-2">by the call.</text>
    <text x="80" y="450" font-size="38" font-weight="700" font-family="Arial, sans-serif">Paid in USDG on Robinhood Chain,</text>
    <text x="80" y="500" font-size="38" font-weight="700" font-family="Arial, sans-serif">straight to the seller.</text>
    <text x="80" y="580" font-size="30" font-family="Consolas, monospace" font-weight="700">usehawker.fun</text>
  </g>
</svg>`;
const logo = await sharp(Buffer.from(mark('b'))).resize(330, 330).png().toBuffer();
await sharp(Buffer.from(svg)).composite([{ input: logo, left: 790, top: 180 }]).png().toFile(fileURLToPath(new URL('../site/og-image.png', import.meta.url)));
console.log('wrote site/og-image.png');
