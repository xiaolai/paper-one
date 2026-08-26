import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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
 * this entry takes the stylesheets directly. The READER itself is reachable now
 * — `bookVault.ts`'s Tauri binding moved to `vaultFsTauri.ts`, which is what put
 * `FoliateView` back within a browser's reach — but the UI barrel still is not,
 * so `Reader.tsx` imports the component rather than the entry. */
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
import { connect, type ShelfChannel } from './app/web/channel'
import { asIndexedBook, createRemoteBooks, type RemoteBooks } from './app/web/books'
import { remoteContent, type RemoteContent } from './app/web/content'
import { remoteCovers } from './app/web/covers'
import { createRemoteMarks, type MarksStore } from './app/web/marks'
import { createRemoteCards, type CardsStore } from './app/web/cards'
import { TabBar, type Tab } from './app/web/shell/TabBar'
import { ContinueStrip } from './app/web/shell/ContinueStrip'
import { Reader } from './app/web/Reader'
import { capabilities } from 'virtual:paper-composition'
/* DIRECTLY, not through `./kernel`. The barrel re-exports modules that import
 * `@tauri-apps`, so importing ANY symbol from it retains them — `assert-bundle`
 * refused a web bundle carrying three. `metrics.ts` itself has exactly one
 * import, type-only, so reaching it costs nothing: it is the design system's
 * geometry as plain arithmetic. `.dependency-cruiser.cjs` allows this one
 * module to a composition root, with that reason written beside the rule. */
import { applyMetrics } from './kernel/core/metrics'
import { Cards, Library, Settings, offeredFaces, presentFaces } from './kernel/ui/browser'
import { WEB_SETTINGS, browserSettings } from './app/web/settings'
import type { BookAction, Card, IndexedBook } from './kernel'
import { readingStep, stepIndexForSize } from './kernel/core/metrics'

/**
 * The CAPABILITY-supplied entries in a book's row menu — none, here.
 *
 * ⚠️ **This was `['open', 'remove', 'tag', 'finish']`, four strings assigned to
 * an array of objects, and it did not compile.** Nothing said so, because
 * `src/main.web.tsx` was missing from `tsconfig.app.json`'s `files` and so was
 * never type-checked at all. `tsconfig.app.json` names it now.
 *
 * The four strings also described the wrong thing. `BookAction` is how a
 * CAPABILITY adds a row to that menu — sync's "Download" is one — and it
 * carries an `id`, a `label` and a predicate. The shelf's own controls (open,
 * remove, tag, finished) are not in this list on any host; they are drawn from
 * the `onOpen` / `onRemove` / `onSetFinished` callbacks, which is why leaving
 * those out is what actually removes them. This list said "the browser may
 * remove and tag" while being read as "no capability adds anything", and both
 * readings were wrong at once.
 *
 * Derived from `capabilities` rather than written as `[]`, so it stays right on
 * its own: `composition.web.ts` composes nothing today, and the day it composes
 * something this needs no edit. The desktop reaches the same list through
 * `composition.bookActions`.
 */
const WEB_BOOK_ACTIONS: readonly BookAction[] = capabilities.flatMap(
  (capability) => capability.bookActions ?? [],
)
const EMPTY_CARDS: readonly Card[] = []

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
 * The gate, the shelf, a book, and four tabs. It asks whether this browser is
 * connected, shows six digits if not, lists the library over one channel and
 * opens a book over the same one.
 *
 * ⚠️ THIS PARAGRAPH SAID "there are no settings, no marks, no search", and by
 * the time anyone read it the imports above named all three and the tabs below
 * rendered them. A description a file has grown past is worse than none: it is
 * what a reader trusts instead of scrolling.
 *
 * **It is a reader and not the app**, and what that now means precisely:
 * settings live in this browser's own storage rather than the desktop's
 * reducer; marks and cards are READ over the channel and never written, because
 * a browser session holds a read grant; and there is no reading aloud, no
 * ruler, and no local library — every book's bytes stay on the shelf.
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
  const [content, setContent] = useState<RemoteContent | null>(null)
  /* THE SAME SOCKET the listing and the bytes travel. The shelf's row verbs —
   * `book.set`, `tag.add`, `tag.remove` — go over it too, so a dropped
   * connection takes all three down together, which is the truth. */
  const [wire, setWire] = useState<ShelfChannel | null>(null)
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
        /* ONE CHANNEL, both uses. The shelf listing and a book's bytes travel
         * the same socket, so opening a book costs no second handshake and a
         * dropped connection takes both down together — which is the truth. */
        setContent(remoteContent(channel))
        setWire(channel)
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

  if (books === null || content === null || wire === null) return null
  return <ShelfList books={books} content={content} channel={wire} onSignOut={onSignOut} />
}

/**
 * The shelf — the kernel's own `Library` screen, not a copy of it (WI-19.7).
 *
 * ⚠️ **WHAT THIS REPLACED.** A hand-rolled list of `<button>` rows in
 * `entry.css`: no virtualisation for 1 961 books, no search, no filters, no
 * sort, no tags, no covers. Every one of those was already written and already
 * tested in `screens/Library.tsx`, which imports `VIRTUALISE_ABOVE` and
 * `gridWindow` — and was out of reach because `BookCover` imported
 * `tauriVaultFs`. One import.
 *
 * ## What a browser passes, and what it does not
 *
 * The screen takes plain props, so the difference between the two hosts is a
 * list of arguments rather than a second component. A browser has no local
 * files, so `onAddBooks` and `onAddFolder` do nothing and no import can be
 * running; it has no vault, so `coverFor` is absent and every jacket draws its
 * tint until `cover.read` exists (WI-19.8).
 *
 * The row verbs go over the channel to services the shelf has published all
 * along — `book.set`, `tag.add`, `tag.remove` — which the hand-rolled shelf
 * could not call because it had nowhere to call them from.
 */
function ShelfList({
  books,
  content,
  channel,
  onSignOut,
}: {
  readonly books: RemoteBooks
  readonly content: RemoteContent
  readonly channel: ShelfChannel
  readonly onSignOut: () => void
}) {
  const rows = useSyncExternalStore(books.subscribe, books.getSnapshot)
  const status = useSyncExternalStore(books.subscribe, books.status)
  const [reading, setReading] = useState<{ bookId: string; name: string } | null>(null)
  /**
   * THE FOUR TABS — Library · Reading · Cards · You. "The titlebar chip becomes
   * a tab": the open book is a peer of the shelf here, not a screen you leave
   * it for. Opening a book switches to Reading; the tab bar hides while a
   * book is open (the mockup's Reader has none) and Reading with no book open
   * goes to the shelf. `reading` survives a tab change, so Reading returns to
   * the page the reader left.
   */
  const [tab, setTab] = useState<Tab>('library')
  const [query, setQuery] = useState('')
  /**
   * LEAVING THE READER GOES BACK TO THE SHELF, and does not forget the book.
   *
   * ⚠️ This used to `setReading(null)` as well, which made the Reading tab
   * unreachable in every case it exists for. The tab bar is drawn only OUTSIDE
   * the reader, so `hasBook` was read exactly when `reading` had just been
   * cleared — always false — and `TabBar` redirects Reading to Library when it
   * is. The tab was permanently a second Library button.
   *
   * Keeping it is what "Reading" means: the book this reader is in the middle
   * of. Forgetting one is a separate act, and the effect below is the only
   * thing that performs it.
   */
  const close = useCallback(() => {
    setTab('library')
  }, [])

  /* A BOOK THAT LEFT THE SHELF IS NOT STILL BEING READ. `reading` outlives the
   * reader now (see `close`), so it needs the one thing that ends it: the book
   * no longer being there. Without this, removing the open book on the shelf
   * would leave a Reading tab that opens a book the shelf refuses. */
  useEffect(() => {
    if (reading === null) return
    if (rows.length === 0) return
    if (!rows.some((row) => row.bookId === reading.bookId)) setReading(null)
  }, [rows, reading])

  /* THE SAME ARRAY UNTIL THE ROWS CHANGE. `getSnapshot`'s whole contract is
   * identity stability, and mapping on every render would throw it away — the
   * shelf would re-render, and re-virtualise, for nothing. */
  const shelf = useMemo(() => rows.map(asIndexedBook), [rows])

  /* TITLES BY ID, for the reader's Notes pane: marks are cross-book and the
   * reading surface knows one book. A Map rather than a `find` per row —
   * `Marginalia` asks once per mark, and a linear scan of 1 961 rows per ask is
   * how a list of forty notes becomes eighty thousand comparisons. */
  const titles = useMemo(() => new Map(rows.map((r) => [r.bookId, r.title])), [rows])
  const titleOf = useCallback((id: string) => titles.get(id), [titles])

  const open = useCallback((entry: IndexedBook) => {
    setTab('reading')
    setReading({
      bookId: entry.bookId,
      /* THE NAME THE PARSER ROUTES ON. `content.locate` knows the stored
       * extension and the reader asks it; the title is what a person
       * recognises, so it carries both. */
      name: entry.title === '' ? 'book' : entry.title,
    })
  }, [])

  /* THE SHELF'S MUTATIONS ARE NOT COMPOSED HERE, and five of them used to be.
   *
   * `setFinished`, `tagBooks`, `untagBooks`, `removeBook` and `undoRemoveTag`
   * each wrapped a write — `book.set`, `tag.add`, `tag.remove`, `book.remove` —
   * and were handed to `Library`, which drew a control for every one. Not one
   * could succeed: a browser session holds a single grant and it is a READ one
   * (the webhost capability's pump sets out why at length). So the row menu
   * offered Remove and Mark as finished, the bulk bar offered both plus Tags…,
   * and each press applied optimistically, was refused, and undid itself. `send`
   * logged the refusal to a console no reader opens.
   *
   * `undoRemoveTag` went last and was the clearest case: with the tag editor no
   * longer drawn here, nothing could reach it — and it was ALSO wrong. It sent
   * `{ book, tag }` once per book, while `tag.add` declares `book` as a
   * `string[]` and batches. Dead code that is also incorrect is the worst of
   * both: nobody runs it, so nobody finds out, and it is waiting for whoever
   * re-enables the surface above it.
   *
   * `Library`'s write callbacks are optional now and absent means not drawn, so
   * deleting these deletes the controls rather than disabling them. **The day
   * the browser may write** is the day that grant is widened deliberately, and
   * they come back with it — correctly typed, against the table.
   */

  /* ONE BINDING PER CHANNEL, not one per render. `BookCover` lists `coverFor`
   * in its effect's dependencies, so a new identity would refetch and revoke an
   * object URL for every visible row on every render. */
  const covers = useMemo(() => remoteCovers(channel), [channel])

  /* ONE MARKS STORE PER CHANNEL. It reads every mark on the shelf on creation
   * — `mark.list` with no book — so building one per render would re-read the
   * whole shelf every time anything changed. */
  const [marks, setMarks] = useState<MarksStore | null>(null)
  useEffect(() => {
    const store = createRemoteMarks(channel)
    setMarks(store)
    return () => {
      store.dispose()
      setMarks(null)
    }
  }, [channel])
  const [cards, setCards] = useState<CardsStore | null>(null)
  useEffect(() => {
    const store = createRemoteCards(channel)
    setCards(store)
    return () => {
      store.dispose()
      setCards(null)
    }
  }, [channel])
  /* Cards re-renders when the store changes; subscribed here so the deck
   * itself stays a plain-props pane. */
  const cardRows = useSyncExternalStore(
    useCallback((l: () => void) => cards?.subscribe(l) ?? (() => {}), [cards]),
    useCallback(() => cards?.all ?? EMPTY_CARDS, [cards]),
  )

  /* THE READER'S PREFERENCES, for the You tab. One store, like `positions`. */
  const prefs = useRef<ReturnType<typeof browserSettings> | null>(null)
  prefs.current ??= browserSettings()
  const prefsStore = prefs.current
  useSyncExternalStore(prefsStore.subscribe, prefsStore.getSnapshot)
  const faces = useMemo(() => offeredFaces(presentFaces()), [])

  if (tab === 'reading' && reading !== null) {
    return (
      <Reader
        content={content}
        bookId={reading.bookId}
        name={reading.name}
        onClose={close}
        marks={marks}
        titleOf={titleOf}
      />
    )
  }

  const theme = prefsStore.get(WEB_SETTINGS.theme)
  const themeFollowsOs = prefsStore.get(WEB_SETTINGS.themeFollowsOs)

  return (
    <div className="web-shell">
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
        <p className="shelf-note">
          Nothing could be loaded. {books.reason() ?? 'Your library is not answering.'}
        </p>
      )}

      {tab === 'library' && (
        <div className="web-stage">
          {/* CONTINUE — the three most recently opened, as covers with a
              progress rule, above the full list. From the mockup. */}
          <ContinueStrip books={shelf} onOpen={open} coverFor={covers} />
          <div className="web-stage-list">
            <Library
              books={shelf}
              platform="web"
              /* Density, not absence: jackets arrive over `cover.read` now. Two
                 columns of 1 961 books on a 393px screen is a lot of scrolling. */
              defaultLayout="list"
              coverFor={covers}
              onOpen={open}
              /* NO `onRemove`, `onTagBooks`, `onUntagBooks` OR `onSetFinished`.
                 Each reaches a write — `book.remove`, `tag.add`, `tag.remove`,
                 `book.set` — and this session holds only `readingGrant`
                 (`capabilities/webhost/lib/pump.ts`). They were passed anyway,
                 so the row menu offered Remove, Tags… and Mark as finished, the
                 bulk bar offered all three over a selection, and every one of
                 them applied optimistically, was refused, and undid itself.
                 `Library` draws none of those controls without the callbacks.

                 `lastRemoval`/`onUndoRemoveTag` are gone with them: they are the
                 tag editor's undo, and the editor is not drawn here either. */
              importing={null}
              enriching={0}
              importNotice={null}
              shelfUnread={status === 'failed'}
              libraryQuery={query}
              onQueryChange={setQuery}
              bookActions={WEB_BOOK_ACTIONS}
              bookStatuses={[]}
            />
          </div>
        </div>
      )}

      {tab === 'cards' && (
        <div className="web-stage web-screen">
          <h1 className="web-screen-title">Cards</h1>
          {cards !== null && (
            <Cards
              /* NO `discard`: `card.remove` is `card:write` and this session
                 holds only `readingGrant`, so passing one would draw a delete
                 button that removes the card, is refused, and puts it back. */
              cards={{ all: cardRows, persistent: cards.persistent }}
              bookId={reading?.bookId ?? null}
              onShelf={() => false}
            />
          )}
        </div>
      )}

      {tab === 'you' && (
        <div className="web-stage web-screen">
          <h1 className="web-screen-title">You</h1>
          <Settings
            theme={theme}
            themeFollowsOs={themeFollowsOs}
            typeface={prefsStore.get(WEB_SETTINGS.typeface)}
            stepIdx={stepIndexForSize(prefsStore.get(WEB_SETTINGS.textSize))}
            spacing={prefsStore.get(WEB_SETTINGS.spacing)}
            align={prefsStore.get(WEB_SETTINGS.align)}
            style={prefsStore.get(WEB_SETTINGS.readingStyle)}
            offered={faces}
            sections={[]}
            onTheme={(next) => {
              prefsStore.set(WEB_SETTINGS.theme, next)
              prefsStore.set(WEB_SETTINGS.themeFollowsOs, false)
            }}
            onFollowOs={() => prefsStore.set(WEB_SETTINGS.themeFollowsOs, !themeFollowsOs)}
            onTypeface={(next) => prefsStore.set(WEB_SETTINGS.typeface, next)}
            onStepIdx={(next) => prefsStore.set(WEB_SETTINGS.textSize, readingStep(next).size)}
            onSpacing={(key, idx) =>
              prefsStore.set(WEB_SETTINGS.spacing, { ...prefsStore.get(WEB_SETTINGS.spacing), [key]: idx })
            }
            onAlign={(next) => prefsStore.set(WEB_SETTINGS.align, next)}
            onStyle={(key, value) =>
              prefsStore.set(WEB_SETTINGS.readingStyle, { ...prefsStore.get(WEB_SETTINGS.readingStyle), [key]: value })
            }
          />
          {/* DISCONNECT lives under You — it is about this device, which is
              what the tab is for. */}
          <button type="button" className="shelf-signout web-signout" onClick={onSignOut}>
            Disconnect this browser
          </button>
        </div>
      )}

      <TabBar active={tab} onSelect={setTab} hasBook={reading !== null} />
    </div>
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

  /**
   * WHICH SESSION CHECK IS THE CURRENT ONE.
   *
   * ⚠️ `refresh` runs on mount, on the Try again button, and after a sign-out,
   * and nothing sequenced them. `checkSession` is a network round trip, so the
   * one that STARTED first can FINISH last — and a reader who pairs
   * successfully, or signs out deliberately, watches the screen revert to
   * whatever an earlier check had found. Pressing Try again twice on a slow
   * shelf is enough to see it.
   *
   * A ref rather than state: the generation is not rendered, and bumping state
   * to track it would be a render per check.
   */
  const checking = useRef(0)

  const refresh = useCallback(() => {
    const mine = ++checking.current
    setState({ kind: 'checking' })
    void checkSession().then((next) => {
      if (mine === checking.current) setState(next)
    })
  }, [])

  useEffect(refresh, [refresh])

  /**
   * WHAT A FAILED SIGN-OUT LOOKS LIKE, which was nothing.
   *
   * The credential is an `HttpOnly` cookie, so this page cannot clear it. If
   * the POST does not reach the shelf — or the shelf declines it — the
   * credential stays good for its full ninety days while this screen returns to
   * the gate and every appearance is of having signed out. On a borrowed
   * laptop that is the one thing the reader most needs to be told.
   *
   * The screen still clears: the shelf is the authority and there is nothing
   * left here to show. What is added is saying so, and naming the one place
   * that can finish it.
   */
  const [signOutFailed, setSignOutFailed] = useState<string | null>(null)

  const onSignOut = useCallback(() => {
    void import('./app/web/session').then(async ({ signOut }) => {
      const result = await signOut()
      setSignOutFailed(result.kind === 'still-paired' ? result.why : null)
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
      return (
        <>
          {/* THE SIGN-OUT THAT DID NOT HAPPEN. Shown on the gate because that
              is where a reader lands after pressing it, and where "you are
              still paired" is the correction they need. */}
          {signOutFailed !== null && (
            <div className="gate-notice" role="alert">
              Signed out here, but the shelf did not confirm it ({signOutFailed}). This browser may
              still be paired — revoke it from Settings → Browsers on the shelf itself.
            </div>
          )}
          <PairScreen onConnected={refresh} />
        </>
      )
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
