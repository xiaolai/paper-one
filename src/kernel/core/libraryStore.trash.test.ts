import { describe, expect, it } from 'vitest'
import type { BookRecord } from './bookFolder'
import type { IndexedBook } from './bookIndex'
import { TRASH_WINDOW_MS } from './bookTrash'
import { fakeFs } from './fakeFs.testkit'
import { createLibrary } from './libraryStore'
import { writeQueue } from './writeQueue'

/**
 * THE BOOT SWEEP, ON THE LANES.
 *
 * `emptyExpired` read a stamp and deleted, off every queue. A restore on the
 * same book — queued on its lane, as every transition of a book is — could
 * land between the two: a partial restore keeps the files it could not move
 * and gives them a fresh fortnight, and the sweep, holding its old decision,
 * deleted exactly those. Codex found the interleaving in a refute round; the
 * purge now runs on the lane and re-reads the stamp there.
 */
const DAY = 24 * 60 * 60 * 1000

function world(files: Record<string, string>) {
  const fs = fakeFs(files)
  const library = createLibrary({ fs, queue: writeQueue(), initial: [] })
  return { fs, library }
}

describe('emptyExpiredTrash', () => {
  it('purges the folders whose stay is over, by name, and leaves the rest', async () => {
    const now = Date.now()
    const { fs, library } = world({
      'trash/book_old/.removed': String(now - TRASH_WINDOW_MS - DAY),
      'trash/book_old/book.json': '{}',
      'trash/book_fresh/.removed': String(now - DAY),
      'trash/book_fresh/book.json': '{}',
      'trash/book_junk/.removed': 'yesterday',
      'trash/book_junk/book.json': '{}',
    })
    expect(await library.emptyExpiredTrash(now)).toEqual(['book_old'])
    expect(await fs.exists('trash/book_old')).toBe(false)
    expect(await fs.exists('trash/book_fresh/book.json')).toBe(true)
    expect(await fs.exists('trash/book_junk/book.json')).toBe(true)
  })
})

describe('purgeTrashed with a stamp to honour', () => {
  const trashed = (now: number) => ({
    /* A live copy of one file, so the restore is PARTIAL: `content.epub`
       collides, stays in the trash, and the trash entry is re-stamped. */
    'books/book_a/content.epub': 'the live one',
    'trash/book_a/content.epub': 'the trashed one',
    'trash/book_a/book.json': JSON.stringify({ bookId: 'book_a', title: 'A', author: '', addedAt: 1 }),
    'trash/book_a/.removed': String(now - TRASH_WINDOW_MS - DAY),
  })

  it('leaves a folder a restore re-stamped ahead of it on the lane', async () => {
    const now = Date.now()
    const { fs, library } = world(trashed(now))
    /* Queued back to back on one lane: the restore runs first and re-stamps;
       the purge, decided "expired" from the OLD stamp, re-reads and leaves. */
    const restoring = library.restore('book_a')
    const purging = library.purgeTrashed('book_a', { unlessStampedAfter: now - TRASH_WINDOW_MS })
    const [outcome, went] = await Promise.all([restoring, purging])
    expect(outcome).toMatchObject({ state: 'partial', held: ['content.epub'] })
    expect(went).toBe(false)
    expect(await fs.exists('trash/book_a/content.epub')).toBe(true)
  })

  it('… which the unconditional purge would have eaten — the defect, kept as the control', async () => {
    const now = Date.now()
    const { fs, library } = world(trashed(now))
    const restoring = library.restore('book_a')
    const purging = library.purgeTrashed('book_a')
    await Promise.all([restoring, purging])
    expect(await fs.exists('trash/book_a/content.epub')).toBe(false)
  })

  it('still purges when the stamp is as old as it was judged', async () => {
    const now = Date.now()
    const { fs, library } = world({
      'trash/book_a/.removed': String(now - TRASH_WINDOW_MS - DAY),
      'trash/book_a/book.json': '{}',
    })
    expect(await library.purgeTrashed('book_a', { unlessStampedAfter: now - TRASH_WINDOW_MS })).toBe(true)
    expect(await fs.exists('trash/book_a')).toBe(false)
  })

  it('leaves a folder whose stamp will not read', async () => {
    const { fs, library } = world({ 'trash/book_a/.removed': '', 'trash/book_a/book.json': '{}' })
    expect(await library.purgeTrashed('book_a', { unlessStampedAfter: Date.now() })).toBe(false)
    expect(await fs.exists('trash/book_a/book.json')).toBe(true)
  })
})

/**
 * ⚠️ **ONE FOLDER, TWO IDS — AND THE DECISION MADE OUTSIDE THE LANE.**
 *
 * `folderOf` sanitises every character outside `[A-Za-z0-9]` to `_`, so
 * `book:a` and `book_a` are two books and one directory. `book.add` and
 * `book.restore` both read the shelf and the trash to refuse a collision, and
 * both then called the store — with the folder free to change hands in
 * between. A removal lands in exactly the folder a restore is about to empty;
 * an aliasing add publishes an optimistic row for the folder this one is about
 * to write. The store folds and restores rather than refusing, so both callers
 * were told it worked.
 *
 * The guards move that decision to where the act is. Every case here is a
 * write already queued on the folder's lane when the guard runs, which is the
 * interleaving a caller's own scan cannot see.
 */
const record = (bookId: string, title = bookId): BookRecord => ({ bookId, title, author: '', addedAt: 1 })
const row = (bookId: string): IndexedBook => ({ bookId, title: bookId, author: '', hasContent: true })

function shelf(files: Record<string, string>, initial: readonly IndexedBook[] = []) {
  const fs = fakeFs(files)
  const library = createLibrary({ fs, queue: writeQueue(), initial })
  return { fs, library }
}

describe('a guarded restore', () => {
  const live = { 'books/book_a/book.json': JSON.stringify(record('book_a')) }

  it('refuses a folder that changed hands after the caller looked', async () => {
    const { fs, library } = shelf(live, [row('book_a')])
    /* The trash is EMPTY as this starts, so a scan out here would say the
       folder is free. The removal is already on the lane. */
    const removing = library.remove('book_a')
    const restoring = library.restore('book:a', { onlyThisBook: true })

    await removing
    expect(await restoring).toEqual({ state: 'mismatch', bookId: 'book_a' })
    /* And nothing moved: the removed book is still in the trash, under its own
       name, rather than back on the shelf wearing the caller's id. */
    expect(await fs.exists('trash/book_a/book.json')).toBe(true)
    expect(await fs.exists('books/book_a/book.json')).toBe(false)
  })

  /* THE DEFECT, KEPT AS THE CONTROL. Unguarded — which is what the app's own
     trash sheet does, restoring by the identity `listTrash` reported — the same
     interleaving brings somebody else's book back relabelled. */
  it('… which the unguarded restore performs, relabelling the book', async () => {
    const { fs, library } = shelf(live, [row('book_a')])
    await Promise.all([library.remove('book_a'), library.restore('book:a')])
    expect(await fs.exists('books/book_a/book.json')).toBe(true)
    expect(library.getSnapshot().map((one) => one.bookId)).toEqual(['book:a'])
  })

  it('restores the book that is actually there', async () => {
    const { fs, library } = shelf({
      'trash/book_a/book.json': JSON.stringify(record('book_a')),
      'trash/book_a/.removed': String(Date.now()),
    })
    expect(await library.restore('book_a', { onlyThisBook: true })).toEqual({ state: 'restored' })
    expect(await fs.exists('books/book_a/book.json')).toBe(true)
  })

  /* AN ENTRY WITH NO READABLE RECORD is addressed by its FOLDER NAME —
     `listTrash`'s rule, so the sheet that lists it and the verb that restores
     it call it the same thing. */
  it('takes the folder name as the identity when there is no record to read', async () => {
    const { fs, library } = shelf({ 'trash/book_a/marks.json': '[]' })
    expect(await library.restore('book:a', { onlyThisBook: true })).toEqual({
      state: 'mismatch',
      bookId: 'book_a',
    })
    expect(await library.restore('book_a', { onlyThisBook: true })).toEqual({ state: 'restored' })
    expect(await fs.exists('books/book_a/marks.json')).toBe(true)
  })

  it('answers absent, not mismatch, when the trash holds nothing at all', async () => {
    const { library } = shelf({})
    expect(await library.restore('book:a', { onlyThisBook: true })).toEqual({ state: 'absent' })
  })
})

describe('an add that must create', () => {
  it('refuses a folder a record already occupies, and puts the row it replaced back', async () => {
    const { fs, library } = shelf(
      { 'books/book_a/book.json': JSON.stringify(record('book_a', 'First')) },
      [row('book_a')],
    )

    expect(await library.add('book:a', record('book:a', 'Second'), false, { fresh: true })).toBe('folder-taken')
    /* THE ROW AS IT WAS. The optimistic list replaced `book_a`'s row with this
       add's, so a retract that only removed the new row left the other book
       wearing the wrong id and title over a record nothing had written. */
    expect(library.getSnapshot().map((one) => one.bookId)).toEqual(['book_a'])
    expect(JSON.parse(new TextDecoder().decode(await fs.readFile('books/book_a/book.json')))).toMatchObject({
      title: 'First',
    })
  })

  it('refuses a folder the trash holds, rather than restoring and relabelling it', async () => {
    const { fs, library } = shelf({
      'trash/book_a/book.json': JSON.stringify(record('book_a', 'First')),
      'trash/book_a/.removed': String(Date.now()),
    })

    expect(await library.add('book:a', record('book:a', 'Second'), false, { fresh: true })).toBe('folder-taken')
    expect(library.getSnapshot()).toEqual([])
    expect(await fs.exists('trash/book_a/book.json')).toBe(true)
    expect(await fs.exists('books/book_a/book.json')).toBe(false)
  })

  /* AND THE SHORTCUT HONOURS IT TOO. A placeholder add over an existing row
     answers before it ever reaches the lane, so a guard not applied there
     would be one that quietly did nothing on one route through its own
     function. */
  it('refuses a placeholder over a row that already holds the folder', async () => {
    const { library } = shelf({ 'books/book_a/book.json': JSON.stringify(record('book_a', 'First')) }, [
      row('book_a'),
    ])
    expect(await library.add('book:a', record('book:a', 'Second'), true, { fresh: true })).toBe('folder-taken')
    expect(library.getSnapshot().map((one) => one.bookId)).toEqual(['book_a'])
  })

  /* THE FOLDER FREED IN THE LANE, which is the window a caller's own scan
     cannot close: the trash entry is there when the add is made and gone by
     the time it runs. */
  it('adds when the folder is free by the time the write runs', async () => {
    const { fs, library } = shelf({
      'trash/book_a/book.json': JSON.stringify(record('book_a')),
      'trash/book_a/.removed': String(Date.now()),
    })
    const purging = library.purgeTrashed('book_a')
    const adding = library.add('book:a', record('book:a', 'Second'), false, { fresh: true })

    expect(await purging).toBe(true)
    expect(await adding).toBe('added')
    expect(await fs.exists('books/book_a/book.json')).toBe(true)
  })
})
