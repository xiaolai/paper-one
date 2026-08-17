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

import './styles/tokens.css'
import './styles/global.css'

import { App } from './App'
import { inTauri, openAppStorage } from './lib/appStorage'
import type { IndexedBook } from './lib/bookIndex'
import { loadShelf } from './lib/bookIndex'
import { emptyExpired } from './lib/bookTrash'
import { migrateToFolders, summariseMigration } from './lib/migrateToFolders'
import { libraryFs } from './lib/bookFiles'
import { installFatalHandlers } from './lib/reportFatal'

installFatalHandlers()

const host = document.getElementById('root')
if (!host) throw new Error('#root is missing from index.html')

/* The store is read BEFORE the first render, and this is the reason boot is
 * asynchronous at all.
 *
 * `useStoredCollection` reads its storage once, in a `useState` initialiser, so
 * a store that arrived later would be a store the app never saw. Rendering
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

  createRoot(root).render(
    <StrictMode>
      <App storage={storage} fs={fs} initialBooks={initialBooks} shelfUnread={shelfUnread} />
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
