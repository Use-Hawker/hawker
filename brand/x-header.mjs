// The X header (1500x500): the awning on top, the line, and price tags hanging on a rail. node x-header.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { INK, GOLD } from './mark.mjs';
const sharp = createRequire(import.meta.url)('sharp');

const PAPER = '#f4ecdc', CARD = '#fffaf0';
const stripes = Array.from({ length: 14 }, (_, i) => `<rect x="${i * 112 + 56}" y="0" width="56" height="44" fill="${INK}"/><circle cx="${i * 112 + 84}" cy="44" r="28" fill="${INK}"/><circle cx="${i * 112 + 28}" cy="44" r="28" fill="${GOLD}"/>`).join('');
// three tags on a rail, right side; X puts the avatar over the bottom left
const tag = (x, price, name) => `
  <line x1="${x + 80}" y1="250" x2="${x + 80}" y2="284" stroke="${INK}" stroke-width="3"/>
  <path d="M${x + 20} 284 H${x + 140} L${x + 160} 304 V450 H${x} V304 Z" fill="${CARD}" stroke="${INK}" stroke-width="3"/>
  <circle cx="${x + 80}" cy="298" r="7" fill="${PAPER}" stroke="${INK}" stroke-width="3"/>
  <text x="${x + 20}" y="358" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="36" fill="${INK}">$${price}</text>
  <text x="${x + 20}" y="384" font-family="Consolas, monospace" font-size="15" fill="#6d6250">USDG / call</text>
  <text x="${x + 20}" y="424" font-family="Arial, sans-serif" font-weight="700" font-size="19" fill="${INK}">${name}</text>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500">
  <rect width="1500" height="500" fill="${PAPER}"/>
  <rect width="1500" height="44" fill="${GOLD}"/>${stripes}
  <g font-family="Arial Black, Arial, sans-serif" font-weight="900" fill="${INK}">
    <text x="420" y="168" font-size="64" letter-spacing="-1">APIs sold</text>
    <rect x="412" y="186" width="406" height="76" fill="${GOLD}"/>
    <text x="420" y="248" font-size="64" letter-spacing="-1">by the call.</text>
    <text x="420" y="306" font-size="26" font-weight="700" font-family="Arial, sans-serif">Paid in USDG on Robinhood Chain.</text>
  </g>
  <line x1="930" y1="250" x2="1460" y2="250" stroke="${INK}" stroke-width="5"/>
  ${tag(945, '0.02', 'Coin Price')}${tag(1125, '0.05', 'Your API')}${tag(1305, '0.03', 'Tx Reader')}
</svg>`;
await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL('./x-header.png', import.meta.url)));
console.log('wrote x-header.png');
