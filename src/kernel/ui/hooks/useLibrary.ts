import { useMemo, useSyncExternalStore } from 'react'
import type { BookRecord } from '../../core/bookFolder'
import type { IndexedBook } from '../../core/bookIndex'
import type { Library, RekeyOutcome, TagRemoval } from '../../core/libraryStore'

/**
 * The library, bound to React — an ADAPTER over `core/libraryStore`.
 *
 * Every verb, and the reasoning behind each, lives in the service; this
 * subscribes a component to its snapshot and hands the verbs on. The one
 * thing added here is what React needs and a service must not do: the
 * promises are let go. A component that adds a tag does not wait for the
 * disk, and a rejection — the write failing — is reported to the console
 * rather than left unhandled, where the app's fatal handler would render an
 * ordinary "could not save" as a crash.
 */
export interface LibraryView {
  readonly books: readonly IndexedBook[]
  add: (bookId: string, record: BookRecord, sparse?: boolean) => void
  update: (bookId: string, change: (record: BookRecord) => BookRecord) => void
  remove: (bookId: string) => void
  rememberPosition: (bookId: string, position: string, progress: number) => void
  setFinished: (bookId: string, finished: boolean) => void
  tag: (bookId: string, tag: string) => void
  untag: (bookId: string, tag: string) => void
  tagBooks: (bookIds: readonly string[], tags: readonly string[]) => void
  untagBooks: (bookIds: readonly string[], tag: string) => void
  adoptTag: (tag: string) => void
  renameTag: (from: string, to: string) => void
  removeTag: (tag: string) => void
  ownTagCount: (tag: string) => number
  ownTagBooks: (tag: string) => readonly string[]
  /** What the last removal took, for the undo the panel offers. */
  readonly lastRemoval: TagRemoval | null
  undoRemoveTag: () => void
  keepJacket: (bookId: string, cover: Blob) => void
  /** Awaitable, because intake orders the record after the bytes. */
  keepContent: (bookId: string, name: string, bytes: Blob) => Promise<boolean>
  positionOf: (bookId: string | null) => string | null
  /** Awaitable, because a caller must order it before adding under the new id. */
  rekeyBook: (from: string, to: string) => Promise<RekeyOutcome>
}

const SAVE_FAILED = 'Paper: could not save the library'

/** Let a write go, reporting a failure rather than leaving it unhandled. */
function letGo(written: Promise<unknown>): void {
  void written.catch((cause: unknown) => {
    console.error(SAVE_FAILED, cause)
  })
}

export function useLibrary(library: Library): LibraryView {
  const books = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot)
  /* A SECOND SUBSCRIPTION over the same listeners, not a field of the snapshot.
   * The undo offer is not part of the shelf, and folding it into the row list
   * would make every subscriber to the books re-render when it moves — and
   * would make the snapshot a new object each time, which is what
   * `useSyncExternalStore` refuses. The store notifies once; each hook reads
   * the part it cares about. */
  const lastRemoval = useSyncExternalStore(library.subscribe, library.lastRemoval, library.lastRemoval)
  const verbs = useMemo(
    () => ({
      add: (bookId: string, record: BookRecord, sparse?: boolean) =>
        letGo(library.add(bookId, record, sparse)),
      update: (bookId: string, change: (record: BookRecord) => BookRecord) =>
        letGo(library.update(bookId, change)),
      remove: (bookId: string) => letGo(library.remove(bookId)),
      rememberPosition: (bookId: string, position: string, progress: number) =>
        letGo(library.rememberPosition(bookId, position, progress)),
      setFinished: (bookId: string, finished: boolean) => letGo(library.setFinished(bookId, finished)),
      tag: (bookId: string, tag: string) => letGo(library.tag(bookId, tag)),
      untag: (bookId: string, tag: string) => letGo(library.untag(bookId, tag)),
      tagBooks: (bookIds: readonly string[], tags: readonly string[]) =>
        letGo(library.tagBooks(bookIds, tags)),
      untagBooks: (bookIds: readonly string[], tag: string) =>
        letGo(library.untagBooks(bookIds, tag)),
      adoptTag: (tag: string) => letGo(library.adoptTag(tag)),
      undoRemoveTag: () => letGo(library.undoRemoveTag()),
      renameTag: (from: string, to: string) => letGo(library.renameTag(from, to)),
      removeTag: (tag: string) => letGo(library.removeTag(tag)),
      keepJacket: (bookId: string, cover: Blob) => letGo(library.keepJacket(bookId, cover)),
      keepContent: library.keepContent,
      ownTagCount: library.ownTagCount,
      ownTagBooks: library.ownTagBooks,
      positionOf: library.positionOf,
      rekeyBook: library.rekeyBook,
    }),
    [library],
  )
  return useMemo<LibraryView>(() => ({ books, lastRemoval, ...verbs }), [books, lastRemoval, verbs])
}
