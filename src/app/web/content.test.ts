import { describe, expect, it } from 'vitest'
import type { ShelfChannel } from './channel'
import { BOOK_MAX_BYTES } from '../../kernel'
import { remoteContent } from './content'

/**
 * The browser's byte path.
 *
 * The shelf half of this — chunking, offsets, the end of the file — is proven
 * over the real router in `contentServices.test.ts`. What is proven HERE is
 * that this side reassembles what that side sends, which is the half a shelf
 * test cannot see: a client that dropped every other chunk would leave the
 * shelf's tests entirely green.
 */

/** Bytes, chunked the way `content.read` chunks them. */
function shelfOf(files: Record<string, string>, chunk = 4) {
  const asked: { service: string; body: unknown }[] = []
  const channel: ShelfChannel = {
    call: async (service, body) => {
      asked.push({ service, body })
      if (service !== 'content.locate') throw new Error(`unexpected call: ${service}`)
      const book = (body as { book: string }).book
      const text = files[book]
      return text === undefined
        ? { bookId: book, here: false, ext: null, size: null }
        : { bookId: book, here: true, ext: 'epub', size: text.length }
    },
    stream: (service, body) => ({
      [Symbol.asyncIterator]: async function* () {
        asked.push({ service, body })
        const { book, offset, length } = body as { book: string; offset?: number; length?: number }
        const text = files[book]
        if (text === undefined) throw new Error(`not-found: ${book}`)
        const from = offset ?? 0
        const to = length === undefined ? text.length : Math.min(text.length, from + length)
        for (let at = from; at < to; at += chunk) {
          const slice = text.slice(at, Math.min(at + chunk, to))
          if (slice === '') break
          /* A PAGE PER YIELD — an array of rows, as every stream in the service
             table answers. */
          yield [{ bookId: book, offset: at, bytes: btoa(slice) }]
        }
      },
    }),
    close: () => {},
    onClosed: () => () => {},
  }
  return { content: remoteContent(channel), asked }
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('fileOf', () => {
  it('assembles every chunk, in order, into one file', async () => {
    const { content } = shelfOf({ one: 'call me ishmael' })
    const file = await content.fileOf('one', 'Moby-Dick.epub')
    expect(await file.text()).toBe('call me ishmael')
  })

  /* THE NAME THE BOOK ARRIVED WITH. Every parser Paper uses routes on the
     extension, and foliate rejects a name with no suffix as an unsupported
     type — so a file named after the vault's content hash would not open. */
  it('carries the name it was given, not the shelf’s', async () => {
    const { content } = shelfOf({ one: 'x' })
    expect((await content.fileOf('one', 'Moby-Dick.epub')).name).toBe('Moby-Dick.epub')
  })
})

describe('readRange', () => {
  it('asks for the slice it was told to and returns exactly that', async () => {
    const { content, asked } = shelfOf({ one: 'call me ishmael' })
    expect(text(await content.readRange('one', 5, 6))).toBe('me ish')
    expect(asked.at(-1)?.body).toEqual({ book: 'one', offset: 5, length: 6 })
  })

  /* A SHORT ANSWER IS THE END OF THE FILE, not a failure. A caller that
     treated one as an error could not read the last page of any book. */
  it('answers fewer bytes at the end of the file, without raising', async () => {
    const { content } = shelfOf({ one: 'call me ishmael' })
    expect(text(await content.readRange('one', 9, 999))).toBe('shmael')
  })

  it('answers nothing past the end', async () => {
    const { content } = shelfOf({ one: 'short' })
    expect(await content.readRange('one', 500, 10)).toEqual(new Uint8Array(0))
  })

  /* NOT SENT AT ALL. The shelf would refuse a zero-length read anyway, but a
     round trip to be told nothing is a round trip a phone paid for. */
  it('answers a zero length without asking the shelf', async () => {
    const { content, asked } = shelfOf({ one: 'x' })
    expect(await content.readRange('one', 0, 0)).toEqual(new Uint8Array(0))
    expect(asked).toEqual([])
  })

  /* THIS SIDE'S MISTAKE, REPORTED AS THIS SIDE'S. pdf.js computes ranges from a
     length this client supplied, so a negative one is a bug here — and arriving
     as a protocol error from the shelf would send the search to the wrong
     machine. */
  it('refuses a negative offset or length locally', async () => {
    const { content, asked } = shelfOf({ one: 'x' })
    await expect(content.readRange('one', -1, 4)).rejects.toThrow(/must not be negative/)
    await expect(content.readRange('one', 0, -4)).rejects.toThrow(/must not be negative/)
    expect(asked).toEqual([])
  })
})

describe('locate', () => {
  it('reports what the shelf holds', async () => {
    const { content } = shelfOf({ one: 'call me ishmael' })
    expect(await content.locate('one')).toEqual({ here: true, ext: 'epub', size: 15 })
  })

  /**
   * NULL IS NOT ZERO, and this is the branch a range transport lives or dies
   * on. A shelf that binds no size port answers null for every book — which
   * the desktop app did for the whole of phase 11 — and a client that read
   * that as `0` would build a transport of length zero and open an empty PDF
   * with no error anywhere.
   */
  it('keeps an unmeasurable size as null rather than zero', async () => {
    const { content } = shelfOf({})
    expect(await content.locate('missing')).toEqual({ here: false, ext: null, size: null })
  })
})

/**
 * A SHELF THAT MISBEHAVES, one way at a time.
 *
 * Every case below assembled cleanly before the offsets were checked, and every
 * one of them produces a file that is wrong rather than a read that fails. A
 * truncated EPUB will not open; a PDF spliced from two versions WILL, which is
 * the worse half.
 */
function badShelf(pages: readonly unknown[][]) {
  const channel: ShelfChannel = {
    call: async () => ({ bookId: 'one', here: true, ext: 'epub', size: 8 }),
    stream: () => ({
      [Symbol.asyncIterator]: async function* () {
        for (const page of pages) yield page
      },
    }),
    close: () => {},
    onClosed: () => () => {},
  }
  return remoteContent(channel)
}

const chunk = (offset: number, text: string, bookId = 'one') => ({ bookId, offset, bytes: btoa(text) })

/**
 * ⚠️ **A WHOLE BOOK USED TO BE COLLECTED WITH NO CEILING.**
 *
 * `fileOf` is the path a PHONE takes, on a device chosen precisely so a book
 * need not be downloaded to it — and it read an entire book into memory with
 * nothing bounding the size. A 300 MB scan, or a shelf answering with something
 * absurd, exhausted the tab before the `File` was constructed.
 *
 * Both halves are here because they answer different failures: the shelf's
 * stated size refuses BEFORE a byte is asked for, and the running total is what
 * covers a shelf that could not measure the book — `size: null` is a real
 * answer, and was for the whole of phase 11.
 */
describe('how much of a book this will hold', () => {
  /* A SMALL CEILING, so the bound can be shown without allocating a real one.
     The comparison is what is under test, not the number. */
  const SMALL = 64

  /** A shelf that claims a size without having to produce one. */
  function claiming(size: number | null, bytes = 'ok') {
    const channel: ShelfChannel = {
      call: async () => ({ bookId: 'one', here: true, ext: 'epub', size }),
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield [{ bookId: 'one', offset: 0, bytes: btoa(bytes) }]
        },
      }),
      close: () => {},
      onClosed: () => () => {},
    }
    return remoteContent(channel)
  }

  it('refuses a book the shelf says is too large, before reading a byte', async () => {
    const content = claiming(BOOK_MAX_BYTES + 1)
    await expect(content.fileOf('one', 'Enormous.epub')).rejects.toThrow(/past the .* this can hold/)
  })

  it('accepts one the shelf says fits', async () => {
    const content = claiming(BOOK_MAX_BYTES)
    await expect(content.fileOf('one', 'Large.epub')).resolves.toBeInstanceOf(File)
  })

  it('has a real ceiling, not an unreachable one', () => {
    /* The shipped number, asserted once so the tests below may use a small one
       without the real bound quietly becoming absent. */
    expect(BOOK_MAX_BYTES).toBeGreaterThan(0)
    expect(BOOK_MAX_BYTES).toBeLessThanOrEqual(1024 * 1024 * 1024)
  })

  /* THE SHELF COULD NOT MEASURE IT — `size: null` is what a shelf with no size
     port answers, which the desktop app was for the whole of phase 11. The
     running total is the only bound in that case. */
  it('stops mid-stream when an unmeasured book runs past the ceiling', async () => {
    const page = 'x'.repeat(SMALL)
    let yielded = 0
    const channel: ShelfChannel = {
      call: async () => ({ bookId: 'one', here: true, ext: 'epub', size: null }),
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          /* Four times the ceiling, and BOUNDED — an endless generator proves
             the same thing by hanging, which is not a test result. */
          for (let at = 0; at < SMALL * 4; at += page.length) {
            yielded += 1
            yield [{ bookId: 'one', offset: at, bytes: btoa(page) }]
          }
        },
      }),
      close: () => {},
      onClosed: () => () => {},
    }
    await expect(remoteContent(channel, SMALL).fileOf('one', 'Unmeasured.epub')).rejects.toThrow(
      /past the .* this can hold/,
    )
    /* AND IT STOPPED EARLY, rather than reading everything and complaining
       afterwards — which is the difference between a bound and a report. */
    expect(yielded).toBeLessThan(4)
  })
})

describe('an assembled book is checked, not trusted', () => {
  it('refuses a gap between chunks', async () => {
    /* THE QUIET ONE. Four bytes missing from the middle of a book assembles
       into a file four bytes short, and nothing downstream can tell. */
    const content = badShelf([[chunk(0, 'abcd')], [chunk(8, 'efgh')]])
    await expect(content.fileOf('one', 'x.epub')).rejects.toThrow(/not contiguous.*expected byte 4/)
  })

  it('refuses a chunk that arrives twice', async () => {
    const content = badShelf([[chunk(0, 'abcd')], [chunk(0, 'abcd')]])
    await expect(content.fileOf('one', 'x.epub')).rejects.toThrow(/not contiguous/)
  })

  it('refuses chunks that arrive out of order', async () => {
    const content = badShelf([[chunk(4, 'efgh')], [chunk(0, 'abcd')]])
    await expect(content.fileOf('one', 'x.epub')).rejects.toThrow(/not contiguous/)
  })

  /* A CHUNK OF ANOTHER BOOK. One socket carries every read, so a correlation
     bug on either side puts one book's bytes inside another's file. */
  it('refuses a chunk belonging to a different book', async () => {
    const content = badShelf([[chunk(0, 'abcd')], [chunk(4, 'efgh', 'two')]])
    await expect(content.fileOf('one', 'x.epub')).rejects.toThrow(/got a chunk of two/)
  })

  /* NOT SKIPPED. A row this cannot read is a protocol disagreement; carrying on
     turns it into a book that is quietly short. */
  it('refuses a page that is not a chunk at all', async () => {
    const content = badShelf([[chunk(0, 'abcd')], [{ nonsense: true }]])
    await expect(content.fileOf('one', 'x.epub')).rejects.toThrow(/not a chunk/)
  })

  /* AND A RANGE STARTS WHERE IT WAS ASKED TO. The first chunk of a ranged read
     is not at zero, so the check has to begin from the offset requested. */
  it('checks a ranged read from the offset it asked for', async () => {
    const good = badShelf([[chunk(16, 'abcd')]])
    expect(new TextDecoder().decode(await good.readRange('one', 16, 4))).toBe('abcd')

    const wrong = badShelf([[chunk(0, 'abcd')]])
    await expect(wrong.readRange('one', 16, 4)).rejects.toThrow(/expected byte 16/)
  })
})
