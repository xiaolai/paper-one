import { describe, expect, it } from 'vitest'
import type { IndexFs } from '../bookIndex'
import { fakeFs } from '../fakeFs.testkit'
import { createKernelServices } from '../services'
import { bookAdd, bookRestore } from './book'

/**
 * ⚠️ **THE FOLDER CAN CHANGE HANDS BETWEEN THE CHECK AND THE ACT.**
 *
 * `book.add` and `book.restore` both refuse a folder that is already spoken
 * for, and both used to decide it out here: read the shelf snapshot, scan the
 * trash, then call the store. The store's write runs later, on the book's
 * write lane, and `folderOf` is many-to-one — `book:a` and `book_a` are two
 * books and one directory. So a removal could land in exactly the folder a
 * restore was about to empty, and a record could appear in exactly the folder
 * an add was about to write; the store FOLDS and RESTORES rather than
 * refusing, so both callers were told it worked and two logical books ended up
 * sharing one folder.
 *
 * The refusals stay where they are — they name the occupant, and they fold
 * case, which a path derived from an id cannot on a case-sensitive filesystem
 * — but they are the diagnosis. The decision is made inside the lane now, and
 * these are the cases where only the lane can see it.
 */

const RECORD = (bookId: string, title: string) => JSON.stringify({ bookId, title, author: '', addedAt: 1 })

describe('book.add and a folder taken after the scan', () => {
  /* A RECORD ON DISK THE SHELF HAS NOT LOADED. The snapshot is empty and the
     trash is empty, so both of the handler's own checks pass — and the folder
     is occupied all the same. It is the ordinary shape of the race, and it is
     also a real state: an import writes a book's folder before the shelf has
     finished loading. */
  it('refuses rather than folding a second book into the first', async () => {
    const fs = fakeFs({ 'books/book_a/book.json': RECORD('book_a', 'First') })
    const services = createKernelServices({ fs, storage: null, initialBooks: [] })

    await expect(bookAdd({ services })({ book: 'book:a', title: 'Second' })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('its folder was taken'),
    })
    await services.drain()

    /* The record that was there is untouched, and no row was left behind
       claiming the add had happened. */
    expect(JSON.parse(new TextDecoder().decode(fs.store.get('books/book_a/book.json')!))).toMatchObject({
      title: 'First',
    })
    expect(services.library.getSnapshot()).toEqual([])
  })
})

describe('book.restore and a trash that changed hands', () => {
  /**
   * The scan and the write read the SAME folder, so the race needs the scan to
   * answer as it would have a moment earlier: `trash/` listing empty while the
   * folder is there. That is precisely what a removal landing between the two
   * produces, without a timing hook to make it flaky.
   */
  const blindScan = (fs: ReturnType<typeof fakeFs>): IndexFs => ({
    ...fs,
    readDir: async (path) => (path === 'trash' ? [] : fs.readDir(path)),
  })

  it('refuses to bring back somebody else’s book under the caller’s id', async () => {
    const fs = fakeFs({ 'trash/book_a/book.json': RECORD('book_a', 'First') })
    const services = createKernelServices({ fs: blindScan(fs), storage: null, initialBooks: [] })

    await expect(bookRestore({ services })({ book: 'book:a' })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('that folder holds book_a, not book:a'),
    })
    await services.drain()

    expect(fs.store.has('trash/book_a/book.json')).toBe(true)
    expect(fs.store.has('books/book_a/book.json')).toBe(false)
    expect(services.library.getSnapshot()).toEqual([])
  })

  /* AND THE ORDINARY RESTORE STILL GOES THROUGH. This is the check that stops
     the paragraph above from being a way to refuse every restore. */
  it('restores the book the folder actually holds', async () => {
    const fs = fakeFs({ 'trash/book_a/book.json': RECORD('book_a', 'First') })
    const services = createKernelServices({ fs: blindScan(fs), storage: null, initialBooks: [] })

    expect(await bookRestore({ services })({ book: 'book_a' })).toEqual({
      bookId: 'book_a',
      restored: true,
      held: [],
    })
    await services.drain()
    expect(fs.store.has('books/book_a/book.json')).toBe(true)
  })
})
