import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

/* Fonts are bundled, never fetched. The design handoff is explicit: the
 * prototypes load these from a CDN for previewing only, and the app embeds
 * them. Literata is the default reading face (design system §14); the other
 * five reading faces are added with the typeface picker. */
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/crimson-pro'
import '@fontsource-variable/literata'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'

/* THE COMPOSITION ROOT. Two kernel entries and one composition, nothing
 * else: `./kernel` is the React-free public entry every capability sees too,
 * `./kernel/ui` is the UI entry only a composition root may import (it brings
 * the stylesheet with it), and `virtual:paper-composition` is THIS BUILD'S
 * platform composition — `src/app/composition.desktop.ts`, `.ios.ts` or
 * `.android.ts`, chosen once, at build time, by `vite.config.ts` from the
 * `TAURI_ENV_PLATFORM` the Tauri CLI sets (unset means desktop). Chosen by
 * resolution rather than by an `if` here so that the other two compositions,
 * and every capability only they import, never enter this build's module
 * graph; `assert-bundle` fails the build if one does. For `tsc` and
 * dependency-cruiser the specifier maps to the desktop file
 * (`tsconfig.base.json` `paths`): all three export the same shape.
 * `.dependency-cruiser.cjs` holds this file to exactly these imports. */
import { composeCapabilities, createKernelServices, defaultDiagnostics, kernelApi } from './kernel'
import {
  App,
  countingFs,
  emptyExpired,
  inTauri,
  installFatalHandlers,
  libraryFs,
  loadShelf,
  migrateToFolders,
  moment,
  onFirstPaint,
  openAppStorage,
  reportFs,
  reportStartup,
  summariseMigration,
  timed,
  watchFs,
  type IndexedBook,
} from './kernel/ui'
import { capabilities } from 'virtual:paper-composition'

installFatalHandlers()

const host = document.getElementById('root')
if (!host) throw new Error('#root is missing from index.html')

/* The store is read BEFORE the first render, and this is the reason boot is
 * asynchronous at all.
 *
 * The card and settings stores read their storage once, when the services are
 * built, so a store that arrived later would be a store the app never saw. Rendering
 * first and filling in afterwards is worse than a moment's delay either way:
 * every reader would get one frame of an empty shelf and an unannotated book.
 *
 * A failure here cannot stop the app — `openAppStorage` falls back rather than
 * throwing — so there is no error branch to render.
 *
 * An async function rather than a top-level await: TLA needs a build target
 * that supports it, and raising the target for the whole bundle to avoid four
 * lines here would be the wrong trade. */
async function boot(root: HTMLElement): Promise<void> {
  /* EVERY PHASE BELOW RUNS WHILE THE WINDOW IS BLANK, which is why they are
   * measured rather than reasoned about. Dev only, and gone from a build —
   * see `devTiming`. */
  const bootFrom = performance.now()
  /* FIRST, so the window's own cost is on the record before the app adds any of
   * its own. Everything above this line ran before `boot` was called at all. */
  reportStartup()
  const storage = await timed('open the store', () => openAppStorage())
  /* THE SHELF IS AWAITED TOO, for the same reason the store is: rendering first
   * and filling in afterwards gives every reader one frame of an empty library,
   * and this one would be a frame of "Your library is empty" over a full one.
   *
   * `loadShelf` reads the index — one file — or rescans when it is missing or
   * disagrees with the folders. Outside Tauri there is no filesystem and the
   * shelf starts empty, which is the honest answer in a browser. */
  /* COUNTED, in dev. The scan's own comment says the call count is the time the
   * window stays blank, so the count is the measurement that matters most here;
   * `countingFs` is the identity function in a build. */
  const fs = inTauri() ? countingFs(libraryFs) : null

  /* CARRY A PHASE-3 LIBRARY ACROSS, before the shelf is read.
   *
   * Before, because the shelf is built by scanning book folders and a book that
   * has not been migrated has no folder to find — so running it after would show
   * an empty library to a reader who has one, exactly once, which is precisely
   * the alarming failure this project has already produced.
   *
   * Awaited, unlike the trash sweep: this decides what the shelf contains.
   * Idempotent, so the second launch does almost nothing — it reads one record
   * per book and stops.
   *
   * Failure is SWALLOWED rather than fatal. A migration that cannot run leaves
   * the phase-3 files untouched, which is recoverable; refusing to start is not.
   */
  if (fs && storage) {
    try {
      /* PARSED SEPARATELY. One `try` around both meant a malformed marks value
       * stopped every valid library row migrating — and the migration itself
       * already treats unreadable marks as none, so the strict read was the only
       * thing standing between a reader and their books. */
      const outcomes = await timed('carry a legacy library across', () =>
        migrateToFolders(fs, {
        /* CHECKED, not asserted. `as []` told the compiler this was a list and
         * told the runtime nothing — so a store holding a valid JSON OBJECT
         * threw inside the migration and skipped every legacy book, which is
         * exactly the whole-or-nothing failure the separate parse above exists
         * to prevent. */
        rows: asRows(readJson(storage.getItem('paper.library.v1'), [])),
        marks: readJson(storage.getItem('paper.marks.v1'), []),
        }),
      )
      const said = summariseMigration(outcomes)
      if (said) console.info(`Paper: ${said}`)
    } catch (cause) {
      console.error('Paper: could not carry the previous library across', cause)
    }
  }
  /* A SHELF THAT WILL NOT LOAD IS NOT AN EMPTY SHELF, and the reader is told
   * which. Swallowing it drew "Your library is empty" over a library that is
   * still on disk — the single most alarming thing this app can say, produced by
   * a transient read. */
  let initialBooks: readonly IndexedBook[] = []
  let shelfUnread = false
  if (fs) {
    try {
      /* THE ANSWER TO "why is launch slow" IS USUALLY `rescanned`. A trusted
       * cache is one file read and one listing; a rescan is two round-trips per
       * book, and a library of a few thousand feels every one of them. If this
       * says `rescanned=true` on every launch, the cache is being distrusted
       * rather than the scan being slow, and that is a different bug. */
      const shelf = await timed('load the shelf', () => loadShelf(fs), (one) => ({
        books: one.books.length,
        rescanned: one.rescanned,
        why: one.why,
      }))
      initialBooks = shelf.books
    } catch (cause) {
      /* SAID, not swallowed. Logging it and carrying on with `[]` still drew
       * "Your library is empty" over a library that is sitting on disk, which is
       * the most alarming thing this app can say and the least true. The flag
       * travels so the screen can say "could not be read" instead. */
      console.error('Paper: could not read the library', cause)
      shelfUnread = true
    }
  }
  /* Emptied at BOOT, not on a timer and not when the reader removes something.
   *
   * It has to happen somewhere, and every other candidate is worse: a timer
   * deletes a reader's work while they are looking at the shelf, and doing it
   * during a removal makes an undoable action wait on unrelated disk work. At
   * launch nothing is waiting, and being a fortnight late is not a failure.
   *
   * Deliberately not awaited. A slow or failing sweep must not delay the window,
   * and `emptyExpired` errs towards keeping anything it cannot age. */
  if (fs) void emptyExpired(fs).catch(() => [])

  moment('everything before the first render', { ms: Math.round(performance.now() - bootFrom) })
  reportFs('filesystem, up to the first render')

  /* THE KERNEL'S SERVICES, built once, here — the composition root — over the
   * store and the shelf resolved above, and handed to the UI. The hooks are
   * adapters over these instances; a capability's service handler will hold
   * the same ones. The ports keep their defaults until a capability supplies
   * an implementation: no recorder journals, and diagnostics go to the console
   * in a dev build and nowhere in a release. */
  const services = createKernelServices({
    fs,
    storage,
    initialBooks,
    diagnostics: defaultDiagnostics(),
  })

  /* THE CAPABILITIES, composed onto those services — validated, ordered and
   * started before the first render, so the pane and the palette are complete
   * on the first frame rather than filling in. A capability whose START fails
   * is left out and the app runs without it (ADR 0001 Decision 9); a
   * composition that will not VALIDATE is a build defect and still reaches the
   * fatal handlers. `composition.failures` is what did not compose, and the
   * settings pane says so. */
  const lifetime = new AbortController()
  const composition = await composeCapabilities(capabilities, kernelApi(services), lifetime.signal)

  /* THE LIFETIME ENDS WITH THE PAGE, which nothing used to do.
   *
   * A reload builds a SECOND set of capabilities while the first is still
   * live, and the two overlap for as long as the old context takes to go
   * away. The sync journal is append-only with an in-memory sequence counter,
   * so two of them on one file is exactly how its sequence came to run
   * backwards — 203 violations, and a journal the next launch refused. Aborting
   * here runs each capability's teardown: sync unbinds the recorder at once, so
   * no further bracket reaches the old journal, and closes it behind the queue.
   *
   * `pagehide`, not `beforeunload`: it fires on a reload and on a navigation,
   * it does not ask to block the unload, and it is the event the platform
   * actually guarantees here. Idempotent — `dispose()` and the abort listener
   * both no-op after the first. */
  window.addEventListener('pagehide', () => lifetime.abort(), { once: true })

  createRoot(root).render(
    <StrictMode>
      <App services={services} fs={fs} shelfUnread={shelfUnread} composition={composition} />
    </StrictMode>,
  )

  /* AFTER THE FIRST PAINT, and after that whenever the filesystem moves. A
   * shelf that comes up quickly and then reads a thousand covers is slow in a
   * way no boot measurement can see. */
  onFirstPaint('the window drew its first frame', {
    ms: Math.round(performance.now() - bootFrom),
    books: initialBooks.length,
  })
  watchFs()
}

/** A legacy library value that is not a list is not a library. */
function asRows(value: unknown): [] {
  return (Array.isArray(value) ? value : []) as []
}

function readJson(raw: string | null, fallback: unknown): unknown {
  if (!raw) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

void boot(host)
