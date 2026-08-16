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
import { loadShelf } from './lib/bookIndex'
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
  const initialBooks = fs ? (await loadShelf(fs).catch(() => ({ books: [] }))).books : []
  createRoot(root).render(
    <StrictMode>
      <App storage={storage} fs={fs} initialBooks={initialBooks} />
    </StrictMode>,
  )
}

void boot(host)
