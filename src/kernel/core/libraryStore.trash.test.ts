import { describe, expect, it } from 'vitest'
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
