'use strict';
// "Which font is this letter from?"  A sample STL of a known (or guessed) character is compared with
// the same character in every installed system font and in every 3D font of the library.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const stl = require('./stl');
const threemf = require('./threemf');
const rec = require('./recognize');
const store = require('./fontstore');
const { ROTATIONS, rotate, charFromStem, CHAR_NAMES } = require('./scan');

const SIZE = 32;
const SYS_VERSION = 3; // bump when tools/render-fonts.ps1 changes what it renders
const toVec = (bytes) => { const f = new Float32Array(bytes.length); for (let i = 0; i < f.length; i++) f[i] = bytes[i] / 255; return rec.blur(f, SIZE); };

// Orient a sample to read as its character from the front.
// Returns { name, char, guessed, variants: [{ a, m }] } (near-equal orientations are all kept).
function prepareSample(buf, name, char) {
  const tris = /\.3mf$/i.test(name) ? threemf.parse(buf) : stl.parse(buf);
  if (!tris.length) throw new Error('no triangles in ' + name);
  const bb0 = stl.bbox(tris);
  const ext = [0, 1, 2].map((a) => bb0.max[a] - bb0.min[a]);
  const thin = ext.indexOf(Math.min(...ext));
  const flat = ext[thin] < [...ext].sort((a, b) => a - b)[1] * 0.7;
  // no character given: take the hint in the file name, if any
  if (!char) {
    const stem = name.replace(/\.\w+$/, '');
    const named = stem.toLowerCase().split(/[^a-z]+/).map((w) => CHAR_NAMES[w]).find((c) => c && !/[a-z0-9]/i.test(c));
    const hint = charFromStem(stem) || named || (/(?:^|[-_ .])([A-Za-z])\d*(?=[-_ .(]|$)/.exec(stem) || [])[1];
    if (hint && rec.CHARS.includes(hint)) char = hint;
  }
  const wanted = char ? (/[a-z]/i.test(char) ? [char.toUpperCase(), char.toLowerCase()] : [char]).filter((c) => rec.CHARS.includes(c)) : [];
  // no hint at all: guess among letters, digits and a few distinctive symbols
  const chars = wanted.length ? wanted : rec.CHARS.filter((c) => /[A-Za-z0-9&@#$%?]/.test(c));
  const tries = [];
  for (const r of ROTATIONS) {
    if (flat && r.p[2] !== thin) continue; // a flat letter is read face-on, never edge-on
    const t = rotate(tris, r), bb = stl.bbox(t);
    const f = rec.features(t, bb.min, bb.max);
    let best = null;
    for (const c of chars) { const s = rec.score(f, c); if (!best || s > best.s) best = { c, s }; }
    tries.push({ t, bb, c: best.c, s: best.s });
  }
  tries.sort((a, b) => b.s - a.s);
  const top = tries[0];
  const variants = [];
  for (const v of tries) {
    if (v.s < top.s - 0.05 || variants.length >= 4) break;
    const raw = rec.raster(v.t, v.bb.min, v.bb.max, SIZE);
    const m = Buffer.from(raw.map((x) => Math.round(x * 255))).toString('base64');
    if (variants.some((o) => o.m === m)) continue; // same picture from a symmetric rotation
    variants.push({ a: +((v.bb.max[0] - v.bb.min[0]) / (v.bb.max[1] - v.bb.min[1])).toFixed(4), m });
  }
  return { name, char: wanted.length ? (wanted.includes(char) ? char : top.c) : top.c, guessed: !wanted.length, variants };
}

// ---------- system fonts (rendered by PowerShell/GDI+, cached per character) ----------
let sysCache = null; // code -> [{ family, style, a, v }]
function loadSys(cacheDir) {
  if (sysCache) return sysCache;
  sysCache = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(cacheDir, 'system-fonts.json'), 'utf8'));
    if (data.size === SIZE && data.v === SYS_VERSION) for (const [code, list] of Object.entries(data.glyphs)) sysCache.set(+code, list.map((g) => ({ ...g, v: toVec(Buffer.from(g.m, 'base64')) })));
  } catch (e) { /* not rendered yet */ }
  return sysCache;
}
async function systemGlyphs(cacheDir, codes) {
  const cache = loadSys(cacheDir);
  const need = codes.filter((c) => !cache.has(c));
  if (need.length && process.platform === 'win32') {
    const tmp = path.join(cacheDir, `~render-${process.pid}.json`);
    const script = path.join(__dirname, '..', 'tools', 'render-fonts.ps1');
    await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& '${script.replace(/'/g, "''")}' -Codes ${need.join(',')} -Size ${SIZE} -Out '${tmp.replace(/'/g, "''")}'`],
        { windowsHide: true, timeout: 180000 }, (err, so, se) => (err ? reject(new Error('could not render system fonts: ' + (se || err.message).slice(0, 300))) : resolve()));
    });
    const data = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    fs.unlinkSync(tmp);
    for (const c of need) cache.set(c, []);
    for (const f of data.fonts) for (const g of f.glyphs) cache.get(g.c).push({ family: f.family, style: f.style, a: g.a, m: g.m, v: toVec(Buffer.from(g.m, 'base64')) });
    const glyphs = {};
    for (const [code, list] of cache) glyphs[code] = list.map(({ family, style, a, m }) => ({ family, style, a, m }));
    fs.writeFileSync(path.join(cacheDir, 'system-fonts.json'), JSON.stringify({ size: SIZE, v: SYS_VERSION, glyphs }));
  }
  return cache;
}

// ---------- library fonts ----------
const libCache = new Map(); // "<id>/<file>" -> { a, v }
function libraryGlyph(cacheDir, font, ch) {
  const pick = (c) => font.glyphs.find((g) => g.char === c && !g.alt);
  const g = pick(ch) || (/[a-z]/i.test(ch) ? pick(ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()) : null);
  if (!g) return null;
  const key = font.id + '/' + g.file;
  if (!libCache.has(key)) {
    const tris = stl.parse(fs.readFileSync(path.join(cacheDir, font.id, g.file)));
    const bb = stl.bbox(tris);
    libCache.set(key, { a: (bb.max[0] - bb.min[0]) / (bb.max[1] - bb.min[1]), v: rec.blur(rec.raster(tris, bb.min, bb.max, SIZE), SIZE) });
  }
  return libCache.get(key);
}

function similarity(variants, cand) {
  let best = -1;
  for (const s of variants) {
    let diff = 0;
    for (let i = 0; i < s.v.length; i++) diff += Math.abs(s.v[i] - cand.v[i]);
    best = Math.max(best, 1 - diff / s.v.length - 0.25 * Math.min(1, Math.abs(Math.log(s.a / cand.a))));
  }
  return best;
}

// samples: [{ char, variants: [{ a, m }] }] as returned by prepareSample
async function match(samples, cacheDir, libraryIds) {
  const prepared = samples.map((s) => ({ char: s.char, code: s.char.codePointAt(0), variants: s.variants.map((v) => ({ a: v.a, v: toVec(Buffer.from(v.m, 'base64')) })) }));
  const results = [];
  let note = '';
  try {
    const sys = await systemGlyphs(cacheDir, [...new Set(prepared.map((s) => s.code))]);
    const byFont = new Map();
    for (const s of prepared) {
      for (const g of sys.get(s.code) || []) {
        const key = g.family + '|' + g.style;
        if (!byFont.has(key)) byFont.set(key, { type: 'system', family: g.family, style: g.style, name: g.family + (g.style === 'Regular' ? '' : ' ' + g.style.replace(',', '')), per: [] });
        byFont.get(key).per.push(similarity(s.variants, g));
      }
    }
    // a style the font does not really have (synthesised bold) renders identically: list it once
    const seen = new Set();
    for (const f of byFont.values()) {
      const key = f.family + '|' + f.per.join(',');
      if (f.per.length !== prepared.length || seen.has(key)) continue;
      seen.add(key);
      results.push(f);
    }
    if (process.platform !== 'win32') note = 'System fonts are only compared on Windows.';
  } catch (e) { note = e.message; }
  for (const id of libraryIds) {
    const font = store.readFont(cacheDir, id);
    if (!font) continue;
    const per = prepared.map((s) => { const g = libraryGlyph(cacheDir, font, s.char); return g ? similarity(s.variants, g) : null; });
    if (per.every((p) => p !== null)) results.push({ type: 'library', id, name: font.name, per });
  }
  for (const r of results) { r.score = +(r.per.reduce((a, b) => a + b, 0) / r.per.length).toFixed(4); r.per = r.per.map((p) => +p.toFixed(3)); }
  results.sort((a, b) => b.score - a.score);
  return { results: results.slice(0, 40), compared: results.length, note };
}

module.exports = { prepareSample, match };
