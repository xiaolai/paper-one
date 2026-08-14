import type { AppDispatch, AppState, PaneId, Theme } from './state'

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

const PANES: readonly { id: PaneId; label: string; combo?: string }[] = [
  { id: 'toc', label: 'Contents', combo: '⌘1' },
  { id: 'notes', label: 'Notes', combo: '⌘2' },
  { id: 'search', label: 'Search', combo: '⌘3' },
  { id: 'cards', label: 'Cards', combo: '⌘4' },
  { id: 'companion', label: 'Companion' },
  { id: 'stats', label: 'Reading', combo: '⌘5' },
  { id: 'import', label: 'Add books' },
  { id: 'settings', label: 'Settings' },
]

/** §11 binds ⌘1…5 to "Contents, notes, search, cards, stats". */
export const PANE_SHORTCUTS: readonly { combo: string; digit: string; pane: PaneId }[] =
  PANES.filter((pane) => pane.combo).map((pane) => ({
    combo: pane.combo ?? '',
    digit: (pane.combo ?? '').slice(-1),
    pane: pane.id,
  }))

const THEMES: readonly { id: Theme; label: string }[] = [
  { id: 'paper', label: 'Paper' },
  { id: 'slate', label: 'Slate' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'sage', label: 'Sage' },
  { id: 'night', label: 'Night' },
]

export function buildCommands(ctx: CommandContext): Command[] {
  const { state, dispatch } = ctx
  const commands: Command[] = []

  for (const pane of PANES) {
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
  }

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
    keywords: 'shelf books home',
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
