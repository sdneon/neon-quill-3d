'use strict';
// On-disk font cache: cache/<font-id>/font.json + one binary STL per glyph, named after its character.
const fs = require('fs');
const path = require('path');
const stl = require('./stl');

const SYMBOL_NAMES = {
  '.': 'period', ',': 'comma', '/': 'slash', '\\': 'backslash', '?': 'question', '!': 'exclamation', '&': 'ampersand',
  '@': 'at', '#': 'hash', '$': 'dollar', '%': 'percent', '+': 'plus', '-': 'minus', ':': 'colon', ';': 'semicolon',
  "'": 'apostrophe', '"': 'quote', '_': 'underscore', '*': 'asterisk', '=': 'equals', '(': 'paren-left', ')': 'paren-right',
  '[': 'bracket-left', ']': 'bracket-right', '{': 'brace-left', '}': 'brace-right', '<': 'less', '>': 'greater',
  '^': 'caret', '~': 'tilde', '`': 'backtick', '|': 'bar',
};

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'font';

// Windows file names are case-insensitive, so "a.stl" and "A.stl" cannot coexist:
// lowercase letters get a "lower-" prefix whenever the font also has that capital.
function baseName(ch, hasUpper) {
  if (/^[A-Z0-9]$/.test(ch)) return ch;
  if (/^[a-z]$/.test(ch)) return hasUpper.has(ch.toUpperCase()) ? 'lower-' + ch : ch;
  if (SYMBOL_NAMES[ch]) return SYMBOL_NAMES[ch];
  return 'u' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
}

// Decide file names and which glyph is the primary one for each character.
function assignFiles(glyphs) {
  const hasUpper = new Set(glyphs.map((g) => g.char).filter((c) => c && /^[A-Z]$/.test(c)));
  const byChar = new Map();
  glyphs.forEach((g, i) => {
    if (!g.char) return;
    if (!byChar.has(g.char)) byChar.set(g.char, []);
    byChar.get(g.char).push(i);
  });
  const names = new Array(glyphs.length);
  glyphs.forEach((g, i) => { if (!g.char) { g.alt = 0; names[i] = `glyph-${String(i + 1).padStart(3, '0')}.stl`; } });
  for (const [ch, list] of byChar) {
    // a glyph the user labelled wins, then the most confident match
    list.sort((a, b) => (glyphs[b].user ? 1 : 0) - (glyphs[a].user ? 1 : 0) || (glyphs[b].conf || 0) - (glyphs[a].conf || 0) || a - b);
    list.forEach((gi, k) => {
      glyphs[gi].alt = k;
      names[gi] = baseName(ch, hasUpper) + (k ? `-alt${k + 1}` : '') + '.stl';
    });
  }
  return names;
}

function writeFont(cacheDir, id, meta, built) {
  const dir = path.join(cacheDir, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/\.stl$/i.test(f) || f === 'font.json') fs.unlinkSync(path.join(dir, f));
  // x0 / adv only exist for glyphs made from a font file (real side bearing and advance width)
  const glyphs = built.map((g) => ({ char: g.char || null, conf: +(g.conf || 0).toFixed(3), x0: g.x0, w: g.w, y0: g.y0, y1: g.y1, d: g.d, n: g.n, adv: g.adv, src: g.src }));
  const names = assignFiles(glyphs);
  glyphs.forEach((g, i) => { g.file = names[i]; fs.writeFileSync(path.join(dir, g.file), stl.write(built[i].tris)); });
  const font = { id, ...meta, capHeight: capHeight(glyphs), glyphs };
  if (meta.kind === 'ttf') font.allFile = writeAllInOne(dir, id, font, built);
  fs.writeFileSync(path.join(dir, 'font.json'), JSON.stringify(font, null, 1));
  return font;
}

// One STL with every character laid out in rows (capitals, small letters, digits, symbols) - handy
// for sharing a whole font as a single file. Letters are kept apart so it can be split again.
function writeAllInOne(dir, id, font, built) {
  const cap = font.capHeight || 1;
  const rank = (c) => (/[A-Z]/.test(c) ? 0 : /[a-z]/.test(c) ? 1 : /[0-9]/.test(c) ? 2 : 3);
  const order = font.glyphs.map((g, i) => i).filter((i) => font.glyphs[i].char && !font.glyphs[i].alt)
    .sort((a, b) => rank(font.glyphs[a].char) - rank(font.glyphs[b].char) || font.glyphs[a].char.codePointAt(0) - font.glyphs[b].char.codePointAt(0));
  const total = order.reduce((s, i) => s + built[i].tris.length, 0);
  const out = new Float32Array(total);
  let o = 0, x = 0, y = 0, group = -1, inRow = 0;
  for (const i of order) {
    const g = font.glyphs[i], r = rank(g.char);
    if ((r !== group && inRow) || inRow >= 13) { x = 0; y -= cap * 1.9; inRow = 0; }
    group = r;
    const dx = x - (g.x0 || 0), t = built[i].tris;
    for (let k = 0; k < t.length; k += 3) { out[o++] = t[k] + dx; out[o++] = t[k + 1] + y; out[o++] = t[k + 2]; }
    x += g.w + cap * 0.25;
    inRow++;
  }
  const file = `${id}-all.stl`;
  fs.writeFileSync(path.join(dir, file), stl.write(out));
  return file;
}

function capHeight(glyphs) {
  const pick = (re) => glyphs.filter((g) => g.char && re.test(g.char) && !g.alt).map((g) => g.y1).sort((a, b) => a - b);
  let hs = pick(/^[A-Z0-9]$/);
  if (!hs.length) hs = pick(/^[bdfhklt]$/);
  if (!hs.length) hs = glyphs.map((g) => g.y1 - Math.min(0, g.y0)).sort((a, b) => a - b);
  return hs.length ? hs[hs.length >> 1] : 1;
}

function readFont(cacheDir, id) {
  if (!/^[a-z0-9-]+$/.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(cacheDir, id, 'font.json'), 'utf8')); } catch (e) { return null; }
}

// Relabel one glyph (char = '' clears it) and rename the cached STLs to match.
function relabel(cacheDir, id, index, char) {
  const font = readFont(cacheDir, id);
  if (!font || !font.glyphs[index]) return null;
  const g = font.glyphs[index];
  g.char = char || null;
  g.user = true;
  const dir = path.join(cacheDir, id);
  const names = assignFiles(font.glyphs);
  const moves = font.glyphs.map((gl, i) => ({ gl, from: gl.file, to: names[i] })).filter((m) => m.from !== m.to);
  // two steps, because names get swapped around
  moves.forEach((m, k) => { m.tmp = `~tmp-${k}.stl`; fs.renameSync(path.join(dir, m.from), path.join(dir, m.tmp)); });
  moves.forEach((m) => { fs.renameSync(path.join(dir, m.tmp), path.join(dir, m.to)); m.gl.file = m.to; });
  font.capHeight = capHeight(font.glyphs);
  fs.writeFileSync(path.join(dir, 'font.json'), JSON.stringify(font, null, 1));
  return font;
}

module.exports = { slug, writeFont, readFont, relabel };
