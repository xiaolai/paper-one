import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { buildCommands } from './commands'
import { offeredFaces } from '../core/typefaces'
import { presentFaces } from './fontProbe'
import { canKeepPlace, resolveAccel } from './accel'
import { DEFAULT_STEP_IDX, applyMetrics } from '../core/metrics'
import { importFs as tauriImportFs, pickBooks, pickFolder, readBookAt } from '../core/bookFiles'
import { positionRecorder, type PositionRecorder } from '../core/positionRecorder'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri, usePlatform, usePrefersDark, usePrefersReducedMotion } from './platform'
import { planImport } from '../core/tagArchive'
import { canArchiveTags, exportTagsToFile, importTagsFromFile } from './tagFiles'
import { canArchiveMarks, exportMarksToFile, importMarksFromFile } from './marksFiles'
import { createHandover } from './importHandover'
import { createGenerations } from './latestOpen'
import { CLOSE_DRAIN_MS, createCloseSequence } from './closeWindow'
import { openExternal } from './openExternal'
import { planImport as planMarksImport } from '../core/marksArchive'
import { hasOpenLayer, useAppState } from './state'
import { useTagPrefs } from './hooks/useTagPrefs'
import type { KernelServices } from '../core/services'
import type { Composition } from '../core/registry'
import { useBook } from './hooks/useBook'
import { useBookIntake } from './hooks/useBookIntake'
import { useEnrichment } from './hooks/useEnrichment'
import { flushBeforeClose, onBeforeClose } from '../core/beforeClose'
import { useFileDrop, type DropHaul } from './hooks/useFileDrop'
import { useLibrary } from './hooks/useLibrary'
import { useCards } from './hooks/useCards'
import { useMarks } from './hooks/useMarks'
import { useMarking } from './hooks/useMarking'
import { useBookmarking } from './hooks/useBookmarking'
import { useJumps, type JumpTarget } from './hooks/useJumps'
import { locationToOpen, overrideSpent, type Place } from '../core/jumpStack'
import type { ExternalLinkDetail } from 'foliate-js/view.js'
import type { FootnoteRender } from './reader/session'
import { extensionFor, readOwnedBook, storedBookName } from '../core/bookVault'
import type { IndexedBook } from '../core/bookIndex'
import type { IndexFs } from '../core/bookIndex'
import { contentPathIn, readBook } from '../core/bookFolder'
import {
  MAX_FILES,
  SHELVE_BATCH,
  importFolder,
  keepOwnCopy,
  summarise,
  type ImportOutcome,
  type ImportProgress,
} from '../core/importFolder'
import { BookSwitcher } from './overlays/BookSwitcher'
import { CommandPalette } from './overlays/CommandPalette'
import { OverlaySheet } from './overlays/OverlaySheet'
import { TitleBar } from './shell/TitleBar'
import { WindowShell } from './shell/WindowShell'
import { Library } from './screens/Library'
import { Reader } from './screens/Reader'
import { TagEditor } from './screens/TagEditor'
import { tagCounts } from '../core/library'
import { SidePane } from './pane/SidePane'
import { parseBook } from './reader/parseBook'
import { useSpeech } from './reader/useSpeech'

export interface AppProps {
  /**
   * The kernel's services — the shelf, the marks, the cards, the settings —
   * built ONCE by the composition root (`main.tsx`) over the store and the
   * filesystem it resolved before the first render, and handed in rather than
   * built here: the hooks below are adapters over these instances, and
   * anything else that will hold them (a service answering a peer) must hold
   * the same ones.
   */
  services: KernelServices
  /**
   * The library's filesystem, or null outside Tauri.
   *
   * Still taken here as well as inside the services, because this component
   * reads books and imports folders through it directly.
   */
  fs: IndexFs | null
  /**
   * The shelf could not be READ, which is not the same as having no books.
   *
   * `loadShelf` failing used to hand back an empty list, and the reader was told
   * their library was empty while it sat on disk. The two states look identical
   * from here, so the one that is alarming and wrong has to be labelled at the
   * only place that can tell them apart.
   */
  shelfUnread?: boolean
  /**
   * What the composed capabilities contributed — panes for the side pane,
   * commands for the palette — as `composeCapabilities` returned it. Built
   * by the composition root, like `services`, and read here; the kernel
   * itself puts nothing in it.
   */
  composition: Composition
}

/**
 * How long a one-line notice about the library stays on screen, in ms.
 *
 * It shares the status bar's single work slot with the background parse
 * pass, so this is also how long that pass can be prevented from reporting.
 */
const NOTICE_MS = 12_000

export function App({ services, fs, shelfUnread = false, composition }: AppProps) {
  const platform = usePlatform()
  /* Probed once for the app's lifetime: which fonts this machine has cannot
     change while it is running. Shared by the settings panel and the palette so
     the two cannot come to offer different lists. */
  const offeredHere = useMemo(() => offeredFaces(presentFaces()), [])
  const prefersDark = usePrefersDark()
  /* The one thing that can stop a page turn sliding. Not a setting — see the
   * hook, which explains why there is deliberately no control for it. */
  const reducedMotion = usePrefersReducedMotion()
  const [state, dispatch] = useAppState(services.settings, composition.panes)
  /* The reader's `Look up` preference (WI-15.13). Read through the settings
     store's `useSyncExternalStore` pair, so cycling the row in Settings
     changes what the popover does without a remount. */
  const settingsSnapshot = useSyncExternalStore(
    services.settings.subscribe,
    services.settings.getSnapshot,
  )
  /* The status bar's third rung, through the kernel's own port — the kernel
     imports nothing from a capability, so `inference` binds this and App reads
     it here. Null at rest, which is what keeps the bar byte-for-byte what it
     was when nothing is downloading. */
  const workLine = services.workLine()
  const download = useSyncExternalStore(workLine.subscribe, workLine.line, workLine.line)
  const lookUpMode = useMemo(
    () => services.lookUp(),
    /* `settingsSnapshot` is the dependency that matters: the store hands back
       a new object on every change, which is what re-reads the value. */
    [services.settings, settingsSnapshot],
  )
  /* The open book lives here, not in the reader: Contents and Companion read
   * from it and they are panels of the side pane now. */
  const book = useBook()
  /* Marks outlive the open book — the Marginalia panel browses every book's — so the
   * store is keyed by book rather than owned by one. Every write to a book's
   * folder goes through the ONE queue the services share — see
   * `createKernelServices` — which is what gives the close something to hold for. */
  const marks = useMarks(services.marks, book.bookId)
  const cards = useCards(services.cards)
  const marking = useMarking(book, marks)
  /* Beside marking, not inside it. Marking acts on a selection and
   * bookmarking acts on a place — see `useBookmarking`. */
  const bookmarking = useBookmarking(book, marks)
  /* Pins, colours, hidden subjects and saved views — the reader's decisions
     ABOUT their tags, as opposed to which books carry them. See `tagPrefs`. */
  const tagPrefs = useTagPrefs(services.storage)
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
  const library = useLibrary(services.library)
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

  /* EVERY OPEN SUPERSEDES A PENDING ONE — see `latestOpen.ts`. The counter
   * this replaces was advanced only by the stored-book route, so a shelf read
   * still in flight stayed "fresh" however many books the reader picked or
   * dropped afterwards, and landed on top of the one they had chosen. */
  const openGenerations = useRef(createGenerations())

  const openBook = useCallback(
    (source: File | string, path: string | null = null) => {
      openGenerations.current.claim()
      dispatch({ type: 'goScreen', screen: 'reader' })
      /* Handed over WITH its source rather than set directly, so the effect that
       * notices the new source is the single place the path is decided. Set here
       * alone, it survived a route that does not come through this function. */
      intake.noteOpen(source, path)
      book.open(source)
    },
    [book, dispatch],
  )


  const { add, addMany, remove, positionOf, rekeyBook, keepContent, rememberPosition, setFinished } = library

  /**
   * Put what an import produced onto the shelf.
   *
   * Every route in goes through here — today that is the folder import, and it
   * is one function rather than a step inside it because the same shelving has
   * been needed by every import route this app has had.
   */
  /* THROUGH `addMany`, NOT A LOOP OVER `add`, and that is the whole of what
   * stops a large import losing its tail — see `Library.addMany`. This loop
   * used to call `add` once per book in one synchronous pass, which put a
   * write chain per book on the queue in a single tick; the writes at the end
   * of the burst failed, and a failed record write silently drops the row. It
   * also let every failure go: `add` through the hook is fire-and-forget, so
   * the count below had nowhere to come from. */
  const shelveImported = useCallback(
    async (outcomes: readonly ImportOutcome[]): Promise<number> => {
      /* Every non-failed outcome, including duplicates. `add` folds into an
       * existing record rather than replacing it, so a book already on the
       * shelf keeps its tags and its place — and a book whose bytes are in the
       * library with no record gets one, which is the case that was invisible
       * forever before. */
      const entries = outcomes
        .filter((one) => one.status !== 'failed' && one.bookId && one.name)
        .map((one) => ({
          bookId: one.bookId!,
          record: {
            /* The FILENAME, until the book is opened. Parsing three hundred books
             * to learn three hundred titles would make importing a folder as slow
             * as reading one, and the record corrects itself on first open. */
            title: one.name!.replace(/\.[^.]+$/, ''),
            author: '',
            addedAt: Date.now(),
            /* WITHOUT THIS EVERY IMPORTED PDF IS UNOPENABLE. The bytes go to
             * `content.pdf`, and `openStored` defaults a record with no `ext` to
             * `.epub` — so it looks for a file that is not there. */
            ext: extensionFor(one.name!),
            ...(one.path ? { origin: one.path } : {}),
          },
          /* SPARSE — a placeholder, not a parse. Everything above except the
           * extension is a guess from a filename, and `add` folds what it is given
           * in as the book's own account of itself. Without this flag, re-scanning
           * re-importing a folder overwrote the real title and author of every
           * book in it with `moby-dick-1851` and nothing. */
          sparse: true,
        }))
      return addMany(entries)
    },
    [addMany],
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

  const openStored = useCallback(
    (entry: IndexedBook) => {
      if (!fs) return
      const fresh = openGenerations.current.claim()
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
  /* DECLARED HERE, above the enrichment pass, because the pass reads it —
   * it stands down while books are arriving. It used to sit beside the import
   * handlers three hundred lines below, which is where it is written but not
   * where it is first needed. */
  const [importing, setImporting] = useState<ImportProgress | null>(null)

  const enrichment = useEnrichment({
    books: library.books,
    fs,
    /* THE SCREEN, not whether a book is loaded. A book stays loaded when the
     * reader steps back to the shelf, and the shelf is exactly where they want
     * jackets appearing; gated on the open book, the pass would stop the first
     * time anything was read and never start again that session. */
    reading: state.screen === 'reader',
    /* AND NOT WHILE BOOKS ARE STILL ARRIVING. The import shelves as it
     * copies, so rows reach this pass mid-import; taking them would put a
     * parse a second against a copy loop that wants the same thread seventy
     * times a second. */
    importing: importing !== null,
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
    keepContent,
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

      /* SUPERSEDED BY EVERY INTAKE, not only by a multi-book one.
       *
       * The token used to be taken inside the branch below, so a single-file
       * pick or drop advanced nothing. A folder walk already running was
       * therefore still `current()` when it finished, and its closing
       * `openBook` ran AFTER the single book the reader had just asked for —
       * leaving them in the older book. One book is as much an intake as a
       * thousand, and the thing being superseded is "which book opens last",
       * which every intake decides. */
      importAbort.current?.abort()
      importAbort.current = null
      const batch = importBatch.current + 1
      importBatch.current = batch
      const current = () => importBatch.current === batch

      if (picked.length > 1 && fs) {
        /* THE WALK ALSO HAS TO BE TOLD. The token makes an older batch stop
         * REPORTING, but a walk deep in `importFolder` kept COPYING against
         * the same content-hashed paths; the signal above is how it actually
         * stops.
         *
         * (was: SUPERSEDES ANY BATCH ALREADY RUNNING. Two imports could overlap —
         * drop a folder, then drop a book — and the older, slower one then
         * called `openBook` last, so the reader ended up in the book they had
         * asked for first rather than the one they asked for last. Worse, both
         * batches wrote through `keepOwnCopy`, whose destination is derived
         * from the content hash, so two copies of the same book raced for one
         * path.
         *
         * The token is taken BEFORE the first await and re-checked after
         * every one.) */

        /* PROGRESS, because a dropped folder can hold thousands. The picker's
         * folder route has reported per book from the start; the drop route
         * showed nothing at all until the whole batch finished, which on a
         * large folder is indistinguishable from the app having hung. Same
         * lifecycle, same channel, cleared in `finally` so an exception cannot
         * strand the bar on screen. */
        setImporting({ done: 0, total: picked.length })
        const outcomes: ImportOutcome[] = []
        /* THE SAME BATCHING THE FOLDER WALK DOES, and for the same reason —
         * see `onCopied`. A drop of a thousand books left the shelf saying
         * "Your library is empty" for the whole copy exactly as the picker
         * did; the two routes had one defect between them. */
        /* ONE HANDOVER, SHARED WITH THE FOLDER ROUTE. Both grew their own —
         * a pending array, the same threshold, a promise chain, a final flush
         * — and both guarded it with the generation token, so a superseded
         * import discarded shelf records for books already on disk. There is
         * no token inside `createHandover`, which is what stops that being
         * re-decided here. See `importHandover.ts`. */
        const handed = createHandover<ImportOutcome>(SHELVE_BATCH, shelveImported)
        try {
          for (const [index, { file, path }] of picked.entries()) {
            if (!current()) return
            setImporting({ done: index, total: picked.length })
            try {
              /* Never null without a signal — the only `null` is a stop, and
               * neither the picker nor a drop has anything to stop. */
              const kept = await keepOwnCopy(fs, file, path)
              if (kept) {
                outcomes.push(kept)
                handed.add(kept)
              }
            } catch (cause) {
              console.error('Paper: could not add', path ?? file.name, cause)
              outcomes.push({ path: path ?? file.name, status: 'failed', name: file.name })
            }
          }
        } finally {
          /* Even on the early return above: the bytes are on disk either way,
           * and leaving them recordless is the orphan this pipeline exists to
           * avoid. */
          handed.flush()
          if (current()) setImporting(null)
        }
        /* AWAITED UNCONDITIONALLY, and before the token is consulted. The
         * count is the notice's, and the notice belongs to the current batch
         * — but the WRITES belong to whoever made the copies, so a superseded
         * batch still waits for its own records to land rather than walking
         * away from a chain nothing is holding. */
        const unsaved = await handed.settled()
        if (!current()) return
        const summary = summarise(outcomes, unsaved)
        setImportNotice(note ? `${summary} ${note}` : summary)
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
  /* NOT SEEDED WITH THE SHELF FAILURE any more. It shared this channel with
   * import notices, so the first folder import or failed open replaced it — and
   * it was not dismissable, so until then it sat there permanently. The screens
   * say it themselves now, in the place that would otherwise have claimed the
   * library was empty. */
  const [importNotice, setImportNotice] = useState<string | null>(null)

  /**
   * A notice is TRANSIENT, and it was not.
   *
   * Nothing ever cleared this, so "1,959 added" — or a tag-import error from
   * twenty minutes ago — stayed on screen for the rest of the session. That
   * was survivable while the line had a row of its own above the shelf. It is
   * not survivable now the line shares the status bar's one work slot with
   * the enrichment pass: a notice that never goes away is a parse pass that
   * can never report, and the reader is left with no way to tell whether the
   * app is still doing something.
   *
   * Long enough to read a sentence twice; the notices are one line and say
   * one thing. Nothing acts on the notice, so nothing is lost by it going —
   * every failure it reports is also on the console, and every count it
   * reports is visible in the shelf itself.
   */
  useEffect(() => {
    if (importNotice === null) return
    const timer = setTimeout(() => setImportNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [importNotice])

  /**
   * The reader's filing, out to a file and back.
   *
   * BOTH REPORT THROUGH `importNotice`, which is the shelf's own line for
   * "something just happened to your library" — an archive written silently is
   * indistinguishable from a dialog the reader dismissed, and an import that
   * merged nothing looks exactly like one that failed.
   *
   * A dismissed dialog says nothing at all, deliberately: the reader closed it,
   * they know, and a message about it is the app narrating their own action.
   */
  const exportTagsNow = useCallback(() => {
    void exportTagsToFile(library.books, new Date())
      .then((path) => {
        if (!path) return
        const filed = library.books.filter((book) => (book.tags ?? []).length > 0).length
        setImportNotice(
          filed === 0
            ? 'No tags to export yet — nothing on the shelf is filed.'
            : `Exported the tags on ${filed} ${filed === 1 ? 'book' : 'books'}.`,
        )
      })
      .catch((cause: unknown) => {
        console.error('Paper: could not export your tags', cause)
        setImportNotice('Those tags could not be written.')
      })
  }, [library.books])

  const importTagsNow = useCallback(() => {
    void importTagsFromFile()
      .then((picked) => {
        if (!picked) return
        if (!picked.archive) {
          setImportNotice('That file is not a Paper tag export.')
          return
        }
        const plan = planImport(picked.archive, library.books)
        for (const one of plan.additions) library.tagBooks([one.bookId], one.tags)
        /* THE NUMBER THAT DID NOTHING IS WORTH SAYING TOO. An archive from
           another library matches nothing here, and an import that reports only
           its successes leaves the reader believing it worked. */
        const missed = plan.unmatched > 0 ? ` ${plan.unmatched} not on this shelf.` : ''
        setImportNotice(
          plan.booksTouched === 0
            ? `Nothing to add — those tags are already here.${missed}`
            : `Added ${plan.tagsAdded} ${plan.tagsAdded === 1 ? 'tag' : 'tags'} across ${plan.booksTouched} ${plan.booksTouched === 1 ? 'book' : 'books'}.${missed}`,
        )
      })
      .catch((cause: unknown) => {
        console.error('Paper: could not import those tags', cause)
        setImportNotice('That file could not be read.')
      })
  }, [library])
  /**
   * The reader's marginalia, out to a file and back.
   *
   * THE EMPTY-FILE TRAP, and it is why this awaits rather than reads.
   * `MarksView.all` and `.allBookmarks` are empty until `loadAll()` has run,
   * and the only caller of `loadAll` is the Marginalia panel mounting. So an
   * export from the palette, in a session where that panel was never opened,
   * would have walked an empty list, written `{"version":1,"books":[]}` and
   * reported success — a backup that exists, opens, and contains nothing.
   *
   * That is "green is not evidence that anything happened" exactly, and it is
   * the worst possible shape for THIS feature: the file is not read again
   * until the day the reader needs it.
   *
   * `loadAllNow()` resolves with the rows rather than setting state and hoping
   * a re-render arrives first — see `MarksView.loadAllNow`.
   */
  const exportMarksNow = useCallback(() => {
    void (async () => {
      /* CARDS ARE NOT LAZY — `CardStore` holds every row from the start,
         because a card is explicitly cross-book and no surface ever asked for
         one book's. Only the marks need the scan. */
      const everyMark = await marks.loadAllNow()
      const written = await exportMarksToFile(library.books, everyMark, cards.all, new Date())
      if (!written) return
      if (written.marks === 0 && written.cards === 0) {
        setImportNotice('Nothing to export yet — no marks and no cards.')
        return
      }
      const parts = [
        `${written.marks} ${written.marks === 1 ? 'mark' : 'marks'}`,
        `${written.cards} ${written.cards === 1 ? 'card' : 'cards'}`,
      ]
      /* SAYS WHICH FORMAT, because Markdown is a reading copy that cannot be
         imported back — and a reader told only "exported" could keep one as
         their only backup. */
      const note = written.format === 'md' ? ' as Markdown, which cannot be imported back' : ''
      setImportNotice(`Exported ${parts.join(' and ')} from ${written.books} ${written.books === 1 ? 'book' : 'books'}${note}.`)
    })().catch((cause: unknown) => {
      console.error('Paper: could not export your marginalia', cause)
      setImportNotice('Those marks could not be written.')
    })
  }, [marks, cards, library.books])

  const importMarksNow = useCallback(() => {
    void (async () => {
      const picked = await importMarksFromFile()
      if (!picked) return
      if (!picked.archive) {
        setImportNotice('That file is not a Paper marginalia export.')
        return
      }
      const everyMark = await marks.loadAllNow()
      const plan = planMarksImport(picked.archive, library.books, everyMark, cards.all)
      /* ONE WRITE PER BOOK, AND ONE FOR THE CARDS — and every one of them
       * AWAITED before the notice below claims anything.
       *
       * This looped `marks.add` and `cards.make` per row and reported success
       * without waiting for any of them. Two defects in one shape: each call
       * is a whole-file read-mutate-write, so a thousand-mark archive rewrote
       * a growing file a thousand times and the card store re-serialised its
       * entire global list per card; and "Added N marks" appeared whether or
       * not a single write had landed, so a full disk produced a cheerful
       * notice and no marginalia. */
      await Promise.all([
        ...plan.additions.map((one) =>
          marks.addMany(
            one.bookId,
            one.marks.map((mark) => ({
              bookId: one.bookId,
              cfi: mark.localAnchor.cfi,
              sectionIndex: mark.localAnchor.sectionIndex,
              text: mark.text,
              prefix: mark.prefix,
              suffix: mark.suffix,
              note: mark.note,
              kind: mark.kind,
              tint: mark.tint,
              style: mark.style,
              chapter: mark.chapter,
            })),
          ),
        ),
        cards.makeMany(
          plan.additions.flatMap((one) =>
            one.cards.map((card) => ({
              bookId: one.bookId,
              kind: card.kind,
              body: card.body,
              answer: card.answer,
              source: card.source,
              cfi: card.localAnchor?.cfi ?? null,
            })),
          ),
        ),
      ])
      /* THE BOOKS THAT MATCHED NOTHING ARE NAMED, not counted. An archive from
         another library matches nothing here, and an import that reports only
         its successes leaves the reader believing it worked. Three titles fit
         in a sentence; past that the count carries the rest. */
      const missing = plan.unmatched
      const named = missing.slice(0, 3).map((one) => one.title || 'an untitled book').join(', ')
      const rest = missing.length > 3 ? ` and ${missing.length - 3} more` : ''
      const missed = missing.length > 0 ? ` Not on this shelf: ${named}${rest}.` : ''
      const already = plan.duplicates > 0 ? ` ${plan.duplicates} already here.` : ''
      setImportNotice(
        plan.marksAdded === 0 && plan.cardsAdded === 0
          ? `Nothing to add.${already}${missed}`
          : `Added ${plan.marksAdded} ${plan.marksAdded === 1 ? 'mark' : 'marks'} and ${plan.cardsAdded} ${plan.cardsAdded === 1 ? 'card' : 'cards'} across ${plan.booksTouched} ${plan.booksTouched === 1 ? 'book' : 'books'}.${already}${missed}`,
      )
    })().catch((cause: unknown) => {
      console.error('Paper: could not import that marginalia', cause)
      setImportNotice('That file could not be read.')
    })
  }, [marks, cards, library.books])

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
      setImporting({ done: 0, total: 0 })
      /* SHELVED AS THE WALK RUNS, one batch behind — see `onCopied`. Chained
       * rather than fired in parallel: each `shelveImported` already writes
       * `WRITE_WIDTH` books at once, and starting a batch per handover would
       * put the whole library back in flight together, which is the defect
       * `addMany` exists to prevent.
       *
       * The chain is what the notice waits on, so "N added" is still a
       * statement about writes that finished rather than writes that were
       * started. */
      const handed = createHandover<ImportOutcome>(SHELVE_BATCH, shelveImported)
      try {
        const outcomes = await importFolder(
          importFs,
          folder,
          {
            onProgress: (progress) => { if (current()) setImporting(progress) },
            /* UNCONDITIONAL, for the reason the drop path gives: a walk that
             * has been superseded still copied these bytes, and a copy with
             * no record is invisible to the shelf and to removal alike. The
             * token below governs the notice, not the bookkeeping. */
            onCopied: (copied) => {
              for (const one of copied) handed.add(one)
            },
            signal: controller.signal,
          },
        )
        // Awaited for the unsaved count, and awaited even when superseded —
        // see the drop path above.
        const unsaved = await handed.settled()
        if (!current()) return
        setImportNotice(summarise(outcomes, unsaved))
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
  /**
   * Open the NEXT book at a place, rather than where it was last left.
   *
   * "Open at a place" is not a new path — it is the path every reopen takes.
   * `lastLocation` below is read exactly ONCE, when the book finishes parsing
   * (`FoliateView` holds it in a ref; `session.ts` passes it to
   * `view.init({ lastLocation })`), so a jump into another book only has to
   * make that one read answer differently.
   *
   * KEYED BY `bookId`, NOT A FLAG. The id is derived from the file's content
   * and arrives a few milliseconds after `open`, and the read happens at parse
   * completion — so matching on it is exact, and an override left over from an
   * open the reader abandoned cannot be applied to whatever they opened
   * instead. `useBook`'s `generationRef` guards the same class of race, and its
   * comment says what happens without one: every late callback from a book
   * being closed wrote itself back over the book that replaced it.
   *
   * DECLARED HERE rather than beside `goToJump`, which is the only writer.
   * `lastLocation` reads it, `lastLocation` is computed during render, and a
   * `const` referenced above its own declaration is a temporal dead zone, not
   * a hoist.
   */
  const [openAt, setOpenAt] = useState<Place | null>(null)

  const lastLocation = locationToOpen(bookId, openAt, resumeAt, positionOf(bookId))

  /**
   * Spend the override once the reader has landed.
   *
   * ON THE POSITION, not on the id alone. The id resolves within a few
   * milliseconds of the open and long before the section renders, so clearing
   * on `bookId` would drop the override before `lastLocation` was ever read —
   * the jump would open the right book at the wrong place, which is the failure
   * this whole item is about. A published CFI means a section has rendered,
   * which means the read has happened.
   */
  useEffect(() => {
    if (overrideSpent(bookId, openAt, book.position.cfi)) setOpenAt(null)
  }, [openAt, bookId, book.position.cfi])

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
    /* THE SEQUENCE IS ITS OWN UNIT, and every failure path lives there — see
     * `closeWindow.ts`. `preventDefault` has already run by the time it
     * starts, so nothing else will close this window; a throw anywhere in
     * here used to reject the listener and leave the reader with a window
     * that would not close. */
    const close = createCloseSequence({
      flush: flushBeforeClose,
      drain: () => services.drain(),
      destroy: () => getCurrentWindow().destroy(),
      timeoutMs: CLOSE_DRAIN_MS,
      report: (message, cause) => console.error(message, cause),
    })
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault()
        await close()
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
      /* SET, which it never was. The comment above describes a registration
       * landing after its effect died being "unregistered on the spot", and
       * `disposed` was declared and read and never written — so StrictMode's
       * mount/unmount/mount left the first listener registered and the second
       * mount added another: two intercepts, two teardowns, racing. */
      disposed = true
      stop?.()
    }
  }, [services])

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
  const rememberRef = useRef(rememberPosition)
  rememberRef.current = rememberPosition

  const saver = useRef<PositionRecorder | null>(null)
  if (saver.current === null) {
    saver.current = positionRecorder({
      // The library's own verb — identity-guarded and clamped there, once,
      // for this writer and for a peer's.
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
  /* Whether the reader is actually LOOKING at the book. The reader screen stays
   * mounted under the library — see `Reader.inert` — so nothing downstream of
   * it can be trusted to say which screen is on top. */
  const onReader = state.screen === 'reader'
  const readingBook = onReader ? (openRow ?? null) : null
  /* Memoized as the one-element list `TagEditor` takes, or a fresh `[book]`
   * inline at the render defeated every books-keyed memo inside it. */
  const readingBooks = useMemo(() => (readingBook ? [readingBook] : []), [readingBook])
  const openTags = useCallback(
    () => dispatch({ type: 'toggleLayer', layer: 'tagsOpen' }),
    [dispatch],
  )

  /**
   * Where the reader is, as a `Place` — the session's answer, paired with the
   * book's identity.
   *
   * `book.placeHere()` rather than `book.position.cfi`, and the difference is
   * not cosmetic: the host's copy of the CFI is a React commit behind the
   * session's, and pairing the two is what once produced a bookmark describing
   * two different pages. Null when the place cannot be pinned down, or before
   * the content-derived id has resolved — a jump stack entry with no book id
   * names nothing.
   */
  const placeHere = useCallback((): Place | null => {
    const here = book.placeHere()
    const id = book.bookId
    return here && here.cfi && id ? { bookId: id, cfi: here.cfi } : null
  }, [book])

  /** Go where a jump asks, and say whether it was accepted — see `JumpsDeps`. */
  const goToJump = useCallback(
    (target: JumpTarget): boolean => {
      if (typeof target === 'string') {
        book.goTo(target)
        return true
      }
      if (target.bookId === book.bookId) {
        book.goTo(target.cfi)
        return true
      }
      const row = library.books.find((one) => one.bookId === target.bookId)
      if (!row) {
        /* The book left the shelf between the row being drawn and the row
           being clicked. Marginalia disables such rows, so this is the race
           rather than the ordinary case.

           REFUSED, AND SAID SO. Returning false keeps the stack still — it
           must not record a departure the reader never made — and the notice
           is what stops this being the silent no-op the whole item exists to
           delete. `console.warn` alone was exactly that. */
        setImportNotice('That book is no longer on your shelf.')
        return false
      }
      setOpenAt(target)
      openStored(row)
      return true
    },
    [book, library.books, openStored],
  )

  const jumps = useJumps({ placeHere, navigate: goToJump })

  /**
   * "← Back to Loomings" — the line that tells a reader the key is worth
   * pressing.
   *
   * A JUMP IS THE ONLY THING THAT CAN BE INVISIBLE. Every other way of moving
   * through a book is something the reader did to the page in front of them;
   * a jump replaces it, and without a word the reader has no reason to think
   * anything is recoverable. ⌘[ existed for an afternoon before this and was
   * a key nobody had been told about.
   *
   * NAMED BY CHAPTER, NOT BY PAGE. The plan's sketch said "back to p. 148" and
   * a page number is the one thing an EPUB does not have — foliate only offers
   * one where the book ships a page list, which most do not. The chapter is
   * what the reader just left and what they would say themselves.
   *
   * Set only when a jump ACTUALLY happened: `jumpTo` returns false for a
   * refused one, and offering a way back from a jump that did not occur is a
   * worse lie than saying nothing.
   */
  const [returnTo, setReturnTo] = useState<string | null>(null)

  /**
   * The note showing in place, or null.
   *
   * The SESSION decides what a note contains and renders it; this only decides
   * that one is up. Dismissing goes back through the session, because it holds
   * the view the note was rendered into and a host that merely stopped drawing
   * it would leave an iframe alive behind the page.
   */
  const [footnote, setFootnote] = useState<FootnoteRender | null>(null)

  const jumpTo = useCallback(
    (target: JumpTarget) => {
      /* Read BEFORE the jump — this is where the reader is leaving from. */
      const leaving = book.position.chapterLabel
      if (jumps.jumpTo(target) && leaving) setReturnTo(leaving)
    },
    [jumps, book.position.chapterLabel],
  )

  /* Spent by using it, so the line does not linger over a place the reader has
     already gone back to. */
  const goBackFromHint = useCallback(() => {
    setReturnTo(null)
    jumps.back()
  }, [jumps])

  /**
   * A link inside the book. Record the departure and let foliate navigate.
   *
   * NOT `jumpTo`. foliate navigates this one itself — `#handleLinks` calls
   * `goTo(href)` unless the `link` event is cancelled — so calling `jumpTo`
   * would move the reader twice and stack the origin twice. `record` is the
   * push without the navigation, which is exactly the shape this needs.
   *
   * The event is left UNCANCELLED, which is what makes the link work. WI-12.3
   * cancels it for a footnote and shows the note in place instead; everything
   * that is not a footnote goes on navigating, with ⌘[ now able to bring the
   * reader back.
   *
   * AND IT SAYS SO, which it did not. `record` pushed the origin and stopped
   * there, so following a link armed ⌘[ and showed nothing — the reader landed
   * somewhere else with no sign that going back was on offer. That is invisible
   * for any link and unusable for a note: the whole point of the `*` at the
   * head of a footnote, or the `↩` at the end of an endnote, is the round trip,
   * and half of it was silent. The hint is the same one `jumpTo` raises,
   * because it is the same movement — non-linear, and undoable.
   *
   * READ BEFORE THE PUSH. `record` does not navigate — foliate does, after this
   * returns — so the label is where the reader still is either way; taking it
   * first is what keeps that true if `record` ever does move them.
   */
  const onBookLink = useCallback(() => {
    const leaving = book.position.chapterLabel
    jumps.record()
    if (leaving) setReturnTo(leaving)
  }, [jumps, book.position.chapterLabel])

  /**
   * A link whose scheme leaves the book.
   *
   * CANCELLED, ALWAYS. Leaving the event alone is what let foliate hand the
   * raw href to `globalThis.open(href, '_blank')` — and "external" under
   * `epub.js` is any scheme but `blob:`, so `javascript:` and `data:` went the
   * same way. A book file does not get to decide what this window does.
   *
   * The href then goes to the platform's own browser through a route Paper
   * chose, and a refusal is SHOWN rather than swallowed: a link that silently
   * does nothing is the failure this path exists to delete.
   */
  const onBookExternalLink = useCallback(
    (detail: ExternalLinkDetail, event: Event) => {
      event.preventDefault()
      void openExternal(detail.href_).then((refusal) => {
        if (refusal) setImportNotice(refusal)
      })
    },
    [],
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
        jumpBack: jumps.canBack ? jumps.back : null,
        jumpForward: jumps.canForward ? jumps.forward : null,
        exportMarks: canArchiveMarks() ? exportMarksNow : null,
        importMarks: canArchiveMarks() ? importMarksNow : null,
        exportTags: canArchiveTags() ? exportTagsNow : null,
        importTags: canArchiveTags() ? importTagsNow : null,
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
        /* Null where there is no place to keep — the palette then does not
           offer the row at all, rather than offering one that does nothing.
           AND ONLY ON THE READER, which is not the same condition. The reader
           stays MOUNTED under the library so foliate is not torn down and the
           position survives, so it goes on reporting a perfectly good place
           the whole time the reader is browsing their shelf — and the palette
           offered to bookmark a page nobody could see. `editTags` is guarded
           on the screen for the same reason, three lines up. */
        /* THE SAME RULE THE KEY USES — see `canKeepPlace`. The palette row and
           ⌘B are one action, and the row PRINTS ⌘B, so a condition spelled
           twice is a promise that can come apart: the row offered with the key
           inert, or the key live with the row missing. */
        toggleBookmark: canKeepPlace({ onReader, canBookmark: bookmarking.canBookmark })
          ? bookmarking.toggle
          : null,
        bookmarked: onReader && bookmarking.here !== null,
        openBookPicker: addBooks,
        /* The palette is where the folder import lives now that the toolbar
         * carries one action — see `KernelCommandContext`. */
        importFolder: addFolder,
        importing: importing !== null,
        closeBook: () => book.close(),
        openSwitcher: () => dispatch({ type: 'toggleLayer', layer: 'switcherOpen' }),
        contributed: composition.commands,
      }),
    /* `bookmarking` is READ inside this builder, so it belongs here. It was
       missing, and the memo only stayed fresh because `book` happens to change
       on every relocation — a dependency that held by accident and would have
       stopped holding the moment the hook's inputs changed. */
    [state, dispatch, book, marking, bookmarking, onReader, addBooks, addFolder, importing, readingBook, openTags, composition],
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

      /* THE MAP IS A PURE FUNCTION — see `resolveAccel`. What is left here is
         the dispatching, which is the part that needs an effect. Every guard,
         every repeat rule and every toggle lives there, where a test can put
         real keys through it instead of searching this file for a literal. */
      const action = resolveAccel(event, {
        screen: state.screen,
        pane: state.pane,
        hasSelection: marking.selection !== null,
        canBookmark: bookmarking.canBookmark,
        onReader,
        hasBook: readingBook !== null,
        canJumpBack: jumps.canBack,
        canJumpForward: jumps.canForward,
      })
      if (!action) return
      event.preventDefault()

      switch (action.kind) {
        case 'togglePalette':
          dispatch({ type: 'toggleLayer', layer: 'paletteOpen' })
          return
        case 'togglePane':
          dispatch({ type: 'togglePane' })
          return
        case 'toggleScreen':
          dispatch({
            type: 'goScreen',
            screen: state.screen === 'library' ? 'reader' : 'library',
          })
          return
        case 'markSelection':
          // The tint and style the selection bar is showing — see `markSelection`.
          marking.mark('', { tint: state.markTint, style: state.markStyle })
          return
        case 'toggleBookmark':
          bookmarking.toggle()
          return
        case 'editTags':
          openTags()
          return
        case 'stepBy':
          dispatch({ type: 'setStepIdx', idx: state.stepIdx + action.delta })
          return
        case 'resetStep':
          dispatch({ type: 'setStepIdx', idx: DEFAULT_STEP_IDX })
          return
        case 'openPane':
          dispatch({ type: 'openPane', pane: action.pane })
          return
        case 'closePane':
          dispatch({ type: 'closePane' })
          return
        case 'jumpBack':
          jumps.back()
          return
        case 'jumpForward':
          jumps.forward()
          return
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
    /* ⌘D MARKS IN THE COLOUR THE BAR IS SHOWING, and these were missing — so
       the handler went on closing over whichever tint was current when the
       effect last ran. Change the colour in the mark palette, select a new
       passage, press ⌘D: it was marked in the PREVIOUS colour, and the button
       beside it in the new one. Nothing else in this list changes when a tint
       does, so nothing else was rebuilding the handler. */
    state.markTint,
    state.markStyle,
    readingBook,
    openTags,
    /* The whole object, because ⌘B reads two things off it — whether a place
       can be kept, and whether it already is — and a handler closed over a
       stale one would toggle against the previous page. */
    bookmarking,
    onReader,
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
            bookmarking={bookmarking}
            platform={platform}
            cards={cards}
            onGoTo={jumpTo}
            onDeleteMark={marking.unmark}
            markFocus={marking.focus}
            /* The one place the app decides what the companion is — and this
               IS the line the old comment said would change when a provider
               arrived. It reads the kernel's port rather than a constant, so
               `companion`'s bind reaches here without App knowing the
               capability exists. Resolved per render, never captured: a
               reader who installs a model must not have to restart. */
            companion={services.companion()}
            /* The grounding, as a GETTER: assembling it walks the rendered
               document, and the thread calls it when the reader asks rather
               than on every render. */
            companionPassages={book.passages}
            books={library.books}
            /* GROUPED BY THE PANEL THEY SERVE — see `SidePaneProps`. Eight of
               these were flat props on a component that reads none of them. */
            library={{
              onRenameTag: library.renameTag,
              onRemoveTag: library.removeTag,
              tagPrefs,
              lastRemoval: library.lastRemoval,
              onUndoRemoveTag: library.undoRemoveTag,
              onAdoptTag: library.adoptTag,
              onTagBooks: library.tagBooks,
            }}
            settings={{
              offered: offeredHere,
              sections: composition.settings,
              missing: composition.failures,
            }}
            contributed={composition.panes}
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
          /* The gloss port, read per render rather than captured: `inference`
             binds it after composition, and a reader who installs a model
             must not have to restart to get Look up back. */
          gloss={services.gloss()}
          lookUpMode={lookUpMode}
          marks={marks}
          marking={marking}
          bookmarking={bookmarking}
          /* Read at every render and consumed once, when the book finishes
             parsing. It is null for the first few milliseconds of an open —
             `bookId` is derived from the file's content — which is why the
             reader takes it through a ref rather than at mount. */
          footnote={footnote}
          onFootnote={setFootnote}
          onDismissFootnote={book.closeFootnote}
          returnTo={returnTo}
          onReturn={goBackFromHint}
          onReturnDone={() => setReturnTo(null)}
          onLink={onBookLink}
          onExternalLink={onBookExternalLink}
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
            lastRemoval={library.lastRemoval}
            onUndoRemoveTag={library.undoRemoveTag}
            onSetFinished={setFinished}
            onAddFolder={addFolder}
            importing={importing}
            importNotice={importNotice}
            shelfUnread={shelfUnread}
            enriching={enrichment.pending}
            download={download}
            onAddBooks={addBooks}
            bookActions={composition.bookActions}
          />
        )}
      </WindowShell>

    </>
  )
}
