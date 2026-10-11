import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_TEXT = 'Neon Quill 3D|Preview, Find & Create Fonts|for 3D Printing';
const DEFAULT_FONT = 'fredoka-semibold'; // bundled, and has every character of the default text
// ?font=<id>&text=...&view=front|iso|top... in the address overrides what was remembered
const query = new URLSearchParams(location.search);
const saved = (k, d) => { try { return query.get(k) ?? localStorage.getItem(k) ?? d; } catch (e) { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };

// ---------- scene ----------
const canvas = $('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
const material = new THREE.MeshStandardMaterial({ color: saved('color', '#4f8ef7'), roughness: 0.55, metalness: 0.05, flatShading: true });
// the full-alphabet block under the text is drawn a little subdued
const sheetMaterial = material.clone();
const tintSheet = () => sheetMaterial.color.copy(material.color).lerp(new THREE.Color(0x808890), 0.55);
tintSheet();
const persp = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
let camera = ortho;
for (const cam of [persp, ortho]) {
  // lights ride on the camera so the model is lit from wherever you look
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-0.6, 0.9, 1.2);
  cam.add(key, key.target);
  key.target.position.set(0, 0, -1);
  scene.add(cam);
}
scene.add(new THREE.HemisphereLight(0xffffff, 0x555566, 1.3));
const textGroup = new THREE.Group();
scene.add(textGroup);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.zoomToCursor = true;
let userMoved = false;
controls.addEventListener('start', () => { userMoved = true; anim = null; });

const VIEWS = {
  front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0], iso: [-0.42, 0.3, 1], // the opening view: perspective, a little from the left and above
};
let anim = null;

function applyTheme() {
  renderer.setClearColor(getComputedStyle(document.documentElement).getPropertyValue('--view').trim() || '#e9ecf2');
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  persp.aspect = w / h;
  persp.updateProjectionMatrix();
  ortho.left = -ortho.top * (w / h);
  ortho.right = ortho.top * (w / h);
  ortho.updateProjectionMatrix();
}
new ResizeObserver(() => { resize(); if (!userMoved) fit(); }).observe(canvas);

// Frame the text. dir = direction from the text towards the camera (default: keep the current one).
function fit(dir) {
  const box = new THREE.Box3().setFromObject(textGroup);
  if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 1, 0.2));
  const center = box.getCenter(new THREE.Vector3());
  const d = (dir ? new THREE.Vector3(...dir) : camera.position.clone().sub(controls.target)).normalize();
  const probe = new THREE.Object3D();
  probe.position.copy(d);
  probe.lookAt(0, 0, 0);
  probe.updateMatrix();
  const right = new THREE.Vector3().setFromMatrixColumn(probe.matrix, 0), up = new THREE.Vector3().setFromMatrixColumn(probe.matrix, 1);
  let mr = 0, mu = 0, md = 0;
  for (let i = 0; i < 8; i++) {
    const c = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
    mr = Math.max(mr, Math.abs(c.dot(right))); mu = Math.max(mu, Math.abs(c.dot(up))); md = Math.max(md, Math.abs(c.dot(d)));
  }
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const half = Math.max(mu, mr / aspect, 0.05) * 1.12;
  const radius = Math.max(mr, mu, md, 0.5);
  const dist = camera.isPerspectiveCamera ? half / Math.tan(THREE.MathUtils.degToRad(persp.fov / 2)) + md : radius * 4;
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(d, dist);
  ortho.top = half; ortho.bottom = -half; ortho.zoom = 1;
  ortho.near = -radius * 200; ortho.far = radius * 200;
  persp.near = radius / 200; persp.far = radius * 400;
  resize();
  controls.update();
}

function setProjection(kind) {
  const want = kind === 'persp' ? persp : ortho;
  if (want !== camera) {
    const offset = camera.position.clone().sub(controls.target);
    const tan = Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
    if (want === persp) {
      // same apparent size: distance that shows what the ortho frustum showed
      offset.setLength((ortho.top / ortho.zoom) / tan);
    } else {
      ortho.top = offset.length() * tan; ortho.bottom = -ortho.top; ortho.zoom = 1;
    }
    want.position.copy(controls.target).add(offset);
    want.up.copy(camera.up);
    camera = want;
    controls.object = camera;
    resize();
    controls.update();
  }
  $('proj-ortho').classList.toggle('on', camera === ortho);
  $('proj-persp').classList.toggle('on', camera === persp);
}

function snap(view) {
  setProjection(view === 'iso' ? 'persp' : 'ortho');
  const fromPos = camera.position.clone(), fromTarget = controls.target.clone();
  fit(VIEWS[view]);
  userMoved = false;
  const toPos = camera.position.clone(), toTarget = controls.target.clone();
  const a = fromPos.clone().sub(fromTarget), b = toPos.clone().sub(toTarget);
  anim = { t0: performance.now(), fromTarget, toTarget, la: a.length(), lb: b.length(), a: a.normalize(), q: new THREE.Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize()) };
  stepAnim(anim.t0);
}
function stepAnim(now) {
  if (!anim) return;
  const t = Math.min(1, (now - anim.t0) / 260), e = t * t * (3 - 2 * t);
  const q = new THREE.Quaternion().slerp(anim.q, e);
  controls.target.lerpVectors(anim.fromTarget, anim.toTarget, e);
  camera.position.copy(anim.a).applyQuaternion(q).multiplyScalar(THREE.MathUtils.lerp(anim.la, anim.lb, e)).add(controls.target);
  if (t >= 1) anim = null;
}

// View cube: a CSS 3D box that mirrors the camera orientation.
const cube = $('cube');
function updateCube() {
  const e = camera.matrixWorldInverse.elements;
  // three.js is y-up, CSS is y-down: flip the y row and column
  cube.style.transform = `matrix3d(${e[0]},${-e[1]},${e[2]},0,${-e[4]},${e[5]},${-e[6]},0,${e[8]},${-e[9]},${e[10]},0,0,0,0,1)`;
}

renderer.setAnimationLoop((now) => {
  stepAnim(now);
  if (!anim) controls.update();
  else camera.lookAt(controls.target);
  camera.updateMatrixWorld();
  updateCube();
  renderer.render(scene, camera);
});

// ---------- fonts ----------
const loader = new STLLoader();
let fonts = [];
let font = null;          // current font.json
let geoms = [];           // BufferGeometry per glyph index
let loadToken = 0;

async function api(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

let pollTimer = null;
async function refreshFonts() {
  let data;
  try { data = await api('/api/fonts'); } catch (e) { showStatus(`<span class="err">Server not reachable: ${esc(e.message)}</span>`); return; }
  fonts = data.fonts;
  $('assets-path').textContent = data.assets;
  $('font-count').textContent = `Fonts (${fonts.length})`;
  const list = $('fonts');
  list.replaceChildren(...fonts.map((f) => {
    const li = document.createElement('li');
    li.dataset.id = f.id;
    li.tabIndex = 0;
    li.className = font && font.id === f.id ? 'on' : '';
    li.innerHTML = `<span class="name">${esc(f.name)}</span><span class="meta">${f.glyphs} glyphs · ${f.kind === 'sheet' ? 'split from one STL' : f.kind === 'ttf' ? 'made from a font file' : 'one file per letter'}</span>`;
    li.title = f.source.join('\n');
    return li;
  }));
  const errs = data.errors.map((e) => `<div class="err">${esc(e.source)}: ${esc(e.message)}</div>`).join('');
  if (data.scanning) {
    showStatus(`Scanning ${data.done}/${data.total}: ${esc(data.current)}<div class="bar"><i style="width:${data.total ? (100 * data.done) / data.total : 0}%"></i></div>${errs}`);
  } else if (errs) showStatus(errs);
  else if (!fonts.length) showStatus('No fonts found in the assets folder.');
  else showStatus('');
  clearTimeout(pollTimer);
  if (data.scanning) pollTimer = setTimeout(refreshFonts, 800);
  if (pendingFont) {
    const made = fonts.find((f) => f.name.toLowerCase() === pendingFont.toLowerCase() && f.kind === 'ttf');
    if (made) { pendingFont = null; selectFont(made.id); return; }
    if (!data.scanning) pendingFont = null;
  }
  if (!font && fonts.length) selectFont((fonts.find((f) => f.id === saved('font', '')) || defaultFont()).id);
}
// First visit: a font that can spell the whole preview text - the bundled default if it is there.
function defaultFont() {
  const need = [...new Set($('text').value.replace(/[\s|]/g, ''))];
  const covers = (f) => need.every((c) => f.chars.includes(c));
  return fonts.find((f) => f.id === DEFAULT_FONT && covers(f)) || fonts.find(covers) || fonts[0];
}
function showStatus(html) { $('status').hidden = !html; $('status').innerHTML = html; }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function selectFont(id) {
  const token = ++loadToken;
  const data = await api('/api/fonts/' + id);
  if (token !== loadToken) return;
  save('font', id);
  for (const li of $('fonts').children) li.classList.toggle('on', li.dataset.id === id);
  const next = new Array(data.glyphs.length);
  let done = 0;
  const loading = $('loading');
  loading.hidden = false;
  const queue = data.glyphs.map((g, i) => i);
  const work = async () => {
    while (queue.length) {
      const i = queue.shift();
      const buf = await (await fetch(`/cache/${id}/${encodeURIComponent(data.glyphs[i].file)}`)).arrayBuffer();
      if (token !== loadToken) return;
      const geo = loader.parse(buf);
      geo.deleteAttribute('normal'); // flat-shaded; normals come from screen-space derivatives
      next[i] = geo;
      loading.textContent = `Loading ${data.name}… ${++done}/${data.glyphs.length}`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, work));
  if (token !== loadToken) return;
  loading.hidden = true;
  geoms.forEach((g) => g && g.dispose());
  font = data;
  geoms = next;
  userMoved = false;
  layoutText();
  renderGlyphs();
}

// ---------- text line ----------
function glyphMap() {
  const map = new Map();
  font.glyphs.forEach((g, i) => { if (g.char && !g.alt) map.set(g.char, i); });
  return map;
}
function layoutText() {
  textGroup.clear();
  if (!font) return;
  const map = glyphMap();
  const cap = font.capHeight || 1;
  // Fonts made from a font file have real advance widths: the slider's default adds nothing there.
  const gap = (+$('spacing').value - (font.kind === 'ttf' ? 0.08 : 0)) * cap;
  const spaceW = font.space ?? cap * 0.38;
  const missing = new Set();
  // room for descenders and accents (Å) between lines
  const lineH = cap * 1.6;
  let x = 0, y = 0, widest = 0;
  const put = (i, mat) => {
    const mesh = new THREE.Mesh(geoms[i], mat);
    mesh.position.set(x, y, 0);
    textGroup.add(mesh);
    x += (font.glyphs[i].adv ?? font.glyphs[i].w) + gap;
    widest = Math.max(widest, x - gap);
  };
  // '|' starts a new line
  for (const line of $('text').value.split('|')) {
    x = 0;
    for (const ch of line) {
      if (ch === ' ') { x += spaceW + gap; continue; }
      // fonts with only capitals (or only small letters) still spell everything
      const i = map.get(ch) ?? map.get(ch.toUpperCase()) ?? map.get(ch.toLowerCase());
      if (i === undefined) { missing.add(ch); x += cap * 0.3 + gap; continue; }
      put(i, material);
    }
    y -= lineH;
  }
  if ($('show-all').checked) {
    // the whole font underneath: capitals, small letters, digits, symbols - each group on its own line(s)
    const wrap = Math.max(widest, cap * 22);
    const all = [...map.entries()].sort((a, b) => charRank(a[0]) - charRank(b[0]));
    y -= cap * 0.5;
    const adv = (i) => (font.glyphs[i].adv ?? font.glyphs[i].w) + gap;
    for (let g = 0; g < 4; g++) {
      const items = all.filter(([ch]) => Math.floor(charRank(ch) / 1e6) === g);
      if (!items.length) continue;
      // a group too wide for one line is split into lines of equal length (no lone "Z" left over)
      const total = items.reduce((s, [, i]) => s + adv(i), 0);
      const target = total / Math.ceil(total / wrap);
      x = 0;
      for (const [, i] of items) {
        if (x > 0 && x + adv(i) / 2 > target) { x = 0; y -= lineH; }
        put(i, sheetMaterial);
      }
      y -= lineH;
    }
  }
  textGroup.scale.setScalar(1 / cap); // every font previews at the same size: capital height = 1
  $('missing').hidden = !missing.size;
  $('missing').textContent = missing.size ? `No glyph in this font for: ${[...missing].join(' ')}` : '';
  if (!userMoved) fit();
}

// ---------- glyph grid ----------
const THUMB = 128;
const thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
thumbRenderer.setSize(THUMB, THUMB, false);
const thumbScene = new THREE.Scene();
const thumbCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
thumbScene.add(new THREE.HemisphereLight(0xffffff, 0x555566, 1.3));
const thumbLight = new THREE.DirectionalLight(0xffffff, 2.2);
thumbLight.position.set(-0.6, 0.9, 1.2);
thumbScene.add(thumbLight);
const thumbMesh = new THREE.Mesh(undefined, material);
thumbScene.add(thumbMesh);

const drawThumb = (cv, i) => drawGlyph(cv, geoms[i], font.glyphs[i], font.capHeight);
// Front view of one glyph (g = its font.json entry, cap = the font's capital height) into a canvas.
function drawGlyph(cv, geo, g, cap) {
  const h = g.y1 - g.y0;
  const half = Math.max(g.w, h, cap * 1.1) * 0.56;
  thumbMesh.geometry = geo;
  const cx = (g.x0 || 0) + g.w / 2;
  thumbCam.left = cx - half; thumbCam.right = cx + half;
  thumbCam.bottom = (g.y0 + g.y1) / 2 - half; thumbCam.top = (g.y0 + g.y1) / 2 + half;
  thumbCam.updateProjectionMatrix();
  thumbRenderer.render(thumbScene, thumbCam);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, THUMB, THUMB);
  ctx.drawImage(thumbRenderer.domElement, 0, 0);
}

const charRank = (c) => (!c ? 4e6 : /[A-Z]/.test(c) ? 0 : /[a-z]/.test(c) ? 1e6 : /[0-9]/.test(c) ? 2e6 : 3e6) + (c ? c.codePointAt(0) : 0);
function renderGlyphs() {
  const box = $('glyphs');
  if (!font) { box.innerHTML = '<div class="empty">No font selected.</div>'; return; }
  const order = font.glyphs.map((g, i) => i).sort((a, b) => charRank(font.glyphs[a].char) - charRank(font.glyphs[b].char) || font.glyphs[a].alt - font.glyphs[b].alt || a - b);
  const labelled = font.glyphs.filter((g) => g.char && !g.alt).length;
  $('glyph-title').textContent = `${font.name} — ${labelled} characters` + (labelled < font.glyphs.length ? ` (${font.glyphs.length} glyphs)` : '');
  // fonts made from a font file also come as one STL holding every letter
  $('all-link').hidden = !font.allFile;
  if (font.allFile) { $('all-link').href = `/cache/${font.id}/${font.allFile}`; $('all-link').download = font.allFile; }
  $('glyph-title').title = `One STL per letter in cache\\${font.id}\\`;
  box.replaceChildren(...order.map((i) => {
    const g = font.glyphs[i];
    const cell = document.createElement('div');
    const unsure = font.kind === 'sheet' && !g.user && g.conf < 0.6;
    cell.className = 'glyph' + (g.alt ? ' alt' : '') + (unsure ? ' unsure' : '');
    cell.title = `${g.file}\n${g.n.toLocaleString()} triangles` + (unsure ? '\nnot sure about this label' : '') + (g.alt ? '\nduplicate of another glyph with this label (not used in text)' : '');
    const cv = document.createElement('canvas');
    cv.width = cv.height = THUMB;
    drawThumb(cv, i);
    cv.addEventListener('click', () => { if (g.char) { $('text').value += g.char; onText(); } });
    const input = document.createElement('input');
    input.value = g.char || '';
    input.maxLength = 2;
    input.setAttribute('aria-label', 'Character for this glyph');
    input.addEventListener('focus', () => input.select());
    input.addEventListener('change', () => relabel(i, input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = g.alt ? 'duplicate' : !g.char ? 'unlabelled' : unsure ? 'check' : '';
    cell.append(cv, input, tag);
    return cell;
  }));
}
function redrawThumbs() {
  if (!font) return;
  renderGlyphs();
}

async function relabel(i, value) {
  try {
    const data = await api(`/api/fonts/${font.id}/glyphs/${i}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ char: value }) });
    font = data;
    layoutText();
    renderGlyphs();
    refreshFonts();
  } catch (e) { showStatus(`<span class="err">Could not relabel: ${esc(e.message)}</span>`); }
}

// ---------- wiring ----------
function onText() { save('text', $('text').value); layoutText(); }
// migrate the previous default text
$('text').value = saved('text', DEFAULT_TEXT) === 'Quick brown fox jumps over a fence' ? DEFAULT_TEXT : saved('text', DEFAULT_TEXT);
$('text').addEventListener('input', onText);
$('spacing').value = saved('spacing', '0.08');
$('spacing').addEventListener('input', () => { save('spacing', $('spacing').value); layoutText(); });
$('color').value = saved('color', '#4f8ef7');
$('color').addEventListener('input', () => { material.color.set($('color').value); tintSheet(); save('color', $('color').value); redrawThumbs(); });
$('show-all').checked = saved('all', '1') === '1';
$('show-all').addEventListener('change', () => { save('all', $('show-all').checked ? '1' : '0'); layoutText(); });
$('fonts').addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) selectFont(li.dataset.id); });
$('fonts').addEventListener('keydown', (e) => { const li = e.target.closest('li'); if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectFont(li.dataset.id); } });
$('rescan').addEventListener('click', async () => { await api('/api/rescan', { method: 'POST' }); refreshFonts(); });
$('nav').addEventListener('click', (e) => {
  if (cubeDragged) { cubeDragged = false; return; } // the end of a drag on the cube is not a click on a face
  const v = e.target.closest('[data-view]');
  if (v) snap(v.dataset.view);
});
// Dragging the cube turns it - and the view with it - like grabbing the model itself.
let cubeDragged = false;
{
  const box = $('cube-box');
  let last = null, moved = 0;
  box.addEventListener('pointerdown', (e) => { last = [e.clientX, e.clientY]; moved = 0; cubeDragged = false; });
  box.addEventListener('pointermove', (e) => {
    if (!last) return;
    const dx = e.clientX - last[0], dy = e.clientY - last[1];
    moved += Math.abs(dx) + Math.abs(dy);
    if (moved < 4) return; // a slightly shaky click still counts as a click
    last = [e.clientX, e.clientY];
    // capture only once it is a drag, so a plain click still reaches the face
    if (!cubeDragged) box.setPointerCapture(e.pointerId);
    cubeDragged = true;
    anim = null;
    userMoved = true;
    const s = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    s.theta -= dx * 0.012;
    s.phi = Math.min(Math.PI - 0.001, Math.max(0.001, s.phi - dy * 0.012));
    camera.position.setFromSpherical(s).add(controls.target);
    camera.lookAt(controls.target);
  });
  const end = (e) => { last = null; if (box.hasPointerCapture(e.pointerId)) box.releasePointerCapture(e.pointerId); };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}
$('fit').addEventListener('click', () => { userMoved = false; fit(); });
$('proj-ortho').addEventListener('click', () => setProjection('ortho'));
$('proj-persp').addEventListener('click', () => setProjection('persp'));
canvas.addEventListener('dblclick', () => { userMoved = false; fit(); });

// ---------- find font by sample ----------
const findDlg = $('find');
let findSamples = []; // { file, sample } - sample as prepared by the server
$('find-open').addEventListener('click', () => findDlg.showModal());
$('find-close').addEventListener('click', () => findDlg.close());
$('find-files').addEventListener('change', async () => {
  findSamples = [...$('find-files').files].map((file) => ({ file, sample: null }));
  await Promise.all(findSamples.map((s) => prepareSample(s, '')));
  runFind();
});
async function prepareSample(s, char) {
  $('find-status').textContent = 'Reading samples…';
  try {
    s.sample = await api(`/api/find/sample?name=${encodeURIComponent(s.file.name)}&char=${encodeURIComponent(char)}`, { method: 'POST', body: s.file });
  } catch (e) { s.sample = null; s.error = e.message; }
  renderSamples();
}
function renderSamples() {
  $('find-samples').replaceChildren(...findSamples.map((s) => {
    const row = document.createElement('div');
    row.className = 'sample';
    const cv = document.createElement('canvas');
    cv.width = cv.height = 32;
    if (s.sample) {
      const bytes = Uint8Array.from(atob(s.sample.variants[0].m), (c) => c.charCodeAt(0));
      const img = new ImageData(32, 32);
      bytes.forEach((v, i) => { img.data.set([255 - v, 255 - v, 255 - v, 255], i * 4); });
      cv.getContext('2d').putImageData(img, 0, 0);
      // the bitmap is stretched to a square for matching; show it at the letter's real proportions
      cv.style.width = Math.round(64 * Math.min(2.5, Math.max(0.2, s.sample.variants[0].a))) + 'px';
    }
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = s.sample ? s.file.name : `${s.file.name}: ${s.error || '…'}`;
    name.title = s.file.name;
    const input = document.createElement('input');
    input.maxLength = 1;
    input.value = s.sample ? s.sample.char : '';
    input.title = 'Which character this is - correct it if the guess is wrong';
    input.setAttribute('aria-label', 'Character of this sample');
    input.addEventListener('change', async () => { await prepareSample(s, input.value.trim()); runFind(); });
    row.append(cv, name, input);
    return row;
  }));
}
async function runFind() {
  const samples = findSamples.filter((s) => s.sample).map((s) => s.sample);
  const list = $('find-results');
  list.replaceChildren();
  if (!samples.length) { $('find-status').textContent = ''; return; }
  $('find-status').textContent = 'Comparing with all fonts… (the first search for a new letter takes a few seconds)';
  let data;
  try { data = await api('/api/find', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ samples }) }); } catch (e) { $('find-status').textContent = e.message; return; }
  const chars = samples.map((s) => s.char).join('');
  $('find-status').textContent = `Best matches of ${data.compared} fonts for "${chars}". ${data.note || ''}`;
  list.replaceChildren(...data.results.map((r, k) => {
    const li = document.createElement('li');
    // a clear winner stands out from the pack; otherwise nothing is marked
    if (k === 0 && data.results[1] && r.score - data.results[1].score > 0.03) li.className = 'best';
    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = Math.round(r.score * 100) + '%';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.innerHTML = `${esc(r.name)} <small>${r.type === 'library' ? '3D font in library' : 'system font'}</small>`;
    nm.title = r.name;
    let pv;
    if (r.type === 'library') {
      pv = document.createElement('button');
      pv.textContent = 'Open';
      pv.addEventListener('click', () => { findDlg.close(); selectFont(r.id); });
    } else {
      pv = document.createElement('span');
      const sample = document.createElement('span');
      sample.className = 'pv';
      // browser sample only for fonts it really has; otherwise drawn by the server
      const style = r.style.replace(',', '');
      if (browserHas({ family: r.family, style })) {
        sample.textContent = chars;
        sample.style.fontFamily = `"${r.family}"`;
        if (/Bold/.test(style)) sample.style.fontWeight = '700';
        if (/Italic/.test(style)) sample.style.fontStyle = 'italic';
      } else {
        previewSvg({ family: r.family, style }, chars, 28).then((svg) => { if (svg) sample.append(svg); });
      }
      const make = document.createElement('button');
      make.textContent = 'Make 3D';
      make.title = 'Extrude this installed font into a 3D font and add it to the list';
      make.addEventListener('click', async () => { if (await addFont({ type: 'system', family: r.family, style: r.style }, $('find-status'))) findDlg.close(); });
      pv.append(sample, ' ', make);
    }
    li.append(pct, nm, pv);
    li.tabIndex = 0;
    li.addEventListener('click', (e) => { if (!e.target.closest('button')) selectResult(li, r, chars); });
    li.addEventListener('keydown', (e) => {
      if (e.target !== li) return;
      const next = e.key === 'ArrowDown' ? li.nextElementSibling : e.key === 'ArrowUp' ? li.previousElementSibling : null;
      if (next) { e.preventDefault(); next.focus(); next.click(); }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectResult(li, r, chars); }
    });
    return li;
  }));
  // start with the best match shown large next to the samples
  if (data.results.length) selectResult(list.firstElementChild, data.results[0], chars);
  else $('find-big').replaceChildren();
}

// Selecting a result shows its letters large, beside the uploaded samples, for a direct comparison.
const BIG_H = 76;
// Text drawn by the browser, cropped to its ink and scaled to exactly `height` CSS pixels.
function inkCanvas(text, font, height) {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  ctx.font = font;
  const m = ctx.measureText(text);
  const w = Math.max(1, m.actualBoundingBoxLeft + m.actualBoundingBoxRight), h = Math.max(1, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent);
  const k = (height * Math.min(window.devicePixelRatio || 1, 2) * 2) / h; // 2x for crisp edges
  cv.width = Math.ceil(w * k) + 2;
  cv.height = Math.ceil(h * k) + 2;
  ctx.setTransform(k, 0, 0, k, 1, 1);
  ctx.font = font;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#888';
  ctx.fillText(text, m.actualBoundingBoxLeft, m.actualBoundingBoxAscent);
  cv.style.height = height + 'px';
  cv.style.width = 'auto';
  return cv;
}
let bigToken = 0;
async function selectResult(li, r, chars) {
  for (const el of $('find-results').children) el.classList.toggle('on', el === li);
  const token = ++bigToken;
  const box = document.createElement('div');
  box.className = 'big';
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.textContent = r.name;
  if (r.type === 'system') {
    const style = r.style.replace(',', '');
    // every preview is cropped to its ink and scaled to the full height of the box
    if (browserHas({ family: r.family, style })) {
      box.append(inkCanvas(chars, `${/Italic/.test(style) ? 'italic ' : ''}${/Bold/.test(style) ? '700 ' : ''}200px "${r.family.replace(/["\\]/g, '')}"`, BIG_H));
    } else {
      const svg = await previewSvg({ family: r.family, style, tight: 1 }, chars, BIG_H);
      if (svg) box.append(svg); else cap.textContent += ' (no preview available)';
    }
  } else {
    // a 3D font of the library: draw its own glyphs for these letters
    try {
      const f = await api('/api/fonts/' + r.id);
      for (const ch of chars) {
        const pick = (c) => f.glyphs.find((g) => g.char === c && !g.alt);
        const g = pick(ch) || pick(ch.toUpperCase()) || pick(ch.toLowerCase());
        if (!g) continue;
        const geo = loader.parse(await (await fetch(`/cache/${r.id}/${encodeURIComponent(g.file)}`)).arrayBuffer());
        geo.deleteAttribute('normal');
        const cv = document.createElement('canvas');
        cv.width = cv.height = THUMB;
        drawGlyph(cv, geo, g, 0); // cap 0 = frame the glyph itself
        geo.dispose();
        box.append(cv);
      }
    } catch (e) { cap.textContent += ' (no preview available)'; }
  }
  if (token === bigToken) $('find-big').replaceChildren(box, cap);
}

// ---------- add a font (extrude an ordinary font file into 3D letters) ----------
const addDlg = $('add');
let pendingFont = null; // name of a font being generated: selected once it shows up in the list
async function addFont(body, statusEl) {
  statusEl.textContent = 'Working…';
  try {
    const r = await api('/api/fonts/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    statusEl.textContent = `Making 3D letters for ${r.name}…`;
    pendingFont = r.name;
    refreshFonts();
    return true;
  } catch (e) { statusEl.textContent = e.message; return false; }
}
$('add-open').addEventListener('click', async () => {
  addDlg.showModal();
  if (addDlg.sysFonts) return;
  try {
    addDlg.sysFonts = await api('/api/sysfonts');
    renderSysList();
  } catch (e) { $('add-status').textContent = e.message; }
});
// Installed fonts as a scrollable list, each with a sample set in the font itself; the box filters it.
function renderSysList() {
  const words = $('add-sys').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const chosen = $('add-sys').value.trim().toLowerCase();
  const list = (addDlg.sysFonts || []).filter((f) => words.every((w) => f.name.toLowerCase().includes(w)));
  // an exact name is a selection, not a filter: keep the whole list visible around it
  const exact = (addDlg.sysFonts || []).some((f) => f.name.toLowerCase() === chosen);
  $('sys-list').replaceChildren(...(exact ? addDlg.sysFonts : list).map((f) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.name = f.name;
    li.className = f.name.toLowerCase() === chosen ? 'on' : '';
    const name = document.createElement('span');
    name.textContent = f.name;
    const pv = document.createElement('span');
    pv.className = 'pv';
    if (browserHas(f)) {
      pv.textContent = PREVIEW_TEXT;
      pv.style.fontFamily = `"${f.family}"`;
      if (/bold/i.test(f.style)) pv.style.fontWeight = '700';
      if (/italic|oblique/i.test(f.style)) pv.style.fontStyle = 'italic';
    } else if (sysPreviews.has(f.name)) {
      pv.append(sysPreviews.get(f.name).cloneNode(true));
    }
    li.append(name, pv);
    return li;
  }));
  const on = $('sys-list').querySelector('.on');
  if (on) { on.scrollIntoView({ block: 'nearest' }); serverPreview(on); }
}

// Browser samples only for fonts the browser really has; other rows get a server-drawn sample
// when selected.
const PREVIEW_TEXT = 'AaBbCc 123';
const hasFamily = new Map();
const measureCtx = document.createElement('canvas').getContext('2d');
function browserHas(f) {
  // only plain styles map onto CSS weight/italic
  if (!/^(regular|bold|italic|oblique|bold italic|bold oblique)$/i.test(f.style)) return false;
  if (!hasFamily.has(f.family)) {
    const width = (font) => { measureCtx.font = `72px ${font}`; return measureCtx.measureText('mmwwiillAaBb@123').width; };
    const fam = `"${f.family.replace(/["\\]/g, '')}"`;
    // present if it changes the measurement against at least one generic fallback
    hasFamily.set(f.family, ['monospace', 'serif', 'sans-serif'].some((g) => width(`${fam}, ${g}`) !== width(g)));
  }
  return hasFamily.get(f.family);
}
const sysPreviews = new Map(); // request -> <svg> (or null when the server could not draw it)
// A sample drawn by the server from the font file; who = { name } or { family, style }.
async function previewSvg(who, text, height = 24) {
  const q = new URLSearchParams({ ...who, text }).toString();
  if (!sysPreviews.has(q)) {
    let svg = null;
    try {
      const p = await api('/api/sysfonts/preview?' + q);
      const ns = 'http://www.w3.org/2000/svg';
      svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `${p.x} ${p.y} ${p.w} ${p.h}`);
      svg.setAttribute('height', height);
      svg.setAttribute('width', Math.min(height * 11, Math.round((height * p.w) / p.h)));
      svg.setAttribute('aria-label', `${who.name || who.family} sample`);
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', p.d);
      path.setAttribute('fill', 'currentColor');
      svg.append(path);
    } catch (e) { /* no usable font file (e.g. a .ttc collection): leave the sample empty */ }
    sysPreviews.set(q, svg);
  }
  const svg = sysPreviews.get(q);
  return svg ? svg.cloneNode(true) : null;
}
async function serverPreview(li) {
  const f = (addDlg.sysFonts || []).find((x) => x.name === li.dataset.name);
  if (!f || browserHas(f)) return;
  const svg = await previewSvg({ name: f.name }, PREVIEW_TEXT);
  const pv = li.querySelector('.pv');
  if (svg && pv && li.isConnected && !pv.firstChild) pv.append(svg);
}
$('add-sys').addEventListener('input', renderSysList);
$('sys-list').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  $('add-sys').value = li.dataset.name;
  for (const el of $('sys-list').children) el.classList.toggle('on', el === li);
  serverPreview(li);
});
$('sys-list').addEventListener('dblclick', (e) => { if (e.target.closest('li')) $('add-sys-go').click(); });
$('add-close').addEventListener('click', () => addDlg.close());
$('add-sys-go').addEventListener('click', async () => {
  const f = (addDlg.sysFonts || []).find((x) => x.name.toLowerCase() === $('add-sys').value.trim().toLowerCase());
  if (!f) { $('add-status').textContent = 'Pick one of the installed fonts from the list.'; return; }
  if (await addFont({ type: 'system', family: f.family, style: f.style }, $('add-status'))) addDlg.close();
});
$('add-google-go').addEventListener('click', async () => {
  if (await addFont({ type: 'google', family: $('add-google').value, weight: $('add-weight').value }, $('add-status'))) addDlg.close();
});

resize();
setProjection('persp');
fit(VIEWS.iso);
if (VIEWS[query.get('view')]) { setProjection(query.get('view') === 'iso' ? 'persp' : 'ortho'); fit(VIEWS[query.get('view')]); }
refreshFonts();

// ?dialog=add opens the Add dialog straight away (handy for screenshots)
if (query.get('dialog') === 'add') { $('add-sys').value = query.get('q') || ''; $('add-open').click(); }

// ?find=<font-id>:<letters>[&pick=<n>] runs the finder on glyphs of a library font (test hook)
if (query.get('find')) {
  const [id, letters] = query.get('find').split(':');
  findDlg.showModal();
  Promise.all([...(letters || '')].map(async (ch) => ({ file: new File([await (await fetch(`/cache/${id}/${ch}.stl`)).blob()], `${ch}.stl`), sample: null })))
    .then(async (list) => { findSamples = list; await Promise.all(findSamples.map((s) => prepareSample(s, ''))); await runFind(); const li = $('find-results').children[+query.get('pick')]; if (query.get('pick') && li) { li.scrollIntoView({ block: 'center' }); li.click(); } });
}