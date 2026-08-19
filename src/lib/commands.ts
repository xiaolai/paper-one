import { DEFAULT_STEP_IDX, READING_STEPS, readingStep } from './metrics'
import { panesFor, THEMES } from './panes'
import { BUNDLED_FACES, GROUP_LABEL, type Face } from './typefaces'
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
  /**
   * The faces to offer, which depends on what this machine has — see
   * `offeredFaces`. Omitted, only the bundled three are listed, which is the
   * conservative answer rather than a wrong one.
   */
  faces?: readonly Face[]
  /** Marks the current selection, when there is one. */
  markSelection: (() => void) | null
  openBookPicker: () => void
  /**
   * Import a folder of books.
   *
   * HERE BECAUSE IT IS NOT IN THE TOOLBAR any more. Seeding a shelf from a
   * folder is something a reader does once, so it sat beside the everyday
   * action at equal weight and asked them to classify their intent — files or
   * folder — before a picker had even opened. The toolbar keeps the recurring
   * action; this and the library's empty state keep the rare one reachable.
   */
  importFolder: () => void
  /**
   * True while books are being copied in.
   *
   * THE GUARD THAT MOVED WITH THE CONTROL. The toolbar button carried
   * `disabled={importing !== null}`, and when the folder import left the
   * toolbar that guard did not come with it — so ⌘K during an import started a
   * second one, two walks reporting into one progress bar. The command is
   * omitted while this is true, and `addFolder` refuses re-entry on its own
   * account, because a guard that lives only in the caller is a guard the next
   * caller has to remember.
   */
  importing: boolean
  closeBook: () => void
  openSwitcher: () => void
  /**
   * Open the tag editor over the book being read. Null when there is no such
   * book on the shelf — the reader is on the library, or reading a `?book=`
   * the shelf does not hold — so the palette does not offer it.
   */
  editTags: (() => void) | null
  /**
   * Write the reader's tags to a file, and read one back — null where there is
   * no filesystem to write to.
   *
   * IN THE PALETTE rather than in the toolbar or the Library panel, and the
   * panel is the tempting place. Backing up is not tag MANAGEMENT: a reader
   * looking at the panel is filing books, and a pair of file-dialog rows beside
   * the tags they are sorting is a second subject in the same surface. It is
   * also the rarest action here — done once, or after something went wrong —
   * which is exactly what the palette is for.
   */
  exportTags: (() => void) | null
  importTags: (() => void) | null
}

export function buildCommands(ctx: CommandContext): Command[] {
  const { state, dispatch } = ctx
  const commands: Command[] = []

  /* THE PANELS THIS SCREEN HAS. Listing all eight from the library offered
   * three that cannot open there — and a palette entry that does something
   * other than what it says is worse than one that is missing, because the
   * reader has already decided before they press return. */
  for (const pane of panesFor(state.screen)) {
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

  /* Only while a pane is showing. Closed, the command moved nothing anyone
   * could see — a label promising a visible result that did not come — and
   * the preference is set again the moment a pane opens on the other side. */
  if (state.pane !== null) {
    commands.push({
      id: 'pane:side',
      label: state.side === 'left' ? 'Move the pane to the right' : 'Move the pane to the left',
      group: 'Panels',
      keywords: 'position side',
      run: () => dispatch({ type: 'setSide', side: state.side === 'left' ? 'right' : 'left' }),
    })
  }

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
  /* The SAME faces the settings panel offers, which depends on what this
   * machine has — so they are handed in rather than looked up. Defaulted to the
   * bundled three, which exist everywhere: a palette listing a face the reader
   * does not have would run and silently change nothing. */
  for (const face of ctx.faces ?? BUNDLED_FACES) {
    commands.push({
      id: `typeface:${face.id}`,
      label: `Typeface — ${face.label}`,
      group: 'Appearance',
      keywords: `font family type ${GROUP_LABEL[face.group].toLowerCase()}`,
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

  /* Half of tagging happens while reading — this is the book that turned out
   * to be about the sea — and the shelf is a screen away. Same editor the
   * shelf opens, as a sheet. */
  if (ctx.editTags) {
    const editTags = ctx.editTags
    /* No `on:` — it could never light. The palette is a layer, layers are
     * exclusive, so `tagsOpen` is false whenever the palette is open to show
     * this row. */
    commands.push({
      id: 'book:tags',
      label: 'Tags for this book…',
      group: 'Book',
      combo: '⌘T',
      keywords: 'tag label subject shelve',
      run: editTags,
    })
  }

  if (ctx.exportTags) {
    const run = ctx.exportTags
    commands.push({
      id: 'tags:export',
      label: 'Export your tags…',
      group: 'Library',
      keywords: 'tag backup save export file json archive',
      run,
    })
  }

  if (ctx.importTags) {
    const run = ctx.importTags
    commands.push({
      id: 'tags:import',
      /* "Merge" in the label, because that is what it does and the word is the
         reassurance: an import never removes a tag, so restoring an old file
         cannot silently undo a month of filing. */
      label: 'Import tags from a file…',
      group: 'Library',
      keywords: 'tag restore load import merge file json archive backup',
      run,
    })
  }

  commands.push({
    id: 'screen:library',
    /* "Back to the reader" only when there is a book to go back TO. With none
     * open, the reader screen is the empty book-opening state — the titlebar
     * already words this correctly, and the palette said "back" to a place
     * the reader had never been. */
    label:
      state.screen === 'library'
        ? ctx.hasBook
          ? 'Back to the reader'
          : 'Go to the reader'
        : 'Go to the library',
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

  /* OMITTED WHILE ONE IS RUNNING, rather than offered and refused. A palette
   * entry that does nothing when you pick it is worse than one that is absent:
   * absence is legible, a dead row is a bug report. */
  if (!ctx.importing) commands.push({
    id: 'book:import-folder',
    label: 'Import a folder…',
    group: 'Book',
    /* "Add folder" is in the keywords rather than the label, because that is
     * what this control used to be CALLED and a reader who learned it there
     * will type it. The label says what happens — a folder is read once and its
     * books copied in — which the old one did not, and which is why it had to
     * be asked about. */
    keywords: 'add folder bulk collection recursive many',
    run: ctx.importFolder,
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
