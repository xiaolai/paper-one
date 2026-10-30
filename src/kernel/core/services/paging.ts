/**
 * How a `stream` service answers (phase 11, WI-11.3).
 *
 * IN PAGES, not row by row and not all at once. Both extremes were measured
 * rather than argued: WI-8.6's first pull moved 1 959 rows, and
 *
 *   - one frame for the whole shelf would carry roughly half a megabyte of
 *     index rows on that library and would exceed `MAX_FRAME_BYTES` on a
 *     larger one. A list that only works below some unstated size is a list
 *     that fails on the library it was written for.
 *   - one frame per row is 1 959 frames, each with its own envelope header,
 *     its own JSON parse and its own trip through the router's send chain.
 *
 * A page of `PAGE_ROWS` index rows is tens of kilobytes — two orders of
 * magnitude under the cap, and two orders of magnitude fewer frames.
 *
 * THE SIGNAL IS CHECKED BETWEEN PAGES, which is what makes `cancel` mean
 * something: the router aborts the handler's signal on `cancel`, timeout and
 * disconnect, and a generator that never looked would go on producing pages
 * for a peer that has gone. Checked BEFORE each yield rather than after, so a
 * request cancelled before the first page produces no page at all.
 */

/** Rows per `stream` frame. Exported so a test can seed more than one page
 *  without hard-coding the number in two places. */
import { SERVICE_ERRORS, refuse } from './refusals'

export const PAGE_ROWS = 200

/**
 * The byte budget for one page, well under the envelope's 4 MiB frame cap.
 *
 * ROWS ALONE ARE NOT A BOUND, and that is the reason this exists. A book
 * record's text fields are capped at 500 characters each, so 200 shelf rows
 * are tens of kilobytes — but a MARK's `text` is the passage the reader
 * selected and nothing bounds it, so 200 marks are bounded by nothing at all.
 * One page over the cap does not truncate; it is `frame-too-large`, and the
 * stream stops. A byte budget makes the page size a function of what is
 * actually in it.
 *
 * 512 KiB, counted in UTF-16 CODE UNITS rather than encoded bytes — and the
 * number is chosen so that the difference cannot matter. `JSON.stringify`
 * escapes every non-ASCII character it must, and the worst honest expansion
 * from a code unit to UTF-8 is three bytes; 512 Ki units is therefore at most
 * 1.5 MiB on the wire, against a 4 MiB cap. Measuring exactly would mean
 * encoding every row twice, once to size it and once to send it.
 *
 * ONE ROW OVER THE BUDGET STILL GOES, alone. Dropping it would be a silent
 * truncation and refusing it would make one long highlight unlistable. A row
 * whose encoded form genuinely exceeds the FRAME cap — a four-million-
 * character highlight — cannot be sent at all, and the transport says
 * `frame-too-large` by name, which is a loud failure rather than a quiet one.
 */
export const PAGE_BYTES = 512 * 1024

/**
 * `rows` as pages, stopping at `limit` rows and at the first abort.
 *
 * `limit` is applied to ROWS, not pages — a caller asking for 10 gets 10, in
 * one page. A negative or fractional limit is refused by the input schema
 * before it reaches here; zero yields nothing, which is what asking for
 * nothing means.
 *
 * A page ends at `PAGE_ROWS` rows or `PAGE_BYTES` of encoded JSON, whichever
 * comes first — and a single row over the budget still goes, alone, because
 * dropping it would be a silent truncation and refusing it would make one
 * long highlight unlistable.
 */
export async function* pages<T>(
  /* AN ITERABLE, not necessarily an array. Every caller today hands over one
   * it has already built, but nothing here needs the whole sequence to exist:
   * the loop pulls one row at a time and stops the moment it is cancelled or
   * reaches the limit. Widening it costs nothing and makes "stopped early"
   * mean the rows were never produced, rather than never read. */
  rows: Iterable<T>,
  signal: AbortSignal,
  limit?: number | undefined,
): AsyncGenerator<readonly T[]> {
  /* CANCELLATION FIRST, before any work. Checking only at flush points meant
   * an already-aborted request still serialised up to a full page. */
  if (signal.aborted) return
  /* NOT `slice`. A limit of five over a two-thousand-book shelf copied five
   * rows and kept the copy for the generator's lifetime; counting is the same
   * answer with no array. No limit means "everything", which `Infinity` says
   * directly — `rows.length` said the same thing while also requiring the
   * sequence to be an array. */
  const stop = limit === undefined ? Infinity : Math.max(0, Math.floor(limit))
  let page: T[] = []
  let bytes = 0
  let taken = 0
  for (const row of rows) {
    if (taken >= stop) break
    /* CHECKED PER ROW, not only at page boundaries.
     *
     * The abort check sat beside the `yield`, so a cancellation arriving just
     * after one page was handed over let the generator build the WHOLE of the
     * next one — pulling two hundred rows and calling `JSON.stringify` on each
     * — and then discard it at the boundary. The consumer saw one page either
     * way, which is why counting yielded pages could not see this: a page's
     * worth of serialisation, done for a caller that had already gone. Reading
     * a boolean once per row is the cheapest thing in this loop. */
    if (signal.aborted) return
    taken += 1
    /* The encoded length, measured rather than guessed — `JSON.stringify` is
     * what the frame will carry, and a row's cost is dominated by whichever
     * string in it happens to be long. */
    const size = JSON.stringify(row).length
    /* A ROW THAT CANNOT FIT IN A PAGE IS REFUSED, LOUDLY.
     *
     * The budget was only consulted when a page already held something, so a
     * single oversized row was yielded alone and the transport rejected the
     * frame downstream — the caller saw a generic wire error for a specific,
     * nameable problem. Inputs are bounded now, so this should be
     * unreachable; if it ever fires, something published a row larger than a
     * page can carry and the message says which. */
    if (size > PAGE_BYTES) {
      throw refuse(
        SERVICE_ERRORS.unsupported,
        `one row is ${size} bytes, past the ${PAGE_BYTES}-byte page budget, so it cannot be sent`,
      )
    }
    if (page.length > 0 && (page.length >= PAGE_ROWS || bytes + size > PAGE_BYTES)) {
      if (signal.aborted) return
      yield page
      page = []
      bytes = 0
    }
    page.push(row)
    bytes += size
  }
  if (page.length > 0) {
    if (signal.aborted) return
    yield page
  }
}
