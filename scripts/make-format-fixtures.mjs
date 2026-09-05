#!/usr/bin/env node
import { deflateSync, crc32 } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeZip } from './lib/zip.mjs'

/**
 * WI-24.A1 — one minimal book per format Paper's picker offers.
 *
 * `ACCEPT_FORMATS` is `.epub,.pdf,.mobi,.azw3,.cbz,.fb2,.fbz`. EPUB and PDF are
 * exercised everywhere in this tree; the other five have never been opened by a
 * test or by a person, which is what makes the ledger's `MOBI / AZW3 / CBZ /
 * FB2` row Partial. This builds the fixtures that row needs.
 *
 * ⚠️ **THE LEDGER ROW NAMES FOUR FORMATS AND THE PICKER OFFERS FIVE.** `.fbz`
 * — a zipped FB2 — has been on the accept list the whole time and appears in no
 * row, no test and no plan. It is here because "handled by the same loader" is
 * exactly the kind of claim this phase exists to stop taking on trust.
 *
 * # Committed, and regenerable
 *
 * The fixtures are checked in (see `FIXTURE_DIR`) and this script is how they
 * are remade. `make-sample-epub.py` and `make-hostile-epub.py` are the pattern:
 * a fixture whose GENERATOR is reviewed is a fixture whose contents can be
 * reasoned about, where a checked-in binary with no generator is a thing nobody
 * reads again after the commit that added it.
 *
 * # Every fixture carries a watchword, and they are all different
 *
 * ⚠️ **A TEST THAT ASSERTS "the title is Moby-Dick" PASSES AGAINST THE WRONG
 * FILE.** Each book here declares a title, an author and a sentence containing a
 * nonce that appears nowhere else in this repository or in any real book, and no
 * two fixtures share one. So a loader that silently fell back to another
 * fixture, or a test pointed at a stale path, fails rather than passes.
 *
 * MOBI and AZW3 are CONVERTED, so each gets its own source EPUB rather than
 * sharing one — otherwise both would carry the EPUB's watchword and the two
 * cases could not tell each other apart.
 *
 * # CBZ has no text, and the test has to know that
 *
 * ⚠️ A comic book is a zip of images. There is no title, no author, no
 * sentence — `comic-book.js` synthesises a section per image and that is all
 * there is. Asserting a watchword against it is impossible, so the fixture
 * declares its shape instead: `CBZ_PAGES` images at `CBZ_SIZE`, and the test
 * asserts the count. Stated here because a test author reaching for the same
 * assertion as the other four will write one that cannot pass, and conclude the
 * format is broken.
 *
 * # The `ebook-convert` dependency is FATAL, never skipped
 *
 * ⚠️ **A GENERATOR THAT QUIETLY PRODUCES THREE OF FIVE IS HOW THIS PHASE GOES
 * GREEN HAVING TESTED NOTHING.** `actool` exits 0 and writes no `Assets.car`;
 * `screencapture` exits 0 having written nothing; `codesign` reports a pipe's
 * status. Three defects of one shape, all recorded in `AGENTS.md`, and this is
 * where the fourth would go. If Calibre is missing this exits non-zero and names
 * the formula. It does not warn, and it does not carry on.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

/**
 * Where the fixtures go, and **all six are COMMITTED.**
 *
 * ⚠️ **CALIBRE CANNOT BE A TEST DEPENDENCY.** MOBI and AZW3 exist only as
 * `ebook-convert` output; a test that shelled out to Calibre would be red on
 * every machine and every CI runner without it — the `features:check` trap in a
 * new coat, a gate whose input is not in the checkout.
 *
 * The other four could have been built in the test from the functions below,
 * and the first draft did exactly that. **It was wrong for two reasons that had
 * nothing to do with size**: a test under `src/kernel/` importing a build script
 * is an edge pointing the wrong way, and `tsc` cannot type an untyped `.mjs`
 * across it (`TS7016`, twice). Reading six files costs neither.
 *
 * **27 KB, and the "no binaries in git" rule does not reach it.** That rule is
 * `vendor/pdfjs/` and `vendor/inference/` — tens of megabytes of compiled
 * runtime per platform. Six fixtures the size of one source file, regenerable
 * by this script, are the opposite case, and committing them is what makes the
 * test hermetic.
 */
export const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures')

/** The author every fixture declares. One name, so a wrong-file failure shows up in the TITLE or the watchword rather than here. */
const AUTHOR_FIRST = 'Fixture'
const AUTHOR_LAST = 'Wright'

/**
 * The author every fixture declares. One name, so a wrong-file failure shows up
 * in the TITLE or the watchword rather than here.
 *
 * ⚠️ **DERIVED FROM THE TWO PARTS, not spelled a second time.** FB2 needs the
 * name split into `<first-name>`/`<last-name>` and had both words written out
 * again — so changing this constant moved EPUB, MOBI and AZW3 and silently left
 * FB2 and FBZ behind, which is a fixture set that disagrees with itself.
 */
export const FIXTURE_AUTHOR = `${AUTHOR_FIRST} ${AUTHOR_LAST}`

/**
 * The nonce each format's prose carries.
 *
 * Chosen to be real words that are rare rather than invented strings, because a
 * conversion pipeline may lowercase, hyphenate or spell-correct, and a real word
 * survives all three. Verified absent from this repository before use.
 */
export const WATCHWORDS = Object.freeze({
  epub: 'quernstone',
  mobi: 'marlinspike',
  azw3: 'sarsaparilla',
  fb2: 'fenugreek',
  fbz: 'halyard',
})

/** Pages in the CBZ fixture, and the size of each. Asserted by the test — see the header. */
export const CBZ_PAGES = 3
export const CBZ_SIZE = 8

export const fixtureTitle = (format) => `Paper Format Fixture ${format.toUpperCase()}`
export const fixtureSentence = (format) =>
  `This fixture is ${format.toUpperCase()} and its watchword is ${WATCHWORDS[format]}.`

/* ---- PNG, by hand ------------------------------------------------------- */

/**
 * One PNG chunk: length, type, payload, CRC over type+payload.
 *
 * `zlib.crc32` rather than a hand-rolled table — Node has had it since 20.15 and
 * a second CRC implementation in this tree is a second thing to get wrong.
 */
function chunk(type, payload) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(payload.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body) >>> 0, 0)
  return Buffer.concat([head, body, tail])
}

/**
 * A solid-colour 8-bit RGB PNG, `size` square.
 *
 * DETERMINISTIC: same inputs, same bytes, so a fixture regenerated on another
 * machine hashes the same and a digest can be asserted later if this ever needs
 * one. That rules out anything drawing text or a timestamp into the image.
 */
export function solidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 /* bit depth */
  ihdr[9] = 2 /* colour type: truecolour */
  /* 10, 11, 12 stay zero: deflate, adaptive filtering, no interlace. */

  /* One filter byte per scanline, then the pixels. Filter 0 — none — because a
     solid colour gains nothing from prediction and `None` is the one filter
     every decoder implements without qualification. */
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => Buffer.from([r, g, b])))])
  const raw = Buffer.concat(Array.from({ length: size }, () => row))

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---- the books ---------------------------------------------------------- */

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * A minimal EPUB 3, as bytes.
 *
 * ⚠️ **`mimetype` MUST BE THE FIRST MEMBER AND MUST BE STORED**, which is why
 * this uses `writeZip` — it is STORE-only throughout, so the rule is satisfied
 * for free rather than by remembering it. A deflated `mimetype` is the classic
 * "EPUB that every reader but one accepts".
 *
 * `dc:identifier` is a per-format URN so the five books are five WORKS. Sharing
 * one would make them one work to `claimFor`, and a circle or import fixture
 * built on these later would silently conflate them.
 */
export function epubBytes(format) {
  const title = fixtureTitle(format)
  const sentence = fixtureSentence(format)
  const id = `urn:paper:fixture:${format}`
  return writeZip([
    ['mimetype', 'application/epub+zip'],
    [
      'META-INF/container.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    ],
    [
      'OEBPS/content.opf',
      `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${xml(id)}</dc:identifier>
    <dc:title>${xml(title)}</dc:title>
    <dc:creator>${xml(FIXTURE_AUTHOR)}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-09-05T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`,
    ],
    [
      'OEBPS/nav.xhtml',
      `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
  <head><title>Contents</title></head>
  <body><nav epub:type="toc"><h1>Contents</h1><ol>
    <li><a href="ch1.xhtml">The First Chapter</a></li>
    <li><a href="ch2.xhtml">The Second Chapter</a></li>
  </ol></nav></body>
</html>`,
    ],
    [
      'OEBPS/ch1.xhtml',
      `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
  <head><title>The First Chapter</title></head>
  <body><h1>The First Chapter</h1><p>${xml(sentence)}</p></body>
</html>`,
    ],
    [
      'OEBPS/ch2.xhtml',
      `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
  <head><title>The Second Chapter</title></head>
  <body><h1>The Second Chapter</h1><p>A second section, so a one-section reader cannot pass by accident.</p></body>
</html>`,
    ],
  ])
}

/**
 * A minimal FictionBook 2, as bytes.
 *
 * One file, no zip. `<body>` holds two `<section>`s for the same reason the
 * EPUB holds two: a reader that finds exactly one section for every book cannot
 * be told from one that parses.
 */
export function fb2Bytes(format) {
  const title = fixtureTitle(format)
  const sentence = fixtureSentence(format)
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info>
      <genre>sf</genre>
      <author><first-name>${xml(AUTHOR_FIRST)}</first-name><last-name>${xml(AUTHOR_LAST)}</last-name></author>
      <book-title>${xml(title)}</book-title>
      <lang>en</lang>
    </title-info>
    <document-info>
      <author><nickname>paper</nickname></author>
      <date value="2026-09-05">2026-09-05</date>
      <id>urn:paper:fixture:${format}</id>
      <version>1.0</version>
    </document-info>
  </description>
  <body>
    <section><title><p>The First Chapter</p></title><p>${xml(sentence)}</p></section>
    <section><title><p>The Second Chapter</p></title><p>A second section, so a one-section reader cannot pass by accident.</p></section>
  </body>
</FictionBook>`,
    'utf8',
  )
}

/** A comic book: `CBZ_PAGES` PNGs, named so their sort order is their page order. */
export function cbzBytes() {
  const colours = [
    [220, 60, 60],
    [60, 180, 90],
    [70, 110, 220],
  ]
  return writeZip(
    Array.from({ length: CBZ_PAGES }, (_, i) => [
      `page-${String(i + 1).padStart(3, '0')}.png`,
      solidPng(CBZ_SIZE, colours[i % colours.length]),
    ]),
  )
}

/* ---- conversion --------------------------------------------------------- */

/**
 * Convert an EPUB to `format` with Calibre, through a temporary directory.
 *
 * ⚠️ **THE OUTPUT IS CHECKED FOR EXISTENCE AND SIZE, not for a zero exit.**
 * `ebook-convert` is better behaved than `actool`, but the rule this repository
 * learned three times over is not about any one tool: the artefact is the
 * evidence, and the exit code is a hint.
 */
function convert(sourceBytes, format) {
  const dir = mkdtempSync(join(tmpdir(), 'paper-fixture-'))
  try {
    const from = join(dir, 'source.epub')
    const to = join(dir, `out.${format}`)
    writeFileSync(from, sourceBytes)
    execFileSync('ebook-convert', [from, to], { stdio: 'pipe' })
    const bytes = readFileSync(to)
    if (bytes.length === 0) throw new Error(`ebook-convert wrote an empty ${format}`)
    return bytes
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * `'present'`, `'missing'`, or the reason it would not run.
 *
 * ⚠️ **A BLANKET CATCH TOLD EVERY FAILURE THE SAME LIE.** This returned a
 * boolean, so an `EACCES` on the binary, or a Calibre installed and broken,
 * printed "not on the PATH" and advised a `brew install` that would not help.
 * `ENOENT` is the only error that means absent; everything else is reported as
 * itself.
 */
function calibreState() {
  try {
    execFileSync('ebook-convert', ['--version'], { stdio: 'pipe' })
    return 'present'
  } catch (cause) {
    if (cause && cause.code === 'ENOENT') return 'missing'
    return cause && cause.message ? cause.message : String(cause)
  }
}

/* ---- the run ------------------------------------------------------------ */

/**
 * The complete set, as (name, builder) pairs.
 *
 * ⚠️ **ONE LIST, NOT TWO.** This was a list of names beside six hand-written
 * `write(...)` calls, and a completeness check that reconciled the two — both
 * written by this same file, so the check could only ever catch a typo in
 * itself. The builders are here, so "what a complete set is" and "how it is
 * made" cannot disagree.
 *
 * ⚠️ **CBZ HAS NO WATCHWORD**, which is why the builders are not uniform: a
 * comic is a zip of images and carries no title, author or text at all.
 */
export const FIXTURES = Object.freeze([
  { name: 'fixture.epub', build: () => epubBytes('epub') },
  { name: 'fixture.fb2', build: () => fb2Bytes('fb2') },
  /* FBZ is a zipped FB2 — its OWN watchword, so a loader that fell through to
     the plain FB2 fails rather than passing. The member name matters: the
     loader finds the FictionBook by extension inside the archive. */
  { name: 'fixture.fbz', build: () => writeZip([['fixture.fb2', fb2Bytes('fbz')]]) },
  { name: 'fixture.cbz', build: () => cbzBytes() },
  { name: 'fixture.mobi', build: () => convert(epubBytes('mobi'), 'mobi') },
  { name: 'fixture.azw3', build: () => convert(epubBytes('azw3'), 'azw3') },
])

export const fixturePath = (name) => join(FIXTURE_DIR, name)

function main() {
  const calibre = calibreState()
  if (calibre !== 'present') {
    console.error(
      calibre === 'missing'
        ? 'ebook-convert is not on the PATH, and MOBI and AZW3 cannot be built without it.\n' +
            '  brew install --cask calibre'
        : `ebook-convert is on the PATH but would not run: ${calibre}`,
    )
    console.error(
      'Refusing to write a partial fixture set: a generator that quietly produces four of\n' +
        'six is how a format test goes green having tested nothing.',
    )
    return 1
  }

  /* ⚠️ **BUILD EVERY FIXTURE BEFORE WRITING ANY OF THEM.** The first version
   * wrote the four hand-built formats and only then shelled out to Calibre, so
   * a conversion that failed on the fifth left four NEW fixtures beside two
   * STALE committed binaries — a set that is internally inconsistent and looks
   * complete. That is precisely the failure this script's header says it exists
   * to prevent, committed on the write path while the header watched the PATH.
   *
   * Everything is a Buffer in memory first; disk is touched only once the whole
   * set exists. */
  const built = []
  for (const one of FIXTURES) {
    const bytes = one.build()
    if (!bytes || bytes.length === 0) {
      console.error(`refusing to write: ${one.name} built empty`)
      return 1
    }
    built.push([one.name, bytes])
  }

  mkdirSync(FIXTURE_DIR, { recursive: true })
  const written = []
  for (const [name, bytes] of built) {
    writeFileSync(fixturePath(name), bytes)
    written.push([name, bytes.length])
  }

  for (const [name, size] of written) console.log(`  ${name.padEnd(14)} ${String(size).padStart(8)} bytes`)
  console.log(`written: ${written.length} fixtures in tests/fixtures/ — commit them`)
  return 0
}

/* Run only as a script, so importing this module writes nothing — the same
   shape `check-browser-safe.mjs` uses.

   ⚠️ **NOTHING IMPORTS IT TODAY, and the exports are deliberate anyway.** An
   earlier draft had `formats.corpus.test.ts` import these builders; that was
   wrong twice over — a test under `src/kernel/` importing a build script is an
   edge pointing the wrong way, and `tsc` cannot type an untyped `.mjs` across
   it. The test reads the committed fixtures and states its own expectations, so
   a regenerated fixture that changed them fails instead of agreeing with
   itself. The exports remain because they are the seam a future check would
   use to rebuild and compare. */
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main())
