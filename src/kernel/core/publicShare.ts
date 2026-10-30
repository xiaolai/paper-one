import { isContentHash } from './bookFolder'

/**
 * What a book may be offered publicly as, and what a fetched file may become —
 * WI-25.2 and WI-25.4.
 *
 * PURE. No filesystem, no transport, no clock. Every decision here is over
 * values a caller already holds, which is what lets the two rules below be
 * tested exhaustively rather than through a network.
 *
 * ## `contentHash` is the network name, and there is no new identifier
 *
 * ⚠️ **THE FIRST DRAFT OF PHASE 25 INVENTED A `shareHash` AND IT WAS DELETED
 * BEFORE ANY CODE EXISTED.** `contentHash` is already BLAKE3 over the whole
 * file, already computed in Rust, already backfilled off the open path, and its
 * docstring in `bookFolder.ts` already states the rule this needs: *"two
 * devices holding bytes for one `bookId` with two different hashes is a
 * conflict, never a merge"*. A second digest would have been a second thing to
 * keep true.
 *
 * `contentId` is untouched. It keeps its sampling and keeps keying marks, cards
 * and positions — see `contentIdentity.ts`, which is explicit that above
 * {@link FULL_HASH_LIMIT} it is APPROXIMATE.
 *
 * ## What is missing is that `contentHash` is OPTIONAL
 *
 * It is stamped by sync's backfill, so a build composed without `sync` has none
 * at all, and a book added a minute ago may not have one yet. A surface that
 * simply hid the control would look broken; {@link offerAbsentBecause} is the
 * sentence that has to accompany its absence, the same shape and for the same
 * reason as `shareAbsentBecause` in `circle/foreign.ts`.
 */

/* ⚠️ **`isContentHash` IS IMPORTED, NOT WRITTEN AGAIN.** `bookFolder.ts` calls
   its copy *"THE ONE RULE, for every door a digest comes through"* and lists
   the doors: the record on disk, a peer's push and pull rows, a browser's
   `book.list` answer. The share endpoint is a fourth door and a public one, so
   a second pattern here would be the exact defect that comment records — one
   of which, the browser's, had had no pattern at all. */

/**
 * Whether a book can be offered publicly, and if not, what is missing.
 *
 * ⚠️ **THE TWO REASONS ARE DIFFERENT ACTS FOR THE READER**, which is why they
 * are two values rather than one `false`. A book with no bytes on this device
 * needs downloading; a book with bytes and no digest needs nothing but time,
 * and telling the reader to do something about it would be wrong.
 */
export type PublicOfferability =
  | 'offerable'
  /** The bytes are not on this device, so there is nothing to serve. */
  | 'no-content'
  /**
   * The bytes are here and their whole-file digest has not been computed.
   *
   * ⚠️ **NOT AN ERROR, AND NOT THE READER'S PROBLEM TO FIX.** `contentHash` is
   * stamped off the open path by sync's backfill; a book that has never been
   * opened on a device with `sync` composed simply has not been reached yet.
   */
  | 'no-content-hash'

/** What a book has to look like to be judged. A subset of `IndexedBook`. */
export interface Offerable {
  readonly contentHash?: string | undefined
  /**
   * Whether this device holds the bytes.
   *
   * ⚠️ **`| undefined` EXPLICITLY, UNDER `exactOptionalPropertyTypes`.** A
   * caller building this from a partial record spreads a key whose value is
   * `undefined`, and "the scan has not answered yet" is a state this function
   * is documented to handle — a type that could only express "absent" would
   * push those callers into a cast at the one boundary where the answer
   * decides whether a book is offered to strangers.
   */
  readonly hasContent?: boolean | undefined
}

/**
 * Whether this book can be offered publicly.
 *
 * ⚠️ **CONTENT FIRST, THEN THE DIGEST.** A book with neither is reported as
 * having no content, because that is the one the reader can act on — reporting
 * the missing digest for a book whose bytes are elsewhere sends them looking
 * for a backfill that could not run.
 */
export function offerabilityOf(book: Offerable): PublicOfferability {
  if (book.hasContent !== true) return 'no-content'
  return isContentHash(book.contentHash) ? 'offerable' : 'no-content-hash'
}

/**
 * Why offering is absent, for the copy that must accompany its absence.
 *
 * `null` when the control is offered — so a caller renders the control or the
 * sentence and cannot render neither.
 */
export function offerAbsentBecause(state: PublicOfferability): string | null {
  switch (state) {
    case 'offerable':
      return null
    case 'no-content':
      return 'This device does not hold this book’s file.'
    case 'no-content-hash':
      return 'Paper has not finished reading this file’s fingerprint yet.'
  }
}

/**
 * Whether public annotations can be published for a book — WI-25.9.
 *
 * ⚠️ **THIS IS A DIFFERENT QUESTION FROM {@link offerabilityOf} AND THE
 * DIFFERENCE IS THE WHOLE POINT.** A reader may publish notes on a book they
 * have no right to redistribute; that is the common case, not the exception.
 * What annotations need is the NAME — a hash both ends agree on — and not the
 * bytes, so a book whose file lives on another device can still be annotated
 * publicly here as long as its digest is known.
 *
 * ⚠️ **AND `hasContent` IS DELIBERATELY NOT READ.** A version of this that
 * required the bytes would look more careful and would be wrong: it would make
 * publishing an opinion depend on holding a copy, which is the conflation
 * WI-25.9 exists to prevent.
 */
export function mayPublishNotes(book: Offerable): boolean {
  return isContentHash(book.contentHash)
}

/**
 * Whether a fetched file may adopt an existing book's identity — WI-25.4,
 * which blocks release.
 *
 * ⚠️ **A `bookId` IS SAMPLED ABOVE 64 MiB, SO AN ID MATCH IS EVIDENCE AND NOT
 * PROOF.** `contentIdentity.ts` states the trade in as many words, and
 * `marks.test.ts` already builds two unequal 65 MiB files with one `contentId`;
 * positions key on `bookId` alone (`libraryStore.ts`). So a downloaded file
 * that happens to share a sampled identity with a book the reader has annotated
 * would, without this, take that book's anchors and its saved position.
 *
 * ⚠️ **THE CODEBASE ALREADY DOES THIS TWICE AND THIS IS THE SAME RULE, NOT A
 * THIRD ONE.** `marksArchive.ts` demotes an id match when the full digests
 * disagree; `sync/lib/ledger.ts` refuses the conflict outright. Both compare
 * whole-file BLAKE3 and both treat a MISSING hash as proving nothing.
 *
 * ⚠️ **AND A SUCCESSFUL DOWNLOAD DOES NOT COUNT AS PASSING.** The transfer
 * verifies the bytes against the hash they were REQUESTED under; that says the
 * provider was honest, and says nothing about whether those bytes are the book
 * this device already has under that id. The two questions are one apart and
 * WI-25.4's acceptance is explicit that answering the first does not answer the
 * second.
 */
export type AdoptionVerdict =
  /** The digests agree: the same bytes, so the same book. */
  | 'same-book'
  /**
   * The digests disagree: a different file wearing a colliding id.
   *
   * ⚠️ **THE FETCHED FILE IS A NEW BOOK, NOT A REPLACEMENT.** It must not take
   * the held book's marks, cards, anchors or saved position, and the held book
   * must not be overwritten.
   */
  | 'different-book'
  /**
   * One side has no `contentHash`, so nothing is settled.
   *
   * ⚠️ **REFUSED RATHER THAN ALLOWED, AND THAT IS THE OPPOSITE OF WHAT THE
   * ARCHIVE PATH DOES.** `marksArchive.ts` leaves an id match alone when a hash
   * is missing, because refusing on absence would break every import on a build
   * that computes no digest. Here the file arrived from a STRANGER, over a
   * content-addressed transport whose whole premise is that the hash is known —
   * so a fetch with no hash to compare is a fetch that should not have been
   * made, and adopting on it would be the collision this rule exists to stop,
   * reached by a different road.
   */
  | 'unverifiable'

/**
 * Whether a file fetched from a stranger may become the book already held
 * under that id.
 *
 * @param fetched the whole-file digest of what arrived
 * @param held the whole-file digest the device has recorded for that `bookId`
 */
export function mayAdoptIdentity(fetched: string | undefined, held: string | undefined): AdoptionVerdict {
  if (!isContentHash(fetched) || !isContentHash(held)) return 'unverifiable'
  return fetched === held ? 'same-book' : 'different-book'
}

/** Whether a verdict permits the fetched bytes to become the held book. */
export function adopts(verdict: AdoptionVerdict): boolean {
  return verdict === 'same-book'
}

/* ⚠️ **`adoptionRefusedBecause` STOOD HERE AND ITS SENTENCES WERE UNTRUE.**
   It answered, for a refused adoption, *"…so they have been added as a
   separate book."* — a claim about what HAPPENED, made by a function that
   knows only the identity verdict. The import path this phase ships does not
   add a book: `publicPort.importBook` stages the bytes in a folder of their
   own and returns `into-new` precisely so a caller cannot report a book the
   reader has no way to open. So the sentence described a step that does not
   exist, in the reader's own words, and nothing outside its tests ever read
   it.

   The two things it got right are kept where they can act: `ShareImport.why`
   still distinguishes *"these are not your book"* from *"I could not check"*,
   because that difference is real and a surface will need it. The sentence
   itself belongs to the import path, written when there is one, saying what
   that path actually did. Found by audit. */

/** A book already in the library, as the import planner needs to see one. */
export interface HeldBook {
  readonly bookId: string
  readonly contentHash?: string | undefined
  /** Whether this device already holds its bytes. */
  readonly hasContent?: boolean | undefined
}

/**
 * Where a fetched book's bytes are allowed to land — WI-25.4's guard, as the
 * only decision that can act on it.
 *
 * ⚠️ **THE VERDICT IS THE FOLDER, WHICH IS WHY THIS IS NOT A BOOLEAN.**
 * `mayAdoptIdentity` answers a question; a caller that got `false` and then had
 * to decide what to do with the bytes would be making the same judgement again,
 * somewhere else, with less to go on. Here the answer names the destination, so
 * a caller that honours it cannot write a stranger's file over an annotated
 * book — and one that ignores it is visibly ignoring a folder it was given.
 */
export type ShareImport =
  /** These exact bytes are already here. Nothing to fetch. */
  | { readonly kind: 'already-held'; readonly bookId: string }
  /**
   * The library has this book as a row with no bytes, and the digests AGREE.
   *
   * The one case where a fetch may write into an existing book's folder, and
   * it is safe by construction rather than by care: the held record names this
   * exact whole-file digest.
   */
  | { readonly kind: 'into-held'; readonly bookId: string }
  /**
   * The bytes go somewhere of their own.
   *
   * ⚠️ **INCLUDING WHEN A HELD BOOK LOOKED LIKE A MATCH.** `why` names which
   * of `mayAdoptIdentity`'s refusals applied, so the sentence the reader gets
   * can distinguish "these are not your book" from "I could not check";
   * `'no-candidate'` is the ordinary case of a book nobody here has.
   */
  | {
      readonly kind: 'into-new'
      readonly folder: string
      /* ⚠️ **`'same-book'` IS NOT ONE OF THESE, AND THE TYPE USED TO ALLOW
         IT.** `AdoptionVerdict | 'no-candidate'` includes the one verdict that
         means the bytes MAY be adopted — a state this variant documents as
         impossible and the planner never produces. A type that permits a state
         its own comment forbids is a comment, not a type. Found by audit. */
      readonly why: Exclude<AdoptionVerdict, 'same-book'> | 'no-candidate'
    }

/**
 * The staging folder a fetched book lands in when it is not adopting an
 * identity.
 *
 * Derived from the hash, so a retry resumes into the same place rather than
 * littering the vault with one folder per attempt. `pub_` and thirty-two hex
 * digits: alphanumeric and underscore only, well inside the eighty characters
 * `validate_folder` allows, and impossible to confuse with `safeId`'s output
 * for a `book:`-prefixed id.
 */
export function folderForFetch(hash: string): string {
  if (!isContentHash(hash)) throw new Error(`publicShare: not a content hash: ${JSON.stringify(hash)}`)
  return `pub_${hash.slice(0, 32)}`
}

/**
 * Where to put a book fetched by `wanted`, given the book the library offers
 * as a match.
 *
 * `candidate` is whatever the caller found — a row with the same digest, or a
 * row whose id would collide. `undefined` when the library has nothing.
 */
export function planShareImport(wanted: string, candidate: HeldBook | undefined): ShareImport {
  /* ⚠️ **ONE VALIDATION AND ONE FOLDER.** The hash was checked here and then
     checked again inside `folderForFetch` on each of the two `into-new`
     paths — three times for one value, with two spellings of the refusal. The
     folder is the validation: `folderForFetch` throws on anything that is not
     a content hash, so computing it first is both checks at once. */
  const folder = folderForFetch(wanted)
  if (candidate === undefined) return { kind: 'into-new', folder, why: 'no-candidate' }
  const verdict = mayAdoptIdentity(wanted, candidate.contentHash)
  /* ⚠️ **A DIRECT COMPARISON, SO THE TYPE NARROWS.** `adopts(verdict)` answers
     the same question and tells the compiler nothing, which is why `why` had
     to be widened to include `'same-book'` to typecheck. */
  if (verdict !== 'same-book') return { kind: 'into-new', folder, why: verdict }
  /* The digests agree, so these are the same bytes. Whether to fetch at all is
     then a question about what is on this disk, not about identity. */
  return candidate.hasContent === true
    ? { kind: 'already-held', bookId: candidate.bookId }
    : { kind: 'into-held', bookId: candidate.bookId }
}

