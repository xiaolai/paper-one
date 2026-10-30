import { describe, expect, it } from 'vitest'
import type { IndexedBook } from '../bookIndex'
import { fakeFs } from '../fakeFs.testkit'
import { createKernelServices } from '../services'
import { contentEvict } from './content'

/**
 * ⚠️ **A FOLDER LISTED OUTSIDE THE LANE CANNOT DECIDE ANYTHING.**
 *
 * `content.evict` enumerated the folder and then called into the store only
 * when that enumeration found something. The enumeration runs off the book's
 * write lane, so it is a snapshot of a moment already past: content landing
 * behind it, or bytes a listing could not see at all, survived an eviction
 * that reported success. The set of content names is small and closed, so the
 * store is now always asked, and which of them are really there is decided
 * inside the lane — where it cannot go stale.
 */
describe('content.evict', () => {
  const ROW: IndexedBook = { bookId: 'one', title: 'T', author: '', hasContent: false }

  it('deletes bytes the folder listing could not see', async () => {
    /* A directory that cannot be LISTED and can still be traversed is an
       ordinary POSIX state — `readDir` needs read on the directory, `exists`
       needs only search — and it is the sharpest form of the same defect: the
       diagnosis is blind, the lane is not. */
    const fs = fakeFs({
      'books/one/book.json': JSON.stringify({ bookId: 'one', title: 'T', author: '' }),
      'books/one/content.epub': 'bytes',
    })
    const blind = {
      ...fs,
      readDir: async (path: string) => {
        if (path === 'books/one') throw new Error('EACCES')
        return fs.readDir(path)
      },
    }
    const services = createKernelServices({ fs: blind, storage: null, initialBooks: [ROW] })

    const where = await contentEvict({ services })({ book: 'one' })
    await services.drain()

    expect(fs.store.has('books/one/content.epub'), 'the bytes the reader asked to evict').toBe(false)
    expect(where).toMatchObject({ bookId: 'one', here: false })
    // The book itself survives: eviction takes this device's copy, not the record.
    expect(fs.store.has('books/one/book.json')).toBe(true)
  })

  /* AND NOTHING TO DO STILL OPENS NO JOURNAL BRACKET. That is why the caller
     used to short-circuit at all — `removeBlob` records what an empty bracket
     costs: the journal advances, the feed carries an entry, and the verify
     pass has one more surface to digest, all for a file that was already
     gone. The check moved into the lane; it did not disappear. */
  it('journals nothing when there is no content and the row does not claim any', async () => {
    const fs = fakeFs({ 'books/one/book.json': JSON.stringify({ bookId: 'one', title: 'T', author: '' }) })
    const kinds: string[] = []
    const services = createKernelServices({
      fs,
      storage: null,
      initialBooks: [ROW],
      recorder: {
        begin: async (_book, what) => {
          kinds.push(what)
          return { book: 'one', what } as never
        },
        commit: async () => {},
      },
    })

    expect(await contentEvict({ services })({ book: 'one' })).toMatchObject({ here: false })
    await services.drain()
    expect(kinds).toEqual([])
  })

  /* A row still claiming content over an empty folder IS something to do: that
     claim is what makes an unopenable book look fine on the shelf. */
  it('settles a row that claims content the folder does not have', async () => {
    const fs = fakeFs({ 'books/one/book.json': JSON.stringify({ bookId: 'one', title: 'T', author: '' }) })
    const services = createKernelServices({
      fs,
      storage: null,
      initialBooks: [{ ...ROW, hasContent: true }],
    })

    expect(await contentEvict({ services })({ book: 'one' })).toMatchObject({ here: false })
    await services.drain()
    expect(services.library.getSnapshot()[0]?.hasContent).toBe(false)
  })
})
