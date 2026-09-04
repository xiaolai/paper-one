import { claimFor, indexKeys, matchWork, type ClaimSource, type WorkClaim } from '../../../kernel'
import { pageCrypto } from './crypto'
import {
  CIRCLE_PROTO,
  CIRCLE_VERSION,
  agreedVersion,
  parseCircleHello,
  parsePagesRequest,
  parseShelfRequest,
  type CircleWelcome,
  type PagesAnswer,
} from './protocol'
import { DEFAULT_BOUNDS, pagesFor, type Bounds, type Publisher, type SharedFile } from './publish'
import { shelfPagesFor, shelvedNow, type ShelfFile } from './shelf'
import { base64Of } from './base64'
import { SHELF_WORK, listWork } from '../../../kernel'
import { listPagesFor, type ListFile, type OwnList } from './lists'
import { COVER_CHUNK_BYTES, MAX_ANSWER_CHARS, MAX_PAGES_PER_ANSWER, parseCoverRequest, parseListsRequest, type CoverAnswer } from './protocol'
import { MAX_COVER_BYTES } from '../../../kernel'

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
  /* Two editions matching alike — two copies of one identifier, say — are
     told apart by their id, the one thing about them that two reads of the
     shelf agree on. Listing order is not a rule. */
  let strong: BookLike | null = null
  let weak: BookLike | null = null
  for (const book of books) {
    const how = matchWork(claim, claimOf(book))
    // Stryker disable EqualityOperator: two books on one shelf never share an id, so `<` and `<=` choose alike.
    if (how === 'strong') {
      if (strong === null || book.id < strong.id) strong = book
    } else if (how === 'weak') {
      if (weak === null || book.id < weak.id) weak = book
    }
    // Stryker restore EqualityOperator
  }
  return strong ?? weak
}

/**
 * An index from claim key to book, for a shelf too large to scan per request.
 *
 * `indexKeys` is deliberately generous — it is not the answer, `matchWork` is
 * — so a hit here is a CANDIDATE and every candidate is still judged.
 */
/* One index per shelf snapshot. The array is the key: `runningOver` hands
   the same array back until the library changes, so a thousand requests
   over an unchanged shelf build the index once. */
const INDEXES = new WeakMap<readonly BookLike[], ReadonlyMap<string, readonly BookLike[]>>()

export function indexOf(books: readonly BookLike[]): ReadonlyMap<string, readonly BookLike[]> {
  const known = INDEXES.get(books)
  if (known !== undefined) return known
  const built = buildIndex(books)
  INDEXES.set(books, built)
  return built
}

function buildIndex(books: readonly BookLike[]): ReadonlyMap<string, readonly BookLike[]> {
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
  /** The reader's own shelf as published, and the boundaries sealed — WI-23.C1. */
  readonly shelf: () => Promise<ShelfFile>
  readonly sealShelf: (held: ShelfFile) => Promise<void>
  /** The reader's own lists as published, and the boundaries sealed — WI-23.E1. */
  readonly lists: () => Promise<readonly OwnList[]>
  readonly sealList: (listId: string, held: ListFile) => Promise<void>
  /** The jacket this device holds for a book, measured — or null (WI-23.C5). */
  readonly cover: (bookId: string) => Promise<CoverSource | null>
}

/** A jacket as the publisher holds it: the facts on its record and the file's bytes. */
export interface CoverSource {
  readonly hash: string
  readonly size: number
  readonly bytes: Uint8Array
}

/**
 * Answer a request for one chunk of a jacket — WI-23.C5.
 *
 * ⚠️ **ONE REFUSAL FOR EVERY WAY OF HAVING NOTHING TO SAY.** A person the
 * switch is off for, a pub nobody holds, a shelf entry that named no cover, a
 * file that has changed under its digest, one past the size the circle
 * serves: each answers `null`, and the caller cannot tell which. A friend
 * who has been hidden from must not learn it by asking for a picture.
 *
 * The digest on the shelf entry is the contract: the bytes served are the
 * file whose facts match it, and a file that no longer matches is not served
 * rather than served with a caveat. The recipient verifies the whole file
 * against the same digest before keeping a byte.
 */
export async function answerCover(request: unknown, serving: Serving, discloses: boolean): Promise<CoverAnswer | null> {
  const asked = parseCoverRequest(request)
  if (!asked) return null
  if (!discloses) return null
  const row = [...shelvedNow(await serving.shelf()).values()].find((one) => one.pub === asked.pub)
  // Stryker disable next-line ConditionalExpression: a row that names no cover matches no held hash below; this refuses it a line earlier.
  if (row === undefined || row.work.cover === undefined) return null
  const held = await serving.cover(row.bookId)
  if (held === null || held.hash !== row.work.cover || held.size > MAX_COVER_BYTES || held.bytes.length !== held.size) return null
  if (asked.offset >= held.size) return null
  const slice = held.bytes.subarray(asked.offset, Math.min(held.size, asked.offset + COVER_CHUNK_BYTES))
  return { offset: asked.offset, size: held.size, bytes: base64Of(slice), more: asked.offset + slice.length < held.size }
}

/** What a caller is served when there is nothing to say — ONE literal, see `answerShelf`. */
const NOTHING: PagesAnswer = { pages: [], more: false }

/**
 * Answer one request for the shelf — WI-23.C1, gated by WI-23.C2.
 *
 * ⚠️ **A PERSON THE SWITCH IS OFF FOR IS ANSWERED EXACTLY AS A READER WHO
 * OWNS NOTHING IS.** `discloses` is the relationship's `shelf` for the
 * CALLER; false answers `NOTHING`, and so does a shelf with no books — the
 * same literal, so the bytes on the wire cannot say which. A difference
 * would be a bit of information about the shelf, leaked to somebody the
 * switch is off for, which is the falsifier the item names.
 */
export async function answerShelf(request: unknown, serving: Serving, discloses: boolean, bounds: Bounds = DEFAULT_BOUNDS): Promise<PagesAnswer | null> {
  const asked = parseShelfRequest(request)
  if (!asked) return null
  if (!discloses) return NOTHING

  const publisher = await serving.publisher(SHELF_WORK)
  if (!publisher) return NOTHING

  const held = await serving.shelf()
  const built = await shelfPagesFor(held, publisher, asked.since, workDigest, bounds, asked.v)
  /* Boundaries before pages, for `answerPages`'s reason. */
  if (built.held.sealed.length !== held.sealed.length) await serving.sealShelf(built.held)
  return { pages: built.pages, more: built.more }
}

/**
 * Answer one request for every list — WI-23.E1, gated by WI-23.C2's switch.
 *
 * ⚠️ **THE SAME `NOTHING` AS THE SHELF'S, FOR THE SAME REASON.** A list names
 * works the recipient may not have, so it needs the shelf's disclosure rule:
 * a person the switch is off for is answered byte for byte as a reader with
 * no lists is. The falsifier compares the two answers' bytes.
 *
 * One answer carries pages from several lists; each page names its list in
 * its claim (`listWork`), which is how the recipient files it and how a new
 * list is discovered. Bounded to `MAX_PAGES_PER_ANSWER` across lists — a
 * truncated tail is asked for again from the cursor, which only moves over
 * pages taken.
 */
export async function answerLists(request: unknown, serving: Serving, discloses: boolean, bounds: Bounds = DEFAULT_BOUNDS): Promise<PagesAnswer | null> {
  const asked = parseListsRequest(request)
  if (!asked) return null
  if (!discloses) return NOTHING

  const pages: string[] = []
  /* ONE CHARACTER BUDGET ACROSS THE LISTS, as there is one page budget: a
     caller with many lists is answered to the same size as one with one. */
  const maxChars = bounds.maxChars ?? MAX_ANSWER_CHARS
  let chars = 0
  let more = false
  for (const list of await serving.lists()) {
    /* ⚠️ **NOTHING IS CUT OR SIGNED FOR AN ANSWER THAT IS ALREADY FULL.** The
     * cap bounds the wire; it has to bound the work too, or a caller with
     * many lists makes this side sign pages it then throws away. */
    if (pages.length >= MAX_PAGES_PER_ANSWER || chars >= maxChars) {
      more = true
      break
    }
    const publisher = await serving.publisher(listWork(list.id))
    if (!publisher) return NOTHING
    const room = MAX_PAGES_PER_ANSWER - pages.length
    const built = await listPagesFor(list.held, publisher, asked.since[list.id] ?? {}, workDigest, { ...bounds, maxPages: Math.min(bounds.maxPages, room), maxChars: maxChars - chars }, asked.v)
    if (built.held.sealed.length !== list.held.sealed.length) await serving.sealList(list.id, built.held)
    pages.push(...built.pages)
    for (const page of built.pages) chars += page.length
    if (built.more) more = true
  }
  return { pages, more }
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
  /* The chain the CALLER negotiated — `PagesRequest.v` — and no other: a v1
     peer handed a v2 page refuses it as `version`, and a v1 page cut from the
     v2 boundaries is a page that reproduces under no chain at all. */
  const built = await pagesFor(held, publisher, asked.since, workDigest, DEFAULT_BOUNDS, asked.v)
  /* ⚠️ **THE SEALED BOUNDARIES ARE WRITTEN BEFORE THE PAGES GO OUT.** A page
   * served under a boundary that was never recorded is a page the next fetch
   * re-paginates — and every recipient holding it then refuses the one after
   * with `chain`. Of the two orders only this one fails safe: a boundary
   * recorded and not served is re-served, which costs a round trip. */
  if (built.held.sealed.length !== held.sealed.length) await serving.seal(book.id, built.held)
  return { pages: built.pages, more: built.more }
}
