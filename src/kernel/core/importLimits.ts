/**
 * How much of a reader-chosen file this app will take into memory.
 *
 * ## Why a ceiling exists at all
 *
 * The marginalia and tag importers read a picked file WHOLE and then parse it,
 * and the browser client's `fileOf` collects an entire book into an array of
 * chunks before constructing a `File`. In each case the size is decided by
 * something outside the app — a file the reader picked, or a book on a shelf
 * that may be a 300 MB scan — and nothing bounded it. A crafted archive, or an
 * ordinary large one picked by mistake, exhausted memory or froze the interface
 * before a single field had been validated.
 *
 * The order is the point: a bound that runs AFTER the read has not bounded
 * anything.
 *
 * ## The numbers
 *
 * `ARCHIVE_MAX_BYTES` is for a marks or tags export — JSON this app itself
 * wrote. A shelf of 1,961 books with marks throughout produces a few megabytes;
 * 64 MiB is far past any real one and far below what hurts.
 *
 * `ARCHIVE_MAX_ROWS` is the second half, and it is not the same question. A
 * file can be small and still describe a million rows — JSON is compact — and
 * what costs is building them, not reading them.
 */
export const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024
export const ARCHIVE_MAX_ROWS = 200_000

/**
 * A book's bytes, held in memory while a `File` is built around them.
 *
 * EPUB and MOBI are assembled whole because their parsers walk the archive
 * freely; a PDF is not, and takes the range transport instead. So this bounds
 * the formats that genuinely need to be resident — and 512 MiB is past every
 * real EPUB while still refusing a shelf that answers with something absurd
 * before a phone runs out of memory.
 */
export const BOOK_MAX_BYTES = 512 * 1024 * 1024

/** A size that exceeds `limit`, said the way a reader can act on. */
export function tooLarge(what: string, bytes: number, limit: number): Error {
  const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`
  return new Error(
    `${what} is ${mb(bytes)}, which is past the ${mb(limit)} this can hold in memory.`,
  )
}
