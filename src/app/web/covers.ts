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
export function remoteCovers(channel: ShelfChannel): (bookId: string) => Promise<string | null> {
  return async (bookId: string): Promise<string | null> => {
    try {
      const parts: Uint8Array[] = []
      for await (const page of channel.stream('cover.read', { book: bookId })) {
        for (const chunk of page as readonly unknown[]) {
          if (typeof chunk !== 'object' || chunk === null) continue
          const bytes = (chunk as Record<string, unknown>)['bytes']
          if (typeof bytes !== 'string') continue
          const binary = atob(bytes)
          const out = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
          parts.push(out)
        }
      }
      /* NO BYTES IS NO JACKET. Minting a URL for an empty blob would give the
       * cell an `<img>` that fails to decode, which draws a broken-image glyph
       * where the tint belongs. */
      if (parts.length === 0) return null
      return URL.createObjectURL(new Blob(parts as BlobPart[]))
    } catch (cause) {
      console.error(`Paper: could not read the cover for ${bookId}`, cause)
      return null
    }
  }
}
