import { useCallback, useMemo, useRef, useState } from 'react'
import { mergeParsed, readBook, updateBook, writeBook, type BookRecord } from './bookFolder'
import { writeIndex, type IndexFs, type IndexedBook } from './bookIndex'
import { restoreBook, trashBook } from './bookTrash'
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

  /** State first, then the folder, then the index. */
  const commit = useCallback(
    (key: string, next: readonly IndexedBook[], write: (target: IndexFs) => Promise<unknown>) => {
      latest.current = next
      setBooks(next)
      if (!fs) return
      void queue.current
        .push(key, async () => {
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
      const at = latest.current.findIndex((one) => one.bookId === bookId)
      const previous = at === -1 ? null : latest.current[at]
      /* A PLACEHOLDER over a real record does nothing. An import supplies a
       * filename for a title and an empty author; `mergeParsed` treats what it
       * is given as the book's own account of itself, which is right for a
       * parse and destructive for a guess. */
      if (sparse && previous) return
      /* A fresh parse folded into what the reader owns. The book is the
       * authority on its own metadata; the reader is the authority on their
       * tags, their place in it, and whether they are done. */
      const { bookId: _id, ...prior } = previous ?? { bookId: '' }
      const merged = mergeParsed(previous ? (prior as BookRecord) : null, record)
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
         * moment content-derived identity was about to hand them back. */
        if (at === -1) await restoreBook(target as never, bookId)
        const existing = at === -1 ? await readBook(target, bookId) : null
        await writeBook(target, bookId, existing ? mergeParsed(existing, record) : merged)
      })
    },
    [commit],
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
    () => ({ books, add, update, remove, tag, untag, positionOf }),
    [books, add, update, remove, tag, untag, positionOf],
  )
}
