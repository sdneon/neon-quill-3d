'use strict';
// Minimal dependency-free ZIP reader (store + deflate, no zip64/encryption).
const fs = require('fs');
const zlib = require('zlib');

function openFrom(readAt, size) {
  const tailLen = Math.min(size, 65557);
  const tail = readAt(size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no end-of-central-directory)');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOff = tail.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff) throw new Error('zip64 not supported');
  const cd = readAt(cdOff, cdSize);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10);
    const csize = cd.readUInt32LE(p + 20);
    const usize = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28);
    const xlen = cd.readUInt16LE(p + 30);
    const clen = cd.readUInt16LE(p + 32);
    const offset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    entries.push({ name, method, csize, usize, offset });
  }
  function read(entry) {
    const lh = readAt(entry.offset, 30);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header: ' + entry.name);
    const start = entry.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const data = readAt(start, entry.csize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 1 << 30 });
    throw new Error('unsupported zip method ' + entry.method + ': ' + entry.name);
  }
  return { entries, read };
}

function openFile(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const readAt = (pos, len) => {
    const b = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, b, got, len - got, pos + got);
      if (n <= 0) throw new Error('short read in ' + file);
      got += n;
    }
    return b;
  };
  const z = openFrom(readAt, size);
  z.close = () => fs.closeSync(fd);
  return z;
}

function openBuffer(buf) {
  const z = openFrom((pos, len) => buf.subarray(pos, pos + len), buf.length);
  z.close = () => {};
  return z;
}

module.exports = { openFile, openBuffer };
