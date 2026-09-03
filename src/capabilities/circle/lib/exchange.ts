import { claimFor, indexKeys, matchWork, type ClaimSource, type WorkClaim } from '../../../kernel'
import { pageCrypto } from './crypto'
import {
  CIRCLE_PROTO,
  CIRCLE_VERSION,
  agreedVersion,
  parseCircleHello,
  parsePagesRequest,
  type CircleWelcome,
  type PagesAnswer,
} from './protocol'
import { pagesFor, type Publisher, type SharedFile } from './publish'

/**
 * The two sides of an exchange, as functions of their inputs — WI-22.C4.
 *
 * PURE except for what is handed in. A service handler is the hardest thing in
 * this capability to reach from a test — it needs a peer, a grant, a live
 * envelope — so the DECIDING is here and the handler is the thin part.
 *
 * ## Which book a work claim means
 *
 * ⚠️ **THE DIGEST HAS TO BE THE SAME FUNCTION ON BOTH MACHINES OR NOTHING EVER
 * MATCHES.** `claimFor` takes it as a parameter precisely so this is a decision
 * somebody makes rather than a default somebody inherits: two peers hash their
 * own copies of a title independently and compare the results, so a build using
 * a different hash would find no book in common with anybody and look like a
 * network that works and a circle that is empty.
 *
 * SHA-256, which is `pageCrypto.hash` — the one already crossing this wire.
 */

/** The digest both sides must agree on. See the module header. */
export const workDigest = pageCrypto.hash

/** A book, as far as naming the work goes. */
export interface BookLike extends ClaimSource {
  readonly id: string
}

/** The claim for one book of this library. */
export function claimOf(book: BookLike): WorkClaim {
  return claimFor(book, workDigest)
}

/**
 * The book in this library a claim means, or `null`.
 *
 * ⚠️ **A STRONG MATCH WINS OVER A WEAK ONE, AND NOT MERELY BY LUCK OF
 * ITERATION.** A shared identifier is evidence; a title and an author in the
 * same language is a guess that is right most of the time. Taking whichever
 * came first in a directory listing would make which book a friend's passages
 * land in depend on the order the shelf happened to be read.
 */
export function bookFor(books: readonly BookLike[], claim: WorkClaim): BookLike | null {
  let weak: BookLike | null = null
  for (const book of books) {
    const how = matchWork(claim, claimOf(book))
    if (how === 'strong') return book
    if (how === 'weak' && !weak) weak = book
  }
  return weak
}

/**
 * An index from claim key to book, for a shelf too large to scan per request.
 *
 * `indexKeys` is deliberately generous — it is not the answer, `matchWork` is
 * — so a hit here is a CANDIDATE and every candidate is still judged.
 */
export function indexOf(books: readonly BookLike[]): ReadonlyMap<string, readonly BookLike[]> {
  const index = new Map<string, BookLike[]>()
  for (const book of books) {
    for (const key of indexKeys(claimOf(book))) {
      const held = index.get(key)
      if (held) held.push(book)
      else index.set(key, [book])
    }
  }
  return index
}

/** The candidates a claim points at, judged. */
export function bookVia(
  index: ReadonlyMap<string, readonly BookLike[]>,
  claim: WorkClaim,
): BookLike | null {
  /* Stryker disable next-line ArrayDeclaration: what a seeded value would put
     in this list cannot change an answer — `bookFor` judges every candidate
     with `matchWork`, and anything that is not a book of this library fails on
     the language before anything else is compared. */
  const candidates: BookLike[] = []
  // Stryker disable next-line ArrayDeclaration: as above, for the same reason.
  for (const key of indexKeys(claim)) candidates.push(...(index.get(key) ?? []))
  return bookFor(candidates, claim)
}

/* ─────────────────────────────────────────────────────────── the two sides */

/** What this device answers a hello with, or `null` to refuse. */
export function welcome(request: unknown, person: string): CircleWelcome | null {
  const hello = parseCircleHello(request)
  if (!hello) return null
  const agreed = agreedVersion(hello.pages)
  /* ⚠️ **NO OVERLAP IS A REFUSAL, NOT A GUESS.** `SYNC_VERSION`'s history: an
   * unbumped peer stripped a field it did not know, ACKed the stripped row, and
   * the ACK erased the sender's data. On an append-only log that is not a lost
   * field but a lost history. */
  if (agreed === null) return null
  return { proto: CIRCLE_PROTO, pages: CIRCLE_VERSION, person, agreed }
}

/** Everything answering a page request needs, and nothing it does not. */
export interface Serving {
  /** The books this device holds, for matching the claim. */
  readonly books: readonly BookLike[]
  /** This reader's publications for a book, and the boundaries already sealed. */
  readonly shared: (bookId: string) => Promise<SharedFile>
  /** Write back what `pagesFor` sealed — see `SealedPage`. */
  readonly seal: (bookId: string, held: SharedFile) => Promise<void>
  /** Who this device is, and how it signs. */
  readonly publisher: (work: WorkClaim) => Promise<Publisher | null>
}

/**
 * Answer one request for pages.
 *
 * ⚠️ **A WORK THIS SHELF DOES NOT HAVE IS AN EMPTY ANSWER, NOT AN ERROR.** The
 * caller asked whether this reader has anything of a book; "no" is the ordinary
 * answer and the overwhelmingly common one. An error here would put a failure
 * in front of a reader for the fact that their friend owns a book they do not.
 *
 * ⚠️ **AND SO IS A BOOK WITH NOTHING SHARED FROM IT.** The two are deliberately
 * indistinguishable from outside: telling a peer *"I have that book but have
 * shared nothing"* discloses the reader's library one request at a time.
 */
export async function answerPages(request: unknown, serving: Serving): Promise<PagesAnswer | null> {
  const asked = parsePagesRequest(request)
  if (!asked) return null

  const book = bookVia(indexOf(serving.books), asked.work)
  if (!book) return { pages: [], more: false }

  const publisher = await serving.publisher(asked.work)
  /* No identity, or a delegation this device cannot produce: nothing to say,
     and saying so is not this exchange's business either. */
  if (!publisher) return { pages: [], more: false }

  const held = await serving.shared(book.id)
  const built = await pagesFor(held, publisher, asked.since, workDigest)
  /* ⚠️ **THE SEALED BOUNDARIES ARE WRITTEN BEFORE THE PAGES GO OUT.** A page
   * served under a boundary that was never recorded is a page the next fetch
   * re-paginates — and every recipient holding it then refuses the one after
   * with `chain`. Of the two orders only this one fails safe: a boundary
   * recorded and not served is re-served, which costs a round trip. */
  if (built.held.sealed.length !== held.sealed.length) await serving.seal(book.id, built.held)
  return { pages: built.pages, more: built.more }
}
