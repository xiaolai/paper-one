import { DEFAULT_STEP_IDX, READING_STEPS, readingStep } from './metrics'
import { panesFor, THEMES, TYPEFACES } from './panes'
import type { AppDispatch, AppState } from './state'

/**
 * Everything the command palette can do, as data.
 *
 * One registry rather than a list in the palette and a switch in the keyboard
 * handler. §11 publishes a keyboard map, and a command that has a shortcut
 * carries it here — so the palette shows the same combo the handler binds, and
 * neither can quietly stop matching the other.
 *
 * Commands are built from the current state, so `on` reflects what is actually
 * true right now: the palette says "Close the side pane" when it is open rather
 * than offering to open something already open.
 */

export interface Command {
  /** Stable across renders — the palette keys and remembers rows by it. */
  readonly id: string
  readonly label: string
  /** The group heading in the palette. */
  readonly group: string
  /** §11 combo, displayed as written in the design's keyboard map. */
  readonly combo?: string
  /** Extra words to match on that are not in the label. */
  readonly keywords?: string
  /** True when this command names a state that is currently on. */
  readonly on?: boolean
  readonly run: () => void
}

export interface CommandContext {
  state: AppState
  dispatch: AppDispatch
  /** Null when the reader has no book open — book commands are then omitted. */
  hasBook: boolean
  /** Marks the current selection, when there is one. */
  markSelection: (() => void) | null
  openBookPicker: () => void
  closeBook: () => void
  openSwitcher: () => void
}

export function buildCommands(ctx: CommandContext): Command[] {
  const { state, dispatch } = ctx
  const commands: Command[] = []

  /* THE PANELS THIS SCREEN HAS. Listing all eight from the library offered
   * three that cannot open there — and a palette entry that does something
   * other than what it says is worse than one that is missing, because the
   * reader has already decided before they press return. */
  for (const pane of panesFor(state.screen)) {
    if (pane.inPalette === false) continue
    const open = state.pane === pane.id
    commands.push({
      id: `pane:${pane.id}`,
      label: open ? `Close ${pane.label}` : `Open ${pane.label}`,
      group: 'Panels',
      ...(pane.combo ? { combo: pane.combo } : {}),
      keywords: 'pane panel sidebar',
      on: open,
      run: () =>
        open
          ? dispatch({ type: 'closePane' })
          : dispatch({ type: 'openPane', pane: pane.id }),
    })
  }

  commands.push({
    id: 'pane:toggle',
    label: state.pane ? 'Close the side pane' : 'Open the side pane',
    group: 'Panels',
    combo: '⌘\\',
    on: state.pane !== null,
    run: () => dispatch({ type: 'togglePane' }),
  })

  commands.push({
    id: 'pane:side',
    label: state.side === 'left' ? 'Move the pane to the right' : 'Move the pane to the left',
    group: 'Panels',
    keywords: 'position side',
    run: () => dispatch({ type: 'setSide', side: state.side === 'left' ? 'right' : 'left' }),
  })

  /* §06: the ruler is scrolled-flow only. Offering it in paginated mode would
   * be a command that silently does nothing — the reducer clears `rulerOn` the
   * moment the layout changes. */
  if (state.pageLayout === 'scrolled') {
    commands.push({
      id: 'reading:ruler',
      label: state.rulerOn ? 'Turn the reading ruler off' : 'Turn the reading ruler on',
      group: 'Reading',
      keywords: 'line guide focus',
      on: state.rulerOn,
      run: () => dispatch({ type: 'toggleRuler' }),
    })

    // Same guard, same reason: a paged book has no scroll port to draw one in.
    commands.push({
      id: 'reading:scrollbar',
      label: state.scrollbarOn ? 'Hide the scrollbar' : 'Show the scrollbar',
      group: 'Reading',
      keywords: 'scroll bar gutter position',
      on: state.scrollbarOn,
      run: () => dispatch({ type: 'toggleScrollbar' }),
    })
  }

  /* Outside the flow guard above, unlike the scrollbar. Progress through the
   * book is the same quantity in either flow — `fraction` arrives on relocate
   * whichever way the book is laid out — so guarding it would hide a command
   * that works. */
  commands.push({
    id: 'reading:progress',
    label: state.progressLineOn ? 'Hide the progress rule' : 'Show the progress rule',
    group: 'Reading',
    keywords: 'progress bar edge colour color how far',
    on: state.progressLineOn,
    run: () => dispatch({ type: 'toggleProgressLine' }),
  })

  commands.push({
    id: 'reading:flow',
    label: state.pageLayout === 'scrolled' ? 'Switch to pages' : 'Switch to scrolling',
    group: 'Reading',
    keywords: 'flow paginated scrolled layout',
    run: () =>
      dispatch({
        type: 'setPageLayout',
        layout: state.pageLayout === 'scrolled' ? 'paginated' : 'scrolled',
      }),
  })

  /* §09's seven reading sizes, one step at a time.
   *
   * Omitted at the end of the ramp for the same reason the ruler is omitted in
   * paginated flow: the reducer clamps an out-of-range index straight back, so
   * "Larger" at 30px would be a row that runs and changes nothing. The label
   * names the size it would MOVE TO, because a stepper the reader cannot see
   * while the palette is open has to say where it is going. */
  if (state.stepIdx < READING_STEPS.length - 1) {
    commands.push({
      id: 'reading:bigger',
      label: `Larger type — ${readingStep(state.stepIdx + 1).size}px`,
      group: 'Reading',
      combo: '⌘+',
      keywords: 'size text bigger increase zoom',
      run: () => dispatch({ type: 'setStepIdx', idx: state.stepIdx + 1 }),
    })
  }

  if (state.stepIdx > 0) {
    commands.push({
      id: 'reading:smaller',
      label: `Smaller type — ${readingStep(state.stepIdx - 1).size}px`,
      group: 'Reading',
      combo: '⌘−',
      keywords: 'size text smaller decrease zoom',
      run: () => dispatch({ type: 'setStepIdx', idx: state.stepIdx - 1 }),
    })
  }

  if (state.stepIdx !== DEFAULT_STEP_IDX) {
    commands.push({
      id: 'reading:size-default',
      label: `Default type size — ${readingStep(DEFAULT_STEP_IDX).size}px`,
      group: 'Reading',
      combo: '⌘0',
      keywords: 'size text reset',
      run: () => dispatch({ type: 'setStepIdx', idx: DEFAULT_STEP_IDX }),
    })
  }

  for (const theme of THEMES) {
    commands.push({
      id: `theme:${theme.id}`,
      label: `Theme — ${theme.label}`,
      group: 'Appearance',
      keywords: 'colour color appearance',
      on: state.theme === theme.id,
      run: () => dispatch({ type: 'setTheme', theme: theme.id }),
    })
  }

  /* The book's face, in the same group as the themes and for the same reason:
   * both are Appearance, and both are a choice from a fixed registry. The
   * label names the face rather than describing it — a palette row is read by
   * someone who already knows which one they want. */
  for (const face of TYPEFACES) {
    commands.push({
      id: `typeface:${face.id}`,
      label: `Typeface — ${face.label}`,
      group: 'Appearance',
      keywords: `font family type ${face.note.toLowerCase()}`,
      on: state.typeface === face.id,
      run: () => dispatch({ type: 'setTypeface', typeface: face.id }),
    })
  }

  commands.push({
    id: 'theme:follow',
    label: state.themeFollowsOs
      ? 'Stop following the system appearance'
      : 'Follow the system appearance',
    group: 'Appearance',
    on: state.themeFollowsOs,
    run: () => dispatch({ type: 'setThemeFollowsOs', follows: !state.themeFollowsOs }),
  })

  if (ctx.markSelection) {
    const mark = ctx.markSelection
    commands.push({
      id: 'book:mark',
      label: 'Mark the selection',
      group: 'Book',
      combo: '⌘D',
      keywords: 'highlight annotate',
      run: mark,
    })
  }

  commands.push({
    id: 'screen:library',
    label: state.screen === 'library' ? 'Back to the reader' : 'Go to the library',
    group: 'Book',
    // The key the titlebar button names and the handler binds. Three surfaces
    // for one action, and the palette is where a reader learns the shortcut.
    combo: '⌘L',
    keywords: 'shelf books home library',
    on: state.screen === 'library',
    run: () =>
      dispatch({
        type: 'goScreen',
        screen: state.screen === 'library' ? 'reader' : 'library',
      }),
  })

  commands.push({
    id: 'book:open',
    label: 'Add books…',
    group: 'Book',
    keywords: 'import file epub open',
    run: ctx.openBookPicker,
  })

  commands.push({
    id: 'book:switch',
    label: 'Switch book…',
    group: 'Book',
    keywords: 'library recent',
    run: ctx.openSwitcher,
  })

  if (ctx.hasBook) {
    commands.push({
      id: 'book:close',
      label: 'Close the book',
      group: 'Book',
      run: ctx.closeBook,
    })
  }

  return commands
}

/**
 * Rank commands against a query.
 *
 * A prefix match on the label beats a match inside it, which beats a match on
 * the keywords — so typing "not" puts "Open Notes" first rather than whichever
 * command happens to contain those letters earliest. Returns null for a miss so
 * the caller can drop the row rather than showing every command at rank zero.
 */
export function score(command: Command, query: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const label = command.label.toLowerCase()
  if (label.startsWith(q)) return 0
  const at = label.indexOf(q)
  if (at >= 0) return 1 + at / 100
  if (command.keywords?.toLowerCase().includes(q)) return 50
  if (command.group.toLowerCase().startsWith(q)) return 60
  return null
}

export function filterCommands(commands: readonly Command[], query: string): Command[] {
  return commands
    .map((command) => ({ command, rank: score(command, query) }))
    .filter((entry): entry is { command: Command; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.command)
}
