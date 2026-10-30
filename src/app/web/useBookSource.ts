import { messageOf } from '../../kernel'
import { useEffect, useRef, useState } from 'react'
import type { RemoteContent } from './content'

/**
 * WHICH PATH A BOOK TAKES OUT OF THE SHELF, and what happens when it cannot say.
 *
 * ## Why this is its own module
 *
 * `Reader` was six hundred and fifty lines holding content acquisition,
 * preferences, gestures, marks, search, navigation and four tool panes in one
 * function — and this is the piece with the least to do with any of the others.
 * It reads `content.locate`, decides between a range transport and a whole
 * file, and hands back three states. Nothing else in the component needs to see
 * how, and nothing here needs to see the rest.
 *
 * ## The decision
 *
 * An EPUB is assembled into a `File`: a zip's central directory is at the end
 * and foliate walks the archive freely, so there is no useful way to read one
 * in pieces. A PDF is handed a RANGE TRANSPORT instead, so pdf.js asks the
 * shelf for the byte ranges of the page it is drawing rather than the file —
 * the difference between opening a 300 MB scanned book and downloading one.
 *
 * ## A shelf that cannot measure
 *
 * pdf.js is told a length before it asks for a byte, and `content.locate`
 * answers `size: null` whenever the shelf binds no size port — which the
 * desktop app did for the whole of phase 11. A transport built on `null` opens
 * an empty document with no error anywhere, so the fallback is the whole file:
 * slower and correct, which is the right way round.
 */

/** What is known about the book while it is being fetched. */
export type Opening =
  | { readonly kind: 'locating' }
  /* A `File` for an EPUB, or a ranged source for a PDF. Spelled structurally
   * rather than imported: `RangedSource` lives in `formats.ts`, which is not on
   * the browser client's short list of kernel modules, and the shape is two
   * fields. `FoliateView` accepts either. */
  | { readonly kind: 'reading'; readonly source: File | { readonly range: object; readonly name: string } }
  | { readonly kind: 'failed'; readonly why: string }

/**
 * Fetch this book, by whichever route its format wants.
 *
 * `onProblem` is separate from the `failed` state on purpose: a range read that
 * fails happens LONG after the book opened, so it is not a failure to open. It
 * is a message for a reader who is already looking at a page — see `Reader`'s
 * own note on `problem`.
 */
export function useBookSource(
  content: RemoteContent,
  bookId: string,
  name: string,
  onProblem: (why: string) => void,
): Opening {
  const [opening, setOpening] = useState<Opening>({ kind: 'locating' })

  /* `onProblem` IS READ THROUGH A REF, not listed as a dependency. A caller
     writing it inline gives a new identity every render, and this effect
     re-running is a re-fetch of the whole book. */
  const problem = useRef(onProblem)
  problem.current = onProblem

  useEffect(() => {
    let live = true
    setOpening({ kind: 'locating' })
    void (async () => {
      try {
        const facts = await content.locate(bookId)
        if (!live) return
        if (!facts.here) {
          setOpening({ kind: 'failed', why: 'Your library does not have this book’s pages.' })
          return
        }
        /* A PDF GOES THROUGH THE TRANSPORT — but only when the shelf could
         * measure it. pdf.js is told a length before it asks for a byte, and a
         * shelf that answers `null` has no length to give; falling back to the
         * whole file is slower and correct, which is the right way round. */
        /* THE NAME A PARSER ROUTES ON, rebuilt from what the shelf stores.
         * The shelf sends a TITLE — "Moby-Dick" — and every parser Paper uses
         * routes on the suffix; foliate rejects a name without one as an
         * unsupported type. `content.locate` knows the stored extension, which
         * is exactly what `storedBookName` does on the desktop side. */
        const filename = facts.ext === null ? name : `${name}.${facts.ext}`

        if (facts.ext === 'pdf' && facts.size !== null) {
          const { pdfRangeTransport } = await import('./pdfRange')
          const range = await pdfRangeTransport(content, bookId, facts.size, {
            onFailure: (cause) =>
              problem.current(messageOf(cause)),
            /* THE VERSION THIS OPEN SAW. Every range the document asks for,
               for as long as the reader has it open, is read against the book
               these facts describe — not against whatever a later `locate`
               finds. See `PdfRangeOptions.contentHash`. */
            contentHash: facts.contentHash,
          })
          if (!live) return
          setOpening({ kind: 'reading', source: { range, name: filename } })
          return
        }
        const file = await content.fileOf(bookId, filename)
        if (!live) return
        setOpening({ kind: 'reading', source: file })
      } catch (thrown) {
        if (!live) return
        setOpening({ kind: 'failed', why: messageOf(thrown) })
      }
    })()
    return () => {
      live = false
    }
  }, [content, bookId, name])

  return opening
}
