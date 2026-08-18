import { useCallback, useEffect, useReducer, type Dispatch } from 'react'
import { DEFAULT_STEP_IDX, READING_STEPS } from '../core/metrics'
import type { SettingsStore } from '../core/ports'
import { readKernelPreferences, writeKernelPreferences, type KernelPreferences } from '../core/settings'
import type { PaneContribution } from '../core/capability'
import { isContributedPaneId, type PageLayout, type PaneId, type Screen, type Side, type Theme, type Typeface } from '../core/uiTypes'

/**
 * Application state.
 *
 * Names follow design system §16: `isFoo` for a derived boolean, `fooOpen` for
 * a dismissible layer, `fooOn` for a feature the user switched on, `fooIdx`
 * for a cursor into a named list, and `verbFoo` for handlers. Keeping to it is
 * what makes the state readable next to the design.
 */

/**
 * Topmost first — `dismissTop` walks this order so Esc peels one layer.
 *
 * `figureOpen` and `selectionOpen` used to be here too. Nothing opened either
 * one and nothing rendered either one: they were §12's layer list transcribed
 * into state ahead of the surfaces that would use it, so Esc walked past two
 * layers that could not exist, and every guard elsewhere in the app had to name
 * them. A layer earns a place here when something raises it.
 */
const LAYER_ORDER = ['paletteOpen', 'switcherOpen'] as const

/** Derived from LAYER_ORDER so the action types and the dismiss order cannot
 *  drift apart — adding a layer in one place now fails to compile in the other. */
export type Layer = (typeof LAYER_ORDER)[number]

/**
 * The layers that take the whole window, of which at most one can be open.
 *
 * They were free to stack, and the result disagreed with itself: opening the
 * palette over the switcher left the switcher painted on top — it renders
 * later — while Esc closed the palette, because `dismissTop` walks
 * LAYER_ORDER and the palette is higher in it. So the layer the reader could
 * see was not the layer their keystrokes reached, and dismissing the one on
 * screen took two presses of Esc with nothing visibly happening on the first.
 *
 */
const MODAL_LAYERS: readonly Layer[] = ['paletteOpen', 'switcherOpen']

/* `Screen`, `Theme`, `Typeface`, `PaneId`, `Side` and `PageLayout` are
 * declared in `core/uiTypes` — with their reasoning — so that code with no
 * React in it can name them: a durable setting under `kernel.theme`, a pane a
 * capability contributes. Re-exported here, so nothing that named them through
 * this module has moved. */
export type { ContributedPaneId, KernelPaneId, PageLayout, PaneId, Screen, Side, Theme, Typeface } from '../core/uiTypes'

/**
 * What the reducer needs to know about a contributed pane: its id and the
 * screens it fits. `PaneContribution` carries both, so the composition's list
 * is passed as is; the reducer reads nothing else off it.
 */
export type ContributedPanes = readonly Pick<PaneContribution, 'id' | 'screens'>[]
const NO_CONTRIBUTED: ContributedPanes = []

export interface AppState {
  readonly screen: Screen
  readonly theme: Theme
  /** §05: the system follows the OS by default, with an override in Settings. */
  readonly themeFollowsOs: boolean
  readonly pane: PaneId | null
  /** Remembered so the pane toggle reopens what was last shown. */
  readonly lastPane: PaneId
  readonly side: Side
  readonly paletteOpen: boolean
  readonly switcherOpen: boolean
  /** Chrome fades to 0 and returns on pointer-near (§06). */
  readonly chromeOn: boolean
  readonly rulerOn: boolean
  readonly rulerPinned: boolean
  readonly stepIdx: number
  readonly typeface: Typeface
  /**
   * Whether the book's scrollbar is drawn. Off by default.
   *
   * Off hides the bar without disabling scrolling — the wheel, the trackpad,
   * Space and the arrow keys are all untouched, which is what makes this a
   * default rather than a removal.
   */
  readonly scrollbarOn: boolean
  /**
   * The progress rule down the reading area's leading edge. Off by default.
   *
   * Separate from `scrollbarOn` although both are edge marks, because they
   * answer different questions: a scrollbar says how much of THIS SECTION is
   * off screen, and this says how far through the BOOK you are. Turning one on
   * is not a reason to turn the other off.
   */
  readonly progressLineOn: boolean
  readonly pageLayout: PageLayout
  /**
   * What is typed in the library's search field — and therefore what the
   * shelf is scoped to, since `tag:` and `is:` live in the same string.
   *
   * IN APP STATE rather than local to the library screen, because two surfaces
   * write it: the field itself, and the Library panel in the side pane, whose
   * rows put `tag:` and `is:` terms into it. Local state in one component
   * cannot be written by a sibling, and a second copy in the pane would be the
   * hidden scope the whole `tag:` design exists to avoid — a filter the field
   * does not show.
   */
  readonly libraryQuery: string
}

export const initialState: AppState = {
  /**
   * THE LIBRARY, not the reader.
   *
   * Paper opened onto the reader, which for anyone not mid-book is an empty
   * screen offering to be given something — and it is the screen you get after
   * quitting with ten books on the shelf. The library is what the app has; show
   * it. The reader is where you go when you pick one.
   *
   * `?book=` overrides this at startup, because asking for a book IS picking
   * one — see `screenFor`. That is the only launch that arrives already knowing
   * what it wants.
   */
  screen: 'library',
  theme: 'paper',
  themeFollowsOs: true,
  pane: 'companion',
  lastPane: 'companion',
  side: 'right',
  paletteOpen: false,
  libraryQuery: '',
  switcherOpen: false,
  chromeOn: false,
  rulerOn: false,
  rulerPinned: false,
  stepIdx: DEFAULT_STEP_IDX,
  // §14's face, and the one the whole reading typography is specified around.
  typeface: 'literata',
  scrollbarOn: false,
  progressLineOn: false,
  pageLayout: 'scrolled',
}

export type Action =
  | { type: 'goScreen'; screen: Screen }
  | { type: 'setLibraryQuery'; query: string | ((prev: string) => string) }
  | { type: 'setTheme'; theme: Theme; fromOs?: boolean }
  | { type: 'setThemeFollowsOs'; follows: boolean }
  | { type: 'openPane'; pane: PaneId }
  | { type: 'togglePane' }
  | { type: 'closePane' }
  | { type: 'setSide'; side: Side }
  | { type: 'toggleLayer'; layer: Layer }
  | { type: 'closeLayer'; layer: Layer }
  /** Esc dismisses the topmost layer only (§11 keyboard map). */
  | { type: 'dismissTop' }
  | { type: 'setChrome'; on: boolean }
  | { type: 'toggleRuler' }
  | { type: 'pinRuler' }
  | { type: 'setStepIdx'; idx: number }
  | { type: 'setTypeface'; typeface: Typeface }
  | { type: 'toggleScrollbar' }
  | { type: 'toggleProgressLine' }
  | { type: 'setPageLayout'; layout: PageLayout }

/**
 * `contributed` is the panes the composition added — the reducer's fitting
 * rule (`paneFits`) has to know which screens they belong on, and a reducer
 * cannot read a registry. Defaulted to none, which is the kernel alone.
 */
export function reducer(state: AppState, action: Action, contributed: ContributedPanes = NO_CONTRIBUTED): AppState {
  switch (action.type) {
    case 'goScreen': {
      /* THE PANE FOLLOWS THE SCREEN. Three panels need an open book — see
       * `needsBook` — so arriving at the library on one of them shows a title
       * above an apology, and that was the default: the first thing Paper
       * offered a reader with a full shelf was a panel saying it was not
       * available.
       *
       * PREFERRED FROM `lastPane` rather than from the current panel, and left
       * alone. `lastPane` is the last panel the reader deliberately opened, so
       * asking it "does this screen have that" is how popping to the library for
       * a book and coming back returns you to Companion — rather than leaving
       * you on whatever the library substituted, which you never chose. */
      /* CLOSED STAYS CLOSED. `paneFor` answers "which panel", never "is the
       * pane open" — so asking it about a null pane would have opened one on
       * every screen change, which is the same conflation as a pane that shuts
       * itself, arriving from the other side. */
      const pane = state.pane === null ? null : paneFor(action.screen, state.lastPane, contributed)
      return { ...state, screen: action.screen, pane, switcherOpen: false, paletteOpen: false }
    }

    case 'setLibraryQuery': {
      /* A FUNCTIONAL update is resolved HERE, against the state the reducer
       * holds — not in a component against the value it rendered with. The
       * library screen adapted `setQuery((q) => …)` calls by applying them to
       * its own render-captured `libraryQuery`, so two updates in one batch
       * both read the same stale value and the second overwrote the first.
       * `useReducer` guarantees `state` is current; that is the whole reason
       * to put the resolution here. */
      const query = typeof action.query === 'function' ? action.query(state.libraryQuery) : action.query
      return state.libraryQuery === query ? state : { ...state, libraryQuery: query }
    }

    case 'setTheme':
      // An explicit pick in Settings turns off OS following; a change pushed by
      // the OS must not.
      return action.fromOs
        ? { ...state, theme: action.theme }
        : { ...state, theme: action.theme, themeFollowsOs: false }

    case 'setThemeFollowsOs':
      return { ...state, themeFollowsOs: action.follows }

    case 'openPane':
      /* Asking for a panel this screen does not have is not an error to report,
       * it is a request that cannot be honoured — from a ⌘-digit pressed on the
       * library, or a palette entry. The nearest thing it can mean is opening
       * the pane, so it opens on what the screen does offer. */
      return {
        ...state,
        pane: paneFor(state.screen, action.pane, contributed),
        lastPane: action.pane,
        paletteOpen: false,
      }

    case 'togglePane':
      return state.pane
        ? { ...state, pane: null }
        : { ...state, pane: paneFor(state.screen, state.lastPane, contributed) }

    case 'closePane':
      return { ...state, pane: null }

    case 'setSide':
      return { ...state, side: action.side }

    case 'toggleLayer': {
      // Closing needs no ceremony; opening a modal layer retires the others.
      if (state[action.layer]) return { ...state, [action.layer]: false }
      if (!MODAL_LAYERS.includes(action.layer)) return { ...state, [action.layer]: true }
      const closed = Object.fromEntries(MODAL_LAYERS.map((layer) => [layer, false]))
      return { ...state, ...closed, [action.layer]: true }
    }

    case 'closeLayer':
      return { ...state, [action.layer]: false }

    case 'dismissTop': {
      const top = LAYER_ORDER.find((layer) => state[layer])
      return top ? { ...state, [top]: false } : state
    }

    case 'setChrome':
      return { ...state, chromeOn: action.on }

    case 'toggleRuler':
      // Turning the ruler off also unpins it, so re-enabling starts from rest.
      return state.rulerOn
        ? { ...state, rulerOn: false, rulerPinned: false }
        : { ...state, rulerOn: true }

    case 'pinRuler':
      return { ...state, rulerPinned: true }

    case 'setStepIdx':
      // Clamped rather than validated at the call site: the stepper, the
      // settings slider and the keyboard shortcut all feed this.
      // Non-finite input is dropped rather than stored: `stepIdx` indexes
      // READING_STEPS, and NaN survives Math.min/Math.max unchanged, so the
      // old clamp let NaN straight through to the array lookup.
      if (!Number.isFinite(action.idx)) return state
      return {
        ...state,
        stepIdx: Math.min(Math.max(Math.round(action.idx), 0), READING_STEPS.length - 1),
      }

    case 'setTypeface':
      return { ...state, typeface: action.typeface }

    case 'toggleScrollbar':
      return { ...state, scrollbarOn: !state.scrollbarOn }

    case 'toggleProgressLine':
      return { ...state, progressLineOn: !state.progressLineOn }

    case 'setPageLayout':
      // §06: the ruler does not exist in paginated flow, so switching layout
      // must take it down rather than leave a control pointing at nothing.
      return action.layout === 'paginated'
        ? { ...state, pageLayout: 'paginated', rulerOn: false, rulerPinned: false }
        : { ...state, pageLayout: 'scrolled' }

  }
}

export type AppDispatch = Dispatch<Action>

/**
 * Which screen a launch starts on.
 *
 * A fact about HOW THE APP WAS OPENED rather than a preference, which is why it
 * is decided once here and not restored from anywhere: the library is the
 * answer unless the launch already named a book.
 *
 * Taking `search` rather than reading `window.location` keeps this testable and
 * keeps `state` a module that does not touch the DOM.
 */
/**
 * The panels that have nothing to show without an open book.
 *
 * Not a style question, and not a list anyone should keep a second copy of.
 * `Contents` lists the open book's own table of contents, `Companion` says as
 * much in its own subtitle — "grounded in this book only" — and `Search` takes
 * a `Book` and scans it. On the library screen all three are a title above an
 * apology, and the pane OPENED ONTO ONE OF THEM: the first thing Paper showed a
 * reader with a full shelf was a panel saying it was not available.
 *
 * Notes and Cards are deliberately absent from this list. Both are cross-book
 * by design — Notes shows every book's marks — and they are why the library has
 * a side pane at all rather than none.
 *
 * It lives here rather than in the pane registry because the ids are declared
 * here and the reducer below needs the same answer. The registry reads it.
 */
const BOOK_ONLY: readonly PaneId[] = ['toc', 'search', 'companion']

/**
 * The panels that mean something only on the SHELF.
 *
 * `library` is the collection view — scopes and counts over the shelf. In the
 * reader the shelf is hidden, so a panel that narrows it would be changing a
 * screen the reader cannot see; and with it merely permitted everywhere, a
 * launch onto the library left `lastPane` as `library`, which then followed
 * the reader into the first book they opened instead of yielding to
 * Companion. It also produced a palette entry "Open Library" beside "Go to the
 * library" on the reader — near-identical words, different actions.
 */
const SHELF_ONLY: readonly PaneId[] = ['library']

/**
 * Whether a panel has anything to show on this screen.
 *
 * A contributed pane fits where its contribution says (`screens`), and an id
 * no contribution claims — a pane from a capability that is not composed —
 * fits nowhere, so every path through the reducer lands on a panel that
 * exists. The kernel's own answer is the two lists above.
 */
export function paneFits(screen: Screen, pane: PaneId, contributed: ContributedPanes = NO_CONTRIBUTED): boolean {
  if (isContributedPaneId(pane)) {
    return contributed.some((entry) => entry.id === pane && entry.screens.includes(screen))
  }
  return screen === 'reader' ? !SHELF_ONLY.includes(pane) : !BOOK_ONLY.includes(pane)
}

/**
 * Which panel a screen opens on when the one that was wanted is not there.
 *
 * The library's answer is Library — the panel about the collection, which is
 * what the screen is. It used to be Notes, on the reasoning that Notes was
 * "the nearest thing to what Companion is for a book"; nearest was the tell.
 * The pane in the reader holds things about this book; on the shelf it should
 * hold things about this shelf, and now there is a panel that does.
 */
export function defaultPaneFor(screen: Screen): PaneId {
  return screen === 'reader' ? 'companion' : 'library'
}

/**
 * The panel to show, given a screen and the one that was wanted.
 *
 * Never null: this answers "which panel", not "is the pane open". The caller
 * holds the second question, and conflating them is how a reader ends up with a
 * pane that closes itself whenever they change screen.
 */
function paneFor(screen: Screen, wanted: PaneId | null, contributed: ContributedPanes): PaneId {
  if (wanted && paneFits(screen, wanted, contributed)) return wanted
  return defaultPaneFor(screen)
}

export function screenFor(search: string): Screen {
  return new URLSearchParams(search).get('book') ? 'reader' : 'library'
}

/**
 * The application state, with the durable half remembered.
 *
 * READ BEFORE THE FIRST RENDER, written on change. The nine preferences that
 * survive a launch — theme, face, size, layout, side, the three edge marks —
 * live in `AppState` while the app runs, because that is what every control
 * reads and every reducer case writes; the `SettingsStore` is where they go
 * between launches. `bootState` folds the stored values in, and the effect
 * below writes each change back. `set` on the store is by value, so a
 * re-render that changes nothing durable writes nothing.
 */
export function useAppState(settings: SettingsStore, contributed: ContributedPanes = NO_CONTRIBUTED): [AppState, AppDispatch] {
  /* The reducer closes over the contributed panes; the composition is static
   * for the app's lifetime, so this is built once. React reads the reducer
   * from the latest render either way. */
  const reduce = useCallback((state: AppState, action: Action) => reducer(state, action, contributed), [contributed])
  const [state, dispatch] = useReducer(
    reduce,
    bootState(typeof window === 'undefined' ? '' : window.location.search, readKernelPreferences(settings)),
  )
  const prefs = preferencesOf(state)
  useEffect(() => {
    try {
      writeKernelPreferences(settings, prefs)
    } catch (cause) {
      // Reported, not fatal: a preference that will not persist is a
      // preference the reader chooses again next launch, and the store
      // itself says why (`fileStore` reports a failed disk write).
      console.error('Paper: could not save a preference', cause)
    }
  }, [
    settings,
    prefs.theme,
    prefs.themeFollowsOs,
    prefs.typeface,
    prefs.stepIdx,
    prefs.pageLayout,
    prefs.side,
    prefs.rulerOn,
    prefs.scrollbarOn,
    prefs.progressLineOn,
  ])
  return [state, dispatch]
}

/** The durable half of the state, in the shape the settings store takes. */
export function preferencesOf(state: AppState): KernelPreferences {
  return {
    theme: state.theme,
    themeFollowsOs: state.themeFollowsOs,
    typeface: state.typeface,
    stepIdx: state.stepIdx,
    pageLayout: state.pageLayout,
    side: state.side,
    rulerOn: state.rulerOn,
    scrollbarOn: state.scrollbarOn,
    progressLineOn: state.progressLineOn,
  }
}

/**
 * The state a launch starts in — the screen, and a panel that belongs on it.
 *
 * THE PANE HAS TO BE FITTED HERE TOO, and forgetting that undid the whole
 * point. `paneFor` runs on transitions, so a reducer that moves you off
 * Companion when you walk to the library does nothing about ARRIVING there:
 * Paper opens on the library, `initialState.pane` was Companion, and the first
 * thing a reader saw was the panel saying it was not available. The one moment
 * it mattered most was the one moment nothing checked.
 *
 * Exported because it is the honest thing to test — a reducer case cannot show
 * that the state a launch begins in is coherent.
 */
export function bootState(search: string, remembered: Partial<KernelPreferences> = {}): AppState {
  const screen = screenFor(search)
  const pane = paneFits(screen, initialState.pane ?? defaultPaneFor(screen))
    ? initialState.pane
    : defaultPaneFor(screen)
  const prefs = { ...preferencesOf(initialState), ...remembered }
  /* THE SAME RULE THE REDUCER KEEPS: paginated flow has no ruler (§06). Two
   * stored values can disagree — the layout written after the ruler — and a
   * launch must not start in a state no sequence of actions can reach. */
  const rulerOn = prefs.pageLayout === 'paginated' ? false : prefs.rulerOn
  return {
    ...initialState,
    ...prefs,
    rulerOn,
    screen,
    pane,
    lastPane: pane ?? initialState.lastPane,
  }
}

/**
 * True when any dismissible layer is up.
 *
 * Exported for the guards that must not act through an overlay — the reading
 * keys in App and the ruler's Space in ReadingRuler. Both used to list the
 * layers by hand, which is how they came to name two that no longer exist.
 */
export function hasOpenLayer(state: AppState): boolean {
  return LAYER_ORDER.some((layer) => state[layer])
}
