'use strict';
// Regenerates lib/ref-glyphs.json: small reference bitmaps of what each character looks like in a
// spread of ordinary type styles. lib/recognize.js compares split-off glyphs with them.
// Drawn from open fonts (Google Fonts, downloaded once into cache/ref-fonts/); without a connection
// it uses the fonts installed on this machine instead (same as make-ref-from-system.js).
//   node tools/make-ref.js [--system]
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');

const SIZE = 16, SS = 4;
// [family, weight] - plain sans, heavy sans, serif, slab, mono, casual, script, blackletter, display
const FONTS = [
  ['Roboto', 400], ['Roboto', 700], ['Open Sans', 400], ['Fira Sans', 400], ['Archivo Black', 400], ['Anton', 400],
  ['Tinos', 400], ['Tinos', 700], ['Gelasio', 400], ['Rokkitt', 400], ['Courier Prime', 700],
  ['Comic Neue', 400], ['Patrick Hand', 400], ['Kaushan Script', 400], ['Dancing Script', 700], ['Homemade Apple', 400],
  ['UnifrakturMaguntia', 400], ['Pirata One', 400], ['Caprasimo', 400], ['Righteous', 400],
];
// preferred installed fonts for the offline variant (whatever is present is used)
const SYSTEM_FIRST = ['Arial', 'Arial Bold', 'Arial Black', 'Verdana', 'Trebuchet MS', 'Times New Roman', 'Times New Roman Bold', 'Georgia',
  'Courier New Bold', 'Comic Sans MS', 'Impact', 'Rockwell', 'Segoe Print', 'Segoe Script', 'Ink Free', 'Old English Text MT', 'Cooper Black',
  'Liberation Sans', 'Liberation Sans Bold', 'Liberation Serif', 'Liberation Mono Bold', 'DejaVu Sans', 'DejaVu Sans Bold', 'DejaVu Serif', 'Noto Sans', 'Noto Serif'];
const CODES = [];
for (let c = 0x21; c <= 0x7e; c++) CODES.push(c);
CODES.push(0xc6, 0xd8, 0xc5, 0xe6, 0xf8, 0xe5);
const DIR = path.join(__dirname, '..', 'cache', 'ref-fonts');
const OUT = path.join(__dirname, '..', 'lib', 'ref-glyphs.json');

async function download(family, weight) {
  const file = path.join(DIR, `${family.replace(/\s+/g, '')}-${weight}.ttf`);
  if (fs.existsSync(file)) return file;
  const q = encodeURIComponent(family).replace(/%20/g, '+');
  let css = '';
  for (const url of [`https://fonts.googleapis.com/css2?family=${q}:wght@${weight}`, `https://fonts.googleapis.com/css2?family=${q}`]) {
    const r = await fetch(url, { headers: { 'User-Agent': 'node' } });
    if (r.ok) { css = await r.text(); break; }
  }
  const m = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/.exec(css);
  if (!m) return null;
  fs.writeFileSync(file, Buffer.from(await (await fetch(m[1])).arrayBuffer()));
  return file;
}

// Outline -> closed polylines (y down, as opentype draws).
function contours(glyph) {
  const out = [];
  let cur = null, px = 0, py = 0;
  for (const c of glyph.getPath(0, 0, 1000).commands) {
    if (c.type === 'M') { cur = [[c.x, c.y]]; out.push(cur); }
    else if (c.type === 'L') cur.push([c.x, c.y]);
    else if (c.type === 'Q') for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t; cur.push([u * u * px + 2 * u * t * c.x1 + t * t * c.x, u * u * py + 2 * u * t * c.y1 + t * t * c.y]); }
    else if (c.type === 'C') for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t; cur.push([u * u * u * px + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x, u * u * u * py + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y]); }
    if (c.x !== undefined) { px = c.x; py = c.y; }
  }
  return out.filter((c) => c.length > 2);
}

// Non-zero winding fill of the outline, stretched to its bounding box, as SIZE x SIZE grey levels.
function bitmap(cs, box) {
  const R = SIZE * SS;
  const sx = R / (box.x2 - box.x1), sy = R / (box.y2 - box.y1);
  const edges = [];
  for (const c of cs) for (let i = 0; i < c.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length];
    edges.push([(a[0] - box.x1) * sx, (a[1] - box.y1) * sy, (b[0] - box.x1) * sx, (b[1] - box.y1) * sy]);
  }
  const acc = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < R; y++) {
    const yc = y + 0.5;
    const hits = [];
    for (const [x0, y0, x1, y1] of edges) {
      if ((y0 <= yc) === (y1 <= yc)) continue;
      hits.push([x0 + ((yc - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
    }
    hits.sort((p, q) => p[0] - q[0]);
    let wind = 0;
    for (let k = 0; k + 1 < hits.length; k++) {
      wind += hits[k][1];
      if (!wind) continue;
      const xa = Math.max(0, Math.ceil(hits[k][0] - 0.5)), xb = Math.min(R - 1, Math.floor(hits[k + 1][0] - 0.5));
      for (let x = xa; x <= xb; x++) acc[((y / SS) | 0) * SIZE + ((x / SS) | 0)] += 1;
    }
  }
  return Buffer.from(acc.map((v) => Math.round((255 * v) / (SS * SS)))).toString('base64');
}

function bounds(cs) {
  const b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  for (const c of cs) for (const [x, y] of c) { b.x1 = Math.min(b.x1, x); b.x2 = Math.max(b.x2, x); b.y1 = Math.min(b.y1, y); b.y2 = Math.max(b.y2, y); }
  return b;
}

function render(name, file) {
  const buf = fs.readFileSync(file);
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const capH = -bounds(contours(font.charToGlyph('H'))).y1; // baseline is y = 0, up is negative
  if (!(capH > 0)) throw new Error('no capital H');
  const r = (v) => Math.round(v * 1e4) / 1e4;
  const glyphs = [];
  for (const code of CODES) {
    const g = font.charToGlyph(String.fromCodePoint(code));
    if (!g || !g.index) continue;
    const cs = contours(g);
    if (!cs.length) continue;
    const b = bounds(cs);
    if (b.x2 - b.x1 <= 0 || b.y2 - b.y1 <= 0) continue;
    // a = width/height, h = height in cap heights, b = bottom edge above the baseline in cap heights
    glyphs.push({ c: code, a: r((b.x2 - b.x1) / (b.y2 - b.y1)), h: r((b.y2 - b.y1) / capH), b: r(-b.y2 / capH), m: bitmap(cs, b) });
  }
  if (glyphs.length < 60) throw new Error('too few Latin characters');
  return { name, glyphs };
}

// The open fonts, downloaded once into cache/ref-fonts/. Empty when there is no connection.
async function openFonts() {
  fs.mkdirSync(DIR, { recursive: true });
  const list = [];
  for (const [family, weight] of FONTS) {
    let file = null;
    try { file = await download(family, weight); } catch (e) { /* offline */ }
    if (file) list.push([`${family} ${weight}`, file]);
  }
  return list;
}

// Fonts installed on this machine: the usual suspects first, then anything else to make up the number.
function systemFontFiles() {
  const installed = require('../lib/ttf').systemFonts();
  const picked = [];
  for (const name of SYSTEM_FIRST) {
    const f = installed.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (f) picked.push([f.name, f.file]);
  }
  for (const f of installed) {
    if (picked.length >= 20) break;
    if (/^(regular|bold)$/i.test(f.style) && !picked.some((p) => p[1] === f.file)) picked.push([f.name, f.file]);
  }
  return picked;
}

// opts.system: use installed fonts. Otherwise the open fonts, falling back to installed ones offline.
async function run(opts = {}) {
  let origin = 'open';
  let list = opts.system ? [] : await openFonts();
  if (list.length < FONTS.length / 2) {
    if (!opts.system) console.log('Could not download the open fonts (no connection?) - using fonts installed on this machine.');
    origin = 'system';
    list = systemFontFiles();
  }
  const fonts = [];
  for (const [name, file] of list) {
    try { fonts.push(render(name, file)); console.log(`ok: ${name}`); } catch (e) { console.log(`skipped ${name}: ${e.message}`); }
  }
  if (fonts.length < 5) throw new Error('not enough usable fonts found');
  const source = origin === 'open'
    ? 'Rendered from openly licensed fonts (Google Fonts, SIL OFL / Apache 2.0); see tools/make-ref.js'
    : 'Rendered from fonts installed on the machine that ran tools/make-ref-from-system.js - for private use, not for redistribution';
  fs.writeFileSync(OUT, JSON.stringify({ size: SIZE, origin, source, fonts }));
  console.log(`wrote ${OUT} (${fonts.length} fonts, from ${origin === 'open' ? 'open fonts' : 'installed fonts'})`);
}

module.exports = { run };
if (require.main === module) run({ system: process.argv.includes('--system') }).catch((e) => { console.error(e.message); process.exit(1); });