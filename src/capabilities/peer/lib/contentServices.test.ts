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

/**
 * `content.read` — the one path by which a book's bytes reach a browser.
 *
 * Everything else in this file describes bytes; this carries them. The generic
 * read-service sweep in `readServices.test.ts` proves only that it answers
 * SOMETHING of the declared shape, which a handler yielding one empty chunk
 * would satisfy — and a client assembling that writes a zero-byte file and
 * calls it a book.
 *
 * So the assertions here are about the bytes: that what arrives is what is on
 * disk, that the chunks tile the file without gap or overlap, and that the end
 * of the file ends the stream rather than raising.
 *
 * THE CHUNK SIZE IS NEVER NAMED. It is a tuning constant, and a test that
 * spells it out is a second copy of it that drifts. What is asserted is the
 * PROPERTY a chunk size has to have — uniform pages, contiguous offsets, and a
 * concatenation equal to the file — which holds at any value.
 */

interface Chunk {
  readonly bookId: string
  readonly offset: number
  readonly bytes: string
}

/** Every chunk of a `content.read`, pages flattened. */
async function chunks(shelf: ReturnType<typeof serveTable>, body: Record<string, unknown>): Promise<Chunk[]> {
  const out: Chunk[] = []
  for await (const page of shelf.client.stream('content.read', body)) out.push(...(page as Chunk[]))
  return out
}

/** The bytes those chunks carry, decoded and joined in the order they arrived. */
function assembled(got: readonly Chunk[]): Uint8Array {
  const parts = got.map((one) => Uint8Array.from(atob(one.bytes), (ch) => ch.charCodeAt(0)))
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const all = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.length
  }
  return all
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('content.read', () => {
  it('answers the bytes that are on disk', async () => {
    const got = await chunks(withContent(['content.epub']), { book: 'one' })
    expect(text(assembled(got))).toBe('the whale')
    expect(got.every((one) => one.bookId === 'one')).toBe(true)
  })

  it('starts where it was asked to and stops after the length it was given', async () => {
    const shelf = withContent(['content.epub'])
    expect(text(assembled(await chunks(shelf, { book: 'one', offset: 4 })))).toBe('whale')
    expect(text(assembled(await chunks(shelf, { book: 'one', offset: 4, length: 3 })))).toBe('wha')
    /* THE FIRST CHUNK'S OFFSET IS THE CALLER'S, not zero — a client resuming a
       download seeks by it, and a chunk mislabelled zero overwrites the start
       of the file it was assembling. */
    expect((await chunks(shelf, { book: 'one', offset: 4 }))[0]?.offset).toBe(4)
  })

  /* A READ PAST THE END IS NOT AN ERROR, and it is not a chunk of nothing
     either. A zero-length chunk would be indistinguishable from a book whose
     bytes are still coming. */
  it('answers nothing past the end of the file, without raising', async () => {
    expect(await chunks(withContent(['content.epub']), { book: 'one', offset: 9_000 })).toEqual([])
  })

  it('answers nothing for a zero length', async () => {
    expect(await chunks(withContent(['content.epub']), { book: 'one', length: 0 })).toEqual([])
  })

  /**
   * THE WHOLE REASON THIS IS A STREAM.
   *
   * A book is larger than a frame — the envelope caps one at 4 MiB and base64
   * costs four bytes per three — so a handler that yielded the file in one
   * piece would work on the fixture and fail on a real book, over the wire,
   * where the failure is a dropped connection rather than a message.
   *
   * The chunk size itself is deliberately not named here; see the header.
   */
  it('tiles a book too large for one frame into contiguous equal pages', async () => {
    /* ASCII, so a byte is a character and the fake filesystem's `TextEncoder`
       does not change the length out from under the assertions. */
    const big = 'abcdefgh'.repeat(200_000) // 1.6 MB, several chunks at any sane size
    const shelf = serveTable({
      books: [seedBook('one', { hasContent: true })],
      files: { 'books/one/content.epub': big },
    })
    const got = await chunks(shelf, { book: 'one' })
    expect(got.length).toBeGreaterThan(1)
    expect(text(assembled(got))).toBe(big)

    /* CONTIGUOUS AND NON-OVERLAPPING. Assembling by concatenation above would
       hide an off-by-one in the offsets; a client that seeks by them would
       not. */
    let expected = 0
    for (const one of got) {
      expect(one.offset).toBe(expected)
      expected += atob(one.bytes).length
    }
    expect(expected).toBe(big.length)

    /* EVERY PAGE BUT THE LAST IS THE SAME SIZE — the property a fixed chunk
       size has, asserted without naming the number. */
    const sizes = got.map((one) => atob(one.bytes).length)
    expect(new Set(sizes.slice(0, -1)).size).toBe(1)
    expect(sizes[sizes.length - 1]).toBeLessThanOrEqual(sizes[0]!)
  })

  it('stops at the length asked for even when it spans chunks', async () => {
    const big = 'abcdefgh'.repeat(200_000)
    const shelf = serveTable({
      books: [seedBook('one', { hasContent: true })],
      files: { 'books/one/content.epub': big },
    })
    const want = 700_000
    const got = await chunks(shelf, { book: 'one', length: want })
    expect(assembled(got).length).toBe(want)
    expect(got.length).toBeGreaterThan(1)
  })

  /* ONE FILE, ONE ANSWER. `content.locate` reports an `ext` and a `size`; this
     streams bytes. Picking differently — first-sorted here, `CONTENT_EXTENSIONS`
     order there — had `locate` describe the epub while `read` sent the azw3, so
     a client sizing a buffer from one and filling it from the other got a
     truncated book and no error anywhere. */
  it('streams the same file content.locate describes when a folder holds two', async () => {
    const shelf = serveTable({
      books: [seedBook('one', { hasContent: true })],
      files: {
        'books/one/content.azw3': 'the wrong one',
        'books/one/content.epub': 'the whale',
      },
    })
    const found = (await shelf.client.call('content.locate', { book: 'one' })) as { ext: string }
    expect(found.ext).toBe('epub')
    expect(text(assembled(await chunks(shelf, { book: 'one' })))).toBe('the whale')
  })

  it('refuses a book whose folder holds no bytes, rather than streaming nothing', async () => {
    /* NOT AN EMPTY STREAM. "This shelf does not have the bytes" and "this book
       is zero bytes long" have to be different answers, or a client writes the
       second when it was told the first. */
    const shelf = withContent([])
    expect(refusalCode(await chunks(shelf, { book: 'one' }).catch((e: unknown) => e))).toBe('not-found')
  })

  it('refuses a book the shelf does not hold, and is forbidden without its grant', async () => {
    expect(refusalCode(await chunks(serveTable({}), { book: 'nobody' }).catch((e: unknown) => e))).toBe('not-found')
    const locked = withContent(['content.epub'])
    locked.setGrants(['mark:read'])
    expect(refusalCode(await chunks(locked, { book: 'one' }).catch((e: unknown) => e))).toBe(FORBIDDEN)
    /* THE HANDLER NEVER RAN. A refusal that arrives after the file was opened
       leaks through timing what it withheld in the answer. */
    expect(locked.ran).not.toContain('content.read')
  })
})
