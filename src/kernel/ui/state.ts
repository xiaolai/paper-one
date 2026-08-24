import { useCallback, useEffect, useReducer, type Dispatch } from 'react'
import type { MarkStyle, MarkTint } from '../core/marks'
import { BRIGHTNESS, CONTRAST, DEFAULT_READING_STYLE, DEFAULT_STEP_IDX, FIGURE_HEIGHTS, FIGURE_WIDTHS, MINIMUM_SIZES, READING_STEPS, SPACING, readingStep, stepIndexForSize, type SpacingScale } from '../core/metrics'
import type { SettingsStore } from '../core/ports'
import { readKernelPreferences, writeKernelPreferences, type KernelPreferences } from '../core/settings'
import type { PaneContribution } from '../core/capability'
import { isContributedPaneId, type Align, type PageLayout, type PaneId, type ReadingStyle, type ReadingStyleKey, type Screen, type Side, type SpacingIndices, type SpacingKey, type Theme, type Typeface } from '../core/uiTypes'

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
/* `tagsOpen` is the tag editor as a sheet over the reader — the shelf opens
 * the same editor as a popover, which is not a layer because it is dismissed
 * by its own click-outside and never takes the window. */
/* `trashOpen` is the removed-books sheet. It EARNED its place the day the
   app could remove a book but not un-remove one: `book.restore` and
   `trash.list` had existed as services and CLI verbs since phase 11, and the
   remove confirmation promised recovery "for two weeks", while no surface in
   the app could perform it. A promise printed on screen that only a terminal
   can keep is not a promise. */
const LAYER_ORDER = ['paletteOpen', 'switcherOpen', 'tagsOpen', 'trashOpen'] as const

/** Derived from LAYER_ORDER so the action types and the dismiss order cannot
 *  drift apart — adding a layer in one place now fails to compile in the other. */
export type Layer = (typeof LAYER_ORDER)[number]

/**
 * Every layer, shut — derived from the one list rather than typed out again.
 *
 * `goScreen` used to repeat each field by hand, so `LAYER_ORDER` was the
 * declared source of truth for the DISMISS ORDER while the closing was a
 * second list beside it. A layer added to one and not the other compiles, and
 * the symptom is a sheet about the shelf still hanging over the reader.
 */
const ALL_LAYERS_SHUT = Object.fromEntries(LAYER_ORDER.map((layer) => [layer, false])) as Record<
  Layer,
  false
>

/* AT MOST ONE LAYER IS OPEN — enforced in `toggleLayer`, over the whole of
 * LAYER_ORDER. There used to be a second list of "modal" layers beside this
 * one, byte-identical to it, because they were once free to stack and the
 * result disagreed with itself: opening the palette over the switcher left
 * the switcher painted on top while Esc closed the palette. Two identical
 * lists are one list — the day a genuinely non-modal layer arrives, it gets
 * its own list and its own reasoning. */

/* `Screen`, `Theme`, `Typeface`, `PaneId`, `Side` and `PageLayout` are
 * declared in `core/uiTypes` — with their reasoning — so that code with no
 * React in it can name them: a durable setting under `kernel.theme`, a pane a
 * capability contributes. Re-exported here, so nothing that named them through
 * this module has moved. */
export type {
  Align, CodeFace, CodeWrap, ContributedPaneId, Fidelity, FigureFrame, Flourish,
  HeadingScale, KernelPaneId, NoteSize, PageLayout, PaneId, QuoteStyle, ReadingStyle,
  ReadingStyleKey, Screen, Separation, Side, SpacingIndices, SpacingKey, TableFit,
  Theme, Typeface,
} from '../core/uiTypes'

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
  /** The tag editor over the reader's current book, as a sheet — ⌘T. */
  readonly tagsOpen: boolean
  /** Removed books, with what is left of their fortnight — see LAYER_ORDER. */
  readonly trashOpen: boolean
  /** Chrome fades to 0 and returns on pointer-near (§06). */
  readonly chromeOn: boolean
  readonly rulerOn: boolean
  readonly rulerPinned: boolean
  readonly stepIdx: number
  /**
   * How open the reader wants the type: letter, word, line and paragraph, each
   * an index into its own scale in `SPACING`.
   *
   * Indices rather than values, exactly like `stepIdx`: the steps are the
   * decision and a stored value would let a build with a different scale
   * resolve to something between two of them. Grouped rather than four fields
   * because they are one thing a reader adjusts together, and because the
   * reducer can then take one action for all four.
   */
  readonly spacing: SpacingIndices
  /** Justified, or flush to the reading edge — see `Align`. */
  readonly align: Align
  /**
   * How much of the theme's light the app emits, and how hard the text sits on
   * it — indices into `BRIGHTNESS` and `CONTRAST`.
   *
   * Independent of the system, which is the point: a reader dimming their whole
   * display to read at night dims everything else with it, and turning the
   * display back up to answer a message undoes the reading setting. This is the
   * app's own.
   */
  readonly brightness: number
  readonly contrast: number
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
  /**
   * The appearance the next mark gets — the tint chosen in the selection bar,
   * and whether it lays down a band or a rule.
   *
   * IN APP STATE rather than local to the bar, because the bar is unmounted
   * between selections. Kept there it would reset to yellow on every gesture,
   * which is the opposite of what a colour scheme is for: a reader who marks
   * questions in purple wants the NEXT question in purple too, without
   * re-choosing. ⌘D and the palette's "Mark this passage" read the same two
   * values, so a mark made by keyboard and a mark made by pointer cannot come
   * out looking different.
   *
   * Not persisted across launches — like `theme`, `stepIdx` and every other
   * reading setting here, which is a gap this state has had all along rather
   * than one these two fields introduce.
   */
  readonly markTint: MarkTint
  readonly markStyle: MarkStyle
  /**
   * How the book is SET — WI-14.4's fifteen, the fidelity dial among them.
   *
   * ONE FIELD RATHER THAN FIFTEEN, exactly as `spacing` is one rather than
   * four, and for the same two reasons: a reader adjusts them together, and the
   * reducer takes one action for all of them instead of fifteen near-identical
   * branches that would each have to remember the same clamping trap.
   *
   * Every default is what Paper rendered before the settings existed — see
   * `DEFAULT_READING_STYLE`, which is where that promise is kept and where a
   * test holds it.
   */
  readonly readingStyle: ReadingStyle
}

/**
 * The seed `bootState` starts from — and COHERENT ON ITS OWN TERMS: its pane
 * fits its screen. It carried `pane: 'companion'` beside `screen: 'library'`
 * for a while, a pairing `paneFits` rejects, on the reasoning that only
 * `bootState` ever read it — which was true right up until anything else did,
 * and tests already do. `bootState` still owns fitting the pane to whatever
 * screen the launch actually lands on; `?book=` boots land on the reader and
 * take its default panel through `paneFor`.
 */
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
  /* The screen's own panel — `paneFits('library', 'library')` holds, so the
   * seed is a legal state. A reader boot swaps both through `paneFor`. */
  pane: 'library',
  lastPane: 'library',
  side: 'right',
  paletteOpen: false,
  libraryQuery: '',
  switcherOpen: false,
  trashOpen: false,
  tagsOpen: false,
  chromeOn: false,
  rulerOn: false,
  rulerPinned: false,
  stepIdx: DEFAULT_STEP_IDX,
  // §14's face, and the one the whole reading typography is specified around.
  typeface: 'literata',
  /* Every spacing at its own default, which is the book exactly as it reads
     today — a reader who never opens these gets no change. */
  spacing: {
    letter: SPACING.letter.def,
    word: SPACING.word.def,
    line: SPACING.line.def,
    paragraph: SPACING.paragraph.def,
  },
  /* Justified, which is what the book has always been set as. */
  align: 'justified',
  /* The theme exactly as designed, until a reader says otherwise. */
  brightness: BRIGHTNESS.def,
  contrast: CONTRAST.def,
  scrollbarOn: false,
  progressLineOn: false,
  pageLayout: 'scrolled',
  markTint: 'yellow',
  markStyle: 'fill',
  /* The book exactly as it reads today — a reader who never opens any of these
     gets no change. Imported rather than restated, so the seed and the
     stylesheet's own defaults cannot come to disagree. */
  readingStyle: DEFAULT_READING_STYLE,
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
  | { type: 'setSpacing'; key: SpacingKey; idx: number }
  | { type: 'setAlign'; align: Align }
  | { type: 'setBrightness'; idx: number }
  | { type: 'setContrast'; idx: number }
  | { type: 'setTypeface'; typeface: Typeface }
  | { type: 'toggleScrollbar' }
  | { type: 'toggleProgressLine' }
  | { type: 'setPageLayout'; layout: PageLayout }
  | { type: 'setMarkTint'; tint: MarkTint }
  | { type: 'setMarkStyle'; style: MarkStyle }
  /**
   * One action for all fifteen — see `readingStyle`.
   *
   * GENERIC IN THE KEY, so the value is checked against the key's own type: a
   * `separation` of `'shadow'` is a compile error rather than a state that
   * reaches the stylesheet and silently matches no rule.
   */
  | {
      [K in ReadingStyleKey]: { type: 'setReadingStyle'; key: K; value: ReadingStyle[K] }
    }[ReadingStyleKey]

/**
 * An index into a scale of `length` steps, or null for input that must not
 * reach an array lookup.
 *
 * ONE FUNCTION, because four reducer branches each restated it and each had
 * to remember the same trap: NaN survives `Math.min`/`Math.max` unchanged, so
 * a clamp without the finite check let NaN straight through to the lookup.
 */
/**
 * Which of `ReadingStyle`'s fifteen are INDICES into a scale.
 *
 * A table rather than a condition in the reducer, so adding a scaled setting is
 * one line here and forgetting to clamp it is not possible in the other
 * direction — an unlisted key is a closed set the compiler already checked.
 */
const READING_STYLE_SCALES: Partial<Record<ReadingStyleKey, SpacingScale>> = {
  figureWidth: FIGURE_WIDTHS,
  figureHeight: FIGURE_HEIGHTS,
  minimumSize: MINIMUM_SIZES,
}

function scaleIndex(idx: number, length: number): number | null {
  if (!Number.isFinite(idx)) return null
  return Math.min(Math.max(Math.round(idx), 0), length - 1)
}

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
      return {
        ...state,
        screen: action.screen,
        pane,
        /* A SCREEN CHANGE CLOSES EVERY LAYER — all of them, from the list that
           also decides the dismiss order, so a layer added later cannot be
           added to one and forgotten in the other. */
        ...ALL_LAYERS_SHUT,
      }
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
      /* Closing needs no ceremony; opening retires the others. Every layer is
       * modal today, so there is no non-modal branch — one existed, guarded on
       * a membership test that could not fail, which is the kind of branch that
       * looks exercised and never runs. If a non-modal layer ever arrives, it
       * gets its own list and this comment stops being true loudly. */
      if (state[action.layer]) return { ...state, [action.layer]: false }
      const closed = Object.fromEntries(LAYER_ORDER.map((layer) => [layer, false]))
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
      /* §06: THE RULER IS SCROLLED-FLOW ONLY. The palette already omits the
       * command in paginated mode, but the reducer is the boundary every
       * dispatcher crosses, and a guard that lives only in one caller is a
       * guard the next caller has to remember — `setPageLayout` clears the
       * ruler on the way out for exactly this invariant. */
      if (state.pageLayout !== 'scrolled') return state
      // Turning the ruler off also unpins it, so re-enabling starts from rest.
      return state.rulerOn
        ? { ...state, rulerOn: false, rulerPinned: false }
        : { ...state, rulerOn: true }

    case 'pinRuler':
      // Pinning a ruler that is not there would leave a pin waiting to apply
      // to the next ruler — a state nothing chose and nothing draws.
      return state.rulerOn ? { ...state, rulerPinned: true } : state

    case 'setStepIdx': {
      // Clamped rather than validated at the call site: the stepper, the
      // settings slider and the keyboard shortcut all feed this.
      const stepIdx = scaleIndex(action.idx, READING_STEPS.length)
      return stepIdx === null ? state : { ...state, stepIdx }
    }

    case 'setSpacing': {
      const idx = scaleIndex(action.idx, SPACING[action.key].steps.length)
      if (idx === null || state.spacing[action.key] === idx) return state
      return { ...state, spacing: { ...state.spacing, [action.key]: idx } }
    }

    /**
     * One branch for all fifteen — see `readingStyle`.
     *
     * THE THREE INDEX FIELDS ARE CLAMPED AND THE REST ARE NOT, and the
     * difference is what each one is. `figureWidth`, `figureHeight` and
     * `minimumSize` are positions in a scale, and a stale index from a build
     * with a shorter scale reaches an array lookup — the trap `setSpacing`
     * documents, where `undefined` arrives at the stylesheet as the string
     * "undefined". The other twelve are closed sets the compiler checks at the
     * call site, so there is nothing left for a clamp to do.
     *
     * SAME STATE WHEN NOTHING MOVED, exactly as `setSpacing` returns, and this
     * one earns its keep: `readingStyle` is a dependency of the effect that
     * re-applies the reader's settings to the book, and a new object identity
     * for an unchanged setting would re-run it on every dispatch.
     */
    case 'setReadingStyle': {
      const scale = READING_STYLE_SCALES[action.key]
      const value =
        scale === undefined ? action.value : scaleIndex(action.value as number, scale.steps.length)
      if (value === null || state.readingStyle[action.key] === value) return state
      return { ...state, readingStyle: { ...state.readingStyle, [action.key]: value } }
    }

    case 'setBrightness':
    case 'setContrast': {
      const key = action.type === 'setBrightness' ? 'brightness' : 'contrast'
      const scale = action.type === 'setBrightness' ? BRIGHTNESS : CONTRAST
      const idx = scaleIndex(action.idx, scale.steps.length)
      return idx === null || state[key] === idx ? state : { ...state, [key]: idx }
    }

    case 'setAlign':
      return state.align === action.align ? state : { ...state, align: action.align }

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

    /* Two settings rather than one `appearance`, because the reader changes
       them independently and a combined action would make every tint click
       restate the style — which is how a toggle silently resets. */
    case 'setMarkTint':
      return { ...state, markTint: action.tint }

    case 'setMarkStyle':
      return { ...state, markStyle: action.style }

  }
}

export type AppDispatch = Dispatch<Action>

/**
 * A `setReadingStyle` action, with the key and the value checked against each
 * other.
 *
 * THE CAST IS HERE AND NOWHERE ELSE, and it is a limit of the type system
 * rather than a shortcut. `Action` distributes over the fifteen keys so the
 * REDUCER can narrow `value` from `key` — which is the property worth having,
 * because it is what makes a `separation` of `'shadow'` a compile error. What
 * TypeScript cannot then prove is that a `{ key: K; value: ReadingStyle[K] }`
 * built from a generic `K` is one of those fifteen members, though it is one by
 * construction. Every call site stays type-checked; this one function absorbs
 * the gap, with the assertion written down.
 */
export function setReadingStyle<K extends ReadingStyleKey>(
  key: K,
  value: ReadingStyle[K],
): Action {
  return { type: 'setReadingStyle', key, value } as Action
}

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
 * Marginalia and Cards are deliberately absent. Both are cross-book by design —
 * Marginalia shows every book's marks, notes and places — and they are why the
 * library has a side pane at all rather than none. Places were briefly a
 * book-only panel of their own; folding them into Marginalia is what let them
 * off this list, and the "This book" chip is how a reader narrows to one.
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
 * READ BEFORE THE FIRST RENDER, written on change. The fifteen preferences
 * that survive a launch — theme, face, size, spacing, alignment, brightness,
 * contrast, layout, side, the three edge marks and the mark's own tint and
 * style — live in `AppState` while the app runs, because that is what every
 * control reads and every reducer case writes; the `SettingsStore` is where
 * they go between launches. `bootState` folds the stored values in, and the
 * effect below writes each change back. `set` on the store is by value, so a
 * re-render that changes nothing durable writes nothing.
 *
 * THE SETTINGS ARRIVE BEFORE THE FIRST RENDER, not through an effect:
 * `main.tsx` awaits the store before React mounts, so the first frame is the
 * reader's own theme and type size. Applied afterwards they would be a visible
 * flash of Paper at 21px on every launch, on the one surface nobody can look
 * away from.
 */
export function useAppState(settings: SettingsStore, contributed: ContributedPanes = NO_CONTRIBUTED): [AppState, AppDispatch] {
  /* The reducer closes over the contributed panes; the composition is static
   * for the app's lifetime, so this is built once. React reads the reducer
   * from the latest render either way. */
  const reduce = useCallback((state: AppState, action: Action) => reducer(state, action, contributed), [contributed])
  const [state, dispatch] = useReducer(
    reduce,
    bootState(
      typeof window === 'undefined' ? '' : window.location.search,
      readKernelPreferences(settings),
      contributed,
    ),
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
    /* SPREAD FIELD BY FIELD, not `[settings, prefs]`: `preferencesOf` builds a
     * fresh object every render, so depending on it would run this effect on
     * every page turn and keystroke. `spacing` is the one nested value, so its
     * four indices are listed rather than the object that holds them. */
  }, [
    settings,
    prefs.theme,
    prefs.themeFollowsOs,
    prefs.typeface,
    prefs.textSize,
    prefs.spacing.letter,
    prefs.spacing.word,
    prefs.spacing.line,
    prefs.spacing.paragraph,
    prefs.align,
    prefs.brightness,
    prefs.contrast,
    prefs.pageLayout,
    prefs.side,
    prefs.rulerOn,
    prefs.scrollbarOn,
    prefs.progressLineOn,
    prefs.markTint,
    prefs.markStyle,
    /* THE OBJECT, not its fifteen fields — and unlike `spacing` above, that is
       safe here. `setReadingStyle` returns the SAME object when a setting has
       not moved, so its identity is stable across a page turn or a keystroke;
       `spacing` is listed field by field because `preferencesOf` builds a fresh
       wrapper each render and its own reducer branch predates that guarantee.
       Omitted entirely at first, which meant fifteen settings a reader could
       move and never save — the effect simply never re-ran. */
    prefs.readingStyle,
  ])
  return [state, dispatch]
}

/** The durable half of the state, in the shape the settings store takes. */
export function preferencesOf(state: AppState): KernelPreferences {
  return {
    theme: state.theme,
    themeFollowsOs: state.themeFollowsOs,
    typeface: state.typeface,
    /* THE SIZE, NOT THE INDEX — see `KERNEL_SETTINGS.textSize`. `AppState`
       keeps an index because the stepper and the ramp are indexed; the FILE
       keeps pixels, because an index means nothing across a change to the
       ramp and every reader's type would move the day one landed. */
    textSize: readingStep(state.stepIdx).size,
    spacing: state.spacing,
    align: state.align,
    brightness: state.brightness,
    contrast: state.contrast,
    pageLayout: state.pageLayout,
    side: state.side,
    rulerOn: state.rulerOn,
    scrollbarOn: state.scrollbarOn,
    progressLineOn: state.progressLineOn,
    markTint: state.markTint,
    markStyle: state.markStyle,
    readingStyle: state.readingStyle,
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
export function bootState(
  search: string,
  remembered: Partial<KernelPreferences> = {},
  contributed: ContributedPanes = NO_CONTRIBUTED,
): AppState {
  const screen = screenFor(search)
  /* CLOSED STAYS CLOSED, FITTED STAYS FITTED — and the two must not tangle.
   * The old conditional fed the FALLBACK into `paneFits` and then returned the
   * original: with a null initial pane, "the default fits" answered yes and
   * null came back — which happened to be wanted, by an accident of routing
   * rather than a statement of it. Said directly: a null seed boots closed;
   * anything else boots to that panel where it fits, or the screen's default. */
  const pane = initialState.pane === null ? null : paneFor(screen, initialState.pane, contributed)
  /* THE PREFERENCES GO ON FIRST, then the things a launch decides. Screen and
     pane are session facts and are not persisted — see `KERNEL_SETTINGS` — so a
     stored file cannot put the reader back into a panel they closed, and the
     order here is what guarantees it rather than trusting the file's shape. */
  const prefs = { ...preferencesOf(initialState), ...remembered }
  /* THE SAME RULE THE REDUCER KEEPS: paginated flow has no ruler (§06). Two
   * stored values can disagree — the layout written after the ruler — and a
   * launch must not start in a state no sequence of actions can reach. */
  const rulerOn = prefs.pageLayout === 'paginated' ? false : prefs.rulerOn
  /* Back to an index, landing on the nearest step this build offers — see
     `stepIndexForSize`, and the ramp note about 30px no longer being on it. */
  /* `textSize` IS PULLED OUT OF THE SPREAD, not merely overridden after it.
     It is a field of the FILE and not of `AppState`, and a spread carries
     excess properties through without complaint — left in, every state object
     would quietly grow a `textSize` nothing reads and the reducer would copy it
     forward for the life of the session. */
  const { textSize: _textSize, ...carried } = prefs
  const stepIdx = stepIndexForSize(prefs.textSize)
  return {
    ...initialState,
    ...carried,
    stepIdx,
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
