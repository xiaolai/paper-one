import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildCommands } from './lib/commands'
import { offeredFaces } from './lib/typefaces'
import { presentFaces } from './lib/fontProbe'
import { PANE_SHORTCUTS } from './lib/panes'
import { DEFAULT_STEP_IDX, applyMetrics } from './lib/metrics'
import { importFs as tauriImportFs, pickBooks, pickFolder, readBookAt } from './lib/bookFiles'
import { positionRecorder, type PositionRecorder } from './lib/positionRecorder'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri, usePlatform, usePrefersDark, usePrefersReducedMotion } from './lib/platform'
import { NOT_CONFIGURED } from './lib/companion'
import { hasOpenLayer, paneFits, useAppState } from './lib/state'
import { loadSettings, useSettings } from './lib/useSettings'
import type { MarkStorage } from './lib/marks'
import { useBook } from './lib/useBook'
import { useBookIntake } from './lib/useBookIntake'
import { useEnrichment } from './lib/useEnrichment'
import { flushBeforeClose, onBeforeClose } from './lib/beforeClose'
import { writeQueue } from './lib/writeQueue'
import { useFileDrop, type DropHaul } from './lib/useFileDrop'
import { useLibrary } from './lib/useLibrary'
import { useCards } from './lib/useCards'
import { useMarks } from './lib/useMarks'
import { useMarking } from './lib/useMarking'
import { extensionFor, readOwnedBook, storedBookName } from './lib/bookVault'
import type { IndexedBook } from './lib/bookIndex'
import type { IndexFs } from './lib/bookIndex'
import { contentPathIn, readBook } from './lib/bookFolder'
import {
  MAX_FILES,
  importFolder,
  keepOwnCopy,
  summarise,
  type ImportOutcome,
  type ImportProgress,
} from './lib/importFolder'
import { BookSwitcher } from './overlays/BookSwitcher'
import { CommandPalette } from './overlays/CommandPalette'
import { OverlaySheet } from './overlays/OverlaySheet'
import { TitleBar } from './shell/TitleBar'
import { WindowShell } from './shell/WindowShell'
import { Library } from './screens/Library'
import { Reader } from './screens/Reader'
import { TagEditor } from './screens/TagEditor'
import { tagCounts } from './lib/library'
import { SidePane } from './pane/SidePane'
import { parseBook } from './reader/parseBook'
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
  /**
   * The shelf could not be READ, which is not the same as having no books.
   *
   * `loadShelf` failing used to hand back an empty list, and the reader was told
   * their library was empty while it sat on disk. The two states look identical
   * from here, so the one that is alarming and wrong has to be labelled at the
   * only place that can tell them apart.
   */
  shelfUnread?: boolean
}

export function App({ storage, fs, initialBooks, shelfUnread = false }: AppProps) {
  const platform = usePlatform()
  /* Probed once for the app's lifetime: which fonts this machine has cannot
     change while it is running. Shared by the settings panel and the palette so
     the two cannot come to offer different lists. */
  const offeredHere = useMemo(() => offeredFaces(presentFaces()), [])
  const prefersDark = usePrefersDark()
  /* The one thing that can stop a page turn sliding. Not a setting — see the
   * hook, which explains why there is deliberately no control for it. */
  const reducedMotion = usePrefersReducedMotion()
  /* THE READER'S OWN SETTINGS, read before the first render. `storage` is
     already awaited in `main.tsx`, so the theme and type size a reader chose
     are what the first paint uses rather than something an effect corrects a
     frame later. */
  const [state, dispatch] = useAppState(loadSettings(storage))
  /* The open book lives here, not in the reader: Contents and Companion read
   * from it and they are panels of the side pane now. */
  /* And written back whenever they move. See `useSettings` for why this is a
     comparison rather than a write on every state change. */
  useSettings(storage, state)
  const book = useBook()
  /* Marks outlive the open book — the Notes panel browses every book's — so the
   * store is keyed by book rather than owned by one. */
  /**
   * ONE QUEUE for everything written to a book's folder.
   *
   * Both stores had their own, so a write to `book.json` could not see a write
   * to `marks.json` beside it — and there is nothing to wait for at the moment
   * that matters most, which is the window closing. One queue keyed by book
   * makes those writes serial and gives the close something to hold for.
   */
  /* Lazily, through useState's initializer — `useRef(writeQueue())` evaluated
   * its argument on every render and kept only the first result, so every
   * position-driven render built a queue object just to drop it. The state
   * setter is never used; the initializer's run-once guarantee is the point. */
  const [initialWrites] = useState(writeQueue)
  const writes = useRef(initialWrites)
  const marks = useMarks(book.bookId, fs, writes.current)
  const cards = useCards(storage)
  const marking = useMarking(book, marks)
  /* The import walks the reader's OWN filesystem, so it needs the absolute
   * directory reader rather than the app-relative one the shelf scan uses. They
   * are different operations and were one name, which is how the shelf came up
   * empty with ten books on disk. */
  /* NAMED, not assembled here. The library's filesystem and an import's differ
   * in exactly one member — whether `readDir` walks the app's data directory or
   * the reader's own disk — and building the second out of the first at the call
   * site is what let an `as unknown as DirFs` assert a `readOutside` that was
   * never there. Both are declared in `bookFiles`, where the difference can be
   * stated once. */
  const importFs = useMemo(
    () => (fs ? tauriImportFs : null),
    [fs],
  )
  const library = useLibrary(fs, writes.current, initialBooks)
  /* Reading aloud follows the spine document: an utterance outlives a section,
   * and would otherwise go on reading words that are no longer on screen. */
  const speech = useSpeech(book.doc)

  /* One file picker for the window. The reader's empty state, the palette and
   * the switcher all ask for books, and one input serves all three rather than
   * each surface growing its own. */

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

  const openBook = useCallback(
    (source: File | string, path: string | null = null) => {
      dispatch({ type: 'goScreen', screen: 'reader' })
      /* Handed over WITH its source rather than set directly, so the effect that
       * notices the new source is the single place the path is decided. Set here
       * alone, it survived a route that does not come through this function. */
      intake.noteOpen(source, path)
      book.open(source)
    },
    [book, dispatch],
  )


  const { add, update, remove, positionOf, rekeyBook } = library

  /**
   * Put what an import produced onto the shelf.
   *
   * Every route in goes through here — today that is the folder import, and it
   * is one function rather than a step inside it because the same shelving has
   * been needed by every import route this app has had.
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
         * re-importing a folder overwrote the real title and author of every
         * book in it with `moby-dick-1851` and nothing. */
        true)
      }
    },
    [add],
  )

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
  /* Which open the reader asked for LAST. Reading a stored book takes real
   * time — a large PDF is seconds — and two clicks in that window resolved in
   * completion order, so the slower FIRST click could land its `openBook`
   * after the second's and replace the book the reader most recently chose
   * with the one they had already abandoned. Each request takes a number; a
   * completion that is not the newest number says nothing. */
  const openGeneration = useRef(0)

  const openStored = useCallback(
    (entry: IndexedBook) => {
      if (!fs) return
      const generation = ++openGeneration.current
      const fresh = () => openGeneration.current === generation
      const name = storedBookName(entry)
      void readOwnedBook(fs, contentPathIn(entry.bookId, name), name)
        .then((file) => {
          if (fresh()) openBook(file, entry.origin ?? null)
        })
        .catch((cause: unknown) => {
          if (!fresh()) return
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
            /* AN ORIGIN IS A PATH OR AN ADDRESS, and which one is not always
             * decidable by looking. `https://…` is obvious; `/sample.epub` is
             * not — it is a relative URL served by the app itself, and it is
             * what the bundled sample book has been opened by all along. Read as
             * a filesystem path it is simply absent, so pattern-matching on the
             * scheme reported the one book most likely to still work as
             * unopenable.
             *
             * So: try it as a file, and fall back to opening it as an address.
             * The reader takes a string source directly, and a genuinely bad
             * origin still fails — one step later, through the reader's own
             * error path, which is where an unopenable book belongs. */
            if (/^https?:\/\//i.test(original)) {
              openBook(original)
              return
            }
            void readBookAt(original)
              .then((file) => {
                if (fresh()) openBook(file, original)
              })
              .catch(() => {
                if (fresh()) openBook(original)
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

  /* The drop hook now lives below `dropBooks`, which it takes as its handler —
   * a `const` read at call time, so it has to be declared first. */

  /**
   * Fill the shelf in for the books nobody has opened.
   *
   * An import writes a placeholder — a filename for a title, no jacket —
   * because parsing a folder of three hundred books at import time would make
   * importing as slow as reading. That was always meant to be corrected on
   * first open, and nothing ever opens most of a two-thousand-book library: the
   * shelf built to show jackets showed almost none, and every row read like the
   * file it came from.
   *
   * So the same parse, in the background, over the books that have not had one.
   * `useEnrichment` owns the pacing; what is supplied here is the three things
   * only this component knows — where the bytes are, what parses them, and
   * whether the reader is currently in a book.
   */
  const enrichment = useEnrichment({
    books: library.books,
    fs,
    /* THE SCREEN, not whether a book is loaded. A book stays loaded when the
     * reader steps back to the shelf, and the shelf is exactly where they want
     * jackets appearing; gated on the open book, the pass would stop the first
     * time anything was read and never start again that session. */
    reading: state.screen === 'reader',
    add,
    keepJacket: library.keepJacket,
    readBook: (entry) => {
      // `storedBookName`, the same reconstruction `openStored` uses — the
      // parser routes on the extension and the vault stores by hash.
      const name = storedBookName(entry)
      return readOwnedBook(fs!, contentPathIn(entry.bookId, name), name)
    },
    parse: (file) => parseBook(file),
  })

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

  const { rekey: rekeyMarks } = marks
  const { rekey: rekeyCards } = cards

  /* Taking a book in — the bytes, the identity migration and the record, in one
   * ordered sequence. It was four pieces of this component: two refs, a layout
   * effect and a hundred and fifty lines of effect, and it has produced more
   * defects than anything else in this app. On its own it is legible; here it
   * read as a formality. See `useBookIntake`. */
  const intake = useBookIntake({
    bookId,
    meta,
    source,
    fs,
    add,
    rekeyBook,
    rekeyMarks,
    rekeyCards,
  })


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
   * The native picker. Returns paths, which is the entire difference.
   *
   * PICKING FIVE BOOKS USED TO ADD ONE. The loop called `openBook` on every file
   * in turn, and opening a book REPLACES the open one — so React saw a single
   * source, the last, and the intake effect that shelves a book ran once. The
   * other four were selected, reported as nothing, and never arrived.
   *
   * The button says "Add books", so all of them are added: each is copied into
   * its own folder and put on the shelf, exactly as a folder import does, and
   * then ONE is opened. The reader asked to add several and to be reading; both
   * happen, and neither is inferred from the other.
   */
  /* Which import is the current one. Bumped by every route that copies books
   * in, so a batch can tell that a newer one has started and stand down —
   * see `addAndOpen`, and `addFolder`, which shares it. A ref rather than
   * state because it is read inside a running loop, where a re-render's stale
   * closure is exactly the thing that must not happen. */
  const importBatch = useRef(0)
  /* The running folder walk's abort handle. The batch token makes a
   * superseded import stop REPORTING; this is what makes it stop WORKING —
   * `importFolder` takes the signal and checks it between books. */
  const importAbort = useRef<AbortController | null>(null)

  /**
   * Add every book, then open one — the shared half of picking and dropping.
   *
   * EXTRACTED BECAUSE THERE ARE NOW TWO CALLERS, and the drop path had been
   * quietly missing this behaviour entirely: it opened `files.item(0)` and
   * discarded the rest, which is the very defect the note above records as
   * fixed for the picker. Written a second time in the drop handler, the two
   * would drift on exactly the details that already went wrong once — which
   * book opens, whether duplicates are reported, whether the shelf is told.
   *
   * `path` is nullable here where `PickedBook` requires one, because a drop has
   * no path to give: the webview is handed bytes and a filename, not a location
   * on disk. Nothing downstream needs it — `keepOwnCopy` derives the
   * destination from the content hash — so the honest type is the one that
   * admits the difference rather than inventing a path to satisfy a signature.
   */
  const addAndOpen = useCallback(
    /* `note` rides along to the FINAL notice. The drop path knows things the
     * batch cannot — how many items were unreadable, whether the walk was
     * truncated — and setting them as their own notice up front meant the
     * progress bar covered them and `summarise` then overwrote them: the one
     * warning that books were silently missing was itself silently missing. */
    async (picked: readonly { file: File; path: string | null }[], note?: string) => {
      if (picked.length === 0) return
      // The last, because that is the one the previous version happened to
      // open — the same book opens as before, and now the rest arrive too.
      const opening = picked[picked.length - 1]!
      /* The note reaches the reader on EVERY path. The batch path folds it
       * into the final summary below; the single-book path and the no-`fs`
       * path (a plain browser tab, where nothing is shelved) have no summary,
       * so the note stands alone — dropped there, a truncated or partly
       * unreadable drop was reported only when persistence happened to be
       * available, which is not what the warning was about. */
      if (note && (picked.length === 1 || !fs)) setImportNotice(note)
      if (picked.length > 1 && fs) {
        /* AND STOPS A RUNNING FOLDER WALK — the token below makes an older
         * batch stop REPORTING, but a walk deep in `importFolder` kept
         * COPYING against the same content-hashed paths. The signal is how it
         * actually stops. */
        importAbort.current?.abort()
        importAbort.current = null
        /* SUPERSEDES ANY BATCH ALREADY RUNNING. Two imports could overlap —
         * drop a folder, then drop a book — and the older, slower one then
         * called `openBook` last, so the reader ended up in the book they had
         * asked for first rather than the one they asked for last. Worse, both
         * batches wrote through `keepOwnCopy`, whose destination is derived
         * from the content hash, so two copies of the same book raced for one
         * path.
         *
         * The token is taken BEFORE the first await and re-checked after every
         * one: a batch that is no longer the current one stops writing, stops
         * reporting, and above all does not open anything. */
        const batch = importBatch.current + 1
        importBatch.current = batch
        const current = () => importBatch.current === batch

        /* PROGRESS, because a dropped folder can hold thousands. The picker's
         * folder route has reported per book from the start; the drop route
         * showed nothing at all until the whole batch finished, which on a
         * large folder is indistinguishable from the app having hung. Same
         * lifecycle, same channel, cleared in `finally` so an exception cannot
         * strand the bar on screen. */
        setImporting({ done: 0, total: picked.length, current: '' })
        const outcomes: ImportOutcome[] = []
        try {
          for (const [index, { file, path }] of picked.entries()) {
            if (!current()) return
            setImporting({ done: index, total: picked.length, current: file.name })
            try {
              /* Never null without a signal — the only `null` is a stop, and
               * neither the picker nor a drop has anything to stop. */
              const kept = await keepOwnCopy(fs, file, path)
              if (kept) outcomes.push(kept)
            } catch (cause) {
              console.error('Paper: could not add', path ?? file.name, cause)
              outcomes.push({ path: path ?? file.name, status: 'failed', name: file.name })
            }
          }
        } finally {
          if (current()) setImporting(null)
        }
        if (!current()) return
        shelveImported(outcomes)
        setImportNotice(note ? `${summarise(outcomes)} ${note}` : summarise(outcomes))
      }
      openBook(opening.file, opening.path)
    },
    [openBook, fs, shelveImported],
  )

  const addBooks = useCallback(() => {
    void pickBooks()
      .then((picked) => addAndOpen(picked))
      .catch((cause: unknown) => {
        /* SAID, not only logged. A cancelled picker resolves empty, so
         * reaching here is a real failure — and a reader whose "Add books"
         * produced nothing at all cannot tell a broken picker from a click
         * that did not land. */
        console.error('Paper: the book picker failed', cause)
        setImportNotice('The file picker failed — nothing was added.')
      })
  }, [addAndOpen])

  /**
   * Books dropped on the window, treated exactly as picked ones.
   *
   * A drop used to be the one route in that could not report on itself: it
   * opened a book and said nothing, so dropping a folder of forty did nothing
   * at all and dropping five added one, with no notice either way. It goes
   * through the same path as the picker now, so the shelf fills, duplicates are
   * named, and failures are counted in the same sentence.
   */
  const dropBooks = useCallback(
    ({ books, unreadable, truncated }: DropHaul) => {
      /* SAYS WHICH KIND OF NOTHING IT WAS. The drop is filtered to the formats
       * Paper reads, so a dropped `.txt` or a folder with no books in it yields
       * an empty list — and a drag that produces no response is
       * indistinguishable from a frozen window. But "no books here" and "the
       * books are there and unreadable" are different facts, and reporting the
       * first for the second is the more alarming of the two told as the
       * milder. The haul distinguishes them; so does this. */
      if (books.length === 0) {
        setImportNotice(
          unreadable > 0
            ? `Nothing in that drop could be read — ${unreadable} ${unreadable === 1 ? 'item' : 'items'} failed.`
            : 'Nothing Paper can open was in that drop.',
        )
        return
      }
      /* The ceilings are announced rather than applied quietly — a reader who
       * drops six thousand books and is shown five thousand, or whose drop
       * held three unreadable files among forty good ones, has otherwise been
       * told something untrue by omission. AS PART OF THE FINAL NOTICE, not
       * before the batch: set up front, the progress bar covered it and the
       * batch summary then replaced it. */
      const notes = [
        truncated ? `That drop held more than ${MAX_FILES} books — took the first ${MAX_FILES}.` : null,
        unreadable > 0
          ? `${unreadable} ${unreadable === 1 ? 'item' : 'items'} could not be read.`
          : null,
      ].filter((one): one is string => one !== null)
      void addAndOpen(
        books.map((file) => ({ file, path: null })),
        notes.length ? notes.join(' ') : undefined,
      ).catch((cause: unknown) => {
        console.error('Paper: could not add what was dropped', cause)
      })
    },
    [addAndOpen],
  )

  /* Window-wide, not just over the empty state. A file dropped anywhere the
   * app does not intercept NAVIGATES the webview to it — the interface is
   * replaced by WebKit's PDF viewer with no error and no way back. */
  const { dragging } = useFileDrop(dropBooks)

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
  /* NOT SEEDED WITH THE SHELF FAILURE any more. It shared this channel with
   * import notices, so the first folder import or failed open replaced it — and
   * it was not dismissable, so until then it sat there permanently. The screens
   * say it themselves now, in the place that would otherwise have claimed the
   * library was empty. */
  const [importNotice, setImportNotice] = useState<string | null>(null)
  const addFolder = useCallback(() => {
    void (async () => {
      /* REFUSES TO RE-ENTER. The toolbar button carried `disabled={importing
       * !== null}` and that was the whole guard — so when the control moved to
       * the empty state and the ⌘K palette, the palette had none and ⌘K during
       * an import started a second one: two walks, two progress streams into
       * one bar, two notices overwriting each other.
       *
       * Guarded HERE rather than only in the palette, because a guard that
       * lives in one caller is a guard the next caller has to remember. The
       * palette also omits the command while importing, so the reader is not
       * offered something that would refuse — but this is what makes it true. */
      if (importing !== null) return
      /* A rejected picker is a FAILURE, not a cancellation — cancelling
       * resolves null — and swallowing it into the same null made a broken
       * dialog look like a change of mind: the reader clicked Import, nothing
       * happened, nothing was said anywhere. */
      const folder = await pickFolder().catch((cause: unknown) => {
        console.error('Paper: the folder picker failed', cause)
        setImportNotice('The folder picker failed — nothing was imported.')
        return null
      })
      if (!folder || !importFs) return
      /* Takes the same token `addAndOpen` uses, so the two routes supersede
       * each other rather than only themselves. Without it a folder import
       * finishing after a drop had started would clear the drop's progress bar
       * and overwrite its notice — one import reporting on another's behalf. */
      const batch = (importBatch.current += 1)
      const current = () => importBatch.current === batch
      /* A new walk retires the old one's WORK, not just its reporting. */
      importAbort.current?.abort()
      const controller = new AbortController()
      importAbort.current = controller
      setImporting({ done: 0, total: 0, current: '' })
      try {
        const outcomes = await importFolder(
          importFs,
          folder,
          {
            onProgress: (progress) => { if (current()) setImporting(progress) },
            signal: controller.signal,
          },
        )
        if (!current()) return
        shelveImported(outcomes)
        setImportNotice(summarise(outcomes))
      } catch (cause) {
        console.error('Paper: the folder import failed', cause)
        if (current()) setImportNotice('That folder could not be imported.')
      } finally {
        if (importAbort.current === controller) importAbort.current = null
        if (current()) setImporting(null)
      }
    })()
  }, [shelveImported, importFs, importing])


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
      intake.noteRemoval(entry.bookId)
      remove(entry.bookId)
    },
    [remove],
  )

  /**
   * Where to resume, read from the BOOK'S OWN RECORD rather than from the index.
   *
   * The index is a cache and it can be one write behind — a crash between
   * writing `book.json` and writing `index.json` leaves it so, and that is a
   * trade this project accepts because a stale cache cannot cause a stale WRITE:
   * every mutation applies to the record on disk.
   *
   * Except through here. The position it handed back was fed to the reader as
   * the place to resume, and the reader then saved it — so the one path by which
   * a stale cache could overwrite a newer record was the reading position, which
   * is the single thing a reader notices losing.
   *
   * Falls back to the row until the read lands. One small file against parsing a
   * book is not a close race, but if it were, the cached position is a better
   * answer than none.
   */
  const [resumeAt, setResumeAt] = useState<{ bookId: string; position: string | null } | null>(null)
  useEffect(() => {
    if (!bookId || !fs) return
    let live = true
    void readBook(fs, bookId)
      .then((record) => {
        if (live) setResumeAt({ bookId, position: record?.position ?? null })
      })
      .catch(() => {
        // The row's value stands. A record that will not read is a book that is
        // about to fail to open anyway, and this is not where that is reported.
      })
    return () => {
      live = false
    }
  }, [bookId, fs])
  const lastLocation =
    resumeAt && resumeAt.bookId === bookId ? resumeAt.position : positionOf(bookId)

  /**
   * Hold the window shut until everything written has landed.
   *
   * Every write in this app is deliberately asynchronous — a page turn must not
   * wait on a disk — and that is right until the process is about to go away, at
   * which point an unfinished write is a highlight the reader will not get back.
   * `pagehide` was the previous answer and it cannot be one: it STARTS the work
   * and the webview is torn down underneath it.
   *
   * So the close is intercepted, the queue drained, and the window closed for
   * real. The reader sees a window that takes a few milliseconds longer to shut,
   * which is the correct price.
   *
   * BOUNDED. A queue that will not drain — a disk that has stopped answering —
   * must not make the app unclosable, because then the only way out is to kill
   * it and that loses strictly more. Two seconds is far past any real write.
   */
  useEffect(() => {
    if (!isTauri()) return
    /* The registration is ASYNC and the cleanup is not: torn down before the
     * promise resolved — which StrictMode's mount/unmount/mount does on every
     * launch in dev — `stop` was still undefined, the cleanup removed
     * nothing, and the second mount added a second handler: two intercepts,
     * two destroys, racing. A registration that lands after its effect died
     * is unregistered on the spot. */
    let disposed = false
    let stop: (() => void) | undefined
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault()
        /* WHAT IS HELD IN MEMORY FIRST, then what is on the queue. A queue can
         * only drain what it has been given, and the thing most likely to be
         * lost is the thing not yet handed over — a note being typed. */
        flushBeforeClose()
        await Promise.race([
          writes.current.idle(),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ])
        await getCurrentWindow().destroy()
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten()
          return
        }
        stop = unlisten
      })
      .catch((cause: unknown) => {
        // Without the listener the window closes as it always did — writes in
        // flight are at risk, which is the state this replaces rather than a
        // new one. Reported, because it is the difference between "saved" and
        // "probably saved".
        console.error('Paper: could not hold the window open to finish saving', cause)
      })
    return () => {
      disposed = true
      stop?.()
    }
  }, [])

  /* The book intake — bytes first, then record, one effect — lives in
   * `useBookIntake`, where its ordering rationale is documented. */

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
    /* `keepCover`, which IS the one write path — this was its own copy of the
     * same exists/downscale/mkdir/write sequence, written before the helper
     * existed and left behind when it did, so the comment claiming a single
     * path was describing an intention rather than the code. Two copies of a
     * write is one of them missing the `exists` check later.
     *
     * There is no `cancelled` flag any more. It only ever guarded the write,
     * and writing this book's jacket into this book's folder is correct whether
     * or not the reader has since moved on — the path is derived from the id,
     * so a late write cannot land on the wrong book. */
    /* `keepJacket`, not `keepCover` directly: the write goes in line behind
     * this book's record write and its removal. Called straight, it could
     * recreate a folder that had just been moved to the trash. */
    library.keepJacket(bookId, cover)
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
    /* AND THE CLOSE PATH. The close handler runs `flushBeforeClose()` before
     * draining the queue — that is the whole design: hand over what memory
     * holds, then drain — but the throttled position was never REGISTERED
     * with it. So the last two seconds of reading rode on `pagehide`, which
     * Tauri fires after the close request has already drained the queue: the
     * flush wrote into a queue nothing would run, and quitting mid-page lost
     * the place the reader quit at. */
    const offBeforeClose = onBeforeClose(flush)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      offBeforeClose()
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

  /* The book being read, AS THE SHELF KNOWS IT — the row the tag editor edits.
   * Null on the library, and null for a `?book=` the shelf does not hold, so
   * neither ⌘T nor the palette offers to tag a book that has no record to
   * write the tag into. FROM `openRow`, which is the same lookup made once
   * above — this ran its own scan of the shelf beside it. */
  const readingBook = state.screen === 'reader' ? (openRow ?? null) : null
  /* Memoized as the one-element list `TagEditor` takes, or a fresh `[book]`
   * inline at the render defeated every books-keyed memo inside it. */
  const readingBooks = useMemo(() => (readingBook ? [readingBook] : []), [readingBook])
  const openTags = useCallback(
    () => dispatch({ type: 'toggleLayer', layer: 'tagsOpen' }),
    [dispatch],
  )
  /* Every tag on the shelf, for the sheet's suggestions. Only walked while the
   * sheet is up: the shelf computes its own for its own editors. */
  const shelfTags = useMemo(
    () => (state.tagsOpen ? tagCounts(library.books) : []),
    [state.tagsOpen, library.books],
  )

  const commands = useMemo(
    () =>
      buildCommands({
        editTags: readingBook ? openTags : null,
        /* The same faces the settings panel offers — see `offeredFaces`. */
        faces: offeredHere,
        state,
        dispatch,
        hasBook: book.source !== null,
        // Null when nothing is selected, so the palette simply does not offer
        // a command that could not do anything.
        /* The same two settings the selection bar writes, so a mark made by
           ⌘D and a mark made by clicking a swatch cannot come out looking
           different — which is what a second default here would guarantee. */
        markSelection: marking.selection
          ? () => marking.mark('', { tint: state.markTint, style: state.markStyle })
          : null,
        openBookPicker: addBooks,
        /* The palette is where the folder import lives now that the toolbar
         * carries one action — see `CommandContext`. */
        importFolder: addFolder,
        importing: importing !== null,
        closeBook: () => book.close(),
        openSwitcher: () => dispatch({ type: 'toggleLayer', layer: 'switcherOpen' }),
      }),
    [state, dispatch, book, marking, addBooks, addFolder, importing, readingBook, openTags],
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
      /* NOT FROM A CONTROL, AND NOT AFTER SOMETHING ELSE HANDLED IT. The
       * `typing` guard covered text entry only, so Space on a FOCUSED BUTTON —
       * a toolbar control reached by Tab — turned the page instead of pressing
       * the button, and an arrow key a custom control had already consumed
       * (`defaultPrevented`) turned it again. Both are the platform's meaning
       * of those keys being taken from under the reader's focus. */
      const onControl =
        target instanceof HTMLElement &&
        target.closest('button, a[href], select, [role="menu"], [role="listbox"], [role="dialog"]') !== null
      if (!accel && !typing && !onControl && !event.defaultPrevented && reading) {
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
      /* UP ONE LEVEL, the same toggle the titlebar button and the palette entry
       * do. Bound because the button's tooltip names it, and a tooltip naming a
       * key nothing binds is the app describing a feature it does not have —
       * which is the row the library ledger opens with. */
      if (event.key === 'l') {
        event.preventDefault()
        dispatch({
          type: 'goScreen',
          screen: state.screen === 'library' ? 'reader' : 'library',
        })
        return
      }
      if (event.key === 'd') {
        // Only when there is a selection to mark; otherwise ⌘D stays the
        // browser's own, rather than being swallowed to do nothing.
        if (!marking.selection) return
        event.preventDefault()
        // The tint and style the selection bar is showing — see `markSelection`.
        marking.mark('', { tint: state.markTint, style: state.markStyle })
        return
      }
      /* ⌘T: the tags of the book being read — the palette's "Tags for this
       * book…". Only when there is such a book, on the same reasoning as ⌘D:
       * a combo swallowed to do nothing is worse than one left unbound. */
      if (event.key === 't') {
        if (!readingBook) return
        event.preventDefault()
        openTags()
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
      /* NOT ON A SCREEN THAT HAS NO SUCH PANEL. `openPane` falls back rather
       * than failing, which is right for a palette entry the reader chose by
       * name — and wrong for a digit: pressing ⌘1 for Contents on the library
       * and being given Notes is a key that does something else, silently. It
       * does nothing there instead, which is what an unbound key does. */
      if (shortcut && paneFits(state.screen, shortcut.pane)) {
        event.preventDefault()
        /* A TOGGLE, exactly as the palette row behaves — the row for an open
         * panel says "Close" and carries this combo, so the combo has to
         * close it too. Dispatching `openPane` unconditionally made the
         * shortcut re-open a panel its own advertised label promised to
         * close: the same command, two behaviours by entry point. */
        if (state.pane === shortcut.pane) dispatch({ type: 'closePane' })
        else dispatch({ type: 'openPane', pane: shortcut.pane })
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
    state.pane,
    state.paletteOpen,
    state.switcherOpen,
    state.tagsOpen,
    state.stepIdx,
    readingBook,
    openTags,
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
            {/* The tag editor over the book being read — ⌘T. The same box the
                shelf opens over a card, in a sheet, because in the reader
                there is no card to hang it from. */}
            {state.tagsOpen && readingBook && (
              <OverlaySheet
                label="Tags for this book"
                onDismiss={() => dispatch({ type: 'closeLayer', layer: 'tagsOpen' })}
              >
                <TagEditor
                  books={readingBooks}
                  shelfTags={shelfTags}
                  onAdd={library.tagBooks}
                  onRemove={library.untagBooks}
                  fill
                />
              </OverlaySheet>
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
            books={library.books}
            onRenameTag={library.renameTag}
            onRemoveTag={library.removeTag}
            lastRemoval={library.lastRemoval}
            onUndoRemoveTag={library.undoRemoveTag}
            onAdoptTag={library.adoptTag}
            onTagBooks={library.tagBooks}
            offered={offeredHere}
          />
        }
        onDismissPane={() => dispatch({ type: 'closePane' })}
      >
        {/* The reader stays mounted under every screen. Unmounting it tears
            foliate down mid-flight and loses the reading position — see the
            note on Library's own stacking. */}
        <Reader
          libraryCount={library.books.length}
          shelfUnread={shelfUnread}
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
          lastLocation={lastLocation}
          reducedMotion={reducedMotion}
          onAddBooks={addBooks}
          dragging={dragging}
          inert={state.screen === 'library'}
        />

        {state.screen === 'library' && (
          <Library
            books={library.books}
            platform={platform}
            libraryQuery={state.libraryQuery}
            onQueryChange={(query) => dispatch({ type: 'setLibraryQuery', query })}
            // Opening from the library takes you to what you opened. Staying
            // on the shelf with a book loading behind it is the one thing a
            // reader does not want from a click on a cover.
            onOpen={openStored}
            onRemove={removeBook}
            onTagBooks={library.tagBooks}
            onUntagBooks={library.untagBooks}
            onSetFinished={(bookId, finished) =>
              update(bookId, (record) => ({ ...record, finished }))
            }
            onAddFolder={addFolder}
            importing={importing}
            importNotice={importNotice}
            shelfUnread={shelfUnread}
            enriching={enrichment.pending}
            onAddBooks={addBooks}
          />
        )}
      </WindowShell>

    </>
  )
}
