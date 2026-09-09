import {
  BOOKS_DIR,
  admitsAnotherBook,
  folderOf,
  isContentExtension,
  isContentHash,
  mayPublishNotes,
  notifyAll,
  offerAbsentBecause,
  offerabilityOf,
  planShareImport,
  type IndexedBook,
  type Library,
  type PublicOfferability,
  type ShareImport,
} from '../../../kernel'
import type { SharedBook, SharePort, ShareService } from '../../peer'

/**
 * What the public-sharing surface reads and does — phase 25's caller.
 *
 * ⚠️ **THIS EXISTS BECAUSE THE RULES HAD NOBODY TO CALL THEM.** `offerabilityOf`
 * and `mayAdoptIdentity` were written, tested and unreachable: a guard nothing
 * runs is a comment. What is here is the composition — the library snapshot on
 * one side, the peer plugin's share commands on the other, and the kernel's
 * pure decisions between them.
 *
 * ⚠️ **AND IT NEVER GUESSES A FOLDER.** `folderOf` is the one rule for where a
 * book's files live; the segment below is taken from it rather than rebuilt,
 * because `safeId` is many-to-one and a second spelling of it is a path two
 * writers disagree about.
 */

/** One book's public state, as a surface draws it. */
export interface PublicBookState {
  readonly bookId: string
  /** Its network name, when it has one. */
  readonly hash: string | null
  readonly offerability: PublicOfferability
  /** The sentence to show when offering is not possible; `null` when it is. */
  readonly absentBecause: string | null
  /** Whether public annotations may be published — see `mayPublishNotes`. */
  readonly mayAnnotate: boolean
  readonly bytes: boolean
  readonly notes: boolean
  /** How many annotations are held, or `null` when they could not be counted. */
  readonly noteCount: number | null
}

export interface PublicPort {
  /** One book's public state. `null` for a book the library does not have. */
  forBook(bookId: string): Promise<PublicBookState | null>
  /** Offer this book's bytes. Publication, and it cannot be undone. */
  offerBytes(bookId: string): Promise<void>
  /** Offer public annotations without offering the book. */
  offerNotes(bookId: string): Promise<void>
  /** Stop offering one book over one service. */
  withdraw(bookId: string, service: ShareService): Promise<void>
  /**
   * Fetch a book by hash, putting the bytes where the guard says they may go.
   *
   * ⚠️ **THE PLAN IS COMPUTED HERE AND HONOURED HERE**, so `mayAdoptIdentity`
   * is not advice a caller may skip. See `planShareImport`.
   *
   * ⚠️ **`ext` IS REQUIRED BECAUSE A HASH DOES NOT CARRY A FORMAT**, and there
   * is nowhere yet for one to come from. A content address names bytes; what
   * those bytes ARE is a fact about the book, and phase 25 records the
   * catalogue — title, author, hash — as *"a second contract this phase does
   * not yet specify"*. The format belongs in it. Defaulting to `epub` here
   * would write a PDF into `content.epub`, which every reader of `extensionFor`
   * would then believe.
   */
  importBook(hash: string, ext: string, providers?: readonly string[]): Promise<ShareImport>
  /** Something changed. Returns its own unsubscribe. */
  subscribe(listener: () => void): () => void
}

/**
 * Whether this device may start holding public annotations for another book.
 *
 * ⚠️ **`MAX_BOOKS_WITH_PUBLIC` WAS DECLARED AND NEVER READ**, so the claimed
 * device-wide storage bound did not exist — found by audit. This is the moment
 * it is asked: where a book first acquires public storage, and where refusing
 * costs nothing already stored.
 */
function roomForAnotherBook(offered: readonly SharedBook[], hash: string): boolean {
  const already = offered.some((one) => one.hash === hash && one.notes)
  return already || admitsAnotherBook(offered.filter((one) => one.notes).length)
}

/**
 * Every quota claim on one device, in a line.
 *
 * ⚠️ **A COUNT READ IN ONE `await` AND ACTED ON IN THE NEXT IS NOT A QUOTA.**
 * Two concurrent calls each saw a count under the limit and each published, so
 * the device passed a bound it reports as absolute — measured by audit at
 * 2 001 books against 2 000. Nothing about the two calls is unusual: the pane
 * and a service handler can both be publishing, and `offered()` crosses a
 * process boundary, which is a long window.
 *
 * The chain is per module and not per port, which is deliberate: the bound is
 * about THIS DEVICE, and a device has one share endpoint. A rejected claim
 * must not poison the chain for the next one, which is what the `catch` on the
 * tail is for.
 */
let claiming: Promise<unknown> = Promise.resolve()
function claimNotesSlot(port: SharePort, hash: string): Promise<void> {
  const mine = claiming.then(async () => {
    if (!roomForAnotherBook(await port.offered(), hash)) {
      throw new Error('This device already publishes notes for as many books as it will hold.')
    }
    await port.offerNotes(hash)
  })
  claiming = mine.catch(() => {})
  return mine
}

/** What one book's content file is called, or `null` when it has no bytes. */
function contentNameOf(book: IndexedBook): string | null {
  return book.hasContent === true && typeof book.ext === 'string' && book.ext !== '' ? `content.${book.ext}` : null
}

/**
 * The path segment under `books/` for a book — taken from `folderOf` rather
 * than rebuilt.
 */
function folderSegment(bookId: string): string {
  return folderOf(bookId).slice(`${BOOKS_DIR}/`.length)
}

/**
 * The book the library offers as a match for a wanted hash.
 *
 * ⚠️ **BY `contentHash` AND NOTHING ELSE.** A match by title, by author or by
 * `bookId` would be a match by something that can collide, and handing one to
 * `planShareImport` as a candidate is asking it to refuse — which it would,
 * every time, with `unverifiable` or `different-book`. Matching on the one
 * field that settles the question keeps "the reader already has this" a real
 * answer rather than a coincidence the guard then has to talk them out of.
 */
function candidateFor(books: readonly IndexedBook[], hash: string): IndexedBook | undefined {
  return books.find((book) => book.contentHash === hash)
}

export function publicPortOver(library: Library, share: () => SharePort | null, changed: () => void): PublicPort {
  const listeners = new Set<() => void>()
  /**
   * The share port, or the one sentence that says why there is not one.
   *
   * ⚠️ **RESOLVED PER CALL, NEVER CAPTURED**, because `peer` may be composed
   * and this capability still started before its wire exists — a port captured
   * as `null` would stay null for the whole run. Four call sites repeated the
   * lookup and the identical sentence; the sentence is a promise to the reader
   * and belongs in one place.
   */
  const mustShare = (): SharePort => {
    const port = share()
    if (port === null) throw new Error('public sharing is not available on this device')
    return port
  }
  const tell = (): void => {
    /* ⚠️ **EACH ON ITS OWN, AND THE CHANGE HAS ALREADY LANDED.** A throwing
       callback stopped every later subscriber and travelled back out of an
       operation that had already been written — so the caller's `await`
       rejected and the reader was told a change failed that is on disk. See
       `notifyAll`, which is where that class is written down. */
    notifyAll([changed, ...listeners], 'public book')
  }
  const bookOf = (bookId: string): IndexedBook | undefined =>
    library.getSnapshot().find((book) => book.bookId === bookId)

  return {
    async forBook(bookId) {
      const book = bookOf(bookId)
      if (book === undefined) return null
      const offerability = offerabilityOf(book)
      const hash = isContentHash(book.contentHash) ? book.contentHash : null
      const port = share()
      /* ⚠️ **`offered()` READS A FILE AND STARTS NOTHING** — the wire says so
         at length. A surface that polled anything else here would bind a
         second UDP port for a reader who has never published. */
      const offered = port === null || hash === null ? [] : await port.offered()
      const row = offered.find((one) => one.hash === hash)
      return {
        bookId,
        hash,
        offerability,
        absentBecause: offerAbsentBecause(offerability),
        mayAnnotate: mayPublishNotes(book),
        bytes: row?.bytes ?? false,
        notes: row?.notes ?? false,
        /* ⚠️ **A BOOK WITH NO ROW HAS NO ANNOTATIONS; ONE WHOSE FILE WOULD
           NOT READ HAS AN UNKNOWN NUMBER.** `?? 0` collapsed the two, and the
           surface uses this to say what stopping publication deletes. */
        noteCount: row === undefined ? 0 : row.noteCount,
      }
    },

    async offerBytes(bookId) {
      const book = bookOf(bookId)
      if (book === undefined) throw new Error('that book is not in this library')
      /* ⚠️ **THE RULE IS ASKED HERE, NOT ONLY WHERE THE BUTTON IS DRAWN.** A
         surface that hid the control is a surface; this is the boundary. The
         two disagree exactly when a book loses its bytes between a render and
         a click, which is the case a control-only check gets wrong. */
      const offerability = offerabilityOf(book)
      if (offerability !== 'offerable') {
        throw new Error(offerAbsentBecause(offerability) ?? 'this book cannot be offered')
      }
      const name = contentNameOf(book)
      const hash = book.contentHash
      /* Narrowed rather than asserted: `offerabilityOf` already established
         both, and a `!` here would be the compiler being told to trust a
         function it cannot see into. The two throws are unreachable and cheap,
         and they stay reachable if that function ever changes its mind. */
      if (name === null || !isContentHash(hash)) throw new Error('this device does not hold this book’s file')
      await mustShare().offerBytes(folderSegment(bookId), name, hash)
      tell()
    },

    async offerNotes(bookId) {
      const book = bookOf(bookId)
      if (book === undefined) throw new Error('that book is not in this library')
      /* ⚠️ **NO `hasContent` CHECK, AND THAT IS WI-25.9.** A reader may publish
         notes on a book they have no right to redistribute — the common case,
         not the exception. `mayPublishNotes` needs the NAME and not the bytes. */
      const hash = book.contentHash
      if (!mayPublishNotes(book) || !isContentHash(hash)) {
        throw new Error('Paper has not finished reading this file’s fingerprint yet.')
      }
      const port = mustShare()
      /* ⚠️ **THE QUOTA AND THE PUBLICATION ARE TWO AWAITS AND THE GAP IS
         REAL.** Two calls could each read a count under the limit and each
         publish, so the device ends up over it — measured by audit at 2 001
         books against a 2 000 bound. The backend's own 10 000-book limit does
         not help: it is a different, larger number.

         Serialised on ONE promise chain per port, which is what makes the read
         and the write one step as far as any other caller is concerned. It
         cannot be pushed into the backend without a policy call that takes the
         quota as an argument, which is an ALPN change; this closes the window
         a caller can actually reach. */
      await claimNotesSlot(port, hash)
      tell()
    },

    async withdraw(bookId, service) {
      const book = bookOf(bookId)
      if (book === undefined || !isContentHash(book.contentHash)) {
        throw new Error('that book has nothing published')
      }
      await mustShare().withdraw(book.contentHash, service)
      tell()
    },

    async importBook(hash, ext, providers) {
      const port = mustShare()
      if (!isContentExtension(ext)) throw new Error(`Paper does not store a ${ext} file`)
      const candidate = candidateFor(library.getSnapshot(), hash)
      const plan = planShareImport(hash, candidate)
      if (plan.kind === 'already-held') return plan
      /* ⚠️ **THE FOLDER COMES FROM THE PLAN, WHICH IS THE WHOLE GUARD.**
         `into-held` is the one case where a fetch writes into an existing
         book's folder, and it is reached only when the held record names this
         exact whole-file digest. Everything else lands in a staging folder of
         its own — including a candidate that matched and disagreed. */
      if (plan.kind === 'into-held') {
        /* ⚠️ **THE HELD RECORD'S OWN FORMAT WINS, AND THE CALLER'S IS REFUSED
           WHEN IT DISAGREES.** Found by audit: fetching a known PDF hash as
           `epub` wrote `content.epub` while the existing record still opened
           `content.pdf` — a book with two content files, one of which nothing
           reads. The record names the format because the record is what the
           reader opens. */
        const held = candidate?.ext
        if (typeof held === 'string' && held !== '' && held !== ext) {
          throw new Error(`This book is stored as a ${held} file, not a ${ext} one.`)
        }
        await port.fetch(hash, folderSegment(plan.bookId), `content.${held ?? ext}`, providers)
        /* ⚠️ **THE INDEX DOES NOT NOTICE BYTES LANDING FROM OUTSIDE THE
           KERNEL.** `hasContent` is cached, and a blob written by the peer
           plugin changes the answer without changing the record — which is
           exactly what `refreshContent` exists for. Without it the row still
           reported the book as missing its file, so the next import fetched
           the same bytes again, for ever. Measured by audit: two fetches, zero
           refreshes. */
        await library.refreshContent(plan.bookId)
        tell()
        return plan
      }
      /* ⚠️ **A STAGED BOOK IS NOT IN THE LIBRARY, AND THIS SAYS SO RATHER THAN
         REPORTING SUCCESS.** The bytes land in a folder of their own; making
         them a book means parsing them for a title, minting a `bookId` and
         writing a record, which is the import path this phase does not ship.
         `ShareImport.kind` is `'into-new'` and the caller has to handle it —
         reporting a plain success for a book the reader cannot open would be
         the quieter and worse answer. */
      await port.fetch(hash, plan.folder, `content.${ext}`, providers)
      tell()
      return plan
    },

    subscribe(listener) {
      listeners.add(listener)
      /* ⚠️ **THE LIBRARY CHANGES THIS PORT'S ANSWER AND USED NOT TO REACH
         IT.** Everything `forBook` reports — whether a book is offerable, its
         fingerprint, whether its bytes are here — is read out of the library
         snapshot, and this port only ever told its subscribers about its OWN
         mutations. So a fingerprint arriving from the enrichment pass, a
         content eviction or a removal left the open pane showing the previous
         answer until the reader clicked something. Found by audit.

         Subscribed per LISTENER rather than once for the port, so the port
         holds nothing after its last subscriber leaves — this factory has no
         disposal of its own to hang an unsubscribe on. */
      const off = library.subscribe(listener)
      return () => {
        listeners.delete(listener)
        off()
      }
    },
  }
}
