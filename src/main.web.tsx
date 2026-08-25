import { StrictMode, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
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
/* THE APP'S BASE STYLESHEET. §02's typeface, §07's focus ring and disabled
 * convention, and the resets — all of it app-wide statements this client was
 * restating, worse, in a file of its own. `kernel/ui/index.ts` imports these
 * three the same way for the desktop build. */
import './kernel/ui/styles/global.css'
/* PAPER'S CONTROLS, not imitations of them. `.paper-cap-field`,
 * `.paper-cap-button` and the rest are the published vocabulary every
 * capability's UI already uses; the client styling its own input is how it came
 * to look like a web form dropped into Paper. */
import './kernel/ui/styles/capability.css'
import './app/web/entry.css'

import { PairScreen } from './app/web/PairScreen'
import { checkSession, type SessionState } from './app/web/session'
import { connect } from './app/web/channel'
import { createRemoteBooks, type RemoteBooks } from './app/web/books'
import { capabilities } from 'virtual:paper-composition'
/* DIRECTLY, not through `./kernel`. The barrel re-exports modules that import
 * `@tauri-apps`, so importing ANY symbol from it retains them — `assert-bundle`
 * refused a web bundle carrying three. `metrics.ts` itself has exactly one
 * import, type-only, so reaching it costs nothing: it is the design system's
 * geometry as plain arithmetic. `.dependency-cruiser.cjs` allows this one
 * module to a composition root, with that reason written beside the rule. */
import { applyMetrics } from './kernel/core/metrics'

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

/**
 * The shelf, over the channel.
 *
 * Opens one channel, reads `book.list` through it, and renders what comes back.
 * `useSyncExternalStore` is what `libraryStore`'s own hook uses on the desktop
 * side, for the same reason: the store owns the state and the view is an
 * adapter over `getSnapshot`/`subscribe`.
 */
function Shelf({ onSignOut }: { readonly onSignOut: () => void }) {
  const [books, setBooks] = useState<RemoteBooks | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    let opened: { channel: Awaited<ReturnType<typeof connect>>; store: RemoteBooks } | null = null
    void connect()
      .then((channel) => {
        if (!live) {
          channel.close()
          return
        }
        const store = createRemoteBooks(channel)
        opened = { channel, store }
        setBooks(store)
      })
      .catch((thrown: unknown) => {
        if (live) setFailed(thrown instanceof Error ? thrown.message : String(thrown))
      })
    return () => {
      live = false
      /* BOTH, and in this order. Disposing first stops a late answer waking a
       * listener that no longer has anywhere to render; closing after it means
       * the socket's own close cannot re-enter a store already gone. */
      opened?.store.dispose()
      opened?.channel.close()
    }
  }, [])

  if (failed !== null) {
    return (
      <main className="gate">
        <h1>Could not open a channel</h1>
        <p>{failed}</p>
        <button type="button" onClick={onSignOut}>
          Disconnect this browser
        </button>
      </main>
    )
  }

  if (books === null) return null
  return <ShelfList books={books} onSignOut={onSignOut} />
}

function ShelfList({ books, onSignOut }: { readonly books: RemoteBooks; readonly onSignOut: () => void }) {
  const rows = useSyncExternalStore(books.subscribe, books.getSnapshot)
  const status = useSyncExternalStore(books.subscribe, books.status)

  return (
    <main className="shelf">
      <header className="shelf-head">
        <h1>Library</h1>
        <span className="shelf-count">
          {status === 'loading' ? 'Loading…' : `${rows.length} ${rows.length === 1 ? 'book' : 'books'}`}
        </span>
      </header>

      {/* STALE IS SAID, NOT HIDDEN. The books on screen are real and no longer
          current; a reader deciding whether to trust a progress figure needs to
          know which. */}
      {status === 'stale' && (
        <p className="shelf-note">
          Your library stopped answering. These are the books as they were — nothing here is
          current until it is back.
        </p>
      )}

      {status === 'failed' && (
        <p className="shelf-note">Your library is not answering, and nothing was loaded.</p>
      )}

      <ul className="shelf-list">
        {rows.map((book) => (
          <li key={book.id} className="shelf-row">
            <span className="shelf-title">{book.title === '' ? 'Untitled' : book.title}</span>
            {book.author !== undefined && <span className="shelf-author">{book.author}</span>}
          </li>
        ))}
      </ul>

      {/* THE READER IS STILL NOT BUILT, and the shelf saying so beats a row
          that opens nothing. */}
      <p className="shelf-note">
        Opening a book is not built yet — this build lists the shelf and no more.
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
      return <Shelf onSignOut={onSignOut} />
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

/* THE GEOMETRY, before the first render.
 *
 * `capability.css` resolves `--control-sm`, `--radius-pill` and the rest from
 * these; unpublished they are undefined and every control silently loses its
 * size and shape. `App.tsx` does the same call for the desktop build.
 *
 * `'web'` is a real member of `Platform` rather than a lie told to get the
 * rest: a browser tab has no titlebar and no window controls, and the table
 * says so with zeros. */
applyMetrics(document.documentElement, 'web')

const root = document.getElementById('root')
if (root === null) throw new Error('Paper: no #root to mount into')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
