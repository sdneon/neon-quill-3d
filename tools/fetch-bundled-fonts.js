'use strict';
// Downloads the fonts shipped in fonts-bundled/ (all SIL Open Font License) from Google Fonts,
// together with each font's licence text. Only needed to refresh or extend the bundle.
//   node tools/fetch-bundled-fonts.js
const fs = require('fs');
const path = require('path');

// [family, weight, folder name in github.com/google/fonts/ofl]
const FONTS = [
  ['Audiowide', 400, 'audiowide'],
  ['Dancing Script', 700, 'dancingscript'],
  ['Lobster', 400, 'lobster'],
  ['Pacifico', 400, 'pacifico'],
  ['Caprasimo', 400, 'caprasimo'],
  ['Bungee', 400, 'bungee'],
  ['Righteous', 400, 'righteous'],
  ['Orbitron', 700, 'orbitron'],
  ['Fredoka', 600, 'fredoka'],
];
const OUT = path.join(__dirname, '..', 'fonts-bundled');

(async () => {
  fs.mkdirSync(path.join(OUT, 'licenses'), { recursive: true });
  for (const [family, weight, dir] of FONTS) {
    const q = encodeURIComponent(family).replace(/%20/g, '+');
    // the css2 endpoint hands plain TTF links to clients it does not recognise as browsers
    const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${q}:wght@${weight}`, { headers: { 'User-Agent': 'node' } })).text();
    const m = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/.exec(css);
    if (!m) { console.log(`FAILED  ${family}: no TTF offered`); continue; }
    const base = family.replace(/\s+/g, '') + (weight === 400 ? '' : '-' + weight);
    fs.writeFileSync(path.join(OUT, base + '.ttf'), Buffer.from(await (await fetch(m[1])).arrayBuffer()));
    const lic = await fetch(`https://raw.githubusercontent.com/google/fonts/main/ofl/${dir}/OFL.txt`);
    if (!lic.ok) { console.log(`FAILED  ${family}: licence text not found (${lic.status})`); continue; }
    const text = await lic.text();
    fs.writeFileSync(path.join(OUT, 'licenses', base + '-OFL.txt'), text);
    console.log(`ok      ${family} ${weight}  -  ${text.split('\n')[0].trim()}`);
  }
})();
