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
  remember: (bookId: string, position: string) => void
  /** Record that Paper's own copy landed — see `rememberVault`. */
  rememberOwned: (bookId: string, vault: string) => void
  /** Record the book's jacket once it is filed — see `rememberCover`. */
  rememberJacket: (bookId: string, cover: string) => void
  /** Take a book off the shelf. The reader's own file is not touched. */
  forget: (bookId: string) => void
  /** Add one of the READER's own tags — never a publisher's subject. */
  tag: (bookId: string, tag: string) => void
  untag: (bookId: string, tag: string) => void
  /** The saved position for a book, or null. Stable across renders. */
  positionOf: (bookId: string | null) => string | null
  /** Move a row from a superseded book id — see `idMigration`. */
  rekey: (from: string, to: string) => void
}

export function useLibrary(storage = localStore()): Library {
  /* The same plumbing as marks and cards — see `useStoredCollection`. The one
   * difference that matters is deliberate and stays here: a failed write is not
   * surfaced. Losing a mark loses the reader's own words; losing a row here
   * only means the switcher forgets a title, and a persistence warning over
   * the recency list would be noise. */
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

  const tag = useCallback(
    (bookId: string, value: string) => {
      if (tagBook(booksRef.current, bookId, value) === booksRef.current) return
      apply((prev) => [...tagBook(prev, bookId, value)])
    },
    [apply],
  )

  const untag = useCallback(
    (bookId: string, value: string) => {
      if (untagBook(booksRef.current, bookId, value) === booksRef.current) return
      apply((prev) => [...untagBook(prev, bookId, value)])
    },
    [apply],
  )

  const forget = useCallback(
    (bookId: string) => {
      if (forgetBook(booksRef.current, bookId) === booksRef.current) return
      apply((prev) => [...forgetBook(prev, bookId)])
    },
    [apply],
  )

  const rememberJacket = useCallback(
    (bookId: string, cover: string) => {
      if (rememberCover(booksRef.current, bookId, cover) === booksRef.current) return
      apply((prev) => [...rememberCover(prev, bookId, cover)])
    },
    [apply],
  )

  const rememberOwned = useCallback(
    (bookId: string, vault: string) => {
      // Identity check first, like `remember`: this fires on every open and
      // most of them find the copy already recorded.
      if (rememberVault(booksRef.current, bookId, vault) === booksRef.current) return
      apply((prev) => [...rememberVault(prev, bookId, vault)])
    },
    [apply],
  )

  const remember = useCallback(
    (bookId: string, position: string) => {
      /* Checked before applying, not inside the mutation. `apply` persists
       * whatever the mutation returns — a full serialisation of the shelf —
       * even when it returns the collection unchanged, and this runs while the
       * reader is reading. `rememberPosition` returning its input by identity
       * is what makes the check a comparison rather than a diff. */
      if (rememberPosition(booksRef.current, bookId, position) === booksRef.current) return
      /* Copied unconditionally on the way out. The guard above reads the render
       * value and the mutation below reads `apply`'s own, and the two differ
       * between an apply and the render that follows it — so the inner call can
       * legitimately find nothing to change. Forcing a new array costs one
       * redundant write in that window; not forcing one would drop a real
       * position on the floor, and only the second failure is silent. */
      apply((prev) => [...rememberPosition(prev, bookId, position)])
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
      positionOf,
      rekey,
    }),
    [books, record, remember, rememberOwned, rememberJacket, forget, tag, untag, positionOf, rekey],
  )
}
