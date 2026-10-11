'use strict';
// Discovers fonts in the assets folder (loose files, sub-folders and zip archives, incl. zips in zips),
// turns each one into separate, consistently oriented glyph STLs and caches them in cache/<font>/.
const fs = require('fs');
const path = require('path');
const zip = require('./zip');
const stl = require('./stl');
const threemf = require('./threemf');
const split = require('./split');
const rec = require('./recognize');
const store = require('./fontstore');
const ttf = require('./ttf');

const ALGO = 7;                 // bump to invalidate every cached result
const MIN_SHEET_GLYPHS = 20;    // a single STL needs at least this many separate glyphs to count as a font
const MESH_RE = /\.(stl|3mf)$/i;

// ---------- orientations: the 24 axis-aligned rotations ----------
const ROTATIONS = [];
for (const p of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
  for (let s = 0; s < 8; s++) {
    const sg = [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1];
    const parity = (p[0] === 0 && p[1] === 1) || (p[0] === 1 && p[1] === 2) || (p[0] === 2 && p[1] === 0) ? 1 : -1;
    if (parity * sg[0] * sg[1] * sg[2] === 1) ROTATIONS.push({ p, sg }); // new[k] = sg[k] * old[p[k]]
  }
}
function rotate(tris, r) {
  const out = new Float32Array(tris.length);
  const [p0, p1, p2] = r.p, [s0, s1, s2] = r.sg;
  for (let i = 0; i < tris.length; i += 3) {
    out[i] = s0 * tris[i + p0]; out[i + 1] = s1 * tris[i + p1]; out[i + 2] = s2 * tris[i + p2];
  }
  return out;
}

// ---------- discovery ----------
function sourceName(name) {
  return name.replace(/\.zip$/i, '').replace(/\s*-\s*part\s+\d+\s+of\s+\d+\s*$/i, '').trim();
}
function prettyName(name) {
  return sourceName(name).replace(/\s*-\s*\d{4,}\s*$/, '').replace(/[-_ ]*(model[-_ ])?files$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Lists mesh files of one member (folder, zip or loose file). Each: { dir, name, size, load() }.
function listDir(root, rel, out) {
  for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + d.name : d.name;
    const full = path.join(root, r);
    if (d.isDirectory()) listDir(root, r, out);
    else if (MESH_RE.test(d.name) || ttf.FONT_RE.test(d.name)) out.push({ dir: rel, name: d.name, size: fs.statSync(full).size, load: () => fs.readFileSync(full) });
    else if (/\.zip$/i.test(d.name)) listZip(() => zip.openFile(full), out);
  }
}
function listZip(open, out) {
  let z;
  try { z = open(); } catch (e) { return; }
  try {
    for (const e of z.entries) {
      const slash = e.name.lastIndexOf('/');
      const dir = slash < 0 ? '' : e.name.slice(0, slash), name = e.name.slice(slash + 1);
      const load = () => { const zz = open(); try { return zz.read(e); } finally { zz.close(); } };
      if (MESH_RE.test(name) || ttf.FONT_RE.test(name)) out.push({ dir, name, size: e.usize, load });
      else if (/\.zip$/i.test(name)) listZip(() => zip.openBuffer(load()), out);
    }
  } finally { z.close(); }
}

// extra.fontFiles: font files (ttf/otf) from outside the assets folder, each a source of its own
function discover(assetsDir, extra = {}) {
  const groups = new Map();
  for (const full of extra.fontFiles || []) {
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    groups.set('font:' + full, { key: 'font:' + full, name: path.basename(full).replace(ttf.FONT_RE, ''), members: [{ name: path.basename(full), full, kind: 'file', size: st.size, mtime: Math.round(st.mtimeMs) }] });
  }
  const names = fs.readdirSync(assetsDir, { withFileTypes: true });
  const dirs = new Set(names.filter((d) => d.isDirectory()).map((d) => d.name.toLowerCase()));
  for (const d of names) {
    const isZip = !d.isDirectory() && /\.zip$/i.test(d.name);
    if (!d.isDirectory() && !isZip && !MESH_RE.test(d.name) && !ttf.FONT_RE.test(d.name)) continue;
    if (isZip && dirs.has(d.name.slice(0, -4).toLowerCase())) continue; // already unzipped next to it
    const key = sourceName(d.isDirectory() || isZip ? d.name : d.name.replace(/\.\w+$/, ''));
    if (!groups.has(key)) groups.set(key, { key, name: prettyName(key), members: [] });
    const st = fs.statSync(path.join(assetsDir, d.name));
    groups.get(key).members.push({ name: d.name, kind: d.isDirectory() ? 'dir' : isZip ? 'zip' : 'file', size: st.size, mtime: Math.round(st.mtimeMs) });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function listFiles(assetsDir, group) {
  const files = [];
  for (const m of group.members) {
    const full = m.full || path.join(assetsDir, m.name);
    if (m.kind === 'dir') listDir(full, '', files);
    else if (m.kind === 'zip') listZip(() => zip.openFile(full), files);
    else files.push({ dir: '', name: m.name, size: m.size, load: () => fs.readFileSync(full) });
  }
  // the same file often appears twice (a zip inside the zip, part 1 / part 2 overlap)
  const seen = new Set();
  return files.filter((f) => { const k = f.name.toLowerCase() + ':' + f.size; if (seen.has(k)) return false; seen.add(k); return true; });
}

const loadMesh = (f) => (/\.3mf$/i.test(f.name) ? threemf.parse(f.load()) : stl.parse(f.load()));

// ---------- one letter per file ----------
const CHAR_NAMES = {
  comma: ',', full_stop: '.', fullstop: '.', period: '.', dot: '.', point: '.', slash: '/', backslash: '\\',
  question: '?', question_mark: '?', exclamation: '!', exclamation_mark: '!', exclaim: '!', ampersand: '&', and: '&',
  at: '@', hash: '#', hashtag: '#', pound: '#', dollar: '$', percent: '%', plus: '+', minus: '-', hyphen: '-', dash: '-',
  colon: ':', semicolon: ';', apostrophe: "'", quote: '"', underscore: '_', star: '*', asterisk: '*', equals: '=', equal: '=',
  heart: '♥', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
function charFromStem(rest) {
  const t = rest.replace(/^[-_ .]+|[-_ .]+$/g, '');
  if ([...t].length === 1) return t;
  const named = CHAR_NAMES[t.toLowerCase().replace(/[- ]/g, '_')];
  if (named) return named;
  const last = t.split(/[-_ ]+/).pop();
  if (last && [...last].length === 1 && t.split(/[-_ ]+/).length > 1) return last;
  return null;
}
function letterSets(files) {
  const byDir = new Map();
  for (const f of files) {
    const k = f.dir + '|' + path.extname(f.name).toLowerCase();
    if (!byDir.has(k)) byDir.set(k, []);
    byDir.get(k).push(f);
  }
  const sets = [], loose = [];
  for (const [k, list] of byDir) {
    if (list.length < 3) continue;
    const stems = list.map((f) => f.name.replace(MESH_RE, ''));
    let pre = stems[0];
    for (const s of stems) { let i = 0; while (i < pre.length && i < s.length && pre[i] === s[i]) i++; pre = pre.slice(0, i); }
    const items = [];
    const seen = new Set();
    list.forEach((f, i) => {
      // if stripping the shared prefix leaves nothing usable, fall back to the whole stem
      const ch = charFromStem(stems[i].slice(pre.length)) || charFromStem(stems[i]);
      if (!ch || seen.has(ch.toLowerCase())) return;
      seen.add(ch.toLowerCase());
      items.push({ file: f, ch });
    });
    const letters = items.filter((it) => /[a-z]/i.test(it.ch)).length;
    const ext = k.split('|')[1];
    if (items.length >= 3 && letters >= 3 && items.length >= list.length * 0.6) {
      sets.push({ dir: list[0].dir, ext, pre, items, used: new Set(items.map((it) => it.file)) });
    } else if (items.length && items.length >= list.length * 0.6) loose.push({ ext, pre, items });
  }
  // Leftovers with the same file-name prefix (digits in another folder) join the matching set.
  for (const l of loose) {
    const s = sets.find((x) => x.ext === l.ext && x.pre === l.pre && x.pre.length > 0);
    if (!s) continue;
    for (const it of l.items) if (!s.items.some((o) => o.ch.toLowerCase() === it.ch.toLowerCase())) { s.items.push(it); s.used.add(it.file); }
  }
  // the same letters offered as STL and 3MF: keep the STL set
  const hasStl = sets.some((s) => s.ext === '.stl');
  return hasStl ? sets.filter((s) => s.ext === '.stl') : sets;
}

function buildLetterSet(set) {
  const meshes = set.items.map((it) => ({ ch: it.ch, src: it.file.name, tris: loadMesh(it.file) })).filter((m) => m.tris.length);
  // which way round do these models face? try all 24 and keep the one whose silhouettes read best
  const order = 'FGJLPRQBEKDCAYTNSZ2345679';
  const sample = [...meshes].filter((m) => refCase(m.ch)).sort((a, b) => (order.indexOf(a.ch.toUpperCase()) + 100) % 100 - (order.indexOf(b.ch.toUpperCase()) + 100) % 100).slice(0, 10);
  // When one axis is clearly the thinnest across the set, favour looking along it.
  const mean = [0, 1, 2].map((a) => meshes.reduce((s, m) => { const bb = stl.bbox(m.tris); return s + bb.max[a] - bb.min[a]; }, 0) / meshes.length);
  const thin = mean.indexOf(Math.min(...mean));
  const flat = mean[thin] < [...mean].sort((a, b) => a - b)[1] * 0.7;
  let best = null;
  for (const r of ROTATIONS) {
    let total = flat && r.p[2] === thin ? 0.08 * sample.length : 0;
    for (const m of sample) {
      const t = rotate(m.tris, r), bb = stl.bbox(t);
      const f = rec.features(t, bb.min, bb.max);
      total += Math.max(...refCase(m.ch).map((c) => rec.score(f, c)));
    }
    if (!best || total > best.total) best = { r, total };
  }
  const glyphs = [];
  let upper = 0, lower = 0;
  for (const m of meshes) {
    const t = rotate(m.tris, best.r), bb = stl.bbox(t);
    const g = { tris: t, bb, ch: m.ch, src: m.src, conf: 1 };
    const cases = refCase(m.ch);
    if (cases && cases.length === 2) {
      const f = rec.features(t, bb.min, bb.max);
      const su = rec.score(f, cases[0]), sl = rec.score(f, cases[1]);
      g.conf = Math.max(su, sl);
      if ('ABDEGHNQRT'.includes(cases[0]) && Math.abs(su - sl) > 0.05) { if (su > sl) upper++; else lower++; }
    }
    glyphs.push(g);
  }
  // Mixed-case file names are kept as they are; all-one-case names are decided by the shapes.
  const named = glyphs.filter((g) => /[a-z]/i.test(g.ch));
  const mixed = named.some((g) => g.ch !== g.ch.toLowerCase()) && named.some((g) => g.ch !== g.ch.toUpperCase());
  if (mixed) upper = lower = 0;
  const toCase = mixed ? (c) => c : lower > upper ? (c) => c.toLowerCase() : (c) => c.toUpperCase();
  const xh = split.median(glyphs.filter((g) => 'acemnorsuvwxz'.includes(g.ch.toLowerCase())).map((g) => g.bb.max[1] - g.bb.min[1]));
  return glyphs.map((g) => {
    const ch = toCase(g.ch), h = g.bb.max[1] - g.bb.min[1];
    // no shared baseline between files: sit everything on the line, drop lowercase descenders below it
    const drop = lower > upper && 'gpqy'.includes(ch) && xh > 0 && h > xh * 1.15 ? h - xh : 0;
    return finishGlyph(g.tris, g.bb, g.bb.min[1] + drop, g.bb.min[2], { char: ch, conf: g.conf, src: g.src });
  });
}
function refCase(ch) {
  if (/[a-z]/i.test(ch)) return [ch.toUpperCase(), ch.toLowerCase()];
  return rec.CHARS.includes(ch) ? [ch] : null;
}

// ---------- whole alphabet in one STL ----------
function buildSheet(tris) {
  const { labels, count } = split.components(tris);
  if (count < MIN_SHEET_GLYPHS) return null;
  const bb = stl.bbox(tris);
  const ext = [0, 1, 2].map((a) => bb.max[a] - bb.min[a]);
  const depth = ext.indexOf(Math.min(...ext));
  // a sheet of letters is flat: clearly thinner than it is wide
  if (ext[depth] > Math.max(...ext) * 0.5) return null;

  let best = null;
  for (const r of ROTATIONS) {
    if (r.p[2] !== depth) continue;
    const t = rotate(tris, r);
    const boxes = split.componentBoxes(t, labels, count);
    const lay = split.layout(boxes, 0, 1);
    const n = lay.rows.reduce((s, row) => s + row.glyphs.length, 0);
    if (n < MIN_SHEET_GLYPHS) continue;
    const capH = Math.max(...lay.rows.map((row) => split.median(row.glyphs.map((g) => g.max[1] - g.min[1]))));
    const seq = [];
    for (const row of lay.rows) {
      for (const g of row.glyphs) {
        const part = split.extract(t, labels, new Set(g.parts));
        const feat = rec.features(part, g.min, g.max, { capH, baseline: row.baseline });
        const parts = g.parts.map((id) => boxes[id]).sort((a, b) => a.min[1] - b.min[1]);
        feat.dotBelow = parts.length > 1 && parts[0].max[1] < parts[1].min[1] && parts[0].max[1] - parts[0].min[1] < (g.max[1] - g.min[1]) * 0.3;
        seq.push({ g, row, tris: part, feat });
      }
    }
    const res = rec.sequence(seq.map((s) => s.feat));
    // a double quote is two separate marks side by side: join a pair of adjacent apostrophes
    for (let i = seq.length - 2; i >= 0; i--) {
      const a = seq[i], b = seq[i + 1];
      if (res.chars[i] !== "'" || res.chars[i + 1] !== "'" || a.row !== b.row) continue;
      if (b.g.min[0] - a.g.max[0] > (a.g.max[0] - a.g.min[0]) * 1.5) continue;
      const tris2 = new Float32Array(a.tris.length + b.tris.length);
      tris2.set(a.tris); tris2.set(b.tris, a.tris.length);
      a.tris = tris2;
      for (let k = 0; k < 3; k++) { a.g.min[k] = Math.min(a.g.min[k], b.g.min[k]); a.g.max[k] = Math.max(a.g.max[k], b.g.max[k]); }
      res.chars[i] = '"';
      seq.splice(i + 1, 1); res.chars.splice(i + 1, 1); res.conf.splice(i + 1, 1);
    }
    const score = res.total / n;
    if (!best || score > best.score) best = { score, seq, res, zMin: stl.bbox(t).min[2] };
  }
  if (!best) return null;
  return best.seq.map((s, i) => finishGlyph(s.tris, { min: s.g.min, max: s.g.max }, s.row.baseline, best.zMin, { char: best.res.chars[i], conf: best.res.conf[i] }));
}

// Move a glyph so that x starts at 0, y = 0 is the baseline and z = 0 is the back face.
function finishGlyph(tris, bb, baseline, zMin, extra) {
  const out = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) {
    out[i] = tris[i] - bb.min[0]; out[i + 1] = tris[i + 1] - baseline; out[i + 2] = tris[i + 2] - zMin;
  }
  const r = (v) => +v.toPrecision(6);
  return { tris: out, w: r(bb.max[0] - bb.min[0]), y0: r(bb.min[1] - baseline), y1: r(bb.max[1] - baseline), d: r(bb.max[2] - zMin), n: tris.length / 9, ...extra };
}

// ---------- scan ----------
function scan(assetsDir, cacheDir, report = () => {}, extra = {}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const indexFile = path.join(cacheDir, 'index.json');
  let index = { sources: {} };
  try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch (e) { /* first run */ }
  const groups = discover(assetsDir, extra);
  const sources = {};
  const active = [];
  const usedIds = new Set();

  groups.forEach((group, gi) => {
    report({ type: 'progress', done: gi, total: groups.length, current: group.name });
    const sig = JSON.stringify([ALGO, group.members]);
    const old = index.sources[group.key];
    if (old && old.sig === sig && old.fonts.every((id) => fs.existsSync(path.join(cacheDir, id, 'font.json')))) {
      sources[group.key] = old;
      for (const id of old.fonts) { usedIds.add(id); active.push(id); report({ type: 'font', id }); }
      return;
    }
    const fonts = [];
    try {
      const files = listFiles(assetsDir, group);
      const found = [];
      // ordinary font files (ttf/otf): extrude their outlines
      for (const f of files) {
        if (!ttf.FONT_RE.test(f.name)) continue;
        const buf = f.load();
        const names = ttf.readNames(buf);
        const built = ttf.build(buf);
        if (built.glyphs.length >= 10) found.push({ kind: 'ttf', name: names ? ttf.displayName(names) : f.name.replace(ttf.FONT_RE, ''), label: f.name, from: (f.dir ? f.dir + '/' : '') + f.name, glyphs: built.glyphs, space: built.space });
      }
      const sets = letterSets(files.filter((f) => MESH_RE.test(f.name)));
      for (const set of sets) found.push({ kind: 'letters', label: set.dir.split('/').pop(), from: set.dir, glyphs: buildLetterSet(set) });
      if (!sets.length && !found.length) {
        for (const f of files) {
          if (!/\.stl$/i.test(f.name)) continue;
          report({ type: 'progress', done: gi, total: groups.length, current: group.name + ' / ' + f.name });
          const glyphs = buildSheet(stl.parse(f.load()));
          if (glyphs) found.push({ kind: 'sheet', label: f.name.replace(MESH_RE, ''), from: (f.dir ? f.dir + '/' : '') + f.name, glyphs });
        }
      }
      for (const fnt of found) {
        const name = fnt.name || (found.length > 1 ? `${group.name} (${fnt.label.replace(/_/g, ' ')})` : group.name);
        let id = store.slug(name), k = 2;
        while (usedIds.has(id)) id = store.slug(name) + '-' + k++;
        usedIds.add(id);
        store.writeFont(cacheDir, id, { name, kind: fnt.kind, source: group.members.map((m) => m.full || m.name), sourceFile: fnt.from, ...(fnt.space ? { space: fnt.space } : {}) }, fnt.glyphs);
        fonts.push(id); active.push(id);
        report({ type: 'font', id });
      }
    } catch (e) {
      report({ type: 'error', source: group.name, message: e.message });
    }
    sources[group.key] = { sig, fonts };
    fs.writeFileSync(indexFile, JSON.stringify({ sources: { ...index.sources, ...sources }, active }, null, 1));
  });

  fs.writeFileSync(indexFile, JSON.stringify({ sources, active }, null, 1));
  report({ type: 'done', active, sources: groups.length });
  return active;
}

module.exports = { scan, discover, listFiles, letterSets, buildSheet, buildLetterSet, ROTATIONS, rotate, charFromStem, CHAR_NAMES };
