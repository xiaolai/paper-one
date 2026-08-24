import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

/* Fonts are bundled, never fetched — the same rule the desktop entry follows,
 * and here it is also a Content Security Policy question: `font-src 'self'`
 * refuses a CDN, and the policy is not negotiable because a book's HTML runs
 * in this origin. */
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/crimson-pro'
import '@fontsource-variable/literata'
import '@fontsource/ibm-plex-mono/400.css'

/* THE DESIGN SYSTEM'S VALUES, and only those. Importing `./kernel/ui` would
 * bring the whole reader — including `appStorage.ts`, `lookUp.ts` and the three
 * other modules that import `@tauri-apps`, none of which exist in a browser. So
 * this entry takes the stylesheet directly and nothing else, until the reader
 * itself is wired (WI-18.7 onward). */
import './kernel/ui/styles/tokens.css'
import './app/web/entry.css'

import { PairScreen } from './app/web/PairScreen'
import { checkSession, type SessionState } from './app/web/session'
import { capabilities } from 'virtual:paper-composition'

/**
 * THE BROWSER CLIENT'S COMPOSITION ROOT.
 *
 * A second entry rather than a branch inside `src/main.tsx`, for two reasons
 * that are both structural:
 *
 *   - **`main.tsx` is the Tauri webview's root.** It arms a shutdown handshake
 *     with the Rust shell, tears the sync journal down on `pagehide`, and
 *     migrates a legacy `localStorage` library. A browser has no shell, no
 *     journal and no legacy, so every one of those is dead code here — and the
 *     imports that carry them pull `@tauri-apps` into the bundle.
 *   - **`index.html` carries an inline script** for the first-paint hint, which
 *     would need `script-src 'unsafe-inline'`. That is precisely what the web
 *     host's policy refuses, so the web entry needs its own HTML anyway.
 *
 * ## What this build is, today
 *
 * The gate and nothing behind it. It asks the shelf whether this browser is
 * already connected, and shows the six-digit screen if not. **There is no
 * reader here yet**: the remote stores, the `Channel` over the frame socket and
 * the reading surface are WI-18.7 onward, and pretending otherwise with a
 * placeholder library would be the app describing a feature it does not have.
 */

function ConnectedPlaceholder({ onSignOut }: { readonly onSignOut: () => void }) {
  /* HONEST RATHER THAN DECORATIVE. This build genuinely has no reader, so it
   * says so instead of drawing an empty shelf that looks like a failed load.
   * §07's rule — a control that cannot act is the app describing a feature it
   * does not have — applies to whole screens too. */
  return (
    <main className="gate">
      <h1>Connected</h1>
      <p>
        This browser is paired with your library. The reading surface is not built yet — this
        build is the connection and the six-digit screen, nothing further.
      </p>
      <button type="button" onClick={onSignOut}>
        Disconnect this browser
      </button>
    </main>
  )
}

function Unreachable({ onRetry }: { readonly onRetry: () => void }) {
  /* NOT the code screen. A shelf that is asleep is a different problem from a
   * browser that was never paired, and offering six digits here would send
   * someone hunting for a screen that is not on. */
  return (
    <main className="gate">
      <h1>Your library is not answering</h1>
      <p>
        The computer holding your books may be asleep, or off the network. Paper does not keep a
        copy here, so there is nothing to read until it is back.
      </p>
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </main>
  )
}

function App() {
  const [state, setState] = useState<SessionState>({ kind: 'checking' })

  const refresh = useCallback(() => {
    setState({ kind: 'checking' })
    void checkSession().then(setState)
  }, [])

  useEffect(refresh, [refresh])

  const onSignOut = useCallback(() => {
    void import('./app/web/session').then(async ({ signOut }) => {
      await signOut()
      refresh()
    })
  }, [refresh])

  switch (state.kind) {
    case 'checking':
      /* Deliberately blank rather than a spinner. The check is one request to
       * the same origin; a spinner that flashes for 20ms is noise, and one
       * that persists means `unreachable` is about to be shown anyway. */
      return null
    case 'connected':
      return <ConnectedPlaceholder onSignOut={onSignOut} />
    case 'unreachable':
      return <Unreachable onRetry={refresh} />
    case 'needs-code':
      return <PairScreen onConnected={refresh} />
  }
}

/* THIS BUILD'S COMPOSITION, imported so the bundle actually contains it —
 * `assert-bundle` fails a build whose platform composition is missing, and it
 * caught this entry not having one.
 *
 * It is empty today, and composing an empty list is a no-op, so nothing here
 * calls `composeCapabilities`: that lives in `./kernel`, which reaches
 * `bookVault.ts` and `bookFiles.ts` and therefore `@tauri-apps`. Wiring it is
 * WI-18.7's job, together with the reader it exists to serve.
 *
 * So this is a GUARD rather than a decoration. The day a capability is added to
 * `composition.web.ts`, this throws instead of silently ignoring it — which is
 * the failure that would otherwise take an afternoon to find. */
if (capabilities.length > 0) {
  throw new Error(
    `Paper: composition.web.ts names ${capabilities.length} capability/capabilities ` +
      'and this entry does not compose any. Wire composeCapabilities here before adding one.',
  )
}

const root = document.getElementById('root')
if (root === null) throw new Error('Paper: no #root to mount into')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
