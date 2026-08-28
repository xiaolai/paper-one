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
  it('refuses an offset or length that is not a byte count, locally', async () => {
    /* Negatives were refused; `NaN`, `Infinity` and fractions were not, and
     * each is a range pdf.js can compute from a length this side supplied —
     * so each is this side's bug to report, before it reaches a shelf. */
    const { content, asked } = shelfOf({ one: 'x' })
    await expect(content.readRange('one', -1, 4)).rejects.toThrow(/byte counts/)
    await expect(content.readRange('one', 0, -4)).rejects.toThrow(/byte counts/)
    await expect(content.readRange('one', Number.NaN, 4)).rejects.toThrow(/byte counts/)
    await expect(content.readRange('one', 0, Number.POSITIVE_INFINITY)).rejects.toThrow(/byte counts/)
    await expect(content.readRange('one', 1.5, 4)).rejects.toThrow(/byte counts/)
    expect(asked).toEqual([])
  })
})

describe('locate', () => {
  it('reports what the shelf holds', async () => {
    const { content } = shelfOf({ one: 'call me ishmael' })
    expect(await content.locate('one')).toEqual({ here: true, ext: 'epub', size: 15, contentHash: null })
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
    expect(await content.locate('missing')).toEqual({ here: false, ext: null, size: null, contentHash: null })
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

/**
 * A READ THAT LOST ITS CHANNEL IS RESTARTED WHOLE (WI-20.30).
 *
 * Codex refuted two drafts of this. Reconnecting alone cannot finish a read
 * already in flight: `shut()` rejects every pending call. And a replay that
 * RESUMED after the chunks already delivered either repeated offset 0 and
 * tripped the contiguity check above, or spliced two versions of the book —
 * because neither the chunks nor `locate`'s facts carried a hash. So the
 * partial is discarded, the whole read is asked for again once the channel is
 * back, and every read carries the hash `locate` learned so a changed book is
 * a refusal rather than a splice.
 */
import { ENVELOPE_ERRORS, ServiceCallError, serviceError } from '../../kernel/core/envelope'
import { MAX_RESTARTS } from './content'

const dropped = () => new ServiceCallError('content.read', serviceError(ENVELOPE_ERRORS.disconnected, 'disconnected', true))
const chunkOf = (offset: number, bytes: string, bookId = 'one') => ({ bookId, offset, bytes: btoa(bytes) })

/**
 * A shelf whose `content.read` answers from a script, one entry per call:
 * the pages to yield, then optionally a throw. `whenOpen` counts how often
 * the client waited for the channel to come back.
 */
function flakyShelf(
  script: readonly { pages: readonly unknown[][]; then?: unknown }[],
  facts: { contentHash: string | null } = { contentHash: null },
) {
  const asked: { service: string; body: Record<string, unknown> }[] = []
  let waited = 0
  let call = 0
  const channel = {
    call: async (service: string, body: unknown) => {
      asked.push({ service, body: body as Record<string, unknown> })
      return { bookId: 'one', here: true, ext: 'epub', size: 4, contentHash: facts.contentHash }
    },
    stream: (service: string, body: unknown) => ({
      [Symbol.asyncIterator]: async function* () {
        asked.push({ service, body: body as Record<string, unknown> })
        const step = script[Math.min(call, script.length - 1)]!
        call += 1
        for (const page of step.pages) yield page
        if (step.then !== undefined) throw step.then
      },
    }),
    close: () => {},
    onClosed: () => () => {},
    whenOpen: async () => {
      waited += 1
    },
  }
  return { content: remoteContent(channel), asked, waits: () => waited }
}

describe('a read that lost its channel', () => {
  it('is restarted whole on the channel that comes back, and the original promise resolves to one exact copy', async () => {
    const { content, asked, waits } = flakyShelf([
      { pages: [[chunkOf(0, 'AB')]], then: dropped() },
      { pages: [[chunkOf(0, 'AB')], [chunkOf(2, 'CD')]] },
    ])
    const file = await content.fileOf('one', 'x.epub')
    expect(text(new Uint8Array(await file.arrayBuffer()))).toBe('ABCD')
    /* FROM THE START, not from byte 2. The two reads ask for the same thing;
       what was delivered before the drop is thrown away. */
    const reads = asked.filter((one) => one.service === 'content.read')
    expect(reads).toHaveLength(2)
    expect(reads[1]!.body['offset']).toBe(reads[0]!.body['offset'])
    expect(waits()).toBe(1)
  })

  it('restarts a RANGE from the range’s own start, never from where the drop left it', async () => {
    const { content, asked } = flakyShelf([
      { pages: [[chunkOf(4, 'ef')]], then: dropped() },
      { pages: [[chunkOf(4, 'ef')], [chunkOf(6, 'gh')]] },
    ])
    expect(text(await content.readRange('one', 4, 4))).toBe('efgh')
    const reads = asked.filter((one) => one.service === 'content.read')
    expect(reads.map((one) => one.body['offset'])).toEqual([4, 4])
  })

  it('carries the hash locate learned on every read, and refuses a book that changed rather than splicing it', async () => {
    const HASH = 'a'.repeat(64)
    const changed = new ServiceCallError('content.read', serviceError('conflict', 'the content of one changed'))
    const { content, asked } = flakyShelf(
      [
        { pages: [[chunkOf(0, 'AB')]], then: dropped() },
        /* The shelf, asked with `expect`, no longer holds that hash. A fake
           that served `YZ` here is what the old design would have spliced
           onto the `AB` already delivered. */
        { pages: [], then: changed },
      ],
      { contentHash: HASH },
    )
    await content.locate('one')
    await expect(content.fileOf('one', 'x.epub')).rejects.toThrow(/changed/)
    const reads = asked.filter((one) => one.service === 'content.read')
    expect(reads).toHaveLength(2)
    expect(reads.every((one) => one.body['expect'] === HASH)).toBe(true)
  })

  it('sends no expectation when the shelf could not hash the book', async () => {
    const { content, asked } = flakyShelf([{ pages: [[chunkOf(0, 'ABCD')]] }], { contentHash: null })
    await content.locate('one')
    await content.fileOf('one', 'x.epub')
    const read = asked.find((one) => one.service === 'content.read')!
    expect('expect' in read.body).toBe(false)
  })

  it('gives up after a bounded number of restarts, with the failure that ended it', async () => {
    const { content, asked } = flakyShelf([{ pages: [], then: dropped() }])
    await expect(content.fileOf('one', 'x.epub')).rejects.toThrow(/disconnected/)
    expect(asked.filter((one) => one.service === 'content.read')).toHaveLength(1 + MAX_RESTARTS)
  })

  it('does not restart a read that failed for a reason a retry cannot change', async () => {
    const refused = new ServiceCallError('content.read', serviceError('not-found', 'no content for one'))
    const { content, asked, waits } = flakyShelf([{ pages: [], then: refused }])
    await expect(content.fileOf('one', 'x.epub')).rejects.toThrow(/no content/)
    expect(asked.filter((one) => one.service === 'content.read')).toHaveLength(1)
    expect(waits()).toBe(0)
  })
})
