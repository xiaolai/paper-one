import { describe, expect, it } from 'vitest'
import { FORBIDDEN, refusalCode, seedBook, serveTable } from './serviceTable.testkit'

/**
 * `content.*` OVER THE REAL ROUTER — where a book's bytes are, and the one
 * verb that deletes them.
 *
 * `content.evict` is destructive and DEVICE-LOCAL by construction: the outbox
 * carries `record | marks | removed | cards`, so the `content` commit it
 * journals exists and never pushes. Nothing here had focused coverage, and the
 * failures it can produce are the quiet kind — an answer of `here: false` over
 * a file that is plainly still on disk.
 */

const BYTES = new TextEncoder().encode('the whale')

/** A shelf with one book whose folder holds the named content files. */
function withContent(names: readonly string[], row: Record<string, unknown> = {}) {
  return serveTable({
    books: [seedBook('one', { hasContent: names.length > 0, ...row })],
    files: Object.fromEntries(names.map((name) => [`books/one/${name}`, 'the whale'])),
  })
}

describe('content.locate', () => {
  it('describes the file the folder actually holds', async () => {
    const shelf = withContent(['content.epub'])
    expect(await shelf.client.call('content.locate', { book: 'one' })).toMatchObject({
      bookId: 'one',
      here: true,
      ext: 'epub',
    })
  })

  /* ONE ANSWER ABOUT ONE FILE. A folder is not supposed to hold two content
   * files, but it can — and `ext` and `size` picking differently reported one
   * format with the other's byte count. */
  it('names and measures the same file when a folder holds two', async () => {
    const shelf = withContent(['content.azw3', 'content.epub'])
    const found = (await shelf.client.call('content.locate', { book: 'one' })) as { ext: string }
    /* `CONTENT_EXTENSIONS` order, which is what the size port walks — not
     * lexicographic, which would have said `azw3`. */
    expect(found.ext).toBe('epub')
  })

  /**
   * A FOLDER THAT IS GONE HAS NOTHING IN IT, and that is not the same as a
   * folder nobody could read. Both used to collapse into "could not look",
   * which falls back to the record's cached flag — so a book whose folder had
   * been deleted was reported as still holding its bytes.
   */
  it('believes an absent folder over a stale hasContent', async () => {
    const shelf = serveTable({ books: [seedBook('one', { hasContent: true })] })
    /* The seeded record makes the folder exist, so take it away entirely. */
    for (const key of [...shelf.fs.store.keys()]) if (key.startsWith('books/one/')) shelf.fs.store.delete(key)
    expect(await shelf.client.call('content.locate', { book: 'one' })).toMatchObject({ here: false, size: null })
  })

  /* AND AN UNREADABLE ONE IS NOT AN EMPTY ONE. The record's flag is the
   * fallback exactly here, and nowhere else. */
  it('falls back to the record when the folder will not read', async () => {
    const shelf = withContent(['content.epub'], { ext: 'epub' })
    shelf.fs.readDir = async () => {
      throw new Error('EACCES')
    }
    expect(await shelf.client.call('content.locate', { book: 'one' })).toMatchObject({ here: true, ext: 'epub' })
  })

  it('refuses a book the shelf does not hold, by name', async () => {
    const shelf = serveTable({ books: [] })
    const failure = await shelf.client.call('content.locate', { book: 'nobody' }).catch((e: unknown) => e)
    expect(refusalCode(failure)).toBe('not-found')
    expect(String(failure)).toMatch(/no book nobody/)
  })
})

describe('content.evict', () => {
  it('deletes the bytes and answers with what the folder now holds', async () => {
    const shelf = withContent(['content.epub'])
    expect(await shelf.client.call('content.evict', { book: 'one' })).toMatchObject({ here: false, size: null })
    expect(shelf.fs.store.has('books/one/content.epub')).toBe(false)
    /* THE BOOK ITSELF SURVIVES. Eviction takes this device's copy, not the
     * reader's record, their tags or their marks. */
    expect(shelf.fs.store.has('books/one/book.json')).toBe(true)
  })

  /* EVERY stored content file, not the first. A folder holding two would
   * otherwise have one deleted and the other left under a row saying the
   * bytes are gone. */
  it('deletes every content file in the folder', async () => {
    const shelf = withContent(['content.epub', 'content.pdf'])
    expect(await shelf.client.call('content.evict', { book: 'one' })).toMatchObject({ here: false })
    expect([...shelf.fs.store.keys()].filter((k) => k.startsWith('books/one/content.'))).toEqual([])
  })

  /* THE COVER IS NOT CONTENT. `REMOVABLE_BLOB_NAMES` includes it for the
   * cover cache's own eviction; this verb is about the book's bytes. */
  it('leaves the cover alone', async () => {
    const shelf = serveTable({
      books: [seedBook('one', { hasContent: true })],
      files: { 'books/one/content.epub': 'x', 'books/one/cover.jpg': 'jacket' },
    })
    await shelf.client.call('content.evict', { book: 'one' })
    expect(shelf.fs.store.has('books/one/cover.jpg')).toBe(true)
  })

  /**
   * A STALE `hasContent: true` OVER AN EMPTY FOLDER IS SETTLED, NOT IGNORED.
   *
   * A listing that succeeds and finds nothing, against a row still claiming
   * the bytes are here, is exactly a stale cache — and skipping the refresh
   * left `content.evict` answering `here: false` while the shelf went on
   * offering the book as downloaded until a rescan happened to disagree.
   */
  it('settles a row that claims content the folder does not have', async () => {
    const shelf = serveTable({
      books: [seedBook('one', { hasContent: true })],
      files: { 'books/one/book.json': JSON.stringify({ bookId: 'one', title: 'T', author: 'A' }) },
    })
    expect(await shelf.client.call('content.evict', { book: 'one' })).toMatchObject({ here: false })
    const listed = (await shelf.client.call('book.get', { book: 'one' })) as { hasContent: boolean | null }
    expect(listed.hasContent).toBe(false)
  })

  /* EVICTING WHAT IS NOT THERE IS DONE, not an error — the verb is
   * idempotent, which is what makes it safe for a satchel to retry. */
  it('is idempotent', async () => {
    const shelf = withContent(['content.epub'])
    const first = await shelf.client.call('content.evict', { book: 'one' })
    const again = await shelf.client.call('content.evict', { book: 'one' })
    expect(again).toEqual(first)
  })

  /**
   * A LANDING THAT ARRIVES WHILE AN EVICTION IS QUEUED MUST NOT SURVIVE IT.
   *
   * The folder is read OUTSIDE the book's lane, so a content file of a
   * different extension landing between that read and the delete was absent
   * from the list and outlived an evict that reported success. Offering the
   * whole closed set costs an `exists` apiece and removes the window.
   */
  it('removes a file that landed after the folder was read', async () => {
    const shelf = withContent(['content.epub'])
    const real = shelf.fs.readDir.bind(shelf.fs)
    let once = false
    shelf.fs.readDir = async (path: string) => {
      const answer = await real(path)
      if (!once && path === 'books/one') {
        once = true
        /* The landing happens after the enumeration and before the delete. */
        shelf.fs.store.set('books/one/content.pdf', BYTES)
      }
      return answer
    }
    expect(await shelf.client.call('content.evict', { book: 'one' })).toMatchObject({ here: false })
    expect(shelf.fs.store.has('books/one/content.pdf')).toBe(false)
    expect(shelf.fs.store.has('books/one/content.epub')).toBe(false)
  })

  it('refuses a book the shelf does not hold, and is forbidden without its grant', async () => {
    expect(
      refusalCode(await serveTable({}).client.call('content.evict', { book: 'nobody' }).catch((e: unknown) => e)),
    ).toBe('not-found')
    const locked = withContent(['content.epub'])
    locked.setGrants(['book:read'])
    expect(refusalCode(await locked.client.call('content.evict', { book: 'one' }).catch((e: unknown) => e))).toBe(
      FORBIDDEN,
    )
    expect(locked.ran).not.toContain('content.evict')
  })
})
