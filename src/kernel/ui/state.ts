import { useCallback, useEffect, useReducer, type Dispatch } from 'react'
import type { MarkStyle, MarkTint } from '../core/marks'
import { BRIGHTNESS, CONTRAST, PARAGRAPH_GAP, SENTENCE_GAP, DEFAULT_ALIGN, DEFAULT_READING_STYLE, DEFAULT_SPACING, DEFAULT_STEP_IDX, DEFAULT_THEME, DEFAULT_TYPEFACE, FIGURE_HEIGHTS, FIGURE_WIDTHS, MINIMUM_SIZES, READING_STEPS, SPACING, readingStep, stepIndexForSize, type SpacingScale } from '../core/metrics'
import type { SettingsStore } from '../core/ports'
import {
  PARAGRAPH_GAP_MAX,
  PARAGRAPH_GAP_MIN,
  READING_RATE_MAX,
  READING_RATE_MIN,
  SENTENCE_GAP_MAX,
  SENTENCE_GAP_MIN,
  readKernelPreferences,
  writeKernelPreferences,
  type KernelPreferences,
} from '../core/settings'
import type { PaneContribution } from '../core/capability'
import { isContributedPaneId, isContributedScreenId, paneOffered, type Align, type PageLayout, type PaneId, type ReadingStyle, type ReadingStyleKey, type Screen, type Side, type SpacingIndices, type SpacingKey, type Theme, type Typeface } from '../core/uiTypes'

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
// Stryker disable next-line ArrayDeclaration: every reader of the list asks `entry.id === pane` first, and a string entry has no `id`, so a list holding one fits exactly the panels an empty list fits
const NO_CONTRIBUTED: ContributedPanes = []

export interface AppState {
  readonly screen: Screen
  /**
   * Whether developer options are on — ⌘⌃⌥D, and nothing else.
   *
   * MIRRORED INTO STATE like every other durable preference, because the
   * reducer needs it: `paneFor` has to know, on every screen change, whether a
   * remembered panel is one this reader may still be shown. Reading the store
   * from inside the reducer would make it impure.
   */
  readonly developer: boolean
  /** Unfinished panels hidden while developer options are on — see `paneOffered`. */
  readonly hiddenPanes: readonly string[]
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
   * PERSISTED across launches, like `theme`, `stepIdx` and every other reading
   * setting here — `KERNEL_SETTINGS.markTint` and `.markStyle`. This said "not
   * persisted", describing a gap the settings store has since closed, until
   * the 2026-09-13 audit.
   */
  readonly markTint: MarkTint
  readonly markStyle: MarkStyle
  /**
   * Read aloud's voice per language, and its speed.
   *
   * PER LANGUAGE because one voice for the app reads a Chinese book in English
   * — see `ui/reader/voiceChoice.ts`. The value is a `voiceURI`, which is the
   * only stable identity a `SpeechSynthesisVoice` has: `name` collides (this Mac
   * offers two voices called Samantha and two called Tingting, differing only in
   * tier) and the object itself does not survive a relaunch.
   */
  readonly readingVoice: Readonly<Record<string, string>>
  readonly readingRate: number
  /** Whether a note's BODY is read aloud — see `NOTE_BODIES` in `speechSkip.ts`. */
  readonly readingNotesAloud: boolean
  /** Silence after a sentence, in ms — see `SENTENCE_GAP` in `metrics.ts`. */
  readonly sentenceGapMs: number
  /** Silence after a paragraph, in ms. Used ALONE at a paragraph end, not added
   *  to the sentence gap: the label says "between paragraphs", so a reader who
   *  sets it to zero means no pause there. */
  readonly paragraphGapMs: number
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
  developer: false,
  hiddenPanes: [],
  /* NO VOICE CHOSEN AND THE ENGINE'S OWN SPEED. Empty is not "no voice" — it is
     "the app picks", which `voiceFor` answers with the best voice installed for
     the book's language. A reader only lands in this map by disagreeing with
     that choice. */
  readingVoice: {},
  readingRate: 1,
  readingNotesAloud: false,
  sentenceGapMs: SENTENCE_GAP.steps[SENTENCE_GAP.def] ?? 0,
  paragraphGapMs: PARAGRAPH_GAP.steps[PARAGRAPH_GAP.def] ?? 0,
  theme: DEFAULT_THEME,
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
  typeface: DEFAULT_TYPEFACE,
  /* Every spacing at its own default, which is the book exactly as it reads
     today — a reader who never opens these gets no change. */
  spacing: { ...DEFAULT_SPACING },
  /* Justified, which is what the book has always been set as. */
  align: DEFAULT_ALIGN,
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
  /** ⌘⌃⌥D. See `AppState.developer`. */
  | { type: 'toggleDeveloper' }
  /** One unfinished panel shown or hidden, from the Developer band. */
  | { type: 'setPaneHidden'; pane: string; hidden: boolean }
  | { type: 'setSide'; side: Side }
  | { type: 'toggleLayer'; layer: Layer }
  | { type: 'closeLayer'; layer: Layer }
  /** Esc dismisses the topmost layer only (§11 keyboard map). */
  | { type: 'dismissTop' }
  | { type: 'setChrome'; on: boolean }
  | { type: 'toggleReadingNotes' }
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
  /* The VOICE for one language, not the whole map: a picker changes the voice
     for the book in hand, and an action carrying the map would let a stale
     render overwrite a choice made for another language. */
  | { type: 'setReadingVoice'; lang: string; voice: string }
  | { type: 'setReadingRate'; rate: number }
  | { type: 'setSentenceGap'; ms: number }
  | { type: 'setParagraphGap'; ms: number }
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
 * The fields of `ReadingStyle` whose value is a number — which is to say, an
 * index. Derived from the type, so the table below has to name every one.
 */
type ScaledReadingStyleKey = { [K in ReadingStyleKey]: ReadingStyle[K] extends number ? K : never }[ReadingStyleKey]

/**
 * Which of `ReadingStyle`'s fifteen are INDICES into a scale.
 *
 * A table rather than a condition in the reducer, so adding a scaled setting is
 * one line here and forgetting to clamp it is not possible in the other
 * direction — an unlisted key is a closed set the compiler already checked.
 *
 * ⚠️ **AND FORGETTING ONE HERE WAS POSSIBLE UNTIL THE 2026-09-13 AUDIT.** The
 * table was a `Partial<Record<…>>`, so a numeric field left out of it compiled,
 * took the reducer's `scale === undefined` branch and was stored unclamped —
 * the trap the table exists to close. Keyed by `ScaledReadingStyleKey`, an
 * omission is a compile error.
 */
const READING_STYLE_SCALES: Readonly<Record<ScaledReadingStyleKey, SpacingScale>> = {
  figureWidth: FIGURE_WIDTHS,
  figureHeight: FIGURE_HEIGHTS,
  minimumSize: MINIMUM_SIZES,
}

function scaleIndex(idx: number, length: number): number | null {
  if (!Number.isFinite(idx)) return null
  return Math.min(Math.max(Math.round(idx), 0), length - 1)
}

/**
 * `brightness` or `contrast` at an index into its own scale — the same state
 * when the index has not moved or is not a number.
 *
 * ⚠️ **ONE CASE EACH, NAMING ITS OWN PAIR, AND IT WAS ONE CASE FOR BOTH.** The
 * shared branch picked the key and then the scale by testing `action.type`
 * twice, and `BRIGHTNESS` and `CONTRAST` are both five steps — so the second
 * test decided nothing a behaviour could see, and all four of its mutants
 * survived every test (2026-09-15 mutation sweep). Named at the case, the
 * pairing is read off one line rather than decided by a branch.
 */
function atIndex(state: AppState, key: 'brightness' | 'contrast', scale: SpacingScale, idx: number): AppState {
  const at = scaleIndex(idx, scale.steps.length)
  return at === null || state[key] === at ? state : { ...state, [key]: at }
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
      const pane = state.pane === null ? null : paneFor(action.screen, state.lastPane, audienceOf(state, contributed))
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
        pane: paneFor(state.screen, action.pane, audienceOf(state, contributed)),
        /* ⚠️ **REMEMBERED ONLY IF IT IS A PANEL THIS READER MAY BE SHOWN.**
         * `lastPane` has exactly one invariant — `afterVisibilityChange` states
         * it and was the only thing enforcing it — and this wrote straight
         * through it: a request for an UNFINISHED panel opened the screen's
         * default and then recorded the unfinished id as "what the reader last
         * opened". Nothing repairs that until the next visibility change, so
         * the following ⌘\ resolved the unopenable id to the default a second
         * time and the panel the reader actually had was gone.
         *
         * OFFERED-NESS, NOT FIT, for the reason given at `afterVisibilityChange`:
         * this value is cross-screen, and a panel that does not fit the screen
         * the reader is on is still the one to come back to on the screen where
         * it does. An un-offered request leaves the memory untouched rather
         * than overwriting it — the reader asked for something they cannot
         * have, which is no reason to discard what they had. */
        lastPane: paneOffered(action.pane, state.developer, state.hiddenPanes) ? action.pane : state.lastPane,
        paletteOpen: false,
      }

    /* ⚠️ **NOT WHERE THERE IS NO PANE — see `paneAvailable`.** The titlebar and
     * ⌘\ both refused on a contributed screen and the palette's "Close the side
     * pane" did not, so it closed a pane nothing was drawing and the reader came
     * back to the shelf with the panel they had left open gone. Refused HERE,
     * where every dispatcher arrives, with `lastPane` untouched, so leaving the
     * screen restores what was open before they came (2026-09-13 audit). */
    case 'togglePane':
      if (!paneAvailable(state.screen)) return state
      return state.pane
        ? { ...state, pane: null }
        : { ...state, pane: paneFor(state.screen, state.lastPane, audienceOf(state, contributed)) }

    case 'closePane':
      return { ...state, pane: null }

    /* ⚠️ **THE OPEN PANEL IS RE-RESOLVED, AND IT HAS TO BE.** Turning developer
     * options OFF takes the unfinished panels away — including, quite possibly,
     * the one on screen. Leaving `pane` alone would show a title over a panel
     * the rail no longer draws and the reducer can no longer reach, which is
     * the state `paneFor` exists to make unreachable. Turning them ON needs the
     * same call for the same reason in reverse: nothing else re-asks. */
    case 'toggleDeveloper':
      return afterVisibilityChange({ ...state, developer: !state.developer }, contributed)

    /* THE SAME STATE WHEN THE LIST ALREADY SAYS SO. A hide of a panel already
       hidden built a new array, and the write effect depends on `hiddenPanes`
       by IDENTITY, on the promise — stated at `useAppState` — that it changes
       only when the list does; so each repeat re-ran the whole preference
       write (2026-09-13 audit). */
    case 'setPaneHidden':
      if (state.hiddenPanes.includes(action.pane) === action.hidden) return state
      return afterVisibilityChange(
        {
          ...state,
          hiddenPanes: action.hidden
            ? [...new Set([...state.hiddenPanes, action.pane])]
            : state.hiddenPanes.filter((one) => one !== action.pane),
        },
        contributed,
      )

    case 'setSide':
      return { ...state, side: action.side }

    case 'toggleLayer': {
      /* Closing needs no ceremony; opening retires the others. Every layer is
       * modal today, so there is no non-modal branch — one existed, guarded on
       * a membership test that could not fail, which is the kind of branch that
       * looks exercised and never runs. If a non-modal layer ever arrives, it
       * gets its own list and this comment stops being true loudly. */
      if (state[action.layer]) return { ...state, [action.layer]: false }
      /* `ALL_LAYERS_SHUT`, not a second `Object.fromEntries` over the same
         list. This rebuilt it on every open — the same map, derived the same
         way, from the same constant, allocated again — and a second derivation
         of one value is exactly what the note beside that constant was written
         about. */
      return { ...state, ...ALL_LAYERS_SHUT, [action.layer]: true }
    }

    case 'closeLayer':
      return { ...state, [action.layer]: false }

    case 'dismissTop': {
      const top = LAYER_ORDER.find((layer) => state[layer])
      return top ? { ...state, [top]: false } : state
    }

    case 'setChrome':
      return { ...state, chromeOn: action.on }

    case 'toggleReadingNotes':
      return { ...state, readingNotesAloud: !state.readingNotesAloud }
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
      /* Widened to every key for the lookup, by assignment rather than a cast:
         the table is complete for the scaled keys, and a key it does not name
         is one of the closed sets. */
      const scales: Partial<Record<ReadingStyleKey, SpacingScale>> = READING_STYLE_SCALES
      const scale = scales[action.key]
      const value =
        scale === undefined ? action.value : scaleIndex(action.value as number, scale.steps.length)
      if (value === null || state.readingStyle[action.key] === value) return state
      return { ...state, readingStyle: { ...state.readingStyle, [action.key]: value } }
    }

    case 'setBrightness':
      return atIndex(state, 'brightness', BRIGHTNESS, action.idx)

    case 'setContrast':
      return atIndex(state, 'contrast', CONTRAST, action.idx)

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

    /* MERGED INTO THE MAP, never replacing it, so choosing a Chinese voice
       leaves the English one alone. An empty voice REMOVES the entry rather
       than storing `''`, which is how a reader goes back to letting the app
       choose — `chosenVoice` treats an empty string as no choice, but leaving
       one behind would mean the map grew a dead key per language visited. */
    case 'setReadingVoice': {
      const { [action.lang]: had, ...rest } = state.readingVoice
      if (action.voice === '') return had === undefined ? state : { ...state, readingVoice: rest }
      if (had === action.voice) return state
      return { ...state, readingVoice: { ...rest, [action.lang]: action.voice } }
    }

    case 'setReadingRate': {
      /* CLAMPED HERE TOO, not only in the settings validator. The validator
         guards what arrives from disk; this guards what arrives from a control,
         and the two are different doors into the same value. */
      const rate = bounded(action.rate, READING_RATE_MIN, READING_RATE_MAX)
      return rate === null ? state : { ...state, readingRate: rate }
    }

    case 'setSentenceGap': {
      const ms = bounded(action.ms, SENTENCE_GAP_MIN, SENTENCE_GAP_MAX)
      return ms === null ? state : { ...state, sentenceGapMs: ms }
    }

    case 'setParagraphGap': {
      const ms = bounded(action.ms, PARAGRAPH_GAP_MIN, PARAGRAPH_GAP_MAX)
      return ms === null ? state : { ...state, paragraphGapMs: ms }
    }

  }
}

/**
 * A number inside `[min, max]`, or null when it is not a number at all.
 *
 * ⚠️ **`Math.max(min, Math.min(max, NaN))` IS `NaN`**, and three reducer branches
 * clamped that way — so `NaN` reached live state, serialised as `null`, and broke
 * the session until a relaunch reset it. The settings validator beside them asks
 * `Number.isFinite` first; the reducer is the OTHER door into the same value and
 * did not, which is precisely the asymmetry `setReadingRate`'s own comment warns
 * about.
 *
 * `null` for a refusal rather than a fallback: a control that sends a
 * non-number has a defect, and silently substituting the minimum would hide it
 * while changing the reader's setting. The caller returns the state unchanged.
 *
 * One helper for all three, because the duplication is what let two of them
 * inherit the omission from the first.
 */
function bounded(value: number, min: number, max: number): number | null {
  if (!Number.isFinite(value)) return null
  return Math.max(min, Math.min(max, value))
}

export type AppDispatch = Dispatch<Action>

/**
 * The two arguments of a reading-style change, CORRELATED — one member per
 * setting, each holding that setting's own key beside its own value type.
 *
 * ⚠️ **IT WAS `<K extends ReadingStyleKey>(key: K, value: ReadingStyle[K])`, AND
 * A GENERIC DOES NOT MAKE `K` A SINGLE KEY.** Instantiated with a union —
 * `setReadingStyle<'separation' | 'figureFrame'>('separation', 'shadow')` —
 * `ReadingStyle[K]` was both value types at once, the call compiled, and the
 * reducer stored a separation of `'shadow'`: the compile error the signature
 * promised, not given. No caller did it, and the type is what has to refuse it.
 *
 * A UNION OF TUPLES CANNOT BE INSTANTIATED THAT WAY: there is no member pairing
 * one setting's key with another's value, so the pairing above is not a type
 * the union contains. TypeScript resolves an ordinary call against the member
 * whose key it was given, so every real call site reads exactly as before.
 *
 * ⚠️ **AND IT HAS TO BE SPELLED ON `onStyle` TOO** (`pane/Settings.tsx`), which
 * had the identical generic: closing it here alone would have moved the hole
 * one call up rather than shut it (2026-09-13 audit, #212).
 */
export type ReadingStyleArgs = {
  [K in ReadingStyleKey]: [key: K, value: ReadingStyle[K]]
}[ReadingStyleKey]

/**
 * A `setReadingStyle` action, with the key and the value checked against each
 * other.
 *
 * THE CAST IS HERE AND NOWHERE ELSE, and it is a limit of the type system
 * rather than a shortcut. `Action` distributes over the fifteen keys so the
 * REDUCER can narrow `value` from `key` — which is the property worth having,
 * because it is what makes a `separation` of `'shadow'` a compile error.
 * Destructuring the tuple above is what loses the correlation again: `key` and
 * `value` become the two unions, and TypeScript cannot then prove the pair it
 * just took apart is one of the fifteen members. The ARGUMENTS are checked at
 * every call site; this one function absorbs the gap, with the assertion
 * written down.
 */
export function setReadingStyle(...[key, value]: ReadingStyleArgs): Action {
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
 * `Contents` lists the open book's own table of contents and `Search` takes a
 * `Book` and scans it. On the library screen both are a title above an apology,
 * and the pane OPENED ONTO ONE OF THEM: the first thing Paper showed a reader
 * with a full shelf was a panel saying it was not available.
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
const BOOK_ONLY: readonly PaneId[] = ['toc', 'search']

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
export interface PaneAudience {
  readonly contributed?: ContributedPanes
  /** See `AppState.developer`. Absent reads as off, which is the safe default. */
  readonly developer?: boolean
  readonly hiddenPanes?: readonly string[]
}

/**
 * Whether ONE contribution belongs on this screen — the rule `paneFits` applies
 * to a contributed id, for a caller that already holds the contribution.
 *
 * The rail had the same question and no way to ask it: it filtered the
 * contributed list through `paneFits`, which looks each id up in that list
 * again, so a rail of n contributed panes rescanned the list n times (#148).
 * The cost is nothing at today's two, and the rule being in two places is not
 * nothing — the rail would have been the copy that forgot `screens`.
 */
export function contributionFits(screen: Screen, entry: ContributedPanes[number]): boolean {
  return entry.screens.includes(screen)
}

export function paneFits(screen: Screen, pane: PaneId, audience: PaneAudience = {}): boolean {
  const contributed = audience.contributed ?? NO_CONTRIBUTED
  if (isContributedPaneId(pane)) {
    return contributed.some((entry) => entry.id === pane && contributionFits(screen, entry))
  }
  /* ⚠️ **NO KERNEL PANEL FITS A CONTRIBUTED SCREEN, and that is what makes a
   * screen a screen.** The rail below is panels about a book or about the
   * shelf; a capability's full-window view is neither, so drawing them beside
   * it is furniture from a room the reader has left. Without this the ternary
   * at the end treats every non-`reader` screen as the library and offers
   * Library, Marginalia and Cards over somebody else's page. */
  if (isContributedScreenId(screen)) return false
  /* ⚠️ **TWO FACTS, ONE QUESTION, AND DELIBERATELY NOT TWO FUNCTIONS.** This
   * asks "has this panel anything to show here", and a panel the reader has not
   * asked to be shown has nothing — so `paneOffered` is folded in rather than
   * left for each caller to remember. There are five callers (the rail, the
   * palette, the digit accelerators, the reducer's `paneFor`, and the pane's
   * own fallback), and §11's pane ids drifted across exactly three copies
   * before `panes.ts` existed. A sixth caller gets the whole rule or none of
   * it. */
  /* `hiddenPanes` WITH NO FALLBACK OF ITS OWN: `paneOffered` defaults an absent
     list to none, and a second `?? []` here was a default nothing could tell
     from its mutant — the list is consulted only for an unfinished id. */
  if (!paneOffered(pane, audience.developer ?? false, audience.hiddenPanes)) return false
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
  /* A contributed screen has no panel to fall back to — `paneFits` refuses
     every one of them. The answer is never read (the side pane is closed on
     such a screen); returning the shelf's panel keeps the type honest without
     inventing a state. It is not the reader, so the `return` below already
     answers `library` for it — which is why the branch that said so again is
     gone: it returned what falling through returns, and no behaviour could
     tell it was there (2026-09-15 mutation sweep). */
  /* ⚠️ **CONTENTS, AND IT USED TO BE COMPANION.** The reader's fallback panel
   * cannot be one that most readers are not shown: `companion` is in
   * `UNFINISHED_PANE_IDS`, so with developer options off it fits nowhere, and a
   * default that fits nowhere is how every path through the reducer lands on a
   * panel that does not exist.
   *
   * Contents is the honest replacement rather than the nearest one. The rule
   * this function states is "the panel about what this screen IS", and in the
   * reader that is the book's own structure — the panel a reader opens to find
   * where they are. Companion held the slot because it was the surface being
   * built at the time. */
  return screen === 'reader' ? 'toc' : 'library'
}

/**
 * The panel to show, given a screen and the one that was wanted.
 *
 * Never null: this answers "which panel", not "is the pane open". The caller
 * holds the second question, and conflating them is how a reader ends up with a
 * pane that closes itself whenever they change screen.
 */
/**
 * What must be re-resolved when a panel's VISIBILITY changes.
 *
 * ONE HELPER FOR BOTH ACTIONS, because they were two copies carrying the same
 * defect — which is how a defect gets fixed once and survives.
 *
 * ⚠️ **`lastPane` IS TESTED FOR OFFERED-NESS, NOT FOR FIT**, and the two copies
 * both used fit. `paneFits` also asks about the SCREEN, so toggling developer
 * options while reading replaced a `library` remembered for the shelf with the
 * reader's default — erasing a perfectly good memory for a screen the reader
 * was not even on. The remembered panel is a cross-screen value; the only
 * reason a visibility change may touch it is that the panel is no longer
 * offered to this reader at all. `goScreen` never rewrites it for the same
 * reason.
 *
 * The OPEN pane is the other way round: it is on this screen by definition, so
 * it goes through `paneFor` and lands on the screen's default when it must.
 */
function afterVisibilityChange(next: AppState, contributed: ContributedPanes): AppState {
  const audience = audienceOf(next, contributed)
  return {
    ...next,
    pane: next.pane === null ? null : paneFor(next.screen, next.pane, audience),
    lastPane: paneOffered(next.lastPane, next.developer, next.hiddenPanes)
      ? next.lastPane
      : defaultPaneFor(next.screen),
  }
}

/** The audience a state describes, so the reducer's four calls cannot differ. */
function audienceOf(state: AppState, contributed: ContributedPanes): PaneAudience {
  return { contributed, developer: state.developer, hiddenPanes: state.hiddenPanes }
}

function paneFor(screen: Screen, wanted: PaneId | null, audience: PaneAudience): PaneId {
  if (wanted && paneFits(screen, wanted, audience)) return wanted
  return defaultPaneFor(screen)
}

/**
 * Whether the side pane exists on this screen at all.
 *
 * ⚠️ **`WindowShell` AND `SidePane` ALREADY REFUSED TO DRAW ONE, AND THE
 * CONTROLS DID NOT KNOW.** A contributed screen owns the whole window, so no
 * pane is shown there — but the titlebar kept drawing an active "Close pane"
 * button and ⌘\ kept toggling, so both mutated a state nothing reflected. The
 * reader pressed a lit control and nothing happened, and whether the pane came
 * back on the way out silently changed.
 *
 * One predicate rather than three copies of `!isContributedScreenId(...)`, for
 * `paneFits`' reason: this question has five askers already.
 */
export function paneAvailable(screen: Screen): boolean {
  return !isContributedScreenId(screen)
}

/** Where ⌘L goes from here, and what the control that does it is called. */
export interface ScreenJump {
  readonly to: Screen
  readonly label: string
}

/**
 * The ONE answer to "where does ⌘L go", for every surface that offers it.
 *
 * ⚠️ **THREE SURFACES DERIVED THIS SEPARATELY AND TWO OF THEM DISAGREED.** The
 * titlebar button computed `isReader ? 'library' : 'reader'`; the keyboard
 * handler and the command palette both computed
 * `screen === 'library' ? 'reader' : 'library'`. With two screens those are the
 * same function. With a third they are not: from a capability's screen the
 * button said "Back to the book" and went to the reader, while the shortcut it
 * advertised in its own tooltip opened the library. A control that names one
 * destination and performs another is worse than no control.
 *
 * The label comes back with the destination for the same reason — they were
 * also computed apart, so a fourth surface could have named this one correctly
 * and sent the reader somewhere else.
 *
 * The rule: from the reader, out to the shelf. From ANYWHERE else — the shelf
 * or a capability's screen — in to the book, which is the reader's empty state
 * when there is no book. Saying "Open a book" rather than "Back to the book"
 * there is what keeps the name true.
 */
export function screenJump(screen: Screen, hasBook: boolean): ScreenJump {
  if (screen === 'reader') return { to: 'library', label: 'Library' }
  return { to: 'reader', label: hasBook ? 'Back to the book' : 'Open a book' }
}

export function screenFor(search: string): Screen {
  return new URLSearchParams(search).get('book') ? 'reader' : 'library'
}

/**
 * The application state, with the durable half remembered.
 *
 * READ BEFORE THE FIRST RENDER, written on change. The preferences that survive
 * a launch — every entry in `KERNEL_SETTINGS` — live in `AppState` while the
 * app runs, because that is what every control reads and every reducer case
 * writes; the `SettingsStore` is where they go between launches. This said
 * "the fifteen" and listed them until the 2026-09-13 audit, long after there
 * were more: the table is the list, and a count here only goes stale.
 * `bootState` folds the stored values in, and the
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
  /* ⚠️ **LAZILY, THROUGH `useReducer`'S THIRD ARGUMENT.** The initial state was
   * an ordinary argument, so `bootState` — and `readKernelPreferences`, a read
   * and a parse per preference — ran on EVERY render and was thrown away on all
   * but the first: a keystroke in the shelf's search re-read the whole settings
   * store (2026-09-13 audit). An initializer runs once, which is the only time
   * the value was ever used. */
  const [state, dispatch] = useReducer(reduce, settings, (store) =>
    bootState(
      typeof window === 'undefined'
        ? // Stryker disable next-line StringLiteral: `screenFor` reads only a `book` parameter, and neither an empty search nor "Stryker was here!" has one — both open the library
          ''
        : window.location.search,
      readKernelPreferences(store),
      contributed,
    ),
  )
  const prefs = preferencesOf(state)
  useEffect(() => {
    try {
      writeKernelPreferences(settings, prefs)
    } catch (cause) {
      /* THE SHIPPED STORE NO LONGER REACHES HERE. `set` used to throw on a
       * refused write, and this caught it — which meant the batch had already
       * been ABANDONED partway through, so what persisted was a prefix of what
       * the reader chose. `createSettingsStore` reports a refusal through
       * `persistent` instead, which the Settings panel draws, and the loop
       * completes.
       *
       * The guard stays because `SettingsStore` is a PORT: another
       * implementation may still throw, and a preference that will not persist
       * must not take the render down with it. */
      console.error('Paper: could not save a preference', cause)
    }
    /* SPREAD FIELD BY FIELD, not `[settings, prefs]`: `preferencesOf` builds a
     * fresh object every render, so depending on it would run this effect on
     * every page turn and keystroke. `spacing`'s four indices are listed where
     * the object itself would do as well — see the note at `readingStyle`. */
  }, [
    settings,
    /* ⚠️ **OMITTED AT FIRST, EXACTLY AS THE FIFTEEN BELOW WERE.** This effect
       lists every preference by name, so a new one that is not added here is a
       setting the reader can change and never save — the defect `readingStyle`
       records two paragraphs down, repeated on the day developer options landed.
       It is the whole point of persisting the flag: without these two lines
       ⌘⌃⌥D worked and did not survive a relaunch.

       `hiddenPanes` is safe as an identity: `setPaneHidden` builds a new array
       only when the list actually changes, so this cannot re-run on a page
       turn. (That promise was false for a repeated hide or show until the
       2026-09-13 audit, which also struck a comparison here to a
       "freshly-built `spacing` wrapper" that does not exist.) */
    prefs.developer,
    prefs.hiddenPanes,
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
    /* THE OBJECT, not its fifteen fields, and that is safe: `setReadingStyle`
       returns the SAME object when a setting has not moved, so its identity is
       stable across a page turn or a keystroke. Omitted entirely at first,
       which meant fifteen settings a reader could move and never save — the
       effect simply never re-ran.

       `spacing` WOULD BE EXACTLY AS SAFE. This note said it is listed field by
       field because `preferencesOf` builds a fresh wrapper each render — it
       passes `state.spacing` through by reference, and `setSpacing` keeps the
       object when an index has not moved. The indices stay listed, which is
       harmless; the reason given was false (2026-09-13 audit). */
    prefs.readingStyle,
    /* THE MAP BY IDENTITY, which is safe for the same reason `readingStyle`'s
       object is: `setReadingVoice` returns the SAME state when the chosen voice
       has not moved, so no page turn or keystroke produces a new one. */
    prefs.readingVoice,
    prefs.readingRate,
    prefs.readingNotesAloud,
    prefs.sentenceGapMs,
    prefs.paragraphGapMs,
  ])
  return [state, dispatch]
}

/** The durable half of the state, in the shape the settings store takes. */
export function preferencesOf(state: AppState): KernelPreferences {
  return {
    developer: state.developer,
    hiddenPanes: state.hiddenPanes,
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
    readingVoice: state.readingVoice,
    readingRate: state.readingRate,
    readingNotesAloud: state.readingNotesAloud,
    sentenceGapMs: state.sentenceGapMs,
    paragraphGapMs: state.paragraphGapMs,
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
  /* THE SEED'S PANEL, FITTED: where it fits, or the screen's default.
   *
   * ⚠️ **THIS BRANCHED ON A NULL SEED, WHICH CANNOT HAPPEN.** An older
   * conditional fed the fallback into `paneFits` and returned the original, and
   * the repair said directly that "a null seed boots closed" — but
   * `initialState` is a readonly constant whose `pane` is `'library'`, so that
   * branch and the `lastPane` fallback beside it were code no launch could
   * reach (2026-09-13 audit). Booting closed would need the seed as a
   * parameter, and nothing asks for one. */
  /* THE PREFERENCES GO ON FIRST, then the things a launch decides. Screen and
     pane are session facts and are not persisted — see `KERNEL_SETTINGS` — so a
     stored file cannot put the reader back into a panel they closed, and the
     order here is what guarantees it rather than trusting the file's shape.
     ⚠️ AND THEY ARE READ BEFORE THE PANE IS CHOSEN, which they used not to be:
     whether a remembered panel may be shown at all depends on `developer`, and
     that is a stored preference. Choosing the pane first asked the question
     with the answer still on disk. */
  const prefs = { ...preferencesOf(initialState), ...remembered }
  // Stryker disable next-line ObjectLiteral: the seed's panel is `library`, which `paneOffered` never refuses and no contributed pane can stand in for — so it fits the library and not the reader for every audience, and `{}` fits it identically
  const audience = {
    contributed,
    developer: prefs.developer,
    hiddenPanes: prefs.hiddenPanes,
  }
  const pane = paneFor(screen, initialState.pane, audience)
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
    lastPane: pane,
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

/**
 * Whether the BOOK has the reader's input — the one question every paging
 * route asks, however the reader asked to turn the page.
 *
 * ⚠️ **IT WAS ASSEMBLED TWICE AND THE TWO COPIES DID NOT AGREE** (2026-09-13
 * audit, #207). `Reader.onPageIntent` guards the wheel and the swipe on three
 * things — the reader's screen, no open layer, and the side pane not being a
 * SHEET over the book — while `App`'s key handler guarded the arrow keys on the
 * first two only. So below §06's threshold, where the pane stops being a track
 * beside the book and becomes a sheet over it, a wheel gesture was refused and
 * an arrow key turned the page underneath the sheet.
 *
 * `paneIsTrack` is the caller's, because the two know it differently: the
 * reader measures the window it is laying out, and App reads it at the moment
 * of the keystroke. It is only consulted when a pane is OPEN — a closed pane
 * covers nothing whatever the window is doing.
 */
export function readerTakesInput(state: AppState, paneIsTrack: boolean): boolean {
  return state.screen === 'reader' && !hasOpenLayer(state) && (state.pane === null || paneIsTrack)
}
