import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { UNREADABLE, matchesPattern, readMatching, writeDeflatedZip, writeZip } from './zip.mjs'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const roots = []
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true })
})

const archive = (bytes) => {
  const root = mkdtempSync(join(tmpdir(), 'paper-zip-'))
  roots.push(root)
  const file = join(root, 'content.epub')
  writeFileSync(file, bytes)
  return file
}

const MEMBERS = [
  ['mimetype', 'application/epub+zip'],
  ['OEBPS/styles/main.css', 'p { font-size: 1rem }'],
  ['OEBPS/text/one.xhtml', '<p>one</p>'],
]

describe('what a pattern matches', () => {
  /* `*` CROSSES A SEPARATOR, which is the whole reason this is not a path
     glob. `unzip -p book.epub '*.css'` finds `OEBPS/styles/main.css`, and
     every pattern this repository passes depends on it. A `*` that stopped at
     `/` would find the stylesheets of flat books only and report every nested
     book as having none — a false finding, not a missing one. */
  it('crosses a directory separator, the way the shell and unzip both do', () => {
    expect(matchesPattern('OEBPS/styles/main.css', '*.css')).toBe(true)
    expect(matchesPattern('main.css', '*.css')).toBe(true)
    expect(matchesPattern('OEBPS/main.xhtml', '*.css')).toBe(false)
  })

  it('does not let a pattern\'s punctuation act as a regular expression', () => {
    /* `.` is a literal here. Unescaped it matches any character, so `*.css`
       would also match `axcss` — and a book with no stylesheet would be
       measured as having one. */
    expect(matchesPattern('axcss', '*.css')).toBe(false)
    expect(matchesPattern('a+b.css', '*.css')).toBe(true)
  })
})

describe('an archive this repository wrote', () => {
  it('round-trips stored members', () => {
    const got = readMatching(archive(writeZip(MEMBERS)), ['*.css'])
    expect(got).not.toBe(UNREADABLE)
    expect(got.map((b) => b.toString())).toEqual(['p { font-size: 1rem }'])
  })

  it('round-trips deflated members, which is what a real book uses', () => {
    /* The writer stores; every EPUB on a shelf deflates. The reader has to do
       both, and only this case exercises the `inflateRaw` path. */
    const got = readMatching(archive(writeDeflatedZip(MEMBERS)), ['*.xhtml'])
    expect(got).not.toBe(UNREADABLE)
    expect(got.map((b) => b.toString())).toEqual(['<p>one</p>'])
  })

  it('answers every matching member, in archive order', () => {
    const got = readMatching(archive(writeZip(MEMBERS)), ['*.css', '*.xhtml'])
    expect(got.map((b) => b.toString())).toEqual(['p { font-size: 1rem }', '<p>one</p>'])
  })
})

/**
 * THE THREE OUTCOMES, WHICH ARE THE POINT OF THE MODULE.
 *
 * `scan-corpus.mjs` reports "a book whose whole typography is Paper's sheet"
 * as a headline finding, and a corrupt archive counted as the same thing is a
 * silence dressed as a measurement. Nothing else here keeps them apart.
 */
describe('nothing matched is not the same as could not be read', () => {
  it('answers an empty list when the archive is fine and holds no match', () => {
    const got = readMatching(archive(writeZip(MEMBERS)), ['*.nosuchthing'])
    expect(got).toEqual([])
  })

  it('answers the sentinel for bytes that are not an archive', () => {
    expect(readMatching(archive(Buffer.from('this is not a zip at all')), ['*.css'])).toBe(UNREADABLE)
  })

  it('answers the sentinel for a file that is not there, rather than throwing', () => {
    expect(readMatching(join(tmpdir(), 'paper-zip-absent', 'nope.epub'), ['*.css'])).toBe(UNREADABLE)
  })

  it('answers the sentinel for a path that exists and cannot be read', () => {
    /* A directory, which `existsSync` is happy with and `readFileSync` is
       not. The existence check alone would have let this throw out of a scan
       that must survive one bad book among two thousand. */
    const root = mkdtempSync(join(tmpdir(), 'paper-zip-'))
    roots.push(root)
    expect(readMatching(root, ['*.css'])).toBe(UNREADABLE)
  })
})

/**
 * EVERY REFUSAL, EXERCISED — the paths that decide between a wrong number and
 * an honest one.
 *
 * Each case below is a way a real archive can be malformed or beyond what this
 * reader implements. The wrong behaviour in all of them is the same and is
 * quiet: parse on regardless, hand back the members that happened to survive,
 * and let a partial book be measured as a whole one. `scan-corpus.mjs` prints
 * those numbers as findings about a library, so a misparse does not announce
 * itself — it just makes the report a little wrong for ever.
 */
describe('what it refuses rather than guesses', () => {
  /** A valid archive with `patch` applied to its bytes. */
  const damaged = (patch, make = writeZip) => {
    const bytes = Buffer.from(make(MEMBERS))
    const eocd = bytes.length - 22
    patch(bytes, eocd, bytes.readUInt32LE(eocd + 16))
    return archive(bytes)
  }

  it('refuses a ZIP64 end record instead of reading its saturated fields', () => {
    /* The 32-bit count and offset saturate and the true values live in a
       record this does not parse. Reading the saturated ones walks into the
       middle of the file and yields members that are not there. */
    expect(readMatching(damaged((b, eocd) => b.writeUInt16LE(0xffff, eocd + 8 + 2)), ['*.css'])).toBe(UNREADABLE)
    expect(readMatching(damaged((b, eocd) => b.writeUInt32LE(0xffffffff, eocd + 16)), ['*.css'])).toBe(UNREADABLE)
  })

  it('refuses a ZIP64 member rather than reading a saturated size or offset', () => {
    for (const at of [20, 24, 42]) {
      expect(readMatching(damaged((b, _eocd, cd) => b.writeUInt32LE(0xffffffff, cd + at)), ['*.css'])).toBe(UNREADABLE)
    }
  })

  it('refuses a central directory that is not one', () => {
    expect(readMatching(damaged((b, _eocd, cd) => b.writeUInt32LE(0xdeadbeef, cd)), ['*.css'])).toBe(UNREADABLE)
  })

  it('refuses a truncated central directory rather than reading off the end', () => {
    const bytes = Buffer.from(writeZip(MEMBERS))
    const eocd = bytes.length - 22
    /* Point the directory just short of the end: the walk runs out of bytes
       before it has read the members the end record promises. */
    bytes.writeUInt32LE(bytes.length - 8, eocd + 16)
    expect(readMatching(archive(bytes), ['*.css'])).toBe(UNREADABLE)
  })

  it('refuses a compression method it does not implement', () => {
    /* Method lives at +10 in the central entry. Anything but STORE or DEFLATE
       — bzip2, LZMA, zstd — is a member this cannot produce bytes for, and
       returning nothing for it would read as "the book has no stylesheet". */
    expect(readMatching(damaged((b, _eocd, cd) => b.writeUInt16LE(9, cd + 10)), ['mimetype'])).toBe(UNREADABLE)
  })

  it('refuses a member whose compressed bytes will not inflate', () => {
    const bytes = Buffer.from(writeDeflatedZip(MEMBERS))
    const eocd = bytes.length - 22
    const cd = bytes.readUInt32LE(eocd + 16)
    /* The first member's data begins after its local header and name. */
    const local = bytes.readUInt32LE(cd + 42)
    const from = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    for (let i = from; i < from + 8 && i < cd; i++) bytes[i] ^= 0xff
    expect(readMatching(archive(bytes), ['mimetype'])).toBe(UNREADABLE)
  })

  it('refuses a local header that does not match the directory', () => {
    const bytes = Buffer.from(writeZip(MEMBERS))
    const eocd = bytes.length - 22
    const cd = bytes.readUInt32LE(eocd + 16)
    bytes.writeUInt32LE(0xdeadbeef, bytes.readUInt32LE(cd + 42))
    expect(readMatching(archive(bytes), ['mimetype'])).toBe(UNREADABLE)
  })
})

describe('the writers take bytes as readily as text', () => {
  /* A caller with a Buffer should not have to decode it to a string first —
     and a book's own bytes are not always valid UTF-8, which is the trap
     `scan-corpus.mjs` records about reading CSS as latin1. */
  it('stores a Buffer member unchanged, through both writers', () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x41])
    for (const make of [writeZip, writeDeflatedZip]) {
      const got = readMatching(archive(make([['a.bin', raw]])), ['*.bin'])
      expect(got).not.toBe(UNREADABLE)
      expect(got[0].equals(raw)).toBe(true)
    }
  })
})

/**
 * AGAINST THE TOOL IT REPLACED, on the book in this repository.
 *
 * This module exists because `unzip` does not ship with Windows, and a
 * replacement for a tool is only worth having if it answers the same. Byte for
 * byte, including the case that cost a silent under-report once: asked for
 * `*.xhtml *.html *.htm`, `unzip` EXITS 11 while writing every matching member
 * to stdout, because 11 means "some pattern matched nothing" rather than "none
 * did".
 *
 * Skipped at RUN time where `unzip` is absent — never with `skipIf`, which
 * does not collect the name, and `tests/ledger.json` is one file for all three
 * platforms.
 */
describe('the reader agrees with unzip', () => {
  const book = path.join(REPO_ROOT, 'public', 'sample.epub')
  const unzipAt = (patterns) => spawnSync('unzip', ['-p', book, ...patterns], { maxBuffer: 64 * 1024 * 1024 })

  it.each([[['*.css']], [['*.opf']], [['*.xhtml', '*.html', '*.htm']], [['*.nosuchthing']]])(
    'answers what `unzip -p %j` writes',
    (patterns, { skip } = {}) => {
      if (spawnSync('unzip', ['-v']).error) return skip?.('unzip is not installed here')
      const theirs = unzipAt(patterns)
      const mine = readMatching(book, patterns)
      expect(mine).not.toBe(UNREADABLE)
      expect(Buffer.concat(mine).equals(theirs.stdout)).toBe(true)
    },
  )

  it('reads a book unzip cannot be asked about the same way, and still agrees on the count', ({ skip }) => {
    if (spawnSync('unzip', ['-v']).error) skip('unzip is not installed here')
    /* The exit-11 trap, named: four members written, failure reported. */
    const theirs = unzipAt(['*.xhtml', '*.html', '*.htm'])
    expect(theirs.status).toBe(11)
    expect(theirs.stdout.length).toBeGreaterThan(0)
    expect(Buffer.concat(readMatching(book, ['*.xhtml', '*.html', '*.htm'])).equals(theirs.stdout)).toBe(true)
  })
})
