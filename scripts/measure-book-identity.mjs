#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * `node scripts/measure-book-identity.mjs` — does the `file:` key mean what the
 * key table says it means? (WI-21.4)
 *
 * NOT A GATE. `scan-corpus.mjs` sets the rule this follows: every other script
 * in here answers a question with an exit code; this one answers a question
 * with a REPORT and exits 0 whenever it ran. Its output is a DATED READING of a
 * library that changes, never an acceptance criterion — *"the suite beside it
 * tests the analysis against fixtures and never the real shelf"*, and
 * `measure-book-identity.test.mjs` is that suite.
 *
 * ## The two questions, and why they are not knowable from the code
 *
 * **Does the `file:` key even mean what it says?** It does not above 64 MiB:
 * `contentId` hashes a size prefix, the first and last 64 KiB and sixteen
 * interior probes, so two equal-sized files differing only in a gap produce one
 * id. `marks.test.ts` proves that on synthetic blobs. What no test can say is
 * HOW MANY BOOKS on a real shelf are large enough for it to matter.
 *
 * **Do two copies of one work hold the same bytes?** Phase 21's whole "Stage 1
 * is useful on its own" argument rests on a reader's two downloads of a book
 * being recognisable to each other, and nothing in the code knows. This groups
 * the shelf by work and reports how often the copies agree.
 *
 * ⚠️ **BOTH NUMBERS ARE BOUNDS, AND NEITHER IS TIGHT.** A personal shelf is not
 * a sample of anything, works are grouped by folded title and author (so a
 * differently-titled edition is invisible — see the corpus, where a commercial
 * `Moby-Dick` does not join `Moby-Dick; or, The Whale`), and a shelf with one
 * copy of everything reports nothing at all rather than reporting agreement.
 * The report says so in its own footer rather than leaving it to be
 * rediscovered.
 *
 * ## The sampling is reimplemented here, and held to the kernel's
 *
 * The kernel's `contentId` takes a `Blob`; this reads files by descriptor,
 * because sampling 64 KiB windows out of a 500 MB scan is the entire point of
 * being able to run it over two thousand books. That is a second copy of a rule,
 * and a second copy of a rule drifts — so `measure-book-identity.test.mjs`
 * asserts window for window that it agrees with `identityParts`.
 */

/** Where the app keeps books. Overridable, because a corpus is an argument. */
const DEFAULT_LIB = join(homedir(), 'Library/Application Support/one.paper.reader/books')

/* THE KERNEL'S CONSTANTS, spelled out because this file cannot import a `.ts`
 * module — and held to them by the parity test rather than by hope. See
 * `marks.ts`: `FULL_HASH_LIMIT`, `SAMPLE_BYTES`, `INTERIOR_PROBES`. */
export const FULL_HASH_LIMIT = 64 * 1024 * 1024
export const SAMPLE_BYTES = 64 * 1024
export const INTERIOR_PROBES = 16

/**
 * The byte ranges identity is computed over, as `[start, end)` pairs.
 *
 * The same arithmetic `identityParts` performs, in offsets rather than in
 * `Blob.slice` calls, so it can be compared with the kernel's answer directly.
 */
export function identityWindows(size) {
  if (size <= FULL_HASH_LIMIT) return [[0, size]]
  const windows = [[0, Math.min(SAMPLE_BYTES, size)]]
  for (let i = 1; i <= INTERIOR_PROBES; i++) {
    const at = Math.floor((size * i) / (INTERIOR_PROBES + 1))
    windows.push([at, Math.min(at + SAMPLE_BYTES, size)])
  }
  windows.push([Math.max(0, size - SAMPLE_BYTES), size])
  return windows
}

/** How much of a file identity does NOT look at. Zero below the limit. */
export function unsampledBytes(size) {
  const seen = identityWindows(size).reduce((sum, [from, to]) => sum + (to - from), 0)
  return Math.max(0, size - seen)
}

/**
 * The `file:` key for one file on disk — `contentId`'s answer, computed by
 * reading only what it hashes.
 *
 * The size leads the digest, exactly as the kernel does it, so two files cannot
 * agree by sampling alone.
 */
export function fileKeyOf(path, size = statSync(path).size) {
  const hash = createHash('sha256')
  hash.update(`${size}:`)
  const fd = openSync(path, 'r')
  try {
    for (const [from, to] of identityWindows(size)) {
      const want = to - from
      if (want <= 0) continue
      const buffer = Buffer.allocUnsafe(want)
      /* ⚠️ **LOOPED UNTIL THE WINDOW IS FULL, not one call.** `readSync` may
         answer short, and the first version handled that by hashing only what
         came back — which is safe against digesting an uninitialised
         `allocUnsafe` tail, and STILL WRONG: the kernel hashes the whole
         window, so a short read produces a different key for a file nobody
         touched. That is a phantom collision, or a phantom disagreement,
         reported as a finding about the shelf.
         A genuine short read at EOF cannot happen here — every window is
         clamped to `size` by `identityWindows` — so a loop that stops making
         progress means the file changed under us, and hashing a partial window
         then would be inventing a key. */
      let filled = 0
      while (filled < want) {
        const read = readSync(fd, buffer, filled, want - filled, from + filled)
        if (read <= 0) throw new Error(`short read at ${from + filled} of ${path}: the file changed while it was being measured`)
        filled += read
      }
      hash.update(buffer)
    }
  } finally {
    closeSync(fd)
  }
  return `book:${hash.digest('hex').slice(0, 32)}`
}

/**
 * The whole file's digest — what tells a real collision from a duplicate copy.
 *
 * Read in chunks rather than with `readFileSync`, because these are the books
 * big enough to be sampled in the first place and a 500 MB `Buffer` to answer
 * a diagnostic question is not a trade worth making.
 */
export function fullDigest(path) {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      /* `null` position: read SEQUENTIALLY from the file offset, so the loop
         advances. Passing an explicit position would re-read byte 0 for ever. */
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/**
 * The folded form title and author are compared under — `tags.ts`'s `fold`,
 * character for character.
 *
 * ⚠️ **THIS WAS A LOOKALIKE AND IT DIVERGED**, which is the whole reason the
 * parity test beside it now exists. The first version was
 * `NFKD → strip combining marks → trim → squeeze → lowercase`: a plausible
 * "normalise a title" rule that STRIPS ACCENTS, so it folded `Éloge` and
 * `Eloge` into one work where `marksArchive` keeps them apart. The measurement
 * would have reported a work with two copies that the app does not group at
 * all — a wrong answer to the second question with the first one untouched,
 * which is the hardest kind to notice.
 *
 * The kernel's rule is a CASE FOLD and nothing else: NFC before the case
 * mapping (because mapping can change which decompositions apply), then
 * `lower → upper → lower` to catch the pairs a single `toLowerCase` misses, then
 * NFC again because case mapping can denormalise what it produced. No trim and
 * no squeeze — `nameKey` does not trim either.
 */
const fold = (text) => text.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC')

/** How a book is looked up by name. A structured tuple, never a joined string. */
export const nameKey = (title, author) => JSON.stringify([fold(title), fold(author)])

/** The content file inside a book folder, or null when there is none. */
function contentIn(dir) {
  const names = readdirSync(dir)
  const content = names.find((name) => name.startsWith('content.'))
  return content ? join(dir, content) : null
}

/**
 * Every book on the shelf as a row: its key, its size, and what it says it is.
 *
 * A folder that will not read is SKIPPED AND COUNTED, never fatal. A shelf is
 * full of files Paper did not write, and a measurement that stops at the first
 * unreadable one measures the books before it and calls that the shelf.
 */
export function scanLibrary(lib, { limit = Infinity } = {}) {
  const rows = []
  let unreadable = 0
  for (const name of readdirSync(lib).slice(0, limit === Infinity ? undefined : limit)) {
    const dir = join(lib, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      const path = contentIn(dir)
      if (!path) continue
      const size = statSync(path).size
      let record = {}
      try {
        record = JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8'))
      } catch {
        /* A book with no readable record still has bytes and still has a key.
           Its title is unknown, which only costs it a place in a work group. */
      }
      rows.push({
        folder: name,
        size,
        fileKey: fileKeyOf(path, size),
        /* ⚠️ **THE WHOLE FILE, computed ONLY for the books that share a key** —
           see `measure`. Without it "two folders, one key" cannot be told from
           "two folders holding the same bytes", and the second is not a
           collision at all. Deferred rather than computed here because hashing
           1 959 books whole is minutes of I/O to answer a question about the
           handful that collide. */
        fullDigestOf: () => fullDigest(path),
        title: typeof record.title === 'string' ? record.title : '',
        author: typeof record.author === 'string' ? record.author : '',
        identifier: typeof record.identifier === 'string' ? record.identifier : '',
      })
    } catch {
      unreadable += 1
    }
  }
  return { rows, unreadable }
}

/**
 * What the shelf says about the `file:` key.
 *
 * PURE over rows, so the whole analysis is testable against fixtures and never
 * against a real library — which is the rule `scan-corpus.mjs` states and the
 * only thing that makes a number here re-derivable.
 */
export function measure({ rows, unreadable = 0 }) {
  const sampled = rows.filter((row) => row.size > FULL_HASH_LIMIT)

  /* COLLISIONS: two DIFFERENT folders answering to one key. */
  const byKey = new Map()
  for (const row of rows) byKey.set(row.fileKey, [...(byKey.get(row.fileKey) ?? []), row])
  const repeated = [...byKey.values()].filter((group) => group.length > 1)
  /* ⚠️ **A REPEATED KEY IS NOT YET A COLLISION.** Two folders holding the SAME
   * BYTES should share a key — that is the function working. Only two folders
   * holding DIFFERENT bytes is a collision, and the full digests are what tell
   * the two apart; they are computed only for these few, because hashing 1 959
   * books whole to answer a question about a handful is minutes of I/O.
   *
   * Paper's own store cannot produce the duplicate case — a folder is named
   * `safeId(bookId)`, so a second import of the same bytes lands in the SAME
   * folder — but this script is pointed at a DIRECTORY, not at a running app,
   * and a hand-copied, migrated or restored library breaks that invariant
   * without anybody noticing. Asserting an invariant the scanner cannot see is
   * how a measurement reports a fact about the shelf that is really a fact
   * about the measurement.
   *
   * THREE BUCKETS, NOT TWO. A group whose digest would not read is a collision
   * CANDIDATE and is counted with the collisions — fail closed, because "could
   * not prove these are the same file" must never quietly become "they are the
   * same file" — but it is reported apart, because the line that carries it
   * says "verified by full digest" and for this group nothing was verified. */
  const collisions = []
  const unverified = []
  const duplicates = []
  for (const group of repeated) {
    const digests = new Set()
    let readable = true
    for (const row of group) {
      try {
        digests.add(row.fullDigestOf ? row.fullDigestOf() : row.folder)
      } catch {
        readable = false
      }
    }
    if (!readable) unverified.push(group)
    else if (digests.size > 1) collisions.push(group)
    else duplicates.push(group)
  }

  /* AGREEMENT: works the shelf holds more than one copy of, and whether the
     copies share a key. `named` groups only rows that HAVE a title — an
     untitled row would otherwise join every other untitled row as one work. */
  const byWork = new Map()
  for (const row of rows) {
    if (!row.title) continue
    const key = nameKey(row.title, row.author)
    byWork.set(key, [...(byWork.get(key) ?? []), row])
  }
  const multi = [...byWork.values()].filter((group) => group.length > 1)
  const agreeing = multi.filter((group) => new Set(group.map((row) => row.fileKey)).size === 1)

  /* ⚠️ A COVERAGE COUNT, NOT AN AGREEMENT RATE — and the distinction is the
     whole honesty of the line. This says how many books CARRY a
     `dc:identifier`; it does not derive work keys, group by them, or measure
     whether identifiers recognise two copies of one work. It is here because a
     coverage of zero makes every question about identifier-based recognition
     unanswerable, and that is worth knowing before the question is asked. */
  const declaring = rows.filter((row) => row.identifier !== '')

  return {
    books: rows.length,
    unreadable,
    sampled: sampled.length,
    /* How much of the shelf identity never looks at, in bytes. Zero on a shelf
       with no oversized book, which is the honest answer for most. */
    unsampled: sampled.reduce((sum, row) => sum + unsampledBytes(row.size), 0),
    collisions: collisions.map((group) => ({ key: group[0].fileKey, folders: group.map((row) => row.folder) })),
    /* Repeated keys that ARE the same bytes. Not a defect — reported so the
       collision count above cannot be read as including them. */
    duplicateCopies: duplicates.map((group) => ({ key: group[0].fileKey, folders: group.map((row) => row.folder) })),
    /* Counted WITH the collisions in any total, reported apart in the line —
       the digest failed, so nothing about this group was verified. */
    unverifiedCollisions: unverified.map((group) => ({ key: group[0].fileKey, folders: group.map((row) => row.folder) })),
    worksWithSeveralCopies: multi.length,
    copiesAgreeingOnFileKey: agreeing.length,
    declaringAnIdentifier: declaring.length,
  }
}

/** The reading, as a page. `at` is stamped by the caller — see `scan-corpus`. */
export function report(totals, { json = false, at } = {}) {
  if (json) return JSON.stringify({ at, ...totals }, null, 2)
  const lines = [
    `measure-book-identity — a dated reading, ${at}`,
    ``,
    `books scanned                       ${totals.books}`,
    `folders that would not read         ${totals.unreadable}`,
    ``,
    `Q1. Does the file: key mean what it says?`,
    `  above the 64 MiB limit            ${totals.sampled}   (identity is SAMPLED for these)`,
    `  bytes identity never looks at     ${totals.unsampled.toLocaleString()}`,
    `  distinct files sharing one key    ${totals.collisions.length}   (verified by full digest)`,
    `  identical copies sharing one key  ${totals.duplicateCopies.length}   (not a collision — the same bytes)`,
    `  ...key shared, digest UNREADABLE  ${totals.unverifiedCollisions.length}   (counted as a collision, unverified)`,
  ]
  for (const group of totals.collisions) lines.push(`    ${group.key}  ${group.folders.join(', ')}`)
  for (const group of totals.unverifiedCollisions) lines.push(`    ${group.key}  ${group.folders.join(', ')}  (unverified)`)
  lines.push(
    ``,
    /* ⚠️ NOT "hold the same bytes". This measures `file:`-KEY equality, which
       is exactly what the reader of Q1 has just been told is sampled above
       64 MiB — so the heading claimed a stronger fact than the row beneath it
       computes, in the one report whose whole subject is that gap. */
    `Q2. Do two copies of one work share a file: key?`,
    `  works with more than one copy     ${totals.worksWithSeveralCopies}`,
    `  ...whose copies share a file: key ${totals.copiesAgreeingOnFileKey}`,
    `  books declaring a dc:identifier   ${totals.declaringAnIdentifier}`,
    ``,
    `⚠️ BOUNDS. Neither number is tight and neither is a sample of anything.`,
    `  Works are grouped by folded title and author, so a differently-titled`,
    `  edition of one work is invisible here — the corpus's commercial`,
    `  "Moby-Dick" does not join "Moby-Dick; or, The Whale". A shelf holding`,
    `  one copy of everything reports nothing about agreement rather than`,
    `  reporting that copies agree. And a personal library is one reader's`,
    `  habits, not a population.`,
  )
  return lines.join('\n')
}

/* The CLI. Nothing above this line reads a flag or prints. */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const argv = process.argv.slice(2)
  /* A flag written without a value is an ERROR, never a silent default — see
     `scan-corpus.mjs`, where `--limit` with nothing after it scanned zero books
     and printed a clean report of zero. */
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    if (i < 0) return fallback
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      console.error(`measure-book-identity: --${name} needs a value`)
      process.exit(2)
    }
    return value
  }
  const limitFlag = () => {
    const raw = flag('limit', null)
    if (raw === null) return Infinity
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0) {
      console.error(`measure-book-identity: --limit must be a non-negative integer, not ${JSON.stringify(raw)}`)
      process.exit(2)
    }
    return n
  }
  const lib = flag('lib', process.env.PAPER_LIBRARY ?? DEFAULT_LIB)
  if (!existsSync(lib)) {
    console.error(`measure-book-identity: no library at ${lib} — pass --lib <path> or set PAPER_LIBRARY`)
    process.exit(2)
  }
  console.log(
    report(measure(scanLibrary(lib, { limit: limitFlag() })), {
      json: argv.includes('--json'),
      /* Stamped by the caller, never by the report: a dated reading has to
         carry its date or it will be quoted years later as a current fact. */
      at: flag('at', new Date().toISOString().slice(0, 10)),
    }),
  )
}
