'use strict';
// Works out which character a glyph silhouette is. Two cues are combined:
//   - shape: the front silhouette is compared with reference bitmaps of ordinary fonts (ref-glyphs.json)
//   - order: neighbouring glyphs that continue the alphabet (…K L M…) reinforce each other
// The same shape score is used to find which way round a model faces.
const fs = require('fs');
const path = require('path');

const REF = JSON.parse(fs.readFileSync(path.join(__dirname, 'ref-glyphs.json'), 'utf8'));
const N = REF.size;
const SS = 3; // supersampling factor when rasterising meshes

function blur(src, n = N) {
  const N = n;
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || yy >= N || xx < 0 || xx >= N) continue;
      const w = dx === 0 && dy === 0 ? 2 : 1;
      s += src[yy * N + xx] * w; c += w;
    }
    const v = s / c;
    out[y * N + x] = v;
  }
  return out;
}

// refs: char -> [{ v, a, h, b }] (one entry per reference font)
const refs = new Map();
for (const font of REF.fonts) {
  for (const g of font.glyphs) {
    const raw = Buffer.from(g.m, 'base64');
    const f = new Float32Array(N * N);
    for (let i = 0; i < f.length; i++) f[i] = raw[i] / 255;
    const ch = String.fromCodePoint(g.c);
    if (!refs.has(ch)) refs.set(ch, []);
    refs.get(ch).push({ v: blur(f), a: g.a, h: g.h, b: g.b });
  }
}
const CHARS = [...refs.keys()];

const CHAINS = ['ABCDEFGHIJKLMNOPQRSTUVWXYZÆØÅ', 'abcdefghijklmnopqrstuvwxyzæøå', '0123456789', '1234567890'];
const succ = new Map();
for (const chain of CHAINS) {
  for (let i = 0; i + 1 < chain.length; i++) {
    if (!succ.has(chain[i])) succ.set(chain[i], new Set());
    succ.get(chain[i]).add(chain[i + 1]);
  }
}
const classOf = (c) => (/[0-9]/.test(c) ? 2 : c.toLowerCase() !== c ? 0 : c.toUpperCase() !== c ? 1 : 3);

// Rasterise the front (+Z towards viewer, X right, Y up) silhouette of a mesh, stretched to fill n x n.
function raster(tris, min, max, n = N) {
  const N = n;
  const R = N * SS;
  const hi = new Uint8Array(R * R);
  const w = Math.max(max[0] - min[0], 1e-9), h = Math.max(max[1] - min[1], 1e-9);
  const sx = R / w, sy = R / h;
  for (let i = 0; i < tris.length; i += 9) {
    const x0 = (tris[i] - min[0]) * sx, y0 = (max[1] - tris[i + 1]) * sy;
    const x1 = (tris[i + 3] - min[0]) * sx, y1 = (max[1] - tris[i + 4]) * sy;
    const x2 = (tris[i + 6] - min[0]) * sx, y2 = (max[1] - tris[i + 7]) * sy;
    const d = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(d) < 1e-12) continue;
    const ya = Math.max(0, Math.floor(Math.min(y0, y1, y2))), yb = Math.min(R - 1, Math.floor(Math.max(y0, y1, y2)));
    const xa = Math.max(0, Math.floor(Math.min(x0, x1, x2))), xb = Math.min(R - 1, Math.floor(Math.max(x0, x1, x2)));
    for (let y = ya; y <= yb; y++) {
      const py = y + 0.5;
      for (let x = xa; x <= xb; x++) {
        const px = x + 0.5;
        const a = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / d;
        const b = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / d;
        if (a >= -0.02 && b >= -0.02 && a + b <= 1.02) hi[y * R + x] = 1;
      }
    }
  }
  const out = new Float32Array(N * N);
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) out[((y / SS) | 0) * N + ((x / SS) | 0)] += hi[y * R + x];
  for (let i = 0; i < out.length; i++) out[i] /= SS * SS;
  return out;
}
const silhouette = (tris, min, max) => blur(raster(tris, min, max));

// feat: { v, a (width/height), h (height in cap heights), b (bottom above baseline, in cap heights) }
// h/b may be undefined when the glyph has no line context (one letter per file).
function features(tris, min, max, ctx) {
  const w = max[0] - min[0], h = max[1] - min[1];
  const f = { v: silhouette(tris, min, max), a: w / Math.max(h, 1e-9) };
  if (ctx && ctx.capH > 0) { f.h = h / ctx.capH; f.b = (min[1] - ctx.baseline) / ctx.capH; }
  return f;
}

function score(f, ch) {
  const list = refs.get(ch);
  if (!list) return -1;
  let best = -1;
  for (const r of list) {
    // mean absolute difference of the two bitmaps
    let diff = 0;
    for (let i = 0; i < r.v.length; i++) diff += Math.abs(r.v[i] - f.v[i]);
    let s = 1 - diff / r.v.length - 0.12 * Math.min(2, Math.abs(Math.log(f.a / r.a)));
    if (f.h !== undefined) s -= 0.35 * Math.min(1, Math.abs(f.h - r.h)) + 0.35 * Math.min(1, Math.abs(f.b - r.b));
    if (s > best) best = s;
  }
  // a separate dot underneath is the mark of '!' and '?'
  if (f.dotBelow !== undefined && (ch === '!' || ch === '?')) best += f.dotBelow ? 0.15 : -0.15;
  return best;
}

// Complete alphabet runs: where most of a stretch reads as consecutive letters, relabel the rest.
function repairRuns(chars, plausible) {
  const out = [...chars];
  for (const chain of CHAINS.slice(0, 3)) {
    for (let o = -chain.length + 1; o < chars.length; o++) {
      const from = Math.max(0, o), to = Math.min(chars.length, o + chain.length);
      let a = -1, b = -1, hits = 0;
      for (let i = from; i < to; i++) if (chars[i] === chain[i - o]) { if (a < 0) a = i; b = i; hits++; }
      // look one glyph beyond each end too: the run usually starts/ends on a misread letter
      if (a < 0) continue;
      const len = b - a + 1;
      if (len < 8 || hits < len * 0.7) continue;
      for (let i = a; i <= b; i++) out[i] = chain[i - o];
      // the run may start or end on a misread letter: extend while the next letter is a plausible reading
      for (let i = a - 1; i >= from && plausible(i, chain[i - o]); i--) out[i] = chain[i - o];
      for (let i = b + 1; i < to && plausible(i, chain[i - o]); i++) out[i] = chain[i - o];
    }
  }
  return out;
}

// Label a sequence of glyphs (reading order). Returns { chars, conf, total }.
function sequence(feats, opts = {}) {
  // Following the alphabet earns a bonus that grows with the run length; a glyph may only be read
  // as "the next letter" if its shape makes that plausible (gate).
  const chainBonus = opts.chainBonus ?? [0.03, 0.08, 0.16], classBonus = opts.classBonus ?? 0.03, gate = opts.gate ?? 0.13;
  const R = chainBonus.length;
  const n = feats.length, m = CHARS.length;
  if (!n) return { chars: [], conf: [], total: 0 };
  const cls = CHARS.map(classOf);
  const next = CHARS.map((c) => { const s = succ.get(c); return s ? CHARS.map((d, j) => (s.has(d) ? j : -1)).filter((j) => j >= 0) : []; });
  const emis = feats.map((f) => CHARS.map((c) => score(f, c)));
  // state = char * R + r, r = length of the alphabet run ending here (capped)
  let prev = new Float64Array(m * R).fill(-Infinity);
  for (let j = 0; j < m; j++) prev[j * R] = emis[0][j];
  const back = [];
  for (let i = 1; i < n; i++) {
    const cur = new Float64Array(m * R).fill(-Infinity), bk = new Int32Array(m * R).fill(-1);
    const top = Math.max(...emis[i]);
    // best predecessor overall and per class, so the common case is O(1) per state
    let bestAll = 0;
    const bestCls = [-1, -1, -1, -1];
    for (let s = 0; s < m * R; s++) {
      const c = cls[(s / R) | 0];
      if (prev[s] > prev[bestAll]) bestAll = s;
      if (bestCls[c] < 0 || prev[s] > prev[bestCls[c]]) bestCls[c] = s;
    }
    for (let j = 0; j < m; j++) {
      let b = bestAll, v = prev[bestAll];
      const sc = bestCls[cls[j]];
      if (sc >= 0 && cls[j] !== 3 && prev[sc] + classBonus > v) { v = prev[sc] + classBonus; b = sc; }
      cur[j * R] = v + emis[i][j]; bk[j * R] = b;
    }
    for (let p = 0; p < m; p++) {
      for (const j of next[p]) {
        if (emis[i][j] < top - gate) continue;
        for (let r = 0; r < R; r++) {
          const from = p * R + r, to = j * R + Math.min(r + 1, R - 1);
          const v = prev[from] + chainBonus[r] + classBonus + emis[i][j];
          if (v > cur[to]) { cur[to] = v; bk[to] = from; }
        }
      }
    }
    back.push(bk);
    prev = cur;
  }
  let s = 0;
  for (let k = 1; k < m * R; k++) if (prev[k] > prev[s]) s = k;
  const total = prev[s];
  const idx = new Array(n);
  for (let i = n - 1; i >= 0; i--) { idx[i] = (s / R) | 0; if (i > 0) s = back[i - 1][s]; }
  const chars = repairRuns(idx.map((k) => CHARS[k]), (i, c) => emis[i][CHARS.indexOf(c)] >= Math.max(...emis[i]) - 0.2);
  return { chars, conf: chars.map((c, i) => emis[i][CHARS.indexOf(c)]), total };
}

module.exports = { features, score, sequence, raster, blur, CHARS };
