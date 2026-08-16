import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildCommands } from './lib/commands'
import { PANE_SHORTCUTS } from './lib/panes'
import { DEFAULT_STEP_IDX, applyMetrics } from './lib/metrics'
import { pickBooks, pickFolder, readBookAt, tauriDirOps, tauriWatchOps } from './lib/bookFiles'
import { legacyBookIdFor } from './lib/idMigration'
import { positionRecorder, type PositionRecorder } from './lib/positionRecorder'
import { usePlatform, usePrefersDark, usePrefersReducedMotion } from './lib/platform'
import { NOT_CONFIGURED } from './lib/companion'
import { hasOpenLayer, useAppState } from './lib/state'
import type { MarkStorage } from './lib/marks'
import { useBook } from './lib/useBook'
import { useFileDrop } from './lib/useFileDrop'
import { useLibrary } from './lib/useLibrary'
import { useCards } from './lib/useCards'
import { useMarks } from './lib/useMarks'
import { useMarking } from './lib/useMarking'
import { coverTintFor } from './lib/bookAccent'
import { disownBook, ownBook, readOwnedBook, tauriVaultFs } from './lib/bookVault'
import type { LibraryEntry } from './lib/library'
import { useCollections } from './lib/useCollections'
import { saveCover } from './lib/coverArt'
import {
  importFolder,
  summarise,
  type ImportOutcome,
  type ImportProgress,
} from './lib/importFolder'
import { WATCHED_FOLDER_KEY, watchFolder } from './lib/watchedFolder'
import { lookupMetadata } from './lib/metadataLookup'
import { inTauri } from './lib/appStorage'
import { BookSwitcher } from './overlays/BookSwitcher'
import { CommandPalette } from './overlays/CommandPalette'
import { TitleBar } from './shell/TitleBar'
import { WindowShell } from './shell/WindowShell'
import { Library } from './screens/Library'
import { Reader } from './screens/Reader'
import { SidePane } from './pane/SidePane'
import { useSpeech } from './reader/useSpeech'

export interface AppProps {
  /**
   * Where the reader's marks, cards and library live.
   *
   * Injected rather than reached for, because it is resolved asynchronously
   * before the first render — see `main.tsx` — and because the three stores
   * below already take a storage argument for exactly this reason.
   */
  storage: MarkStorage | null
}

export function App({ storage }: AppProps) {
  const platform = usePlatform()
  const prefersDark = usePrefersDark()
  /* The one thing that can stop a page turn sliding. Not a setting — see the
   * hook, which explains why there is deliberately no control for it. */
  const reducedMotion = usePrefersReducedMotion()
  const [state, dispatch] = useAppState()
  /* The open book lives here, not in the reader: Contents and Companion read
   * from it and they are panels of the side pane now. */
  const book = useBook()
  /* Marks outlive the open book — the Notes panel browses every book's — so the
   * store is keyed by book rather than owned by one. */
  const marks = useMarks(book.bookId, storage)
  const cards = useCards(storage)
  const marking = useMarking(book, marks)
  const library = useLibrary(storage)
  /* Reading aloud follows the spine document: an utterance outlives a section,
   * and would otherwise go on reading words that are no longer on screen. */
  const speech = useSpeech(book.doc)

  /* One file picker for the window. The reader's empty state, the palette and
   * the switcher all ask for books, and one input serves all three rather than
   * each surface growing its own. */
  /* Where the open book lives on THIS machine, when it was opened from disk.
   *
   * Held beside the book rather than inside it: everything downstream takes a
   * `File`, and neither foliate nor `bookIdFor` has any business knowing about
   * the filesystem. It is written onto the library row so the shelf can open
   * the book again — which is the whole point, and what a `File` could never
   * support, since it is a handle to bytes granted for one session. */
  const [openedPath, setOpenedPath] = useState<string | null>(null)

  /**
   * Open a book AND go to it.
   *
   * Every route in — a drop on the window, the switcher, the picker, a cover on
   * the shelf — goes through here. Only the shelf used to switch screens, so a
   * book opened any other way loaded into a reader the library was still
   * covering: the shelf sat there unchanged while the book it had been asked
   * for finished loading out of sight, which reads as the click having done
   * nothing at all.
   */
  const openBook = useCallback(
    (source: File | string, path: string | null = null) => {
      dispatch({ type: 'goScreen', screen: 'reader' })
      // Set before the open, so the record effect below cannot fire on the new
      // book while this still holds the previous one's path.
      setOpenedPath(path)
      book.open(source)
    },
    [book, dispatch],
  )

  /** The native picker. Returns paths, which is the entire difference. */
  const addBooks = useCallback(() => {
    void pickBooks()
      .then((picked) => {
        for (const { file, path } of picked) openBook(file, path)
      })
      .catch((cause: unknown) => {
        console.error('Paper: the book picker failed', cause)
      })
  }, [openBook])

  const { record, remember, rememberOwned, rememberJacket, forget, positionOf } = library
  const collections = useCollections(storage)

  /**
   * Put what an import produced onto the shelf.
   *
   * ONE function, called by both the manual import and the watched folder. The
   * watcher had no equivalent at all: it copied books into the vault and updated
   * a notice, so a folder being watched filled the vault and never the shelf —
   * the books were there and invisible.
   */
  const shelveImported = useCallback(
    (outcomes: readonly ImportOutcome[]) => {
      for (const one of outcomes) {
        if (one.status !== 'added' || !one.bookId || !one.name) continue
        record({
          bookId: one.bookId,
          /* The FILENAME, until the book is opened. Parsing every book to learn
           * its title would make importing a folder as slow as reading one, and
           * the row corrects itself on first open. */
          title: one.name.replace(/\.[^.]+$/, ''),
          author: '',
          url: null,
          lastOpened: Date.now(),
          position: null,
          workId: null,
          path: one.path,
          // The path the VAULT chose. Rebuilding it from the filename recorded a
          // `.EPUB` that is not on disk, because `extensionFor` lowercases.
          ...(one.vault ? { vault: one.vault } : {}),
        })
      }
    },
    [library],
  )

  /**
   * The watched folder — one, not a list.
   *
   * A reader with books in five places wants those books imported, not five
   * watchers running; and the second folder is what turns a setting into a
   * management screen. It becomes a list when somebody actually has two.
   */
  const [watched, setWatched] = useState<string | null>(() => {
    try {
      return storage?.getItem(WATCHED_FOLDER_KEY) || null
    } catch {
      return null
    }
  })

  const connectFolder = useCallback(() => {
    void (async () => {
      const folder = await pickFolder().catch(() => null)
      if (!folder) return
      try {
        storage?.setItem(WATCHED_FOLDER_KEY, folder)
      } catch {
        // A watch that cannot be remembered still works for this session.
      }
      setWatched(folder)
    })()
  }, [storage])

  const disconnectFolder = useCallback(() => {
    try {
      /* Written EMPTY rather than removed: `MarkStorage` has `getItem`/`setItem`
       * and no `removeItem`, and widening that interface for one caller means
       * changing every implementation of it — including the file-backed store
       * and the localStorage fallback. An empty string is read back as absent by
       * the initialiser above, which is the same outcome for less surface. */
      storage?.setItem(WATCHED_FOLDER_KEY, '')
    } catch {
      // Nothing to do: the state below is what stops the watcher either way.
    }
    setWatched(null)
  }, [storage])

  /* The watcher itself. Torn down and rebuilt when the folder changes, which is
   * rare — and it must be torn down, or connecting a second folder leaves the
   * first one importing forever with nothing referring to it. */
  useEffect(() => {
    if (!watched || !inTauri()) return
    let watcher: { stop: () => void } | null = null
    let stopped = false
    void watchFolder(
      { ...tauriVaultFs, ...tauriDirOps },
      tauriWatchOps,
      watched,
      (outcomes) => {
        shelveImported(outcomes)
        setImportNotice(summarise(outcomes))
      },
    )
      .then((live) => {
        if (stopped) live.stop()
        else watcher = live
      })
      .catch((cause: unknown) => {
        console.error('Paper: could not watch that folder', cause)
        setImportNotice('That folder could not be watched.')
      })
    return () => {
      stopped = true
      watcher?.stop()
    }
  }, [watched, shelveImported])

  /** Reopen a book the shelf knows the location of. */
  const openStored = useCallback(
    (entry: { url: string | null; path: string | null; vault?: string | null; title?: string }) => {
      /* Paper's own copy FIRST, and the reader's original only as a fallback.
       *
       * The copy is under `$APPDATA`, which is in scope permanently, so this
       * path does not depend on a dialog grant having been restored. The
       * original is tried after it for books shelved before the vault existed —
       * they are copied in on this open, by the effect below. */
      if (entry.vault) {
        const at = entry.vault
        /* The name must carry an EXTENSION, and a title does not. `isPdf` routes
         * on it, so `readOwnedBook(..., 'Moby-Dick')` sent every PDF to foliate,
         * which rejects it as an unsupported type. The vault path always has the
         * right extension because `vaultPath` put it there. */
        const named = `${entry.title || 'book'}.${at.slice(at.lastIndexOf('.') + 1)}`
        void readOwnedBook(tauriVaultFs, at, named)
          .then((file) => openBook(file, entry.path ?? null))
          .catch((cause: unknown) => {
            console.error('Paper: could not read our own copy', at, cause)
            const original = entry.path
            if (!original) return
            /* CAUGHT, because the fallback can fail too. Without this a book
             * whose vault copy is missing AND whose original has moved produced
             * an unhandled rejection at the window rather than a message. */
            void readBookAt(original)
              .then((file) => openBook(file, original))
              .catch((second: unknown) => {
                console.error('Paper: could not reopen', original, second)
              })
          })
        return
      }
      if (entry.path) {
        const at = entry.path
        void readBookAt(at)
          .then((file) => openBook(file, at))
          .catch((cause: unknown) => {
            // Moved, renamed, on an unmounted volume. The row stays; the reader
            // is told rather than left clicking something that does nothing.
            console.error('Paper: could not reopen', at, cause)
          })
        return
      }
      if (entry.url) openBook(entry.url)
    },
    [openBook],
  )

  /* Window-wide, not just over the empty state. A file dropped anywhere the
   * app does not intercept NAVIGATES the webview to it — the interface is
   * replaced by WebKit's PDF viewer with no error and no way back. */
  const { dragging } = useFileDrop(openBook)

  useEffect(() => {
    applyMetrics(document.documentElement, platform)
  }, [platform])

  /* §05: the system follows the OS by default, with an explicit override in
   * Settings. Night is the dark surface; Paper is the light default. */
  useEffect(() => {
    if (!state.themeFollowsOs) return
    dispatch({ type: 'setTheme', theme: prefersDark ? 'night' : 'paper', fromOs: true })
  }, [prefersDark, state.themeFollowsOs, dispatch])

  /* Remember every book that opens, so the switcher lists what this reader has
   * actually read rather than a fixture shelf. Keyed on the metadata arriving,
   * because that is when there is a title worth showing. */
  const { bookId, meta, source, cover } = book

  /**
   * Ask Open Library about one book — Decision 1's only network call.
   *
   * Explicit, per book, and never on import. What comes back is applied to the
   * row rather than shown as a dialog to approve: the control is only offered
   * on a book that is MISSING an author, so there is nothing of the reader's to
   * overwrite and a confirmation would be ceremony over an empty field.
   *
   * A failure of any kind — offline, no match, a shape that was not expected —
   * says one thing, because from here they are one thing.
   */
  const lookUp = useCallback(
    (entry: LibraryEntry) => {
      void (async () => {
        const found = await lookupMetadata({ title: entry.title, author: entry.author })
        if (!found) {
          setImportNotice('Nothing found for that book.')
          return
        }
        /* `applyFound`, not `record`. A lookup is a slow call against a row
         * captured when the reader clicked: `recordOpen` would RECREATE a book
         * removed in the meantime, revert one changed since, and move it to the
         * top of a shelf ordered by recency. This patches by id and no-ops when
         * the book has gone. */
        library.applyFound(entry.bookId, found)
        setImportNotice(`Updated from ${found.source}.`)
      })()
    },
    [library],
  )


  /**
   * Add a whole folder.
   *
   * The books are copied into the vault and the shelf fills from what landed —
   * NOT by opening each one, which would mean parsing three hundred books to
   * learn three hundred titles. A row appears with the filename and gains its
   * real metadata and cover the first time it is actually read.
   *
   * Progress is reported per book rather than as a spinner, and failures are
   * named individually: "4 of 300 failed" tells a reader nothing they can act
   * on.
   */
  const [importing, setImporting] = useState<ImportProgress | null>(null)
  const [importNotice, setImportNotice] = useState<string | null>(null)
  const addFolder = useCallback(() => {
    void (async () => {
      const folder = await pickFolder().catch(() => null)
      if (!folder) return
      setImporting({ done: 0, total: 0, current: '' })
      try {
        const outcomes = await importFolder(
          { ...tauriVaultFs, ...tauriDirOps },
          folder,
          { onProgress: setImporting },
        )
        shelveImported(outcomes)
        setImportNotice(summarise(outcomes))
      } catch (cause) {
        console.error('Paper: the folder import failed', cause)
        setImportNotice('That folder could not be imported.')
      } finally {
        setImporting(null)
      }
    })()
  }, [record])


  /**
   * Take a book off the shelf, and give up our copy of it.
   *
   * TWO FILES, ONE OF THEM OURS. The row goes and Paper's copy under `$APPDATA`
   * is deleted; the reader's own file, wherever they keep it, is not touched.
   * That distinction only became expressible once the vault existed — before it
   * there was one file and it belonged to the reader, so "remove" could not be
   * offered honestly at all.
   *
   * The row goes FIRST and the copy after. The shelf is what the reader is
   * looking at, and a removal that waits on a disk operation to redraw feels
   * broken; a copy that fails to delete is wasted disk, not a wrong answer.
   *
   * Marks and reading position survive on purpose — they are keyed by content,
   * so adding the book again finds them waiting.
   */
  const removeBook = useCallback(
    (entry: LibraryEntry) => {
      forget(entry.bookId)
      if (entry.vault && inTauri()) void disownBook(tauriVaultFs, entry.vault)
      if (entry.cover && inTauri()) void disownBook(tauriVaultFs, entry.cover)
    },
    [forget],
  )

  useEffect(() => {
    if (!bookId || !meta) return
    record({
      bookId,
      title: meta.title,
      author: meta.author,
      // A File cannot be reopened later — there is no path to keep — so only a
      // URL source records one. The switcher shows the difference.
      url: typeof source === 'string' ? source : null,
      lastOpened: Date.now(),
      // An open knows nothing about where the reader will be. `recordOpen`
      // carries the saved position through rather than letting this erase it.
      position: null,
      // The work's own identifier, when the book declares one. Nothing reads it
      // yet; it is captured here because recovering it later means re-opening
      // every book on the shelf.
      workId: meta.identifier || null,
      // Device-local. `recordOpen` carries a known path through an open that
      // does not have one, so a drop or a URL cannot erase it.
      path: openedPath,
      /* What the book says about itself, kept rather than discarded.
       *
       * foliate parses every one of these on every open and Paper narrowed them
       * away between the parse and the row, so a shelf that could have sorted by
       * series and filtered by subject had title and author to work with. All of
       * it is capped in `readMeta` — this is a stranger's file. */
      sortAs: meta.sortAs,
      series: meta.series,
      seriesIndex: meta.seriesIndex,
      subjects: meta.subjects,
      publisher: meta.publisher,
      published: meta.published,
      languages: meta.languages,
      description: meta.description,
    })
  }, [bookId, meta, source, record, openedPath])

  /* Take our own copy of the book, so the shelf stops depending on someone
   * else's filesystem.
   *
   * Runs after the record effect above rather than inside it: the copy is
   * asynchronous and the row has to exist before there is anything to attach a
   * vault path to. It is also how a book shelved BEFORE the vault existed gets
   * one — there is no migration sweep at startup, because that would turn a cold
   * launch into a disk copy of the whole library. A book is copied the next time
   * it is opened, and never again after that.
   *
   * Silent on failure by design. A copy that does not land leaves the row
   * pointing at the reader's own file, which is exactly where it pointed before
   * this existed; telling someone their book opened but was not filed away is
   * noise about a fallback that worked.
   */
  useEffect(() => {
    if (!bookId || !meta || !inTauri()) return
    if (!(source instanceof File)) return
    let cancelled = false
    void (async () => {
      try {
        const bytes = new Uint8Array(await source.arrayBuffer())
        const entry = await ownBook(tauriVaultFs, bookId, source.name, bytes)
        if (!cancelled) rememberOwned(bookId, entry.path)
      } catch (cause) {
        console.error('Paper: could not keep our own copy of the book', cause)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bookId, meta, source, rememberOwned])

  /* File the book's own jacket, once.
   *
   * `cover` arrives as a Blob because the session has no business knowing where
   * covers are kept; this is the layer that does. It is downscaled on the way in
   * rather than on the way out — a publisher's jacket is routinely 1600px wide
   * and the shelf draws it at a couple of hundred, and decoding the full image
   * per cell would do that on every render rather than once ever.
   *
   * Only when the row does not already have one. A book reopened weekly should
   * not re-encode its cover weekly.
   */
  useEffect(() => {
    if (!bookId || !cover || !inTauri()) return
    if (library.books.find((b) => b.bookId === bookId)?.cover) return
    let cancelled = false
    void (async () => {
      try {
        const at = await saveCover(tauriVaultFs, bookId, { getCover: async () => cover })
        if (at && !cancelled) rememberJacket(bookId, at)
      } catch (cause) {
        // A book without a picture, not a book that failed. The shelf falls
        // back to the derived tint, which is what it drew for everything before.
        console.error('Paper: could not keep the cover', cause)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bookId, cover, library.books, rememberJacket])

  /* Remember where the reader is, so the next open starts there.
   *
   * The recorder owns the "not on every page turn" rules — see its own file.
   * Everything here is about the moments a position stops being reachable and
   * must be written before it is: the window going away, and this component
   * coming apart. `pagehide` rather than `unload`, which WebKit does not fire
   * reliably; `visibilitychange` catches the app being hidden without closing,
   * which on macOS is most of how an app is left. */
  /* Through a ref, not closed over. The recorder is built once and outlives
   * every render, so capturing `remember` directly would pin whichever one this
   * component first rendered with — the exact staleness FoliateView's handler
   * refs exist to prevent. It happens to be stable today; that is a property of
   * `useLibrary` this file must not depend on silently. */
  const rememberRef = useRef(remember)
  rememberRef.current = remember

  const saver = useRef<PositionRecorder | null>(null)
  if (saver.current === null) {
    saver.current = positionRecorder({
      write: (id, at, fraction) => rememberRef.current(id, at, fraction),
    })
  }

  useEffect(() => {
    const recorder = saver.current
    if (!recorder) return
    const flush = () => recorder.flush()
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHidden)
      // In that order: whatever is outstanding is written, and only then is the
      // timer that would have written it dropped.
      recorder.flush()
      recorder.stop()
    }
  }, [])

  const { cfi, fraction } = book.position
  useEffect(() => {
    /* The fraction travels WITH the CFI, on the same throttled write. Saving it
     * separately would put a progress bar and the position it describes on two
     * different cadences, and they would disagree for as long as the reader kept
     * reading. */
    saver.current?.record(bookId, cfi, fraction)
  }, [bookId, cfi, fraction])

  /* Carry a reader's existing work across the change of book identity.
   *
   * `bookIdFor` now hashes content rather than a file's ends, and reads a URL
   * rather than trusting its address — so everything already stored is filed
   * under an id nothing will compute again. The old id cannot be derived from
   * the new one, only recomputed from the same source, which is why this runs
   * on open rather than at load and why a book never reopened keeps its rows
   * under the legacy id until it is.
   *
   * Every store returns its collection unchanged when there is nothing to move,
   * so all but the first open of each book costs one comparison.
   */
  const { rekey: rekeyMarks } = marks
  const { rekey: rekeyCards } = cards
  const { rekey: rekeyLibrary } = library
  useEffect(() => {
    if (!bookId || !source) return
    let live = true
    void legacyBookIdFor(source)
      .then((legacy) => {
        if (!live || legacy === bookId) return
        rekeyMarks(legacy, bookId)
        rekeyCards(legacy, bookId)
        rekeyLibrary(legacy, bookId)
      })
      .catch((cause: unknown) => {
        // Nothing is lost by failing — the rows stay under the old id and the
        // next open tries again. Silence would make a migration that never
        // runs look like a reader who never had any marks.
        console.error('Paper: could not migrate this book\'s earlier marks', cause)
      })
    return () => {
      live = false
    }
  }, [bookId, source, rekeyMarks, rekeyCards, rekeyLibrary])

  const commands = useMemo(
    () =>
      buildCommands({
        state,
        dispatch,
        hasBook: book.source !== null,
        // Null when nothing is selected, so the palette simply does not offer
        // a command that could not do anything.
        markSelection: marking.selection ? () => marking.mark('') : null,
        openBookPicker: addBooks,
        closeBook: () => book.close(),
        openSwitcher: () => dispatch({ type: 'toggleLayer', layer: 'switcherOpen' }),
      }),
    [state, dispatch, book, marking, addBooks],
  )

  /* §11's keyboard map. Every combo the design publishes is bound here, and
   * nothing is bound to a layer that does not exist — ⌘K used to be left
   * deliberately unbound for exactly that reason, and now has a palette. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dispatch({ type: 'dismissTop' })
        return
      }

      const overlayOpen = hasOpenLayer(state)

      /* Typing comes first. The search field, a note, and the palette all take
       * arrow keys and a space bar, and turning the page underneath someone
       * mid-word is worse than not binding the key at all. */
      const target = event.target as HTMLElement | null
      const typing =
        target?.isContentEditable ||
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA'

      /* The accelerator is ⌘ on macOS and Ctrl elsewhere — not either, anywhere.
       *
       * Accepting both meant Control-D, Control-K and Control-\ were swallowed
       * on macOS, where they are the system's own text-editing keys: Control-D
       * deletes forward and Control-K kills to end of line, in every text field
       * in the app. It also meant the combos the palette PRINTS were wrong on
       * one platform or the other, since those always read ⌘. */
      const accel = platform === 'macos' ? event.metaKey : event.ctrlKey

      /* Reading keys belong to the reader.
       *
       * Guarded on the screen and on the modal layers, because the reader stays
       * MOUNTED under the library and under every overlay — see the note at its
       * render. Without the guard, an arrow key pressed while browsing the
       * shelf, or with the palette open, turned pages in a book nobody could
       * see, and the reader came back to a different place than they left. */
      const reading = state.screen !== 'library' && !overlayOpen

      /* §11: ← → turn the page. Unbound until now, which went unnoticed
       * because a scrolled EPUB scrolls — but a fixed-layout book, which is
       * every PDF, does not scroll at all. These were its only way through and
       * it had none, so it opened on one page and stayed there. */
      if (!accel && !typing && reading) {
        /* Shift+arrow is a SELECTION, not a page turn — the platform meaning of
         * the combo in every text surface there is. Without this guard the page
         * turned instead, which also made the paginator's keyboard-selection
         * branch unreachable: it extends the selection on the same keydown this
         * handler was consuming first. Space handles its own shift below, where
         * ⇧Space is the published binding for the previous page. */
        const selecting = event.shiftKey

        if (!selecting && (event.key === 'ArrowRight' || event.key === 'PageDown')) {
          event.preventDefault()
          book.next()
          return
        }
        if (!selecting && (event.key === 'ArrowLeft' || event.key === 'PageUp')) {
          event.preventDefault()
          book.prev()
          return
        }

        /* §11: Space moves on by one screen, ⇧Space back by one.
         *
         * In BOTH flows, which this used to refuse. It returned early unless
         * the book was paginated, on the stated grounds that "with the ruler
         * off, Space is the scroll the reader expects and nothing here should
         * take it" — and there is no such scroll. foliate's scroller is a
         * `#container` div inside the paginator's SHADOW ROOT, styled
         * `overflow: auto` only at `:host([flow="scrolled"])`; the book's own
         * iframe is `overflow: hidden` and does not scroll. So with focus in
         * the book — which is where it is while reading — Space reached a
         * document with nothing to scroll and a container that never had
         * focus, and both Space and ⇧Space did nothing at all. Reported
         * against ⇧Space; plain Space was equally dead.
         *
         * `next`/`prev` are the right call in both flows rather than a special
         * case for one: the paginator's own `#scrollNext` branches on
         * `this.scrolled` and scrolls by a viewport there, turning a page here.
         *
         * The ruler still wins when it is on. It pins and advances a single
         * line — §06 — and marks the event handled from its own window
         * listener, which React registers before this one because a child's
         * effects run before its parent's. That is what `defaultPrevented`
         * below is reading, and it is the whole reason this can be flow-blind. */
        if ((event.key === ' ' || event.code === 'Space') && !event.defaultPrevented) {
          event.preventDefault()
          if (event.shiftKey) book.prev()
          else book.next()
          return
        }
      }

      if (!accel) return

      if (event.key === 'k') {
        event.preventDefault()
        dispatch({ type: 'toggleLayer', layer: 'paletteOpen' })
        return
      }
      if (event.key === '\\') {
        event.preventDefault()
        dispatch({ type: 'togglePane' })
        return
      }
      if (event.key === 'd') {
        // Only when there is a selection to mark; otherwise ⌘D stays the
        // browser's own, rather than being swallowed to do nothing.
        if (!marking.selection) return
        event.preventDefault()
        marking.mark('')
        return
      }
      /* §09's reading sizes, on the combo every reader already knows.
       *
       * Both spellings of each key, because the shifted and unshifted forms
       * arrive as different `key` values: ⌘+ on a US layout is ⌘⇧= and reports
       * '+', while ⌘= reports '='. Binding one of the pair gives a shortcut
       * that works or not depending on whether the reader held shift.
       *
       * The reducer clamps, so pressing on at either end of the ramp is a
       * no-op rather than something to guard here. */
      if (event.key === '=' || event.key === '+') {
        event.preventDefault()
        dispatch({ type: 'setStepIdx', idx: state.stepIdx + 1 })
        return
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        dispatch({ type: 'setStepIdx', idx: state.stepIdx - 1 })
        return
      }
      if (event.key === '0') {
        event.preventDefault()
        dispatch({ type: 'setStepIdx', idx: DEFAULT_STEP_IDX })
        return
      }

      const shortcut = PANE_SHORTCUTS.find((entry) => entry.digit === event.key)
      if (shortcut) {
        event.preventDefault()
        dispatch({ type: 'openPane', pane: shortcut.pane })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    dispatch,
    marking,
    book,
    platform,
    state.screen,
    state.paletteOpen,
    state.switcherOpen,
    state.stepIdx,
  ])

  /* Titlebar metadata comes from the OPEN book, and from nothing else.
   *
   * It used to read BOOKS[0] unconditionally, so every book was presented as
   * Moby-Dick; that was fixed for the open case and left in place for the
   * empty one, where it was the same lie in a quieter voice — the titlebar
   * named a book with a chapter position while the window behind it said the
   * library was empty. With nothing open the chip says so. */
  const title = book.meta?.title || (book.source ? 'Untitled' : 'Paper')
  const subtitle = book.source ? book.position.chapterLabel || book.meta?.author || '' : ''

  return (
    <>
      <WindowShell
        state={state}
        platform={platform}
        titleBar={
          <TitleBar
            state={state}
            dispatch={dispatch}
            platform={platform}
            bookTitle={title}
            bookSubtitle={subtitle}
            // The same tint the shelf gives this book, so the chip and the cover agree.
            coverTint={coverTintFor(book.bookId ?? '')}
            speech={speech}
            hasBook={book.source !== null}
          />
        }
        overlays={
          <>
            {state.paletteOpen && (
              <CommandPalette
                commands={commands}
                platform={platform}
                onDismiss={() => dispatch({ type: 'closeLayer', layer: 'paletteOpen' })}
                /* The companion has no model configured, so an unmatched query
                 * goes to the panel that says so rather than being answered.
                 * §13 forbids producing content about the book that is not
                 * grounded in it. */
                onAsk={() => dispatch({ type: 'openPane', pane: 'companion' })}
              />
            )}
            {state.switcherOpen && (
              <BookSwitcher
                books={library.books}
                currentBookId={book.bookId}
                onOpen={(entry) => {
                  dispatch({ type: 'closeLayer', layer: 'switcherOpen' })
                  openStored(entry)
                }}
                onDismiss={() => dispatch({ type: 'closeLayer', layer: 'switcherOpen' })}
                onAddBooks={addBooks}
              />
            )}
          </>
        }
        pane={
          <SidePane
            state={state}
            dispatch={dispatch}
            book={book}
            marks={marks}
            cards={cards}
            onGoTo={book.goTo}
            onDeleteMark={marking.unmark}
            markFocus={marking.focus}
            /* The one place the app decides what the companion is. There is no
               provider in this build — see `lib/companion` — and this is the
               line that changes when there is. */
            companion={NOT_CONFIGURED}
            onAddBooks={addBooks}
          />
        }
        onDismissPane={() => dispatch({ type: 'closePane' })}
      >
        {/* The reader stays mounted under every screen. Unmounting it tears
            foliate down mid-flight and loses the reading position — see the
            note on Library's own stacking. */}
        <Reader
          state={state}
          dispatch={dispatch}
          platform={platform}
          book={book}
          marks={marks}
          marking={marking}
          /* Read at every render and consumed once, when the book finishes
             parsing. It is null for the first few milliseconds of an open —
             `bookId` is derived from the file's content — which is why the
             reader takes it through a ref rather than at mount. */
          lastLocation={positionOf(bookId)}
          reducedMotion={reducedMotion}
          onAddBooks={addBooks}
          dragging={dragging}
          inert={state.screen === 'library'}
        />

        {state.screen === 'library' && (
          <Library
            books={library.books}
            platform={platform}
            // Opening from the library takes you to what you opened. Staying
            // on the shelf with a book loading behind it is the one thing a
            // reader does not want from a click on a cover.
            onOpen={openStored}
            onRemove={removeBook}
            collections={collections.all}
            onSaveCollection={collections.save}
            onRemoveCollection={collections.remove}
            onTag={library.tag}
            onUntag={library.untag}
            onSetFinished={library.setFinished}
            onLookUp={lookUp}
            onAddFolder={addFolder}
            importing={importing}
            importNotice={importNotice}
            watchedFolder={watched}
            onConnectFolder={connectFolder}
            onDisconnectFolder={disconnectFolder}
            onAddBooks={addBooks}
          />
        )}
      </WindowShell>

    </>
  )
}
