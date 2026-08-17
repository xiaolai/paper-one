import { useEffect, useRef, useState } from 'react'
import { coverTintFor } from '../lib/bookAccent'
import { tauriVaultFs } from '../lib/bookVault'
import { coverUrl } from '../lib/coverArt'
import type { IndexedBook } from '../lib/bookIndex'
import { coverPathIn } from '../lib/bookFolder'

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
 * book that genuinely has no artwork, which is most PDFs. It shows immediately
 * and stays if no jacket arrives, so a shelf never flashes empty rectangles on
 * the way to being drawn.
 */
export function BookCover({
  book,
  title,
  className,
  titleClassName,
}: {
  book: IndexedBook
  title: string
  className?: string | undefined
  titleClassName?: string | undefined
}) {
  const [url, setUrl] = useState<string | null>(null)
  /* DERIVED, not stored. A cover lives at a known path inside the book's own
   * folder, so there is no field to keep in step and no way for a row to claim
   * a jacket that is not there — which is what a stale `cover` field did. */
  const at = coverPathIn(book.bookId)

  /* The URL this cell created, so the error handler below can release it. The
   * effect's own `mine` is not reachable from there and the effect does not
   * re-run on a decode failure, so without this the bytes of every unreadable
   * cover stayed held until the whole cell unmounted. */
  const held = useRef<string | null>(null)

  useEffect(() => {
    let revoked = false
    let mine: string | null = null
    void coverUrl(tauriVaultFs, at).then((next) => {
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
      if (mine) URL.revokeObjectURL(mine)
      held.current = null
      setUrl(null)
    }
  }, [at])

  return (
    <span className={className} style={{ background: coverTintFor(book.bookId) }}>
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
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <span className={titleClassName}>{title}</span>
      )}
    </span>
  )
}
