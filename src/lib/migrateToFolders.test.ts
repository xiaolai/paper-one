import { describe, expect, it } from 'vitest'
import type { VaultFs } from './bookVault'
import {
  contentPathIn,
  folderOf,
  readBook,
  readMarks,
  writeBook,
  writeMarks,
} from './bookFolder'
import {
  marksByBook,
  migrateToFolders,
  recordFromRow,
  summariseMigration,
} from './migrateToFolders'

/**
 * The one piece that runs once, against data that exists once, and whose failure
 * mode is a reader's own writing.
 *
 * So the cases here are mostly about the properties rather than the happy path:
 * that a second run changes nothing, that the old layout survives, that one bad
 * book costs one book, and that a crash midway leaves something resumable.
 */

function fakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>()
  for (const [k, v] of Object.entries(seed)) files.set(k, new TextEncoder().encode(v))
  const fs: VaultFs & { files: Map<string, Uint8Array>; failWrite?: string } = {
    files,
    readFile: async (path) => {
      const bytes = files.get(path)
      if (!bytes) throw new Error(`no such file: ${path}`)
      return bytes
    },
    writeFile: async (path, bytes) => {
      if (fs.failWrite && path.startsWith(fs.failWrite)) throw new Error('disk full')
      files.set(path, bytes)
    },
    exists: async (path) => files.has(path),
    mkdir: async () => {},
    remove: async (path) => void files.delete(path),
    removeDir: async (path) => {
      for (const key of [...files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) files.delete(key)
      }
    },
    rename: async (from, to) => {
      const bytes = files.get(from)
      if (bytes) files.set(to, bytes)
      files.delete(from)
    },
  }
  return fs
}

const row = (over: Record<string, unknown> = {}) => ({
  bookId: 'book_a',
  title: 'Moby-Dick',
  author: 'Herman Melville',
  lastOpened: 1700000000000,
  position: 'epubcfi(/6/14)',
  progress: 0.42,
  tags: ['Sea'],
  vault: 'books/book_a.epub',
  cover: 'covers/book_a.jpg',
  path: '/Users/someone/Downloads/moby.epub',
  ...over,
})

const legacy = {
  'books/book_a.epub': 'WHALE',
  'covers/book_a.jpg': 'JACKET',
}

describe('recordFromRow', () => {
  it('carries the reader work across', () => {
    expect(recordFromRow(row())).toMatchObject({
      title: 'Moby-Dick',
      position: 'epubcfi(/6/14)',
      progress: 0.42,
      tags: ['Sea'],
    })
  })

  /**
   * The old shape had ONE timestamp and the new one has two.
   *
   * Using it for both is the only honest answer: "when was this added" was never
   * recorded, and inventing a date would put migrated books in an order nobody
   * chose.
   */
  it('uses the one timestamp for both, rather than inventing one', () => {
    const record = recordFromRow(row())
    expect(record.openedAt).toBe(1700000000000)
    expect(record.addedAt).toBe(1700000000000)
  })

  it('keeps the reader original path as provenance', () => {
    expect(recordFromRow(row()).origin).toBe('/Users/someone/Downloads/moby.epub')
  })

  it('takes the extension from the old vault filename', () => {
    expect(recordFromRow(row({ vault: 'books/book_a.PDF' })).ext).toBe('pdf')
  })

  it('survives a row with almost nothing on it', () => {
    expect(recordFromRow({ bookId: 'x' })).toEqual({ title: '', author: '' })
  })

  it('clamps a nonsensical progress rather than carrying it', () => {
    expect(recordFromRow(row({ progress: 4 })).progress).toBe(1)
  })
})

describe('marksByBook', () => {
  it('groups the shared store by book', () => {
    const grouped = marksByBook([
      { id: '1', bookId: 'a' },
      { id: '2', bookId: 'b' },
      { id: '3', bookId: 'a' },
    ])
    expect(grouped.get('a')).toHaveLength(2)
    expect(grouped.get('b')).toHaveLength(1)
  })

  /* A mark with no book cannot be filed, and guessing would put somebody's note
   * in a book they did not write it in. */
  it('drops a mark with no book id', () => {
    expect(marksByBook([{ id: '1' }, { id: '2', bookId: '' }]).size).toBe(0)
  })

  it('survives nonsense', () => {
    expect(marksByBook(null).size).toBe(0)
    expect(marksByBook('not marks').size).toBe(0)
  })
})

describe('migrateToFolders', () => {
  const marks = [
    { id: 'm1', bookId: 'book_a', cfi: 'x' },
    { id: 'm2', bookId: 'other', cfi: 'y' },
  ]

  it('moves a book into its folder with everything it owned', async () => {
    const fs = fakeFs(legacy)
    const out = await migrateToFolders(fs, { rows: [row()], marks })
    expect(out).toEqual([{ bookId: 'book_a', status: 'migrated', marks: 1 }])

    const record = await readBook(fs, 'book_a')
    expect(record).toMatchObject({ title: 'Moby-Dick', tags: ['Sea'], progress: 0.42 })
    expect(fs.files.has(contentPathIn('book_a', 'book.epub'))).toBe(true)
    expect(fs.files.has(`${folderOf('book_a')}/cover.webp`)).toBe(true)
    expect(await readMarks(fs, 'book_a')).toHaveLength(1)
  })

  /* Only this book's marks. The shared store held every book's, and filing
   * somebody else's notes into this book would be worse than losing them. */
  it('files only the marks belonging to that book', async () => {
    const fs = fakeFs(legacy)
    await migrateToFolders(fs, { rows: [row()], marks })
    const mine = (await readMarks(fs, 'book_a')) as { id: string }[]
    expect(mine.map((m) => m.id)).toEqual(['m1'])
  })

  /**
   * ADDITIVE. The old layout is read and never deleted, so a migration that
   * turns out to be wrong can be walked back.
   */
  it('leaves the phase-3 files exactly where they were', async () => {
    const fs = fakeFs(legacy)
    await migrateToFolders(fs, { rows: [row()], marks })
    expect(fs.files.has('books/book_a.epub')).toBe(true)
    expect(fs.files.has('covers/book_a.jpg')).toBe(true)
  })

  /**
   * IDEMPOTENT — and this is the case that matters most, because a reader may
   * relaunch after a crash midway. A book whose record exists is finished, and
   * rewriting it would overwrite whatever they have done since.
   */
  it('changes nothing on a second run', async () => {
    const fs = fakeFs(legacy)
    await migrateToFolders(fs, { rows: [row()], marks })
    // The reader tags it after migrating.
    const record = await readBook(fs, 'book_a')
    await writeBook(fs, 'book_a', { ...record!, tags: ['Sea', 'Mine'] })

    const again = await migrateToFolders(fs, { rows: [row()], marks })
    expect(again).toEqual([{ bookId: 'book_a', status: 'already' }])
    expect((await readBook(fs, 'book_a'))?.tags).toEqual(['Sea', 'Mine'])
  })

  /* PER BOOK. One unreadable book costs that book and is named, or the reader
   * is left with neither layout complete and nothing saying why. */
  it('names the book that failed and keeps going', async () => {
    const fs = fakeFs(legacy)
    fs.failWrite = folderOf('book_b')
    const out = await migrateToFolders(fs, {
      rows: [row(), row({ bookId: 'book_b', vault: null, cover: null })],
      marks,
    })
    expect(out[0]?.status).toBe('migrated')
    expect(out[1]).toMatchObject({ bookId: 'book_b', status: 'failed' })
    expect(out[1]?.reason).toBeTruthy()
  })

  /**
   * A row naming a copy that is not there.
   *
   * Phase 3 had bugs that produced exactly this — an orphaned row, a stale
   * cover — so a missing source is a book without its bytes rather than a failed
   * migration. Its record and its marks still arrive.
   */
  it('migrates a book whose content has gone missing', async () => {
    const fs = fakeFs({})
    const out = await migrateToFolders(fs, { rows: [row()], marks })
    expect(out[0]?.status).toBe('migrated')
    expect(await readBook(fs, 'book_a')).toMatchObject({ title: 'Moby-Dick' })
    expect(fs.files.has(contentPathIn('book_a', 'book.epub'))).toBe(false)
  })

  it('ignores a row with no book id', async () => {
    expect(await migrateToFolders(fakeFs(), { rows: [{ title: 'x' }], marks: [] })).toEqual([])
  })
})

describe('summariseMigration', () => {
  it('says what happened', () => {
    expect(
      summariseMigration([
        { bookId: 'a', status: 'migrated', marks: 3 },
        { bookId: 'b', status: 'failed' },
      ]),
    ).toBe('1 book moved, 3 notes kept, 1 could not be moved')
  })

  /* Nothing to say when nothing moved — a reader with no phase-3 library should
   * not be told about a migration they did not have. */
  it('says nothing when there was nothing to do', () => {
    expect(summariseMigration([])).toBeNull()
    expect(summariseMigration([{ bookId: 'a', status: 'already' }])).toBeNull()
  })
})


/**
 * A row Paper has no bytes for, and no way back to them.
 *
 * Phase 3 only began keeping its own copies near the end, so most rows in a real
 * library have no `vault` — and phase 4 dropped the `url` that used to open
 * those. Writing a record anyway put books on the shelf that could never open,
 * and marked them `already` so the migration would never revisit them.
 */
describe('a row with nothing behind it', () => {
  it('is left in the previous library rather than shelved', async () => {
    const fs = fakeFs({})
    const out = await migrateToFolders(fs, {
      rows: [row({ vault: null, cover: null, path: null })],
      marks: [],
    })
    expect(out[0]?.status).toBe('skipped')
    expect(out[0]?.reason).toContain('no stored copy')
    expect(fs.files.size).toBe(0)
  })

  /* Skipped rather than failed, so a later run can pick it up — and so the
   * reader is not told something broke when nothing did. */
  it('is retried on a later run', async () => {
    const fs = fakeFs({})
    const rows = [row({ vault: null, cover: null, path: null })]
    await migrateToFolders(fs, { rows, marks: [] })
    const again = await migrateToFolders(fs, { rows, marks: [] })
    expect(again[0]?.status).toBe('skipped')
  })

  /* `origin` is a way back, so this one still migrates. */
  it('migrates a row that still knows where its file was', async () => {
    const fs = fakeFs({})
    const out = await migrateToFolders(fs, { rows: [row({ vault: null, cover: null })], marks: [] })
    expect(out[0]?.status).toBe('migrated')
    expect((await readBook(fs, 'book_a'))?.origin).toBeTruthy()
  })

  it('says so in the summary, without calling it a failure', () => {
    expect(
      summariseMigration([
        { bookId: 'a', status: 'migrated' },
        { bookId: 'b', status: 'skipped' },
      ]),
    ).toBe('1 book moved, 1 had no stored copy')
  })
})

describe('the record knows its own id', () => {
  /* `safeId` is not reversible — `book:abc` lives in `book_abc` — so a rescan
   * that read the id off the directory renamed every book, and marks are keyed
   * by it. */
  it('stores the canonical id, not the sanitised folder name', async () => {
    const fs = fakeFs(legacy)
    await migrateToFolders(fs, { rows: [row({ bookId: 'book:abc' })], marks: [] })
    expect((await readBook(fs, 'book:abc'))?.bookId).toBe('book:abc')
  })
})

/**
 * Repairing what the FIRST version of this migration wrote.
 *
 * It wrote a record for a row it had no bytes for, and the idempotence check
 * then reported that record `already` on every later run — so the one state
 * needing repair was the one state guaranteed never to be looked at again. A
 * record is finished when it has content or a path back to it, not merely when
 * it is present.
 */
describe('a record left behind by the broken first run', () => {
  const stranded = async () => {
    const fs = fakeFs({})
    await writeBook(fs, 'book_a', { title: 'Moby-Dick', author: 'Herman Melville' })
    return fs
  }

  it('is retried rather than reported already done', async () => {
    const fs = await stranded()
    const out = await migrateToFolders(fs, { rows: [row({ vault: null, path: null })], marks: [] })
    expect(out[0]?.status).toBe('skipped')
  })

  it('is repaired once the bytes are findable again', async () => {
    const fs = await stranded()
    fs.files.set('books/book_a.epub', new TextEncoder().encode('WHALE'))
    const out = await migrateToFolders(fs, { rows: [row()], marks: [] })
    expect(out[0]?.status).toBe('migrated')
    expect(fs.files.has(contentPathIn('book_a', 'book.epub'))).toBe(true)
  })

  /* And the repair must not undo the reader. Anything they did to the stranded
   * record — a tag, a rename — outlives the retry. */
  it('keeps what the reader wrote on the stranded record', async () => {
    const fs = await stranded()
    await writeBook(fs, 'book_a', {
      title: 'Moby-Dick; or, The Whale',
      author: 'Herman Melville',
      tags: ['Mine'],
    })
    fs.files.set('books/book_a.epub', new TextEncoder().encode('WHALE'))
    await migrateToFolders(fs, { rows: [row()], marks: [] })
    const record = await readBook(fs, 'book_a')
    expect(record?.tags).toEqual(['Mine'])
    expect(record?.title).toBe('Moby-Dick; or, The Whale')
  })

  /* A COMPLETE record is still left alone, which is what idempotence means. */
  it('leaves a finished record untouched', async () => {
    const fs = fakeFs(legacy)
    await migrateToFolders(fs, { rows: [row()], marks: [] })
    await writeBook(fs, 'book_a', {
      title: 'Renamed by the reader',
      author: 'M',
      ext: 'epub',
    })
    const again = await migrateToFolders(fs, { rows: [row()], marks: [] })
    expect(again[0]?.status).toBe('already')
    expect((await readBook(fs, 'book_a'))?.title).toBe('Renamed by the reader')
  })
})

/**
 * A retry must not replace marks the reader has made since the first attempt.
 *
 * The phase-3 store is the source only for a book that has none of its own. A
 * record retried because it had no bytes reaches the marks step a second time,
 * and rewriting `marks.json` from the old shared store there discards every
 * highlight made in between.
 */
describe('marks on a retried book', () => {
  it('leaves an existing marks file alone', async () => {
    /* A record stranded by the broken first run, WITH marks the reader has made
     * since — and the bytes now findable, so this run actually migrates it. A
     * row that is still unrecoverable would be skipped before the marks step,
     * which is what made the first version of this test prove nothing. */
    const fs = fakeFs(legacy)
    await writeBook(fs, 'book_a', { title: 'Moby-Dick', author: 'M' })
    await writeMarks(fs, 'book_a', [{ id: 'mine', bookId: 'book_a', cfi: 'later' }])
    const out = await migrateToFolders(fs, {
      rows: [row()],
      marks: [{ id: 'm1', bookId: 'book_a', cfi: 'x' }],
    })
    expect(out[0]?.status).toBe('migrated')
    const kept = (await readMarks(fs, 'book_a')) as { id: string }[]
    expect(kept.map((m) => m.id)).toEqual(['mine'])
  })

  it('still files them for a book that has none', async () => {
    const fs = fakeFs(legacy)
    await migrateToFolders(fs, {
      rows: [row()],
      marks: [{ id: 'm1', bookId: 'book_a', cfi: 'x' }],
    })
    expect(await readMarks(fs, 'book_a')).toHaveLength(1)
  })
})

/* This runs once, so a position lost here is lost for good — and `str` slices
 * at 4000, which turns a long CFI into a string that anchors nowhere. */
describe('a legacy row with a very long position', () => {
  it('carries it across whole', () => {
    const long = `epubcfi(/6/14!/4/2/${'2/'.repeat(2000)}1:0)`
    expect(long.length).toBeGreaterThan(4000)
    expect(recordFromRow(row({ position: long })).position).toBe(long)
  })

  it('drops an absurd one rather than carrying a broken anchor', () => {
    expect(recordFromRow(row({ position: 'x'.repeat(70_000) })).position).toBeUndefined()
  })
})

/**
 * A record that is there but will not read is NOT an absent one.
 *
 * `readBook` answers both with null, and the retry writes the phase-3 row when
 * it gets one — so a momentary read failure on a finished book would replace
 * everything the reader had done since with the state it was migrated from.
 * This runs once, so that is permanent.
 */
describe('a record that cannot be read', () => {
  it('is left untouched and reported, rather than overwritten', async () => {
    const fs = fakeFs(legacy)
    fs.files.set(`${folderOf('book_a')}/book.json`, new TextEncoder().encode('half a write'))
    const out = await migrateToFolders(fs, { rows: [row()], marks: [] })
    expect(out[0]).toMatchObject({ bookId: 'book_a', status: 'failed' })
    expect(new TextDecoder().decode(fs.files.get(`${folderOf('book_a')}/book.json`)!)).toBe(
      'half a write',
    )
  })
})
