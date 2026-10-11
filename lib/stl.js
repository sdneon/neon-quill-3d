'use strict';
// STL read/write. Meshes are passed around as a flat Float32Array, 9 floats per triangle.

function isBinary(buf) {
  if (buf.length < 84) return false;
  const n = buf.readUInt32LE(80);
  if (84 + n * 50 === buf.length) return true;
  const head = buf.toString('latin1', 0, Math.min(buf.length, 512));
  if (/^\s*solid\b/.test(head) && /facet|endsolid/.test(buf.toString('latin1', 0, Math.min(buf.length, 4096)))) return false;
  return true;
}

function parseBinary(buf) {
  const n = Math.min(buf.readUInt32LE(80), Math.floor((buf.length - 84) / 50));
  const tris = new Float32Array(n * 9);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  for (let i = 0, p = 96; i < n; i++, p += 50) {
    for (let k = 0; k < 36; k += 4) tris[o++] = dv.getFloat32(p + k, true);
  }
  return tris;
}

function parseAscii(buf) {
  const out = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  // Decode in chunks so huge ASCII files never need one giant string.
  const CHUNK = 32 << 20;
  let carry = '';
  for (let pos = 0; pos < buf.length; pos += CHUNK) {
    const text = carry + buf.toString('latin1', pos, Math.min(buf.length, pos + CHUNK));
    const cut = pos + CHUNK < buf.length ? text.lastIndexOf('\n') : text.length;
    const part = text.slice(0, cut);
    carry = text.slice(cut);
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(part))) out.push(+m[1], +m[2], +m[3]);
  }
  out.length -= out.length % 9;
  return Float32Array.from(out);
}

function parse(buf) {
  return isBinary(buf) ? parseBinary(buf) : parseAscii(buf);
}

function write(tris) {
  const n = tris.length / 9;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write('Neon Quill 3D glyph', 0, 'latin1');
  buf.writeUInt32LE(n, 80);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0, p = 84, o = 0; i < n; i++, p += 50, o += 9) {
    const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
    const ux = tris[o + 3] - ax, uy = tris[o + 4] - ay, uz = tris[o + 5] - az;
    const vx = tris[o + 6] - ax, vy = tris[o + 7] - ay, vz = tris[o + 8] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(p, nx / l, true); dv.setFloat32(p + 4, ny / l, true); dv.setFloat32(p + 8, nz / l, true);
    for (let k = 0; k < 9; k++) dv.setFloat32(p + 12 + k * 4, tris[o + k], true);
  }
  return buf;
}

function bbox(tris) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = tris[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

module.exports = { parse, write, bbox, isBinary };
