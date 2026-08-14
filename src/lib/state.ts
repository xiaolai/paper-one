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
  | 'search'
  | 'stats'
  | 'import'
  | 'settings'
export type LibView = 'shelf' | 'wall' | 'index' | 'map'
export type CardView = 'wall' | 'deck' | 'thread' | 'map'
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
  readonly libView: LibView
  readonly cardView: CardView
  readonly paletteOpen: boolean
  readonly switcherOpen: boolean
  readonly figureOpen: boolean
  readonly selectionOpen: boolean
  /** Chrome fades to 0 and returns on pointer-near (§06). */
  readonly chromeOn: boolean
  readonly rulerOn: boolean
  readonly rulerPinned: boolean
  readonly ttsOn: boolean
  readonly bookmarkOn: boolean
  readonly stepIdx: number
  readonly pageLayout: PageLayout
  readonly noteIdx: number
  readonly openSection: string | null
}

export const initialState: AppState = {
  screen: 'reader',
  theme: 'paper',
  themeFollowsOs: true,
  pane: 'companion',
  lastPane: 'companion',
  side: 'right',
  libView: 'shelf',
  cardView: 'wall',
  paletteOpen: false,
  switcherOpen: false,
  figureOpen: false,
  selectionOpen: false,
  chromeOn: false,
  rulerOn: false,
  rulerPinned: false,
  ttsOn: false,
  bookmarkOn: false,
  stepIdx: DEFAULT_STEP_IDX,
  pageLayout: 'scrolled',
  noteIdx: 0,
  openSection: null,
}

export type Action =
  | { type: 'goScreen'; screen: Screen }
  | { type: 'setTheme'; theme: Theme; fromOs?: boolean }
  | { type: 'setThemeFollowsOs'; follows: boolean }
  | { type: 'openPane'; pane: PaneId }
  | { type: 'togglePane' }
  | { type: 'closePane' }
  | { type: 'setSide'; side: Side }
  | { type: 'setLibView'; view: LibView }
  | { type: 'setCardView'; view: CardView }
  | { type: 'toggleLayer'; layer: 'paletteOpen' | 'switcherOpen' | 'figureOpen' | 'selectionOpen' }
  | { type: 'closeLayer'; layer: 'paletteOpen' | 'switcherOpen' | 'figureOpen' | 'selectionOpen' }
  /** Esc dismisses the topmost layer only (§11 keyboard map). */
  | { type: 'dismissTop' }
  | { type: 'setChrome'; on: boolean }
  | { type: 'toggleRuler' }
  | { type: 'pinRuler' }
  | { type: 'toggleTts' }
  | { type: 'toggleBookmark' }
  | { type: 'setStepIdx'; idx: number }
  | { type: 'setPageLayout'; layout: PageLayout }
  | { type: 'setNoteIdx'; idx: number }
  | { type: 'toggleSection'; section: string }

/** Topmost first — `dismissTop` walks this order so Esc peels one layer. */
const LAYER_ORDER = ['figureOpen', 'paletteOpen', 'switcherOpen', 'selectionOpen'] as const

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

    case 'setLibView':
      return { ...state, libView: action.view }

    case 'setCardView':
      return { ...state, cardView: action.view }

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

    case 'toggleBookmark':
      return { ...state, bookmarkOn: !state.bookmarkOn }

    case 'setStepIdx':
      // Clamped rather than validated at the call site: the stepper, the
      // settings slider and the keyboard shortcut all feed this.
      return {
        ...state,
        stepIdx: Math.min(Math.max(action.idx, 0), READING_STEPS.length - 1),
      }

    case 'setPageLayout':
      // §06: the ruler does not exist in paginated flow, so switching layout
      // must take it down rather than leave a control pointing at nothing.
      return action.layout === 'paginated'
        ? { ...state, pageLayout: 'paginated', rulerOn: false, rulerPinned: false }
        : { ...state, pageLayout: 'scrolled' }

    case 'setNoteIdx':
      return { ...state, noteIdx: action.idx }

    case 'toggleSection':
      return {
        ...state,
        openSection: state.openSection === action.section ? null : action.section,
      }
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
