import { canonicalJson } from './canonicalJson'
import { folderOf, marksPathIn, readMarks, trashOf, writeMarks } from './bookFolder'
import type { ResolvedCfi } from './resolvedCfi'
import { scanAllMarks, type IndexFs } from './bookIndex'
import { hlcOf, type Hlc } from './hlc'
import { upsertOverlapping } from './markMatch'
import {
  annotationsIn,
  placedIn,
  type Placed,
  unplacedIn,
  bookmarksIn,
  isBookmark,
  liveMarks,
  mergeMarks,
  removeMark,
  placeMark as placeMarkIn,
  setTint as setTintIn,
  updateNote as updateNoteIn,
  validMarks,
  type Annotation,
  type Bookmark,
  type Mark,
  type MarkTint,
} from './marks'
import { NOOP_RECORDER, recorded, type MutationRecorder } from './ports'
import type { WriteQueue } from './writeQueue'

/**
 * The annotation store — marks, as a service with no React in it.
 *
 * All the rules live in `marks.ts`; this holds the state, persists after every
 * change, and narrows the whole collection to the open book. Writing on every
 * change rather than on an interval or on unload is deliberate: a reader who
 * highlights a line and then force-quits should still have the highlight, and
 * the payload is small enough that debouncing would buy nothing.
 *
 * ONE WRITE PATH, and the reason is the bug that had two. A snapshot write
 * captures the list at the moment the reader highlights something, and
 * anything else still in flight for that book is not in it — highlight A while
 * the file is being read, highlight B before A's write lands, and B persists a
 * list without A in it. Every version of this that wrote a captured list had
 * some version of that hole in it. So the CHANGE goes to disk, not the result:
 * read, modify, write, in order, on the book's queue, and the optimistic
 * update is for the screen only, corrected by whatever the write finds. A
 * remote merge (`mergeRemote`) is the same read-modify-write with a different
 * change, which is why it can be trusted next to a local edit.
 *
 * `useMarks` used to hold all of this in `useState`; it is an adapter over
 * `getSnapshot`/`subscribe` now, so a change made through any caller — the
 * reader, the Marginalia pane, a service answering a peer — reaches every
 * subscriber exactly once. Every mutator returns a promise that settles when
 * the write is on disk, or with the write's error.
 */

/** One shared empty list per class, so a book with none does not re-render on
 *  identity. Two constants because the two are differently typed now. */
const EMPTY: readonly Placed<Annotation>[] = []
const NO_BOOKMARKS: readonly Bookmark[] = []
/** The third class's empty list — see `project`. Almost every book has none. */
const NO_UNPLACED: readonly Annotation[] = []

export interface MarkSnapshot {
  /** Every LIVE PLACED ANNOTATION, across every book — what the Marginalia
   *  panel browses. Empty until `loadAll` has run, because it costs a read per
   *  book. Tombstoned rows stay in the files and in the store's own working
   *  lists (a merge needs them); no snapshot ever shows one.
   *
   *  ⚠️ PLACED ONLY, which this comment used to omit. `project` splits the
   *  unplaced rows into `allUnplaced`, so a caller that wants everything a
   *  reader has left in their books — an export, a backup — must combine the
   *  two. Reading "every live annotation" literally is how an export comes to
   *  silently omit a whole class. */
  /* ⚠️ `Annotation`, NOT `Placed<Annotation>` — and it was briefly the latter.
   * The projection does filter this list by `isPlaced`, so the narrower type
   * compiled; but `all` is CROSS-BOOK, and `ResolvedCfi` means "addresses a
   * passage in the build now open". Branding another book's anchors with it
   * says something false, and says it at exactly the door the brand exists to
   * guard. `current` is the per-book list and keeps the narrowing. */
  readonly all: readonly Annotation[]
  /**
   * The open book's LIVE ANNOTATIONS. `EMPTY` until its file is read.
   *
   * `Placed<Annotation>`, not `Annotation` — WI-22.A1. `placedIn` is a filter
   * over a type predicate, so the narrowing this list already performs at
   * runtime is now carried in its type: `MarkAnchor.cfi` is `ResolvedCfi`, and
   * that makes "the painter is never handed an anchorless mark" a compile
   * error rather than a paragraph of prose two fields down.
   */
  readonly current: readonly Placed<Annotation>[]
  /**
   * The open book's LIVE BOOKMARKS, in book order. `EMPTY` until its file is
   * read, and for a book with none.
   *
   * THE OTHER HALF OF THE SPLIT, and the reason `all` and `current` can stay
   * the names they were. Bookmarks share the file, the queue, the tombstones
   * and the merge with annotations — they are the same record with a different
   * `kind` — and they share none of the CONSUMERS: nothing paints one, the
   * margin does not reserve a column for one, Notes does not list one, and a
   * selection never resolves to one. Separating them at the one door every
   * subscriber reads through is what makes all four of those true by
   * construction rather than by four filters that each have to remember.
   *
   * PER BOOK, for the surfaces that ask "is THIS place kept" — the ribbon and
   * the footer toggle. `allBookmarks` is the cross-book list beside it.
   */
  /**
   * The open book's LIVE ANNOTATIONS THAT HAVE NO ANCHOR HERE (WI-21.7).
   *
   * THE THIRD CLASS, and it exists for `bookmarks`' reason: an unplaced mark
   * shares the file, the queue, the tombstones and the merge with every other
   * annotation, and shares none of the DRAWING consumers. Marginalia lists it
   * and search finds its text — so it cannot be dropped from the store — while
   * nothing paints it, because it has nowhere to be painted.
   *
   * Keeping it out of `current` is what makes "the painter is never handed an
   * anchorless mark" true by construction rather than by every painter
   * remembering to check.
   */
  readonly unplaced: readonly Annotation[]
  readonly bookmarks: readonly Bookmark[]
  /**
   * Every LIVE BOOKMARK, across every book — the other half of what Marginalia
   * browses. Empty until `loadAll` has run, exactly like `all`.
   *
   * FREE, and that is why it can exist. `loadAll` already scans every book's
   * marks file and both classes live in the same file, so the rows are already
   * in hand; this is a projection of what was read, not a second read. The
   * per-book list above stays because the ribbon asks a different question —
   * "is this place kept" — and answering it from a cross-book list would mean
   * filtering the whole library on every page turn.
   */
  readonly allBookmarks: readonly Bookmark[]
  /** Every LIVE UNPLACED annotation, across every book — Marginalia's, and
   *  what a re-anchoring pass reads to know what is waiting for a home. */
  readonly allUnplaced: readonly Annotation[]
  /** Which book `current` and `bookmarks` are for. */
  readonly bookId: string | null
  /**
   * Whether the open book's file has actually been READ yet.
   *
   * Without it, "this book has no bookmarks" and "this book's marks have not
   * arrived" are the same empty list, and every consumer has to guess. The
   * bookmarks list guessed wrong in the honest direction — it announced "No
   * bookmarks in this book" over a book with several, for as long as the read
   * took — and the toggle guessed wrong in the harmful one: with the list
   * still empty, ⌘B on an already-bookmarked page reads as "not bookmarked"
   * and re-places it instead of removing it.
   *
   * False with no book open, which is the honest answer to "have this book's
   * marks been read" when there is no book.
   */
  readonly ready: boolean
  /**
   * False once a write has failed. Surfaced rather than swallowed so the
   * reader can be told their marks are not being saved; a store that silently
   * stops persisting is indistinguishable from one that works.
   */
  readonly persistent: boolean
  /**
   * The open book's marks file is THERE and would not read.
   *
   * A different fact from `persistent`, and it used to be no fact at all:
   * `open` caught the read's throw and installed an empty list with `ready`
   * true — so the reader saw a book with no marks, the ribbon offered to
   * place a bookmark on it, and only the write's own read throwing again
   * stood between that bookmark and the damaged file. Now the book is not
   * called ready, this says why, and the file is left exactly as it is.
   * Cleared by the next `open`, which is the point at which the question
   * is asked again.
   */
  readonly unreadable: boolean
  /**
   * The last `loadAll` scan FAILED, and `all` is empty because of that and
   * not because the library holds no marks. Until this existed the catch
   * installed `[]` and published, and the panel could not tell a damaged
   * shelf from an empty one — "Nothing kept yet" stood over both (the
   * 2026-08-28 audit, #101/#477). Cleared by the next scan that lands.
   */
  readonly scanFailed: boolean
}

export interface MarkStore {
  /** The same object until something changes. */
  getSnapshot(): MarkSnapshot
  subscribe(listener: () => void): () => void
  /**
   * Make a book the open one and read its marks, on that book's queue.
   *
   * THE READ GOES ON THE QUEUE TOO, which is the point rather than a detail.
   * A highlight made before this lands is written as a change and reaches the
   * file first; an unqueued read then returned the file as it was BEFORE that
   * change and installed it as the open book's list, so the next highlight
   * wrote a snapshot without the first one in it. Ordering the read against
   * the writes is what makes the answer it gets the current answer.
   *
   * Resolves when the list is installed — or, for a file that will not read,
   * when the empty list is. Never rejects. `null` closes the book.
   */
  open(bookId: string | null): Promise<void>
  /** One book's marks as its file holds them now, read in order with its writes. */
  forBook(bookId: string): Promise<readonly Mark[]>
  /**
   * Read every book's marks into `all`.
   *
   * Called by the Marginalia pane when it mounts. Marks live in book folders, so
   * answering "every book's marks" costs one read per book — paid at the moment
   * somebody asks for cross-book notes rather than at boot, where nobody did.
   * A failed scan leaves `all` empty rather than pretending it ran.
   */
  loadAll(): Promise<void>
  /**
   * Add a mark to its book, replacing any it OVERLAPS — a mark is reached by
   * any selection that covers part of it, so the row a new mark replaces is
   * the row that selection resolved to. The caller mints the mark
   * (`createMark`) because it needs the id and anchor at once, to draw it.
   */
  add(mark: Mark): Promise<void>
  /**
   * Add several marks to ONE book in a single write.
   *
   * `add` per row is a whole-file read, mutate and rewrite per row, queued —
   * so importing an archive of a thousand marks did a thousand rewrites of a
   * file that grew with every one of them. The reader's own marking never hits
   * this (one mark, one write, which is correct), but an import is the case
   * the per-row shape cannot serve.
   *
   * The same `upsertOverlapping` per mark, folded, so the overlap rule and the
   * tombstoning are identical to adding them one at a time — this is one
   * write, not a different policy.
   */
  addMany(bookId: string, marks: readonly Mark[]): Promise<void>
  /**
   * Remove a mark wherever it lives. Routed by id: the open book's list is
   * consulted first, then `all`, then `bookId` when the caller knows it —
   * a mark none of them know is a rejection, not a silent no-op.
   */
  remove(id: string, bookId?: string): Promise<void>
  updateNote(id: string, note: string, bookId?: string): Promise<void>
  /**
   * Recolour a mark. The twin of `updateNote`, routed the same way and
   * stamped the same way — a mark none of the store's lists know is a
   * rejection, not a silent no-op.
   */
  setTint(id: string, tint: MarkTint, bookId?: string): Promise<void>
  /**
   * Give an UNPLACED mark the anchor a re-anchoring pass found — WI-22.A2.
   *
   * The third mutator routed like `updateNote` and `setTint`, stamped like
   * them, and rejecting an unknown id like them rather than no-op'ing. It is a
   * WRITE and not a render-time decoration for the reason the plan gives: a
   * mark resolved only in memory is resolved again on every open and is
   * invisible to export, to sync and to the browser client.
   *
   * `placeMark` refuses a tombstoned row, an already-placed mark, an empty cfi
   * and a negative section — so a pass that has drifted from the store cannot
   * write a mark into a state `isMark` would later reject off disk.
   */
  place(id: string, cfi: ResolvedCfi, sectionIndex: number, bookId?: string): Promise<void>
  /**
   * Carry marks written under a superseded book id onto this one.
   *
   * With marks in book folders this MOVES a file rather than rewriting rows: the
   * old id named a different folder, so its marks are read from there and merged
   * into this book's. A no-op unless the reader has marks under the previous
   * identity scheme — see `idMigration`.
   */
  rekey(from: string, to: string): Promise<void>
  /**
   * Fold marks that arrived from elsewhere into one book's file — the same
   * read-modify-write as every local edit, on the same queue. BY ID, the
   * NEWEST STAMP wins (`mergeMarks`): an incoming tombstone deletes, an
   * incoming edit newer than a held tombstone resurrects, and a stale row
   * changes nothing — which is what lets an ack be applied as a merge,
   * never as an assignment. Every incoming mark must belong to `bookId`;
   * one that does not rejects the whole call.
   */
  mergeRemote(bookId: string, marks: readonly Mark[]): Promise<void>
}

export interface MarkStoreOptions {
  readonly fs: IndexFs | null
  /** THE SHELF'S QUEUE, not one of its own — see `LibraryOptions.queue`. */
  readonly queue: WriteQueue
  readonly recorder?: MutationRecorder
  /**
   * The stamp for edits and tombstones (`updatedAt`, `deletedAt`). The
   * default is the legacy clock — wall time under the zero device — monotone
   * only as far as the wall clock is, which is enough with no sync composed;
   * the sync capability injects its real HLC at composition.
   */
  readonly clock?: () => Hlc
  /**
   * The lane a book's folder writes run on.
   *
   * `folderOf` alone is folder-correct but NOT rekey-aware: when a book is
   * rekeyed the library follows the rename chain to keep the old and new ids
   * on one lane, and marks queued on the bare folder name took a different
   * one — so a marks write could run beside the move it was supposed to be
   * ordered against. The library publishes the resolver; the default keeps
   * the plain folder for suites that build a store without one.
   */
  readonly lane?: (bookId: string) => string
}

/** Two lists say the same marks in the same order. Serialised, because that is what is stored. */
function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  /* CANONICAL, so the answer does not depend on which order a row's keys were
     written in: a row read back through `validMarks` names the same fields in
     its own order, and a plain stringify called that a change — one more
     notification per edit, for nothing. `libraryStore.sameRow` had the same
     defect and the same cure. */
  return a.every((mark, i) => canonicalJson(mark) === canonicalJson(b[i]))
}

export function createMarkStore({
  fs,
  queue,
  recorder = NOOP_RECORDER,
  clock = () => hlcOf(Date.now()),
  lane = folderOf,
}: MarkStoreOptions): MarkStore {
  /* THE OPEN BOOK'S MARKS ONLY, held here.
   *
   * They live in that book's folder, so there is nothing to load until a book is
   * open and nothing to filter once one is — `current` used to be
   * `marksForBook(everything)`, which is what a shared store forces.
   *
   * HELD WITH THEIR BOOK, not beside it. A bare list kept the previous book's
   * marks until the new book's read resolved — so the reader could be shown,
   * and the overlay could DRAW, another book's highlights. Pairing them means a
   * mismatch is simply an empty list, and a read that resolves after the reader
   * has moved on is discarded because its generation no longer matches. */
  let loaded: { bookId: string | null; marks: readonly Mark[] } = { bookId: null, marks: [] }
  let openId: string | null = null
  let all: readonly Mark[] = []
  let persistent = true
  /** Whether a write has failed since the last successful load — see `applyElsewhere`. */
  let failed = false
  /** The book whose marks file was there and would not read — see `MarkSnapshot.unreadable`. */
  let unreadableId: string | null = null
  /** See `MarkSnapshot.scanFailed`. */
  let scanFailed = false
  /** Which `open` is the current one, so a read that lands late is discarded. */
  let generation = 0
  /**
   * How many times each book's rows have changed in memory, by book id.
   *
   * `loadAll` READS THE DISK OUTSIDE THE WRITE QUEUE, and it must: it scans
   * every book's folder, and there is no one key to serialise that against —
   * taking every folder's lock would deadlock against a write already holding
   * one. So instead of preventing the overlap it is DETECTED. A write landing
   * mid-scan bumps its book's count here; a scan that started before it holds
   * rows that predate it, and those rows are dropped rather than published over
   * the newer truth already in memory.
   *
   * Per book rather than one global counter, so a write to one book does not
   * throw away a scan of forty others. Counting rather than flagging, so two
   * scans in flight at once each compare against their own starting point.
   */
  const writeGen = new Map<string, number>()
  const noteWrite = (bookId: string) => writeGen.set(bookId, (writeGen.get(bookId) ?? 0) + 1)

  const listeners = new Set<() => void>()
  let snapshot: MarkSnapshot = {
    all: EMPTY,
    allBookmarks: NO_BOOKMARKS,
    allUnplaced: NO_UNPLACED,
    current: EMPTY,
    unplaced: NO_UNPLACED,
    bookmarks: NO_BOOKMARKS,
    bookId: null,
    ready: false,
    persistent,
    unreadable: false,
    scanFailed: false,
  }

  /**
   * The last source list each projection was derived from, and what it gave.
   *
   * DERIVED ONCE PER SOURCE, not once per publish. `publish` runs for every
   * change the store makes — a note edit, a remote merge, a failed write
   * flipping `persistent` — and each of the three projections filters, and one
   * of them also SORTS. Recomputing all three on every publish handed every
   * subscriber three new array identities whether or not any mark had moved,
   * which defeats exactly the memo that `useSyncExternalStore` consumers hang
   * their re-render decisions on. Keyed by source identity because the working
   * lists are replaced rather than mutated, so identity is a sound key.
   */
  interface Projection {
    source: readonly Mark[]
    /** PLACED annotations — what can be painted. See `project`. */
    annotations: readonly Placed<Annotation>[]
    /** Annotations with no anchor in this library. */
    unplaced: readonly Annotation[]
    bookmarks: readonly Bookmark[]
  }
  let cache: Projection | null = null
  let allCache: Projection | null = null

  /**
   * One source list, split and cached — or the cached answer, unchanged.
   *
   * BOTH PROJECTIONS ARE THIS, and they were written out twice with one line
   * different between them. The identity contract below is the part that
   * matters and the part a second copy quietly stops honouring: a subscriber
   * hangs its re-render on these arrays being the same object when nothing
   * moved.
   *
   * `place` is where the two genuinely differ, so it is the parameter rather
   * than the reason for a second copy. The per-book list sorts; the cross-book
   * one cannot, because `compareMarks` orders by section and CFI and both are
   * only meaningful WITHIN one book — two CFIs from different books address
   * positions in different documents, so sorting across them produces an order
   * that means nothing and changes as an unrelated book's bookmarks move.
   * Marginalia groups by book and sorts inside each group, which is where that
   * comparator belongs; the cross-book projection hands over scan order.
   */
  const project = (
    held: readonly Mark[],
    prior: Projection | null,
    place: (live: readonly Mark[]) => Bookmark[],
  ): Projection => {
    if (prior && prior.source === held) return prior
    const live = liveMarks(held)
    const places = place(live)
    const annotations = annotationsIn(live)
    /* ⚠️ **A THIRD CLASS AT THE SAME DOOR** (WI-21.7), and for the reason
     * `MarkSnapshot.bookmarks` gives for the second: an unplaced mark shares
     * the file, the queue, the tombstones and the merge with every other
     * annotation, and shares NONE of the drawing consumers. Nothing paints one,
     * the margin reserves no column for one, and a selection never resolves to
     * one — while Marginalia lists it and search finds its text, which is why
     * it cannot simply be filtered out of `annotationsIn`.
     *
     * Split here rather than at four call sites, so those four are true by
     * construction rather than by each remembering. */
    const placed = placedIn(annotations)
    const unplaced = placed === annotations ? NO_UNPLACED : unplacedIn(annotations)
    return {
      source: held,
      annotations: placed,
      unplaced,
      /* One shared empty list when there are none: a sort cannot return its
       * input by identity, and most books have no bookmarks at all. */
      bookmarks: places.length > 0 ? places : NO_BOOKMARKS,
    }
  }

  const publish = () => {
    /* FILTERED TO LIVE AT THE ONE DOOR a subscriber reads through. The
     * working lists keep their tombstones — a merge and a write both need
     * them — and nothing outside this store ever sees one.
     *
     * AND SPLIT BY CLASS AT THE SAME DOOR, for the same reason: the working
     * lists hold both, because they are one file and one merge, and no
     * subscriber is ever handed the two mixed. See `MarkSnapshot.bookmarks`. */
    const ready = openId !== null && loaded.bookId === openId
    cache = project(ready ? loaded.marks : EMPTY, cache, bookmarksIn)
    allCache = project(all, allCache, (live) => live.filter(isBookmark))
    snapshot = {
      all: allCache.annotations,
      allBookmarks: allCache.bookmarks,
      allUnplaced: allCache.unplaced,
      current: cache.annotations,
      unplaced: cache.unplaced,
      bookmarks: cache.bookmarks,
      bookId: openId,
      ready,
      persistent,
      unreadable: openId !== null && unreadableId === openId,
      scanFailed,
    }
    for (const listener of [...listeners]) {
      /* EACH ON ITS OWN. One throwing subscriber used to stop every later
       * one — and, called from the optimistic half of `applyTo`, stopped the
       * disk write behind it; called after a successful write, its throw was
       * then classified as a persistence failure by the catch around it. */
      try {
        listener()
      } catch (cause) {
        console.error('Paper: a marks subscriber threw', cause)
      }
    }
  }

  /**
   * Write a change to one book's marks file — the only thing that writes one.
   *
   * Named for the case it was added for, which is a mark belonging to a book
   * that is NOT open: Marginalia lists every book's marks, so a reader can edit or
   * delete one from a book they are not reading. Reads that book's file,
   * changes it, writes it back, on the same per-book queue as everything else.
   * `all` is updated so the row stays changed, and the open book's list when
   * this is that book.
   */
  const applyElsewhere = (
    targetId: string,
    mutate: (prev: readonly Mark[]) => readonly Mark[],
    /** A mark id the change is about — the file must hold it, or this rejects. */
    requires?: string,
    /** Work that must happen INSIDE the task, before the file is read. */
    prepare?: () => Promise<void>,
  ): Promise<void> => {
    if (!fs) {
      /* SAID OUT LOUD. With nowhere to write, a mark is drawn and gone at the
       * next redraw — and a store that silently stops persisting is
       * indistinguishable from one that works, which is the whole reason this
       * flag exists. */
      if (persistent) {
        persistent = false
        publish()
      }
      return Promise.resolve()
    }
    const target = fs
    return queue
      /* APPEND. Unlike a whole-list write, which makes its predecessors
       * redundant, this one READS the file and changes part of it. Coalescing
       * two — delete a mark, then recolour another — drops the first, and the
       * row it belonged to reappears. */
      /* THE FOLDER IS THE KEY, exactly as the library keys its writes — the
       * queue serialises what contends for one directory, and two spellings of
       * one id (`book:abc` and its folder name `book_abc`) name one directory.
       * Keyed by the id as spelled, a marks write and the removal trashing the
       * same folder could run beside each other. */
      .append(lane(targetId), async () => {
        /* `writeMarks` creates the folder it writes into, so a change landing
         * after a removal puts a marks-only directory back where the book had
         * been. Checked before — and, because a removal can land between the
         * check and the write, checked AFTER as well: the trash entry the
         * removal leaves is the evidence, exactly as `updateBook` uses it. */
        if (!(await target.exists(folderOf(targetId)))) {
          /* SAID, not swallowed. A cross-book edit reaches this queue under
           * the mark's STORED id — and a book migrated onto a content-derived
           * id no longer has a folder under its old one, so the edit has
           * nowhere to land. The mark itself moved with the folder and is
           * safe; the EDIT is what is lost, and losing it silently made the
           * Notes row look updated until the next reload disagreed. */
          /* AND FAILED, not merely said. Resolving here left the caller
           * believing an edit had landed that had nowhere to land; the catch
           * below turns this into the store's own not-saving state, which is
           * what the edit's loss is. */
          throw new Error(`could not change a mark for ${targetId} — no folder under that id`)
        }
        if (prepare) await prepare()
        const trashedBefore = await target.exists(trashOf(targetId))
        const before = validMarks(await readMarks(target, targetId))
        const next = mutate(before)
        if (next === before) {
          /* An unchanged answer for a mark the file does not hold is the
           * rejection the interface promises — "a mark none of them know is
           * a rejection, not a silent no-op" — which the hint-routed path
           * used to resolve as success, since the routing never checked. */
          if (requires !== undefined && !before.some((mark) => mark.id === requires)) {
            throw new Error(`no mark ${requires} is known to the store under ${targetId}`)
          }
          return
        }
        await recorded(recorder, targetId, 'marks', () => writeMarks(target, targetId, next))
        if (!trashedBefore && (await target.exists(trashOf(targetId)))) {
          /* The removal won. What was just written is a fragment of this
           * book's marks in a folder that is no longer the book — and leaving
           * it there is worse than losing the edit, because a later re-add
           * lets that fragment beat the complete list waiting in the trash.
         *
         * THE TELL IS THE TRASH ENTRY APPEARING, and nothing stronger is
         * available, so do not "improve" this with a record-absence check:
         * a trash entry beside a folder with no `book.json` is ALSO what a
         * re-add in progress looks like — the previous removal's entry
         * still in the trash, the content copied back, the record not yet
         * restored — and a reader can be marking that book at that exact
         * moment, since it is open. A predicate that read record-absence
         * as "removed" deleted that reader's fresh mark as tidy-up. The
         * cost of the weaker tell: a removal racing this write while a
         * STALE trash entry exists leaves a marks-only folder fragment
         * behind — a stray the scan does not shelve, whose real book is in
         * the trash, recoverable either way. A fragment is visible;
         * a deleted mark is gone. */
          await target.remove(marksPathIn(targetId)).catch(() => {})
          return
        }
        /* WHAT THE WRITE FOUND, back into memory — and published only when it
         * differs from what the optimistic update predicted, so a subscriber
         * hears once per change rather than once more per confirmation. */
        let changed = false
        const nextAll = [...next, ...all.filter((mark) => mark.bookId !== targetId)]
        if (!sameMarks(nextAll, all)) {
          all = nextAll
          noteWrite(targetId)
          changed = true
        }
        /* AND THE OPEN BOOK'S OWN LIST, when this is that book. It is, every
         * time a change routes here before the file has been read — and
         * leaving the list behind meant the mark just made was missing from
         * it, so the NEXT mark wrote a snapshot that erased the first. */
        if (openId === targetId && (loaded.bookId !== targetId || !sameMarks(loaded.marks, next))) {
          loaded = { bookId: targetId, marks: next }
          changed = true
        }
        /* NOT AFTER A FAILURE, until the book is read again. A write that
         * fails is an edit that is gone: the next one is computed from the
         * file WITHOUT it, so reporting "saving" again on that success hides
         * the loss behind the very thing that caused it. `open` is what clears
         * this, because that is the point at which what is on screen agrees
         * with what is on disk. */
        if (!failed && !persistent) {
          persistent = true
          changed = true
        }
        if (changed) publish()
      })
      .catch((cause: unknown) => {
        failed = true
        persistent = false
        publish()
        throw cause
      })
  }

  /**
   * Change one book's marks: the screen at once, the file as a change.
   *
   * The screen first, and only when the book is the open one AND its file has
   * been read — before that the held list is not this book's, and predicting
   * from it would show marks appearing and vanishing. The write lands either
   * way. `all` is kept in step so a Notes row does not revert to the old value
   * the moment it is edited.
   */
  const applyTo = (
    targetId: string,
    mutate: (prev: readonly Mark[]) => readonly Mark[],
    requires?: string,
    prepare?: () => Promise<void>,
  ): Promise<void> => {
    if (openId === targetId && loaded.bookId === targetId) {
      const next = mutate(loaded.marks)
      if (next !== loaded.marks) {
        loaded = { bookId: targetId, marks: next }
        all = [...next, ...all.filter((mark) => mark.bookId !== targetId)]
        noteWrite(targetId)
        publish()
      }
    }
    return applyElsewhere(targetId, mutate, requires, prepare)
  }

  /**
   * Which book a mark belongs to: the caller's word, else the open book's own
   * list, else `all` — a mark can be in `all` and not yet in `current`,
   * because the two are read separately. NOT conditional on a book being
   * open: Notes is reachable with nothing open, and its edits must land.
   */
  const ownerOf = (id: string, hint: string | undefined): string | undefined => {
    if (hint) return hint
    if (openId && loaded.bookId === openId && loaded.marks.some((mark) => mark.id === id)) return openId
    return all.find((mark) => mark.id === id)?.bookId
  }

  const applyToMark = (
    id: string,
    hint: string | undefined,
    mutate: (prev: readonly Mark[]) => readonly Mark[],
  ): Promise<void> => {
    const owner = ownerOf(id, hint)
    if (!owner) return Promise.reject(new Error(`no mark ${id} is known to the store`))
    return applyTo(owner, mutate, id)
  }

  const open: MarkStore['open'] = (bookId) => {
    openId = bookId
    // A fact about ONE open; the next open asks the question again.
    unreadableId = null
    generation += 1
    const mine = generation
    if (!bookId || !fs) {
      loaded = { bookId: null, marks: [] }
      publish()
      return Promise.resolve()
    }
    const target = fs
    failed = false
    publish()
    return queue
      /* THE FOLDER IS THE KEY, exactly as the library keys its writes — the
       * queue serialises what contends for one directory, and two spellings of
       * one id (`book:abc` and its folder name `book_abc`) name one directory.
       * Keyed by the id as spelled, a marks write and the removal trashing the
       * same folder could run beside each other. */
      .append(lane(bookId), async () => {
        const raw = await readMarks(target, bookId)
        // Parsed through the same validator every read uses: this is a file on
        // disk, and a mark with no CFI cannot be drawn.
        if (mine !== generation) return
        loaded = { bookId, marks: validMarks(raw) }
        /* A read that landed is the screen agreeing with the disk again —
         * the point the failure note in `applyElsewhere` names as what
         * clears the flag; it cleared `failed` and left `persistent` false
         * until the next write happened to succeed. */
        if (!failed) persistent = true
        publish()
      })
      .catch(() => {
        if (mine !== generation) return
        /* NOT INSTALLED AS EMPTY. `readMarks` throws for a file that is there
         * and will not read, precisely so that it is not mistaken for a book
         * with no marks — and this catch used to undo that one line later,
         * handing the projections an empty list under the open book's id so
         * `ready` came out true. `loaded` is left as it was, which is not
         * this book's, so the book is not ready and its lists are empty; the
         * flag says why. A write will find the same throw and fail rather
         * than replace the file. */
        unreadableId = bookId
        publish()
      })
  }

  const forBook: MarkStore['forBook'] = async (bookId) => {
    if (!fs) return EMPTY
    const target = fs
    let marks: readonly Mark[] = EMPTY
    /* THE FOLDER IS THE KEY, exactly as the library keys its writes — the
     * queue serialises what contends for one directory, and two spellings of
     * one id (`book:abc` and its folder name `book_abc`) name one directory.
     * Keyed by the id as spelled, a marks write and the removal trashing the
     * same folder could run beside each other. */
    await queue.append(lane(bookId), async () => {
      // LIVE only — a read model, like every other. The file keeps its rows.
      marks = liveMarks(validMarks(await readMarks(target, bookId)))
    })
    return marks
  }

  const loadAll: MarkStore['loadAll'] = () => {
    if (!fs) return Promise.resolve()
    /* WHERE EVERY BOOK STOOD WHEN THE SCAN STARTED — see `writeGen`. Anything
       that moves between here and the result landing is newer than the scan. */
    const before = new Map(writeGen)
    return scanAllMarks(fs)
      .then((raw) => {
        const scanned = validMarks(raw)
        const stale = new Set(
          [...writeGen.keys()].filter((bookId) => writeGen.get(bookId) !== before.get(bookId)),
        )
        all =
          stale.size === 0
            ? scanned
            : [
                ...scanned.filter((mark) => !stale.has(mark.bookId)),
                /* Memory wins for exactly the books that moved. It holds the
                   write's own result for them, which the scan predates. */
                ...all.filter((mark) => stale.has(mark.bookId)),
              ]
        scanFailed = false
        publish()
      })
      .catch(() => {
        // A failed scan has not established that there is nothing; it has
        // established nothing. Empty, SAID SO, and the next mount asks again.
        all = []
        scanFailed = true
        publish()
      })
  }

  /* THE STAMP IS MINTED ONCE, OUTSIDE THE MUTATION. `applyTo` runs the
   * mutation twice — optimistically over the screen's list, then over the
   * file — and a `clock()` inside it minted two different stamps for one
   * edit: memory and disk disagreed until the confirmation republished,
   * and the generation moved twice. One reading, both applications. */
  const add: MarkStore['add'] = (mark) => {
    const at = clock()
    /* Overlapping, not byte-identical. A mark is reached by any selection
     * that covers part of it, so the row a new mark replaces is the row that
     * selection resolved to — otherwise re-marking a passage the reader was
     * just told is marked writes a second, overlapping row. The superseded
     * row is TOMBSTONED under this clock, so the replacement travels. */
    return applyTo(mark.bookId, (prev) => upsertOverlapping(prev, mark, at))
  }

  const addMany: MarkStore['addMany'] = (bookId, marks) => {
    if (marks.length === 0) return Promise.resolve()
    /* EVERY MARK IS THIS BOOK'S, or the batch is refused whole — as
     * `mergeRemote` refuses. A foreign row written into this file would be
     * routed to the wrong folder by every later edit. */
    const stray = marks.find((mark) => mark.bookId !== bookId)
    if (stray) {
      return Promise.reject(new Error(`addMany: mark ${stray.id} belongs to ${stray.bookId}, not ${bookId}`))
    }
    /* ONE CLOCK READING PER MARK, as `add` takes — the stamps have to be
     * distinct or the tombstones a later mark writes over an earlier one in
     * the same batch cannot be ordered. Minted here, once per mark, so both
     * applications of the mutation write the same stamps. */
    const stamps = marks.map(() => clock())
    return applyTo(bookId, (prev) =>
      marks.reduce<readonly Mark[]>((sofar, mark, i) => upsertOverlapping(sofar, mark, stamps[i]!), prev),
    )
  }

  const remove: MarkStore['remove'] = (id, bookId) => {
    const at = clock()
    // A tombstone, not a vanished row — see `removeMark`.
    return applyToMark(id, bookId, (prev) => removeMark(prev, id, at))
  }

  const updateNote: MarkStore['updateNote'] = (id, note, bookId) => {
    const at = clock()
    return applyToMark(id, bookId, (prev) => updateNoteIn(prev, id, note, at))
  }

  const setTint: MarkStore['setTint'] = (id, tint, bookId) => {
    const at = clock()
    return applyToMark(id, bookId, (prev) => setTintIn(prev, id, tint, at))
  }

  const place: MarkStore['place'] = (id, cfi, sectionIndex, bookId) => {
    const at = clock()
    return applyToMark(id, bookId, (prev) => placeMarkIn(prev, id, cfi, sectionIndex, at))
  }

  const rekey: MarkStore['rekey'] = async (from, to) => {
    if (!fs || from === to) return
    /* TWO PLACES, because the library may have got here first.
     *
     * `rekeyBook` renames the whole folder, `marks.json` included — so by
     * the time this runs the marks are usually already in the new book's
     * file, with the OLD id still written inside every one of them. Reading
     * only the old folder therefore found nothing and did nothing, and Notes
     * then sorted the reader's own highlights under a book that no longer
     * existed and refused to navigate to them.
     *
     * So: rewrite what is already here, AND merge anything still sitting in
     * the old folder if the rename has not happened. Whichever order the two
     * ran in, the answer is the same. */
    const target = fs
    let waiting: Mark[] = []
    /* READ INSIDE THE TASK, on the lane the merge writes on. Read before it,
     * outside any queue, a mutation already queued for the old book — or the
     * folder move itself — could land between the read and the merge, and
     * the marks it touched were stranded under the old identity. And a file
     * that is there and will not read REJECTS the rekey: logged-and-continued
     * resolved as if the migration had happened, with no retry signal and the
     * old marks left behind. Nothing is deleted from the old folder either
     * way, so a rejected rekey loses nothing. */
    const prepare = async () => {
      try {
        waiting = validMarks(await readMarks(target, from))
      } catch (cause) {
        console.error('Paper: could not read the marks under the old book id', cause)
        throw new Error(`could not read the marks under ${from}`, { cause })
      }
    }
    await applyTo(to, (prev) => {
      let rewrote = false
      const mine = prev.map((mark) => {
        if (mark.bookId !== from) return mark
        rewrote = true
        return { ...mark, bookId: to }
      })
      /* BY ID, and the set grows as it goes — a file holding two marks with
       * one id would otherwise let both through. Nothing is deleted from the
       * old folder: this ran on every open and only ever copied, so before
       * the deduplication a reader who opened a migrated book five times had
       * five of every highlight. Removing the source after the write is
       * queued would delete the original before the copy was durable — so it
       * stays, and the duplicate is what is prevented. */
      const held = new Set(mine.map((mark) => mark.id))
      const fresh: Mark[] = []
      for (const mark of waiting) {
        if (held.has(mark.id)) continue
        held.add(mark.id)
        fresh.push({ ...mark, bookId: to })
      }
      if (!rewrote && fresh.length === 0) return prev
      return [...mine, ...fresh]
    }, undefined, prepare)
  }

  const mergeRemote: MarkStore['mergeRemote'] = (bookId, incoming) => {
    const marks = validMarks(incoming)
    const stray = marks.find((mark) => mark.bookId !== bookId)
    if (stray) {
      return Promise.reject(new Error(`mergeRemote: mark ${stray.id} belongs to ${stray.bookId}, not ${bookId}`))
    }
    if (marks.length === 0) return Promise.resolve()
    /* LATEST ACTION WINS, per id — `mergeMarks`, the same semilattice the
     * sync capability property-tests. Tombstones are respected in BOTH
     * directions: an incoming tombstone newer than the held edit deletes,
     * an incoming edit newer than the held tombstone resurrects, and an
     * incoming row OLDER than what is held changes nothing — which is what
     * makes applying an ack a merge rather than an assignment. */
    return applyTo(bookId, (prev) => mergeMarks(prev, marks))
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    open,
    forBook,
    loadAll,
    add,
    addMany,
    remove,
    updateNote,
    setTint,
    place,
    rekey,
    mergeRemote,
  }
}
