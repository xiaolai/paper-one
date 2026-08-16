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
import { extensionFor, readOwnedBook } from './lib/bookVault'
import type { IndexedBook } from './lib/bookIndex'
import type { IndexFs } from './lib/bookIndex'
import type { DirFs } from './lib/importFolder'
import { downscaleCover } from './lib/coverArt'
import { contentPathIn, coverPathIn, folderOf, recordPath } from './lib/bookFolder'
import {
  importFolder,
  summarise,
  type ImportOutcome,
  type ImportProgress,
} from './lib/importFolder'
import { WATCHED_FOLDER_KEY, watchFolder } from './lib/watchedFolder'
import { lookupMetadata } from './lib/metadataLookup'
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
  /**
   * The library's filesystem, or null outside Tauri.
   *
   * Separate from `storage` because they move different things: that one is a
   * JSON store for marks and cards, this one is bytes and directories for the
   * books themselves.
   */
  fs: IndexFs | null
  /** The shelf, read at boot so no frame renders an empty library. */
  initialBooks: readonly IndexedBook[]
}

export function App({ storage, fs, initialBooks }: AppProps) {
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
  const marks = useMarks(book.bookId, fs)
  const cards = useCards(storage)
  const marking = useMarking(book, marks)
  /* The import walks the reader's OWN filesystem, so it needs the absolute
   * directory reader rather than the app-relative one the shelf scan uses. They
   * are different operations and were one name, which is how the shelf came up
   * empty with ten books on disk. */
  const importFs = useMemo(
    () => (fs ? ({ ...fs, readDir: tauriDirOps.readDirOutside } as unknown as DirFs) : null),
    [fs],
  )
  const library = useLibrary(fs, initialBooks)
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
  /**
   * Books the reader took off the shelf while they were open.
   *
   * Intake writes the bytes and then the record, with awaits in between, and a
   * removal landing in that gap used to put the book straight back — the row
   * reappeared as if the click had been ignored. Nothing else can see that: the
   * effect's inputs do not change when a row is removed.
   */
  const removedWhileOpen = useRef(new Set<string>())
  /** Which source the marker above was last cleared for — see the intake effect. */
  const clearedFor = useRef<File | string | null>(null)

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

  const { add, update, remove, positionOf, rekeyBook } = library

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
        if (one.status === 'failed' || !one.bookId || !one.name) continue
        /* Every non-failed outcome, including duplicates. `add` folds into an
         * existing record rather than replacing it, so a book already on the
         * shelf keeps its tags and its place — and a book whose bytes are in the
         * library with no record gets one, which is the case that was invisible
         * forever before. */
        add(one.bookId, {
          /* The FILENAME, until the book is opened. Parsing three hundred books
           * to learn three hundred titles would make importing a folder as slow
           * as reading one, and the record corrects itself on first open. */
          title: one.name.replace(/\.[^.]+$/, ''),
          author: '',
          addedAt: Date.now(),
          /* WITHOUT THIS EVERY IMPORTED PDF IS UNOPENABLE. The bytes go to
           * `content.pdf`, and `openStored` defaults a record with no `ext` to
           * `.epub` — so it looks for a file that is not there. */
          ext: extensionFor(one.name),
          ...(one.path ? { origin: one.path } : {}),
        },
        /* SPARSE — a placeholder, not a parse. Everything above except the
         * extension is a guess from a filename, and `add` folds what it is given
         * in as the book's own account of itself. Without this flag, re-scanning
         * a watched folder on startup overwrote the real title and author of
         * every book in it with `moby-dick-1851` and nothing. */
        true)
      }
    },
    [add],
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
    if (!watched || !importFs) return
    let watcher: { stop: () => void } | null = null
    let stopped = false
    void watchFolder(
      importFs,
      tauriWatchOps,
      watched,
      (outcomes) => {
        // Always shelved; only ANNOUNCED when something new arrived. A watcher
        // that says "0 added" whenever a file is touched is noise, but a book
        // silently missing from the shelf is worse than noise.
        shelveImported(outcomes)
        if (outcomes.some((one) => one.status === 'added')) {
          setImportNotice(summarise(outcomes))
        }
      },
    )
      .then((live) => {
        if (stopped) live.stop()
        else watcher = live
      })
      .catch((cause: unknown) => {
        console.error('Paper: could not watch that folder', cause)
        // Not after cleanup: a rejection from a folder the reader has already
        // replaced would otherwise overwrite the status of the working watcher
        // that succeeded it.
        if (!stopped) setImportNotice('That folder could not be watched.')
      })
    return () => {
      stopped = true
      watcher?.stop()
    }
  }, [watched, shelveImported, importFs])

  /**
   * Open a book the library holds.
   *
   * THREE BRANCHES BECAME ONE. Phase 3 tried the vault, then the reader's
   * original path, then a URL, each with its own failure handling — because a
   * row could name any combination of the three and might be right about none of
   * them. A book is a folder now, so there is exactly one place to look and its
   * name is the book's id.
   *
   * The filename carries the EXTENSION, not the title. `isPdf` routes on it, so
   * handing foliate `Moby-Dick` with no suffix sent every PDF to the wrong
   * reader, which rejects it as an unsupported type.
   */
  const openStored = useCallback(
    (entry: IndexedBook) => {
      if (!fs) return
      const name = `${entry.title || 'book'}.${entry.ext || 'epub'}`
      void readOwnedBook(fs, contentPathIn(entry.bookId, name), name)
        .then((file) => openBook(file, entry.origin ?? null))
        .catch((cause: unknown) => {
          /* FALL BACK TO THE READER'S OWN FILE, which phase 4 deleted too
           * eagerly. "Three branches became one" was true for a book Paper
           * holds — and six of the ten books in a real phase-3 library never
           * had a stored copy, because phase 3 only started keeping them near
           * the end. Migrating those produced a record with no content, and
           * with the path fallback gone they became unopenable.
           *
           * `origin` is kept for provenance, and provenance is exactly what is
           * needed here. It is still a fallback rather than a first choice: it
           * depends on the reader's file being where it was, which is the whole
           * reason Paper keeps its own copy. */
          const original = entry.origin
          if (original) {
            void readBookAt(original)
              .then((file) => openBook(file, original))
              .catch((second: unknown) => {
                console.error('Paper: could not reopen', original, second)
                setImportNotice('That book could not be opened. Try adding it again.')
              })
            return
          }
          /* The folder is there and its content is not, which means an import
           * that did not finish. The record stays — its tags and position are
           * still the reader's — and they are told rather than left clicking
           * something that does nothing. */
          console.error('Paper: could not read the stored book', entry.bookId, cause)
          setImportNotice('That book could not be opened. Try adding it again.')
        })
    },
    [openBook, fs],
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

  /* The open book's row, narrowed to the two fields the effects below depend on.
   *
   * PRIMITIVES rather than the row or the array, so an effect restarts only when
   * the thing it cares about changes. Depending on `library.books` restarted an
   * in-flight cover encode on every position save.
   *
   * `null` and `undefined` are deliberately different here: `undefined` means no
   * row (removed, or not yet recorded) and `null` means a row with nothing
   * attached yet. Collapsing them is what made removing the open book start a
   * cover write for a book that no longer existed. */
  const openRow = bookId ? library.books.find((one) => one.bookId === bookId) : undefined
  /* Whether the library HAS this book, which is the only question left. Phase 3
   * asked two more — where the bytes are and where the jacket is — and kept a
   * field for each; a book is a folder now, so both are derived from its id. */
  const isShelved = Boolean(openRow)


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
    (entry: IndexedBook) => {
      void (async () => {
        const found = await lookupMetadata({ title: entry.title, author: entry.author })
        if (!found) {
          setImportNotice('Nothing found for that book.')
          return
        }
        /* `update`, which no-ops when the book has gone. A lookup is a slow
         * call against a record captured when the reader clicked, so by the time
         * it answers the book may have been removed — and anything that WROTE
         * unconditionally would bring it back. `openedAt` is untouched: a lookup
         * is not a read, and the shelf is ordered by recency. */
        update(entry.bookId, (record) => ({
          ...record,
          ...(found.title ? { title: found.title } : {}),
          ...(found.author ? { author: found.author } : {}),
          ...(found.publisher ? { publisher: found.publisher } : {}),
          ...(found.published ? { published: found.published } : {}),
          ...(found.subjects?.length ? { subjects: found.subjects } : {}),
        }))
        setImportNotice(`Updated from ${found.source}.`)
      })()
    },
    [update],
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
      if (!folder || !importFs) return
      setImporting({ done: 0, total: 0, current: '' })
      try {
        const outcomes = await importFolder(
          importFs,
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
  }, [shelveImported, importFs])


  /**
   * Take a book off the shelf.
   *
   * ONE RENAME, into the trash. Phase 3's removal touched three places — a row,
   * the bytes, the cover — any of which could fail alone, and two of which did.
   * A book is a folder, so removing it is moving that folder.
   *
   * THE PROMISE IS EXACT and unchanged: the file the reader imported is not
   * touched. What moves is Paper's own copy, along with the tags, the position
   * and the marks that live beside it — recoverable, because a trash is a
   * visible directory rather than hidden state, and because re-adding the same
   * bytes lands on the same folder name.
   */
  const removeBook = useCallback(
    (entry: IndexedBook) => {
      removedWhileOpen.current.add(entry.bookId)
      remove(entry.bookId)
    },
    [remove],
  )

  /* Take the book in: its bytes first, THEN its record.
   *
   * ONE EFFECT, and the order inside it is the point. These were two — a record
   * written on parse and a copy written on `isShelved`, which meant the copy
   * waited for the record — so a crash in between left a book on the shelf that
   * Paper had no bytes for. That is the exact state the migration produces and
   * the exact state `canOpen` exists to describe; producing it here as well, on
   * every ordinary open, is not something a derived flag should have to cover.
   *
   * The bytes go in first because a folder holding a book with no record is
   * simply not on the shelf yet — `scanBooks` skips it — and the next open of
   * the same file finishes the job. The reverse is a row that cannot open.
   */
  useEffect(() => {
    if (!bookId || !meta) return
    /* CLEARED FOR THIS BOOK, ONCE PER OPEN.
     *
     * Keyed on the SOURCE, because this effect also runs when the parse lands —
     * and metadata arriving is not the reader asking for the book back. Clearing
     * unconditionally there undid a removal made in the seconds between opening
     * a book and it finishing parsing. A fresh open produces a new `File`, or a
     * different path, so identity is exactly the right test. */
    const freshOpen = clearedFor.current !== source
    if (freshOpen) {
      removedWhileOpen.current.delete(bookId)
      clearedFor.current = source
    }
    let cancelled = false
    void (async () => {
      /* THE IDENTITY MIGRATION FIRST, and awaited, which is the whole reason it
       * lives here rather than in its own effect. `add` below creates the folder
       * for the NEW id, and `rekeyBook` abandons the move when that folder is
       * already there — so run as a separate effect the two raced, and losing
       * the race meant a permanent duplicate row rather than a moved book.
       *
       * A book stored under the previous scheme only. `legacyBookIdFor` returns
       * the same id for everything since, and `rekeyBook` returns immediately
       * when it does. */
      let legacy = bookId
      try {
        if (source) legacy = await legacyBookIdFor(source)
        if (legacy !== bookId && (await rekeyBook(legacy, bookId)) === 'failed') {
          /* STOP. Adding the book under its new id now would create the second
           * folder the move exists to prevent — and every later attempt would
           * then find the destination occupied and give up. Left alone, the book
           * keeps the id it has and the next open tries again. */
          return
        }
      } catch (cause) {
        console.error('Paper: could not check the legacy book id', cause)
      }
      // The legacy id is cleared for a deliberate open too, or a removal made
      // under the old id would block the book under its new one forever.
      if (freshOpen) removedWhileOpen.current.delete(legacy)
      /* THE LEGACY ID COUNTS AS THIS BOOK. `removeBook` records whatever id the
       * ROW carried, which for a book stored under the previous scheme is the
       * legacy one — so checking only the newly computed id meant removing a
       * book while it was still parsing put it back under a different name,
       * with the tags and marks it owned left in the old id's trash entry for
       * the sweep. */
      if (cancelled || removedWhileOpen.current.has(legacy)) return
      if (source instanceof File && fs) {
        try {
          const at = contentPathIn(bookId, source.name)
          /* Checked before the bytes are touched: `arrayBuffer()` copies the
           * whole book into memory, and reopening a 40MB book should not do that
           * to discover it is already here. */
          if (!(await fs.exists(at))) {
            const bytes = new Uint8Array(await source.arrayBuffer())
            await fs.mkdir(folderOf(bookId))
            /* Written to a temporary neighbour and renamed, like every other
             * write here: a crash partway must not leave a truncated
             * `content.epub`, because `exists` would then call it the book. */
            const writing = `${at}.writing`
            try {
              await fs.writeFile(writing, bytes)
              await fs.rename(writing, at)
            } catch (cause) {
              await fs.remove(writing).catch(() => {})
              throw cause
            }
          }
        } catch (cause) {
          /* Reported and not fatal. The record is still written, and the shelf
           * says the copy is missing rather than pretending the open failed. */
          console.error('Paper: could not keep our own copy of the book', cause)
        }
        /* CHECKED AGAIN, because the write above is the long part — a 40MB book
         * off a network volume — and a removal during it leaves the folder that
         * `mkdir` recreated sitting there holding nothing but content.
         *
         * ONLY THE FILE THIS EFFECT WROTE, and only once the record is gone,
         * which is what proves the removal finished and this folder is the shell
         * we made. Removing the DIRECTORY here was catastrophic: lose the race
         * the other way and it deletes the live book — content, record, tags,
         * position and marks — before `trashBook` has moved anything, so there
         * is no copy to recover. A stray file is worth incomparably less than
         * the chance of that. */
        if (
          (removedWhileOpen.current.has(bookId) || removedWhileOpen.current.has(legacy)) &&
          fs &&
          source instanceof File
        ) {
          const at = contentPathIn(bookId, source.name)
          if (!(await fs.exists(recordPath(bookId)))) await fs.remove(at).catch(() => {})
          return
        }
      }
      if (cancelled || removedWhileOpen.current.has(bookId)) return
      /* `add`, which FOLDS a fresh parse into what the reader owns rather than
       * replacing it — see `mergeParsed`. Phase 3 spread the parse over the row
       * and erased the reader's tags on every reopen.
       *
       * `openedAt` is set here because this is the moment a book is opened, and
       * the shelf is ordered by it. */
      add(bookId, {
        title: meta.title,
        author: meta.author,
        openedAt: Date.now(),
        addedAt: Date.now(),
        ...(meta.sortAs ? { sortAs: meta.sortAs } : {}),
        ...(meta.series ? { series: meta.series } : {}),
        ...(meta.seriesIndex === null ? {} : { seriesIndex: meta.seriesIndex }),
        ...(meta.subjects.length ? { subjects: meta.subjects } : {}),
        ...(meta.publisher ? { publisher: meta.publisher } : {}),
        ...(meta.published ? { published: meta.published } : {}),
        ...(meta.languages.length ? { languages: meta.languages } : {}),
        /* NO `description`. It was passed here and dropped on the floor:
         * `BookRecord` has no such field and `parseRecord` discards it, so every
         * write serialised it and every read threw it away. Nothing displays a
         * description yet — when something does, it belongs in the record first
         * and here second. */
        ...(openedPath ? { origin: openedPath } : {}),
        ...(source instanceof File ? { ext: source.name.split('.').pop() ?? '' } : {}),
      })
    })()
    return () => {
      cancelled = true
    }
  }, [bookId, meta, source, add, openedPath, fs, rekeyBook])


  /* File the book's own jacket, once.
   *
   * `cover` arrives as a Blob because the session has no business knowing where
   * covers are kept; this is the layer that does. Downscaled on the way IN — a
   * publisher's jacket is routinely 1600px and the shelf draws it at a couple of
   * hundred, so decoding the full image per cell would do it on every render
   * rather than once ever.
   *
   * Also no attachment step, and for the same reason: `cover.webp` inside the
   * book's folder is a known path, so there is nothing to record and nothing
   * that can go stale.
   */
  useEffect(() => {
    if (!bookId || !cover || !isShelved || !fs) return
    let cancelled = false
    void (async () => {
      try {
        const at = coverPathIn(bookId)
        if (await fs.exists(at)) return
        const small = await downscaleCover(cover)
        if (!small || cancelled) return
        await fs.mkdir(folderOf(bookId))
        await fs.writeFile(at, new Uint8Array(await small.arrayBuffer()))
      } catch (cause) {
        // A book without a picture, not a book that failed. The shelf falls back
        // to the derived tint, which is what it drew for everything before.
        console.error('Paper: could not keep the cover', cause)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bookId, cover, isShelved, fs])

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
  const rememberRef = useRef(update)
  rememberRef.current = update

  const saver = useRef<PositionRecorder | null>(null)
  if (saver.current === null) {
    saver.current = positionRecorder({
      write: (id, at, fraction) =>
        rememberRef.current(id, (record) =>
          record.position === at && record.progress === fraction
            ? record
            : { ...record, position: at, progress: Math.min(1, Math.max(0, fraction)) },
        ),
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
  useEffect(() => {
    if (!bookId || !source) return
    let live = true
    void legacyBookIdFor(source)
      .then((legacy) => {
        if (!live || legacy === bookId) return
        rekeyMarks(legacy, bookId)
        rekeyCards(legacy, bookId)
        /* The LIBRARY is rekeyed by the intake effect above, not here, because
         * it has to happen BEFORE the book is added under its new id and this
         * effect cannot promise that. Marks and cards have no such constraint:
         * they merge rather than rename, so arriving late costs nothing. */
      })
      .catch((cause: unknown) => {
        console.error('Paper: could not check the legacy book id', cause)
      })
    return () => {
      live = false
    }
  }, [bookId, source, rekeyMarks, rekeyCards])

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
          libraryCount={library.books.length}
          onOpenLibrary={() => dispatch({ type: 'goScreen', screen: 'library' })}
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
            onTag={library.tag}
            onUntag={library.untag}
            onSetFinished={(bookId, finished) =>
              update(bookId, (record) => ({ ...record, finished }))
            }
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
