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
import { openAppStorage } from './lib/appStorage'
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
  createRoot(root).render(
    <StrictMode>
      <App storage={storage} />
    </StrictMode>,
  )
}

void boot(host)
