import type { PDFDataRangeTransport } from 'pdfjs-dist'
import { isRetryable, type RemoteContent } from './content'

/**
 * pdf.js's range transport, backed by `content.read` (phase 18, WI-18.8).
 *
 * ## Why a PDF gets this and an EPUB gets a `Blob`
 *
 * A scanned book is hundreds of megabytes of JBIG2 with a text layer over it.
 * Handing pdf.js a `Blob` means the phone holds every byte of that before the
 * first page appears — and pdf.js is built not to need it: given a transport
 * and a LENGTH, it asks only for the ranges the page being rendered lives in.
 *
 * An EPUB cannot work that way through foliate: a zip's central directory is
 * at the end and the reader walks the archive freely. It is also megabytes
 * rather than hundreds of them. One shape does not serve both, which is why
 * there are two.
 *
 * ## The length has to be exact
 *
 * pdf.js clamps every request to `length` and reads the trailer by seeking
 * backwards from it. A length that is too large makes the first read run off
 * the end of the file and the document fail to parse; too small and the
 * cross-reference table is simply not there. It comes from `content.locate`,
 * which is why the desktop app had to start binding a size port — it answered
 * `size: null` for every book, and null is not a length.
 *
 * ## Failure has nowhere to go, so it is given somewhere
 *
 * `PDFDataRangeTransport` has an `onDataRange` and no `onError`. A read that
 * rejects therefore delivers nothing, and pdf.js waits for a chunk that is
 * never coming — a book that hangs on a blank page with no error anywhere,
 * which is the single worst way for a network failure to present. `onFailure`
 * exists for that: the reader is told, and can say so.
 *
 * ⚠️ It is REQUIRED. It was optional, and an optional remedy for a silent hang
 * is a silent hang with a note beside it — the default shape of the API was the
 * broken one. See `PdfRangeOptions`.
 *
 * ## Why the import is inside the function
 *
 * pdf.js is half a megabyte, and this module would otherwise pull it into the
 * bundle for every reader — including one on mobile data opening an EPUB, who
 * will never touch a line of it. `makePdf.ts` is lazily imported for exactly
 * this reason and says so; a transport that defeated it from the other side
 * would have undone that quietly. The type is a `import type`, which erases.
 */

export interface PdfRangeOptions {
  /**
   * Called when a range read rejects.
   *
   * ⚠️ **REQUIRED, AND IT WAS OPTIONAL.** The header above explains at length
   * that `PDFDataRangeTransport` has no `onError`, so a rejected read delivers
   * nothing and pdf.js waits forever for a chunk that is not coming — a book
   * hanging on a blank page with no error anywhere. This callback is the entire
   * remedy for that, and making it optional put the hang back in the DEFAULT
   * API: the shape a caller reaches for first was the broken one.
   *
   * A caller with nothing useful to say still has to say so out loud. There is
   * no correct silent handling of this, which is what a required parameter
   * means.
   */
  readonly onFailure: (cause: unknown) => void
}

/**
 * A transport for `bookId`, `size` bytes long.
 *
 * `initialData` is null: this client has no head start on the file, and
 * claiming otherwise would have pdf.js parse zeros as a header.
 */
export async function pdfRangeTransport(
  content: RemoteContent,
  bookId: string,
  size: number,
  /* NO DEFAULT. `= {}` made the silent-and-terminal case the one a caller got
     by writing the shortest thing that compiled. */
  options: PdfRangeOptions,
): Promise<PDFDataRangeTransport> {
  /* THE SAME MODULE INSTANCE `makePdf` will use. `getDocument` accepts a range
   * transport only when it passes `instanceof PDFDataRangeTransport`, so a
   * second copy of pdf.js in the graph would be refused — silently, by falling
   * back to no transport at all and reading the whole file. One specifier,
   * resolved once. */
  const { PDFDataRangeTransport } = await import('pdfjs-dist')

  class ShelfRange extends PDFDataRangeTransport {
    /* SET BY `abort`, and checked after every await. A reader who closes a book
     * mid-page leaves reads in flight; delivering one afterwards pushes bytes
     * into a document pdf.js has already torn down. */
    private stopped = false

    override requestDataRange(begin: number, end: number): void {
      /* ⚠️ **CHECKED BEFORE THE READ, AND IT USED TO BE CHECKED ONLY AFTER.**
       *
       * pdf.js does not stop asking the moment `abort()` returns: a render in
       * progress can call this afterwards. The `stopped` test lived only in the
       * `.then`, so the read was still STARTED — bytes pulled over the wire and
       * decoded for a document that is gone, against a stream budget shared
       * with the book the reader moved on to. Discarding the answer afterwards
       * hid it: nothing wrong appeared on screen, and the only cost was work.
       *
       * The check after the await stays: this one stops a read that never
       * begins, that one stops one already in flight. */
      if (this.stopped) return
      /* `end` IS EXCLUSIVE in pdf.js's contract and `content.read`'s `length`
       * is a count, so the conversion is here and stated. Off by one, this
       * drops the last byte of every range — which corrupts a cross-reference
       * table rather than raising, and presents as a PDF that "is broken". */
      /* TWO ARMS, NOT A CHAINED CATCH. A `.catch` after the `.then` also
       * caught what `onDataRange` threw — a pdf.js listener's own defect —
       * and reported it as the shelf's, ending the transport for a failure
       * that was never a read's. The rejection arm below is the READ's only;
       * a throw in delivery stays a loud, unattributed rejection, which is
       * what it is. */
      void content.readRange(bookId, begin, end - begin).then(
        (bytes) => {
          if (this.stopped) return
          this.onDataRange(begin, bytes)
        },
        (cause: unknown) => {
          if (this.stopped) return
          /* LATCHED ONLY BY A FAILURE A RETRY CANNOT CHANGE (WI-20.30). A
           * dropped socket is retryable — the envelope says so now, and the
           * content layer restarts a read that lost its channel — so ending
           * the transport on one ignored every range pdf.js asked for after
           * the shelf was back a second later: a document stuck on the page
           * it had, for good. A refusal, a missing book or a changed one is
           * terminal and ends it as before; the reader is told either way. */
          if (!isRetryable(cause)) this.stopped = true
          options.onFailure(cause)
        },
      )
    }

    override abort(): void {
      this.stopped = true
    }
  }

  return new ShelfRange(size, null)
}
