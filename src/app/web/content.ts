import type { ShelfChannel } from './channel'

/**
 * A book's bytes, over the channel (phase 18, WI-18.8).
 *
 * ## Why this is not a download
 *
 * The thin client holds no replica. It does not own a book, cache one, or
 * resume one; it asks for the bytes of the frame being rendered and forgets
 * them. That is what makes `content.read` safe to add beside the peer plugin's
 * blob path rather than a second copy of it: the blob path is a TRANSFER —
 * durable, resumable, BLAKE3-verified, with partial-file state on disk — and
 * this is a READ. Integrity comes from the TLS the client cannot work without.
 *
 * ## Why ranged, and not "fetch the book"
 *
 * A scanned PDF is hundreds of megabytes. Buffering one whole to open it means
 * a phone holds all of it in memory before the first page appears, and pdf.js
 * is built not to need that — it asks for the byte ranges its current page
 * lives in. `readRange` is what backs that.
 *
 * EPUBs go the other way: foliate wants a `Blob`, because a zip's central
 * directory is at the END and the reader walks the archive freely. So `fileOf`
 * assembles. An EPUB is megabytes where a PDF is hundreds, which is the whole
 * reason one shape does not serve both.
 *
 * ## The chunk contract
 *
 * `content.read` yields pages of `{ bookId, offset, bytes }`, base64. It
 * answers FEWER bytes than asked at the end of a file and NOTHING past it —
 * the POSIX contract — so a short answer here is the end of the book and not
 * an error. Nothing below treats it as one.
 */

/** One chunk, as `content.read` sends it. */
interface Chunk {
  readonly offset: number
  readonly bytes: string
}

/** What `content.locate` says about a book's bytes. */
export interface ContentFacts {
  /** Whether the shelf holds them at all. */
  readonly here: boolean
  /** The stored extension — `epub`, `pdf`, … — or null. */
  readonly ext: string | null
  /**
   * Bytes, or null when the shelf cannot say.
   *
   * NULL IS A REAL ANSWER and callers must branch on it. A shelf that binds no
   * size port answers null for every book, which is what the desktop app did
   * for the whole of phase 11 — so a range transport built on the assumption
   * that a number always arrives would have worked in every test and against
   * nothing.
   */
  readonly size: number | null
}

/** Base64 to bytes, without a `Buffer` and without a per-byte string. */
function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at += 1) out[at] = binary.charCodeAt(at)
  return out
}

/** One `Uint8Array` from many, in order. */
function joined(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const all = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.length
  }
  return all
}

/** A chunk, or null for anything that is not one. */
function chunkOf(item: unknown): Chunk | null {
  if (typeof item !== 'object' || item === null) return null
  const row = item as Record<string, unknown>
  if (typeof row['offset'] !== 'number' || typeof row['bytes'] !== 'string') return null
  return { offset: row['offset'], bytes: row['bytes'] }
}

export interface RemoteContent {
  /** What the shelf says about this book's bytes, before asking for any. */
  locate(bookId: string): Promise<ContentFacts>
  /**
   * `length` bytes from `offset`, or fewer at the end of the file.
   *
   * A SHORT ANSWER IS NOT AN ERROR — see the header. A caller that treats one
   * as a failure cannot read the last page of any book.
   */
  readRange(bookId: string, offset: number, length: number): Promise<Uint8Array>
  /** The whole book, as the `File` foliate opens. */
  fileOf(bookId: string, name: string): Promise<File>
}

export function remoteContent(channel: ShelfChannel): RemoteContent {
  const collect = async (bookId: string, body: Record<string, unknown>): Promise<Uint8Array[]> => {
    const parts: Uint8Array[] = []
    for await (const page of channel.stream('content.read', { book: bookId, ...body })) {
      /* PAGES, not chunks. Every stream in the service table yields an array of
       * rows; a reader that assumed a bare object worked against one shelf and
       * silently read nothing from another. Flattened here so both shapes land
       * in the same place. */
      const items = Array.isArray(page) ? page : [page]
      for (const item of items) {
        const chunk = chunkOf(item)
        if (chunk === null) continue
        parts.push(bytesOf(chunk.bytes))
      }
    }
    return parts
  }

  return {
    locate: async (bookId) => {
      const answer = (await channel.call('content.locate', { book: bookId })) as Record<string, unknown>
      return {
        here: answer['here'] === true,
        ext: typeof answer['ext'] === 'string' ? answer['ext'] : null,
        size: typeof answer['size'] === 'number' ? answer['size'] : null,
      }
    },

    readRange: async (bookId, offset, length) => {
      /* REFUSED HERE rather than sent. The service would refuse a negative
       * anyway, but the failure would arrive as a protocol error from a shelf
       * rather than as the caller's own mistake — and pdf.js asks for ranges
       * computed from a length this client supplied, so a bad one is this
       * side's bug to report. */
      if (offset < 0 || length < 0) {
        throw new Error(`content.read: offset and length must not be negative (${offset}, ${length})`)
      }
      if (length === 0) return new Uint8Array(0)
      return joined(await collect(bookId, { offset, length }))
    },

    fileOf: async (bookId, name) => {
      const parts = await collect(bookId, {})
      /* THE NAME THE BOOK ARRIVED WITH, not the vault's. Every parser Paper
       * uses routes on the EXTENSION, and foliate rejects a name with no
       * suffix as an unsupported type — the same reason `readOwnedBook` takes
       * a name on the desktop side. */
      return new File(parts as BlobPart[], name)
    },
  }
}
