// The HAWKER mark: a hawk's head in profile, flat, three colours. Variant b (gold tile) is the one in use.
export const INK = '#17130d', CREAM = '#f3ead9', GOLD = '#f0b429';
// the head in profile, facing right: flat crown, heavy brow, hooked beak, neck cut on a slant
const HEAD = 'M96 352 C86 280 78 214 104 160 C128 110 178 78 236 78 C278 78 306 96 318 124 L318 150 L262 206 C262 238 272 262 292 300 L300 352 Z';
const BEAK = 'M300 128 C344 130 366 160 360 200 C356 228 344 248 328 266 C332 236 322 216 300 208 L262 206 Z';
const BROW = 'M196 132 L306 150 L300 172 L190 158 Z';
const EYE = 'M234 172 a13 13 0 1 0 26 0 a13 13 0 1 0 -26 0 Z';

export const mark = (v = 'a') => {
  const c = { a: { tile: INK, head: CREAM, beak: GOLD, cut: INK }, b: { tile: GOLD, head: INK, beak: CREAM, cut: GOLD }, c: { tile: '#b3261e', head: CREAM, beak: GOLD, cut: '#b3261e' } }[v];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="${c.tile}"/><g transform="translate(-22 -14)"><path d="${HEAD}" fill="${c.head}"/><path d="${BEAK}" fill="${c.beak}"/><path d="${BROW}" fill="${c.cut}"/><path d="${EYE}" fill="${c.cut}"/></g></svg>`;
};

