'use strict';
// Offline variant of make-ref.js: regenerates lib/ref-glyphs.json from the fonts installed on this
// machine. For private use - a file made this way must not be redistributed (make-release refuses it).
//   node tools/make-ref-from-system.js
require('./make-ref').run({ system: true }).catch((e) => { console.error(e.message); process.exit(1); });
