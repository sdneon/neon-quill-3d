# Neon Quill 3D

**Preview, find and create fonts for 3D printing.**

Neon Quill 3D is a small local web app for people who print letters. It lets you

- **preview** any text in 3D in every font you have, whether the font is a set of STL letters you
  downloaded or an ordinary font file;
- **find** which font a printed-letter STL comes from, by comparing it with the fonts installed on
  your computer;
- **create** a 3D font from any TTF/OTF font: one STL per letter, plus one STL with the whole
  alphabet for sharing.

Everything runs on your own machine. Nothing is uploaded anywhere.

## Quick start

You need [Node.js](https://nodejs.org) 22 or newer.

    npm install
    node server.js

Open <http://localhost:8123/>. Nine bundled fonts are turned into 3D letters on the first start
(a few seconds) and the preview opens in one of them.

To add your own STL fonts, put them (zipped or not) in the `assets` folder next to `server.js` and
press **Rescan**.

## Usage

### The preview

- Type in the box at the top; the 3D text follows as you type. `|` starts a new line.
- **All letters** shows every character of the font underneath your text.
- **Spacing** changes the gap between letters; the colour box changes the model colour.
- Drag to rotate, right-drag to pan, wheel to zoom, double-click to fit.
- The cube snaps to Front / Back / Left / Right / Top / Bottom (orthographic). **3D** returns to the
  perspective opening view, **Fit** frames the text, **Ortho / Persp** switches projection.
- The panel at the bottom shows every glyph of the font. Click one to type it.

### Your own STL fonts

Point the app at a folder of downloads and it works out which of them are fonts:

    node server.js path/to/your/folder

(or set `FONT_ASSETS`, or put `{ "assets": "path/to/your/folder" }` in a `config.json` next to
`server.js`). Loose files, sub-folders, zip archives and zips inside zips are all searched.
Two kinds of font are recognised:

- **one file per letter** – `A.stl`, `Font_b.stl`, `comma.stl` … (also `.3mf`);
- **a whole alphabet in one STL** – the app cuts it into separate letters and works out which is which.

Models that are not fonts are ignored. If a letter is labelled wrongly, type the right character in
the box under that glyph.

### Fonts from font files (Add…)

Any TTF or OTF font can be extruded into 3D letters:

- **Add… → Installed font** – pick from the fonts on your computer (type to filter).
- **Add… → Google Fonts** – type a family name; the font is downloaded into `fonts/`.
- Or drop `.ttf` / `.otf` files into `assets/` or `fonts/` and press **Rescan**.

Each font gets a folder under `cache/` holding one STL per letter and `<font>-all.stl` with every
letter laid out in rows. The **All-in-one STL** link above the glyph panel downloads the latter.
Check a font's licence before sharing models made from it.

A few fonts draw letters as a single stroke that loops over itself (some "neon" and monoline designs).
Those letters can come out with filled-in gaps; fonts built from ordinary or overlapping outlines are fine.

### Find a font from a sample (Find…)

Pick one or more STL files that each hold a single letter. The letter is taken from the file name
when it offers a hint (`Letter_S.stl`, `Letter_&.stl`, `ampersand.stl`), otherwise guessed from the
shape; correct it in the box if needed. The results rank every installed font and every 3D font in
your library by similarity. Select a result to see it large beside your samples; **Make 3D** turns
an installed font into a 3D font on the spot.

Comparing against installed fonts uses Windows' own text rendering, so this part needs Windows.
On other systems only the 3D fonts in your library are compared.

## Bundled fonts

The fonts in `fonts-bundled/` come from Google Fonts and are licensed under the
[SIL Open Font License 1.1](https://openfontlicense.org); each font's licence and copyright notice
is in `fonts-bundled/licenses/`.

Fredoka · Audiowide · Bungee · Caprasimo · Dancing Script · Lobster · Orbitron · Pacifico · Righteous

`node tools/fetch-bundled-fonts.js` downloads them again (edit the list in that file to change the set).

## Licence

Neon Quill 3D is released under the [MIT License](LICENSE). The bundled fonts keep their own licence
(SIL Open Font License, see above). The reference letter shapes in `lib/ref-glyphs.json` were drawn
from openly licensed fonts (`tools/make-ref.js`).

## How it works

- **Discovery** (`lib/scan.js`) lists the assets folder, groups multi-part downloads, and prefers an
  unpacked folder over its zip. A single STL counts as a font when it is flat and holds at least 20
  separate letter-sized pieces arranged in rows.
- **Splitting** (`lib/split.js`) separates such an STL into connected pieces and joins dots, rings
  and specks to their letters.
- **Recognition** (`lib/recognize.js`) compares each silhouette with reference bitmaps of common
  fonts and uses alphabet order along the row; the same comparison decides which way round a model faces.
- **Font files** (`lib/ttf.js`) are read with opentype.js and extruded with three.js, keeping the
  font's real spacing.
- **Finding** (`lib/find.js`) renders the wanted character in every installed font and ranks by
  silhouette difference.
- **Cache** – results are kept in `cache/` and only rebuilt when a source changes. Delete the folder
  to start afresh.

No build step and no framework: a Node server (`server.js`), a page (`public/`), and two
dependencies, [three.js](https://threejs.org) and [opentype.js](https://opentype.js.org) (both MIT).

## Files

    server.js          the server
    lib/               scanning, splitting, recognition, font extrusion, finding
    public/            the page
    tools/             helper scripts (reference bitmaps, system-font rendering, bundled fonts)
    fonts-bundled/     the fonts shipped with the app, with their licences
    assets/            your STL fonts (created on first start)
    fonts/             font files you downloaded or dropped in
    cache/             generated letters

# Credits
This is a production by Neon who occasionally dabbles in 3D Printing and needs help to find 'Q' - a lost letter of some font now and then, with major assist from Claude Code =)

Great thanks to the community, from creators of 3D fonts et al, to platforms like [thingiverse](https://www.thingiverse.com/) for the many wondrous creations =)
