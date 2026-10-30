import type { CoverSource } from '../../kernel/ui/browser'
import type { ShelfChannel } from './channel'

/**
 * The shelf's jackets, over the channel (phase 19, WI-19.8).
 *
 * `screens/Library.tsx` draws a cover through a `CoverSource` — "a URL for this
 * book, or null" — and the desktop binds one over the local vault. A browser
 * has no vault, so until `cover.read` existed every row on a phone drew a
 * tinted rectangle. This is the browser's binding for the same seam.
 *
 * ## An object URL, and who revokes it
 *
 * `BookCover` owns the lifetime: it revokes what it was given when the cell
 * unmounts or points at another book. So this MINTS and does not track — the
 * contract is the same one `coverIn` has on the desktop, which is why the
 * component needs no branch for which host it is on.
 *
 * ## Absent is null, not a throw
 *
 * Most books have no jacket, and `cover.read` says so with an empty stream
 * rather than a refusal. A rejected promise here would turn the ordinary case
 * into an error for the 1 961 rows that have no artwork.
 *
 * ⚠️ **A FAILURE IS ALSO NULL, AND IS REPORTED.** A dropped channel and a book
 * with no cover produce the same picture — the tint — so the difference has to
 * reach somewhere or it reaches nowhere. It goes to the console; it must not go
 * to the reader, because a shelf that shows a banner per missing jacket is
 * unusable on a library this size.
 */
export function remoteCovers(channel: ShelfChannel): CoverSource {
  return async (bookId: string, signal?: AbortSignal): Promise<string | null> => {
    try {
      /* ⚠️ **THE CHUNKS ARE CHECKED, AND THEY USED TO BE CONCATENATED BLIND.**
       *
       * This read `bytes` and appended, ignoring `bookId` and `offset` and
       * skipping any chunk it could not decode. So a gap (a skipped chunk), a
       * duplicate, a reordering, or bytes belonging to ANOTHER book were joined
       * into one blob and handed to `URL.createObjectURL` — which produces a
       * picture rather than an error. A corrupt jacket is the one failure mode
       * here that looks like a jacket.
       *
       * Contiguity is the check: each chunk must start where the last ended,
       * and must be this book's. Anything else abandons the cover and reports,
       * which lands on the tint — the same place a book with no artwork lands,
       * and the honest answer for bytes this client cannot trust. */
      const parts: Uint8Array[] = []
      let at = 0
      /* ⚠️ **THE SIGNAL IS THE POINT OF THIS BEING A STREAM.** The shelf is
         virtualised: a cell scrolled past unmounts, and without this the read
         kept going — every chunk of a jacket nobody will look at, decoded,
         against the same stream byte budget as the book being read. A flick
         through two thousand rows started hundreds of these and ended none. */
      for await (const page of channel.stream('cover.read', { book: bookId }, signal ? { signal } : {})) {
        for (const chunk of page as readonly unknown[]) {
          /* A ROW CARRYING NO BYTES IS SKIPPED, and only that. A shelf a
             version ahead may send a shape this build does not know; it
             contributes nothing to the image, so ignoring it keeps the cover
             that WAS sent. Every row that does carry bytes is checked. */
          if (typeof chunk !== 'object' || chunk === null) continue
          const row = chunk as Record<string, unknown>
          const bytes = row['bytes']
          if (typeof bytes !== 'string') continue

          if (row['bookId'] !== undefined && row['bookId'] !== bookId) {
            throw new Error(`cover.read sent bytes for ${String(row['bookId'])} while reading ${bookId}`)
          }
          const offset = row['offset']
          if (offset !== undefined && (typeof offset !== 'number' || offset !== at)) {
            throw new Error(`cover.read is not contiguous: expected ${at}, got ${String(offset)}`)
          }
          const binary = atob(bytes)
          const out = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
          parts.push(out)
          at += out.length
        }
      }
      /* NO BYTES IS NO JACKET. Minting a URL for an empty blob would give the
       * cell an `<img>` that fails to decode, which draws a broken-image glyph
       * where the tint belongs. */
      if (parts.length === 0) return null
      /* ABANDONED READS MINT NOTHING. `BookCover` revokes what it is GIVEN, so
         a URL created after the caller walked away belongs to nobody and is
         held for the life of the document — the exact leak the abort exists to
         prevent, reintroduced one line later. */
      if (signal?.aborted) return null
      return URL.createObjectURL(new Blob(parts as BlobPart[]))
    } catch (cause) {
      /* AN ABORT IS NOT A FAILURE. The caller asked for this; reporting it
         would put a line in the console for every row a reader scrolls past. */
      if (signal?.aborted) return null
      console.error(`Paper: could not read the cover for ${bookId}`, cause)
      return null
    }
  }
}
