// The HAWKER demo clip: one paid call, start to finish. 1280x720, 30 fps, about 33 seconds.
// The agent asks a stall, gets a price tag, signs a USDG payment, the till splits it between the seller and the fee
// in one transaction, the answer comes back; then a call that fails and costs nothing. SVG frames -> sharp -> ffmpeg.
// Run: FFMPEG=<path to ffmpeg.exe> node demo.mjs   -> demo.mp4.  ONLY=5,12 writes those seconds as PNGs.
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mark, INK, GOLD } from './mark.mjs';
const sharp = createRequire(import.meta.url)('sharp');

const W = 1280, H = 720, FPS = 30;
const PAPER = '#f4ecdc', PAPER2 = '#ebe0c9', CARD = '#fffaf0', SOFT = '#6d6250', BODY = '#3d3528', RED = '#b3261e', GREEN = '#1f6b3a', BOARD = '#1b211d', CHALK = '#e9e6d8', CHALK2 = '#9aa397';
const SANS = 'Arial Black, Arial, sans-serif', TEXT = 'Arial, sans-serif', MONO = 'Consolas, monospace';
const TILL = '0x8281…a45e', SELLER = '0x43cf…3471', AGENT = '0x7a2c…e019';
const S = { intro: [0, 4], ask: [4, 10.5], sign: [10.5, 16], settle: [16, 24], fail: [24, 29.5], end: [29.5, 33] };
const END = S.end[1];

const clamp = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const span = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const typed = (text, t, a, b) => esc(text.slice(0, Math.floor(span(t, a, b) * text.length)));
const fade = (t, [a, b]) => Math.min(ease(span(t, a, a + 0.45)), 1 - ease(span(t, b - 0.35, b)));
const logo = (x, y, size) => `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 400 400">${mark('b').replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</svg>`;

// the striped awning with scallops, always on top
const awning = () => {
  let s = `<rect width="${W}" height="34" fill="${GOLD}"/>`;
  for (let i = 0; i < 12; i++) s += `<rect x="${i * 112 + 56}" y="0" width="56" height="34" fill="${INK}"/><circle cx="${i * 112 + 84}" cy="34" r="28" fill="${INK}"/><circle cx="${i * 112 + 28}" cy="34" r="28" fill="${GOLD}"/>`;
  return s;
};
const label = (t, sc, n, text) => `<g opacity="${fade(t, sc).toFixed(2)}">
  <text x="70" y="126" font-family="${MONO}" font-weight="700" font-size="18" letter-spacing="4" fill="${SOFT}">${n}</text>
  <text x="70" y="172" font-family="${SANS}" font-size="40" fill="${INK}">${esc(text)}</text></g>`;
// a dark terminal panel; lines type out at their times
const term = (t, a, x, y, w, lines) => `<g transform="translate(${x} ${y})"><rect width="${w}" height="${40 + lines.length * 30}" rx="12" fill="${INK}"/>
  ${lines.map(([at, text, c], i) => (t > a + at ? `<text x="20" y="${34 + i * 30}" font-family="${MONO}" font-size="16" fill="${c || '#f1e7d2'}">${typed(text, t, a + at, a + at + 0.45)}</text>` : '')).join('')}</g>`;
// a price tag that swings in from a string
function priceTag(t, a, x, y, rows) {
  const k = ease(span(t, a, a + 0.6));
  const swing = Math.sin(Math.max(0, t - a) * 5) * 6 * (1 - span(t, a, a + 2.2));
  let s = `<g transform="translate(${x} ${lerp(y - 60, y, k)}) rotate(${swing.toFixed(2)} 150 -40)" opacity="${k.toFixed(2)}">
    <line x1="150" y1="-60" x2="150" y2="0" stroke="${INK}" stroke-width="3"/>
    <path d="M30 0 H270 L300 30 V${70 + rows.length * 34} H0 V30 Z" fill="${CARD}" stroke="${INK}" stroke-width="3"/>
    <circle cx="150" cy="18" r="8" fill="${PAPER}" stroke="${INK}" stroke-width="3"/>`;
  rows.forEach(([kk, v, at, big], i) => {
    if (t < a + at) return;
    s += big
      ? `<text x="26" y="${78 + i * 34}" font-family="${SANS}" font-size="38" fill="${INK}">${esc(v)}</text><text x="160" y="${78 + i * 34}" font-family="${MONO}" font-size="15" fill="${SOFT}">USDG / call</text>`
      : `<text x="26" y="${78 + i * 34}" font-family="${MONO}" font-size="15" fill="${SOFT}">${kk}</text><text x="274" y="${78 + i * 34}" text-anchor="end" font-family="${MONO}" font-size="15" fill="${INK}">${typed(v, t, a + at, a + at + 0.3)}</text>`;
  });
  return s + '</g>';
}
const stamp = (t, at, x, y, text, color, w = 220) => {
  const k = ease(span(t, at, at + 0.25));
  return t < at ? '' : `<g transform="translate(${x} ${y}) rotate(-7) scale(${lerp(1.8, 1, k).toFixed(3)})" opacity="${k.toFixed(2)}">
    <rect x="${-w / 2}" y="-30" width="${w}" height="52" fill="none" stroke="${color}" stroke-width="4"/>
    <text y="8" text-anchor="middle" font-family="${MONO}" font-weight="700" font-size="26" letter-spacing="4" fill="${color}">${text}</text></g>`;
};
const note = (t, at, x, y, lines) => `<g opacity="${ease(span(t, at, at + 0.4)).toFixed(2)}">${lines.map((l, i) => `<text x="${x}" y="${y + i * 32}" font-family="${i ? TEXT : SANS}" font-size="${i ? 19 : 24}" fill="${i ? BODY : INK}">${esc(l)}</text>`).join('')}</g>`;
// a labelled box: the agent's wallet, the till, the seller, the fee sink
const box = (x, y, w, title, sub, amount, color = INK, o = 1) => `<g opacity="${o.toFixed(2)}" transform="translate(${x} ${y})">
  <rect width="${w}" height="112" rx="14" fill="${CARD}" stroke="${INK}" stroke-width="3"/>
  <text x="18" y="34" font-family="${MONO}" font-weight="700" font-size="14" letter-spacing="2" fill="${SOFT}">${title}</text>
  <text x="18" y="58" font-family="${MONO}" font-size="14" fill="${SOFT}">${sub}</text>
  <text x="18" y="96" font-family="${SANS}" font-size="28" fill="${color}">${amount}</text></g>`;
const coin = (x, y, text, o = 1) => `<g opacity="${o.toFixed(2)}" transform="translate(${x} ${y})"><circle r="30" fill="${GOLD}" stroke="${INK}" stroke-width="3"/><text y="6" text-anchor="middle" font-family="${MONO}" font-weight="700" font-size="14" fill="${INK}">${text}</text></g>`;

function frame(t) {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${PAPER}"/>`;

  // ---- intro
  if (t < S.intro[1] + 0.3) {
    const o = Math.min(ease(span(t, 0, 0.5)), 1 - ease(span(t, S.intro[1] - 0.25, S.intro[1] + 0.3)));
    s += `<g opacity="${o.toFixed(2)}">
      ${logo(80, lerp(190, 170, ease(span(t, 0, 1))), 150)}
      <text x="80" y="390" font-family="${MONO}" font-weight="700" font-size="20" letter-spacing="6" fill="${SOFT}" opacity="${ease(span(t, 0.3, 0.9)).toFixed(2)}">HAWKER · ROBINHOOD CHAIN</text>
      <g opacity="${ease(span(t, 0.5, 1.2)).toFixed(2)}"><text x="78" y="${lerp(476, 462, ease(span(t, 0.5, 1.4)))}" font-family="${SANS}" font-size="70" fill="${INK}">APIs sold</text></g>
      <g opacity="${ease(span(t, 0.8, 1.5)).toFixed(2)}"><rect x="70" y="${lerp(498, 484, ease(span(t, 0.8, 1.7)))}" width="470" height="84" fill="${GOLD}"/>
      <text x="78" y="${lerp(562, 548, ease(span(t, 0.8, 1.7)))}" font-family="${SANS}" font-size="70" fill="${INK}">by the call.</text></g>
      <text x="80" y="640" font-family="${TEXT}" font-weight="700" font-size="26" fill="${BODY}" opacity="${ease(span(t, 1.4, 2)).toFixed(2)}">An agent pays in USDG. The seller is paid on chain.</text></g>`;
  }

  // ---- 1: the agent asks, a price tag comes back
  if (t >= S.ask[0] && t < S.ask[1]) {
    const a = S.ask[0];
    s += label(t, S.ask, '01 · ASK', 'The agent asks a stall');
    s += `<g opacity="${fade(t, S.ask).toFixed(2)}">
      ${term(t, a, 70, 220, 620, [
        [0.4, `$ hawker call coin-price '{"ids":"ethereum"}'`],
        [1.4, 'POST usehawker.fun/v1/call/coin-price', '#a39680'],
        [2.1, '402 payment required', GOLD],
        [2.7, '  seller  ' + SELLER, '#a39680'],
        [3.1, '  value   20000  (0.02 USDG)', '#a39680'],
        [3.5, '  ref     0x9c41…7d02', '#a39680'],
      ])}
      <line x1="760" y1="236" x2="1210" y2="236" stroke="${INK}" stroke-width="5"/>
      ${priceTag(t, a + 2.2, 830, 296, [['', '$0.02', 0, true], ['stall', 'coin-price', 0.4], ['seller', SELLER, 0.7], ['till', TILL, 1]])}
      ${note(t, a + 4.4, 70, 520, ['The price is on the tag.', 'Exactly what the agent will sign for, and who gets it.'])}</g>`;
  }

  // ---- 2: it signs a payment for that price
  if (t >= S.sign[0] && t < S.sign[1]) {
    const a = S.sign[0];
    s += label(t, S.sign, '02 · SIGN', 'It signs USDG for one call');
    const card = ease(span(t, a + 0.4, a + 1));
    s += `<g opacity="${fade(t, S.sign).toFixed(2)}">
      <g transform="translate(70 ${lerp(250, 220, card)})" opacity="${card.toFixed(2)}">
        <rect width="640" height="300" rx="14" fill="${CARD}" stroke="${INK}" stroke-width="3"/>
        <rect width="640" height="48" rx="14" fill="${INK}"/><rect y="30" width="640" height="18" fill="${INK}"/>
        <text x="22" y="32" font-family="${MONO}" font-weight="700" font-size="16" letter-spacing="2" fill="${PAPER}">USDG · ReceiveWithAuthorization</text>
        ${[['from', 'the agent  ' + AGENT, 0.8], ['to', 'the till  ' + TILL, 1.2], ['value', '20000  = 0.02 USDG', 1.6], ['nonce', 'keccak(seller, ref)', 2.0], ['valid', 'next 5 minutes', 2.4]]
          .map(([k, v, at], i) => (t > a + at ? `<text x="22" y="${96 + i * 40}" font-family="${MONO}" font-size="17" fill="${SOFT}">${k}</text><text x="130" y="${96 + i * 40}" font-family="${MONO}" font-size="17" fill="${INK}">${typed(v, t, a + at, a + at + 0.35)}</text>` : '')).join('')}
      </g>
      ${stamp(t, a + 3, 590, 470, 'SIGNED', GREEN, 190)}
      ${note(t, a + 3.2, 780, 270, ['No deposit.', 'The USDG stays in the agent\'s wallet.'])}
      ${note(t, a + 3.7, 780, 370, ['No gas.', 'A signature, not a transaction.'])}
      ${note(t, a + 4.2, 780, 470, ['Locked to this seller.', 'The seller is folded into the nonce.'])}</g>`;
  }

  // ---- 3: HAWKER runs the call, then the till splits the payment in one transaction
  if (t >= S.settle[0] && t < S.settle[1]) {
    const a = S.settle[0];
    s += label(t, S.settle, '03 · SETTLE', 'One transaction, two transfers');
    const toTill = ease(span(t, a + 1.2, a + 2.2)), split = ease(span(t, a + 2.6, a + 3.8));
    const agentBal = t > a + 2.2 ? '9.98 USDG' : '10.00 USDG';
    s += `<g opacity="${fade(t, S.settle).toFixed(2)}">
      ${box(70, 230, 250, 'AGENT', AGENT, agentBal)}
      ${box(515, 230, 250, 'HAWKERTILL', TILL, t > a + 2.2 && t < a + 2.7 ? '0.02' : 'holds 0', INK)}
      ${box(960, 200, 250, 'SELLER', SELLER, t > a + 3.8 ? '+0.0194' : '—', t > a + 3.8 ? GREEN : SOFT)}
      ${box(960, 340, 250, 'FEE SINK', '3%', t > a + 3.8 ? '+0.0006' : '—', t > a + 3.8 ? GREEN : SOFT)}
      <path d="M320 286 H515" stroke="${INK}" stroke-width="3" stroke-dasharray="8 8"/>
      <path d="M765 286 C860 286 860 256 960 256" stroke="${INK}" stroke-width="3" stroke-dasharray="8 8" fill="none"/>
      <path d="M765 286 C860 286 860 396 960 396" stroke="${INK}" stroke-width="3" stroke-dasharray="8 8" fill="none"/>
      ${t > a + 1.2 && t < a + 2.4 ? coin(lerp(330, 600, toTill), 286, '0.02') : ''}
      ${t > a + 2.6 && t < a + 3.9 ? coin(lerp(700, 1020, split), lerp(286, 256, split), '.0194') + coin(lerp(700, 1020, split), lerp(286, 396, split), '.0006') : ''}
      ${term(t, a, 70, 486, 640, [
        [0.2, '✓ signature checked · payment reserved · simulated', '#a39680'],
        [0.7, '✓ coin-price answered', '#a39680'],
        [1.2, '→ HawkerTill.settle()  gas paid by HAWKER', GOLD],
        [3.9, '200 { ethereum: { usd: 2066.27 } }', '#f1e7d2'],
      ])}
      ${stamp(t, a + 4.2, 1110, 630, 'PAID', GREEN, 160)}
      ${note(t, a + 4.6, 780, 520, ['The answer leaves after', 'the seller has the USDG.'])}</g>`;
  }

  // ---- 4: a call that fails costs nothing
  if (t >= S.fail[0] && t < S.fail[1]) {
    const a = S.fail[0];
    s += label(t, S.fail, '04 · FAIL', 'A call that fails costs nothing');
    s += `<g opacity="${fade(t, S.fail).toFixed(2)}">
      ${term(t, a, 70, 220, 640, [
        [0.3, `$ hawker call weather-now '{"city":"Oslo"}'`],
        [1.1, '✓ signature checked · payment reserved', '#a39680'],
        [1.7, '✗ the seller answered 503', RED],
        [2.4, '502 seller_failed · Not charged.', GOLD],
        [3.0, '  the signature was never used', '#a39680'],
        [3.4, '  agent still holds 9.98 USDG', '#a39680'],
      ])}
      ${stamp(t, a + 2.5, 960, 330, 'NOT CHARGED', RED, 300)}
      ${note(t, a + 3.4, 780, 450, ['The payment only lands', 'after the stall answers.', 'Retry with the same signature.'])}</g>`;
  }

  // ---- end card
  if (t >= S.end[0]) {
    const o = ease(span(t, S.end[0], S.end[0] + 0.6));
    s += `<g opacity="${o.toFixed(2)}"><rect width="${W}" height="${H}" fill="${PAPER}"/>
      ${logo(565, 120, 150)}
      <text x="640" y="350" text-anchor="middle" font-family="${SANS}" font-size="54" fill="${INK}">Your agent pays per call.</text>
      <rect x="220" y="376" width="840" height="72" fill="${GOLD}"/>
      <text x="640" y="430" text-anchor="middle" font-family="${SANS}" font-size="54" fill="${INK}">The seller is paid on chain.</text>
      <text x="640" y="506" text-anchor="middle" font-family="${MONO}" font-size="19" letter-spacing="4" fill="${SOFT}">USDG · HAWKERTILL ${TILL} · ROBINHOOD CHAIN</text>
      <text x="640" y="590" text-anchor="middle" font-family="${MONO}" font-weight="700" font-size="30" letter-spacing="5" fill="${INK}">USEHAWKER.FUN</text></g>`;
  }
  return s + awning() + '</svg>';
}

const only = process.env.ONLY;
if (only) {
  for (const t of only.split(',').map(Number)) await sharp(Buffer.from(frame(t))).png().toFile(fileURLToPath(new URL(`./demo-${t}.png`, import.meta.url)));
  process.exit(0);
}
const dir = join(tmpdir(), 'hawker-demo-frames');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const total = Math.round(END * FPS);
for (let i = 0; i < total; i++) await sharp(Buffer.from(frame(i / FPS))).png().toFile(join(dir, `f${String(i).padStart(4, '0')}.png`));
const out = fileURLToPath(new URL('./demo.mp4', import.meta.url));
execFileSync(process.env.FFMPEG || 'ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, 'f%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', out]);
rmSync(dir, { recursive: true, force: true });
console.log('wrote', out, total, 'frames');
