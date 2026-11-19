// Built-in pixel art. Numbers are the site's palette indices; -1 = leave the pixel alone.
// 1 red, 2 orange-red, 3 orange, 4 yellow, 5 cream, 22 pink, 27 black, 29 gray, 31 white
const PRESETS = (() => {
  const T = -1;

  // a picture drawn as text rows; `key` maps each letter to a colour
  const fromRows = (rows, key) => {
    const w = Math.max(...rows.map((r) => r.length)), h = rows.length, data = [];
    for (const r of rows) for (let x = 0; x < w; x++) { const ch = r[x] || '.'; data.push(ch in key ? key[ch] : T); }
    return { w, h, data };
  };

  // a picture worked out pixel by pixel: f(x, y, dx, dy, r2) → colour, on a size×size grid centred in the middle
  const fromFn = (size, f) => {
    const c = (size - 1) / 2, R = size / 2, data = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c, d2 = dx * dx + dy * dy;
      const inside = d2 <= R * R - 0.5;
      // outline: inside, with a neighbour outside the circle
      const edge = inside && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => (dx + a) ** 2 + (dy + b) ** 2 > R * R - 0.5);
      data.push(inside ? f(x, y, dx, dy, edge) : T);
    }
    return { w: size, h: size, data };
  };

  // a symmetric picture: only the left half is drawn, the right half is its mirror
  const fromHalf = (rows, key) => fromRows(rows.map((r) => r + [...r].reverse().join('')), key);

  // Sparky, an original chubby orange cat
  const sparky = fromHalf([
    '..K.............',
    '..KK............',
    '..KPK...........',
    '..KPPK..........',
    '..KPPOK.........',
    '..KPPOOK........',
    '..KOPOOOKKKKKKKK',
    '..KOOOOOOOOODOOD',
    '.KOOOOOOOOOOODOO',
    '.KOOOOOOOOOOOOOO',
    '.KOOOOKKKOOOOOOO',
    'KOOOOKBBWKOOOOOO',
    'KOOOOKBBBKOOOOOO',
    'KOOOOKBBBKOOOOOO',
    'KOOOOOKKKOOOOOOO',
    'KOOOOOOOOOOOWWWW',
    'KDDOOOOOOOOWWWPP',
    'KOOOOOOOOOWWWWWK',
    'KDDOOOOOOOWWWKKW',
    '.KOOOOOOOOOWWWWW',
    '.KOOOOOOOOOOWWWW',
    '..KOOOOOOOOOOOOO',
    '...KKOOOOOOOOOOO',
    '.....KKKKKKKKKKK',
  ], { K: 27, O: 3, D: 2, W: 31, P: 23, B: 13 });

  // a yellow smiley: two eyes and a curved smile
  const smiley = fromFn(16, (x, y, dx, dy, edge) => {
    if (edge) return 27;
    if ((x === 5 || x === 10) && (y === 5 || y === 6)) return 27;            // eyes
    const smile = Math.abs(Math.hypot(dx, dy + 2) - 5.5) < 0.6 && dy > 1.5;  // arc under the eyes
    if (smile) return 27;
    if ((x === 3 || x === 12) && y === 9) return 23;                         // blush
    return dx + dy > 6 ? 3 : 4;
  });

  // a little planet: blue ocean, green land, white shine
  const planet = fromFn(16, (x, y, dx, dy, edge) => {
    if (edge) return 27;
    if (['4,3', '5,3', '3,4'].includes(x + ',' + y)) return 31;
    const land = Math.sin(x * 0.9) + Math.cos(y * 0.8 + x * 0.3) > 0.9;
    if (land) return dx + dy > 5 ? 6 : 8;
    return dx + dy > 5 ? 12 : 13;
  });

  const heart = fromRows([
    '.KKK...KKK.',
    'KRRRK.KRRRK',
    'KRWRRKRRRRK',
    'KRRRRRRRRRK',
    '.KRRRRRRRK.',
    '..KRRRRRK..',
    '...KRRRK...',
    '....KRK....',
    '.....K.....',
  ], { K: 27, R: 1, W: 31 });

  const star = fromRows([
    '......K......',
    '.....KYK.....',
    '.....KYK.....',
    'KKKKKYYYKKKKK',
    '.KYYYYYYYYYK.',
    '..KYYYYYYYK..',
    '...KYYYYYK...',
    '..KYYYKYYYK..',
    '..KYYK.KYYK..',
    '.KYK.....KYK.',
    '.KK.......KK.',
  ], { K: 27, Y: 4 });

  return [
    { id: 'sparky', name: 'Sparky the cat, big (32×24)', art: sparky },
    { id: 'smiley', name: 'Smiley (16×16)', art: smiley },
    { id: 'planet', name: 'Planet (16×16)', art: planet },
    { id: 'heart', name: 'Heart (11×9)', art: heart },
    { id: 'star', name: 'Star (13×11)', art: star },
  ];
})();

// every pixel becomes an n×n block
function scaleArt(a, n) {
  if (n <= 1) return { w: a.w, h: a.h, data: a.data.slice() };
  const w = a.w * n, h = a.h * n, data = new Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = a.data[Math.floor(y / n) * a.w + Math.floor(x / n)];
  return { w, h, data };
}

if (typeof module !== 'undefined') module.exports = { PRESETS, scaleArt };
