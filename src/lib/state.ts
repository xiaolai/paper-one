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

/** Topmost first — `dismissTop` walks this order so Esc peels one layer. */
const LAYER_ORDER = ['figureOpen', 'paletteOpen', 'switcherOpen', 'selectionOpen'] as const

/** Derived from LAYER_ORDER so the action types and the dismiss order cannot
 *  drift apart — adding a layer in one place now fails to compile in the other. */
export type Layer = (typeof LAYER_ORDER)[number]

export type Screen = 'library' | 'reader' | 'pdf' | 'cards'
export type Theme = 'paper' | 'slate' | 'sepia' | 'sage' | 'night'
/**
 * The seven panels of the single side pane.
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
  readonly figureOpen: boolean
  readonly selectionOpen: boolean
  /** Chrome fades to 0 and returns on pointer-near (§06). */
  readonly chromeOn: boolean
  readonly rulerOn: boolean
  readonly rulerPinned: boolean
  readonly ttsOn: boolean
  readonly stepIdx: number
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
  figureOpen: false,
  selectionOpen: false,
  chromeOn: false,
  rulerOn: false,
  rulerPinned: false,
  ttsOn: false,
  stepIdx: DEFAULT_STEP_IDX,
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
  | { type: 'toggleTts' }
  | { type: 'setStepIdx'; idx: number }
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

    case 'toggleLayer':
      return { ...state, [action.layer]: !state[action.layer] }

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

    case 'toggleTts':
      return { ...state, ttsOn: !state.ttsOn }

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

/** True when any dismissible layer is up — used to trap Esc and the scrim. */
export function hasOpenLayer(state: AppState): boolean {
  return LAYER_ORDER.some((layer) => state[layer])
}
