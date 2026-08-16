import { useCallback, useMemo, useRef, useState } from 'react'
import {
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
import { writeIndex, type IndexFs, type IndexedBook } from './bookIndex'
import { rescueStrandedMarks, restoreBook, trashBook } from './bookTrash'
import { tagKey } from './library'
import { writeQueue } from './writeQueue'

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
  /** Add a book, or fold a fresh parse into one already here — see `mergeParsed`. */
  /**
   * Add a book, or fold a fresh parse into one already here — see `mergeParsed`.
   *
   * `sparse` marks a record that is a PLACEHOLDER rather than a parse: an
   * import knows a filename and nothing else, so it must not be allowed to
   * overwrite a real title, author and subjects. Without it a watched folder
   * degraded every existing record to its filename on startup.
   */
  add: (bookId: string, record: BookRecord, sparse?: boolean) => void
  /** Change one book. The only mutator, because a book is one file. */
  update: (bookId: string, change: (record: BookRecord) => BookRecord) => void
  /** Take a book off the shelf. Its folder goes to the trash, not away. */
  remove: (bookId: string) => void
  /** Add one of the reader's own tags. Folded, so case cannot duplicate. */
  tag: (bookId: string, tag: string) => void
  untag: (bookId: string, tag: string) => void
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

/** One file as text, or null when it is not there or will not read. */
async function readText(fs: IndexFs, path: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await fs.readFile(path))
  } catch {
    return null
  }
}

export function useLibrary(fs: IndexFs | null, initial: readonly IndexedBook[] = []): Library {
  const [books, setBooks] = useState<readonly IndexedBook[]>(initial)

  /* ONE WRITE AT A TIME. Every write here goes to a fixed `<path>.writing`
   * neighbour and renames it into place — atomic for one write, a collision for
   * two, because the second uses the same temporary file. A position save
   * landing while a tag is being written is exactly that shape.
   *
   * The index is one key, so its rewrites also serialise: two commits could
   * otherwise both write it and the older one land last. */
  const queue = useRef(writeQueue())

  /* The list as it is right now, for callbacks that run outside a render — a
   * throttled position save, or an import finishing several awaits after the
   * component that started it was drawn. */
  const latest = useRef(books)
  latest.current = books

  /**
   * Put what the disk actually holds back into the row.
   *
   * The optimistic update is a prediction; this is the correction. It runs after
   * a write that merged with the on-disk record, so it is the only path by which
   * a field the index never knew about reaches the shelf.
   */
  const reconcile = useCallback((bookId: string, record: BookRecord) => {
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
      void queue.current
        /* APPEND, not replace. Each task here applies a CHANGE to what is on
         * disk — a tag, then a position — and coalescing two of them drops the
         * first. Marks can coalesce because each of those writes the whole list;
         * these cannot, and the distinction is why the queue has two methods. */
        .append(key, async () => {
          await write(fs)
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
        })
    },
    [fs],
  )

  const update = useCallback(
    (bookId: string, change: (record: BookRecord) => BookRecord) => {
      const at = latest.current.findIndex((one) => one.bookId === bookId)
      const current = at === -1 ? null : latest.current[at]
      if (!current) return
      const { bookId: _id, ...record } = current
      const next = change(record)
      // By identity, so a change that decides nothing moved writes nothing —
      // this runs on every page turn.
      if (next === record) return
      const list = [...latest.current]
      list[at] = { ...next, bookId }
      commit(bookId, list, (target) =>
        /* THE CHANGE, not the result. Passing `() => next` wrote the in-memory
         * record back — and that copy can be stale, because it came from an
         * index that may be one write behind after a crash. Handing the function
         * over means it is applied to whatever is actually on disk. */
        updateBook(target, bookId, change),
      )
    },
    [commit],
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
          void queue.current
            .append(bookId, async () => {
              await restoreBook(fs, bookId)
              await rescueStrandedMarks(fs, bookId)
              /* AND THE SAME RESCUE the full path does. Returning after the
               * restore alone left a `book.json` the restore could not move
               * sitting in the trash — so a folder import, which is all sparse
               * adds, was the one route that could see the stranded record and
               * walk past it. */
              const stranded = parseRecord(await readText(fs, `${trashOf(bookId)}/${'book.json'}`))
              if (!stranded) return
              const live = await readBook(fs, bookId)
              await writeBook(fs, bookId, live ? mergeStranded(stranded, live) : stranded)
              await fs.remove(`${trashOf(bookId)}/book.json`).catch(() => {})
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
        await restoreBook(target as never, bookId)
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
        await rescueStrandedMarks(target as never, bookId)
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
          // Stamped with the id it now lives under; the record still names the
          // folder it came from until this runs.
          /* THE RENAME IS THE MIGRATION. Everything after it is bookkeeping on
           * a book that has already arrived, so nothing below may turn the
           * answer back into a failure — the caller would then decline to add a
           * book that is sitting there under its new name. `scanBooks` trusts a
           * stored id only when it names the folder it is in, which is what
           * makes the stamp below safe to lose. */
          outcome = 'moved'
          const moved = await readBook(fs, to)
          if (moved) await writeBook(fs, to, moved)
          const at = latest.current.findIndex((one) => one.bookId === from)
          if (at === -1) return
          const next = [...latest.current]
          next[at] = { ...latest.current[at]!, bookId: to }
          latest.current = next
          setBooks(next)
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
      commit(bookId, list, (target) => trashBook(target as never, bookId))
    },
    [commit],
  )

  const tag = useCallback(
    (bookId: string, raw: string) => {
      const value = raw.trim().slice(0, 60)
      if (!value) return
      const key = tagKey(value)
      update(bookId, (record) => {
        const own = record.tags ?? []
        const declared = record.subjects ?? []
        // Folded against BOTH lists: a publisher's `philosophy` and a reader's
        // `Philosophy` are one tag on this book.
        if ([...own, ...declared].some((one) => tagKey(one) === key)) return record
        return { ...record, tags: [...own, value] }
      })
    },
    [update],
  )

  const untag = useCallback(
    (bookId: string, raw: string) => {
      const key = tagKey(raw)
      update(bookId, (record) => {
        const own = record.tags ?? []
        // A publisher's subject cannot be removed — it is a fact about the book,
        // and it returns on the next parse anyway.
        if (!own.some((one) => tagKey(one) === key)) return record
        return { ...record, tags: own.filter((one) => tagKey(one) !== key) }
      })
    },
    [update],
  )

  const positionOf = useCallback(
    (bookId: string | null) =>
      bookId ? latest.current.find((one) => one.bookId === bookId)?.position ?? null : null,
    [],
  )

  return useMemo<Library>(
    () => ({ books, add, update, remove, tag, untag, positionOf, rekeyBook }),
    [books, add, update, remove, tag, untag, positionOf, rekeyBook],
  )
}
