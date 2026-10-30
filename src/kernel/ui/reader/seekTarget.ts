/**
 * What a reader typed into "Go to", read as a place in the book.
 *
 * WHY A SEEK EXISTS AT ALL. `goToFraction` on the fork's view had **no callers**
 * before this: every navigation in Paper was by href or CFI — a link, a
 * footnote, a Contents row, a search hit, a passage landing. So a reader could
 * reach a chapter and reach a phrase and could not reach *a place*. "Take me to
 * 60 %" and "back thirty pages" had no control anywhere.
 *
 * PURE, and that is the point: what a typed string means is a set of small
 * decisions about ambiguous input — a bare number, a percentage sign in the
 * wrong place, a page in a book that has no pages — and every one of them can
 * be written down and checked without opening a book. The caller does the
 * moving.
 *
 * ⚠️ **EVERY REFUSAL IS NAMED, BECAUSE THE ALTERNATIVE IS A CONTROL THAT DOES
 * NOTHING.** A seek that silently declines is indistinguishable from a seek
 * that failed, and this repository has already paid for one of those: a
 * download that refused verification said only *"sync failed"* and named
 * nothing, because the sentences existed and nothing could reach them.
 */

/** A place a seek can land, or a refusal with words for the reader. */
export type SeekTarget =
  | { readonly kind: 'fraction'; readonly fraction: number }
  | { readonly kind: 'page'; readonly page: number }
  | { readonly kind: 'refuse'; readonly why: string }

/** What the book can answer about itself, for a seek to be checked against. */
export interface SeekBook {
  /**
   * The highest print page the book declares, or 0 when it declares none.
   *
   * ZERO IS THE COMMON CASE and it is not a failure: measured over 150 random
   * books on this shelf, only 10 carry a `page-list` nav at all. A seek by page
   * in a book with no pages is refused by name rather than approximated — a
   * page number invented from a fraction is a citation nobody else can follow,
   * which is the whole argument `citation.ts` makes.
   */
  readonly pages: number
}

const PERCENT = /^(\d{1,3}(?:\.\d+)?)\s*%$/u
const PAGE = /^(?:p\.?|pg\.?|page)\s*(\d{1,6})$/iu
const BARE = /^(\d{1,6}(?:\.\d+)?)$/u

/**
 * Read a typed place.
 *
 * ⚠️ **A BARE NUMBER IS A PERCENTAGE, AND THAT IS A DECISION.** `60` could be
 * "60 %" or "page 60", and the two are different places in every book. It reads
 * as a percentage because a percentage is the only locator EVERY book has:
 * reading it as a page would refuse in the 93 % of books with no page list,
 * which turns the commonest input into the commonest failure. A reader who
 * means the page says `p. 60`, and the refusal below says so.
 */
export function seekTarget(input: string, book: SeekBook): SeekTarget {
  const text = input.trim()
  if (text === '') return { kind: 'refuse', why: 'Type a place — 60%, or p. 213.' }

  const page = PAGE.exec(text)
  if (page) {
    const at = Number(page[1])
    if (book.pages <= 0) {
      return {
        kind: 'refuse',
        why: 'This book has no page numbers of its own — try a percentage, like 60%.',
      }
    }
    if (at < 1 || at > book.pages) {
      return { kind: 'refuse', why: `This book goes up to page ${book.pages}.` }
    }
    return { kind: 'page', page: at }
  }

  const percent = PERCENT.exec(text) ?? BARE.exec(text)
  if (percent) {
    const at = Number(percent[1])
    if (at < 0 || at > 100) return { kind: 'refuse', why: 'A percentage runs from 0 to 100.' }
    return { kind: 'fraction', fraction: at / 100 }
  }

  return { kind: 'refuse', why: `“${text}” is not a place — try 60%, or p. 213.` }
}
