import {
  contentPathIn,
  readOwnedBook,
  readRangeOf,
  storedBookName,
  type IndexFs,
  type IndexedBook,
  type SizePort,
} from '../../kernel'
import type { ContentFacts, RemoteContent } from '../web/content'

/**
 * A book's bytes, off THIS DEVICE'S OWN DISK.
 *
 * ## The same contract, the other implementation
 *
 * `RemoteContent` is the browser client's seam — `locate`, `readRange`,
 * `fileOf` — and it is spelled in terms of what a reader needs rather than
 * where the bytes are, so the phone answers it from the vault where the
 * browser answers it over a WebSocket. That is the whole reason the phone can
 * mount `Reader` rather than growing a second one: the reader was already
 * parameterised over this, `MarksStore` and `ReadingPositions`, and none of
 * the three names a transport.
 *
 * ⚠️ **THE ASYMMETRY THAT MATTERS IS `expect`.** Over a socket it guards
 * against the shelf serving a second version of a book mid-read — a document
 * with pages from two versions, assembled with no check firing. On local disk
 * there is no server to disagree with, and the file cannot change under a read
 * without the reader doing it. So it is accepted and not enforced here, which
 * is stated rather than left as an omission: a caller that relies on this
 * implementation to refuse a changed book will not be refused.
 *
 * ## Why a range transport at all, with no network
 *
 * Because the cost the range path avoids is MEMORY, not bandwidth, and a phone
 * has less of it than the laptop this was written for. `useBookSource` hands
 * pdf.js a ranged source so it reads the pages it draws; the alternative is a
 * 300 MB scanned book resident in a webview that the OS will kill for it.
 * `fs.readRange` is implemented by the real Tauri filesystem, so the O(n)
 * fallback in `readRangeOf` is not what runs here.
 */

export interface LocalContentDeps {
  /** The library's filesystem. `RemoteContent` cannot be answered without one. */
  readonly fs: IndexFs
  /** This book's row, or undefined when the shelf has never heard of it. */
  readonly bookOf: (bookId: string) => IndexedBook | undefined
  /**
   * The size port, or null.
   *
   * NULL IS A REAL ANSWER and `ContentFacts.size` carries it through: a host
   * that binds no size port makes `useBookSource` fall back to the whole file,
   * which is slower and correct. The desktop app did exactly that for the
   * whole of phase 11, which is why the null branch is load-bearing rather
   * than defensive.
   */
  readonly sizes: SizePort | null
}

/** `RemoteContent` over the device's own vault. */
export function localContent({ fs, bookOf, sizes }: LocalContentDeps): RemoteContent {
  /* The stored path for a book, and the name the PARSER should route on.
     They differ on purpose: the vault stores `content.<ext>` so two copies
     cannot collide, and foliate routes on the original filename's suffix and
     shows it when a book declares no title. `storedBookName` is the same
     reconstruction the desktop's `openStored` uses — not a second one. */
  const pathAndName = (bookId: string): { path: string; name: string } | null => {
    const entry = bookOf(bookId)
    if (entry === undefined) return null
    const name = storedBookName(entry)
    return { path: contentPathIn(bookId, name), name }
  }

  return {
    locate: async (bookId): Promise<ContentFacts> => {
      const entry = bookOf(bookId)
      if (entry === undefined) return { here: false, ext: null, size: null, contentHash: null }
      /* `hasContent` is DERIVED from the folder and cached by the index, and
         it is undefined on a record written before the flag existed. Absent
         means "not known to be missing" — treating it as false would hide
         every pre-flag book behind a "no copy" the folder disagrees with. */
      const here = entry.hasContent ?? true
      const size = sizes === null ? null : await sizes.contentBytes(bookId).catch(() => null)
      return {
        here,
        ext: entry.ext ?? null,
        size,
        /* Computed by the peer plugin and never in TypeScript, so it is
           absent on a book this device has not hashed. */
        contentHash: entry.contentHash ?? null,
      }
    },

    readRange: async (bookId, offset, length, _expect): Promise<Uint8Array> => {
      const found = pathAndName(bookId)
      if (found === null) throw new Error(`no book on this device with id ${JSON.stringify(bookId)}`)
      /* A SHORT ANSWER IS NOT AN ERROR — the contract's own words, and
         `readRangeOf` already honours it. A caller that treated one as a
         failure could not read the last page of any book. */
      return await readRangeOf(fs, found.path, offset, length)
    },

    fileOf: async (bookId, name): Promise<File> => {
      const found = pathAndName(bookId)
      /* The CALLER's name wins when it has one: it is what the shelf row said
         the book was called, and the parser routes on its suffix. Falling back
         to the stored reconstruction rather than to the vault's hashed name,
         which would route every book to the same unsupported type. */
      const path = found?.path ?? contentPathIn(bookId, name)
      return await readOwnedBook(fs, path, name || (found?.name ?? name))
    },
  }
}
