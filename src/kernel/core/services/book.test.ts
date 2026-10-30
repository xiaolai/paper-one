import { describe, expect, it, vi } from 'vitest'
import type { IndexFs } from '../bookIndex'
import { fakeFs } from '../fakeFs.testkit'
import { createKernelServices } from '../services'
import { bookAdd, bookPosition, bookRestore, bookSet } from './book'

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

  /* A FOLDER WHOSE OWNER CANNOT BE ESTABLISHED IS REFUSED TOO, and says which
     of the two folders would not read. Answering "there was nothing to
     restore" over a record that could not be read is the same lie the outcome
     type was widened to stop. */
  it('refuses when the record in the folder it would restore into will not read', async () => {
    const fs = fakeFs({
      'trash/book_a/book.json': RECORD('book_a', 'First'),
      'books/book_a/book.json': 'not json',
    })
    const services = createKernelServices({ fs: blindScan(fs), storage: null, initialBooks: [] })

    await expect(bookRestore({ services })({ book: 'book_a' })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('the record in the shelf folder for book_a could not be read'),
    })
    await services.drain()
    expect(fs.store.has('trash/book_a/book.json')).toBe(true)
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

describe('book.set and the reader’s own opinion — WI-23.B3', () => {
  const shelf = () => {
    const fs = fakeFs({ 'books/book_a/book.json': RECORD('book_a', 'Moby-Dick') })
    const services = createKernelServices({
      fs,
      storage: null,
      initialBooks: [{ bookId: 'book_a', title: 'Moby-Dick', author: '', hasContent: true }],
    })
    return { fs, services, set: bookSet({ services }) }
  }

  it('sets status, rating and review in one write, and answers the detail with them', async () => {
    const { services, set } = shelf()
    const detail = await set({ book: 'book_a', status: 'reading', rating: 4, review: 'a whale of a book' })
    expect(detail.status).toBe('reading')
    expect(detail.rating).toBe(4)
    expect(detail.review).toBe('a whale of a book')
    expect(detail.finished).toBe(false)
    await services.drain()
    const held = services.library.getSnapshot()[0]!
    expect(held.status?.state).toBe('reading')
    expect(held.rating).toBe(4)
    expect(held.ratingAt).toBeDefined()
    expect(held.review?.text).toBe('a whale of a book')
  })

  it('moves finished with a status of finished, and takes a review back with an empty string', async () => {
    const { set } = shelf()
    expect((await set({ book: 'book_a', status: 'finished' })).finished).toBe(true)
    await set({ book: 'book_a', review: 'words' })
    expect((await set({ book: 'book_a', review: '' })).review).toBeNull()
  })

  it('refuses a status and a finished that disagree, by name', async () => {
    const { set } = shelf()
    await expect(set({ book: 'book_a', status: 'reading', finished: true })).rejects.toThrow('disagree')
    await expect(set({ book: 'book_a', status: 'finished', finished: false })).rejects.toThrow('disagree')
    expect((await set({ book: 'book_a', status: 'finished', finished: true })).finished).toBe(true)
    expect((await set({ book: 'book_a', status: 'want', finished: false })).finished).toBe(false)
  })

  it('refuses a status that is not one of the three words, by name', async () => {
    const { set } = shelf()
    await expect(set({ book: 'book_a', status: 'abandoned' })).rejects.toMatchObject({
      code: 'malformed',
      message: expect.stringContaining('want, reading, finished'),
    })
  })

  it('refuses a rating outside the five stars, and a fractional one, at the row', async () => {
    const { set } = shelf()
    for (const rating of [0, 6, 2.5]) {
      await expect(set({ book: 'book_a', rating })).rejects.toMatchObject({ code: 'malformed' })
    }
  })

  it('still takes the fields it always took, alone', async () => {
    const { set } = shelf()
    expect((await set({ book: 'book_a', finished: true })).finished).toBe(true)
    expect((await set({ book: 'book_a', finished: true })).status).toBe('finished')
    expect((await set({ book: 'book_a', position: 'epubcfi(/6/4)', progress: 0.5 })).progress).toBe(0.5)
  })
})

describe('what book.set hands the library — WI-23.B3, one row each', () => {
  it('patches only the fields the request named', async () => {
    const fs = fakeFs({ 'books/book_a/book.json': RECORD('book_a', 'Moby-Dick') })
    const services = createKernelServices({
      fs,
      storage: null,
      initialBooks: [{ bookId: 'book_a', title: 'Moby-Dick', author: '', hasContent: true }],
    })
    const patch = vi.spyOn(services.library, 'patch')
    const set = bookSet({ services })
    await set({ book: 'book_a', rating: 2 })
    expect(Object.keys(patch.mock.calls.at(-1)![1])).toEqual(['rating'])
    await set({ book: 'book_a', status: 'want' })
    expect(Object.keys(patch.mock.calls.at(-1)![1])).toEqual(['status'])
    await set({ book: 'book_a', review: 'r' })
    expect(Object.keys(patch.mock.calls.at(-1)![1])).toEqual(['review'])
  })
})

describe('book.position — the narrow door', () => {
  function shelf() {
    /* A record on disk: the position is written inside the book's lane, which reads the record there. */
    const fs = fakeFs({ 'books/book_a/book.json': RECORD('book_a', 'Moby-Dick') }) as unknown as IndexFs
    const services = createKernelServices({
      fs,
      storage: null,
      initialBooks: [{ bookId: 'book_a', title: 'Moby-Dick', author: '', hasContent: true }],
    })
    return { services, at: bookPosition({ services }) }
  }

  it('moves the position, carries a progress when one is given, and leaves it alone when none is', async () => {
    const { services, at } = shelf()
    await at({ book: 'book_a', position: 'epubcfi(/6/2)', progress: 0.25 })
    await services.drain()
    let held = services.library.getSnapshot()[0]!
    expect(held.position).toBe('epubcfi(/6/2)')
    expect(held.progress).toBe(0.25)
    await at({ book: 'book_a', position: 'epubcfi(/6/4)' })
    await services.drain()
    held = services.library.getSnapshot()[0]!
    expect(held.position).toBe('epubcfi(/6/4)')
    expect(held.progress).toBe(0.25)
    await at({ book: 'book_a', position: 'epubcfi(/6/6)', progress: 0.75 })
    await services.drain()
    expect(services.library.getSnapshot()[0]!.progress).toBe(0.75)
  })

  it('refuses a book that is not here, by name', async () => {
    const { at } = shelf()
    await expect(at({ book: 'book_zz', position: 'epubcfi(/6/2)' })).rejects.toMatchObject({ code: 'not-found' })
  })
})
