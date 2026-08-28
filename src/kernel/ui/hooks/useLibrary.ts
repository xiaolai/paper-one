import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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
  /* THE INDEX FLUSH ON BLUR AND ON HIDE (phase 20, D4). A page turn writes
   * `book.json` and marks the index dirty; the index itself is rewritten on
   * a 15 s throttle, at quit through the teardown's drain — and here, when
   * the window loses focus or the tab is hidden, which is the moment a
   * reader is about to sleep the machine or switch away. Chromium's prefs
   * and Firefox's session store commit on the same signals. The store is
   * DOM-free, so the two listeners live in the one hook that adapts it. */
  useEffect(() => {
    const flush = () => void library.flushIndex().catch((cause: unknown) => console.error(SAVE_FAILED, cause))
    const hidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('blur', flush)
      document.removeEventListener('visibilitychange', hidden)
    }
  }, [library])
  /* THE VERB BEHIND EACH FAILURE THIS HOOK RAN, keyed by the failure object
   * the store published for it. Paired in the rejection handler, which runs
   * after the store has already notified — so `paired` is bumped to bring
   * the view up to date once the pairing exists, rather than one render
   * later when something else happens to move. */
  const retries = useRef(new WeakMap<SaveFailure, () => void>())
  /**
   * Failures TWO verbs both claimed, which get no retry at all.
   *
   * ⚠️ **THE BOOK IS NOT AN IDENTITY.** Pairing by book was written to stop the
   * button under "Couldn't save A" re-running a write to B, and it does — but
   * two writes to the SAME book failing close together both match, and the
   * second to reach its catch quietly replaced the first's verb. The store
   * publishes one `lastFailure` and a catch can only read whatever is current
   * when it runs, so which verb the failure actually describes is not
   * decidable from here; the last one to arrive is a guess, and the guess can
   * be `remove`.
   *
   * The rule this hook already states for a shelf-wide verb — ambiguity shows
   * no retry, which is honest — is the rule for a book-scoped one too. A
   * contested failure is marked rather than overwritten, and a marked failure
   * offers nothing.
   */
  const contested = useRef(new WeakSet<SaveFailure>())
  const [paired, setPaired] = useState(0)
  const verbs = useMemo(() => {
    /**
     * Let a write go, keeping the verb so a failure can offer its retry.
     *
     * PAIRED BY BOOK, not by recency. The store publishes one `lastFailure`,
     * and two writes rejecting close together used to read it in whichever
     * order their catches ran — so the displayed failure could carry the
     * OTHER write's retry, and the button under "Couldn't save A" re-ran a
     * write to B. A verb that knows its book pairs only with a failure
     * naming that book; a shelf-wide verb (rename, undo) pairs only while
     * the failure is unclaimed. Ambiguity now shows a failure with no retry,
     * which is honest, rather than the wrong one.
     *
     * AND THE SAME BOOK TWICE IS AMBIGUITY TOO — see `contested`. A second
     * claim on one failure does not win it, it spoils it.
     *
     * AND A RETRY RUNS ONCE: it unpairs itself before running, so a second
     * click while the first is in flight is a no-op — a failed retry mints a
     * fresh failure object and pairs anew.
     */
    const letGo = (run: () => Promise<unknown>, bookId?: string): void => {
      void run().catch((cause: unknown) => {
        console.error(SAVE_FAILED, cause)
        const failed = library.lastFailure()
        if (failed === null) return
        if (bookId !== undefined && failed.bookId !== bookId) return
        if (contested.current.has(failed)) return
        if (retries.current.has(failed)) {
          /* A SHELF-WIDE VERB STILL STANDS ASIDE rather than spoiling the
             claim, exactly as it did: it cannot tell whether the failure is
             even its own, so it is the weaker claim and not a rival one. */
          if (bookId === undefined) return
          /* Somebody else's verb is already on it and this one matches just as
             well. Neither is knowably the write that failed, so the failure
             keeps its sentence and loses its button. */
          retries.current.delete(failed)
          contested.current.add(failed)
          setPaired((n) => n + 1)
          return
        }
        retries.current.set(failed, () => {
          retries.current.delete(failed)
          setPaired((n) => n + 1)
          letGo(run, bookId)
        })
        setPaired((n) => n + 1)
      })
    }
    return {
      add: (bookId: string, record: BookRecord, sparse?: boolean) =>
        letGo(() => library.add(bookId, record, sparse), bookId),
      addMany: library.addMany,
      update: (bookId: string, change: (record: BookRecord) => BookRecord) =>
        letGo(() => library.update(bookId, change), bookId),
      remove: (bookId: string) => letGo(() => library.remove(bookId), bookId),
      rememberPosition: (bookId: string, position: string, progress: number) =>
        letGo(() => library.rememberPosition(bookId, position, progress), bookId),
      setFinished: (bookId: string, finished: boolean) =>
        letGo(() => library.setFinished(bookId, finished), bookId),
      tag: (bookId: string, tag: string) => letGo(() => library.tag(bookId, tag), bookId),
      untag: (bookId: string, tag: string) => letGo(() => library.untag(bookId, tag), bookId),
      tagBooks: (bookIds: readonly string[], tags: readonly string[]) =>
        letGo(() => library.tagBooks(bookIds, tags)),
      tagMany: library.tagMany,
      untagBooks: (bookIds: readonly string[], tag: string) =>
        letGo(() => library.untagBooks(bookIds, tag)),
      adoptTag: (tag: string) => letGo(() => library.adoptTag(tag)),
      undoRemoveTag: () => letGo(() => library.undoRemoveTag()),
      renameTag: (from: string, to: string) => letGo(() => library.renameTag(from, to)),
      removeTag: (tag: string) => letGo(() => library.removeTag(tag)),
      keepJacket: (bookId: string, cover: Blob) => letGo(() => library.keepJacket(bookId, cover), bookId),
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
