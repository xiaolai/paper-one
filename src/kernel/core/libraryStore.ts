import {
  BOOKS_DIR,
  atomicWrite,
  contentPathIn,
  folderOf,
  mergeParsed,
  mergeStranded,
  parseRecord,
  readBook,
  setTag,
  trashOf,
  updateBook,
  writeBook,
  type BookRecord,
} from './bookFolder'
import { hasContentFile, writeIndex, type IndexFs, type IndexedBook } from './bookIndex'
import { keepCover } from './coverArt'
import { rescueStrandedMarks, restoreBook, trashBook } from './bookTrash'
import { hlcOf, type Hlc } from './hlc'
import { normalizeTag, tagKey } from './library'
import { NOOP_RECORDER, recorded, type MutationRecorder } from './ports'
import { PRESENCE_KEY, notePresence, readPresence } from './presence'
import type { WriteQueue } from './writeQueue'

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

export interface Library {
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
  add(bookId: string, record: BookRecord, sparse?: boolean): Promise<void>
  /** Change one book. The only mutator, because a book is one file. */
  update(bookId: string, change: (record: BookRecord) => BookRecord): Promise<void>
  /** Take a book off the shelf. Its folder goes to the trash, not away. */
  remove(bookId: string): Promise<void>
  /**
   * Bring a removed book back from the trash, row and all. Resolves with
   * whether there was one to bring back.
   */
  restore(bookId: string): Promise<boolean>
  /**
   * Where the reader is in a book, and how far through. Identity-guarded, so
   * the page turn that moves nothing writes nothing; progress is clamped to
   * [0, 1] because a hand-edited or remote value past that would draw a bar
   * wider than its track.
   */
  rememberPosition(bookId: string, position: string, progress: number): Promise<void>
  /** Whether the reader is done with a book. */
  setFinished(bookId: string, finished: boolean): Promise<void>
  /** Add one of the reader's own tags. Folded, so case cannot duplicate. */
  tag(bookId: string, tag: string): Promise<void>
  untag(bookId: string, tag: string): Promise<void>
  /**
   * Rename one of the reader's tags on EVERY book that carries it.
   *
   * ONE WRITE PER BOOK: the add and the remove happen in the same record, so
   * a failure cannot leave a book with neither. Renaming onto a name that
   * already exists MERGES — `tag` folds by key, so the books simply end up
   * under one tag. A publisher's subject is untouched: it is not the reader's
   * to rename, and `untag` refuses it anyway.
   */
  renameTag(from: string, to: string): Promise<void>
  /** Take one of the reader's tags off every book that carries it. */
  removeTag(tag: string): Promise<void>
  /** How many books a `removeTag` of this tag would touch — see the implementation. */
  ownTagCount(tag: string): number
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
   * Apply a batch of changes that arrived from elsewhere: one `updateBook`
   * per row on that book's queue, ONE index write for the batch, one
   * notification for the batch. Rows for books not on the shelf are skipped.
   * Rejects after the batch if any row's write failed, naming them all.
   */
  applyRemoteRows(rows: readonly RemoteRow[]): Promise<void>
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
const canonical = (value: unknown): string => {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted)
    if (typeof v === 'object' && v !== null) {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(v).sort()) out[key] = sorted((v as Record<string, unknown>)[key])
      return out
    }
    return v
  }
  return JSON.stringify(sorted(value))
}

/** Two rows say the same thing. CANONICAL, not the raw serialisation: the
 *  register writers (`setTag`) rebuild a record with its keys in a different
 *  order than `parseRecord` does, and a reconcile that treated key order as
 *  a change published a notification for a row that had not changed. */
const sameRow = (a: IndexedBook, b: IndexedBook): boolean => canonical(a) === canonical(b)

export function createLibrary({
  fs,
  queue,
  initial = [],
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
  const listeners = new Set<() => void>()

  const publish = (next: readonly IndexedBook[]) => {
    books = next
    for (const listener of [...listeners]) listener()
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
    const row: IndexedBook = { ...record, bookId, ...(was.hasContent === undefined ? {} : { hasContent: was.hasContent }) }
    if (sameRow(was, row)) return
    const next = [...books]
    next[at] = row
    publish(next)
  }

  /** The index, rewritten whole from the newest state, on its own key. */
  const writeIndexNow = (target: IndexFs) =>
    /* The index LAST, and on its own key so a book's write is never held up
     * by it. Rewritten whole from `books`, which is the newest state by the
     * time this runs — a cache should describe where things ended up, not
     * where one write thought they were going. */
    queue.push('index', async () => {
      await writeIndex(target, books)
    })

  /** State first, then the folder, then the index. */
  const commit = (
    key: string,
    next: readonly IndexedBook[],
    what: 'record' | 'removed',
    write: (target: IndexFs) => Promise<unknown>,
  ): Promise<void> => {
    publish(next)
    if (!fs) return Promise.resolve()
    const target = fs
    return (
      queue
        /* APPEND, not replace. Each task here applies a CHANGE to what is on
         * disk — a tag, then a position — and coalescing two of them drops the
         * first. Marks can coalesce because each of those writes the whole list;
         * these cannot, and the distinction is why the queue has two methods. */
        /* BRACKETED — `begin` before the folder write and `commit` after it,
         * inside the queued task, so a recorder sees the change with nothing
         * else touching the book in between. */
        .append(key, async () => {
          await recorded(recorder, key, what, () => write(target))
        })
        .then(() => writeIndexNow(target))
    )
  }

  const update: Library['update'] = (bookId, change) => {
    const at = books.findIndex((one) => one.bookId === bookId)
    const current = at === -1 ? null : books[at]
    if (!current) return Promise.resolve()
    const { bookId: _id, ...record } = current
    const next = change(record)
    // By identity, so a change that decides nothing moved writes nothing —
    // this runs on every page turn.
    if (next === record) return Promise.resolve()
    const list = [...books]
    list[at] = { ...next, bookId }
    return commit(bookId, list, 'record', (target) =>
      /* THE CHANGE, not the result. Passing `() => next` wrote the in-memory
       * record back — and that copy can be stale, because it came from an
       * index that may be one write behind after a crash. Handing the function
       * over means it is applied to whatever is actually on disk. */
      updateBook(target, bookId, change),
    )
  }

  /**
   * Whether a row's bytes are back, checked and recorded. Runs INSIDE a
   * queued task for the book (so it must not queue on the book's key itself)
   * and writes the index on the index key when the answer changed.
   */
  const noteContent = async (target: IndexFs, bookId: string): Promise<void> => {
    const now = await hasContentFile(target, folderOf(bookId).slice(BOOKS_DIR.length + 1))
    const where = books.findIndex((one) => one.bookId === bookId)
    if (where === -1) return
    const row = books[where]!
    if (row.hasContent === now) return
    const list = [...books]
    list[where] = { ...row, hasContent: now }
    publish(list)
    /* ON THE INDEX KEY, like every other index write. Called directly from a
     * per-book task it shared the fixed `index.json.writing` path with them —
     * and re-adding a folder of disabled books starts one of these per book, so
     * they raced each other and an older list could land last. Being unchanged
     * in folder membership, that stale cache is then trusted, and the repaired
     * book goes back to disabled. AWAITED, so a failure is the caller's. */
    await writeIndexNow(target)
  }

  const add: Library['add'] = (bookId, record, sparse = false) => {
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
      /* NOTHING TO THE SHELF, but the trash may still hold half of this book
       * from a restore that could not finish — and returning here was the only
       * path to `add` that never looked. A watched folder rescanning on every
       * launch would then sail past the stranded files until the sweep deleted
       * them. */
      if (!fs) return Promise.resolve()
      const target = fs
      return queue.append(bookId, () =>
        recorded(recorder, bookId, 'record', async () => {
          await restoreBook(target, bookId)
          await noteReAdd(target, bookId)
          /* AND THE SAME RESCUE the full path does. Returning after the
           * restore alone left a `book.json` the restore could not move
           * sitting in the trash — so a folder import, which is all sparse
           * adds, was the one route that could see the stranded record and
           * walk past it. */
          await rescueStrandedMarks(target, bookId)
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
          if (previous.hasContent === false) await noteContent(target, previous.bookId)
          const stranded = parseRecord(await readText(target, `${trashOf(bookId)}/book.json`))
          if (!stranded) return
          const live = await readBook(target, bookId)
          await writeBook(target, bookId, live ? mergeStranded(stranded, live) : stranded)
          await target.remove(`${trashOf(bookId)}/book.json`).catch(() => {})
        }),
      )
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
    const entry: IndexedBook = { ...merged, bookId }
    const list = at === -1 ? [entry, ...books] : books.map((one, i) => (i === at ? entry : one))
    return commit(bookId, list, 'record', async (target) => {
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
      await restoreBook(target, bookId)
      await noteReAdd(target, bookId)
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
      const stranded = parseRecord(await readText(target, `${trashOf(bookId)}/book.json`))
      /* AND THE MARKS, for the same reason and by the same route. A highlight
       * made while a re-added book's bytes were still being written created a
       * live `marks.json` that blocked the complete one from coming back — so
       * one annotation made in that window cost every annotation made before
       * the book was removed. */
      await rescueStrandedMarks(target, bookId)
      /* MERGED INTO WHAT IS ON DISK, ALWAYS — not only when the row was
       * missing. The in-memory copy comes from an index that `loadShelf` will
       * knowingly trust while it is one write behind, so folding the parse
       * into it and writing that back put a stale record over a newer one:
       * opening a book could undo the tag applied just before the last quit.
       * The record is the truth; the row is a view of it. */
      const live = await readBook(target, bookId)
      /* BOTH ARE THE READER'S, so neither wins outright — see `mergeStranded`.
       * Treating the stranded copy as authoritative threw away a tag applied
       * after the partial restore, which is a fresh way to lose the same thing
       * this rescue exists to save. */
      const existing = stranded ? (live ? mergeStranded(stranded, live) : stranded) : live
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
        await writeBook(target, bookId, kept)
        if (stranded) await target.remove(`${trashOf(bookId)}/book.json`).catch(() => {})
        reconcile(bookId, kept)
        return
      }
      const written = existing ? mergeParsed(existing, record) : merged
      await writeBook(target, bookId, written)
      // Only now: the reader's record is in two places until this line, which
      // is the order that cannot lose it.
      if (stranded) await target.remove(`${trashOf(bookId)}/book.json`).catch(() => {})
      /* WHAT WAS ACTUALLY WRITTEN, back into the row. The optimistic row was
       * built from the index, which `loadShelf` will knowingly trust while it
       * is one write behind — so a tag or a position on disk but not in the
       * cache stayed invisible, and the next thing to save the row wrote the
       * cache's version over it. */
      reconcile(bookId, written)
    })
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
    try {
      await queue.append(from, async () => {
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

  const remove: Library['remove'] = (bookId) => {
    const list = books.filter((one) => one.bookId !== bookId)
    if (list.length === books.length) return Promise.resolve()
    /* ONE RENAME. Phase 3's removal touched three places — a row, the bytes,
     * the cover — any of which could fail alone, and two of which did. */
    const removed = books.find((one) => one.bookId === bookId)
    return commit(bookId, list, 'removed', async (target) => {
      /* THE PRESENCE REGISTER FIRST, THE RENAME SECOND — the order is the
       * point (`presence.ts`). A crash between the two leaves a live folder
       * and a register that says removed, which launch recovery finishes; the
       * other order would leave a book gone with nothing anywhere recording
       * that anyone removed it, and a stale satchel would put it back. */
      await settlePresence(target, bookId, 'removed', clock())
      /* A REMOVAL THAT DID NOT HAPPEN IS NOT A REMOVAL. `trashBook` reports
       * false when there was nothing there — fine, the row was already gone —
       * but it also reported false when the move genuinely failed, and this
       * ignored the answer either way: the row disappeared optimistically, the
       * index was written without it, and the book came back on the next
       * launch. Thrown, so the queue's own reporting says the library could
       * not be saved rather than the shelf lying quietly. */
      try {
        if (!(await trashBook(target, bookId))) {
          if (await target.exists(folderOf(bookId))) {
            throw new Error(`could not remove ${bookId}: its folder is still there`)
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
        if (removed && !books.some((one) => one.bookId === bookId)) {
          publish([removed, ...books])
          await writeIndexNow(target)
        }
        /* AND THE REGISTER IS TOLD THE BOOK STAYED. The removal was reported
         * as failed and the row put back, so leaving `removed` standing would
         * have launch recovery quietly finish, at the next start, the very
         * removal the reader just watched not happen. Best effort: a register
         * that cannot be written back leans towards removal, which recovery
         * treats as intent — the recoverable side of wrong. */
        await settlePresence(target, bookId, 'live', clock()).catch(() => {})
        throw cause
      }
    })
  }

  const restore: Library['restore'] = async (bookId) => {
    if (!fs) return false
    const target = fs
    let came = false
    await queue.append(bookId, () =>
      recorded(recorder, bookId, 'removed', async () => {
        if (!(await restoreBook(target, bookId))) return
        came = true
        /* The register hears about the return, with a stamp newer than the
         * removal's — the `live` half of the LWW pair (`presence.ts`). */
        await settlePresence(target, bookId, 'live', clock())
        await rescueStrandedMarks(target, bookId)
        const record = await readBook(target, bookId)
        if (!record) return
        const hasContent = await hasContentFile(target, folderOf(bookId).slice(BOOKS_DIR.length + 1))
        const row: IndexedBook = { ...record, bookId, hasContent }
        const at = books.findIndex((one) => one.bookId === bookId)
        publish(at === -1 ? [row, ...books] : books.map((one, i) => (i === at ? row : one)))
      }),
    )
    if (came) await writeIndexNow(target)
    return came
  }

  /* THE STAMP IS TAKEN ONCE, OUTSIDE THE CHANGE. `update` applies the change
   * twice — optimistically to the row, then to what is on disk — and a
   * `clock()` inside it would stamp the two applications differently, leaving
   * the index one stamp apart from `book.json` until the next scan. Captured
   * here, both applications carry the same stamp. (WI-C: the writers stamp
   * the ledger's registers now; with no sync composed the stamp is the legacy
   * wall clock under the zero device, which merges exactly like a legacy
   * record's synthesised stamp — nothing changes until a real clock arrives.) */
  const rememberPosition: Library['rememberPosition'] = (bookId, position, progress) => {
    const at = clock()
    return update(bookId, (record) =>
      record.position === position && record.progress === progress
        ? record
        : { ...record, position, progress: Math.min(1, Math.max(0, progress)), positionAt: at },
    )
  }

  const setFinished: Library['setFinished'] = (bookId, finished) => {
    const at = clock()
    return update(bookId, (record) =>
      record.finished === finished ? record : { ...record, finished, finishedAt: at },
    )
  }

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

  /** Every book, one `update` each; settled together, failures gathered. */
  const eachBook = async (change: (record: BookRecord) => BookRecord): Promise<void> => {
    const outcomes = await Promise.allSettled(books.map((book) => update(book.bookId, change)))
    const failed = outcomes.filter((one): one is PromiseRejectedResult => one.status === 'rejected')
    if (failed.length === 1) throw failed[0]!.reason
    if (failed.length) throw new AggregateError(failed.map((one) => one.reason), `${failed.length} books could not be saved`)
  }

  const renameTag: Library['renameTag'] = (from, to) => {
    const value = normalizeTag(to)
    if (!value) return Promise.resolve()
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
    return eachBook((record) => {
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
    })
  }

  const removeTag: Library['removeTag'] = (raw) => {
    const key = tagKey(raw)
    const at = clock()
    // Judged per record, not from the cached row — see `renameTag`.
    return eachBook((record) => {
      const own = record.tags ?? []
      const held = own.find((one) => tagKey(one) === key)
      if (held === undefined) return record
      return setTag(record, held, false, at)
    })
  }

  const keepJacket: Library['keepJacket'] = (bookId, cover) => {
    if (!fs) return Promise.resolve()
    const target = fs
    // The book's OWN key, which is what puts it in line behind that book's
    // record write and its removal rather than beside them.
    return queue.append(bookId, () =>
      recorded(recorder, bookId, 'cover', async () => {
        await keepCover(target, bookId, cover)
      }),
    )
  }

  const keepContent: Library['keepContent'] = async (bookId, name, bytes) => {
    if (!fs) return false
    const target = fs
    let wrote = false
    await queue.append(bookId, () =>
      recorded(recorder, bookId, 'content', async () => {
        const at = contentPathIn(bookId, name)
        /* Checked before the bytes are touched: `arrayBuffer()` copies the
         * whole book into memory, and reopening a 40MB book should not do that
         * to discover it is already here. */
        if (await target.exists(at)) return
        /* Written to a temporary neighbour and renamed, like every other
         * write here: a crash partway must not leave a truncated
         * `content.epub`, because `exists` would then call it the book. */
        await atomicWrite(target, at, new Uint8Array(await bytes.arrayBuffer()))
        wrote = true
      }),
    )
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
  const ownTagCount: Library['ownTagCount'] = (raw) => {
    const key = tagKey(raw)
    return books.filter((book) => (book.tags ?? []).some((one) => tagKey(one) === key)).length
  }

  const positionOf: Library['positionOf'] = (bookId) =>
    bookId ? (books.find((one) => one.bookId === bookId)?.position ?? null) : null

  const refreshContent: Library['refreshContent'] = (bookId) => {
    if (!fs) return Promise.resolve()
    const target = fs
    return queue.append(bookId, () =>
      recorded(recorder, bookId, 'content', () => noteContent(target, bookId)),
    )
  }

  const applyRemoteRows: Library['applyRemoteRows'] = async (rows) => {
    const list = [...books]
    const applied: RemoteRow[] = []
    for (const row of rows) {
      const at = list.findIndex((one) => one.bookId === row.bookId)
      if (at === -1) continue
      const { bookId: _id, ...record } = list[at]!
      const next = row.change(record)
      if (next === record) continue
      list[at] = { ...next, bookId: row.bookId }
      applied.push(row)
    }
    if (applied.length === 0) return
    publish(list)
    if (!fs) return
    const target = fs
    const outcomes = await Promise.allSettled(
      applied.map((row) =>
        queue.append(row.bookId, async () => {
          await recorded(recorder, row.bookId, 'record', () => updateBook(target, row.bookId, row.change))
        }),
      ),
    )
    // ONE index write for the batch, whatever happened to the rows.
    await writeIndexNow(target)
    const failed = outcomes.filter((one): one is PromiseRejectedResult => one.status === 'rejected')
    if (failed.length === 1) throw failed[0]!.reason
    if (failed.length) throw new AggregateError(failed.map((one) => one.reason), `${failed.length} rows could not be applied`)
  }

  return {
    getSnapshot: () => books,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    add,
    update,
    remove,
    restore,
    rememberPosition,
    setFinished,
    tag,
    untag,
    renameTag,
    removeTag,
    ownTagCount,
    keepJacket,
    keepContent,
    positionOf,
    rekeyBook,
    refreshContent,
    applyRemoteRows,
  }
}
