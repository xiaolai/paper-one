import { messageOf } from '../core/messageOf'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { buildCommands } from './commands'
import { ContributedScreen } from './screens/ContributedScreen'
import { isContributedScreenId } from '../core/uiTypes'
import { coverIn } from '../core/coverArt'
import { tauriVaultFs } from '../core/vaultFsTauri'
import { offeredFaces } from '../core/typefaces'
import { presentFaces } from './fontProbe'
import { canKeepPlace, resolveAccel, resolvePageKey } from './accel'
import { DEFAULT_STEP_IDX, applyMetrics } from '../core/metrics'
import { importFs as tauriImportFs, pickBooks, pickFolder, readBookAt } from '../core/bookFiles'
import { positionRecorder, type PositionRecorder } from '../core/positionRecorder'
import { createGenerations } from '../core/generations'
import { writeClipboard } from './clipboard'
import type { DiagnosticLog } from '../core/diagnosticsLog'
import { createOpenRollback } from './openRollback'
import { usePlatform, usePrefersDark, usePrefersReducedMotion } from './platform'
import { useImportRun } from './hooks/useImportRun'
import { useArchives } from './hooks/useArchives'
import { requestWindowClose, useWindowClose } from './hooks/useWindowClose'
import { takeOpened, type OpenRequests } from './openedFiles'
import { closePrepare } from './closeWindow'
import { openExternal } from './openExternal'
import { hasOpenLayer, paneAvailable, screenJump, useAppState } from './state'
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
import { useOverlays } from './hooks/useOverlays'
import { useReanchor } from './hooks/useReanchor'
import { useJumps, type JumpTarget } from './hooks/useJumps'
import { useResumeAt } from './hooks/useResumeAt'
import { locationToOpen, overrideSpent, type Place } from '../core/jumpStack'
import type { ExternalLinkDetail } from 'foliate-js/view.js'
import type { FootnoteRender } from './reader/session'
import { extensionFor, readOwnedBook, storedBookName } from '../core/bookVault'
import type { IndexedBook } from '../core/bookIndex'
import type { IndexFs } from '../core/bookIndex'
import { contentPathIn } from '../core/bookFolder'
import {
  MAX_FILES,
  SHELVE_BATCH,
  importFolder,
  keepOwnCopy,
  summarise,
  type ImportOutcome,
} from '../core/importFolder'
import { BookSwitcher } from './overlays/BookSwitcher'
import { CommandPalette } from './overlays/CommandPalette'
import { OverlaySheet } from './overlays/OverlaySheet'
import { listTrash, type TrashedBook } from '../core/bookTrash'
import { TrashSheet } from './overlays/TrashSheet'
import { TitleBar } from './shell/TitleBar'
import { WindowShell } from './shell/WindowShell'
import { Library } from './screens/Library'
import { Reader, type ReturnHint } from './screens/Reader'
import { TagEditor } from './screens/TagEditor'
import { tagCounts } from '../core/library'
import { SidePane } from './pane/SidePane'
import { parseBook } from './reader/parseBook'
import { useSpeech } from './reader/useSpeech'

/**
 * The desktop's jackets, bound once.
 *
 * ⚠️ **MODULE SCOPE, NOT AN INLINE ARROW.** `BookCover` lists `coverFor` in its
 * effect's dependencies — it has to, or it captures the first one forever — so
 * a new identity per render would mean a refetch and a revoked object URL for
 * every one of 1 961 rows, every render.
 */
const desktopCovers = (bookId: string) => coverIn(tauriVaultFs, bookId)

export interface AppProps {
  /**
   * The window of diagnostics this run has recorded, for the Developer panel.
   *
   * HANDED IN, NOT BUILT HERE, for `services`' own reason one paragraph down:
   * `main.tsx` creates the log before the first render because the boot steps
   * write to it, and a second one built here would show an empty window beside
   * a file that has the answers.
   *
   * Optional, and absent is a real state rather than a missing wire: a build
   * with diagnostics off records nothing, and the panel says so instead of
   * drawing an empty list that looks like a quiet run.
   */
  diagnosticLog?: DiagnosticLog | undefined
  /**
   * Told after the Developer panel clears the window, so the file can catch up.
   *
   * `diagnostics.jsonl` is a PROJECTION of the window, rewritten whole — so a
   * clear that did not reach the spool left the file holding entries the app no
   * longer has, and a harness reading it over ssh read the past.
   */
  onDiagnosticsCleared?: (() => void) | undefined
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
   * What boot found wrong with the store, in one sentence — a damaged file
   * moved aside, a disk it could not open — or null. Shown in the shelf's
   * foot until dismissed, because the console it used to go to is not where
   * a reader looks for their cards and settings (WI-20.36).
   */
  bootNotice?: string | null
  /**
   * What the composed capabilities contributed — panes for the side pane,
   * commands for the palette — as `composeCapabilities` returned it. Built
   * by the composition root, like `services`, and read here; the kernel
   * itself puts nothing in it.
   */
  composition: Composition
  /**
   * What must happen before the window closes, when the composition root has
   * more to tear down than the kernel knows about — the same teardown the
   * quit handshake runs: hand over, drain, end the capabilities, close the
   * sync journal, tell the shell. Absent, the kernel flushes and drains its
   * own queue and no more, which is right for a host with nothing composed.
   */
  beforeWindowClose?: () => Promise<unknown>
  /**
   * Books the launch carried — a double-click in the Finder, a path on the
   * command line, a second launch the first absorbed — as the shell hands
   * them over. Absent for a host with no shell (a browser tab). See
   * `openedFiles.ts` for the queue and why the root, not this component,
   * tells the shell when it may release it.
   */
  openRequests?: OpenRequests
}

/**
 * How long a one-line notice about the library stays on screen, in ms.
 *
 * It shares the status bar's single work slot with the background parse
 * pass, so this is also how long that pass can be prevented from reporting.
 */
const NOTICE_MS = 12_000

export function App({
  services,
  fs,
  shelfUnread = false,
  bootNotice: bootSaid = null,
  composition,
  beforeWindowClose,
  openRequests,
  diagnosticLog,
  onDiagnosticsCleared,
}: AppProps) {
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
  /* ⚠️ THE `Look up` PREFERENCE USED TO BE READ HERE, through a second
     `useSyncExternalStore` on the settings store, so that cycling the row in
     Settings changed what the popover did without a remount. There is no row
     and no preference: the system-dictionary hand-off is deleted and the gloss
     is the whole of Look up. The subscription went with it — it had exactly
     one reader. */
  /* ⚠️ IT SUBSCRIBES TO THE FLAG, NOT TO THE VALUES, and that is the whole
     point. `persistent` flips the first time the store's write is REFUSED, and
     that refusal happens after `values` has already changed and been published
     — so a values snapshot is byte-identical either side of it and
     `useSyncExternalStore` correctly does not re-render. Reading the flag
     itself is what makes the panel's notice appear on the write that failed
     rather than on the next one that worked.

     This used to read "a SECOND subscription" and point at a values snapshot
     directly above it. That snapshot existed to resolve the `Look up` mode and
     went with it; the sentence outlived it by one commit and was caught by
     audit. */
  const settingsPersistent = useSyncExternalStore(
    services.settings.subscribe,
    () => services.settings.persistent,
    () => services.settings.persistent,
  )
  /* The status bar's third rung, through the kernel's own port — the kernel
     imports nothing from a capability, so `inference` binds this and App reads
     it here. Null at rest, which is what keeps the bar byte-for-byte what it
     was when nothing is downloading. */
  const workLine = services.workLine()
  const download = useSyncExternalStore(workLine.subscribe, workLine.line, workLine.line)
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
  /* Reading aloud follows the spine document and turns its pages: the session
   * is the paging — `next`, in reading order — and `doc` is what is read. */
  const speech = useSpeech(book.doc, book)

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
  /* EVERY OPEN SUPERSEDES A PENDING ONE — see `core/generations.ts`. The counter
   * this replaces was advanced only by the stored-book route, so a shelf read
   * still in flight stayed "fresh" however many books the reader picked or
   * dropped afterwards, and landed on top of the one they had chosen. */
  const openGenerations = useRef(createGenerations())

  /**
   * What to undo if the open now starting never lands — see the arming site
   * in `goToJump`, the fuller note above `openFailed`, and `openRollback.ts`,
   * which holds the three transitions and the reasons each has been wrong.
   *
   * DECLARED HERE, above `openBook`, because every open OWNS this slot for its
   * own duration: an open that starts arms it, and doing so retires whatever
   * the last one left.
   */
  const undoOpen = useRef(createOpenRollback())

  const openBook = useCallback(
    (source: File | string, path: string | null = null, undo: (() => void) | null = null) => {
      openGenerations.current.claim()
      /* A direct open RETIRES the rollback a pending open armed — runs it,
       * rather than dropping it: the state a superseded jump committed is
       * still committed. `undo` is how `openStored` carries its own rollback
       * through the origin fallback, which is the one re-entry that is the
       * same open continuing. See `openRollback.ts`. */
      undoOpen.current.arm(undo)
      dispatch({ type: 'goScreen', screen: 'reader' })
      /* Handed over WITH its source rather than set directly, so the effect that
       * notices the new source is the single place the path is decided. Set here
       * alone, it survived a route that does not come through this function. */
      /* ⚠️ `intake` IS NOT IN THE DEPENDENCIES, and cannot be: it is declared
       * two hundred lines below this, because `useBookIntake` needs the open
       * book's id, meta and source, and those come from `book`. Listing it
       * here would read the binding during render, before it exists.
       *
       * What makes that safe is that `noteOpen` and `noteRemoval` are stable
       * for the hook's whole life. That used to be an accident of how the hook
       * was written — `useCallback(…, [])` in a file nothing here points at —
       * and `useBookIntake.stability.test.tsx` now asserts it, so the day it
       * stops being true a test goes red instead of this callback quietly
       * closing over a stale one. */
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

  /**
   * What to undo if the open now starting never lands.
   *
   * ⚠️ A CROSS-BOOK JUMP COMMITTED ITS STATE BEFORE THE OPEN SUCCEEDED.
   * `goToJump` set the place override, started the read and answered `true` —
   * so a book whose bytes are missing or unreadable left the reader where they
   * were, with a "← Back to …" line offering a jump that never happened and,
   * worse, an `openAt` override still armed. That override is spent by the
   * next CFI to arrive, so it applied to whatever book they opened afterwards:
   * a failed jump moved a later, unrelated open to the wrong place.
   *
   * A ref rather than a dependency because `openStored` is declared eight
   * hundred lines above the state it has to undo. It is armed by the open
   * that starts (`openStored`'s `undo` argument) and consumed by whichever
   * settles first; the slot itself is declared above `openBook`, which see.
   */
  const openFailed = useCallback(() => undoOpen.current.fire(), [])

  const openStored = useCallback(
    (entry: IndexedBook, undo?: () => void) => {
      if (!fs) return
      const fresh = openGenerations.current.claim()
      /* THIS open owns the rollback slot now, and taking it RETIRES whatever
       * the last one left rather than dropping it — see `openRollback.ts`. */
      undoOpen.current.arm(undo ?? null)
      const name = storedBookName(entry)
      void readOwnedBook(fs, contentPathIn(entry.bookId, name), name)
        .then((file) => {
          if (!fresh()) return
          /* ⚠️ NOT RELEASED HERE. The bytes arriving is not the book landing:
           * it still has to parse and render, and a corrupt or unsupported one
           * fails after this line. Released this early, a jump into a book the
           * reader was then shown an error for kept its override and its "←
           * Back to …" line. The rollback travels with the open — see the
           * `book.error` effect, which fires it, and the override's own
           * spending effect, which releases it once a section has rendered. */
          openBook(file, entry.origin ?? null, undo ?? null)
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
            /* THE ROLLBACK TRAVELS WITH THE FALLBACK. This is the same open
             * continuing by another route, not a new one replacing it — so it
             * carries `undo` rather than retiring it, which would clear the
             * jump's own override and land the book at its saved place instead
             * of the mark that was clicked. */
            if (/^https?:\/\//i.test(original)) {
              openBook(original, null, undo ?? null)
              return
            }
            void readBookAt(original)
              .then((file) => {
                if (fresh()) openBook(file, original, undo ?? null)
              })
              .catch(() => {
                if (fresh()) openBook(original, null, undo ?? null)
              })
            return
          }
          /* The folder is there and its content is not, which means an import
           * that did not finish. The record stays — its tags and position are
           * still the reader's — and they are told rather than left clicking
           * something that does nothing. */
          console.error('Paper: could not read the stored book', entry.bookId, cause)
          /* Nothing opened, so anything that committed on the assumption it
             would has to come back off — see `undoOpen`. */
          openFailed()
          setImportNotice('That book could not be opened. Try adding it again.')
        })
    },
    [openBook, fs, openFailed],
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
  /* NOT SEEDED WITH THE SHELF FAILURE any more. It shared this channel with
   * import notices, so the first folder import or failed open replaced it — and
   * it was not dismissable, so until then it sat there permanently. The screens
   * say it themselves now, in the place that would otherwise have claimed the
   * library was empty.
   *
   * DECLARED ABOVE THE IMPORT COORDINATOR, which writes every import's notice
   * through it. */
  const [importNotice, setImportNotice] = useState<string | null>(null)
  /* Standing, not transient: a quarantined store is not something the app
     did, it is something the reader has lost, and it stays until they say
     they have read it. */
  const [bootNotice, setBootNotice] = useState<string | null>(bootSaid)

  /* THE IMPORT LIFECYCLE, ONCE — see `useImportRun`. The progress bar, the
   * generation token, the abort handle, the handover and the settle were
   * written out in both routes that copy books in, and had drifted apart in
   * three ways by the time an audit read them side by side. */
  const imports = useImportRun({ shelve: shelveImported, batch: SHELVE_BATCH, notice: setImportNotice })
  const importing = imports.progress

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
    /* WHICH OPEN, not which source — see `BookIntakeInput.generation`. The
       same URL opened twice is two opens and one `source`. */
    generation: book.generation,
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

  /* WI-22.A2 — the marks an import kept but could not place are walked for
   * once per open, and a hit is WRITTEN. Here rather than inside `useMarking`,
   * which acts on a selection: nobody selected anything, and the pass runs on
   * a book the reader has only just opened. `openRow?.contentHash` is the
   * cache's generation, and is legitimately absent on a build composed without
   * `sync` — which means no cache, never an unversioned one. */
  /* WI-22.D1 — what other readers shared in this book, already anchored here.
     `composition.overlays` is the fourth contribution type; `book.reanchor` is
     the resolver port the kernel hands over rather than a capability finding
     one. Empty for a composition with no `circle`. */
  const overlays = useOverlays({
    contributions: composition.overlays,
    bookId: book.bookId,
    openGeneration: book.generation,
    parsed: book.meta !== null,
    resolve: book.reanchor,
  })

  useReanchor({
    reanchor: book.reanchor,
    parsed: book.meta !== null,
    bookId: book.bookId,
    openGeneration: book.generation,
    contentHash: openRow?.contentHash,
    unplaced: marks.unplaced,
    ready: marks.ready,
    place: marks.place,
  })



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
      /* ⚠️ AND THE ONE IT REPLACED IS NAMED, not dropped in silence.
       *
       * The two ways in disagree about what a second intake means, and each is
       * defensible on its own: `addFolder` REFUSES while one is running,
       * because ⌘K during a walk once started two of them; this one
       * SUPERSEDES, because dropping books is the reader saying "these now".
       * What was not defensible is the seam between them. A drop during a
       * folder walk aborted that walk, and the walk's own notice is guarded by
       * a generation token this line has just advanced — so it returned
       * without a word and the reader lost an import in progress with nothing
       * on screen to say it had happened. */
      if (imports.busy) setImportNotice('That replaced the import already running.')
      imports.supersede()

      /* Whether this intake was still the current one when it finished — a
         superseded one must not open its book over the one asked for since.
         The hook's answer, taken once the settle is over; a single pick runs
         nothing and is current by construction. */
      const current = await (async (): Promise<boolean> => {
        if (!(picked.length > 1 && fs)) return true
        const bytes = fs
        /* THE LIFECYCLE IS `useImportRun`'s — the token, the signal, the
         * progress bar, the handover chained one batch behind the copying, the
         * settle the notice waits on, and the order the last two happen in.
         * All six were written out here AND in the folder route, and had
         * already drifted apart in three separate ways. What is left below is
         * the WORK: copy each picked file, and say what happened to it. */
        /* Asked again once the settle is over: a drop landing during the shelf
           writes supersedes this run after the work last looked. */
        return imports.run(
          async (run) => {
            const outcomes: ImportOutcome[] = []
            for (const [index, { file, path }] of picked.entries()) {
              /* `break`, NOT `return`: the settle is unconditional, and
                 returning walked straight past the write chain it waits for. */
              if (!run.current()) break
              run.report({ done: index, total: picked.length })
              try {
                /* Never null without a signal — the only `null` is a stop, and
                 * neither the picker nor a drop has anything to stop. */
                const kept = await keepOwnCopy(bytes, file, path)
                if (kept) {
                  outcomes.push(kept)
                  run.shelve(kept)
                }
              } catch (cause) {
                console.error('Paper: could not add', path ?? file.name, cause)
                outcomes.push({ path: path ?? file.name, status: 'failed', name: file.name })
              }
            }
            return outcomes
          },
          {
            summarise: (outcomes, unsaved) => {
              const summary = summarise(outcomes, unsaved)
              return note ? `${summary} ${note}` : summary
            },
            onFailure: (cause) => {
              console.error('Paper: the import failed', cause)
              setImportNotice('Those books could not be added.')
            },
          },
        )
      })()
      if (!current) return
      openBook(opening.file, opening.path)
    },
    [openBook, fs, imports],
  )

  const addBooks = useCallback(() => {
    void pickBooks()
      .then((picked) =>
        /* ITS OWN CATCH, so the sentence matches the stage. One catch over
         * both used to answer a rejected ADD with "The file picker failed" —
         * files had been selected and partly copied, and the reader was sent
         * to re-pick them. */
        addAndOpen(picked).catch((cause: unknown) => {
          console.error('Paper: could not add the picked books', cause)
          setImportNotice('Those books could not be added.')
        }),
      )
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
        /* SAID, like every other route in. The drop was the one intake whose
         * failure went to the console alone — the silent-failure shape this
         * callback's own header says it exists to remove. */
        console.error('Paper: could not add what was dropped', cause)
        setImportNotice('Those books could not be added.')
      })
    },
    [addAndOpen],
  )

  /* Window-wide, not just over the empty state. A file dropped anywhere the
   * app does not intercept NAVIGATES the webview to it — the interface is
   * replaced by WebKit's PDF viewer with no error and no way back. */
  const { dragging } = useFileDrop(dropBooks)

  /* Books the LAUNCH carried, through the picker's route with the path kept —
   * a double-clicked book is one the shelf should be able to reopen. The
   * subscription is the root's: it registers the shell listener and only then
   * tells the shell it may release what it held (`openedFiles.ts`). */
  /* ⚠️ **THE HANDLER RIDES IN A REF, so the subscription below depends on the
   * STABLE `openRequests` and nothing else.**
   *
   * `addAndOpen` is a `useCallback` over `[openBook, fs, imports]`, and
   * `imports` changes identity while an import runs. With it in the effect's
   * dependencies, the effect tore down and rebuilt on every one of those
   * ticks, and each rebuild cost two things the comments here already say
   * matter:
   *
   *   - the native listener was removed and re-registered, and `openedFiles.ts`
   *     answers only the FIRST readiness — so a book double-clicked in that
   *     window reached no listener at all and was silently dropped;
   *   - `chain` is a local, so the "one launch at a time" ordering restarted
   *     from resolved, which is exactly the concurrency the paragraph below
   *     exists to prevent.
   *
   * Subscribing once per `openRequests` — that is, once for the window's
   * lifetime — is what the comment above already describes as the intent. */
  const openLaunched = useRef(addAndOpen)
  useEffect(() => {
    openLaunched.current = addAndOpen
  }, [addAndOpen])

  useEffect(() => {
    if (!openRequests) return
    /* IN ORDER, one launch at a time. Two deliveries close together — the
     * reader double-clicks A, then B — used to run concurrently, and a slow
     * A (a big PDF off a network volume) could finish its `addAndOpen` AFTER
     * B's, leaving A open when B was the later ask. The chain survives a
     * failure: one launch that cannot be read must not dam the next. */
    let chain: Promise<void> = Promise.resolve()
    return openRequests.subscribe((paths) => {
      chain = chain
        .then(() =>
          takeOpened(paths, {
            addAndOpen: (books, note) => openLaunched.current(books, note),
            notice: setImportNotice,
          }),
        )
        .catch((cause: unknown) => {
          console.error('Paper: could not open what the launch carried', cause)
        })
    })
  }, [openRequests])

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

  /* THE READER'S FILING AND THEIR MARGINALIA, out to a file and back — see
   * `useArchives`. Four handlers and a hundred and seventy lines of the same
   * errand (pick, plan, write, say what happened), none of which touches the
   * position, the screen or the keyboard map this component coordinates. */
  const archives = useArchives({ library, marks, cards, notice: setImportNotice })

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
      if (imports.busy) return
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
      const bytes = importFs
      /* THE LIFECYCLE IS `useImportRun`'s, THE SAME ONE THE DROP ROUTE USES —
       * so the two supersede each other rather than only themselves, and the
       * progress bar, the token, the signal and the settle cannot disagree
       * between them. They already did, in three separate ways. */
      await imports.run(
        (run) =>
          importFolder(bytes, folder, {
            onProgress: run.report,
            /* UNCONDITIONAL: a walk that has been superseded still copied
             * these bytes, and a copy with no record is invisible to the shelf
             * and to removal alike. The token governs the notice, never the
             * bookkeeping. */
            onCopied: (copied) => {
              for (const one of copied) run.shelve(one)
            },
            signal: run.signal,
          }),
        {
          summarise,
          onFailure: (cause) => {
            console.error('Paper: the folder import failed', cause)
            setImportNotice('That folder could not be imported.')
          },
        },
      )
    })().catch((cause: unknown) => {
      /* THE TERMINAL CATCH. `run` reports its own failures through
       * `onFailure`, but its settle — the shelving handover — used to reject
       * past that, and a detached IIFE turned it into an unhandled rejection
       * with no notice anywhere.
       *
       * THE SETTLE IS HANDLED INSIDE `run` NOW, which is where it belonged:
       * catching it here said the right sentence but left the progress bar up
       * and `imports.busy` true forever, so this route refused every later
       * import. This stays as the backstop it should always have been — a
       * detached IIFE with no catch is a rejection nobody hears. */
      console.error('Paper: the folder import failed to settle', cause)
      setImportNotice('That folder could not be imported.')
    })
  }, [importFs, imports])


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
      /* Stable for the hook's life, and asserted — see `openBook`. */
      intake.noteRemoval(entry.bookId)
      remove(entry.bookId)
    },
    [remove],
  )

  /**
   * THE TRASH, READ ONLY WHILE THE SHEET IS OPEN.
   *
   * `listTrash` walks `trash/` and opens a `book.json` per folder, which is
   * work proportional to everything ever removed — so it runs when the reader
   * asks and not on every render of a shelf they are only scrolling.
   *
   * RE-READ AFTER A RESTORE rather than filtered in place: `restore` can come
   * back `partial`, and a row removed from a local array would claim a success
   * the disk did not give. The disk is the answer; this only shows it.
   */
  const [trashRows, setTrashRows] = useState<readonly TrashedBook[] | null>(null)
  /* WHY IT COULD NOT BE READ, kept apart from "there is nothing in it".
     `listTrash` throws for a trash directory that exists and will not read —
     on purpose, so unreadable is never reported as empty — and turning that
     into `[]` put "Nothing removed" in front of a reader whose book was
     sitting right there. */
  const [trashError, setTrashError] = useState<string | null>(null)
  /* A SECOND SLOT, because one could not hold both. A restore reported its
     failure into `trashError` and then refreshed the list, and the refresh
     begins by clearing that field — so the message a reader needed was gone
     in the same tick it was written. Each slot is owned by exactly one
     thing: the list read clears its own, the action clears its own. */
  const [restoreError, setRestoreError] = useState<string | null>(null)
  /* ONE NOW FOR THE WHOLE SHEET, read when it opens. A hundred rows each
     calling `Date.now()` would be a hundred slightly different nows, and two
     books removed in the same second could report different days left. The
     same reasoning the shelf's own `now` carries; it does not ride here
     because the shelf recomputes on a minute tick and a fortnight does not
     need one. */
  const [trashNow, setTrashNow] = useState(0)
  /* WHICH SCAN IS ALLOWED TO ANSWER. `readTrash` returns a cleanup that the
     effect uses, and the post-restore call discarded it — so an older scan
     could still be in flight across a close-and-reopen and overwrite the
     newer one's rows. A counter settles it without the caller having to
     remember a cleanup it has nowhere to put. */
  const trashScan = useRef(0)
  /** The newest scan's `done` — what a superseded scan's `done` waits for. */
  const latestScan = useRef<Promise<void>>(Promise.resolve())
  /**
   * Read the trash into state. `done` settles once the rows are set or the
   * failure recorded — a restore awaits it, so its row is not re-enabled over
   * a list that has not caught up and offered for a second restore. `cancel`
   * is the effect's cleanup; `trashScan` is what stops a superseded read from
   * answering either way.
   */
  const scanTrash = useCallback((): { readonly done: Promise<void>; readonly cancel: () => void } => {
    if (!fs) {
      setTrashRows([])
      setTrashError(null)
      return { done: Promise.resolve(), cancel: () => {} }
    }
    const scan = ++trashScan.current
    let live = true
    setTrashError(null)
    const applied = listTrash(fs)
      .then((rows) => {
        if (!live || scan !== trashScan.current) return
        /* Newest first — the book a reader came here for is the one they just
           lost, and it is almost never at the bottom of a fortnight's list.
           An entry with no readable stamp sorts last rather than as 1970: it
           is not old, it is unknown. */
        setTrashRows(
          [...rows].sort((a, b) => (b.removedAt ?? -Infinity) - (a.removedAt ?? -Infinity)),
        )
      })
      .catch((thrown: unknown) => {
        if (!live || scan !== trashScan.current) return
        setTrashRows([])
        setTrashError(messageOf(thrown))
      })
    /* SUPERSEDED IS NOT DONE. A scan a newer one overtook resolved `done`
       having set nothing, so a restore awaiting it re-enabled its row over a
       list that had not caught up — and while the newer scan was still
       pending, the same book could be restored a second time. A superseded
       scan is done when the scan that superseded it is: what its awaiter
       wanted was the list as it is now, and only the newest scan can say. */
    const done: Promise<void> = applied.then(() => (scan === trashScan.current ? undefined : latestScan.current))
    latestScan.current = done
    return {
      done,
      cancel: () => {
        live = false
      },
    }
  }, [fs])
  const readTrash = useCallback(() => scanTrash().cancel, [scanTrash])

  useEffect(() => {
    if (!state.trashOpen) return
    setTrashRows(null)
    setTrashError(null)
    setRestoreError(null)
    setTrashNow(Date.now())
    return readTrash()
  }, [state.trashOpen, readTrash])

  const restoreBook = useCallback(
    (bookId: string) => {
      /* RETURNED, so the row can disable itself while this runs — and CAUGHT,
         because `restore` rejects on a filesystem fault and an unhandled
         rejection was a button that reported nothing either way: the row
         stayed, the book did not come back, and the only trace was in the
         console. The message goes where the list's own failure goes. */
      setRestoreError(null)
      return services.library
        .restore(bookId)
        .then((outcome) => {
          /* A PARTIAL RESTORE IS NOT A SUCCESS. `restoreBook` moves file by
             file and a name already live wins, so some of the book can come
             back while the rest stays behind; saying nothing would leave the
             reader believing they had it. */
          if (outcome.state === 'partial') {
            setRestoreError('Some of that book could not be moved back. It is still here.')
          } else if (outcome.state === 'absent') {
            setRestoreError('That book is no longer in the trash.')
          }
        })
        .catch((thrown: unknown) => {
          setRestoreError(messageOf(thrown))
        })
        .finally(() =>
          /* The shelf learns about the restore itself through the library
             subscription; this is only the trash list catching up — AWAITED,
             so the row is re-enabled over the list as it is now, not the list
             as it was. `trashScan` is what stops a superseded read from
             answering; there is nowhere here to hang the cleanup. */
          scanTrash().done,
        )
    },
    [services.library, scanTrash],
  )

  /* Where to resume, from the book's own record — `useResumeAt`, which says
     why the record outranks the index and why the previous open's answer is
     cleared before the next open's read lands. */
  const resumeAt = useResumeAt(bookId, fs)
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
   *
   * AND IT IS ALSO WHERE THE OPEN LANDS. A section rendered in the book the
   * jump asked for is the whole of what "it worked" means, so the rollback is
   * released in the same breath the override is spent — see `openRollback.ts`
   * for why releasing it any earlier was wrong.
   */
  useEffect(() => {
    if (!overrideSpent(bookId, openAt, book.position.cfi)) return
    setOpenAt(null)
    undoOpen.current.release()
  }, [openAt, bookId, book.position.cfi])

  /**
   * A book whose bytes arrived and which would not open is a failed open.
   *
   * ⚠️ THE ROLLBACK USED TO BE RELEASED WHEN THE BYTES LANDED, which is before
   * anything has parsed. So a jump into a corrupt, DRM-locked or unsupported
   * book cleared its own undo, showed the reader an error, and left the place
   * override armed and the "← Back to …" line offering a jump that never
   * happened. `book.error` is the reader's terminal open failure — `fail` is
   * generation-guarded, so this is about the book on screen — and it is the
   * signal this half was missing.
   */
  useEffect(() => {
    if (book.error !== null) openFailed()
  }, [book.error, openFailed])

  /* HOLD THE WINDOW SHUT UNTIL EVERYTHING HAS LANDED — see `useWindowClose`.
   * A whole errand with its own lifetime failure modes, and both defects it
   * has had were lifetime defects. The composition's teardown when there is
   * one; the kernel's own flush-and-drain when there is not. */
  const reportClose = useCallback((message: string, cause: unknown) => console.error(message, cause), [])
  useWindowClose(
    useMemo(
      () => beforeWindowClose ?? closePrepare(flushBeforeClose, () => services.drain(), reportClose),
      [beforeWindowClose, services, reportClose],
    ),
  )

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
   *
   * A LABEL AND A NONCE, not a label. Two jumps out of one chapter carry the
   * same chapter name, React bails out of a `setState` to an identical value,
   * and the reader's fade timer therefore never restarted — the second hint
   * ran out on the first one's clock. See `ReturnHint`.
   */
  const [returnTo, setReturnTo] = useState<ReturnHint | null>(null)
  /* MINTED IN ONE PLACE, so the nonce cannot be forgotten by the third call
     site. A ref rather than `n + 1` off the current hint: the hint is cleared
     to null between jumps, so its own count is not there to read. */
  const returnHints = useRef(0)
  const raiseReturnHint = useCallback((label: string) => {
    returnHints.current += 1
    setReturnTo({ label, nonce: returnHints.current })
  }, [])
  /* DECLARED ABOVE `goToJump`, which clears it when a cross-book open fails.
     A refused jump and a jump whose book would not open are the same lie to
     the reader, and only the first was being caught. */

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
      /* ARMED WITH THE READ, consumed if it fails. The override and the
         "← Back to …" line are both committed here on the assumption that the
         open lands, and it can fail seconds later — missing content, an origin
         that has moved. Without this the override stayed armed and was spent
         by the NEXT book the reader opened, sending it to a place from a book
         they never reached. Handed to `openStored` rather than written to the
         ref here, so the open that carries it is the only one that can be
         rolled back by it. */
      /* ⚠️ THE OPEN STARTS FIRST, AND THE ORDER IS THE POINT. Taking the
         rollback slot RETIRES the previous open's — it runs it — and that
         rollback's whole job is `setOpenAt(null)`. Written the other way round
         React batches the pair and the null wins, so a jump made while an
         earlier jump was still in flight lost its own override and opened the
         right book at the wrong place. */
      openStored(row, () => {
        setOpenAt(null)
        setReturnTo(null)
      })
      setOpenAt(target)
      return true
    },
    [book, library.books, openStored, setReturnTo],
  )

  const jumps = useJumps({ placeHere, navigate: goToJump })

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
      if (jumps.jumpTo(target) && leaving) raiseReturnHint(leaving)
    },
    [jumps, book.position.chapterLabel, raiseReturnHint],
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
    if (leaving) raiseReturnHint(leaving)
  }, [jumps, book.position.chapterLabel, raiseReturnHint])

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
        /* NULL WHERE THE BUILD CANNOT DO IT — the palette omits the row
           rather than offering one that would refuse. `useArchives` decides,
           because it is what knows. */
        exportMarks: archives.exportMarks,
        importMarks: archives.importMarks,
        exportTags: archives.exportTags,
        importTags: archives.importTags,
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
    /* AND THE SAME OMISSION AGAIN, twice over. `jumps` supplies both jump
       commands and their availability; the four archive callbacks close over
       `library.books`, `marks` and `cards`. None was listed, so the palette
       could offer a jump the stack no longer has, or export a library snapshot
       taken several imports ago — a stale command is worse than a missing one
       because it looks like it worked. */
    [
      state,
      dispatch,
      book,
      marking,
      bookmarking,
      onReader,
      addBooks,
      addFolder,
      importing,
      readingBook,
      openTags,
      composition,
      jumps,
      archives,
    ],
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
      /* ⚠️ **`onReader`, NOT A SECOND COPY OF THE SAME QUESTION.** This read
       * `state.screen !== 'library'` — and `accel.ts` had ALREADY written the
       * lesson down, on the field it exposes for exactly this: *"Not
       * `screen !== 'library'`: the reader stays mounted under the shelf with a
       * live position."* The component even computes `onReader` correctly a few
       * hundred lines above. So this was not a new mistake; it was the same one
       * made a second time, twenty feet from its own warning.
       *
       * Correcting it to `=== 'reader'` would have left two expressions that
       * can drift again. Using the one that exists is what makes a third copy
       * impossible — with a third screen, "not the shelf" stopped meaning
       * "reading", and every paging key drove the book mounted invisibly
       * underneath a capability's page, persisting a position nobody saw. */
      const reading = onReader && !overlayOpen

      /* §11: ← → turn the page. Unbound until now, which went unnoticed
       * because a scrolled EPUB scrolls — but a fixed-layout book, which is
       * every PDF, does not scroll at all. These were its only way through and
       * it had none, so it opened on one page and stayed there. */
      /* NOT FROM A CONTROL, AND NOT AFTER SOMETHING ELSE HANDLED IT. The
       * `typing` guard covered text entry only, so Space on a FOCUSED BUTTON —
       * a toolbar control reached by Tab — turned the page instead of pressing
       * the button, and an arrow key a custom control had already consumed
       * (`defaultPrevented`) turned it again. Both are the platform's meaning
       * of those keys being taken from under the reader's focus.
       *
       * THE HOST'S CONTROLS ONLY. A key pressed inside the book arrives here
       * re-dispatched with the WINDOW as its target, so this can never see a
       * `<select>` in an interactive EPUB; `ReaderSession.#watchKeys` decides
       * that half where the real target is visible, and does not forward. */
      const onControl =
        target instanceof HTMLElement &&
        target.closest('button, a[href], select, [role="menu"], [role="listbox"], [role="dialog"]') !== null
      if (!accel && !typing && !onControl && !event.defaultPrevented && reading) {
        /* THE MAP IS A PURE FUNCTION — `resolvePageKey`, beside `resolveAccel`
         * and for the same reason. What it returns is the navigator's VERB:
         * the arrows ask for a side (`goLeft`/`goRight`, which the book
         * resolves from its own direction, exactly as the chevrons do), the
         * paging keys and Space ask for an order (`next`/`prev`). The arrows
         * were `next`/`prev` here, and in a right-to-left book the → key and
         * the → chevron beside it moved opposite ways. Shift+arrow is left to
         * the selection there too; ⇧Space is the one shifted key it owns.
         *
         * §11: Space moves on by one screen, ⇧Space back by one.
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
        const verb = resolvePageKey(event)
        if (verb) {
          event.preventDefault()
          book[verb]()
          return
        }
      }

      if (!accel) return

      /* THE MAP IS A PURE FUNCTION — see `resolveAccel`. What is left here is
         the dispatching, which is the part that needs an effect. Every guard,
         every repeat rule and every toggle lives there, where a test can put
         real keys through it instead of searching this file for a literal. */
      const action = resolveAccel(event, {
        platform,
        screen: state.screen,
        pane: state.pane,
        hasSelection: marking.selection !== null,
        canBookmark: bookmarking.canBookmark,
        onReader,
        hasBook: readingBook !== null,
        canJumpBack: jumps.canBack,
        canJumpForward: jumps.canForward,
        /* THE DIGITS READ THIS. An unfinished panel's digit has to be as dead
           as a digit for a panel this screen has not got — see `AccelContext`. */
        developer: state.developer,
        hiddenPanes: state.hiddenPanes,
      })
      if (!action) return
      event.preventDefault()

      switch (action.kind) {
        /* ⌘⌃⌥D. The only way in, and the only way out — see
           `KERNEL_SETTINGS.developer`. */
        case 'toggleDeveloper':
          dispatch({ type: 'toggleDeveloper' })
          return
        case 'togglePalette':
          dispatch({ type: 'toggleLayer', layer: 'paletteOpen' })
          return
        case 'togglePane':
          /* ⚠️ A no-op where there is no pane — see `paneAvailable`. `lastPane`
             is left alone deliberately, so leaving a contributed screen
             restores whatever the reader had open before they arrived. */
          if (paneAvailable(state.screen)) dispatch({ type: 'togglePane' })
          return
        case 'toggleScreen':
          /* `screenJump`, not a comparison of its own — see `state.ts`. The
             titlebar advertises this shortcut in its own tooltip, and the two
             disagreed on every screen that is neither of the kernel's. */
          dispatch({ type: 'goScreen', screen: screenJump(state.screen, book.source !== null).to })
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
        /* THE WINDOW'S CLOSE, not an exit: `useWindowClose` intercepts it and
           runs the teardown the quit handshake runs, so Ctrl+Q closes the
           journal as ⌘Q and the red button do. */
        case 'quit':
          requestWindowClose()
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
    /* ⚠️ THE DIGITS READ THESE, AND THEY WERE MISSING — the same defect the
       tint note below records, on the day developer options landed. The handler
       went on closing over the visibility rules as they were when the effect
       last ran, so ⌘4 stayed dead for a whole render after Cards was revealed,
       and stayed live after it was hidden. */
    state.developer,
    state.hiddenPanes,
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
    /* ⌘[ AND ⌘] READ ALL FOUR OF THESE, and none was listed — so the handler
       closed over the jump stack as it stood when the effect last ran. Follow a
       link, then press ⌘[: whether it was offered at all came from a stale
       `canBack`, and `back` itself could be a function bound to a stack one
       jump behind. Exactly the `state.markTint` defect above, on a different
       object. */
    jumps,
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
            screens={composition.screens}
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
                bookActions={composition.bookActions}
              />
            )}
            {/* REMOVED BOOKS, over the shelf. On the library screen only:
                it lists what this device removed, and the shelf is where a
                reader notices one missing. Reached from ⌘K — "Removed books…",
                which also answers to deleted, restore and undo.

                IN `overlays`, WITH THE OTHER LAYERS, not beside `<Library>` in
                the shell's children. `WindowShell` marks that subtree `inert`
                when the pane is open on a narrow window — so the sheet
                rendered, took the scrim, and could not be clicked or focused,
                on the one surface whose entire purpose is a button that undoes
                a deletion. The jsdom tests could not see it: they mount the
                sheet directly and never build the shell around it. */}
            {state.screen === 'library' && state.trashOpen && (
              <TrashSheet
                rows={trashRows ?? []}
                loading={trashRows === null}
                /* The action's word wins: it is the newer answer, and it is
                   the one the reader just asked for. */
                error={restoreError ?? trashError}
                now={trashNow}
                onRestore={restoreBook}
                onDismiss={() => dispatch({ type: 'closeLayer', layer: 'trashOpen' })}
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
            onMarkFocusDone={marking.clearFocus}
            markControls={composition.markControls}
            selection={marking.selection?.text ?? null}
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
              persistent: settingsPersistent,
            }}
            /* ⚠️ **SUPPLIED ONLY WHILE DEVELOPER OPTIONS ARE ON**, so the band
               and the panel cannot come to disagree about whether they are
               showing: absence is the off state, in one place, rather than a
               boolean each surface reads for itself.

               `recording` is not the same question as `developer`. Recording is
               decided at boot by a FILE — see `diagnosticsLog.ts` — so a reader
               can have developer options on and an empty log, and the panel has
               to say which of the two it is looking at rather than drawing an
               empty list. */
            developer={{
              ...(diagnosticLog ? { log: diagnosticLog } : {}),
              /* NOT `state.developer`. Whether anything is RECORDING is decided
                 at boot by a file; whether the surfaces are DRAWN is
                 `state.developer`, which `paneFits` and the band both read.
                 Passing this unconditionally is what stops the two becoming two
                 answers to one question — see `SidePaneProps.developer`. */
              recording: diagnosticLog !== undefined,
              onCopy: writeClipboard,
              ...(onDiagnosticsCleared ? { onCleared: onDiagnosticsCleared } : {}),
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
          /* NOWHERE TO SEND A READER WITH NO MODEL BUT THE SETTINGS PANE, and
             that is the honest action rather than a placeholder: `inference`
             contributes its Local models section there, and a pane is the
             finest target the app has — there is no mechanism for opening a
             pane scrolled to one capability's section, and inventing one for a
             single caller would put a section id in the kernel, which is the
             thing `onInstallGloss` exists to avoid naming.

             PASSED UNCONDITIONALLY. `decideLookUp` needs `installable` as well
             as this, and only a build that composes `inference` has that — so
             on iOS and Android, where the composition is `[peer, sync]` and the
             port keeps its `NO_GLOSS` default, the button is still absent. */
          onInstallGloss={() => dispatch({ type: 'openPane', pane: 'settings' })}
          libraryCount={library.books.length}
          saveFailure={library.saveFailure}
          onDismissSaveFailure={library.dismissSaveFailure}
          /* WHAT AN IMPORT JUST DID, on the screen it was started from
             (WI-21.2). `marks:import` is in the palette while reading and only
             `Library` rendered this, so an import begun here reported into a
             surface the reader could not see — and Stage 1 refuses a
             name-matched book's marks, which is precisely the outcome that
             must not be silent.

             GATED ON THE SCREEN rather than passed through. The reader stays
             mounted UNDER the library (see the note beside it), so passing it
             unconditionally would put the same sentence in the tree twice —
             invisible behind the shelf, and read out loud by a screen reader.
             `Library` renders it for its own screen. */
          importNotice={state.screen === 'reader' ? importNotice : null}
          onDismissImportNotice={() => setImportNotice(null)}
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
          /* Whether a lookup found a real sentence or fell back — counted,
             never shown. See `ReaderProps.diagnostics`. */
          diagnostics={services.diagnostics}
          marks={marks}
          overlays={overlays}
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
          /* ⚠️ **ANY SCREEN THAT IS NOT THE READER, and this said
             `=== 'library'`.** With a third screen that test stopped meaning
             "somewhere else" and started meaning "the shelf" — so on a
             contributed screen the reader stayed live and visible UNDERNEATH
             it, which is exactly what the first circle screen looked like. */
          inert={state.screen !== 'reader'}
        />

        {/* ⚠️ **A CONTRIBUTED SCREEN REPLACES BOTH OF THE KERNEL'S**, which is
            what distinguishes it from a pane. `Reader` above stays mounted and
            inert the way it does for the library — the book keeps its position
            and its scroll — and the shelf simply does not draw. */}
        {isContributedScreenId(state.screen) &&
          (() => {
            const shown = composition.screens.find((one) => one.id === state.screen)
            /* ⚠️ **KEYED ON THE SCREEN, so two contributed screens are two
             * subtrees.** Without it React reconciles them as one whenever the
             * rendered component type matches — which it does for any two
             * capabilities drawing the same shape — and the second screen
             * inherits the first's form state and its `useEffect([])` lifetime.
             *
             * The renderer is NOT invoked here: `ContributedScreen` takes the
             * function and calls it below its own error boundary, so a
             * capability that throws does not unmount the window. Calling it
             * in this expression would put the throw above the boundary. */
            return (
              <ContributedScreen
                key={state.screen}
                label={shown?.label ?? 'Not here'}
                platform={platform}
                id={state.screen}
                {...(shown === undefined ? {} : { render: shown.render })}
                /* By id, because a screen knows a book by its id and nothing
                   else; the row is looked up here, where the shelf is.

                   OFFERED ONLY WHERE IT CAN OPEN ANYTHING. `openStored` returns
                   at once with no filesystem, and a contribution reads the
                   callback's presence to decide whether to draw an Open
                   control — `PaneContext.openBook` is optional for exactly
                   that. Handed over regardless, the browser client drew
                   links that silently did nothing. */
                {...(!fs
                  ? {}
                  : {
                      openBook: (bookId: string) => {
                        const entry = library.books.find((one) => one.bookId === bookId)
                        if (entry) openStored(entry)
                      },
                    })}
              />
            )
          })()}

        {state.screen === 'library' && (
          <Library
            coverFor={desktopCovers}
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
            saveFailure={library.saveFailure}
            onDismissSaveFailure={library.dismissSaveFailure}
            bootNotice={bootNotice}
            onDismissBootNotice={() => setBootNotice(null)}
            shelfUnread={shelfUnread}
            enriching={enrichment.pending}
            download={download}
            onAddBooks={addBooks}
            bookActions={composition.bookActions}
            bookStatuses={composition.bookStatuses}
          />
        )}

      </WindowShell>

    </>
  )
}
