// The $HAWKER launch clip: a new tag goes up on the rail, then what holding it does for a seller at the till.
// 1280x720, 30 fps, about 19 seconds. SVG frames -> sharp -> ffmpeg.
// Run: FFMPEG=<path to ffmpeg.exe> CA=0x… node launch.mjs  -> launch.mp4 (CA is optional, shown on the end card).
// ONLY=3,9 writes those seconds as PNGs.
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mark, INK, GOLD } from './mark.mjs';
const sharp = createRequire(new URL('../../worker/', import.meta.url))('sharp');

const W = 1280, H = 720, FPS = 30;
const PAPER = '#f4ecdc', CARD = '#fffaf0', SOFT = '#6d6250', BODY = '#3d3528', RED = '#b3261e', GREEN = '#1f6b3a';
const SANS = 'Arial Black, Arial, sans-serif', TEXT = 'Arial, sans-serif', MONO = 'Consolas, monospace';
const TILL = '0x8281…a45e';
const CA = process.env.CA || '';
const S = { intro: [0, 5], fee: [5, 14.5], end: [14.5, 19] };
const END = S.end[1];

const clamp = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const span = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const typed = (text, t, a, b) => esc(text.slice(0, Math.floor(span(t, a, b) * text.length)));
const fade = (t, [a, b]) => Math.min(ease(span(t, a, a + 0.45)), 1 - ease(span(t, b - 0.35, b)));
const logo = (x, y, size) => `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 400 400">${mark('b').replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</svg>`;

const awning = () => {
  let s = `<rect width="${W}" height="34" fill="${GOLD}"/>`;
  for (let i = 0; i < 12; i++) s += `<rect x="${i * 112 + 56}" y="0" width="56" height="34" fill="${INK}"/><circle cx="${i * 112 + 84}" cy="34" r="28" fill="${INK}"/><circle cx="${i * 112 + 28}" cy="34" r="28" fill="${GOLD}"/>`;
  return s;
};
const label = (t, sc, n, text) => `<g opacity="${fade(t, sc).toFixed(2)}">
  <text x="70" y="126" font-family="${MONO}" font-weight="700" font-size="18" letter-spacing="4" fill="${SOFT}">${n}</text>
  <text x="70" y="172" font-family="${SANS}" font-size="40" fill="${INK}">${esc(text)}</text></g>`;
const stamp = (t, at, x, y, text, color, w = 220) => {
  const k = ease(span(t, at, at + 0.25));
  return t < at ? '' : `<g transform="translate(${x} ${y}) rotate(-7) scale(${lerp(1.8, 1, k).toFixed(3)})" opacity="${k.toFixed(2)}">
    <rect x="${-w / 2}" y="-30" width="${w}" height="52" fill="none" stroke="${color}" stroke-width="4"/>
    <text y="8" text-anchor="middle" font-family="${MONO}" font-weight="700" font-size="26" letter-spacing="4" fill="${color}">${text}</text></g>`;
};
const note = (t, at, x, y, lines) => `<g opacity="${ease(span(t, at, at + 0.4)).toFixed(2)}">${lines.map((l, i) => `<text x="${x}" y="${y + i * 32}" font-family="${i ? TEXT : SANS}" font-size="${i ? 19 : 24}" fill="${i ? BODY : INK}">${esc(l)}</text>`).join('')}</g>`;
// a tag hanging from the rail; it drops in and swings at time a
function tag(t, a, x, y, w, big, sub, name, accent) {
  const k = ease(span(t, a, a + 0.6));
  const swing = Math.sin(Math.max(0, t - a) * 5) * 7 * (1 - span(t, a, a + 2.4));
  return `<g transform="translate(${x} ${lerp(y - 70, y, k)}) rotate(${swing.toFixed(2)} ${w / 2} -40)" opacity="${k.toFixed(2)}">
    <line x1="${w / 2}" y1="-56" x2="${w / 2}" y2="0" stroke="${INK}" stroke-width="3"/>
    <path d="M24 0 H${w - 24} L${w} 24 V190 H0 V24 Z" fill="${accent ? GOLD : CARD}" stroke="${INK}" stroke-width="3"/>
    <circle cx="${w / 2}" cy="18" r="8" fill="${PAPER}" stroke="${INK}" stroke-width="3"/>
    <text x="22" y="92" font-family="${SANS}" font-size="${accent ? 44 : 36}" fill="${INK}">${esc(big)}</text>
    <text x="22" y="124" font-family="${MONO}" font-size="15" fill="${accent ? INK : SOFT}">${esc(sub)}</text>
    <text x="22" y="166" font-family="${TEXT}" font-weight="700" font-size="20" fill="${INK}">${esc(name)}</text></g>`;
}
// one payment through the till: from the agent to the seller and the fee sink
function receipt(t, a, x, y, title, holds, sellerGets, fee) {
  const k = ease(span(t, a, a + 0.5));
  const rows = [['agent pays', '0.0200 USDG', 0.5, INK], ['seller holds $HAWKER', holds ? 'yes' : 'no', 1.0, holds ? GREEN : SOFT], ['fee  feeFor(seller)', fee, 1.5, holds ? GREEN : INK], ['seller gets', sellerGets, 2.0, holds ? GREEN : INK]];
  return `<g transform="translate(${x} ${lerp(y + 24, y, k)})" opacity="${k.toFixed(2)}">
    <rect width="520" height="268" rx="14" fill="${CARD}" stroke="${INK}" stroke-width="3"/>
    <rect width="520" height="48" rx="14" fill="${INK}"/><rect y="30" width="520" height="18" fill="${INK}"/>
    <text x="22" y="32" font-family="${MONO}" font-weight="700" font-size="16" letter-spacing="2" fill="${PAPER}">${esc(title)}</text>
    ${rows.map(([kk, v, at, c], i) => (t > a + at ? `<text x="22" y="${98 + i * 44}" font-family="${MONO}" font-size="17" fill="${SOFT}">${kk}</text><text x="498" y="${98 + i * 44}" text-anchor="end" font-family="${MONO}" font-weight="700" font-size="19" fill="${c}">${typed(v, t, a + at, a + at + 0.3)}</text>` : '')).join('')}
  </g>`;
}

function frame(t) {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${PAPER}"/>`;

  // ---- intro: the rail of stalls, and a new tag goes up
  if (t < S.intro[1] + 0.3) {
    const o = Math.min(ease(span(t, 0, 0.4)), 1 - ease(span(t, S.intro[1] - 0.25, S.intro[1] + 0.3)));
    s += `<g opacity="${o.toFixed(2)}">
      <text x="70" y="126" font-family="${MONO}" font-weight="700" font-size="18" letter-spacing="4" fill="${SOFT}" opacity="${ease(span(t, 0.2, 0.8)).toFixed(2)}">NEW ON THE RAIL · PONS · ROBINHOOD CHAIN</text>
      <line x1="40" y1="210" x2="1240" y2="210" stroke="${INK}" stroke-width="5"/>
      ${tag(t, 0.2, 70, 266, 240, '$0.02', 'USDG / call', 'Coin Price')}
      ${tag(t, 0.45, 340, 266, 240, '$0.03', 'USDG / call', 'Tx Reader')}
      ${tag(t, 0.7, 610, 266, 240, '$0.02', 'USDG / call', 'Page Text')}
      ${tag(t, 1.6, 890, 266, 320, '$HAWKER', 'on Pons', 'now trading', true)}
      ${stamp(t, 2.6, 1050, 520, 'OPEN', GREEN, 150)}
      ${note(t, 3.0, 70, 560, ['The market has its own tag.', 'Holding it changes what a seller pays at the till.'])}</g>`;
  }

  // ---- the fee: two sellers, the same call
  if (t >= S.fee[0] && t < S.fee[1]) {
    const a = S.fee[0];
    s += label(t, S.fee, 'AT THE TILL', 'Sellers who hold $HAWKER pay no fee');
    s += `<g opacity="${fade(t, S.fee).toFixed(2)}">
      ${receipt(t, a + 0.5, 70, 220, 'SELLER A · no $HAWKER', false, '0.0194 USDG', '3% · 0.0006')}
      ${receipt(t, a + 2.6, 690, 220, 'SELLER B · holds $HAWKER', true, '0.0200 USDG', '0%  · 0')}
      ${stamp(t, a + 5.0, 1090, 580, 'FEE 0%', GREEN, 170)}
      ${note(t, a + 5.6, 70, 548, ['The till checks it on every payment.', `HawkerTill ${TILL} reads the seller's $HAWKER balance in feeFor().`, 'No claim, no form. Hold it and the fee is gone.'])}</g>`;
  }

  // ---- end card
  if (t >= S.end[0]) {
    const o = ease(span(t, S.end[0], S.end[0] + 0.6));
    s += `<g opacity="${o.toFixed(2)}"><rect width="${W}" height="${H}" fill="${PAPER}"/>
      ${logo(565, 100, 150)}
      <text x="640" y="330" text-anchor="middle" font-family="${SANS}" font-size="54" fill="${INK}">$HAWKER is on Pons.</text>
      <rect x="250" y="356" width="780" height="72" fill="${GOLD}"/>
      <text x="640" y="410" text-anchor="middle" font-family="${SANS}" font-size="54" fill="${INK}">Hold it, sell with 0% fee.</text>
      ${CA ? `<text x="640" y="486" text-anchor="middle" font-family="${MONO}" font-size="20" fill="${SOFT}">CA ${esc(CA)}</text>` : `<text x="640" y="486" text-anchor="middle" font-family="${MONO}" font-size="19" letter-spacing="4" fill="${SOFT}">ROBINHOOD CHAIN · PONS</text>`}
      <text x="640" y="580" text-anchor="middle" font-family="${MONO}" font-weight="700" font-size="30" letter-spacing="5" fill="${INK}">USEHAWKER.FUN</text></g>`;
  }
  return s + awning() + '</svg>';
}

const only = process.env.ONLY;
if (only) {
  for (const t of only.split(',').map(Number)) await sharp(Buffer.from(frame(t))).png().toFile(fileURLToPath(new URL(`./launch-${t}.png`, import.meta.url)));
  process.exit(0);
}
const dir = join(tmpdir(), 'hawker-launch-frames');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const total = Math.round(END * FPS);
for (let i = 0; i < total; i++) await sharp(Buffer.from(frame(i / FPS))).png().toFile(join(dir, `f${String(i).padStart(4, '0')}.png`));
const out = fileURLToPath(new URL('./launch.mp4', import.meta.url));
execFileSync(process.env.FFMPEG || 'ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, 'f%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', out]);
rmSync(dir, { recursive: true, force: true });
console.log('wrote', out, total, 'frames');
