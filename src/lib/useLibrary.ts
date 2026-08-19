import { useCallback, useMemo, useRef, useState } from 'react'
import {
  BOOKS_DIR,
  folderOf,
  mergeParsed,
  mergeStranded,
  parseRecord,
  readBook,
  trashOf,
  updateBook,
  writeBook,
  type BookRecord,
} from './bookFolder'
import { hasContentFile, writeIndex, type IndexFs, type IndexedBook, invalidateIndex } from './bookIndex'
import { keepCover } from './coverArt'
import { rescueStrandedMarks, restoreBook, trashBook } from './bookTrash'
import { normalizeTag, tagKey } from './library'
import type { WriteQueue } from './writeQueue'

/**
 * The library, bound to React.
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

export interface Library {
  readonly books: readonly IndexedBook[]
  /**
   * Add a book, or fold a fresh parse into one already here — see `mergeParsed`.
   *
   * `sparse` marks a record that is a PLACEHOLDER rather than a parse: an
   * import knows a filename and nothing else, so it must not be allowed to
   * overwrite a real title, author and subjects. Without it a watched folder
   * degraded every existing record to its filename on startup.
   */
  add: (bookId: string, record: BookRecord, sparse?: boolean) => void
  /**
   * Change one book. The only mutator, because a book is one file.
   *
   * `fromDisk` decides what the change is judged against — the cached row, or
   * the record on disk. See the implementation; the short version is that the
   * cheap answer is right for the position and wrong for a tag.
   */
  update: (bookId: string, change: (record: BookRecord) => BookRecord, fromDisk?: boolean) => void
  /** Take a book off the shelf. Its folder goes to the trash, not away. */
  remove: (bookId: string) => void
  /**
   * Add the reader's own tags to books. Folded, so case cannot duplicate — see
   * `withTagsAdded`. Publisher subjects are never written here.
   *
   * PLURAL ON BOTH SIDES, and that is the whole API: one book with one tag is
   * the editor over a card; fifty with three is the editor over a selection or
   * a drop on a panel row. ONE WRITE PER BOOK whatever the number of tags,
   * because each write is a read-modify-write of that book's `book.json`, and
   * fifty books times three tags as separate single-tag calls is a hundred
   * and fifty of them queued behind each other for no reason. The singular
   * `tag`/`untag` pair went when nothing called it.
   */
  tagBooks: (bookIds: readonly string[], tags: readonly string[]) => void
  /**
   * Take one of the reader's tags off books. A publisher's subject cannot be
   * removed — it is a fact about the book, and it returns on the next parse.
   */
  untagBooks: (bookIds: readonly string[], tag: string) => void
  /**
   * Make a publisher's subject the reader's own, on every book that declares
   * it. From then on it is theirs — renameable, removable, and kept across a
   * re-parse — which is the one-way door out of the publisher's namespace.
   * The subject itself is untouched; `allTags` folds the two into one chip.
   */
  adoptTag: (tag: string) => void
  /**
   * Rename one of the reader's tags on EVERY book that carries it.
   *
   * Composed from `tag` and `untag`, in that order — the new name is added
   * before the old is removed, so a failure between the two leaves a book with
   * both rather than with neither. Renaming onto a name that already exists
   * MERGES: `tag` folds by key, so the books simply end up under one tag, and
   * the survivor's count is what tells the reader it happened. A publisher's
   * subject is untouched — it is not the reader's to rename, and `untag`
   * refuses it anyway.
   */
  renameTag: (from: string, to: string) => void
  /** Take one of the reader's tags off every book that carries it. */
  removeTag: (tag: string) => void
  /**
   * The last shelf-wide tag removal, kept so it can be put back.
   *
   * HERE RATHER THAN IN THE PANEL, which is where it lived and is not where it
   * belongs. `LibraryPanel` is mounted only while its own panel is showing, so
   * switching to Notes — or closing the pane at all — unmounted the one control
   * that could reverse a tag just taken off four hundred books. The action is
   * the store's; so is the means to undo it.
   *
   * Cleared by the undo, and replaced by the next removal. Not timed: a
   * countdown racing the reader is the wrong pressure to apply to something
   * this large, and there is nothing to reclaim by forgetting it sooner.
   */
  readonly lastRemoval: TagRemoval | null
  /** Put the last removal's tag back on the books it came off. */
  undoRemoveTag: () => void
  /**
   * The books a `removeTag` of this tag would touch, by id — see the
   * implementation. The LENGTH is the number the confirm shows; the ids are
   * what an undo re-tags, so both come from one answer and cannot disagree.
   */
  ownTagBooks: (tag: string) => readonly string[]
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
  keepJacket: (bookId: string, cover: Blob) => void
  /** The saved position for a book, or null. Stable across renders. */
  positionOf: (bookId: string | null) => string | null
  /**
   * Carry a book onto a new id, for the lazy identity migration.
   *
   * Resolves when it is done, so a caller can order it BEFORE adding the book
   * under its new id — which is the difference between a migration and a
   * duplicate.
   */
  rekeyBook: (from: string, to: string) => Promise<RekeyOutcome>
}

/**
 * The reader's tags with some more added, folded by key.
 *
 * ONE FUNCTION under `tag`, `tagBooks` and `adoptTag`, so what "add a tag"
 * means is decided once. It folds against the reader's OWN tags only. It used
 * to fold against the publisher's subjects as well, so adding `Philosophy` to
 * a book whose publisher says `philosophy` was a silent no-op — and the
 * reader's copy is a different fact from the publisher's: theirs, durable
 * across a re-parse, and the thing that makes the tag renameable and
 * removable. `allTags` still folds the two into one chip, so nothing is drawn
 * twice.
 *
 * Returns its input BY IDENTITY when nothing was added, which is how the
 * callers tell `update` there is nothing to write.
 */
/** A shelf-wide tag removal, and what it would take to put it back. */
export interface TagRemoval {
  readonly tag: string
  readonly bookIds: readonly string[]
}

export function withTagsAdded(own: readonly string[], values: readonly string[]): readonly string[] {
  const keys = new Set(own.map(tagKey))
  let next = own
  for (const value of values) {
    const key = tagKey(value)
    if (!key || keys.has(key)) continue
    keys.add(key)
    next = [...next, value]
  }
  return next
}

/** One file as text, or null when it is not there or will not read. */
async function readText(fs: IndexFs, path: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await fs.readFile(path))
  } catch {
    return null
  }
}

export function useLibrary(
  fs: IndexFs | null,
  shared: WriteQueue,
  initial: readonly IndexedBook[] = [],
): Library {
  const [books, setBooks] = useState<readonly IndexedBook[]>(initial)

  /* ONE WRITE AT A TIME. Every write here goes to a fixed `<path>.writing`
   * neighbour and renames it into place — atomic for one write, a collision for
   * two, because the second uses the same temporary file. A position save
   * landing while a tag is being written is exactly that shape.
   *
   * The index is one key, so its rewrites also serialise: two commits could
   * otherwise both write it and the older one land last. */
  /* SHARED WITH THE MARKS STORE — see the note there. One queue per book means
   * a record write and a marks write for the same book are serial, which is
   * what the two separate queues could never guarantee. */
  const queue = useRef(shared)
  queue.current = shared

  /* The list as it is right now, for callbacks that run outside a render — a
   * throttled position save, or an import finishing several awaits after the
   * component that started it was drawn. */
  const latest = useRef(books)
  latest.current = books

  /**
   * How many writes are queued or running per book — the guard under
   * `reconcile`.
   *
   * A write's disk result is a photograph of the record as of THAT write. With
   * a second write queued behind it, the reader has already made a newer edit
   * the shelf is showing optimistically — and putting the older photograph
   * over it made the newer tag vanish until its own write landed, or forever
   * if that write failed. Only the LAST write in flight may correct the row,
   * and because the queue is serial per book, the last write's record has
   * everything the earlier ones did.
   */
  const pending = useRef(new Map<string, number>())
  /**
   * Ids carried onto new ones by `rekeyBook`, old → new.
   *
   * A write enqueued against the old id can RUN after the folder has moved:
   * the queue is serial per key, so a tag typed while the rekey waited its
   * turn executed against a folder that was no longer there, read no record,
   * and dropped the edit with no error anywhere. Tasks resolve their id
   * through this map at run time, so the write follows the book.
   */
  const rekeyed = useRef(new Map<string, string>())
  const beginWrite = (bookId: string) =>
    pending.current.set(bookId, (pending.current.get(bookId) ?? 0) + 1)
  const endWrite = (bookId: string) => {
    const left = (pending.current.get(bookId) ?? 1) - 1
    if (left <= 0) pending.current.delete(bookId)
    else pending.current.set(bookId, left)
  }

  /**
   * Put what the disk actually holds back into the row.
   *
   * The optimistic update is a prediction; this is the correction. It runs after
   * a write that merged with the on-disk record, so it is the only path by which
   * a field the index never knew about reaches the shelf. Called from INSIDE the
   * write's own task, while that task is still counted — hence the guard reads
   * "more than one": someone queued after me, so my photograph is stale.
   */
  const reconcile = useCallback((bookId: string, record: BookRecord) => {
    if ((pending.current.get(bookId) ?? 0) > 1) return
    const at = latest.current.findIndex((one) => one.bookId === bookId)
    if (at === -1) return
    const next = [...latest.current]
    next[at] = { ...record, bookId, ...(latest.current[at]!.hasContent === undefined ? {} : { hasContent: latest.current[at]!.hasContent }) }
    latest.current = next
    setBooks(next)
  }, [])

  /** State first, then the folder, then the index. */
  const commit = useCallback(
    (key: string, next: readonly IndexedBook[], write: (target: IndexFs) => Promise<unknown>) => {
      latest.current = next
      setBooks(next)
      if (!fs) return
      beginWrite(key)
      void queue.current
        /* APPEND, not replace. Each task here applies a CHANGE to what is on
         * disk — a tag, then a position — and coalescing two of them drops the
         * first. Marks can coalesce because each of those writes the whole list;
         * these cannot, and the distinction is why the queue has two methods. */
        .append(key, async () => {
          try {
            await write(fs)
          } finally {
            endWrite(key)
          }
        })
        .then(() =>
          /* The index LAST, and on its own key so a book's write is never held
           * up by it. Rewritten whole from `latest.current`, which is the newest
           * state by the time this runs — a cache should describe where things
           * ended up, not where one write thought they were going. */
          queue.current.push('index', async () => {
            await writeIndex(fs, latest.current)
          }),
        )
        .catch((cause: unknown) => {
          console.error('Paper: could not save the library', cause)
          /* AND THE CACHE GOES WITH IT. The record may well have reached disk
           * before the index rewrite failed, and `loadShelf` trusts the index
           * whenever the folder listing agrees — so leaving it there means the
           * next launch reads a shelf that is confidently missing whatever this
           * write was carrying. A rescan is the cost of not knowing which. */
          void invalidateIndex(fs)
        })
    },
    [fs],
  )

  const update = useCallback(
    (
      bookId: string,
      change: (record: BookRecord) => BookRecord,
      /**
       * Judge the change against the DISK, not against the cached row.
       *
       * `update` normally decides whether anything moved by applying `change`
       * to the row it has in memory, and returns without writing when the
       * answer is "nothing" — which is right for the position, saved on every
       * page turn, and wrong for anything that has to be true of the record
       * itself. `book.json` is explicitly allowed to be NEWER than the index
       * (see `readBook`), so a book whose cached row is one write behind was
       * skipped entirely: `removeTag` could not take a tag off a book that had
       * one on disk and not in the cache, and `renameTag`'s own note claimed
       * the opposite was true.
       *
       * With this set the task is queued regardless and `change` is applied to
       * whatever `updateBook` reads. The optimistic row is still only replaced
       * when the cached view of it moved — a write nobody can see does not need
       * to redraw the shelf, and `reconcile` corrects the row afterwards from
       * what the disk actually returned.
       */
      fromDisk = false,
    ) => {
      const at = latest.current.findIndex((one) => one.bookId === bookId)
      const current = at === -1 ? null : latest.current[at]
      if (!current) return
      const { bookId: _id, ...record } = current
      const next = change(record)
      // By identity, so a change that decides nothing moved writes nothing —
      // this runs on every page turn. `fromDisk` is the opt-out: see above.
      if (next === record && !fromDisk) return
      const list = [...latest.current]
      list[at] = { ...next, bookId }
      commit(bookId, list, async (target) => {
        /* RESOLVED AT RUN TIME — the book may have been carried onto a new id
         * while this write waited its turn. See `rekeyed`. */
        const id = rekeyed.current.get(bookId) ?? bookId
        /* THE CHANGE, not the result. Passing `() => next` wrote the in-memory
         * record back — and that copy can be stale, because it came from an
         * index that may be one write behind after a crash. Handing the function
         * over means it is applied to whatever is actually on disk. */
        const written = await updateBook(target, id, change)
        /* AND THE DISK'S ANSWER, back into the row — the same correction `add`
         * makes, for the same reason. The optimistic row was computed from the
         * cache; when the cache was a write behind, the disk record this call
         * just changed had fields the row did not, and the row kept showing
         * the stale copy while the index was rewritten from it. `reconcile`
         * declines when a newer write is already queued — see the guard. */
        if (written) reconcile(id, written)
      })
    },
    [commit, reconcile],
  )

  const add = useCallback(
    (bookId: string, record: BookRecord, sparse = false) => {
      /* MATCHED BY FOLDER, not by the id as spelled. `safeId` is not reversible
       * and not injective, so a record written before the id was stored comes
       * back off the scan as its directory name — `book_abc` for `book:abc` —
       * and a content-derived add would then miss it and put a SECOND row on the
       * shelf for the one folder both resolve to. */
      const at = latest.current.findIndex((one) => folderOf(one.bookId) === folderOf(bookId))
      const previous = at === -1 ? null : latest.current[at]
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
        if (fs) {
          /* Counted under the ROW's id, which is what `reconcile` below is
           * called with — the two spellings can differ when the record predates
           * the id being stored, and a guard keyed one way and read the other
           * guards nothing. */
          beginWrite(previous.bookId)
          void queue.current
            .append(bookId, async () => {
              try {
              /* Whether the restore MOVED anything — the discriminator for the
               * reconcile below. A restore that brought `book.json` back whole
               * leaves nothing stranded, and gating the reconcile on the
               * stranded copy alone meant exactly the successful restores were
               * the ones whose recovered tags stayed invisible. */
              const restored = await restoreBook(fs, bookId)
              await rescueStrandedMarks(fs, bookId)
              /* AND THE SAME RESCUE the full path does. Returning after the
               * restore alone left a `book.json` the restore could not move
               * sitting in the trash — so a folder import, which is all sparse
               * adds, was the one route that could see the stranded record and
               * walk past it. */
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
              if (previous.hasContent === false) {
                const now = await hasContentFile(fs, folderOf(bookId).slice(BOOKS_DIR.length + 1))
                if (now) {
                  const where = latest.current.findIndex((one) => one.bookId === previous.bookId)
                  if (where !== -1) {
                    const list = [...latest.current]
                    list[where] = { ...latest.current[where]!, hasContent: true }
                    latest.current = list
                    setBooks(list)
                    /* ON THE INDEX KEY, like every other index write. Called
                     * directly from a per-book task it shared the fixed
                     * `index.json.writing` path with them — and re-adding a
                     * folder of disabled books starts one of these per book, so
                     * they raced each other and an older list could land last.
                     * Being unchanged in folder membership, that stale cache is
                     * then trusted, and the repaired book goes back to disabled. */
                    /* AWAITED. Dropping the promise put an index write outside
                     * the surrounding catch — and an unhandled rejection is
                     * rendered as a FATAL banner here, so an ordinary failure to
                     * save a cache became the app reporting it had crashed. */
                    await queue.current.push('index', async () => {
                      await writeIndex(fs, latest.current)
                    })
                  }
                }
              }
              const stranded = parseRecord(await readText(fs, `${trashOf(bookId)}/${'book.json'}`))
              if (!stranded && !restored) return
              const live = await readBook(fs, bookId)
              /* Stranded copy present: merge and write, as before. No stranded
               * copy but the restore moved files: the live record IS the
               * recovery, already whole on disk — nothing to write, only to
               * tell. */
              const kept = stranded ? (live ? mergeStranded(stranded, live) : stranded) : live
              if (!kept) return
              if (stranded) {
                await writeBook(fs, bookId, kept)
                await fs.remove(`${trashOf(bookId)}/book.json`).catch(() => {})
              }
              /* THE ROW AND THE CACHE LEARN WHAT WAS RESCUED. This path wrote
               * a restored record — the reader's tags and place, back from the
               * trash — and then told nobody: the shelf kept its sparse row
               * and the index kept the sparse record, so the recovery stayed
               * invisible until the next full scan. The same correction every
               * other write makes, made here. */
              reconcile(previous.bookId, kept)
              await queue.current.push('index', async () => {
                await writeIndex(fs, latest.current)
              })
              } finally {
                endWrite(previous.bookId)
              }
            })
            .catch((cause: unknown) => {
              console.error('Paper: could not finish restoring that book', cause)
            })
        }
        return
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
      const list =
        at === -1
          ? [entry, ...latest.current]
          : latest.current.map((one, i) => (i === at ? entry : one))
      commit(bookId, list, async (target) => {
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
    },
    [commit, reconcile],
  )

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
  const rekeyBook = useCallback(
    async (from: string, to: string): Promise<RekeyOutcome> => {
      if (from === to || !fs) return 'nothing'
      if (!latest.current.some((one) => one.bookId === from)) return 'nothing'
      if (latest.current.some((one) => one.bookId === to)) return 'occupied'
      let outcome = 'nothing' as RekeyOutcome
      try {
        await queue.current.append(from, async () => {
          if (await fs.exists(folderOf(to))) {
            outcome = 'occupied'
            return
          }
          // Already gone — nothing here to carry anywhere.
          if (!(await fs.exists(folderOf(from)))) return
          await fs.rename(folderOf(from), folderOf(to))
          /* THE RENAME IS THE MIGRATION. Everything after it is bookkeeping on
           * a book that has already arrived, so nothing below may turn the
           * answer back into a failure — the caller would then decline to add a
           * book that is sitting there under its new name. `scanBooks` trusts a
           * stored id only when it names the folder it is in, which is what
           * makes the stamp below safe to lose. */
          outcome = 'moved'
          /* THE ROW MOVES WITH THE FOLDER, immediately — before the fallible
           * stamp below, not after it. Re-keyed only once the stamp succeeded,
           * a stamp that failed returned `moved` (correctly — the book HAS
           * moved) while the row still carried the old id, and the caller then
           * added a second row under the new one: the exact duplicate the
           * whole migration exists to prevent, manufactured by its own
           * bookkeeping order. */
          const at = latest.current.findIndex((one) => one.bookId === from)
          if (at !== -1) {
            const next = [...latest.current]
            next[at] = { ...latest.current[at]!, bookId: to }
            latest.current = next
            setBooks(next)
          }
          /* AND LATER WRITES FOLLOW IT — see `rekeyed`. An update enqueued
           * against the old id while this task waited its turn runs after the
           * folder has moved; unmapped, it read no record and quietly dropped
           * the reader's edit. */
          rekeyed.current.set(from, to)
          /* Stamped with the id it now lives under; the record still names the
           * folder it came from until this runs. ON THE NEW ID'S QUEUE KEY:
           * this task runs under the OLD key, and an update the reader makes
           * against the new id queues under the new one — two keys run
           * independently, so a stamp done inline here could read the record,
           * lose the race to that update's write, and put the pre-update copy
           * back. Serialised under `to`, the stamp and any new-id write take
           * turns, and each read-modify-write sees the other's result. */
          await queue.current.append(to, async () => {
            const moved = await readBook(fs, to)
            if (moved) await writeBook(fs, to, moved)
          })
          await queue.current.push('index', async () => {
            await writeIndex(fs, latest.current)
          })
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
    },
    [fs],
  )

  const remove = useCallback(
    (bookId: string) => {
      const list = latest.current.filter((one) => one.bookId !== bookId)
      if (list.length === latest.current.length) return
      /* ONE RENAME. Phase 3's removal touched three places — a row, the bytes,
       * the cover — any of which could fail alone, and two of which did. */
      const removed = latest.current.find((one) => one.bookId === bookId)
      commit(bookId, list, async (target) => {
        // The removal follows a rekeyed book too — see `rekeyed`.
        const id = rekeyed.current.get(bookId) ?? bookId
        /* A REMOVAL THAT DID NOT HAPPEN IS NOT A REMOVAL. `trashBook` reports
         * false when there was nothing there — fine, the row was already gone —
         * but it also reported false when the move genuinely failed, and this
         * ignored the answer either way: the row disappeared optimistically, the
         * index was written without it, and the book came back on the next
         * launch. Thrown, so the queue's own reporting says the library could
         * not be saved rather than the shelf lying quietly. */
        try {
          if (!(await trashBook(target, id))) {
            if (await target.exists(folderOf(id))) {
              throw new Error(`could not remove ${id}: its folder is still there`)
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
          if (removed && !latest.current.some((one) => one.bookId === bookId)) {
            const back = [removed, ...latest.current]
            latest.current = back
            setBooks(back)
            await queue.current.push('index', async () => {
              await writeIndex(target, latest.current)
            })
          }
          throw cause
        }
      })
    },
    [commit],
  )

  const tagBooks = useCallback(
    (bookIds: readonly string[], raws: readonly string[]) => {
      const values = raws.map(normalizeTag).filter(Boolean)
      if (values.length === 0) return
      for (const bookId of bookIds) {
        update(bookId, (record) => {
          const own = record.tags ?? []
          const next = withTagsAdded(own, values)
          return next === own ? record : { ...record, tags: next }
        })
      }
    },
    [update],
  )

  const untagBooks = useCallback(
    (bookIds: readonly string[], raw: string) => {
      const key = tagKey(raw)
      /* WHICH BOOKS ACTUALLY LOSE IT, taken before anything is written — read
       * afterwards the answer is always none, and an undo would have nothing to
       * put the tag back on. Filtered rather than assumed: `bookIds` is a
       * selection, and most of a selection may not carry the tag at all, so
       * putting it back on all of them would tag books that never had it.
       *
       * From the cached rows, which is the one place this is weaker than the
       * removal itself — that reads each record from disk (`true` below), so a
       * tag present only on disk is removed and not offered back. The
       * alternative is reading every record twice for an undo nobody may use. */
      const touched = latest.current
        .filter(
          (book) =>
            bookIds.includes(book.bookId) &&
            (book.tags ?? []).some((one) => tagKey(one) === key),
        )
        .map((book) => book.bookId)
      for (const bookId of bookIds) {
        update(bookId, (record) => {
          const own = record.tags ?? []
          if (!own.some((one) => tagKey(one) === key)) return record
          return { ...record, tags: own.filter((one) => tagKey(one) !== key) }
        }, true)
      }
      /* THE ONE PLACE A REMOVAL IS RECORDED, so the shelf-wide remove and the
       * editor's remove over a selection offer the same way back. `removeTag`
       * routes through here; it used to record separately, which is two answers
       * to "what did that just take off". */
      if (touched.length > 0) setLastRemoval({ tag: normalizeTag(raw), bookIds: touched })
    },
    [update],
  )

  const adoptTag = useCallback(
    (raw: string) => {
      const value = normalizeTag(raw)
      if (!value) return
      const key = tagKey(value)
      /* Judged per record, like `renameTag` — and only books whose PUBLISHER
       * declares it, so adopting `Fiction` does not spray it across the shelf.
       * The spelling written is the one the reader adopted from the panel, on
       * every book, so the tag reads as one thing rather than as each
       * publisher's variant of it. */
      for (const book of latest.current) {
        update(book.bookId, (record) => {
          if (!(record.subjects ?? []).some((one) => tagKey(one) === key)) return record
          const own = record.tags ?? []
          const next = withTagsAdded(own, [value])
          return next === own ? record : { ...record, tags: next }
        }, true)
      }
    },
    [update],
  )

  const renameTag = useCallback(
    (from: string, to: string) => {
      const value = normalizeTag(to)
      if (!value) return
      const fromKey = tagKey(from)
      const toKey = tagKey(value)
      /* ONE WRITE PER BOOK, and that is the whole point. This was `tag(new)`
       * then `untag(old)` — two queued writes — with a comment promising that
       * a failure between them left the book with both rather than neither.
       * The write queue continues after a failed task, so if the add failed
       * and the remove succeeded the reader's tag was simply gone. One `update`
       * that adds and removes in the same record is what makes the promise
       * true: `book.json` is written once, atomically, holding the result.
       *
       * Judged FROM DISK — the `true` on `update` below, and it is load-bearing
       * rather than tidy. `update` normally decides whether anything moved by
       * applying the change to its CACHED row and returns without writing when
       * the answer is nothing; `book.json` is explicitly allowed to be newer
       * than the index, so a book whose row was one write behind was skipped
       * before this call ever reached the disk. This note used to claim the
       * opposite was already true, which was worse than not knowing.
       * Merging onto an existing tag falls out: if `toKey` is already present
       * the map just drops the old spelling and the fold keeps one. */
      for (const book of latest.current) {
        update(book.bookId, (record) => {
          const own = record.tags ?? []
          if (!own.some((one) => tagKey(one) === fromKey)) return record
          const kept = own.filter((one) => tagKey(one) !== fromKey)
          /* Against the reader's OWN tags only — see `withTagsAdded`. Judged
           * against the subjects too, renaming `Sea` to `Fiction` on a book
           * whose publisher said `fiction` dropped the reader's tag and wrote
           * nothing, so it stopped being theirs. */
          const alreadyThere = kept.some((one) => tagKey(one) === toKey)
          return { ...record, tags: alreadyThere ? kept : [...kept, value] }
        }, true)
      }
    },
    [update],
  )

  /* THE SAME TRANSFORMATION `untagBooks` MAKES, over the whole shelf — one
   * implementation, or the two drift on what "take a tag off" means. Judged
   * from disk rather than from the cached row, which is what `untagBooks`
   * passes: a tag that reached `book.json` while the index fell behind is still
   * on the book, and a remove that could not see it left it there for ever. */
  /* DECLARED BEFORE `removeTag`, which closes over it: the removal has to read
   * the affected ids before it takes the tag off, or the undo has nothing to
   * put it back on. */
  const ownTagBooks = useCallback((raw: string): readonly string[] => {
    const key = tagKey(raw)
    return latest.current
      .filter((book) => (book.tags ?? []).some((one) => tagKey(one) === key))
      .map((book) => book.bookId)
  }, [])

  const [lastRemoval, setLastRemoval] = useState<TagRemoval | null>(null)

  const removeTag = useCallback(
    (raw: string) => {
      /* No recording here: `untagBooks` does it, for every caller. The ids it
       * keeps are the books that actually carried the tag, which over the whole
       * shelf is the same answer `ownTagBooks` gives the confirm — so the
       * number the reader was shown and the books an undo restores come from
       * one rule rather than two that could drift. */
      untagBooks(
        latest.current.map((book) => book.bookId),
        raw,
      )
    },
    [untagBooks],
  )

  const undoRemoveTag = useCallback(() => {
    if (!lastRemoval) return
    tagBooks(lastRemoval.bookIds, [lastRemoval.tag])
    setLastRemoval(null)
  }, [lastRemoval, tagBooks])

  const keepJacket = useCallback(
    (bookId: string, cover: Blob) => {
      if (!fs) return
      // The book's OWN key, which is what puts it in line behind that book's
      // record write and its removal rather than beside them.
      queue.current
        .append(bookId, async () => {
          await keepCover(fs, bookId, cover)
        })
        /* CAUGHT, like every other queued write. `void` discarded the
         * rejection, and a cover that failed to persist surfaced as an
         * unhandled-rejection banner claiming the app had crashed — for a
         * jacket, which the next open re-extracts anyway. */
        .catch((cause: unknown) => {
          console.error('Paper: could not keep the cover', cause)
        })
    },
    [fs],
  )

  /**
   * The books carrying this as the READER's own tag — the ones a
   * collection-wide remove will touch, and the ones an undo puts it back on.
   *
   * Distinct from what the Library panel shows beside the row, which is scoped
   * to the current view and counts publisher subjects too. Showing that number
   * as "Remove from N books" was a lie in both directions: under `is:reading`
   * a tag on five books read "Remove from 2" and removed from five; a tag that
   * was three subjects and one reader tag read "4" and removed from one. The
   * consent number has to be the action's number.
   */
  const positionOf = useCallback(
    (bookId: string | null) =>
      bookId ? latest.current.find((one) => one.bookId === bookId)?.position ?? null : null,
    [],
  )

  return useMemo<Library>(
    () => ({
      books,
      add,
      update,
      remove,
      tagBooks,
      untagBooks,
      adoptTag,
      renameTag,
      removeTag,
      lastRemoval,
      undoRemoveTag,
      ownTagBooks,
      keepJacket,
      positionOf,
      rekeyBook,
    }),
    [
      books,
      add,
      update,
      remove,
      tagBooks,
      untagBooks,
      adoptTag,
      renameTag,
      removeTag,
      lastRemoval,
      undoRemoveTag,
      ownTagBooks,
      keepJacket,
      positionOf,
      rekeyBook,
    ],
  )
}
