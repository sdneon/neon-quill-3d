'use strict';
// Just enough 3MF to read letter models: every mesh in every .model part, concatenated.
// Build/component transforms are ignored (fine for one-object-per-file letters).
const zip = require('./zip');

function parse(buf) {
  const z = zip.openBuffer(buf);
  const out = [];
  for (const e of z.entries) {
    if (!/\.model$/i.test(e.name)) continue;
    const xml = z.read(e).toString('utf8');
    const meshRe = /<mesh\b[\s\S]*?<\/mesh>/g;
    let m;
    while ((m = meshRe.exec(xml))) {
      const verts = [];
      const vRe = /<vertex\b([^>]*)>/g;
      let v;
      while ((v = vRe.exec(m[0]))) {
        const a = v[1];
        verts.push(+/\bx="([^"]+)"/.exec(a)[1], +/\by="([^"]+)"/.exec(a)[1], +/\bz="([^"]+)"/.exec(a)[1]);
      }
      const tRe = /<triangle\b([^>]*)>/g;
      while ((v = tRe.exec(m[0]))) {
        const a = v[1];
        for (const k of ['v1', 'v2', 'v3']) {
          const i = +new RegExp('\\b' + k + '="(\\d+)"').exec(a)[1] * 3;
          out.push(verts[i], verts[i + 1], verts[i + 2]);
        }
      }
    }
  }
  return Float32Array.from(out);
}

module.exports = { parse };
