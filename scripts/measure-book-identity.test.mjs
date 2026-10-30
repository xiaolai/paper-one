import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  FULL_HASH_LIMIT as KERNEL_LIMIT,
  INTERIOR_PROBES as KERNEL_PROBES,
  SAMPLE_BYTES as KERNEL_SAMPLE,
  identityParts,
  identityWindows as kernelWindows,
} from '../src/kernel/core/contentIdentity.ts'
import { fold } from '../src/kernel/core/tags.ts'
import {
  FULL_HASH_LIMIT,
  INTERIOR_PROBES,
  SAMPLE_BYTES,
  fileKeyOf,
  fullDigest,
  identityWindows,
  measure,
  nameKey,
  report,
  scanLibrary,
  unsampledBytes,
} from './measure-book-identity.mjs'

/**
 * The analysis, against fixtures — never against the real shelf.
 *
 * `scan-corpus.mjs` states the rule and this obeys it: the script's OUTPUT is a
 * dated reading of a library that changes, so nothing here may assert a number
 * about a library. What is asserted is that the instrument works — and, for
 * this one, that its copy of the kernel's sampling rule has not drifted.
 */

const roots = []
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** A library of book folders, each with a content file and a record. */
function library(books) {
  const root = mkdtempSync(join(tmpdir(), 'paper-identity-'))
  roots.push(root)
  for (const [folder, book] of Object.entries(books)) {
    mkdirSync(join(root, folder), { recursive: true })
    writeFileSync(join(root, folder, 'content.epub'), book.bytes)
    if (book.record !== null) writeFileSync(join(root, folder, 'book.json'), JSON.stringify(book.record))
  }
  return root
}

describe('the sampling rule', () => {
  /**
   * ⚠️ **THE PARITY TESTS THAT WERE HERE ARE GONE, AND THAT IS THE POINT.**
   *
   * This file used to assert, window for window, that the script's own copy of
   * the sampling arithmetic agreed with the kernel's — a test bought to manage a
   * duplication that was defended on the false premise that a `.mjs` cannot
   * import a `.ts`. The script imports `core/contentIdentity.ts` now, so the
   * two cannot disagree and a test that they agree is a test of `===`.
   *
   * A tautology dressed as a guard is worse than no guard: it reports green for
   * a property nothing could break, and it takes up the space where a real
   * check would go. What is left below are the two claims that still have
   * content — that the script reads the SAME function the app does, and that
   * the geometry's two shapes agree with each other.
   */
  it('reads its geometry from the kernel, not from a copy', () => {
    /* The one assertion that would fail if somebody reintroduced a local
       constant: these are the kernel's own objects, by identity of value with
       the module the app hashes through. */
    expect(FULL_HASH_LIMIT).toBe(KERNEL_LIMIT)
    expect(SAMPLE_BYTES).toBe(KERNEL_SAMPLE)
    expect(INTERIOR_PROBES).toBe(KERNEL_PROBES)
    expect(identityWindows).toBe(kernelWindows)
  })

  it('keeps the offsets and the blob slices two shapes of one geometry', () => {
    /* `identityParts` derives its sampled slices FROM `identityWindows`, so
       this checks the derivation rather than a second implementation — which
       is what a future edit could actually break by splitting them again. */
    for (const size of [
      0,
      1,
      SAMPLE_BYTES,
      FULL_HASH_LIMIT - 1,
      FULL_HASH_LIMIT,
      FULL_HASH_LIMIT + 1,
      65 * 1024 * 1024,
      500 * 1024 * 1024,
    ]) {
      const parts = identityParts({ size, slice: (from, to) => [from, to ?? size] })
      /* The size prefix leads, so two files cannot agree by sampling alone. */
      expect(parts[0], `size ${size}`).toBe(`${size}:`)
      if (size <= FULL_HASH_LIMIT) {
        /* The whole blob ITSELF, not a slice of it. */
        expect(parts).toHaveLength(2)
        continue
      }
      expect(parts.slice(1), `size ${size}`).toEqual(identityWindows(size).map(([from, to]) => [from, to]))
    }
  })

  it('counts nothing unsampled below the limit, and something above it', () => {
    expect(unsampledBytes(FULL_HASH_LIMIT)).toBe(0)
    expect(unsampledBytes(65 * 1024 * 1024)).toBeGreaterThan(0)
  })
})

describe('the key', () => {
  it('gives one file one key, and two different files two', () => {
    const root = library({
      a: { bytes: 'the whale', record: { title: 'A', author: 'M' } },
      b: { bytes: 'the whale.', record: { title: 'B', author: 'M' } },
    })
    const { rows } = scanLibrary(root)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.fileKey)).size).toBe(2)
    expect(rows[0].fileKey).toMatch(/^book:[0-9a-f]{32}$/)
  })

  it('is stable across runs over an unchanged file', () => {
    /* The `readSync` short-read trap: hashing the untouched tail of an
       `allocUnsafe` buffer gives a key that changes between runs, which reads
       as a shelf full of collisions that are not there. */
    const root = library({ a: { bytes: 'x'.repeat(200_000), record: { title: 'A', author: '' } } })
    const path = join(root, 'a', 'content.epub')
    expect(fileKeyOf(path)).toBe(fileKeyOf(path))
  })

  it('leads the digest with the size, so two files cannot agree by sampling alone', () => {
    const root = library({
      a: { bytes: 'abc', record: null },
      b: { bytes: 'abcd', record: null },
    })
    const { rows } = scanLibrary(root)
    expect(new Set(rows.map((row) => row.fileKey)).size).toBe(2)
  })
})

describe('the analysis', () => {
  const row = (over) => ({
    folder: 'f',
    size: 1000,
    fileKey: 'book:aaaa',
    /* Distinct per folder by default, so a test that does not care about the
       collision/duplicate split does not accidentally assert one. */
    fullDigestOf: () => `digest-of-${over?.folder ?? 'f'}`,
    title: 'Moby-Dick',
    author: 'Melville',
    identifier: '',
    ...over,
  })

  it('calls two folders with one key and DIFFERENT bytes a collision', () => {
    const totals = measure({
      rows: [
        row({ folder: 'one', fullDigestOf: () => 'aa' }),
        row({ folder: 'two', fullDigestOf: () => 'bb' }),
      ],
    })
    expect(totals.collisions).toEqual([{ key: 'book:aaaa', folders: ['one', 'two'] }])
    expect(totals.duplicateCopies).toEqual([])
  })

  it('says what it verified, and does not claim more', () => {
    /* The report line and the bucket have to agree. Three buckets, three
       lines — a reader must be able to tell a proved collision from a group
       nobody could read. */
    const text = report(
      measure({
        rows: [
          row({ folder: 'one', fullDigestOf: () => 'aa' }),
          row({
            folder: 'two',
            fullDigestOf: () => {
              throw new Error('nope')
            },
          }),
        ],
      }),
      { at: '2026-08-31' },
    )
    expect(text).toContain('UNREADABLE')
    expect(text).toContain('unverified')
    /* And Q2's heading must not promise byte equality it does not measure —
       it compares `file:` keys, which Q1 has just said are sampled. */
    expect(text).toContain('share a file: key')
    expect(text).not.toContain('hold the same bytes')
  })

  it('does NOT call two folders holding the same bytes a collision', () => {
    /* ⚠️ TWO COPIES OF ONE FILE SHOULD SHARE A KEY — that is the function
       working, not failing. Paper's own store cannot produce the case (a
       folder is named `safeId(bookId)`, so a re-import lands in the SAME
       folder), but this script is pointed at a DIRECTORY rather than at a
       running app, and a hand-copied or restored library breaks that
       invariant. Reporting it as a collision would be a fact about the
       measurement dressed as a fact about the shelf. */
    const totals = measure({
      rows: [
        row({ folder: 'one', fullDigestOf: () => 'same' }),
        row({ folder: 'two', fullDigestOf: () => 'same' }),
      ],
    })
    expect(totals.collisions).toEqual([])
    expect(totals.duplicateCopies).toEqual([{ key: 'book:aaaa', folders: ['one', 'two'] }])
  })

  it('reports a group it could not read whole as UNVERIFIED, and never as a duplicate', () => {
    /* THE LOUD SIDE, and reported apart from the verified ones.
     *
     * ⚠️ Fail-closed is only half of it. Folding an unreadable group in with
       the real collisions made the report line — "distinct files sharing one
       key … verified by full digest" — assert a verification that did not
       happen, in the one report whose entire subject is the gap between a key
       and the bytes behind it. A count that overclaims is the defect this
       script exists to measure, wearing the measurement's own clothes. */
    const totals = measure({
      rows: [
        row({ folder: 'one', fullDigestOf: () => 'aa' }),
        row({
          folder: 'two',
          fullDigestOf: () => {
            throw new Error('permission denied')
          },
        }),
      ],
    })
    expect(totals.duplicateCopies, 'never a duplicate — that would be failing open').toEqual([])
    expect(totals.collisions, 'not counted as verified either').toEqual([])
    expect(totals.unverifiedCollisions).toEqual([{ key: 'book:aaaa', folders: ['one', 'two'] }])
  })

  it('reports agreement only for works it actually holds twice', () => {
    /* A shelf with one copy of everything says NOTHING about agreement — and
       must not be read as saying copies agree, which is the bound the report's
       own footer states. */
    const one = measure({ rows: [row({ folder: 'a' })] })
    expect(one.worksWithSeveralCopies).toBe(0)
    expect(one.copiesAgreeingOnFileKey).toBe(0)

    const agreeing = measure({ rows: [row({ folder: 'a' }), row({ folder: 'b' })] })
    expect(agreeing.worksWithSeveralCopies).toBe(1)
    expect(agreeing.copiesAgreeingOnFileKey).toBe(1)

    const differing = measure({
      rows: [row({ folder: 'a' }), row({ folder: 'b', fileKey: 'book:bbbb', size: 1001 })],
    })
    expect(differing.worksWithSeveralCopies).toBe(1)
    expect(differing.copiesAgreeingOnFileKey).toBe(0)
  })

  it('does not make every untitled book one work', () => {
    /* Grouping on an empty name key would put every unreadable record into one
       group and report a work with a hundred copies. */
    const totals = measure({ rows: [row({ folder: 'a', title: '' }), row({ folder: 'b', title: '' })] })
    expect(totals.worksWithSeveralCopies).toBe(0)
  })

  it('folds the title and the author case-insensitively and accent-SENSITIVELY', () => {
    /* ⚠️ **THE SECOND DUPLICATED RULE, and it had no parity test.** The window
       arithmetic above is held to `identityParts`; the name key was not held to
       anything, so this script could group works differently from
       `marksArchive` — and a disagreement there changes the second question's
       answer without changing the first's, which is the hardest kind to
       notice.

       ⚠️ **AND THE FIRST VERSION OF THIS COMMENT DESCRIBED THE BUG, NOT THE
       RULE** — it said `fold` normalises NFKD, strips combining marks, squeezes
       and lowercases. That is what the SCRIPT's lookalike did. The kernel's
       `fold` is NFC → lower → upper → lower → NFC: a case fold and nothing
       else, which leaves accents alone. Writing the wrong rule down beside a
       correct assertion is how the next reader reintroduces it, so the
       assertion below calls the real `fold` and never restates it. */
    for (const [title, author] of [
      ['Moby-Dick', 'Melville'],
      ['  moby-dick  ', 'MELVILLE'],
      /* The pair the lookalike got wrong: an accent-stripping fold makes these
         one work and the kernel's case fold does not. */
      ['Éloge', 'Valéry'],
      ['ELOGE', 'VALERY'],
      ['ÉLOGE', 'VALÉRY'],
      ['a  b', 'c'],
      ['', ''],
    ]) {
      expect(nameKey(title, author), `${title}/${author}`).toBe(JSON.stringify([fold(title), fold(author)]))
    }
    /* And the separator is structural — `nameKey('a b','c')` must not collide
       with `nameKey('a','b c')`. */
    expect(nameKey('a b', 'c')).not.toBe(nameKey('a', 'b c'))
    /* Case-insensitive, accent-SENSITIVE — both halves asserted, because the
       divergence was in the second. */
    expect(nameKey('Éloge', 'Valéry')).toBe(nameKey('ÉLOGE', 'VALÉRY'))
    expect(nameKey('Éloge', 'Valéry')).not.toBe(nameKey('Eloge', 'Valery'))
  })

  it('counts a book above the limit as sampled, and one below as not', () => {
    const totals = measure({
      rows: [row({ folder: 'small', size: 1000 }), row({ folder: 'big', size: 65 * 1024 * 1024, fileKey: 'book:b' })],
    })
    expect(totals.sampled).toBe(1)
    expect(totals.unsampled).toBeGreaterThan(0)
  })

  it('skips a folder that will not read rather than stopping', () => {
    /* A shelf is full of files Paper did not write. A measurement that stops at
       the first unreadable one measures the books before it and calls that the
       shelf. */
    const root = library({ a: { bytes: 'x', record: { title: 'A', author: '' } } })
    mkdirSync(join(root, 'empty'), { recursive: true })
    writeFileSync(join(root, 'loose.txt'), 'not a folder')
    const scanned = scanLibrary(root)
    expect(scanned.rows.map((one) => one.folder)).toEqual(['a'])
  })

  it('keeps a book whose record will not parse, because it still has bytes', () => {
    const root = library({ a: { bytes: 'x', record: null } })
    writeFileSync(join(root, 'a', 'book.json'), '{ not json')
    const { rows } = scanLibrary(root)
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('')
  })
})

describe('the full digest', () => {
  it('reads the whole file, so two files differing anywhere differ here', () => {
    /* The instrument the collision count now rests on. It must see a
       difference the SAMPLED key is allowed to miss — that is its entire
       reason for existing. */
    const root = library({
      a: { bytes: `x${'y'.repeat(5000)}`, record: null },
      b: { bytes: `x${'y'.repeat(4999)}z`, record: null },
    })
    const one = fullDigest(join(root, 'a', 'content.epub'))
    const two = fullDigest(join(root, 'b', 'content.epub'))
    expect(one).not.toBe(two)
    expect(fullDigest(join(root, 'a', 'content.epub'))).toBe(one)
  })

  it('reads a file larger than one read buffer', () => {
    /* The chunk loop: a single `readSync` would digest the first megabyte and
       call it the file. */
    const big = 'q'.repeat(3 * 1024 * 1024 + 17)
    const root = library({ a: { bytes: big, record: null }, b: { bytes: `${big.slice(0, -1)}Z`, record: null } })
    expect(fullDigest(join(root, 'a', 'content.epub'))).not.toBe(fullDigest(join(root, 'b', 'content.epub')))
  })
})

describe('the report', () => {
  it('carries its own date, so it cannot be quoted later as a current fact', () => {
    const text = report(measure({ rows: [] }), { at: '2026-08-31' })
    expect(text).toContain('2026-08-31')
  })

  it('states its bounds beside its numbers', () => {
    /* The bounds are part of the reading. Left for a later reader to
       rediscover, a number about one personal shelf gets quoted as a fact
       about books. */
    const text = report(measure({ rows: [] }), { at: '2026-08-31' })
    expect(text).toContain('BOUNDS')
    expect(text).toContain('neither is a sample of anything')
    expect(text).toContain('one reader')
  })

  it('answers in JSON when asked, with the date in it', () => {
    const parsed = JSON.parse(report(measure({ rows: [] }), { json: true, at: '2026-08-31' }))
    expect(parsed.at).toBe('2026-08-31')
    expect(parsed.books).toBe(0)
  })
})
