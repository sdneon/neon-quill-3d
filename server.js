'use strict';
// Neon Quill 3D - local server.   node server.js [assets-folder] [--port 8123]
// Finds fonts among the STL files / zip archives of the assets folder and serves the viewer page.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');
const store = require('./lib/fontstore');
const find = require('./lib/find');
const ttf = require('./lib/ttf');

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? +args.splice(portArg, 2)[1] : +process.env.PORT || 8123;
// Where your own STL fonts live: command line, then FONT_ASSETS, then "assets" in config.json
// (a personal file, not part of the release), then the assets/ folder next to this file.
let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) { /* optional */ }
const ASSETS = path.resolve(__dirname, args[0] || process.env.FONT_ASSETS || config.assets || 'assets');
const CACHE = path.join(__dirname, 'cache');
const STATIC = [
  ['/vendor/three/', path.join(__dirname, 'node_modules', 'three')],
  ['/cache/', CACHE],
  ['/', path.join(__dirname, 'public')],
];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.stl': 'model/stl', '.svg': 'image/svg+xml' };

// ---------- scanning ----------
const state = { scanning: false, done: 0, total: 0, current: '', errors: [], active: [] };
try { state.active = JSON.parse(fs.readFileSync(path.join(CACHE, 'index.json'), 'utf8')).active || []; } catch (e) { /* first run */ }

// Font files to extrude besides those in the assets folder: fonts-bundled/, fonts/, user-fonts.json.
const BUNDLED_DIR = path.join(__dirname, 'fonts-bundled');
const FONTS_DIR = path.join(__dirname, 'fonts');
const USER_FILE = path.join(__dirname, 'user-fonts.json');
function userFonts() {
  try { return JSON.parse(fs.readFileSync(USER_FILE, 'utf8')); } catch (e) { return { system: [] }; }
}
function extraFontFiles() {
  const local = [];
  for (const dir of [BUNDLED_DIR, FONTS_DIR]) {
    try { local.push(...fs.readdirSync(dir).filter((f) => ttf.FONT_RE.test(f)).map((f) => path.join(dir, f))); } catch (e) { /* folder not there */ }
  }
  return [...local, ...(userFonts().system || [])];
}

let scanAgain = false;
function startScan() {
  if (state.scanning) { scanAgain = true; return; }
  try { fs.mkdirSync(ASSETS, { recursive: true }); } catch (e) { /* reported by the scan */ }
  Object.assign(state, { scanning: true, done: 0, total: 0, current: '', errors: [] });
  const seen = new Set();
  const worker = new Worker(path.join(__dirname, 'lib', 'scan-worker.js'), { workerData: { assetsDir: ASSETS, cacheDir: CACHE, extra: { fontFiles: extraFontFiles() } }, resourceLimits: { maxOldGenerationSizeMb: 6000 } });
  worker.on('message', (m) => {
    if (m.type === 'progress') Object.assign(state, { done: m.done, total: m.total, current: m.current });
    else if (m.type === 'font') { seen.add(m.id); if (!state.active.includes(m.id)) state.active.push(m.id); }
    else if (m.type === 'error') state.errors.push({ source: m.source, message: m.message });
    else if (m.type === 'fatal') state.errors.push({ source: 'scan', message: m.message });
    else if (m.type === 'done') { state.active = m.active; state.done = state.total; }
  });
  worker.on('error', (e) => state.errors.push({ source: 'scan', message: e.message }));
  worker.on('exit', () => {
    state.scanning = false; state.current = '';
    console.log(`scan finished: ${state.active.length} font(s)`);
    if (scanAgain) { scanAgain = false; startScan(); }
  });
}

const gdiCache = new Map();
function gdiPreview(family, style, text) {
  const st = ['Bold', 'Italic'].filter((s) => new RegExp(s, 'i').test(style)).join(', ') || 'Regular';
  const codes = [...text].map((c) => c.codePointAt(0)).filter((c) => c < 0x10000);
  const key = `${family}|${st}|${codes.join(',')}`;
  if (!gdiCache.has(key)) {
    gdiCache.set(key, new Promise((resolve, reject) => {
      const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
      const script = path.join(__dirname, 'tools', 'font-path.ps1');
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& ${quote(script)} -Family ${quote(family)} -Style ${quote(st)} -Codes ${codes.join(',')}`],
        { windowsHide: true, timeout: 30000, maxBuffer: 8 << 20 }, (err, out) => {
          try { if (err) throw err; resolve(JSON.parse(out)); } catch (e) { gdiCache.delete(key); reject(new Error('could not draw this font')); }
        });
    }));
  }
  return gdiCache.get(key);
}

// ---------- adding fonts ----------
function addSystemFont(family, style) {
  const f = ttf.findSystemFont(family, style);
  if (!f) throw new Error(`no font file found for "${family}" (collections / .ttc files are not supported)`);
  const u = userFonts();
  u.system = [...new Set([...(u.system || []), f.file])];
  fs.writeFileSync(USER_FILE, JSON.stringify(u, null, 1));
  return f.name;
}
// Google Fonts: the css2 endpoint hands plain TTF links to clients it does not recognise as browsers.
async function addGoogleFont(family, weight) {
  family = String(family || '').trim().replace(/\s+/g, ' ');
  if (!/^[\w .'-]{2,60}$/.test(family)) throw new Error('give the font family name, e.g. "Cooper Black" or "Lobster"');
  const w = /^[1-9]00$/.test(String(weight)) ? String(weight) : '';
  const q = encodeURIComponent(family).replace(/%20/g, '+');
  let css = null;
  for (const url of [w && `https://fonts.googleapis.com/css2?family=${q}:wght@${w}`, `https://fonts.googleapis.com/css2?family=${q}`]) {
    if (!url) continue;
    const r = await fetch(url, { headers: { 'User-Agent': 'node' } });
    if (r.ok) { css = await r.text(); break; }
  }
  if (!css) throw new Error(`Google Fonts has no family called "${family}"`);
  const m = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.(?:ttf|otf))\)/.exec(css);
  if (!m) throw new Error('Google Fonts did not offer a TTF file for this family');
  const buf = Buffer.from(await (await fetch(m[1])).arrayBuffer());
  if (!ttf.readNames(buf)) throw new Error('downloaded file is not a usable font');
  fs.mkdirSync(FONTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(FONTS_DIR, `${family.replace(/[^\w-]+/g, '')}${w && w !== '400' ? '-' + w : ''}${path.extname(m[1])}`), buf);
  return family;
}

function fontList() {
  const fonts = [];
  for (const id of state.active) {
    const f = store.readFont(CACHE, id);
    if (!f) continue;
    fonts.push({ id, name: f.name, kind: f.kind, source: f.source, glyphs: f.glyphs.length, chars: f.glyphs.filter((g) => g.char && !g.alt).map((g) => g.char).join('') });
  }
  fonts.sort((a, b) => a.name.localeCompare(b.name));
  return { assets: ASSETS, scanning: state.scanning, done: state.done, total: state.total, current: state.current, errors: state.errors, fonts };
}

// ---------- http ----------
function send(res, code, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', (c) => { parts.push(c); n += c.length; if (n > limit) { reject(new Error('upload too large')); req.destroy(); } });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 4e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    let m;
    if (p === '/api/fonts' && req.method === 'GET') return send(res, 200, fontList());
    if (p === '/api/rescan' && req.method === 'POST') { startScan(); return send(res, 200, { ok: true }); }
    if ((m = /^\/api\/fonts\/([a-z0-9-]+)$/.exec(p)) && req.method === 'GET') {
      const f = store.readFont(CACHE, m[1]);
      return f ? send(res, 200, f) : send(res, 404, { error: 'no such font' });
    }
    if ((m = /^\/api\/fonts\/([a-z0-9-]+)\/glyphs\/(\d+)$/.exec(p)) && req.method === 'POST') {
      const body = await readBody(req);
      const ch = typeof body.char === 'string' ? [...body.char.trim()].slice(0, 1).join('') : '';
      const f = store.relabel(CACHE, m[1], +m[2], ch);
      return f ? send(res, 200, f) : send(res, 404, { error: 'no such glyph' });
    }
    if (p === '/api/sysfonts' && req.method === 'GET') return send(res, 200, ttf.systemFonts().map((f) => ({ name: f.name, family: f.family, style: f.style })));
    if (p === '/api/sysfonts/preview' && req.method === 'GET') {
      // by list name (Add dialog) or by family + style as the finder reports them
      const q = url.searchParams;
      const f = q.get('name') ? ttf.systemFonts().find((x) => x.name === q.get('name')) : ttf.findSystemFont(q.get('family') || '', q.get('style') || 'Regular', true);
      const text = (q.get('text') || 'AaBbCc 123').slice(0, 40);
      if (f) { try { return send(res, 200, ttf.previewPath(f.file, text, q.get('tight') === '1')); } catch (e) { /* unreadable file: try GDI below */ } }
      // no readable file for this exact face: let GDI+ draw it
      if (q.get('family') && process.platform === 'win32') {
        try { return send(res, 200, await gdiPreview(q.get('family'), q.get('style') || 'Regular', text)); } catch (e) { return send(res, 404, { error: e.message }); }
      }
      return send(res, 404, { error: 'no such installed font' });
    }
    if (p === '/api/fonts/add' && req.method === 'POST') {
      const body = await readBody(req);
      let name;
      try {
        name = body.type === 'google' ? await addGoogleFont(body.family, body.weight) : addSystemFont(body.family, body.style);
      } catch (e) { return send(res, 400, { error: e.message }); }
      startScan();
      return send(res, 200, { ok: true, name });
    }
    if (p === '/api/find/sample' && req.method === 'POST') {
      const ch = [...(url.searchParams.get('char') || '').trim()].slice(0, 1).join('');
      return send(res, 200, find.prepareSample(await readRaw(req, 400 << 20), url.searchParams.get('name') || 'sample.stl', ch));
    }
    if (p === '/api/find' && req.method === 'POST') {
      const body = await readBody(req);
      if (!Array.isArray(body.samples) || !body.samples.length) return send(res, 400, { error: 'no samples' });
      return send(res, 200, await find.match(body.samples, CACHE, state.active));
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    for (const [prefix, root] of STATIC) {
      if (!p.startsWith(prefix)) continue;
      const file = path.join(root, p.slice(prefix.length) || 'index.html');
      if (!file.startsWith(root)) break;
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Neon Quill 3D: http://localhost:${PORT}/`);
  console.log(`assets folder:  ${ASSETS}`);
  startScan();
});
