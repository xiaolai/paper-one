import { useReducer, type Dispatch } from 'react'
import { DEFAULT_STEP_IDX, READING_STEPS } from './metrics'

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

/**
 * The two screens there are.
 *
 * `pdf` and `cards` were here and unreachable: a PDF is opened by the reader
 * like any other book — that is the whole point of `makePdf` — and cards are a
 * panel of the side pane, not a screen. They cost more than a dead branch,
 * because a predicate that names one drifts from a predicate that does not:
 * the titlebar counted `pdf` as a reading screen while the chrome fade beside
 * it did not, so the two disagreed about what the reader was looking at.
 */
export type Screen = 'library' | 'reader'
export type Theme = 'paper' | 'slate' | 'sepia' | 'sage' | 'night'

/**
 * The face the BOOK is set in. Interface type never changes — §09 is explicit
 * that it does not scale or vary with the reading settings.
 *
 * Exactly the four families `main.tsx` bundles, and no more. A fifth entry here
 * would name a family no `@font-face` rule describes, and an unknown family is
 * not an error — it is silently the next entry in the fallback chain, which is
 * how every book rendered in Georgia for a month while claiming Literata.
 */
export type Typeface = 'literata' | 'crimson' | 'instrument' | 'plex'
/**
 * The panels of the single side pane — see `lib/panes` for their metadata.
 *
 * Contents and Companion used to live in a separate 340px leading card, which
 * meant two surfaces competing for the same job. One pane holds every tool;
 * the reader stays the only permanent full-width surface.
 *
 * `notes` and `import` rather than "annotation" and "add": §15's lexicon is
 * explicit that the word is Note, not annotation, and the pane title is
 * "Add books".
 */
export type PaneId =
  | 'toc'
  | 'companion'
  | 'notes'
  | 'cards'
  | 'search'
  | 'stats'
  | 'import'
  | 'settings'
export type Side = 'left' | 'right'

/**
 * §06: the reading ruler is scrolled-flow only. In paginated mode there are no
 * lines to advance, so Space is next page and the ruler control is hidden —
 * hidden, not disabled.
 */
export type PageLayout = 'scrolled' | 'paginated'

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
}

export const initialState: AppState = {
  screen: 'reader',
  theme: 'paper',
  themeFollowsOs: true,
  pane: 'companion',
  lastPane: 'companion',
  side: 'right',
  paletteOpen: false,
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

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'goScreen':
      return { ...state, screen: action.screen, switcherOpen: false, paletteOpen: false }

    case 'setTheme':
      // An explicit pick in Settings turns off OS following; a change pushed by
      // the OS must not.
      return action.fromOs
        ? { ...state, theme: action.theme }
        : { ...state, theme: action.theme, themeFollowsOs: false }

    case 'setThemeFollowsOs':
      return { ...state, themeFollowsOs: action.follows }

    case 'openPane':
      return { ...state, pane: action.pane, lastPane: action.pane, paletteOpen: false }

    case 'togglePane':
      return state.pane
        ? { ...state, pane: null }
        : { ...state, pane: state.lastPane }

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

export function useAppState(): [AppState, AppDispatch] {
  return useReducer(reducer, initialState)
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
