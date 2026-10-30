import { useEffect, useRef, useState } from 'react'
import { coverTintFor } from '../../core/bookAccent'
import type { CoverSource } from '../../core/coverArt'
import type { IndexedBook } from '../../core/bookIndex'

/**
 * A book's jacket, or the tint that stands in for one.
 *
 * Its own component because loading a cover is asynchronous and has to be
 * CLEANED UP, and a shelf that does that inline gets it wrong: a blob URL is a
 * document-lifetime reference, so one leaked per cell per render is a leak that
 * grows with scrolling and never shrinks. Keeping it here means the revoke sits
 * next to the create, in the same effect, with no way to add a cell that
 * forgets.
 *
 * The tint is not a placeholder to be replaced later — it is the answer for a
 * book that genuinely has no artwork: an EPUB that ships no cover resource, or
 * a jacket whose bytes will not decode. It shows immediately and stays if no
 * jacket arrives, so a shelf never flashes empty rectangles on the way to being
 * drawn.
 *
 * IT USED TO SAY "which is most PDFs", and that was a gap wearing the costume
 * of a fallback. PDFs had no jacket because Paper's own PDF adapter never
 * implemented `getCover` — not because the format lacks one — and since
 * `session.ts` asks for it with an optional call, the missing method looked
 * exactly like a book with no picture. A PDF's first page renders now, so the
 * only PDFs that land here are the ones whose first page will not.
 */
export function BookCover({
  book,
  title,
  coverFor,
  className,
  tintedClassName,
  titleClassName,
}: {
  book: IndexedBook
  title: string
  /**
   * Where the jacket comes from — a function, not a filesystem.
   *
   * ⚠️ **THIS WAS `tauriVaultFs`, IMPORTED HERE**, and that one import made
   * `BookCell`, `BookRow` and the whole `Library` screen impossible to bundle
   * for a browser. A cover is the only thing on the shelf that needs bytes off
   * a disk, and it took the entire shelf down with it.
   *
   * Absent means there is nowhere to fetch from — a browser before there is a
   * `cover.read` service — and the tint below is drawn instead. That is not a
   * degraded state: it is the same picture a book with no jacket gets, which
   * is most of them.
   */
  coverFor?: CoverSource | undefined
  className?: string | undefined
  /** Added to the box only while it is drawing the TINT — see the return. */
  tintedClassName?: string | undefined
  titleClassName?: string | undefined
}) {
  const [url, setUrl] = useState<string | null>(null)
  /* DERIVED, not stored. A cover lives at a known path inside the book's own
   * folder, so there is no field to keep in step and no way for a row to claim
   * a jacket that is not there — which is what a stale `cover` field did.
   *
   * The ID rather than the path, because there are now two names it could be
   * under: `cover.jpg`, and `cover.webp` in a library written before that name
   * was made honest. `coverIn` is the one place that knows both. */
  const at = book.bookId

  /* The URL this cell created, so the error handler below can release it. The
   * effect's own `mine` is not reachable from there and the effect does not
   * re-run on a decode failure, so without this the bytes of every unreadable
   * cover stayed held until the whole cell unmounted. */
  const held = useRef<string | null>(null)

  useEffect(() => {
    let revoked = false
    let mine: string | null = null
    /* NOTHING TO ASK. Without a source there is no jacket to wait for, so the
     * tint is drawn at once rather than after a promise that cannot resolve. */
    if (coverFor === undefined) return
    /* ⚠️ **THE READ USED TO OUTLIVE THE CELL.** Cleanup revoked whatever URL
     * eventually arrived, which stopped the leak — and left the READ running.
     * This shelf is virtualised, so a flick through two thousand rows unmounts
     * hundreds of cells with a jacket in flight, and over a channel each one is
     * a `cover.read` stream still pulling and decoding chunks nobody will look
     * at, against a byte budget shared with the book being read.
     *
     * Revoking is still here as well, and both are needed: the signal stops
     * work that has not happened, `revoked` catches a source that had already
     * finished or that cannot honour a signal at all. */
    const stop = new AbortController()
    void coverFor(at, stop.signal).then((next) => {
      if (!next) return
      /* The cell may have been unmounted, or pointed at another book, while the
       * bytes were being read. Revoking immediately rather than setting state is
       * what keeps a fast scroll from leaving a trail of live URLs behind it. */
      if (revoked) {
        URL.revokeObjectURL(next)
        return
      }
      mine = next
      held.current = next
      setUrl(next)
    })
    return () => {
      revoked = true
      stop.abort()
      if (mine) URL.revokeObjectURL(mine)
      held.current = null
      setUrl(null)
    }
    /* ⚠️ `coverFor` MUST BE A STABLE REFERENCE, and that is the caller's job.
     * It is in the dependency list because leaving it out captures the first
     * one forever — but an inline arrow gives a new identity every render, and
     * on a 1 961-row shelf that is a refetch and a revoked object URL per row
     * per render. Bind it once at module scope, or in a `useCallback`. */
  }, [at, coverFor])

  /* THE TINT IS THE JACKET, when there is no artwork — so it fills the box,
   * takes the jacket's rounding and shadow, and carries the title. When there
   * IS artwork the box is an invisible well and the image is the jacket, at
   * its own proportion, standing on the well's floor. The tint therefore comes
   * and goes with the artwork rather than sitting behind it: a tinted rectangle
   * showing above a short jacket would be a second, wrong cover. */
  const tinted = !url
  return (
    <span
      className={tinted && tintedClassName ? `${className ?? ''} ${tintedClassName}` : className}
      style={tinted ? { background: coverTintFor(book.bookId) } : undefined}
    >
      {url ? (
        <img
          src={url}
          alt=""
          /* EMPTY alt, deliberately. The title is right beneath it in the same
           * button, so a screen reader announcing the jacket would read the book
           * twice — and "cover of X" is decoration, not information. */
          /* AND A FALLBACK WHEN THE BYTES WILL NOT DECODE. There was none, so a
           * truncated or corrupt `cover.webp` drew the browser's broken-image
           * glyph — while the tinted panel with the title on it, which exists
           * for exactly this, sat behind it unused. */
          onError={() => {
            // Released, not merely forgotten: the bytes stay held otherwise.
            if (held.current) URL.revokeObjectURL(held.current)
            held.current = null
            setUrl(null)
          }}
          /* STYLED BY THE STYLESHEET, not from here. These were inline —
             `width/height: 100%` — and inline styles beat any rule the caller
             writes, which is what made the jacket size its own container: the
             image's 100% resolved against a box that was still sizing itself to
             the image, and the cover came out 189px wide inside a 173px cell.
             The caller owns this element's box now, through `.cover img`. */
        />
      ) : (
        <span className={titleClassName}>{title}</span>
      )}
    </span>
  )
}
