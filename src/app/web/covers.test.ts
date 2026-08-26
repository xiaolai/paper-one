import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShelfChannel } from './channel'
import { remoteCovers } from './covers'

/**
 * `remoteCovers`: a jacket over the channel, and the two ways there is none.
 *
 * THE DISTINCTION THIS FILE EXISTS FOR. A book with no artwork and a channel
 * that failed produce the SAME PICTURE — the tint `BookCover` draws when it is
 * given null — so nothing on screen can tell them apart. That makes it the
 * console's job, and a job nothing checks is a job that quietly stops being
 * done.
 */

/** A shelf whose `cover.read` answers with these bytes, chunked. */
function shelfOf(covers: Record<string, string>, chunk = 4): ShelfChannel {
  return {
    call: async () => {
      throw new Error('remoteCovers must not use call')
    },
    stream: (service: string, body: unknown) => ({
      [Symbol.asyncIterator]: async function* () {
        expect(service).toBe('cover.read')
        const { book } = body as { book: string }
        const text = covers[book]
        if (text === undefined) throw new Error(`not-found: ${book}`)
        for (let at = 0; at < text.length; at += chunk) {
          const slice = text.slice(at, at + chunk)
          yield [{ bookId: book, offset: at, bytes: btoa(slice) }]
        }
      },
    }),
    close: () => {},
  } as unknown as ShelfChannel
}

const minted: string[] = []
let lastBlob: Blob | null = null

beforeEach(() => {
  minted.length = 0
  lastBlob = null
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      lastBlob = blob
      const url = `blob:cover-${minted.length}`
      minted.push(url)
      return url
    },
    revokeObjectURL: () => {},
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('remoteCovers', () => {
  it('mints one object URL per book from the bytes the shelf streamed', async () => {
    const url = await remoteCovers(shelfOf({ a: 'a jacket' }))('a')
    expect(url).toBe('blob:cover-0')
    expect(await lastBlob?.text()).toBe('a jacket')
  })

  /* CHUNKS ARE JOINED IN ORDER. A cover arrives in as many frames as the
     envelope's limit needs; assembling them wrongly produces a blob that
     decodes to nothing and draws a broken-image glyph where the tint belongs. */
  it('joins every chunk, whatever the chunk size', async () => {
    for (const size of [1, 3, 4, 64]) {
      await remoteCovers(shelfOf({ a: 'the whole jacket' }, size))('a')
      expect(await lastBlob?.text()).toBe('the whole jacket')
    }
  })

  /**
   * NO BYTES IS NULL, NOT AN EMPTY BLOB.
   *
   * Most books have no jacket, and `cover.read` says so with an empty stream.
   * Minting a URL for an empty blob would give the cell an `<img>` that fails
   * to decode — a broken-image glyph exactly where the tint belongs.
   */
  it('answers null for a book with no jacket, minting nothing', async () => {
    expect(await remoteCovers(shelfOf({ a: '' }))('a')).toBeNull()
    expect(minted).toEqual([])
  })

  /* A FAILURE IS ALSO NULL — the shelf may be gone, and a rejected promise here
     would break a shelf of 1 961 rows rather than draw 1 961 tints. */
  it('answers null when the channel fails', async () => {
    expect(await remoteCovers(shelfOf({}))('missing')).toBeNull()
    expect(minted).toEqual([])
  })

  /* ...BUT IT IS REPORTED. This is the only place the two nulls differ, so a
     silent catch would make a dead channel indistinguishable from a library of
     books with no artwork. */
  it('reports a failure to the console, and says nothing for an ordinary absence', async () => {
    await remoteCovers(shelfOf({}))('missing')
    expect(console.error).toHaveBeenCalledTimes(1)
    expect(String((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0])).toContain(
      'missing',
    )

    vi.mocked(console.error).mockClear()
    await remoteCovers(shelfOf({ a: '' }))('a')
    expect(console.error).not.toHaveBeenCalled()
  })

  /**
   * ⚠️ **BYTES ARE JOINED IN ORDER OR NOT AT ALL.**
   *
   * The assembly appended every `bytes` it could decode and ignored `bookId`
   * and `offset` entirely, so a gap, a duplicate, a reordering, or bytes
   * belonging to ANOTHER book were concatenated into one blob and handed to
   * `URL.createObjectURL` — which yields a picture rather than an error. A
   * corrupt jacket is the only failure here that looks like a jacket.
   *
   * `null` is the honest answer for bytes this client cannot trust: it draws
   * the tint, which is where a book with no artwork lands too.
   */
  const streamOf = (...chunks: readonly unknown[]) =>
    ({
      call: async () => {
        throw new Error('unused')
      },
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield chunks
        },
      }),
      close: () => {},
    }) as unknown as ShelfChannel

  it('refuses a stream whose offsets skip a gap', async () => {
    const gapped = streamOf(
      { bookId: 'a', offset: 0, bytes: btoa('ab') },
      /* 2 is where the next chunk belongs; 4 means two bytes never arrived. */
      { bookId: 'a', offset: 4, bytes: btoa('cd') },
    )
    expect(await remoteCovers(gapped)('a')).toBeNull()
  })

  it('refuses a stream that repeats a chunk', async () => {
    const repeated = streamOf(
      { bookId: 'a', offset: 0, bytes: btoa('ab') },
      { bookId: 'a', offset: 0, bytes: btoa('ab') },
    )
    expect(await remoteCovers(repeated)('a')).toBeNull()
  })

  it('refuses a stream that arrives out of order', async () => {
    const reordered = streamOf(
      { bookId: 'a', offset: 2, bytes: btoa('cd') },
      { bookId: 'a', offset: 0, bytes: btoa('ab') },
    )
    expect(await remoteCovers(reordered)('a')).toBeNull()
  })

  it('refuses bytes that belong to another book', async () => {
    const wrong = streamOf(
      { bookId: 'a', offset: 0, bytes: btoa('ab') },
      { bookId: 'b', offset: 2, bytes: btoa('cd') },
    )
    expect(await remoteCovers(wrong)('a')).toBeNull()
  })

  it('joins a contiguous stream, so the refusals above are about the disorder', async () => {
    const good = streamOf(
      { bookId: 'a', offset: 0, bytes: btoa('ab') },
      { bookId: 'a', offset: 2, bytes: btoa('cd') },
    )
    expect(await remoteCovers(good)('a')).toBe('blob:cover-0')
    expect(await lastBlob?.text()).toBe('abcd')
  })

  /* A ROW THAT IS NOT A CHUNK IS SKIPPED, not thrown on. A shelf a version
     ahead may send a field this build does not know; dropping the row keeps the
     cover it did send. */
  it('ignores anything in the stream that is not a chunk', async () => {
    const odd = {
      call: async () => {
        throw new Error('unused')
      },
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield [null, 7, 'text', { bookId: 'a', offset: 0 }, { bookId: 'a', offset: 0, bytes: btoa('ok') }]
        },
      }),
      close: () => {},
    } as unknown as ShelfChannel
    expect(await remoteCovers(odd)('a')).toBe('blob:cover-0')
    expect(await lastBlob?.text()).toBe('ok')
  })
})
