import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { BookRecord } from '../../core/bookFolder'
import type { IndexedBook } from '../../core/bookIndex'
import type {
  Library,
  RekeyOutcome,
  SaveFailure,
  TagEntry,
  TagManyOutcome,
  TagRemoval,
} from '../../core/libraryStore'

/**
 * The library, bound to React — an ADAPTER over `core/libraryStore`.
 *
 * Every verb, and the reasoning behind each, lives in the service; this
 * subscribes a component to its snapshot and hands the verbs on. The one
 * thing added here is what React needs and a service must not do: the
 * promises are let go. A component that adds a tag does not wait for the
 * disk, and a rejection — the write failing — must not be left unhandled,
 * where the app's fatal handler would render an ordinary "could not save" as
 * a crash.
 *
 * LET GO IS NOT SWALLOWED. Every rejection went to `console.error` and
 * nowhere else, and the library was the one store that published no
 * `persistent` flag — so a tag that never reached the disk looked, on the
 * shelf, exactly like one that had, until the next launch disagreed. The
 * store now publishes the failure (`Library.lastFailure`); this hook, which
 * is the one holding the verb that failed, is what can offer to run it again.
 */
export interface LibraryView {
  readonly books: readonly IndexedBook[]
  add: (bookId: string, record: BookRecord, sparse?: boolean) => void
  /**
   * Awaitable, and NOT let go — the import needs the count of what could not
   * be saved so it can say so. See `Library.addMany`.
   */
  addMany: (
    entries: readonly { bookId: string; record: BookRecord; sparse?: boolean }[],
  ) => Promise<number>
  update: (bookId: string, change: (record: BookRecord) => BookRecord) => void
  remove: (bookId: string) => void
  rememberPosition: (bookId: string, position: string, progress: number) => void
  setFinished: (bookId: string, finished: boolean) => void
  tag: (bookId: string, tag: string) => void
  untag: (bookId: string, tag: string) => void
  tagBooks: (bookIds: readonly string[], tags: readonly string[]) => void
  /** Awaitable, like `addMany` and for the same reason: the tag import reports what landed. */
  tagMany: (entries: readonly TagEntry[]) => Promise<TagManyOutcome>
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
  /**
   * The last write that did not land, as a sentence, with the way to try it
   * again — or null. See `Library.lastFailure` for what clears it.
   */
  readonly saveFailure: SaveFailureView | null
  dismissSaveFailure: () => void
}

export interface SaveFailureView {
  /** "Couldn’t save “Moby-Dick”". */
  readonly message: string
  /**
   * Run the write that failed again — or null when this hook did not run it.
   *
   * A capability's handler writes through the store directly, and a failure
   * of ITS write is shown here too; but the hook holds no verb for it, and
   * re-running the wrong one would be worse than offering none.
   */
  readonly retry: (() => void) | null
}

const SAVE_FAILED = 'Paper: could not save the library'

export function useLibrary(library: Library): LibraryView {
  const books = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot)
  /* A SECOND SUBSCRIPTION over the same listeners, not a field of the snapshot.
   * The undo offer is not part of the shelf, and folding it into the row list
   * would make every subscriber to the books re-render when it moves — and
   * would make the snapshot a new object each time, which is what
   * `useSyncExternalStore` refuses. The store notifies once; each hook reads
   * the part it cares about. */
  const lastRemoval = useSyncExternalStore(library.subscribe, library.lastRemoval, library.lastRemoval)
  const failure = useSyncExternalStore(library.subscribe, library.lastFailure, library.lastFailure)
  /* THE VERB BEHIND EACH FAILURE THIS HOOK RAN, keyed by the failure object
   * the store published for it. Paired in the rejection handler, which runs
   * after the store has already notified — so `paired` is bumped to bring
   * the view up to date once the pairing exists, rather than one render
   * later when something else happens to move. */
  const retries = useRef(new WeakMap<SaveFailure, () => void>())
  const [paired, setPaired] = useState(0)
  const verbs = useMemo(() => {
    /** Let a write go, keeping the verb so a failure can offer its retry. */
    const letGo = (run: () => Promise<unknown>): void => {
      void run().catch((cause: unknown) => {
        console.error(SAVE_FAILED, cause)
        const failed = library.lastFailure()
        if (failed === null) return
        retries.current.set(failed, () => letGo(run))
        setPaired((n) => n + 1)
      })
    }
    return {
      add: (bookId: string, record: BookRecord, sparse?: boolean) =>
        letGo(() => library.add(bookId, record, sparse)),
      addMany: library.addMany,
      update: (bookId: string, change: (record: BookRecord) => BookRecord) =>
        letGo(() => library.update(bookId, change)),
      remove: (bookId: string) => letGo(() => library.remove(bookId)),
      rememberPosition: (bookId: string, position: string, progress: number) =>
        letGo(() => library.rememberPosition(bookId, position, progress)),
      setFinished: (bookId: string, finished: boolean) => letGo(() => library.setFinished(bookId, finished)),
      tag: (bookId: string, tag: string) => letGo(() => library.tag(bookId, tag)),
      untag: (bookId: string, tag: string) => letGo(() => library.untag(bookId, tag)),
      tagBooks: (bookIds: readonly string[], tags: readonly string[]) =>
        letGo(() => library.tagBooks(bookIds, tags)),
      tagMany: library.tagMany,
      untagBooks: (bookIds: readonly string[], tag: string) =>
        letGo(() => library.untagBooks(bookIds, tag)),
      adoptTag: (tag: string) => letGo(() => library.adoptTag(tag)),
      undoRemoveTag: () => letGo(() => library.undoRemoveTag()),
      renameTag: (from: string, to: string) => letGo(() => library.renameTag(from, to)),
      removeTag: (tag: string) => letGo(() => library.removeTag(tag)),
      keepJacket: (bookId: string, cover: Blob) => letGo(() => library.keepJacket(bookId, cover)),
      keepContent: library.keepContent,
      ownTagCount: library.ownTagCount,
      ownTagBooks: library.ownTagBooks,
      positionOf: library.positionOf,
      rekeyBook: library.rekeyBook,
      dismissSaveFailure: library.dismissFailure,
    }
  }, [library])
  const saveFailure = useMemo<SaveFailureView | null>(
    () =>
      failure === null
        ? null
        : { message: `Couldn’t save “${failure.title}”`, retry: retries.current.get(failure) ?? null },
    // `paired` is the signal that the retry for this failure now exists.
    [failure, paired],
  )
  return useMemo<LibraryView>(
    () => ({ books, lastRemoval, saveFailure, ...verbs }),
    [books, lastRemoval, saveFailure, verbs],
  )
}
