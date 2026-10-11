'use strict';
// Turns an ordinary TrueType/OpenType font into 3D glyphs by extruding its outlines.
// opentype.js reads the outlines, three.js (ExtrudeGeometry) makes the solids - both run inside Node.
const fs = require('fs');
const path = require('path');
const os = require('os');

const FONT_RE = /\.(ttf|otf)$/i;
const DEPTH = 0.22;       // extrusion depth, in capital heights
const EM = 100;           // glyphs are generated at this em size (model units)
const CODES = [];
for (let c = 0x21; c <= 0x7e; c++) CODES.push(c);
CODES.push(0xc6, 0xd8, 0xc5, 0xe6, 0xf8, 0xe5);

let T = null;
function three() {
  // the ES-module build of three, by path (its CommonJS entry point is deprecated)
  if (!T) T = { THREE: require(path.join(__dirname, '..', 'node_modules', 'three', 'build', 'three.module.js')), opentype: require('opentype.js') };
  return T;
}
// Family / style names from the font's 'name' table, reading only the bytes needed.
// Takes a file path or the file contents.
function readNames(file) {
  const fd = Buffer.isBuffer(file) ? null : fs.openSync(file, 'r');
  try {
    const at = fd === null ? (pos, len) => file.subarray(pos, pos + len) : (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };
    const head = at(0, 12);
    if (head.toString('latin1', 0, 4) === 'ttcf') return null; // collections are not supported
    const dir = at(12, head.readUInt16BE(4) * 16);
    for (let i = 0; i + 16 <= dir.length; i += 16) {
      if (dir.toString('latin1', i, i + 4) !== 'name') continue;
      const t = at(dir.readUInt32BE(i + 8), dir.readUInt32BE(i + 12));
      const count = t.readUInt16BE(2), strings = t.readUInt16BE(4);
      const out = {};
      const rank = {};
      for (let r = 0; r < count; r++) {
        const o = 6 + r * 12;
        const platform = t.readUInt16BE(o), lang = t.readUInt16BE(o + 4), id = t.readUInt16BE(o + 6);
        if (id !== 1 && id !== 2) continue;
        const raw = t.subarray(strings + t.readUInt16BE(o + 10), strings + t.readUInt16BE(o + 10) + t.readUInt16BE(o + 8));
        // Windows/English first, then any Windows name, then the old Mac one
        const score = platform === 3 ? (lang === 0x409 ? 3 : 2) : platform === 1 && lang === 0 ? 1 : 0;
        if (!score || score <= (rank[id] || 0)) continue;
        rank[id] = score;
        out[id] = platform === 3 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1');
      }
      if (!out[1]) return null;
      return { family: out[1].trim(), style: (out[2] || 'Regular').trim() };
    }
    return null;
  } catch (e) {
    return null;
  } finally { if (fd !== null) fs.closeSync(fd); }
}
const displayName = (n) => (/^regular$/i.test(n.style) ? n.family : `${n.family} ${n.style}`);

// Installed fonts: [{ family, style, name, file }]
let installed = null;
function systemFonts() {
  if (installed) return installed;
  installed = [];
  const dirs = [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'), path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts'),
    '/usr/share/fonts', '/Library/Fonts', path.join(os.homedir(), 'Library', 'Fonts'), path.join(os.homedir(), '.fonts')];
  const walk = (dir, depth) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const d of list) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { if (depth < 4) walk(full, depth + 1); continue; }
      if (!FONT_RE.test(d.name)) continue;
      const n = readNames(full);
      if (n) installed.push({ ...n, name: displayName(n), file: full });
    }
  };
  for (const dir of dirs) walk(dir, 0);
  installed.sort((a, b) => a.name.localeCompare(b.name));
  return installed;
}
// Find the file for a family + style as GDI names them ("Bold, Italic").
// strict: no falling back to the regular cut when that exact style has no file of its own.
function findSystemFont(family, style, strict) {
  const norm = (s) => String(s || 'Regular').toLowerCase().replace(/[^a-z]/g, '').replace(/^(regular|normal|roman|book)$/, '') ;
  const list = systemFonts().filter((f) => f.family.toLowerCase() === String(family).toLowerCase());
  // GDI calls a family's base face "Regular" even when the file names it "Black", "Light", "Roman"...
  const base = list.find((f) => norm(f.style) === '') || (list.length === 1 ? list[0] : list.find((f) => !/bold|italic|oblique/i.test(f.style)));
  return list.find((f) => norm(f.style) === norm(style)) || (norm(style) === '' || !strict ? base : null) || null;
}

// Build glyphs from font file contents. Returns { glyphs, space } in the shape scan.js expects.
function build(buf) {
  const { THREE, opentype } = three();
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const scale = EM / (font.unitsPerEm || 1000);
  const glyphOf = (ch) => { const g = font.charToGlyph(ch); return g && g.index > 0 ? g : null; };
  const solid = (ch, depth) => {
    const g = glyphOf(ch);
    if (!g) return null;
    const sp = new THREE.ShapePath();
    for (const c of g.getPath(0, 0, EM).commands) {
      // opentype draws y-down; flip to y-up
      if (c.type === 'M') sp.moveTo(c.x, -c.y);
      else if (c.type === 'L') sp.lineTo(c.x, -c.y);
      else if (c.type === 'Q') sp.quadraticCurveTo(c.x1, -c.y1, c.x, -c.y);
      else if (c.type === 'C') sp.bezierCurveTo(c.x1, -c.y1, c.x2, -c.y2, c.x, -c.y);
    }
    if (!sp.subPaths.length) return null;
    // Outer contours and holes wind in opposite directions; the biggest contour is an outer one.
    const parts = sp.subPaths.map((p) => { const pts = p.getPoints(4); return { p, pts, area: THREE.ShapeUtils.area(pts) }; }).filter((c) => Math.abs(c.area) > 1e-6);
    if (!parts.length) return null;
    const outerSign = Math.sign(parts.reduce((a, b) => (Math.abs(b.area) > Math.abs(a.area) ? b : a)).area);
    const inside = (pt, poly) => {
      let hit = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
      }
      return hit;
    };
    // Each outer contour becomes its own solid (overlapping ones merge); a hole is cut only from
    // the outer contours that contain it completely.
    const shapes = [];
    const outers = parts.filter((c) => Math.sign(c.area) === outerSign);
    for (const o of outers) {
      const s = new THREE.Shape();
      s.curves = o.p.curves;
      o.shape = s;
      shapes.push(s);
    }
    for (const h of parts) {
      if (Math.sign(h.area) === outerSign) continue;
      for (const o of outers) if (Math.abs(o.area) > Math.abs(h.area) && h.pts.every((pt) => inside(pt, o.pts))) o.shape.holes.push(h.p);
    }
    const geo = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false, curveSegments: 6 });
    const flat = geo.index ? geo.toNonIndexed() : geo;
    const tris = Float32Array.from(flat.attributes.position.array);
    geo.dispose();
    return tris.length ? tris : null;
  };
  const bounds = (tris) => {
    const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
    for (let i = 0; i < tris.length; i += 3) for (let a = 0; a < 2; a++) { if (tris[i + a] < min[a]) min[a] = tris[i + a]; if (tris[i + a] > max[a]) max[a] = tris[i + a]; }
    return { min, max };
  };
  // capital height from a flat-topped capital, to scale the depth
  let cap = EM * 0.7;
  for (const ch of 'HIEXZ') { const t = solid(ch, 1); if (t) { cap = bounds(t).max[1]; break; } }
  const depth = cap * DEPTH;
  const r = (v) => +v.toPrecision(6);
  const glyphs = [];
  for (const code of CODES) {
    const ch = String.fromCodePoint(code);
    let tris = null;
    try { tris = solid(ch, depth); } catch (e) { /* a broken outline: skip the glyph */ }
    if (!tris) continue;
    const b = bounds(tris);
    // unlike glyphs cut from STLs these keep their real origin: x0 is the left side bearing, adv the advance
    glyphs.push({ tris, char: ch, conf: 1, x0: r(b.min[0]), w: r(b.max[0] - b.min[0]), y0: r(b.min[1]), y1: r(b.max[1]), d: r(depth), n: tris.length / 9, adv: r(glyphOf(ch).advanceWidth * scale) });
  }
  const space = glyphOf(' ') ? r(glyphOf(' ').advanceWidth * scale) : r(cap * 0.38);
  return { glyphs, space };
}

// Outline of a line of text set in a font file, as SVG path data: { d, x, y, w, h }.
// tight: crop to the ink instead of the full line height.
function previewPath(file, text, tight) {
  const { opentype } = three();
  const buf = fs.readFileSync(file);
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const p = font.getPath(text, 0, 0, 100);
  const b = p.getBoundingBox();
  const r = (v) => Math.round(v * 10) / 10;
  // keep the line's full height (ascender to descender) so samples of different fonts line up
  const asc = (font.ascender / font.unitsPerEm) * 100, desc = (font.descender / font.unitsPerEm) * 100;
  const top = tight ? b.y1 : Math.min(-asc, b.y1), bottom = tight ? b.y2 : Math.max(-desc, b.y2);
  return { d: p.toPathData(1), x: r(b.x1), y: r(top), w: r(Math.max(1, b.x2 - b.x1)), h: r(Math.max(1, bottom - top)) };
}

module.exports = { previewPath, FONT_RE,readNames, displayName, systemFonts, findSystemFont, build };
