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
  emptyExpired,
  inTauri,
  installFatalHandlers,
  libraryFs,
  loadShelf,
  migrateToFolders,
  openAppStorage,
  summariseMigration,
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
  const storage = await openAppStorage()
  /* THE SHELF IS AWAITED TOO, for the same reason the store is: rendering first
   * and filling in afterwards gives every reader one frame of an empty library,
   * and this one would be a frame of "Your library is empty" over a full one.
   *
   * `loadShelf` reads the index — one file — or rescans when it is missing or
   * disagrees with the folders. Outside Tauri there is no filesystem and the
   * shelf starts empty, which is the honest answer in a browser. */
  const fs = inTauri() ? libraryFs : null

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
      const outcomes = await migrateToFolders(fs, {
        /* CHECKED, not asserted. `as []` told the compiler this was a list and
         * told the runtime nothing — so a store holding a valid JSON OBJECT
         * threw inside the migration and skipped every legacy book, which is
         * exactly the whole-or-nothing failure the separate parse above exists
         * to prevent. */
        rows: asRows(readJson(storage.getItem('paper.library.v1'), [])),
        marks: readJson(storage.getItem('paper.marks.v1'), []),
      })
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
      initialBooks = (await loadShelf(fs)).books
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
   * on the first frame rather than filling in. A capability that fails to
   * start is a build defect, not a runtime condition to soften: nothing stays
   * registered (the registry rolls back), the rejection reaches the fatal
   * handlers, and the reader sees why. The lifetime signal is the window's;
   * nothing aborts it today, and `dispose()` is what a close would call. */
  const lifetime = new AbortController()
  const composition = await composeCapabilities(capabilities, kernelApi(services), lifetime.signal)

  createRoot(root).render(
    <StrictMode>
      <App services={services} fs={fs} shelfUnread={shelfUnread} composition={composition} />
    </StrictMode>,
  )
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
