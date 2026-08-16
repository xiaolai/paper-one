import { useCallback, useMemo, useRef, useState } from 'react'
import {
  folderOf,
  mergeParsed,
  trashOf,
  updateBook,
  writeBook,
  type BookRecord,
} from './bookFolder'
import { writeIndex, type IndexFs, type IndexedBook } from './bookIndex'
import { tagKey } from './library'

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
  add: (bookId: string, record: BookRecord) => void
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

  /* The list as it is right now, for callbacks that run outside a render — a
   * throttled position save, or an import finishing several awaits after the
   * component that started it was drawn. */
  const latest = useRef(books)
  latest.current = books

  /** State first, then the folder, then the index. */
  const commit = useCallback(
    (next: readonly IndexedBook[], write: (target: IndexFs) => Promise<unknown>) => {
      latest.current = next
      setBooks(next)
      if (!fs) return
      void (async () => {
        try {
          await write(fs)
          // The index LAST, and rewritten whole. It is a cache: a failure here
          // costs a rescan on the next launch, never a book.
          await writeIndex(fs, latest.current)
        } catch (cause) {
          console.error('Paper: could not save the library', cause)
        }
      })()
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
      commit(list, (target) =>
        /* Read-modify-write against the FOLDER rather than writing the
         * in-memory copy: another write may have landed since this one was
         * queued, and the file is the truth. */
        updateBook(target, bookId, () => next),
      )
    },
    [commit],
  )

  const add = useCallback(
    (bookId: string, record: BookRecord) => {
      const at = latest.current.findIndex((one) => one.bookId === bookId)
      const previous = at === -1 ? null : latest.current[at]
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
      commit(list, (target) => writeBook(target, bookId, merged))
    },
    [commit],
  )

  const remove = useCallback(
    (bookId: string) => {
      const list = latest.current.filter((one) => one.bookId !== bookId)
      if (list.length === latest.current.length) return
      /* ONE RENAME. Phase 3's removal touched three places — a row, the bytes,
       * the cover — any of which could fail alone, and two of which did. */
      commit(list, (target) => target.rename(folderOf(bookId), trashOf(bookId)))
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
