'use strict';
// Splits a "whole alphabet in one STL" mesh into separate glyphs:
//   1. connected components (triangles sharing welded vertices)
//   2. components grouped into text rows on the sheet plane
//   3. components of one row merged when they stack vertically (i/j dots, ':', '=', '%'...)

// Label every triangle with a connected-component id. Returns { labels: Int32Array, count }.
function components(tris) {
  const nv = tris.length / 3;
  const nt = nv / 3;
  const bits = new Int32Array(tris.buffer, tris.byteOffset, tris.length);
  let cap = 1;
  while (cap < nv * 2) cap <<= 1;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const vid = new Int32Array(nv);
  for (let i = 0; i < nv; i++) {
    const o = i * 3;
    // +0 so that -0.0 and 0.0 weld together
    const a = bits[o] === (1 << 31) ? 0 : bits[o];
    const b = bits[o + 1] === (1 << 31) ? 0 : bits[o + 1];
    const c = bits[o + 2] === (1 << 31) ? 0 : bits[o + 2];
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & mask;
    for (;;) {
      const j = table[h];
      if (j < 0) { table[h] = i; vid[i] = i; break; }
      const q = j * 3;
      if (tris[q] === tris[o] && tris[q + 1] === tris[o + 1] && tris[q + 2] === tris[o + 2]) { vid[i] = j; break; }
      h = (h + 1) & mask;
    }
  }
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  for (let t = 0; t < nt; t++) {
    const a = find(vid[t * 3]), b = find(vid[t * 3 + 1]), c = find(vid[t * 3 + 2]);
    if (a !== b) parent[b] = a;
    const a2 = find(a);
    if (a2 !== c) parent[find(c)] = a2;
  }
  const labels = new Int32Array(nt);
  const idOf = new Map();
  for (let t = 0; t < nt; t++) {
    const r = find(vid[t * 3]);
    let id = idOf.get(r);
    if (id === undefined) { id = idOf.size; idOf.set(r, id); }
    labels[t] = id;
  }
  return { labels, count: idOf.size };
}

// Per-component bounding boxes and triangle counts.
function componentBoxes(tris, labels, count) {
  const boxes = [];
  for (let i = 0; i < count; i++) boxes.push({ id: i, n: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  for (let t = 0; t < labels.length; t++) {
    const b = boxes[labels[t]];
    b.n++;
    for (let k = 0; k < 9; k++) {
      const v = tris[t * 9 + k], a = k % 3;
      if (v < b.min[a]) b.min[a] = v;
      if (v > b.max[a]) b.max[a] = v;
    }
  }
  return boxes;
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1];
};

// Group component boxes into glyphs laid out in rows on plane (U,V); V is "up".
// Returns { rows: [{ baseline, top, glyphs: [{ parts:[componentId], min, max }] }] } top row first.
function layout(boxes, U, V) {
  const items = boxes.map((b) => ({ parts: [b.id], min: [...b.min], max: [...b.max] }));
  const absorb = (a, b) => {
    a.parts.push(...b.parts);
    for (let k = 0; k < 3; k++) { a.min[k] = Math.min(a.min[k], b.min[k]); a.max[k] = Math.max(a.max[k], b.max[k]); }
  };
  // Pieces fully nested inside another piece's footprint belong to it (inlays, counters, pegs).
  items.sort((a, b) => (b.max[U] - b.min[U]) * (b.max[V] - b.min[V]) - (a.max[U] - a.min[U]) * (a.max[V] - a.min[V]));
  for (let i = 0; i < items.length; i++) {
    for (let j = items.length - 1; j > i; j--) {
      const a = items[i], b = items[j];
      const eu = (a.max[U] - a.min[U]) * 0.02, ev = (a.max[V] - a.min[V]) * 0.02;
      if (b.min[U] >= a.min[U] - eu && b.max[U] <= a.max[U] + eu && b.min[V] >= a.min[V] - ev && b.max[V] <= a.max[V] + ev) {
        absorb(a, b);
        items.splice(j, 1);
      }
    }
  }

  // Rows: bands seeded from the taller pieces; every piece then joins the band it overlaps most.
  const hMed = median(items.map((g) => g.max[V] - g.min[V]));
  const tall = items.filter((g) => g.max[V] - g.min[V] >= hMed * 0.6).sort((a, b) => a.min[V] - b.min[V]);
  const bands = [];
  for (const g of tall) {
    const last = bands[bands.length - 1];
    // shrink the interval a little before testing overlap: descenders may graze the next line
    const lo = g.min[V] + (g.max[V] - g.min[V]) * 0.25;
    if (last && lo < last.hi) { last.hi = Math.max(last.hi, g.max[V]); last.lo = Math.min(last.lo, g.min[V]); }
    else bands.push({ lo: g.min[V], hi: g.max[V], glyphs: [] });
  }
  for (const g of items) {
    let best = null, bestScore = -Infinity;
    for (const b of bands) {
      const ov = Math.min(g.max[V], b.hi) - Math.max(g.min[V], b.lo); // negative = gap
      if (ov > bestScore) { bestScore = ov; best = b; }
    }
    if (best) best.glyphs.push(g);
  }

  const rows = [];
  for (const band of bands) {
    const gs = band.glyphs.sort((a, b) => a.min[U] - b.min[U]);
    // merge vertically stacked pieces (strong overlap along U)
    let merged = true;
    while (merged) {
      merged = false;
      outer:
      for (let i = 0; i < gs.length; i++) {
        for (let j = i + 1; j < gs.length; j++) {
          const a = gs[i], b = gs[j];
          if (b.min[U] > a.max[U]) break;
          const ov = Math.min(a.max[U], b.max[U]) - Math.max(a.min[U], b.min[U]);
          const small = Math.min(a.max[U] - a.min[U], b.max[U] - b.min[U]);
          if (ov > small * 0.6) {
            absorb(a, b);
            gs.splice(j, 1);
            merged = true;
            break outer;
          }
        }
      }
    }
    // Loose fragments (rings of '%', specks) join the glyph they sit in or touch.
    for (let i = gs.length - 1; i >= 0; i--) {
      const s = gs[i];
      const sw = s.max[U] - s.min[U], sh = s.max[V] - s.min[V];
      const speck = sw < hMed * 0.12 && sh < hMed * 0.12;
      let host = null;
      if (sw < hMed * 0.06 && sh < hMed * 0.06 && gs.length > 1) {
        // far too small to be a character of its own (a full stop is bigger): goes to the nearest glyph
        let bestGap = Infinity;
        for (const g of gs) {
          if (g === s) continue;
          const gap = Math.max(g.min[U] - s.max[U], s.min[U] - g.max[U], 0);
          if (gap < bestGap) { bestGap = gap; host = g; }
        }
      }
      for (const g of host ? [] : gs) {
        if (g === s || (g.max[U] - g.min[U]) * (g.max[V] - g.min[V]) <= sw * sh) continue;
        const ou = Math.min(s.max[U], g.max[U]) - Math.max(s.min[U], g.min[U]);
        const ov = Math.min(s.max[V], g.max[V]) - Math.max(s.min[V], g.min[V]);
        const inside = ou > 0 && ov > 0 ? (ou * ov) / Math.max(sw * sh, 1e-12) : 0;
        if (inside > 0.35 || (speck && ou > -hMed * 0.1 && ov > -hMed * 0.1)) { host = g; break; }
      }
      if (host) { absorb(host, s); gs.splice(i, 1); }
    }
    gs.sort((a, b) => a.min[U] - b.min[U]);
    const lows = gs.map((g) => g.min[V]);
    const highs = gs.map((g) => g.max[V]);
    rows.push({ baseline: median(lows), top: median(highs), glyphs: gs });
  }
  rows.sort((a, b) => b.baseline - a.baseline);
  return { rows };
}

// Copy the triangles of the given component ids into a new Float32Array.
function extract(tris, labels, partSet) {
  let n = 0;
  for (let t = 0; t < labels.length; t++) if (partSet.has(labels[t])) n++;
  const out = new Float32Array(n * 9);
  let o = 0;
  for (let t = 0; t < labels.length; t++) {
    if (!partSet.has(labels[t])) continue;
    out.set(tris.subarray(t * 9, t * 9 + 9), o);
    o += 9;
  }
  return out;
}

module.exports = { components, componentBoxes, layout, extract, median };
