import {
  atomicWrite,
  contentPathIn,
  folderOf,
  mergeParsed,
  mergeStranded,
  parseRecord,
  recordPath,
  readBook,
  setTag,
  trashOf,
  updateBook,
  writeBook,
  type BookRecord,
} from './bookFolder'
import type { SyncLevel } from './bookVault'
import {
  clearDirtyMarker,
  hasContentFile,
  invalidateIndex,
  writeDirtyMarker,
  writeIndex,
  type IndexFs,
  type IndexedBook,
} from './bookIndex'
import { measureCover } from './coverFacts'
import { keepCover } from './coverArt'
import {
  TRASH_WINDOW_MS,
  expiredTrash,
  readStamp,
  rescueStrandedMarks,
  restoreBook,
  trashBook,
  trashedIdentity,
  type RestoreOutcome,
} from './bookTrash'
import { hlcOf, type Hlc } from './hlc'
import type { ReadingState, Stars } from './circle/log'
import { normalizeTag, tagKey } from './library'
import { NOOP_RECORDER, REMOVABLE_BLOB_NAMES, recorded, type HashPort, type MutationRecorder } from './ports'
import { PRESENCE_KEY, notePresence, readPresence } from './presence'
import type { WriteQueue } from './writeQueue'
import { canonicalJson } from './canonicalJson'

/**
 * The library — the shelf as a service, with no React in it.
 *
 * ONE VERB WRITES ONE BOOK, and that is the whole shape. Phase 3 published
 * twelve — `record`, `remember`, `rememberOwned`, `rememberJacket`, `forget`,
 * `tag`, `untag`, `setFinished`, `shelve`, `applyFound`, `positionOf`, `rekey` —
 * for a domain with six, because each had to know how to find its field in a
 * flat store and how to persist the whole shelf afterwards. With a book as a
 * folder they collapse into `update`: read one record, change it, write it back.
 *
 * WRITE ORDER IS LOAD-BEARING: `book.json` first, the index after. A crash
 * between them leaves a stale cache until the next scan, which costs nothing.
 * The reverse would leave the cache claiming something no folder has.
 *
 * The in-memory list is updated OPTIMISTICALLY, before the write resolves. A
 * shelf that waits on a file to redraw feels broken, and the cost of being wrong
 * is one row that corrects itself on the next scan — set against a reader
 * watching the tag they just added fail to appear.
 *
 * WHY A SERVICE AND NOT A HOOK. `useLibrary` held all of this in refs and
 * `useState`, which meant the only thing that could change the shelf was a
 * mounted component. A remote service handler — a phone asking the shelf to
 * tag a book — has no component, and giving it a second copy of these verbs
 * would be a second truth. So the verbs live here, once; the hook is an
 * adapter over `getSnapshot`/`subscribe`, and a change made through any
 * caller reaches every subscriber exactly once. Every mutator returns a
 * promise that settles when the write is on disk (or with the write's error),
 * so a caller that needs durability — a service answering a peer — can await
 * it, and a caller that does not — the UI — can let it go.
 */

/**
 * What a rekey did, because the caller has to act on it.
 *
 * `failed` matters: adding the book under its new id after a move that did not
 * happen creates the second folder the move existed to prevent, and every later
 * attempt then stops because the destination exists. A failure has to stop the
 * add, so the next open can try again.
 *
 * `occupied` matters for a different reason: the book exists under BOTH ids and
 * neither is going to move. The other stores must then leave the old copy alone
 * rather than migrating their half of it, or the same mark ends up in two
 * folders under one id and no read of either is authoritative.
 */
export type RekeyOutcome = 'moved' | 'nothing' | 'occupied' | 'failed'

/** One remote change to one book, for `applyRemoteRows`. */
export interface RemoteRow {
  readonly bookId: string
  readonly change: (record: BookRecord) => BookRecord
}

/** A removal the reader can undo: the tag as spelled, and the books that
 *  actually carried it. */
export interface TagRemoval {
  readonly tag: string
  readonly bookIds: readonly string[]
}

/**
 * What one `book.set` may move, in one write.
 *
 * Every field is OPTIONAL and absent means "leave it alone" — including
 * `position.progress`, which is carried from the record rather than defaulted,
 * because omitting it once silently returned the reader to the first page.
 */
export interface BookPatch {
  /* No `title` or `author`: `book.set` was the one caller that sent them,
   * and a stampless prose edit lost to the next parse — `mergeParsed` lets
   * the file win, and sync's metadata group is taken whole by `parsedAt`,
   * which this never moved. Withdrawn from the row (WI-20.7); the per-field
   * register a real rename needs is designed in phase 20's D2, not here. */
  readonly finished?: boolean
  readonly position?: { readonly position: string; readonly progress?: number }
  /**
   * The reader's own opinion of the book — WI-23.B3. Each is its own register
   * and each write stamps it; `status` and `finished` are one fact and a patch
   * naming either moves both under one stamp.
   */
  readonly status?: ReadingState
  readonly rating?: Stars
  /** The whole text; `''` takes a review back (see `BookRecord.review`). */
  readonly review?: string
}

export interface Library {
  /**
   * The write lane this book's FOLDER belongs to.
   *
   * Every writer touching `books/<safeId>/…` must queue here, including the
   * ones outside this store. `folderOf` is many-to-one, so a lane keyed on
   * the raw id splits one directory across two lanes; and a rekeyed book has
   * to stay on the lane its earlier writes are still draining on. Both are
   * `laneFor`'s job, and deriving either again elsewhere is a race that does
   * not show up in a diff.
   */
  lane(bookId: string): string
  /** The shelf as it is right now. Same array until something changes. */
  getSnapshot(): readonly IndexedBook[]
  /** Called once per change of the snapshot. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /**
   * Add a book, or fold a fresh parse into one already here — see `mergeParsed`.
   *
   * `sparse` marks a record that is a PLACEHOLDER rather than a parse: an
   * import knows a filename and nothing else, so it must not be allowed to
   * overwrite a real title, author and subjects. Without it a watched folder
   * degraded every existing record to its filename on startup.
   */
  add(bookId: string, record: BookRecord, sparse?: boolean, guard?: AddGuard): Promise<AddOutcome>
  /**
   * Add a whole import's worth of books, A FEW AT A TIME — see `WRITE_WIDTH`.
   *
   * The reason this exists rather than a loop over `add` in the caller: a
   * folder import called `add` once per book in one synchronous pass, and
   * every call opens its own key on the write queue, which starts draining
   * immediately. Two thousand books therefore put two thousand write chains
   * in flight in a single tick — each one several filesystem round-trips and
   * a journal append — and the writes at the end of that burst failed. A
   * failed record write is not visible to the reader: `commit` drops the row
   * and rewrites the index without it, so the books were copied, silently
   * lost their records, and never appeared. 82 of 1,959 in the case that
   * found this.
   *
   * Resolves with HOW MANY COULD NOT BE SAVED, because the caller is the
   * import and the import is what tells the reader. A count that is thrown
   * away is how the same failure stayed invisible for a whole session.
   */
  addMany(
    entries: readonly { bookId: string; record: BookRecord; sparse?: boolean }[],
  ): Promise<number>
  /** Change one book. The only mutator, because a book is one file. */
  update(bookId: string, change: (record: BookRecord) => BookRecord): Promise<void>
  /** Take a book off the shelf. Its folder goes to the trash, not away. */
  remove(bookId: string): Promise<void>
  /**
   * Bring a removed book back — and say HOW it went.
   *
   * `Promise<boolean>` could not distinguish "there was nothing in the trash"
   * from "half of it could not be moved", and both read as the same word to
   * whoever asked. A partial restore reported as a complete one leaves the
   * reader believing their book is whole while part of it ages towards the
   * sweep.
   */
  restore(bookId: string, guard?: RestoreGuard): Promise<RestoreAnswer>
  /**
   * A removal that arrived FROM ELSEWHERE, with its own stamp: the register
   * decides — last writer wins — and only a win moves the folder. ON THE
   * BOOK'S LANE, both halves in one task, so a re-add of the same book cannot
   * land between the register and the rename (`applyRemoteRemoval` used to
   * write the register from outside every lane, and a guarded `add` could
   * read `live` in between). Answers `lost` for a removal older than what
   * the register holds, which is a stale message and not an error.
   */
  noteRemoteRemoval(bookId: string, at: Hlc): Promise<'removed' | 'lost'>
  /**
   * Where the reader is in a book, and how far through. Identity-guarded, so
   * the page turn that moves nothing writes nothing; progress is clamped to
   * [0, 1] because a hand-edited or remote value past that would draw a bar
   * wider than its track.
   */
  /** A progress not given keeps the record's — read inside the lane, not from a snapshot the caller held. */
  rememberPosition(bookId: string, position: string, progress?: number): Promise<void>
  /**
   * Rewrite the index now, if a position tick left it behind (phase 20, D4).
   *
   * A page turn writes the book's own record and marks the index dirty; the
   * index is rewritten on a throttle, and by this — from the drain at quit,
   * and from the window losing focus or being hidden. Resolves when the
   * rewrite has landed. A no-op when nothing is dirty.
   */
  flushIndex(): Promise<void>
  /** Whether the reader is done with a book. */
  setFinished(bookId: string, finished: boolean): Promise<void>
  /**
   * Several fields at once, in ONE record write.
   *
   * `book.set` used to call `update`, `setFinished` and `rememberPosition` in
   * turn — three queued tasks, three record writes, three journal brackets for
   * one request. A failure in the second left the first persisted with nothing
   * saying so, and two concurrent requests interleaved into a record matching
   * neither of them: caller A's title beside caller B's position, which is a
   * state neither asked for and no retry reproduces.
   *
   * One `update` closes both: the store's task queue serialises it against
   * every other write on the book, and a record write is whole-file, so the
   * request lands entirely or not at all.
   *
   * The registers are stamped from a SINGLE clock reading, so a request that
   * moves both `finished` and `position` stamps them together rather than a
   * microsecond apart.
   */
  patch(bookId: string, fields: BookPatch): Promise<void>
  /** Add one of the reader's own tags. Folded, so case cannot duplicate. */
  tag(bookId: string, tag: string): Promise<void>
  untag(bookId: string, tag: string): Promise<void>
  /**
   * Rename one of the reader's tags on EVERY book that carries it, answering
   * with how many RECORDS actually changed.
   *
   * ONE WRITE PER BOOK: the add and the remove happen in the same record, so
   * a failure cannot leave a book with neither. Renaming onto a name that
   * already exists MERGES — `tag` folds by key, so the books simply end up
   * under one tag. A publisher's subject is untouched: it is not the reader's
   * to rename, and `untag` refuses it anyway.
   *
   * THE COUNT IS THE WRITER'S, for `tagBooks`' reason. A number taken from
   * the snapshot BEFORE the write describes the shelf as it stood when the
   * request arrived, and `tag.rename` published it as a fact about what was
   * written. The two agree for as long as `update` decides from the row it is
   * handed — they are not the same claim, and only one of them is made by the
   * thing that did the writing.
   */
  renameTag(from: string, to: string): Promise<number>
  /** Take one of the reader's tags off every book that carries it. */
  removeTag(tag: string): Promise<void>
  /** How many books a `removeTag` of this tag would touch — see the implementation. */
  ownTagCount(tag: string): number
  /**
   * Add every tag to every book named — one `book.json` write per book.
   *
   * The plural of `tag`, and the only form the shelf's selection and the tag
   * editor use. Spellings are normalised and empties dropped before anything
   * is written, so a caller cannot store a tag the panel could not then name.
   */
  /** Apply these tags, and answer with how many RECORDS actually changed —
   *  a book already carrying the key (in `tags` OR in the publisher's
   *  `subjects`) is skipped, and only the writer knows that. */
  tagBooks(bookIds: readonly string[], tags: readonly string[]): Promise<number>
  /**
   * A whole archive's worth of tags, `WRITE_WIDTH` books at a time — the tag
   * import's verb, and the plural of `tagBooks` the way `addMany` is of `add`.
   *
   * The import looped `tagBooks` once per archived book in one synchronous
   * pass — two thousand write chains in flight in a single tick, which is
   * the flood `addMany` documents — and reported "Added N" before any of
   * them had landed. Failures are COUNTED AND RETURNED beside the count of
   * records that changed, so the notice says what happened rather than what
   * was asked for.
   */
  tagMany(entries: readonly TagEntry[]): Promise<TagManyOutcome>
  /**
   * Whether the LAST write to a book's folder landed.
   *
   * False from a write that failed until any write succeeds; the marks and
   * the cards publish the same flag, and the library was the one store whose
   * failures went to the console and nowhere the reader looks.
   */
  readonly persistent: boolean
  /**
   * The last write that did not land — until the SAME book writes
   * successfully, or the reader dismisses it. Another book's success does
   * not clear it: a page turn in B landing must not make A's lost tag look
   * saved. A second subscription over the same listeners, like `lastRemoval`.
   */
  lastFailure(): SaveFailure | null
  dismissFailure(): void
  /**
   * Take one tag off every book named, and RECORD what was actually taken.
   *
   * The one place a removal is recorded, so the shelf-wide `removeTag` and the
   * editor's remove over a selection offer the same way back — two recorders
   * are two answers to "what did that just take off".
   */
  /** Take this tag off, and answer with how many RECORDS actually changed. */
  untagBooks(bookIds: readonly string[], tag: string): Promise<number>
  /**
   * Adopt a publisher's subject as the reader's OWN tag, on the books whose
   * subjects declare it — and only those, so adopting `Fiction` does not spray
   * it across the shelf. One spelling is written everywhere, so the tag reads
   * as one thing rather than as each publisher's variant of it.
   */
  adoptTag(tag: string): Promise<void>
  /** The books carrying a tag, by id. `ownTagCount` is its length. */
  ownTagBooks(tag: string): readonly string[]
  /** What the last removal took, or null when there is nothing to offer back. */
  lastRemoval(): TagRemoval | null
  /** Put the last removal back, and stop offering it. */
  undoRemoveTag(): Promise<void>
  /**
   * Put a jacket in a book's folder, in order with that book's other writes.
   *
   * `keepCover` does the work; this is about WHEN. Every other write to a
   * book's folder — its record, and the rename that removes it — goes through
   * the per-book queue, and a cover written outside that queue can land after
   * the removal that was supposed to precede it: `mkdir` recreates the folder
   * that was just moved to the trash, leaving a directory containing nothing
   * but a picture of a book that is gone. Serialised, the removal happens
   * first and the write finds no book to write for.
   */
  keepJacket(bookId: string, cover: Blob): Promise<void>
  /**
   * Put a book's bytes in its folder — the open path's copy of the file, in
   * order with that book's other writes and for the same reason as the jacket.
   * Nothing is read from the blob when the file is already there. Resolves
   * with whether it wrote.
   */
  keepContent(bookId: string, name: string, bytes: Blob): Promise<boolean>
  /** The saved position for a book, or null. */
  positionOf(bookId: string | null): string | null
  /**
   * Carry a book onto a new id, for the lazy identity migration.
   *
   * Resolves when it is done, so a caller can order it BEFORE adding the book
   * under its new id — which is the difference between a migration and a
   * duplicate.
   */
  rekeyBook(from: string, to: string): Promise<RekeyOutcome>
  /**
   * Re-derive whether a book's bytes are there, after something outside the
   * kernel — a peer plugin landing a blob — may have changed the answer.
   */
  refreshContent(bookId: string): Promise<void>
  /**
   * Delete this book's stored content and settle the row — ONE task on the
   * book's lane, ONE journal bracket.
   *
   * The service used to do this as four operations: enumerate the folder,
   * call `removeBlob` per file (each its own queued task), then
   * `refreshContent` (another). Content landing concurrently could interleave
   * between them, and a crash after the deletions but before the refresh left
   * the bytes gone, the mutation unjournalled and the index still saying the
   * book was downloaded. Nothing later noticed, because `hasContent` is
   * cached and only a rescan disagrees with it.
   *
   * `candidates` is what the caller believes may be there — the kernel's
   * closed set of removable names, plus whatever the record implies. Which of
   * them actually EXIST is decided inside the task, so the enumeration and the
   * deletion cannot be separated by another writer. Anything outside
   * `REMOVABLE_BLOB_NAMES` is refused rather than deleted: this takes a name,
   * and a name that could reach a path is how a delete leaves the folder.
   *
   * Answers how many files went, so a caller can tell "evicted" from
   * "there was nothing there".
   */
  evictContent(bookId: string, candidates: readonly string[]): Promise<number>
  /**
   * Destroy a trashed book's folder, ON THAT BOOK'S LANE.
   *
   * `emptyTrash` deleted `trash/<folder>` directly, outside the queue every
   * other transition of that book runs on — `remove` moves `books/<f>` into
   * `trash/<f>`, `restore` moves it back, both on `laneFor(bookId)`. So a
   * purge could interleave with either: a restore that had already moved the
   * folder out lost its files to a delete still holding the old path, and a
   * book removed again after the caller's confirmation could be destroyed
   * through the same name it was confirmed under — an ABA, where the path is
   * identical and the contents are not.
   *
   * Queuing here makes the exists-and-delete pair atomic against every other
   * writer for that book, which is the property the one-queue rule already
   * gives records, marks and moves.
   *
   * Answers whether the folder was there and went, so a partial destroy can
   * be reported as one.
   *
   * WITH `unlessStampedAfter`, THE STAMP IS RE-READ INSIDE THE LANE and a
   * folder stamped later than that instant is left. This is what the boot
   * sweep passes: it decided "expired" from a stamp it read off-lane, and a
   * restore queued ahead of the purge on the same lane may have re-stamped
   * the folder — a partial restore keeps the files it could not move and
   * gives them a fresh fortnight. Deleting on the old decision was the sweep
   * eating what the restore had deliberately kept.
   */
  purgeTrashed(bookId: string, options?: PurgeOptions): Promise<boolean>
  /**
   * THE BOOT SWEEP: every trashed folder whose stay is over, purged on its
   * own book's lane with the stamp re-read there. Answers the folders that
   * went. Best effort per folder; one that will not go does not stop the
   * others, and nothing here throws for an unreadable stamp — that folder is
   * left, as the trash's contract says.
   */
  emptyExpiredTrash(now?: number): Promise<string[]>
  /**
   * Apply a batch of changes that arrived from elsewhere: one `updateBook`
   * per row on that book's queue, ONE index write for the batch, one
   * notification for the batch. Rows for books not on the shelf are skipped.
   * Rejects after the batch if any row's write failed, naming them all.
   */
  applyRemoteRows(rows: readonly RemoteRow[]): Promise<void>
}

/**
 * What an add is judged against INSIDE THE BOOK'S LANE. Both fields exist
 * because a decision made outside the lane is a decision about a folder
 * somebody else may take before the write runs.
 */
export interface AddGuard {
  /**
   * The stamp of the state an add that arrived FROM ELSEWHERE carries. A
   * register that says `removed` LATER than this is a removal the sender had
   * not heard, and the add is refused rather than restoring the book.
   */
  readonly asOf?: Hlc
  /**
   * This add CREATES the book: refuse if the folder is already spoken for.
   *
   * ⚠️ **`add` FOLDS, IT DOES NOT REFUSE** — that is its whole contract, and it
   * is right for the shelf: a re-import merges a fresh parse into the record,
   * and a re-add of a removed book restores it. `book.add` means something
   * else, and it checked for itself: it read the shelf snapshot and scanned the
   * trash, and only then called in here. Between the scan and the queued write
   * a folder can be taken — by an aliasing `book.add` whose optimistic row this
   * one then REPLACED, or by a removal that put the folder in the trash for the
   * write to silently restore and relabel. Two logical books, one folder,
   * success reported to both callers.
   *
   * So the decision is made where the act is: the FOLDER is read inside the
   * lane, and the answer is `folder-taken`. The caller's own scan stays — it
   * has the wider reach (it folds case, which an id-derived path cannot on a
   * case-sensitive filesystem) and it names the occupant — but it is the
   * diagnosis, not the decision.
   */
  readonly fresh?: true
}
export type AddOutcome = 'added' | 'removed-since' | 'folder-taken'

/** What a guarded restore is judged against — see `Library.restore`. */
export interface RestoreGuard {
  /**
   * Bring the folder back only if the record in it names THIS book.
   *
   * The same hazard as `AddGuard.fresh` and the same answer: `folderOf` is
   * many-to-one, so a restore that matched the path alone brought somebody
   * else's book back relabelled. `book.restore` reads the trash and refuses
   * that before it calls in here, but the folder can change hands between the
   * two — a removal of an aliasing id lands in exactly the folder the restore
   * is about to empty. Read in the lane, it cannot.
   */
  readonly onlyThisBook: true
}

/**
 * What the STORE's restore answers: the trash primitive's outcome, plus the two
 * answers only a guarded restore can give.
 *
 * `mismatch` is kept OUT of `RestoreOutcome` on purpose. That type is
 * `restoreBook`'s contract — what moving files can result in — and this is a
 * refusal made before anything moves, by a caller that asked for it. So is
 * `unreadable`, which is the same refusal without a name to put on it: a
 * record that will not read says nothing about whose book a folder holds, and
 * a guard that cannot establish identity must not proceed as though it had.
 */
export type RestoreAnswer =
  | RestoreOutcome
  | { readonly state: 'mismatch'; readonly bookId: string }
  | { readonly state: 'unreadable'; readonly at: 'trash' | 'shelf' }

/** One archived book's tags to apply — what `tagMany` takes. */
export interface TagEntry {
  readonly bookId: string
  readonly tags: readonly string[]
}

export interface TagManyOutcome {
  /** Records that actually changed — a book already carrying the tag is not one. */
  readonly changed: number
  /** Books whose write did not land. */
  readonly failed: number
}

/**
 * A write that did not land, as the shelf reports it.
 *
 * `title` is what the status line names, resolved when the failure happened
 * — the repair that follows a failed write may take the row off the shelf,
 * after which there is nothing left to look it up in.
 */
export interface SaveFailure {
  readonly bookId: string
  readonly title: string
  readonly what: 'record' | 'removed'
  readonly message: string
}

export interface PurgeOptions {
  /** Leave the folder if its `.removed` stamp is later than this instant. */
  readonly unlessStampedAfter: number
}

export interface LibraryOptions {
  /** The library's filesystem, or null outside Tauri — then nothing is written. */
  readonly fs: IndexFs | null
  /**
   * The ONE queue every write to a book's folder goes through — shared with
   * the marks store, so a record write and a marks write for the same book
   * are serial, which is what two separate queues could never guarantee.
   */
  readonly queue: WriteQueue
  readonly initial?: readonly IndexedBook[]
  readonly recorder?: MutationRecorder
  /**
   * The hash port, read per call — bound late by the peer capability. With
   * one, a jacket the store keeps is measured and its facts stamped on the
   * record (WI-23.C5); without one, the facts wait for the circle's pass.
   */
  readonly hashes?: () => HashPort | null
  /**
   * The stamp for the presence register's writes. The default is the legacy
   * clock — wall time, counter zero, the zero device — which is monotone only
   * as far as the wall clock is and is enough with no sync composed; the sync
   * capability injects its real HLC here at composition.
   */
  readonly clock?: () => Hlc
}

/** One file as text, or null when it is not there or will not read. */
async function readText(fs: IndexFs, path: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await fs.readFile(path))
  } catch {
    return null
  }
}

/** A value serialised with keys sorted at every depth — so two objects that
 *  say the same thing compare equal whatever order their keys were built in. */

/** Two rows say the same thing. CANONICAL, not the raw serialisation: the
 *  register writers (`setTag`) rebuild a record with its keys in a different
 *  order than `parseRecord` does, and a reconcile that treated key order as
 *  a change published a notification for a row that had not changed. */
/* The kernel's own canonical spelling — the one `signedBytes` uses — so a
   key the local copy dropped (`__proto__` on a plain object) is compared too. */
const sameRow = (a: IndexedBook, b: IndexedBook): boolean => canonicalJson(a) === canonicalJson(b)

/**
 * How many books this store writes at once.
 *
 * Every verb here that touches MANY books — an import, a tag rename across the
 * shelf, a batch of remote rows — used to hand the whole list to the write
 * queue in one pass. The queue serialises per key and a book's key is its own
 * folder, so "one pass" meant every book's chain started in the same tick:
 * two thousand books, each several filesystem round-trips and a journal
 * append, all in flight together. The tail of that burst failed.
 *
 * BOUNDED AT THE PRODUCER, NOT IN THE QUEUE, and the distinction is
 * load-bearing. Capping how many KEYS the queue drains at once looks like the
 * tidier fix and deadlocks: a task running on a book's key awaits other keys
 * from inside itself — the journal's `begin`/`commit` bracket on
 * `JOURNAL_KEY`, and `noteContent`'s index write — so a full pool of book
 * tasks would all be waiting for a key that can never be given a slot. The
 * queue must stay unbounded; the callers must stop flooding it.
 *
 * Matched to `SCAN_WIDTH`'s reasoning and half its value: the cost is IPC
 * round-trips, a handful in flight overlaps the latency, and a write is
 * several round-trips plus an fsync where a scan is two small reads.
 */
export const WRITE_WIDTH = 8

/**
 * How long the index may sit behind a position tick before it is rewritten
 * (phase 20, D4). Fifteen seconds: Chromium commits its prefs every ten,
 * Firefox its session store every fifteen, and Readest throttles its
 * library file at thirty — and a drain, a blur or a hidden tab flushes at
 * once, so the timer is the ceiling and not the usual case.
 */
export const INDEX_FLUSH_MS = 15_000

/**
 * Run `work` over every item, at most `width` in flight, gathering failures
 * rather than stopping at the first.
 *
 * `Promise.allSettled(list.map(...))` — which this replaces in four places —
 * gathers failures too, and starts every item at once, which is the defect.
 * One item failing must not cost the rest, so the failure is caught per item
 * and the reasons are returned for the caller to raise as it sees fit.
 */
async function pooled<T>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<void>,
): Promise<unknown[]> {
  const failures: unknown[] = []
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const at = cursor
      cursor += 1
      if (at >= items.length) return
      try {
        await work(items[at]!)
      } catch (cause) {
        failures.push(cause)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
  return failures
}

/** The gathered failures, raised the way every batch verb here raises them. */
function raiseGathered(failures: readonly unknown[], what: string): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, `${failures.length} ${what}`)
}

/**
 * A shelf row rebuilt from a record — the one place that shape is decided.
 *
 * `hasContent` is the field the record does NOT carry: it is knowledge the
 * index holds about whether the book's bytes are here, so it has to be handed
 * in and carried across, or every reconcile after a write silently forgets it
 * and the shelf offers to open a book it cannot.
 */
export function asRow(record: BookRecord, bookId: string, hasContent: boolean | undefined): IndexedBook {
  /* STRIPPED before the spread, not trusted to be absent. `BookRecord` has no
   * such field, but a caller can hand a row here without noticing — and a
   * smuggled flag surviving an `undefined` argument would make "carries
   * knowledge, invents none" true in the tests and false at runtime. */
  const { hasContent: _stray, ...clean } = record as BookRecord & { hasContent?: boolean }
  return { ...clean, bookId, ...(hasContent === undefined ? {} : { hasContent }) }
}

/**
 * A row as the RECORD it is a view of — `asRow`'s twin.
 *
 * `bookId` and `hasContent` are the index's, not the book's: one is the key
 * the row is filed under, the other is derived by the scan. A change function
 * is record-to-record and must not be shown either, and the identity check
 * that decides whether anything moved must not be comparing against them —
 * handed a row with the flag still on it, a merge that changed nothing
 * returned a fresh object, and a sync session that should have been a no-op
 * wrote a line into the journal for every book it re-served.
 */
export function recordOfRow(row: IndexedBook): BookRecord {
  const { bookId: _id, hasContent: _flag, ...record } = row
  return record
}

export function createLibrary({
  fs,
  queue,
  initial = [],
  // Stryker disable next-line ArrowFunction: no port at all reads as no port — the measure fails and is caught.
  hashes = () => null,
  recorder = NOOP_RECORDER,
  clock = () => hlcOf(Date.now()),
}: LibraryOptions): Library {
  /**
   * Set one book's presence register, serialised on the register's own queue
   * key — two books' removals run on two book keys, and the register is ONE
   * file, so the read-modify-write inside `notePresence` needs a key of its
   * own. Awaited from inside a book's queued task, which is safe: the queue
   * holds no lock across keys, so a task on `book:x` awaiting a task on the
   * presence key cannot deadlock. Failures propagate — a removal whose
   * register write failed must not proceed to the rename, or the removal
   * becomes invisible to replication.
   */
  const settlePresence = (
    target: IndexFs,
    bookId: string,
    state: 'live' | 'removed',
    at: Hlc,
  ): Promise<void> => queue.append(PRESENCE_KEY, async () => void (await notePresence(target, bookId, state, at)))

  /**
   * A re-add makes a REMOVED book live again in the register. Only when the
   * register currently says removed: an ordinary add — which is nearly every
   * add — leaves the file untouched, so importing a folder of two thousand
   * books costs two thousand reads of one small file and zero writes, not
   * two thousand rewrites of it.
   */
  const noteReAdd = (target: IndexFs, bookId: string): Promise<void> =>
    queue.append(PRESENCE_KEY, async () => {
      const held = (await readPresence(target))[bookId]
      if (held?.state === 'removed') await notePresence(target, bookId, 'live', clock())
    })
  /** The list as it is right now — the authority between notifications. */
  let books: readonly IndexedBook[] = initial

  /**
   * Where a book's writes QUEUE, and where they LAND, across a rekey.
   *
   * A rekey renames the folder under a book, so two things move and they move
   * differently. The PATH follows the book — a write enqueued under the old id
   * before the rename must land in the new folder when its turn comes, which
   * is what `rekeyed` resolves. The LANE must NOT follow it: a write that
   * hopped lanes mid-flight could be overtaken by one enqueued after it, so
   * `lanes` routes the NEW folder's lane back onto the old one and every write
   * for the book — issued under either id, before or after the move — stays in
   * a single lane in the order it was asked for.
   *
   * The alias is set BEFORE the rekey's task is enqueued, so no new-id write
   * can slip into an unaliased lane while the rename is still queued. A rekey
   * that then finds the destination occupied leaves the alias behind — two
   * folders over-serialised on one lane, which costs a moment of latency and
   * no correctness, against un-aliasing a lane other tasks may already be
   * queued on.
   */
  const lanes = new Map<string, string>()
  const rekeyed = new Map<string, string>()

  /** A map followed to its end, cycle-safe. */
  const follow = (start: string, map: ReadonlyMap<string, string>): string => {
    let at = start
    const seen = new Set([at])
    for (;;) {
      const next = map.get(at)
      if (next === undefined || seen.has(next)) return at
      seen.add(next)
      at = next
    }
  }

  /* THE FOLDER IS THE LANE, not the id as spelled: two spellings of one id
   * (`book:abc` and its folder name `book_abc`) name one directory, and a
   * queue exists to serialise what contends for one directory.
   *
   * AND FOLDED, because the filesystem folds. macOS's default APFS volume is
   * case-INSENSITIVE, so `books/Case` and `books/case` are ONE directory —
   * `book.add` already folds for exactly this reason, and `migrateToFolders`
   * before it. Keyed case-sensitively, two ids differing only in case took
   * two lanes over one folder: both adds read an empty folder inside their
   * own lane, both passed the `fresh` guard, and the second record replaced
   * the first while both callers were told their book was added. The lane
   * guard's whole claim is that the decision is made where the act is, and a
   * lane that does not cover the folder does not make that true.
   *
   * On a case-SENSITIVE filesystem this over-serialises two genuinely
   * different folders — the same trade the rekey alias above already takes,
   * and for the same reason: a moment of latency against a race nobody can
   * see in a diff. */
  const laneKey = (bookId: string): string => folderOf(bookId).toLowerCase()
  const laneFor = (bookId: string): string => follow(laneKey(bookId), lanes)
  /** Where a book's writes land NOW — `rekeyed` followed to the end. */
  const resolveId = (bookId: string): string => follow(bookId, rekeyed)
  const listeners = new Set<() => void>()

  /** Tell every subscriber to re-read. Its own function because not every
   *  change is a change to the LIST — the undo offer moves on its own. */
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }

  const publish = (next: readonly IndexedBook[]) => {
    books = next
    notify()
  }

  /* WHETHER THE LAST WRITE LANDED, and which one did not. Both published
   * through the same listeners as the list, read by their own getters — the
   * status line subscribes to the failure the way the settings pane subscribes
   * to its store's flag, so the notice appears on the write that failed
   * rather than on the next one that worked. */
  let persistent = true
  let failure: SaveFailure | null = null
  const noteFailed = (bookId: string, what: SaveFailure['what'], cause: unknown, predicted: readonly IndexedBook[]) => {
    /* NAMED NOW. The repair below may take the row off the shelf, and a
     * failure the status line can only call by its id is one the reader
     * cannot connect to anything they did. */
    const row = predicted.find((one) => one.bookId === bookId) ?? books.find((one) => one.bookId === bookId)
    const title = row?.title || bookId
    persistent = false
    failure = { bookId, title, what, message: cause instanceof Error ? cause.message : String(cause) }
    notify()
  }
  const noteLanded = (bookId: string) => {
    const cleared = failure !== null && failure.bookId === bookId
    if (persistent && !cleared) return
    persistent = true
    if (cleared) failure = null
    notify()
  }
  const lastFailure: Library['lastFailure'] = () => failure
  const dismissFailure: Library['dismissFailure'] = () => {
    if (failure === null) return
    failure = null
    notify()
  }

  /**
   * Put what the disk actually holds back into the row.
   *
   * The optimistic update is a prediction; this is the correction. It runs after
   * a write that merged with the on-disk record, so it is the only path by which
   * a field the index never knew about reaches the shelf. When the prediction
   * was right nothing is published — a subscriber hears once per change, not
   * once per confirmation.
   */
  const reconcile = (bookId: string, record: BookRecord) => {
    const at = books.findIndex((one) => one.bookId === bookId)
    if (at === -1) return
    const was = books[at]!
    const row = asRow(record, bookId, was.hasContent)
    if (sameRow(was, row)) return
    const next = [...books]
    next[at] = row
    publish(next)
  }

  /* THE DIRTY LIST (phase 20, D4) — which books `book.json` is ahead of the
   * index on, and a generation that says whether a flush saw all of it.
   *
   * Every position save used to rewrite `index.json` whole: ~1 MB every two
   * seconds at 2 000 books. A tick now writes the record at the barrier
   * level and puts the book here; the index is rewritten on a throttle, at
   * quit, and when the window blurs or hides. The marker on disk is written
   * once per dirty PERIOD — when a book joins the set — not per tick, and
   * `loadShelf` re-reads the listed records before trusting the cache.
   *
   * THE GENERATION IS THE COMPARE-AND-CLEAR KEY, Calibre's `dirtied_sequence`.
   * A flush captures it before serialising; a tick that lands while the
   * flush is writing bumps it; the flush then finds it moved and leaves the
   * marker standing — so a crash before the next flush still re-reads the
   * book the index missed. A one-bit marker was refuted on exactly that
   * interleaving (round 2, #4). */
  const dirty = new Set<string>()
  let generation = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let flushing: Promise<void> | null = null

  /**
   * The index, rewritten whole from the newest state, on its own key —
   * and the dirty marker cleared, if and only if nothing was dirtied while
   * the rewrite was in flight.
   */
  const writeIndexNow = (target: IndexFs) =>
    /* The index LAST, and on its own key so a book's write is never held up
     * by it. Rewritten whole from `books`, which is the newest state by the
     * time this runs — a cache should describe where things ended up, not
     * where one write thought they were going. */
    queue.push('index', async () => {
      const captured = generation
      await writeIndex(target, books)
      if (captured === generation) {
        if (dirty.size === 0) return
        dirty.clear()
        await clearDirtyMarker(target)
      } else {
        /* A tick landed mid-write. The index just installed is behind it;
         * the marker must be on disk for it — re-stated whole, because the
         * one the period began with may name fewer books than are dirty. */
        await writeDirtyMarker(target, { version: 1, generation, books: [...dirty] })
      }
    })

  /**
   * A position tick's half of the index: the book joins the dirty set, the
   * marker is written when it does (APPENDED on the index key, so a
   * structural rewrite queued behind it cannot coalesce it away — the queue
   * keeps appended tasks and replaces only pushed ones), and the throttled
   * flush is armed.
   */
  const markDirty = (target: IndexFs, bookId: string): Promise<void> => {
    generation += 1
    const joined = !dirty.has(bookId)
    dirty.add(bookId)
    armFlush()
    if (!joined) return Promise.resolve()
    const marker = { version: 1 as const, generation, books: [...dirty] }
    return queue.append('index', () => writeDirtyMarker(target, marker))
  }

  const armFlush = () => {
    if (flushTimer !== null) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flushIndex().catch((cause: unknown) => console.error('Paper: could not save the shelf index', cause))
    }, INDEX_FLUSH_MS)
    /* A timer must not keep a Node process — `paper` — alive for a flush
     * its drain will run anyway; a browser's timer has no such handle. */
    ;(flushTimer as { unref?: () => void }).unref?.()
  }

  const flushIndex: Library['flushIndex'] = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (!fs || dirty.size === 0) return Promise.resolve()
    /* ONE IN FLIGHT: a blur and a drain a moment apart share the rewrite
     * rather than queueing two. */
    flushing ??= writeIndexNow(fs).finally(() => {
      flushing = null
    })
    return flushing
  }

  /**
   * What a commit may do BEFORE the recorder's `begin`, inside the lane.
   *
   * `before` reads and decides — and may itself record a bracket of another
   * kind, as `add` does for the presence flip. `'refuse'` means the write
   * does not happen: no `begin` was issued (a bracket begun and abandoned
   * would be recovered at the next open as a phantom local commit and
   * PUSHED), and `retract` puts the optimistic row back where it was.
   */
  interface CommitHooks {
    readonly before: (target: IndexFs, live: string) => Promise<'go' | 'refuse'>
    readonly retract: () => void
  }

  /**
   * How a commit treats the index once its folder write has landed.
   *
   * `now` rewrites it whole — every structural change: a row added or
   * removed, a tag, a rekey. `defer` marks the book dirty and leaves the
   * rewrite to the throttle: the position tick, which is the one write that
   * happens every two seconds and changes nothing the folder listing can
   * see.
   */
  type IndexPolicy = 'now' | 'defer'

  /** State first, then the folder, then the index. */
  const commit = (
    key: string,
    next: readonly IndexedBook[],
    what: 'record' | 'removed',
    write: (target: IndexFs, live: string) => Promise<BookRecord | null | void>,
    hooks?: CommitHooks,
    index: IndexPolicy = 'now',
  ): Promise<void> => {
    publish(next)
    if (!fs) return Promise.resolve()
    const target = fs
    const lane = laneFor(key)
    let refused = false
    /* What the disk write actually produced, IN THREE ANSWERS.
     *
     * A RECORD is what landed. `updateBook` applies the change to what is ON
     * DISK and answers the merged record — and discarding that answer meant a
     * stale cached row (an index one write behind after a crash) stayed
     * published, and was then SERIALISED into the index below: the write landed
     * right and the cache wrote the lie back.
     *
     * `null` IS "NOTHING LANDED", and it used to be read as "no record to
     * reconcile" — which left the optimistic row on the shelf and in the index
     * over a write that never happened. `updateBook` answers it in exactly two
     * situations and both mean the book is not on disk: the folder holds no
     * `book.json` at all (present-but-unreadable THROWS, so this is genuinely
     * absent), or a removal renamed the folder away mid-write and the shell it
     * had recreated was undone. Predicting a change to a book that is gone is
     * the phantom this whole file's repair path exists to keep out of
     * `index.json`.
     *
     * `undefined` is a write that does not report a record — the removals — and
     * leaves the row exactly as the caller published it. */
    let landed: BookRecord | null | void
    return (
      queue
        /* APPEND, not replace. Each task here applies a CHANGE to what is on
         * disk — a tag, then a position — and coalescing two of them drops the
         * first. Marks can coalesce because each of those writes the whole list;
         * these cannot, and the distinction is why the queue has two methods. */
        /* BRACKETED — `begin` before the folder write and `commit` after it,
         * inside the queued task, so a recorder sees the change with nothing
         * else touching the book in between. */
        .append(lane, async () => {
          /* RESOLVED AT RUN TIME — the book may have been carried onto a new
           * id while this write waited its turn. The PATH follows the book;
           * the LANE never has to, because a rekey routes the destination's
           * lane back onto this one — see `lanes`. */
          const live = resolveId(key)
          if (hooks && (await hooks.before(target, live)) === 'refuse') {
            refused = true
            return
          }
          landed = await recorded(recorder, live, what, () => write(target, live))
        })
        .then(() => {
          if (refused) {
            hooks!.retract()
            return writeIndexNow(target)
          }
          const live = resolveId(key)
          noteLanded(live)
          if (landed === null) {
            /* NOTHING LANDED, so nothing may claim it did — see `landed`. The
             * queue is healthy (this is not a failed write, it is a write with
             * no book to apply to), but the row predicted a change to a folder
             * that holds no record, so it goes and the index is rewritten
             * WITHOUT it. Leaving it published put the phantom on the screen
             * and then serialised it: folder membership is unchanged, so
             * `loadShelf` trusts that cache and an idle book's `book.json` is
             * never re-read to contradict it. The lie outlived the session.
             *
             * `now` whatever the policy says: a row leaving the shelf is
             * structural, and a position tick that discovers its book is gone
             * must not leave the correction to a throttle a quit can outrun. */
            if (books.some((one) => one.bookId === live)) {
              publish(books.filter((one) => one.bookId !== live))
            }
            return writeIndexNow(target)
          }
          if (landed) reconcile(live, landed)
          return index === 'defer' ? markDirty(target, live) : writeIndexNow(target)
        })
        .catch(async (cause: unknown) => {
          /* SAID FIRST, before the repair — which is a further write that may
           * itself fail, and whose failure must not be the only one heard. */
          noteFailed(resolveId(key), what, cause, next)
          /* THE FOLDER WINS, NOW — not at some later read that may never come.
           *
           * The optimistic row predicted a write that did not land, and worse,
           * another book's commit may already have serialised that phantom
           * into the index — which is then TRUSTED, because folder membership
           * has not changed, and an idle book's `book.json` is never re-read
           * while the cache is trusted. Repairing memory alone left the lie
           * durable across launches.
           *
           * The repair is a task IN THE BOOK'S LANE: serial behind every write
           * already queued for it, whose outcomes are what it must read, and
           * inside the queue the close-time flush waits on. */
          try {
            await queue.append(lane, async () => {
              const live = resolveId(key)
              const truth = await readBook(target, live)
              if (truth) {
                reconcile(live, truth)
                await measureContent(target, live)
                return
              }
              /* NOTHING READABLE BACKS THE ROW — the write failed AND the
               * folder holds no record this can read, so there is no state the
               * row can honestly show; a scan would not shelve it either. The
               * row goes, and the index written below omits both the book and
               * its folder claim — so a folder actually sitting there makes
               * the next launch's listing DISAGREE and rescan, instead of
               * trusting a cache this session could not confirm. */
              if (books.some((one) => one.bookId === live)) {
                publish(books.filter((one) => one.bookId !== live))
              }
            })
            /* AND THE CORRECTED PICTURE REACHES THE DISK — the whole point.
             * Without this the phantom serialised by the other book's commit
             * stayed in `index.json` with folder membership unchanged, and the
             * next launch believed it. */
            await writeIndexNow(target)
          } catch (repair: unknown) {
            console.error('Paper: could not repair the shelf after a failed save', repair)
            /* THE LAST RESORT, and only here. The repair above is the right
             * answer because it writes a CORRECTED picture; this is the blunt
             * instrument, reached when even that could not be written. At that
             * point the index on disk may hold a phantom this session cannot
             * correct, and `loadShelf` trusts the index whenever the folder
             * listing agrees — so the honest move is to leave no cache to
             * trust. A rescan is the cost of not knowing.
             *
             * AND ITS OWN FAILURE IS THE LAST THING LEFT TO SAY. Swallowed
             * whole, a stale index holding a phantom row stayed on disk AND
             * stayed trusted at the next launch — exactly the corruption this
             * line exists to prevent — with nothing anywhere recording that
             * the prevention had not happened. Still best effort: the caller
             * hears `cause`, which is the failure it asked about. */
            await invalidateIndex(target).catch((why: unknown) => {
              console.error('Paper: the stale shelf index could not be thrown away either', why)
            })
          }
          /* RE-THROWN. The verbs return their promise to the caller — the hook
           * reports a failed save, `eachBook` gathers failures across a shelf —
           * so swallowing it here would make a write that did not happen look
           * like one that did. */
          throw cause
        })
    )
  }

  /**
   * How a record change is written: how hard the record is synced, and
   * what happens to the index. Every caller but the position tick takes the
   * defaults — full sync, index now.
   */
  interface WriteWith {
    readonly level: SyncLevel
    readonly index: IndexPolicy
  }
  const STRUCTURAL: WriteWith = { level: 'full', index: 'now' }
  /* The position tick (phase 20, D3/D4): the record at the barrier level —
   * ordered, not waited for; a position lost to a power cut is a page, not
   * a book — and the index deferred behind the dirty list. */
  const TICK: WriteWith = { level: 'barrier', index: 'defer' }

  const updateWith = (bookId: string, change: (record: BookRecord) => BookRecord, how: WriteWith): Promise<void> => {
    const at = books.findIndex((one) => one.bookId === bookId)
    const current = at === -1 ? null : books[at]
    if (!current) return Promise.resolve()
    const record = recordOfRow(current)
    const next = change(record)
    // By identity, so a change that decides nothing moved writes nothing —
    // this runs on every page turn.
    if (next === record) return Promise.resolve()
    const list = [...books]
    /* THE FLAG SURVIVES A CALLBACK THAT BUILDS ITS RESULT. `change` is
     * record-to-record and is under no obligation to spread its input, so a
     * callback returning a fresh object used to strip the derived flag from
     * the row on the way through — the same defect `add` had, wearing the
     * other mutator. */
    list[at] = asRow(next, bookId, current.hasContent)
    return commit(
      bookId,
      list,
      'record',
      (target, live) =>
        /* THE CHANGE, not the result. Passing `() => next` wrote the in-memory
         * record back — and that copy can be stale, because it came from an
         * index that may be one write behind after a crash. Handing the function
         * over means it is applied to whatever is actually on disk.
         *
         * `live` rather than `bookId`: the book may have been carried onto a new
         * id while this write waited its turn — see `rekeyed`. */
        updateBook(target, live, change, how.level),
      undefined,
      how.index,
    )
  }

  const update: Library['update'] = (bookId, change) => updateWith(bookId, change, STRUCTURAL)

  /**
   * Whether a row's bytes are back, checked and recorded. Runs INSIDE a
   * queued task for the book (so it must not queue on the book's key itself)
   * and writes the index on the index key when the answer changed.
   */
  const measureContent = async (target: IndexFs, bookId: string): Promise<void> => {
    const now = await hasContentFile(target, bookId)
    /* NULL IS NOT FALSE. The folder could not be listed, which says nothing
     * about whether the bytes are there — writing it in as `false` is how a
     * transient failure to look disabled a book whose content was sitting
     * right beside it. Carry what the index already had. */
    if (now === null) return
    const where = books.findIndex((one) => one.bookId === bookId)
    if (where === -1) return
    const row = books[where]!
    if (row.hasContent === now) return
    const list = [...books]
    list[where] = { ...row, hasContent: now }
    publish(list)
  }

  /**
   * The measurement, and the index write that records it.
   *
   * For callers that are NOT inside a `commit` — which writes the index itself
   * once its task resolves, so measuring inside one must not write it a second
   * time. On the index key, like every other index write: called directly from
   * a per-book task it shared the fixed `index.json.writing` path with them,
   * and re-adding a folder of disabled books starts one of these per book, so
   * they raced each other and an older list could land last. Being unchanged
   * in folder membership, that stale cache is then trusted, and the repaired
   * book goes back to disabled. AWAITED, so a failure is the caller's.
   */
  const noteContent = async (target: IndexFs, bookId: string): Promise<void> => {
    await measureContent(target, bookId)
    await writeIndexNow(target)
  }

  const add: Library['add'] = async (bookId, record, sparse = false, guard) => {
    /* MATCHED BY FOLDER, not by the id as spelled. `safeId` is not reversible
     * and not injective, so a record written before the id was stored comes
     * back off the scan as its directory name — `book_abc` for `book:abc` —
     * and a content-derived add would then miss it and put a SECOND row on the
     * shelf for the one folder both resolve to. */
    const at = books.findIndex((one) => folderOf(one.bookId) === folderOf(bookId))
    const previous = at === -1 ? null : books[at]
    /* A PLACEHOLDER over a real record does nothing. An import supplies a
     * filename for a title and an empty author; `mergeParsed` treats what it
     * is given as the book's own account of itself, which is right for a
     * parse and destructive for a guess. */
    if (sparse && previous) {
      /* A GUARD MUST NOT BE SKIPPED BY A SHORTCUT. This path answers before
       * the lane, so `fresh` would silently not apply — and a row already
       * holding the folder is precisely what it refuses. The same refusal, one
       * step earlier; a guard that quietly does nothing on one route through
       * its own function is a defect generator. */
      if (guard?.fresh) return 'folder-taken'
      /* NOTHING TO THE SHELF, but the trash may still hold half of this book
       * from a restore that could not finish — and returning here was the only
       * path to `add` that never looked. A watched folder rescanning on every
       * launch would then sail past the stranded files until the sweep deleted
       * them. */
      if (!fs) return 'added'
      const target = fs
      await queue.append(laneFor(bookId), () => {
        /* THE ID AS IT IS NOW. This branch took the rekey-aware lane and
         * then used the id it was CALLED with for every restore, presence,
         * trash and record operation — so a rekey queued ahead of it had the
         * repair recreate and write the obsolete folder. */
        const here = resolveId(bookId)
        return recorded(recorder, here, 'record', async () => {
          /* BEST EFFORT, and swallowed HERE rather than inside the
           * primitive. This is a repair folded into an add: a trash entry
           * that cannot be read must not stop the reader adding the book,
           * and the sweep or the next add will meet the leftovers again.
           * The explicit `restore` above propagates the same failure,
           * because there the fault IS the answer. */
          await restoreBook(target, here).catch(() => ({ state: 'absent' }) as const)
          await noteReAdd(target, here)
          /* AND THE SAME RESCUE the full path does. Returning after the
           * restore alone left a `book.json` the restore could not move
           * sitting in the trash — so a folder import, which is all sparse
           * adds, was the one route that could see the stranded record and
           * walk past it. */
          await rescueStrandedMarks(target, here)
          /* AND THE ROW LEARNS THE BOOK HAS BYTES AGAIN.
           *
           * This is the path an import takes for a book already on the
           * shelf, and it is the exact remedy `CANNOT_OPEN` tells the reader
           * to perform — "add the file again". The import writes the missing
           * content and then reaches here, which returned without touching
           * the row: so the book stayed disabled, the cache kept
           * `hasContent: false`, folder membership had not changed, and the
           * stale flag was trusted on every launch after. The advertised
           * repair repaired nothing. */
          /* THE FLAG IS MEASURED EVERY TIME, not only when the row said
           * `false`. This path is every re-import of a folder — it is the
           * exact remedy `CANNOT_OPEN` prescribes, "add the file again" — and
           * it is also where a row whose first measurement was suppressed
           * comes to be healed. Measuring only the `false` rows repaired the
           * advertised case and no other: an `undefined` row stayed flagless
           * for ever, which is the launch-rescan defect through the one door
           * that never measured, and a stale `true` kept claiming bytes that
           * are gone. AFTER the restore, so bytes the trash just gave back are
           * counted. */
          await noteContent(target, resolveId(previous.bookId))
          const stranded = parseRecord(await readText(target, `${trashOf(here)}/book.json`))
          if (!stranded) return
          const live = await readBook(target, here)
          await writeBook(target, here, live ? mergeStranded(stranded, live) : stranded)
          await target.remove(`${trashOf(here)}/book.json`).catch(() => {})
        })
      })
      return 'added'
    }
    /* A fresh parse folded into what the reader owns. The book is the
     * authority on its own metadata; the reader is the authority on their
     * tags, their place in it, and whether they are done. */
    const { bookId: _id, ...prior } = previous ?? { bookId: '' }
    const merged = mergeParsed(previous ? (prior as BookRecord) : null, record)
    /* THE INCOMING ID WINS, which is what makes matching by folder safe rather
     * than merely tolerant. `bookId` here is derived from the content; a row
     * that matched by folder under a different spelling is one whose record
     * predates the id being stored. Taking the canonical one now — and
     * `writeBook` stamps it into the record — means `update`, `remove` and
     * `positionOf` see one id from this point on, instead of an alias that
     * resolves to the same folder and matches none of them. */
    /* THE FLAG IS CARRIED, not rebuilt. `hasContent` is derived by the scan and
     * is not a field of `BookRecord`, so the optimistic row — drawn before any
     * disk answer comes back — loses it unless `asRow` is handed it back. The
     * enrichment pass and the reader's own open both fold a parse into an
     * existing row, and this is the exact line where every parse used to knock
     * the flag off the shelf. */
    const entry = asRow(merged, bookId, previous?.hasContent)
    const list = at === -1 ? [entry, ...books] : books.map((one, i) => (i === at ? entry : one))
    let refused = false
    let taken = false
    /* THE PRESENCE FLIP IS NEWS THE WIRE NEEDS, AND IT IS RECORDED FIRST.
     *
     * A re-add of a removed book — the reader opening the file again, a
     * restore arriving from a peer — used to journal `record` alone, so on the
     * wire it was indistinguishable from a stale page turn on a book the
     * shelf had since removed; the classifier that stops THAT from
     * resurrecting the book would have dropped a genuine restore, and the
     * CAS ack would have made the divergence permanent. The flip is a
     * `removed` bracket of its own, exactly as `restore` records it.
     *
     * DECIDED BEFORE THE MUTATION, BY READING THE REGISTER, not after by
     * observing what `restoreBook` did: the recorder has no abort, so a
     * bracket begun after the fact is lost to a crash between, and one begun
     * unconditionally dirties every ordinary add with a phantom removal.
     * Inside the lane, so a local removal cannot land between the read and
     * the write — and that is also where a GUARDED add is refused: a
     * register saying `removed` later than the state the add carries is a
     * removal the sender had not heard. */
    const hooks: CommitHooks = {
      before: async (target, live) => {
        /* THE FOLDER, READ WHERE THE WRITE HAPPENS — see `AddGuard.fresh`. A
         * record on disk is a book already here; a trash entry is one this
         * add would silently restore and relabel. Either way the folder is
         * spoken for, and the caller wanted a creation. */
        if (guard?.fresh && ((await target.exists(recordPath(live))) || (await target.exists(trashOf(live))))) {
          taken = true
          return 'refuse'
        }
        const held = (await readPresence(target))[live]
        if (held?.state !== 'removed') return 'go'
        if (guard?.asOf !== undefined && held.at > guard.asOf) {
          refused = true
          return 'refuse'
        }
        await recorded(recorder, live, 'removed', async () => {
          await restoreBook(target, live).catch(() => ({ state: 'absent' }) as const)
          /* THE WIRE'S STAMP when there is one — the sender's own register,
           * applied last-writer-wins — and this device's clock for the
           * reader's own re-add. */
          await settlePresence(target, live, 'live', guard?.asOf ?? clock())
        })
        return 'go'
      },
      /* THE ROW AS IT WAS, not merely the absence of one.
       *
       * This only took the new row off the shelf and left a REPLACED row
       * replaced: `list` puts `entry` where the matched book was, so a refusal
       * left the other book's row wearing this add's title, id and tags over a
       * record nothing had written. Reachable the moment two aliasing adds
       * race — the second one matches the first's optimistic row by folder and
       * is then refused in the lane. */
      retract: () => {
        const where = books.findIndex((one) => one.bookId === bookId)
        if (where === -1) return
        if (!previous) {
          publish(books.filter((one) => one.bookId !== bookId))
          return
        }
        const back = [...books]
        back[where] = previous
        publish(back)
      },
    }
    await commit(bookId, list, 'record', async (target, live) => {
      /* RESTORED, not overwritten, when a removed copy is waiting. The id is
       * the bytes, so re-adding a book Paper had removed lands on the same
       * folder name — and its tags, position and marks are still in there.
       * Writing a fresh record over the top would throw them away at the exact
       * moment content-derived identity was about to hand them back.
       *
       * ATTEMPTED EVERY TIME, not only when the row was missing. `restoreBook`
       * moves file by file and leaves behind anything it could not move, so a
       * restore CAN be partial — and gating this on the row being absent meant
       * the first attempt was also the last: the row existed afterwards, the
       * leftovers were never retried, and the trash sweep deleted them a
       * fortnight later. It is a cheap no-op when the trash is empty, which is
       * the ordinary case. */
      /* Best effort, for the same reason as the sparse path above: an add
       * must not fail because a leftover trash entry could not be read. */
      await restoreBook(target, live).catch(() => ({ state: 'absent' }) as const)
      await noteReAdd(target, live)
      /* WHAT THE RESTORE COULD NOT BRING BACK, folded in here.
       *
       * `restoreBook` moves file by file and leaves behind a name already
       * live, so `book.json` can stay in the trash while the book is on the
       * shelf. It refuses to overwrite it — correctly, since it cannot know
       * which record is worth more — and the reader's tags and their place in
       * the book then sat there until the sweep deleted them.
       *
       * This layer DOES know: the stranded record is the one the reader wrote,
       * so it is `previous` in the merge and the live one is the parse. Once
       * it is safely written, the copy in the trash goes. */
      const stranded = parseRecord(await readText(target, `${trashOf(live)}/book.json`))
      /* AND THE MARKS, for the same reason and by the same route. A highlight
       * made while a re-added book's bytes were still being written created a
       * live `marks.json` that blocked the complete one from coming back — so
       * one annotation made in that window cost every annotation made before
       * the book was removed. */
      await rescueStrandedMarks(target, live)
      /* MERGED INTO WHAT IS ON DISK, ALWAYS — not only when the row was
       * missing. The in-memory copy comes from an index that `loadShelf` will
       * knowingly trust while it is one write behind, so folding the parse
       * into it and writing that back put a stale record over a newer one:
       * opening a book could undo the tag applied just before the last quit.
       * The record is the truth; the row is a view of it. */
      const onDisk = await readBook(target, live)
      /* BOTH ARE THE READER'S, so neither wins outright — see `mergeStranded`.
       * Treating the stranded copy as authoritative threw away a tag applied
       * after the partial restore, which is a fresh way to lose the same thing
       * this rescue exists to save. */
      const existing = stranded ? (onDisk ? mergeStranded(stranded, onDisk) : stranded) : onDisk
      /* SPARSE IS CHECKED AGAINST THE DISK TOO. The early return above guards
       * the in-memory row, and a record can be on disk without being in that
       * list — a removal shown optimistically before its trash landed, or an
       * import running before the shelf finished loading. Folding a filename
       * placeholder into a real record there replaced the title, the author
       * and the subjects with a guess. A placeholder may contribute only what
       * it actually knows: where the file came from, and what kind it is. */
      if (sparse && existing) {
        const kept: BookRecord = {
          ...existing,
          ...(record.ext && !existing.ext ? { ext: record.ext } : {}),
          ...(record.origin && !existing.origin ? { origin: record.origin } : {}),
        }
        await writeBook(target, live, kept)
        if (stranded) await target.remove(`${trashOf(live)}/book.json`).catch(() => {})
        reconcile(live, kept)
        return
      }
      const written = existing ? mergeParsed(existing, record) : merged
      await writeBook(target, live, written)
      // Only now: the reader's record is in two places until this line, which
      // is the order that cannot lose it.
      if (stranded) await target.remove(`${trashOf(live)}/book.json`).catch(() => {})
      /* WHAT WAS ACTUALLY WRITTEN, back into the row. The optimistic row was
       * built from the index, which `loadShelf` will knowingly trust while it
       * is one write behind — so a tag or a position on disk but not in the
       * cache stayed invisible, and the next thing to save the row wrote the
       * cache's version over it. */
      reconcile(live, written)
      /* AND THE FLAG, MEASURED OFF THE FOLDER BY THE WRITE ITSELF.
       *
       * `loadShelf` refuses to trust an index in which any row lacks
       * `hasContent`, so one flagless row turns the cache off for the NEXT
       * launch and makes opening a freshly imported library pay a full
       * folder-by-folder scan, every single time. A row this path adds has
       * never been scanned, so nothing else will measure it. Inside the
       * committed task, so the index write `commit` chains afterwards carries
       * the answer; `measureContent` deliberately does not write it itself. */
      await measureContent(target, live)
    }, hooks)
    return refused ? 'removed-since' : taken ? 'folder-taken' : 'added'
  }

  /**
   * A whole import's books, `WRITE_WIDTH` at a time — see the interface.
   *
   * SEQUENTIAL WITHIN A SLOT, so the shelf grows in the order the books were
   * read rather than in completion order, and the optimistic rows each `add`
   * publishes stay a faithful picture of what has been asked for.
   *
   * Failures are COUNTED AND RETURNED, not raised. One book that cannot be
   * saved must not cost the other 1,958, and the caller — the import, which
   * is already reporting "N added, N already here" — is the right place for
   * "and N could not be saved" to be said out loud.
   */
  const addMany: Library['addMany'] = async (entries) => {
    const failures = await pooled(entries, WRITE_WIDTH, async (one) => {
      await add(one.bookId, one.record, one.sparse)
    })
    for (const cause of failures) console.error('Paper: could not save an imported book', cause)
    return failures.length
  }

  /**
   * Move a book onto a new id: ONE rename, and deliberately nothing else.
   *
   * `bookIdFor` hashes content now rather than a file's ends, so every book
   * stored under the previous scheme computes a different id the first time it
   * is opened. Marks and cards already migrate themselves there. The library
   * could not, because a book's id names its DIRECTORY — and so opening a
   * migrated book added a second row for it, without the tags or the position
   * held by the first, and the reader's work sat on a shelf entry pointing at
   * the old folder.
   *
   * An earlier attempt at this read, merged, renamed and trashed, and was the
   * most dangerous code on the branch — every one of those steps can fail on its
   * own and leave a book half moved. This does one thing instead. A rename
   * within a filesystem is atomic: the record, the content and the marks arrive
   * together or none of them do, and there is no partial state to reason about.
   *
   * NOTHING IS DELETED, at any point, by anything here. If the destination is
   * occupied the move is abandoned and both books are left exactly as they are —
   * a duplicate row is a visible annoyance, and it is the correct outcome to
   * prefer over any amount of cleverness with somebody's library.
   */
  const rekeyBook: Library['rekeyBook'] = async (from, to) => {
    if (from === to || !fs) return 'nothing'
    if (!books.some((one) => one.bookId === from)) return 'nothing'
    if (books.some((one) => one.bookId === to)) return 'occupied'
    const target = fs
    let outcome = 'nothing' as RekeyOutcome
    /* THE ALIAS FIRST, before the task is enqueued: a write issued under the
     * NEW id while the rename is still queued must already find its way into
     * this lane, or it would run beside the rename rather than behind it. */
    /* KEYED THE WAY `laneFor` READS IT — folded — or the alias is a key
     * nothing ever looks up and the rekey silently un-serialises the book. */
    lanes.set(laneKey(to), laneFor(from))
    try {
      await queue.append(laneFor(from), async () => {
        if (await target.exists(folderOf(to))) {
          outcome = 'occupied'
          return
        }
        // Already gone — nothing here to carry anywhere.
        if (!(await target.exists(folderOf(from)))) return
        // The folder leaving its old name, then the record arriving under the
        // new one: two brackets, because a recorder keyed by book sees two books.
        await recorded(recorder, from, 'removed', () => target.rename(folderOf(from), folderOf(to)))
        // Stamped with the id it now lives under; the record still names the
        // folder it came from until this runs.
        /* THE RENAME IS THE MIGRATION. Everything after it is bookkeeping on
         * a book that has already arrived, so nothing below may turn the
         * answer back into a failure — the caller would then decline to add a
         * book that is sitting there under its new name. `scanBooks` trusts a
         * stored id only when it names the folder it is in, which is what
         * makes the stamp below safe to lose. */
        outcome = 'moved'
        /* AND THE PATH FOLLOWS THE BOOK from here on: a write enqueued under
         * the old id before the rename lands in the new folder when its turn
         * comes — see `rekeyed`. */
        rekeyed.set(from, to)
        const moved = await readBook(target, to)
        if (moved) await recorded(recorder, to, 'record', () => writeBook(target, to, moved))
        const at = books.findIndex((one) => one.bookId === from)
        if (at === -1) return
        const next = [...books]
        next[at] = { ...books[at]!, bookId: to }
        publish(next)
        await writeIndexNow(target)
      })
    } catch (cause) {
      /* Reported and survivable: the book keeps its old id, which is the state
       * it was in a moment ago and one every later open tries again from —
       * PROVIDED the caller does not go on to create the new folder anyway,
       * which is what `failed` is for. A permissions refusal is enough to get
       * here; it needs no crash and no fault. */
      console.error('Paper: could not carry that book onto its new id', cause)
      // Only if the rename itself did not happen. Past that the book HAS
      // moved, whatever else went wrong afterwards.
      return outcome === 'moved' ? 'moved' : 'failed'
    }
    return outcome
  }

  /**
   * The folder half of a removal — the rename into the trash, and the
   * put-back when it fails — for a removal the reader made and for one that
   * arrived from a peer alike. `removed` is the row to put back on failure.
   */
  const evictFolder =
    (removed: IndexedBook | undefined) =>
    async (target: IndexFs, live: string): Promise<void> => {
      /* A REMOVAL THAT DID NOT HAPPEN IS NOT A REMOVAL. `trashBook` reports
       * false when there was nothing there — fine, the row was already gone —
       * but it also reported false when the move genuinely failed, and this
       * ignored the answer either way: the row disappeared optimistically, the
       * index was written without it, and the book came back on the next
       * launch. Thrown, so the queue's own reporting says the library could
       * not be saved rather than the shelf lying quietly. */
      try {
        if (!(await trashBook(target, live))) {
          if (await target.exists(folderOf(live))) {
            throw new Error(`could not remove ${live}: its folder is still there`)
          }
        }
      } catch (cause) {
        /* PUT BACK — THE BOOK, not the shelf. The row is removed
         * optimistically, so a failure here left a book that is still entirely
         * on disk missing from the shelf until the next launch.
         *
         * Restoring the whole captured array was the wrong repair and a worse
         * bug than the one it fixed: anything added or changed while the
         * removal was in flight vanished with it, and the stale index that
         * followed hid a correctly-written `book.json` across launches. Only
         * the one book that failed to go comes back, into whatever the shelf
         * is NOW. */
        if (removed && !books.some((one) => one.bookId === live)) {
          publish([removed, ...books])
          await writeIndexNow(target)
        }
        /* AND THE REGISTER IS TOLD THE BOOK STAYED. The removal was reported
         * as failed and the row put back, so leaving `removed` standing would
         * have launch recovery quietly finish, at the next start, the very
         * removal the reader just watched not happen. Best effort: a register
         * that cannot be written back leans towards removal, which recovery
         * treats as intent — the recoverable side of wrong. */
        await settlePresence(target, live, 'live', clock()).catch(() => {})
        throw cause
      }
    }

  const remove: Library['remove'] = (bookId) => {
    const list = books.filter((one) => one.bookId !== bookId)
    if (list.length === books.length) return Promise.resolve()
    /* ONE RENAME. Phase 3's removal touched three places — a row, the bytes,
     * the cover — any of which could fail alone, and two of which did. */
    const removed = books.find((one) => one.bookId === bookId)
    return commit(bookId, list, 'removed', async (target, live) => {
      /* THE PRESENCE REGISTER FIRST, THE RENAME SECOND — the order is the
       * point (`presence.ts`). A crash between the two leaves a live folder
       * and a register that says removed, which launch recovery finishes; the
       * other order would leave a book gone with nothing anywhere recording
       * that anyone removed it, and a stale satchel would put it back. */
      await settlePresence(target, live, 'removed', clock())
      await evictFolder(removed)(target, live)
    })
  }

  const noteRemoteRemoval: Library['noteRemoteRemoval'] = async (bookId, at) => {
    if (!fs) return 'lost'
    const target = fs
    const held = books.find((one) => one.bookId === bookId)
    let won = false
    const judge = () =>
      queue.append(PRESENCE_KEY, async () => {
        won = await notePresence(target, bookId, 'removed', at)
      })
    if (!held) {
      /* NO ROW, NO FOLDER TO MOVE: the register alone decides, on its own
       * key. A guarded `add` racing this reads the register inside its lane
       * and loses or wins on the stamps either way. */
      await judge()
      return won ? 'removed' : 'lost'
    }
    const list = books.filter((one) => one.bookId !== bookId)
    await commit(bookId, list, 'removed', evictFolder(held), {
      before: async () => {
        await judge()
        return won ? 'go' : 'refuse'
      },
      retract: () => {
        if (!books.some((one) => one.bookId === bookId)) publish([held, ...books])
      },
    })
    return won ? 'removed' : 'lost'
  }

  const restore: Library['restore'] = async (bookId, guard) => {
    if (!fs) return { state: 'absent' }
    const target = fs
    let outcome: RestoreAnswer = { state: 'absent' }
    /* Whether anything actually moved, which is what decides the index write.
     * A flag rather than a re-reading of `outcome`: neither of the two answers
     * that are not a restore leaves anything to rewrite, and asking the union
     * twice out here is how those two would drift apart. */
    let moved = false
    await queue.append(laneFor(bookId), async () => {
      /* WHOSE BOOK THE FOLDER HOLDS, READ IN THE LANE — see `RestoreGuard`.
       *
       * BEFORE THE BRACKET, not inside it. The recorder has no abort, so a
       * bracket begun and abandoned is recovered at the next open as a phantom
       * local commit and PUSHED — the same reason `add` decides its presence
       * flip before opening one. */
      if (guard) {
        const holder = await trashedIdentity(target, bookId)
        if (holder.state === 'unknown') {
          outcome = { state: 'unreadable', at: 'trash' }
          return
        }
        if (holder.state === 'named' && holder.bookId !== bookId) {
          outcome = { state: 'mismatch', bookId: holder.bookId }
          return
        }
        /* AND THE FOLDER IT WOULD MOVE INTO, which is the other half of the
         * same question. The trash entry is only one of the two folders a
         * restore touches: `restoreBook` moves file by file INTO the live
         * folder and a name already there wins, so a live folder belonging to
         * an aliasing book (a partial restore, a legacy library) took this
         * book's marks and content alongside its own — and the row published
         * below carries the REQUESTED id over whichever record survived.
         * Two logical books, one folder, no error anywhere.
         *
         * A folder with no record at all is the ordinary case and passes: an
         * import writes `content.epub` before it writes `book.json`, which is
         * exactly the state this restore exists to complete. A record with no
         * stored id predates ids being stored and is addressed by its folder,
         * the same reading `add` gives it. */
        const live = await readBook(target, bookId)
        if (live !== null && live.bookId !== undefined && live.bookId !== bookId) {
          outcome = { state: 'mismatch', bookId: live.bookId }
          return
        }
        if (live === null && (await target.exists(recordPath(bookId)).catch(() => true))) {
          outcome = { state: 'unreadable', at: 'shelf' }
          return
        }
      }
      await recorded(recorder, bookId, 'removed', async () => {
        /* THROWS ON A FAULT, and that is the point. This used to answer
         * `false` for an unreadable disk exactly as for an empty trash, so a
         * restore that could not even look reported "there was nothing to
         * restore" — and the caller had no way to tell, retry or say so. */
        outcome = await restoreBook(target, bookId)
        if (outcome.state === 'absent') return
        moved = true
        /* The register hears about the return, with a stamp newer than the
         * removal's — the `live` half of the LWW pair (`presence.ts`). */
        await settlePresence(target, bookId, 'live', clock())
        await rescueStrandedMarks(target, bookId)
        const record = await readBook(target, bookId)
        if (!record) return
        const hasContent = await hasContentFile(target, bookId)
        // Absent rather than false when the folder could not be listed — see
        // `hasContentFile`. An absent flag is "not known", which is honest.
        const row = asRow(record, bookId, hasContent ?? undefined)
        const at = books.findIndex((one) => one.bookId === bookId)
        publish(at === -1 ? [row, ...books] : books.map((one, i) => (i === at ? row : one)))
      })
    })
    if (moved) await writeIndexNow(target)
    return outcome
  }

  /* THE STAMP IS TAKEN ONCE, OUTSIDE THE CHANGE. `update` applies the change
   * twice — optimistically to the row, then to what is on disk — and a
   * `clock()` inside it would stamp the two applications differently, leaving
   * the index one stamp apart from `book.json` until the next scan. Captured
   * here, both applications carry the same stamp. (WI-C: the writers stamp
   * the ledger's registers now; with no sync composed the stamp is the legacy
   * wall clock under the zero device, which merges exactly like a legacy
   * record's synthesised stamp — nothing changes until a real clock arrives.) */
  /* `async`, so a patch refused inside the transform — the contradiction check
     below — comes back as the rejection every caller is already awaiting, not
     as a throw out of the call before a promise exists. */
  const patchWith = async (bookId: string, fields: BookPatch, how: WriteWith): Promise<void> => {
    const at = clock()
    return updateWith(bookId, (record) => {
      let next = record
      /* Identity-guarded field by field, so a patch naming three fields of
       * which two already hold writes only what moved — and a patch that
       * moves nothing returns `record` itself, which `update` reads as
       * "nothing to do" and does not write. This runs on every page turn. */
      /* ⚠️ **`status` AND `finished` ARE ONE FACT, MOVED TOGETHER.** A patch
       * naming `finished` — the menu's verb — sets the status it implies:
       * finished, or reading when there is a position to come back to, or
       * want when there is not. A patch naming `status` sets `finished` to
       * match. Both stamps are `at`, so the two registers cannot disagree
       * about when the reader decided. */
      /* "A position to come back to" counts one carried by THIS patch as well
         as one already on the record: a menu that marks a book unfinished as
         it saves where the reader stopped is one act, not two. */
      /* A position to come back to is a NON-EMPTY one: the record's `position`
         is `string | null | undefined`, and a null read as "placed" marked a
         book the reader never opened as `reading` when it was unfinished. */
      // Stryker disable next-line ConditionalExpression,StringLiteral: `parseRecord` drops an empty position on the way in, so none reaches here; the check is belt and braces.
      const placed = fields.position !== undefined || (typeof next.position === 'string' && next.position !== '')
      /* One fact, said twice, must be said the same way: a patch naming both
         `status` and `finished` is refused when they disagree, rather than
         letting one silently win over the other. */
      if (fields.status !== undefined && fields.finished !== undefined && fields.finished !== (fields.status === 'finished')) {
        throw new Error(`a patch cannot say status "${fields.status}" and finished ${String(fields.finished)} at once`)
      }
      const state: ReadingState | undefined =
        fields.status ?? (fields.finished === undefined ? undefined : fields.finished ? 'finished' : placed ? 'reading' : 'want')
      if (state !== undefined && state !== next.status?.state) {
        next = { ...next, status: { state, at }, finished: state === 'finished', finishedAt: at }
      }
      if (fields.rating !== undefined && fields.rating !== next.rating) {
        next = { ...next, rating: fields.rating, ratingAt: at }
      }
      if (fields.review !== undefined && fields.review !== next.review?.text) {
        next = { ...next, review: { text: fields.review, at } }
      }
      const where = fields.position
      if (where !== undefined) {
        /* THE PROGRESS IS CARRIED FROM THE RECORD, not from a snapshot the
         * caller read earlier and not defaulted to zero. Omitted means "leave
         * it alone", and reading it here means reading what is actually on
         * disk rather than what the index believed a moment ago. */
        const progress = Math.min(1, Math.max(0, where.progress ?? next.progress ?? 0))
        if (next.position !== where.position || next.progress !== progress) {
          next = { ...next, position: where.position, progress, positionAt: at }
        }
      }
      return next
    }, how)
  }

  const patch: Library['patch'] = (bookId, fields) => patchWith(bookId, fields, STRUCTURAL)

  /* Both of these are `patch` with one field named. Kept as their own verbs
   * because that is how the reader's app says what it means, and because a
   * caller that only turns pages should not have to build a patch object.
   *
   * THE POSITION TICK IS THE ONE WRITE THAT IS NOT STRUCTURAL (phase 20, D3
   * and D4): the record at the barrier level, the index deferred. `book.set
   * --position` from the CLI goes through `patch` and stays structural — it
   * is one write, not one every two seconds. */
  const rememberPosition: Library['rememberPosition'] = (bookId, position, progress) =>
    // Stryker disable next-line ConditionalExpression: an explicit undefined progress is dropped by the record's writer, as no progress is.
    patchWith(bookId, { position: { position, ...(progress === undefined ? {} : { progress }) } }, TICK)

  const setFinished: Library['setFinished'] = (bookId, finished) => patch(bookId, { finished })

  const tag: Library['tag'] = (bookId, raw) => {
    const value = normalizeTag(raw)
    if (!value) return Promise.resolve()
    const key = tagKey(value)
    const at = clock()
    return update(bookId, (record) => {
      const own = record.tags ?? []
      const declared = record.subjects ?? []
      // Folded against BOTH lists: a publisher's `philosophy` and a reader's
      // `Philosophy` are one tag on this book.
      if ([...own, ...declared].some((one) => tagKey(one) === key)) return record
      // A register write, not a list edit — see `setTag`. The list is
      // re-derived from the clock, so legacy builds keep seeing plain tags.
      return setTag(record, value, true, at)
    })
  }

  const untag: Library['untag'] = (bookId, raw) => {
    const key = tagKey(raw)
    const at = clock()
    return update(bookId, (record) => {
      const own = record.tags ?? []
      // A publisher's subject cannot be removed — it is a fact about the book,
      // and it returns on the next parse anyway.
      const held = own.find((one) => tagKey(one) === key)
      if (held === undefined) return record
      // The register goes OFF but keeps its spelling and gains a stamp — an
      // `off` that travels, where a vanished list entry would look identical
      // to a tag the other device had not seen yet.
      return setTag(record, held, false, at)
    })
  }

  /** Every book, one `update` each; a few at a time, failures gathered. */
  const eachBook = async (change: (record: BookRecord) => BookRecord): Promise<void> => {
    const snapshot = books
    raiseGathered(
      await pooled(snapshot, WRITE_WIDTH, (book) => update(book.bookId, change)),
      'books could not be saved',
    )
  }

  const renameTag: Library['renameTag'] = (from, to) => {
    const value = normalizeTag(to)
    if (!value) return Promise.resolve(0)
    const fromKey = tagKey(from)
    const toKey = tagKey(value)
    const at = clock()
    /* ONE WRITE PER BOOK, and that is the whole point. This was `tag(new)`
     * then `untag(old)` — two queued writes — with a comment promising that
     * a failure between them left the book with both rather than neither.
     * The write queue continues after a failed task, so if the add failed
     * and the remove succeeded the reader's tag was simply gone. One `update`
     * that adds and removes in the same record is what makes the promise
     * true: `book.json` is written once, atomically, holding the result.
     *
     * The same `update` also reads the record it changes, so a book whose
     * cached row is one write stale is judged by what is on disk — which is
     * why this does not pre-filter from the snapshot and instead lets
     * `update` return the record unchanged when the tag is not there.
     * Merging onto an existing tag falls out: if `toKey` is already present
     * the map just drops the old spelling and the fold keeps one. */
    /* `eachOf` OVER THE WHOLE SHELF, not `eachBook`, for the one thing it adds:
     * it counts the books whose record the change actually moved. Same books,
     * same writes — the snapshot is read here exactly as `eachBook` reads it. */
    return eachOf(
      books.map((one) => one.bookId),
      (record) => {
        const own = record.tags ?? []
        const held = own.find((one) => tagKey(one) === fromKey)
        if (held === undefined) return record
        // TWO REGISTER WRITES IN ONE RECORD: the old spelling's register goes
        // off, the new one's on, both at the same stamp — still one `book.json`
        // write, which is what keeps the original promise (neither-nor cannot
        // happen). Renaming onto a name already on the book merges: the off
        // lands and the on is already true.
        const off = setTag(record, held, false, at)
        const alreadyThere = [...(off.tags ?? []), ...(record.subjects ?? [])].some((one) => tagKey(one) === toKey)
        return alreadyThere ? off : setTag(off, value, true, at)
      },
    )
  }

  /* THROUGH `untagBooks`, which is the one place a removal is recorded — the
     interface promises the shelf-wide removal the same way back as the
     editor's, and this used to bypass the recorder and offer none. The books
     named are the ones that carry the tag; `untagBooks` judges each record
     for itself, as `renameTag` does. */
  const removeTag: Library['removeTag'] = (raw) => untagBooks(ownTagBooks(raw), raw).then(() => undefined)

  const keepJacket: Library['keepJacket'] = (bookId, cover) => {
    if (!fs) return Promise.resolve()
    const target = fs
    // The book's OWN lane, which is what puts it in line behind that book's
    // record write and its removal rather than beside them.
    return queue.append(laneFor(bookId), async () => {
      const live = resolveId(bookId)
      /* ONLY FOR A BOOK THAT IS STILL HERE. Being in line behind the removal
       * is necessary and was never sufficient: `keepCover` MAKES the folder it
       * writes into, so a jacket task running after a removal politely
       * recreated the folder the removal had just carried to the trash, as a
       * directory holding nothing but a picture of a book that is gone. The
       * record is the book as far as the shelf is concerned, so its absence is
       * what "removed" looks like from inside the queue. */
      if (!(await target.exists(recordPath(live)))) return
      await recorded(recorder, live, 'cover', async () => {
        await keepCover(target, live, cover)
      })
    }).then(async () => {
      /* MEASURED ONCE IT IS THERE, outside the lane — `update` takes the lane
         itself. A port that is not bound yet leaves the facts to the circle's
         pass; a jacket the store could not keep has no facts to stamp. */
      const port = hashes()
      // Stryker disable next-line ConditionalExpression: a null port fails the measure, which is caught; this spares the attempt.
      if (port === null) return
      const live = resolveId(bookId)
      const facts = await measureCover(target, port, live).catch(() => null)
      if (facts === null) return
      await update(live, (held) => (held.coverFacts === undefined ? { ...held, coverFacts: facts } : held))
    })
  }

  const keepContent: Library['keepContent'] = async (bookId, name, bytes) => {
    if (!fs) return false
    const target = fs
    let wrote = false
    await queue.append(laneFor(bookId), async () => {
      /* RESOLVED AT RUN TIME, like every other task on the rekey-aware lane —
       * this one used the id it was called with, so a rekey queued ahead had
       * it write the bytes back into the obsolete folder. */
      const live = resolveId(bookId)
      /* ONLY FOR A BOOK THAT IS STILL HERE — `keepJacket`'s rule, for
       * `keepJacket`'s reason: `atomicWrite` MAKES the folder it writes
       * into, so a content task queued behind a removal politely recreated
       * the folder the removal had just carried to the trash, holding
       * nothing but orphaned bytes no row names. */
      if (!(await target.exists(recordPath(live)))) return
      await recorded(recorder, live, 'content', async () => {
        const at = contentPathIn(live, name)
        /* Checked before the bytes are touched: `arrayBuffer()` copies the
         * whole book into memory, and reopening a 40MB book should not do that
         * to discover it is already here. */
        if (await target.exists(at)) return
        /* Written to a temporary neighbour and renamed, like every other
         * write here: a crash partway must not leave a truncated
         * `content.epub`, because `exists` would then call it the book. */
        await atomicWrite(target, at, new Uint8Array(await bytes.arrayBuffer()))
        wrote = true
      })
    })
    return wrote
  }

  /**
   * How many books carry this as the READER's own tag — the number a
   * collection-wide remove will touch.
   *
   * Distinct from what the Library panel shows beside the row, which is scoped
   * to the current status and counts publisher subjects too. Showing that
   * number as "Remove from N books" was a lie in both directions: under
   * `is:reading` a tag on five books read "Remove from 2" and removed from
   * five; a tag that was three subjects and one reader tag read "4" and removed
   * from one. The consent number has to be the action's number.
   */
  const ownTagBooks: Library['ownTagBooks'] = (raw) => {
    const key = tagKey(raw)
    return books.filter((book) => (book.tags ?? []).some((one) => tagKey(one) === key)).map((book) => book.bookId)
  }

  /* Its LENGTH, not a second walk with a second rule: the number the reader is
   * shown before a removal and the books an undo puts it back on must come from
   * one answer, or the confirm can promise more than the undo delivers. */
  const ownTagCount: Library['ownTagCount'] = (raw) => ownTagBooks(raw).length

  /** The books named, one `update` each; a few at a time, failures gathered. */
  /**
   * Apply `change` to each book, and answer with how many RECORDS it actually
   * changed.
   *
   * The count matters because callers were deriving it from the in-memory
   * snapshot instead — and the snapshot and the record can disagree. A book
   * whose publisher `subjects` already carry a tag is skipped here (one tag,
   * however it got there), while a snapshot row that has not been rescanned
   * still shows no such tag: the service then reported a book as changed that
   * nothing was written for. The writer is the only thing that knows.
   *
   * `change` returning the SAME object means "nothing to do", which is what
   * every caller here already signals with `continue`.
   */
  const eachOf = async (
    bookIds: readonly string[],
    change: (record: BookRecord) => BookRecord,
  ): Promise<number> => {
    /* BY BOOK, not by invocation. `update` calls `change` TWICE — once against
     * the in-memory row to decide whether anything moved, and again against
     * whatever is actually on disk (see its own comment) — so a naive counter
     * reported two changes for one book. A set of ids counts the thing being
     * asked about. */
    const touched = new Set<string>()
    raiseGathered(
      await pooled(bookIds, WRITE_WIDTH, (bookId) =>
        update(bookId, (record) => {
          const next = change(record)
          if (next !== record) touched.add(bookId)
          return next
        }),
      ),
      'books could not be saved',
    )
    return touched.size
  }

  /* HELD HERE rather than in React state, because the store is the thing that
   * knows what a removal took — and `removeTag` and the editor's remove both
   * route through `untagBooks`, so there is one recorder and one answer. */
  let removal: TagRemoval | null = null
  const setLastRemoval = (next: TagRemoval | null) => {
    removal = next
    notify()
  }
  const lastRemoval: Library['lastRemoval'] = () => removal

  const tagBooks: Library['tagBooks'] = (bookIds, raws) => {
    const values = raws.map(normalizeTag).filter(Boolean)
    if (values.length === 0) return Promise.resolve(0)
    const at = clock()
    return eachOf(bookIds, (record) => {
      let next = record
      for (const value of values) {
        const key = tagKey(value)
        // Folded against BOTH lists, exactly as `tag` does: a publisher's
        // `philosophy` and a reader's `Philosophy` are one tag on this book.
        const held = [...(next.tags ?? []), ...(next.subjects ?? [])]
        if (held.some((one) => tagKey(one) === key)) continue
        next = setTag(next, value, true, at)
      }
      return next
    })
  }

  /**
   * One `tagBooks` per archived book, `WRITE_WIDTH` in flight — see the
   * interface. Each book's failure is its own: `tagBooks` raises what it
   * gathered, `pooled` catches it per item, and the count says the rest.
   */
  const tagMany: Library['tagMany'] = async (entries) => {
    let changed = 0
    const failures = await pooled(entries, WRITE_WIDTH, async (one) => {
      /* AWAITED, THEN ADDED. `changed += await …` reads `changed` BEFORE the
       * await and assigns after it, so eight workers in flight each add to a
       * count seven of them read stale — 201 of 2,000 was the number the
       * test got. */
      const touched = await tagBooks([one.bookId], one.tags)
      changed += touched
    })
    for (const cause of failures) console.error('Paper: could not save imported tags', cause)
    return { changed, failed: failures.length }
  }

  const untagBooks: Library['untagBooks'] = (bookIds, raw) => {
    const key = tagKey(raw)
    const at = clock()
    /* WHICH BOOKS ACTUALLY LOSE IT, taken before anything is written — read
     * afterwards the answer is always none, and an undo would have nothing to
     * put the tag back on. Filtered rather than assumed: `bookIds` is a
     * selection, and most of a selection may not carry the tag at all, so
     * putting it back on all of them would tag books that never had it. */
    const wanted = new Set(bookIds)
    const touched = ownTagBooks(raw).filter((bookId) => wanted.has(bookId))
    return eachOf(bookIds, (record) => {
      const held = (record.tags ?? []).find((one) => tagKey(one) === key)
      // A publisher's subject cannot be removed — it is a fact about the book,
      // and it returns on the next parse anyway.
      if (held === undefined) return record
      return setTag(record, held, false, at)
    }).then((changed) => {
      if (touched.length > 0) setLastRemoval({ tag: normalizeTag(raw), bookIds: touched })
      return changed
    })
  }

  const adoptTag: Library['adoptTag'] = (raw) => {
    const value = normalizeTag(raw)
    if (!value) return Promise.resolve()
    const key = tagKey(value)
    const at = clock()
    return eachBook((record) => {
      if (!(record.subjects ?? []).some((one) => tagKey(one) === key)) return record
      if ((record.tags ?? []).some((one) => tagKey(one) === key)) return record
      return setTag(record, value, true, at)
    })
  }

  const undoRemoveTag: Library['undoRemoveTag'] = async () => {
    const offered = removal
    if (!offered) return
    setLastRemoval(null)
    /* The count is the tagging path's answer, not the undo's: an undo either
     * happened or there was nothing offered. */
    try {
      await tagBooks(offered.bookIds, [offered.tag])
    } catch (cause) {
      /* THE OFFER SURVIVES A WRITE THAT DID NOT. Cleared first and left
       * cleared, a transient disk failure spent the reader's one retry on
       * nothing — the toast was gone and the tag was too. Put back only when
       * no NEWER removal claimed the slot while the undo was failing. */
      if (removal === null) setLastRemoval(offered)
      throw cause
    }
  }

  const positionOf: Library['positionOf'] = (bookId) =>
    bookId ? (books.find((one) => one.bookId === bookId)?.position ?? null) : null

  const refreshContent: Library['refreshContent'] = (bookId) => {
    if (!fs) return Promise.resolve()
    const target = fs
    return queue.append(laneFor(bookId), () => {
      /* Resolved when the task RUNS: queued behind a rekey, the raw id would
       * measure the obsolete folder and leave the newly keyed row unmoved. */
      const live = resolveId(bookId)
      return recorded(recorder, live, 'content', () => noteContent(target, live))
    })
  }

  const evictContent: Library['evictContent'] = (bookId, candidates) => {
    for (const name of candidates) {
      if (!REMOVABLE_BLOB_NAMES.has(name)) {
        /* Loud, and before the lane is taken: a name outside the closed set is
         * a caller defect, not a file that happens to be missing. */
        return Promise.reject(new Error(`evictContent: ${JSON.stringify(name)} is not a blob the kernel removes`))
      }
    }
    if (!fs) return Promise.resolve(0)
    const target = fs
    /* Counted in a closure because the queue's tasks answer `void`: the
     * caller still needs to tell "evicted" from "there was nothing there". */
    let gone = 0
    return queue
      .append(laneFor(bookId), () => {
        /* THE ID AS IT IS NOW, once, for everything in the task. The folder
         * was already resolved; the recorder and the closing measure still
         * used the raw id, so a rekey ahead in the lane had the journal name
         * the obsolete book and the measure read the obsolete folder —
         * `hasContent` then falsely false on the row that stayed. */
        const live = resolveId(bookId)
        return evictHere(target, live, candidates, () => {
          gone += 1
        })
      })
      .then(() => gone)
  }

  /**
   * The eviction itself, INSIDE the book's lane and already resolved.
   *
   * ⚠️ **NOTHING TO DO OPENS NO BRACKET.** The candidates are probed first,
   * here rather than by the caller: `content.evict` listed the folder outside
   * the lane and skipped this call entirely when the listing came back empty,
   * so content that landed between the listing and the lane SURVIVED an
   * eviction that reported success. The listing cannot decide; only the lane
   * can. And the reason the caller's short-circuit existed in the first place
   * is the one `removeBlob` states — a bracket around a change that did not
   * happen advances the journal, feeds an entry to every peer's verify pass,
   * and describes a file that was already gone — so the short-circuit moves
   * in here, where it is made against the folder rather than against a
   * snapshot of it. A row still claiming `hasContent` IS something to do,
   * because that claim is what makes an unopenable book look fine.
   */
  const evictHere = async (
    target: IndexFs,
    live: string,
    candidates: readonly string[],
    count: () => void,
  ): Promise<void> => {
    const folder = folderOf(live)
    const present: string[] = []
    for (const name of candidates) {
      if (await target.exists(`${folder}/${name}`)) present.push(name)
    }
    const at = books.findIndex((one) => one.bookId === live)
    const claims = at !== -1 && books[at]!.hasContent !== false
    if (present.length === 0 && !claims) return
    await recorded(recorder, live, 'content', async () => {
      /* THE INDEX IS INVALIDATED FIRST, and durably.
       *
       * One queue task is atomic against other WRITERS, not against a crash.
       * Deleting the bytes and then refreshing the row leaves a window where
       * the files are gone and `index.json` still says the book is
       * downloaded — and startup trusts that cache, because the folder's
       * membership has not changed, so nothing disagrees until a rescan. The
       * journal cannot repair it either: a content commit carries no digest
       * to compare against.
       *
       * Writing `hasContent: false` before the first unlink inverts which way
       * a crash can lie. "Says gone, bytes may remain" is recoverable — the
       * next measure sees them and says so — while "says here, bytes gone" is
       * the state that makes a book unopenable and looks fine. */
      if (claims) {
        const list = [...books]
        list[at] = { ...list[at]!, hasContent: false }
        publish(list)
        await writeIndexNow(target)
      }
      for (const name of present) {
        const path = `${folder}/${name}`
        /* Existence is checked again HERE. The probe above and this delete are
         * atomic against this QUEUE and not against another process, and an
         * eviction racing one is an absence rather than a fault — the same
         * reading `removeBlob` gives it. */
        if (await target.exists(path)) {
          await target.remove(path)
          count()
        }
      }
      /* Same task, same bracket: the row can never disagree with the folder
       * across a crash the way it could when this was a separate append. */
      await noteContent(target, live)
    })
  }

  const purgeTrashed: Library['purgeTrashed'] = (bookId, options) => {
    if (!fs) return Promise.resolve(false)
    const target = fs
    let went = false
    return queue
      .append(laneFor(bookId), async () => {
        /* `folderOf` answers `books/<safeId>`; the trash holds the same last
         * segment under `trash/`. Derived from the id rather than taken as a
         * path, so nothing a caller supplies can name a directory outside the
         * trash. */
        const folder = folderOf(bookId)
        const at = `trash/${folder.slice(folder.lastIndexOf('/') + 1)}`
        /* CHECKED FIRST, because a recursive remove is forceful and a forceful
         * remove of an absent path SUCCEEDS — a book restored before this ran
         * would otherwise be reported as destroyed. Inside the lane the check
         * and the delete cannot be separated. */
        if (!(await target.exists(at))) return
        /* AND THE STAMP, AS IT IS NOW — see the interface. An unreadable one
         * is left: the trash's contract, and the sweep's. */
        if (options !== undefined) {
          let stamp: number | null = null
          try {
            stamp = readStamp(new TextDecoder().decode(await target.readFile(`${at}/.removed`)))
          } catch {
            stamp = null
          }
          if (stamp === null || stamp > options.unlessStampedAfter) return
        }
        await target.removeDir(at)
        went = true
      })
      .then(() => went)
  }

  const emptyExpiredTrash: Library['emptyExpiredTrash'] = async (now = Date.now()) => {
    if (!fs) return []
    const gone: string[] = []
    /* The folder NAME is the id the purge derives the path from — the same
     * convention the trash sheet uses for an entry with no readable record,
     * and `safeId` is a fixed point on a name it produced. */
    for (const name of await expiredTrash(fs, now)) {
      try {
        if (await purgeTrashed(name, { unlessStampedAfter: now - TRASH_WINDOW_MS })) gone.push(name)
      } catch (cause) {
        /* NAMED, not swallowed: a sweep that fails on the same entry every
         * launch should read as that in the log, not as a clean sweep that
         * happened to purge nothing. Still best effort — one entry that will
         * not go must not stop the rest. */
        console.warn(`Paper: could not purge ${name} from the trash`, cause)
        continue
      }
    }
    return gone
  }

  const applyRemoteRows: Library['applyRemoteRows'] = async (rows) => {
    const list = [...books]
    const applied: RemoteRow[] = []
    for (const row of rows) {
      const at = list.findIndex((one) => one.bookId === row.bookId)
      if (at === -1) continue
      const was = list[at]!
      const record = recordOfRow(was)
      const next = row.change(record)
      if (next === record) continue
      list[at] = asRow(next, row.bookId, was.hasContent)
      applied.push(row)
    }
    if (applied.length === 0) return
    publish(list)
    if (!fs) return
    const target = fs
    const failures = await pooled(applied, WRITE_WIDTH, (row) =>
      queue
        .append(laneFor(row.bookId), async () => {
          /* Resolved at run time and RECONCILED with what the write answered,
           * both for `commit`'s reasons: a rekey ahead in the lane moves the
           * folder, and the optimistic row above was built from a cache that
           * can be behind the disk the change was actually applied to. */
          const live = resolveId(row.bookId)
          const landed = await recorded(recorder, live, 'record', () => updateBook(target, live, row.change))
          if (landed) {
            reconcile(live, landed)
            /* A write that landed is a write that landed: the failure this
               book was showing from an earlier attempt is over. */
            noteLanded(live)
          } else if (books.some((one) => one.bookId === live)) {
            /* `null` IS "NOTHING LANDED" HERE TOO — `updateBook`'s only other
             * answer, and what it says when the folder holds no record. It was
             * read as "no record to reconcile", which left the optimistic row
             * published for the batch write below to serialise: the same
             * phantom `commit` refuses, and a remote row for a book this
             * device no longer has is exactly how it arrives. */
            publish(books.filter((one) => one.bookId !== live))
          }
        })
        .catch(async (cause: unknown) => {
          /* A row whose write did not land must not stay published as if it
           * had — the batch index write below would serialise the phantom and
           * the cache-trust check would believe it every launch. Same repair
           * as `commit`'s: say so FIRST, then let the folder win. The repair
           * is a further read that may itself fail, and its failure must not
           * be the only one heard; a repair that throws becomes this row's
           * failure in the batch, and the cause it replaces was published
           * here before it ran. */
          noteFailed(resolveId(row.bookId), 'record', cause, list)
          await queue.append(laneFor(row.bookId), async () => {
            const live = resolveId(row.bookId)
            const truth = await readBook(target, live)
            if (truth) {
              reconcile(live, truth)
              return
            }
            /* NOTHING READABLE BACKS THE ROW — the write failed AND the folder
             * holds no record to correct it from, so there is no state the row
             * can honestly show; a scan would not shelve it either. It goes,
             * and the index written below omits both the book and its folder
             * claim, so a folder actually sitting there makes the next
             * launch's listing DISAGREE and rescan rather than trust a cache
             * this session could not confirm. `commit` has had this half of
             * the repair since the phantom it describes; this path did not,
             * and left the row on the shelf and in the batch index over a
             * write that never happened. */
            if (books.some((one) => one.bookId === live)) {
              publish(books.filter((one) => one.bookId !== live))
            }
          })
          throw cause
        }),
    )
    try {
      // ONE index write for the batch, whatever happened to the rows.
      await writeIndexNow(target)
    } catch (cause: unknown) {
      /* THE CORRECTED PICTURE COULD NOT BE WRITTEN. With every row landed
       * that is an ordinary failed index write and the caller hears it —
       * the shelf in memory is right, and the next write rewrites the cache.
       *
       * With a row that did NOT land it is the last resort, and `commit`'s,
       * for the same reason: the repair above corrected memory and this was
       * the only thing that would have carried the correction to disk, while
       * another book's commit may already have serialised the phantom into
       * `index.json`. `loadShelf` trusts that index whenever the folder
       * listing agrees, so the honest move is to leave no cache to trust. A
       * rescan is the cost of not knowing, and `raiseGathered` below still
       * tells the caller the batch failed. */
      if (failures.length === 0) throw cause
      console.error('Paper: could not save the shelf index after a failed row', cause)
      /* AND THE INVALIDATION'S OWN FAILURE IS SAID TOO — see `commit`, which
       * had the same silent `.catch`. `raiseGathered` below tells the caller
       * the batch failed and says nothing about the cache left behind. */
      await invalidateIndex(target).catch((why: unknown) => {
        console.error('Paper: the stale shelf index could not be thrown away either', why)
      })
    }
    raiseGathered(failures, 'rows could not be applied')
  }

  return {
    /**
     * The write lane a book's FOLDER belongs to.
     *
     * Published because the folder has writers outside this store — blob
     * deletion in `services.ts` is one — and they must queue where the record,
     * mark and move writers already queue. `folderOf` is many-to-one, so a
     * lane keyed on the raw id puts `book:a/b` and `book:a_b` on different
     * lanes over one directory; `follow(.., lanes)` is what keeps a book that
     * has been rekeyed on the lane its earlier writes are still draining on.
     * A second derivation of either would be a race nobody could see in a
     * diff.
     */
    lane: laneFor,
    getSnapshot: () => books,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    add,
    addMany,
    update,
    remove,
    restore,
    patch,
    rememberPosition,
    flushIndex,
    setFinished,
    tag,
    untag,
    renameTag,
    removeTag,
    ownTagCount,
    ownTagBooks,
    tagBooks,
    tagMany,
    untagBooks,
    adoptTag,
    lastRemoval,
    undoRemoveTag,
    get persistent() {
      return persistent
    },
    lastFailure,
    dismissFailure,
    keepJacket,
    keepContent,
    positionOf,
    rekeyBook,
    refreshContent,
    evictContent,
    purgeTrashed,
    emptyExpiredTrash,
    noteRemoteRemoval,
    applyRemoteRows,
  }
}
