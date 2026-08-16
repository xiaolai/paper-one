import { useCallback, useMemo, useRef } from 'react'
import { rekeyBook } from './idMigration'
import {
  LIBRARY_STORAGE_KEY,
  byRecency,
  parseLibrary,
  recordOpen,
  rememberPosition,
  forgetBook,
  rememberCover,
  applyLookup,
  markFinished,
  tagBook,
  untagBook,
  rememberVault,
  type LibraryEntry,
} from './library'
import { localStore, useStoredCollection, writeJson } from './useStoredCollection'

/**
 * The library, bound to React.
 *
 * Same shape as `useMarks` deliberately — one persistence idiom in the app, not
 * two. Mutations compose from a ref rather than from the value closed over at
 * render, so two opens in one tick both survive, and the write happens outside
 * the state updater because React may invoke an updater twice in StrictMode.
 */

export interface Library {
  readonly books: readonly LibraryEntry[]
  record: (entry: LibraryEntry) => void
  /** Where the reader left off. Ignored for a book not on the shelf. */
  remember: (bookId: string, position: string, progress?: number) => void
  /** Record that Paper's own copy landed — see `rememberVault`. */
  rememberOwned: (bookId: string, vault: string) => void
  /** Record the book's jacket once it is filed — see `rememberCover`. */
  rememberJacket: (bookId: string, cover: string) => void
  /** Take a book off the shelf. The reader's own file is not touched. */
  forget: (bookId: string) => void
  /** Add one of the READER's own tags — never a publisher's subject. */
  tag: (bookId: string, tag: string) => void
  untag: (bookId: string, tag: string) => void
  /** The reader's judgement that a book is done — see `markFinished`. */
  setFinished: (bookId: string, finished: boolean) => void
  /**
   * Shelve a batch of imported books, in ONE write.
   *
   * A book with no row gets one. A book that HAS a row gets its vault path
   * patched and nothing else — an import knows where the bytes landed and does
   * not know the book's metadata, so anything more would overwrite a real row
   * with a filename.
   *
   * The presence check runs INSIDE the mutation, against `prev`. Done outside it
   * the callback would have to depend on `books`, and the watcher effect depends
   * on this callback — so every shelved batch would tear the watcher down and
   * schedule another full catch-up import.
   *
   * One `apply` for the whole batch, rather than one per book: `apply`
   * serialises the entire shelf on every call, so importing three hundred books
   * one row at a time writes the library three hundred times.
   */
  shelve: (rows: readonly LibraryEntry[]) => void
  /** Apply looked-up metadata to a row that is still there — see `applyLookup`. */
  applyFound: (bookId: string, found: Parameters<typeof applyLookup>[2]) => void
  /** The saved position for a book, or null. Stable across renders. */
  positionOf: (bookId: string | null) => string | null
  /** Move a row from a superseded book id — see `idMigration`. */
  rekey: (from: string, to: string) => void
}

export function useLibrary(storage = localStore()): Library {
  /* The same plumbing as marks and cards — see `useStoredCollection`.
   *
   * A failed write is still not surfaced, but THE REASON GIVEN HERE HAS EXPIRED
   * and is worth correcting rather than repeating. It said losing a row only
   * means the switcher forgets a title. That was true when this store held four
   * fields; it now holds reading positions, the reader's own tags, the finished
   * flag, progress, and the paths to Paper's copy of the book and its cover. A
   * failed write now loses work somebody did.
   *
   * It stays silent for now because the failure is not actionable from this
   * screen and the store is written on a throttle — a warning would appear
   * mid-reading, about a write that the next one will probably repair. Surfacing
   * it properly means the durable notice marks and cards use, and that is a
   * change to `useStoredCollection` rather than a line here. Recorded as
   * outstanding rather than left looking intentional. */
  const { items: books, apply } = useStoredCollection<LibraryEntry>({
    storage,
    load: (target) => {
      try {
        return byRecency(parseLibrary(target.getItem(LIBRARY_STORAGE_KEY)))
      } catch {
        return []
      }
    },
    save: (target, next) => writeJson(target, LIBRARY_STORAGE_KEY, next),
  })

  const record = useCallback(
    (entry: LibraryEntry) => apply((prev) => recordOpen(prev, entry)),
    [apply],
  )

  /* The shelf as it is right now, for the two reads below.
   *
   * `books` is a render value; both of these are called from outside a render
   * — one from a debounced timer, the other from the reader's startup, several
   * awaits after the component that created it was drawn. Closing over the
   * render value would give each of them whatever the shelf held when their
   * closure was built. */
  const booksRef = useRef(books)
  booksRef.current = books

  const positionOf = useCallback(
    (bookId: string | null) =>
      bookId
        ? booksRef.current.find((entry) => entry.bookId === bookId)?.position ?? null
        : null,
    [],
  )

  const shelve = useCallback(
    (rows: readonly LibraryEntry[]) => {
      if (rows.length === 0) return
      apply((prev) =>
        rows.reduce((acc, entry) => {
          const at = acc.findIndex((row) => row.bookId === entry.bookId)
          // Absent: a genuinely new row, from the only metadata an import has.
          if (at === -1) return recordOpen(acc, entry)

          /* PRESENT: patch where the bytes are, and nothing else.
           *
           * An import knows one thing a shelved book might not — where its copy
           * landed. It does NOT know the book's metadata: the entry it builds
           * carries a filename for a title and an empty author, because parsing
           * three hundred books to shelve them would make importing as slow as
           * reading.
           *
           * Passing that through `recordOpen` therefore OVERWROTE a real row
           * with a skeleton, and the case is reachable: a book shelved before
           * the vault existed, whose folder is then imported, has a rich row and
           * a newly created copy at the same moment. Its title became the
           * filename and its series, subjects and publisher were erased.
           *
           * The mistake was treating "new vault file" as "new library row". They
           * are different questions and only the second one is asked here. */
          const existing = acc[at]
          if (!existing) return acc
          const vault = entry.vault ?? existing.vault
          const path = entry.path ?? existing.path
          if (existing.vault === vault && existing.path === path) return acc
          const next = [...acc]
          next[at] = { ...existing, ...(vault ? { vault } : {}), path }
          return next
        }, prev),
      )
    },
    [apply],
  )

  const applyFound = useCallback(
    (bookId: string, found: Parameters<typeof applyLookup>[2]) => {
      apply((prev) => applyLookup(prev, bookId, found))
    },
    [apply],
  )

  const setFinished = useCallback(
    (bookId: string, finished: boolean) => {
      apply((prev) => markFinished(prev, bookId, finished))
    },
    [apply],
  )

  const tag = useCallback(
    (bookId: string, value: string) => {
      apply((prev) => tagBook(prev, bookId, value))
    },
    [apply],
  )

  const untag = useCallback(
    (bookId: string, value: string) => {
      apply((prev) => untagBook(prev, bookId, value))
    },
    [apply],
  )

  const forget = useCallback(
    (bookId: string) => {
      apply((prev) => forgetBook(prev, bookId))
    },
    [apply],
  )

  const rememberJacket = useCallback(
    (bookId: string, cover: string) => {
      apply((prev) => rememberCover(prev, bookId, cover))
    },
    [apply],
  )

  const rememberOwned = useCallback(
    (bookId: string, vault: string) => {
      // Identity check first, like `remember`: this fires on every open and
      // most of them find the copy already recorded.
      apply((prev) => rememberVault(prev, bookId, vault))
    },
    [apply],
  )

  const remember = useCallback(
    (bookId: string, position: string, progress?: number) => {
      /* No guard here any more, and none needed. `apply` skips the write when
       * the mutation returns its input by identity, against the authoritative
       * value rather than the render-lagging ref this used to read. */
      apply((prev) => rememberPosition(prev, bookId, position, progress))
    },
    [apply],
  )

  const rekey = useCallback(
    (from: string, to: string) =>
      apply((prev) => {
        const next = rekeyBook(prev, from, to)
        return next === prev ? prev : [...next]
      }),
    [apply],
  )

  /* `forget` was published here and nothing called it: there is no affordance
   * anywhere for removing a book from the shelf, so this was an API waiting for
   * a button. It comes back with the button, tested against what that button
   * actually needs rather than against what seemed likely in advance. */
  return useMemo<Library>(
    () => ({
      books,
      record,
      remember,
      rememberOwned,
      rememberJacket,
      forget,
      tag,
      untag,
      setFinished,
      applyFound,
      shelve,
      positionOf,
      rekey,
    }),
    [books, record, remember, rememberOwned, rememberJacket, forget, tag, untag, setFinished, applyFound, shelve, positionOf, rekey],
  )
}
