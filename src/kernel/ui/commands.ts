import { paneAvailable, paneFits, screenJump } from './state'
import type { Command, CommandContext, PaneContribution } from '../core/capability'
import { DEFAULT_STEP_IDX, READING_STEPS, readingStep } from '../core/metrics'
import { panesFor, THEMES } from './panes'
import { BUNDLED_FACES, GROUP_LABEL, type Face } from '../core/typefaces'
import type { AppDispatch, AppState, PaneId } from './state'

/**
 * Everything the command palette can do, as data.
 *
 * §11 publishes a keyboard map, and a command that has a shortcut carries its
 * combo here, so the palette shows the reader the key. What the key DOES is
 * `resolveAccel` in `accel.ts` — a second mapping, and this header called the
 * pair "one registry" until the 2026-09-13 audit. What stops the two quietly
 * disagreeing is not a shared table but `commands.test.ts`'s "binds every combo
 * the palette prints", which puts each printed combo through the real map.
 *
 * Commands are built from the current state, so `on` reflects what is actually
 * true right now: the palette says "Close the side pane" when it is open rather
 * than offering to open something already open.
 */

/* `Command` is declared in `core/capability.ts` — a capability's commands are
 * the same shape as the kernel's, and the palette does not know which is
 * which. Re-exported here, so nothing that named it through this module has
 * moved. */
export type { Command } from '../core/capability'

/**
 * What the kernel's own commands are built from. A capability's commands see
 * `CommandContext` (core) instead — the React-free part of this, derived
 * below from the same state, so the two cannot disagree about what is true.
 */
export interface KernelCommandContext {
  state: AppState
  dispatch: AppDispatch
  /** False when the reader has no book open — book commands are then omitted. */
  hasBook: boolean
  /**
   * The faces to offer, which depends on what this machine has — see
   * `offeredFaces`. Omitted, only the bundled three are listed, which is the
   * conservative answer rather than a wrong one.
   */
  faces?: readonly Face[]
  /** Marks the current selection, when there is one. */
  markSelection: (() => void) | null
  /**
   * Looks the selection up — `LookUp.press`, null where there is no selection
   * or nothing to look it up with (phase 17, L4). The same handler the popup's
   * button and ⌃⌘D run, so the three cannot disagree about whether it works.
   */
  lookUp: (() => void) | null
  /**
   * Keeps the place the reader is at, or gives it back. Null when no place can
   * be pinned down — see `Bookmarking.canBookmark`.
   */
  toggleBookmark: (() => void) | null
  /**
   * Whether that place is ALREADY kept, so the row can say which of the two
   * things it does.
   *
   * Separate from `toggleBookmark` rather than folded into a nullable pair,
   * because the two answer different questions: one is "can this be done here",
   * the other is "which way round is it". A single value cannot distinguish
   * "nowhere to put one" from "there is not one here yet".
   */
  bookmarked: boolean
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
  /**
   * The reader's marginalia, out to a file and back.
   *
   * BESIDE THE TAG PAIR and for the same reason they are here rather than in a
   * panel: backing up is not annotation MANAGEMENT. A reader looking at
   * Marginalia is reading their notes, and a pair of file-dialog rows in that
   * surface is a second subject. It is also a rare action — done once, or
   * after something went wrong — which is what the palette is for.
   */
  exportMarks: (() => void) | null
  importMarks: (() => void) | null
  /**
   * Back to where the reader was, and forward again — null when the stack has
   * nothing that way.
   *
   * NULL RATHER THAN A DISABLED ROW, because the palette has no disabled state
   * and inventing one here would be a row that looks like every other row and
   * does nothing. The same condition gates the key in `accel.ts`, so a reader
   * who finds the row also finds a combo that works. See `canKeepPlace` for
   * the rule this follows.
   */
  jumpBack: (() => void) | null
  jumpForward: (() => void) | null
  /**
   * The composition's commands — `Composition.commands`. Appended after the
   * kernel's, built from a `CommandContext` derived from `state` here, so a
   * capability's `on` and labels reflect the same moment the kernel's do.
   * Omitted, the kernel is alone.
   */
  contributed?: (ctx: CommandContext) => readonly Command[]
  /**
   * The panes the composition contributed — `Composition.panes` — so each gets
   * the "Open …" row a kernel panel gets, on exactly the screens the rail
   * draws it.
   *
   * ⚠️ **CIRCLE AND PUBLISH HAD NO ROW.** The panel rows came from `PANES`
   * alone, so the two panels a desktop reader has beside every book could be
   * reached from their rail button and from nowhere else — not by name.
   * `contributed` above is a capability's own COMMANDS, which neither declares,
   * and a pane is not a command (2026-09-13 audit). Omitted, the kernel's
   * panels are alone, which is right for a host with no composition.
   */
  contributedPanes?: readonly Pick<PaneContribution, 'id' | 'label' | 'screens'>[]
}

export function buildCommands(ctx: KernelCommandContext): Command[] {
  const { state, dispatch } = ctx
  const commands: Command[] = []

  /* THE PANELS THIS SCREEN HAS. Listing all eight from the library offered
   * three that cannot open there — and a palette entry that does something
   * other than what it says is worse than one that is missing, because the
   * reader has already decided before they press return. */
  /* ONE ROW SHAPE FOR EVERY PANEL, the kernel's and a capability's alike. */
  const paneRow = (id: PaneId, label: string, combo: string | undefined): Command => {
    const open = state.pane === id
    return {
      id: `pane:${id}`,
      label: open ? `Close ${label}` : `Open ${label}`,
      group: 'Panels',
      ...(combo ? { combo } : {}),
      keywords: 'pane panel sidebar',
      on: open,
      run: () => (open ? dispatch({ type: 'closePane' }) : dispatch({ type: 'openPane', pane: id })),
    }
  }

  for (const pane of panesFor(state.screen, {
    developer: state.developer,
    hiddenPanes: state.hiddenPanes,
  })) {
    commands.push(paneRow(pane.id, pane.label, pane.combo))
  }

  /* THE CAPABILITIES' PANELS, after the kernel's and in the composition's
     order — the rail's own order — where `paneFits` says the rail draws them,
     so a row exists exactly where a button does. See `contributedPanes`. */
  const contributedPanes = ctx.contributedPanes ?? []
  for (const pane of contributedPanes) {
    if (paneFits(state.screen, pane.id, { contributed: contributedPanes, developer: state.developer, hiddenPanes: state.hiddenPanes })) {
      commands.push(paneRow(pane.id, pane.label, undefined))
    }
  }

  /* ⚠️ **ONLY WHERE THERE IS A PANE — see `paneAvailable`.** Offered on a
   * contributed screen, "Close the side pane" closed one nothing was drawing,
   * and the panel the reader had open was gone when they went back. The
   * reducer refuses it there now as well; this is what stops the row promising
   * it (2026-09-13 audit). */
  if (paneAvailable(state.screen)) {
    commands.push({
      id: 'pane:toggle',
      label: state.pane ? 'Close the side pane' : 'Open the side pane',
      group: 'Panels',
      combo: '⌘\\',
      on: state.pane !== null,
      run: () => dispatch({ type: 'togglePane' }),
    })
  }

  /* Only while a pane is showing. Closed, the command moved nothing anyone
   * could see — a label promising a visible result that did not come — and
   * the preference is set again the moment a pane opens on the other side.
   *
   * SHOWING IS NOT `pane !== null`. A contributed screen keeps `pane` set for
   * the trip back and draws none, so this offered to move a pane nobody could
   * see (2026-09-13 audit, beside the toggle above). */
  if (state.pane !== null && paneAvailable(state.screen)) {
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

  /* LOOK UP, beside Mark and for Mark's reason: omitted with nothing selected.
     It was reachable ONLY from the popup's button, so a reader who had
     dismissed the popup, or who reaches for the keyboard, had no way to it. */
  if (ctx.lookUp) {
    commands.push({
      id: 'book:look-up',
      label: 'Look up the selection',
      group: 'Book',
      combo: '⌃⌘D',
      keywords: 'define definition dictionary meaning gloss word translate',
      run: ctx.lookUp,
    })
  }

  /* Omitted where a place cannot be pinned down — before the renderer has
   * reported a position, and with no book open. The same rule ⌘D follows for
   * an absent selection, and for the same reason: a palette row that runs and
   * changes nothing is worse than one that is not there, because the reader
   * has already decided by the time they press return. */
  if (ctx.toggleBookmark) {
    const toggle = ctx.toggleBookmark
    commands.push({
      id: 'book:bookmark',
      /* Says what pressing it DOES, against what is true right now — the same
       * wording the footer button carries, so the two surfaces cannot describe
       * one action two ways. */
      label: ctx.bookmarked ? 'Remove this bookmark' : 'Bookmark this place',
      group: 'Book',
      combo: '⌘B',
      keywords: 'bookmark place keep return ribbon',
      on: ctx.bookmarked,
      run: toggle,
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

  if (ctx.jumpBack) {
    const run = ctx.jumpBack
    commands.push({
      id: 'jump:back',
      /* Named for what it does to the READER's position, not for the data
         structure. "Back" alone reads as the browser's, and this is not a
         page-turn history — it is the place they were before they followed
         something. */
      label: 'Back to where you were',
      group: 'Book',
      combo: '⌘[',
      keywords: 'back return jump history previous where was undo navigate',
      run,
    })
  }

  if (ctx.jumpForward) {
    const run = ctx.jumpForward
    commands.push({
      id: 'jump:forward',
      label: 'Forward again',
      group: 'Book',
      combo: '⌘]',
      keywords: 'forward jump history next redo navigate',
      run,
    })
  }

  /* REMOVED BOOKS — offered only from the shelf, which is where the reader
     noticed one missing. `trash.list` and `book.restore` have been services
     since phase 11; until this there was no way to reach either without a
     terminal, while the remove confirmation promised recovery on screen.
     KEYWORDS carry the words a reader actually types. Nobody hunting for a
     book they deleted searches "trash" first — they search "deleted", or
     "restore", or "undo". */
  if (ctx.state.screen === 'library') {
    commands.push({
      id: 'library:trash',
      label: 'Removed books…',
      group: 'Library',
      keywords: 'trash deleted removed restore undo recover bin',
      run: () => ctx.dispatch({ type: 'toggleLayer', layer: 'trashOpen' }),
    })
  }

  if (ctx.exportMarks) {
    const run = ctx.exportMarks
    commands.push({
      id: 'marks:export',
      /* NAMES BOTH THINGS IT WRITES, because a reader looking for a way out
         does not know whether Paper calls a card marginalia. */
      label: 'Export your marks and cards…',
      group: 'Library',
      keywords: 'mark note card highlight annotation backup save export file json markdown archive',
      run,
    })
  }

  if (ctx.importMarks) {
    const run = ctx.importMarks
    commands.push({
      id: 'marks:import',
      /* "Merge" in the label, exactly as the tag import says it, and it is the
         reassurance rather than the description: an import never removes a
         mark, so restoring an old file cannot silently undo a month of
         reading. */
      label: 'Import marks from a file… (merge)',
      group: 'Library',
      keywords: 'mark note card highlight annotation restore load import merge file json archive backup',
      run,
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
         cannot silently undo a month of filing.

         ⚠️ THE LABEL NEVER CARRIED IT. This comment, the marks import's
         "exactly as the tag import says it" and a test titled "says merge in
         the import label" all promised the word from the day this row was
         written, and the test read the keywords. Added — and the test now reads
         the label — by the 2026-09-13 audit. */
      label: 'Import tags from a file… (merge)',
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
    /* One source for the destination AND its name — see `screenJump`. The
       palette, the titlebar and the keyboard handler each derived these
       separately, and on a capability's screen two of the three disagreed. */
    label: screenJump(state.screen, ctx.hasBook).label,
    group: 'Book',
    // The key the titlebar button names and the handler binds. Three surfaces
    // for one action, and the palette is where a reader learns the shortcut.
    combo: '⌘L',
    keywords: 'shelf books home library',
    on: state.screen === 'library',
    run: () =>
      dispatch({ type: 'goScreen', screen: screenJump(state.screen, ctx.hasBook).to }),
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

  /* THE CAPABILITIES' COMMANDS, after the kernel's, from the same state. */
  if (ctx.contributed) {
    commands.push(
      ...ctx.contributed({
        screen: state.screen,
        pane: state.pane,
        hasBook: ctx.hasBook,
        openPane: (pane) => dispatch({ type: 'openPane', pane }),
      }),
    )
  }

  return commands
}

/**
 * Rank commands against a query.
 *
 * A prefix match on the label beats a match inside it, which beats a match on
 * the keywords, which beats every word of the query found somewhere across the
 * two — so typing "marg" puts "Open Marginalia" first rather than whichever
 * command happens to contain those letters earliest. Returns null for a miss so
 * the caller can drop the row rather than showing every command at rank zero.
 */
export function score(command: Command, query: string): number | null {
  const q = query.trim().toLowerCase()
  const label = command.label.toLowerCase()
  const at = label.indexOf(q)
  /* A PREFIX IS RANK 0 — and an empty query is a prefix of every label, which
     is how the palette lists everything before a key is typed.

     ⚠️ **ONE SEARCH, WHERE THERE WERE THREE** (2026-09-14). `if (!q)` and
     `startsWith` each returned 0 ahead of this for a case `indexOf` already
     puts at 0, so neither could change an answer and the mutation sweep said
     so — and behind them `at > 0` read exactly as `at >= 0`, a boundary no
     test could hold.

     ⚠️ **BOUNDED, so a label match cannot rank behind a keyword match.** This
     was `1 + at / 100` — 51 for a match five thousand characters in, behind the
     keywords' 50 and against the order stated above, and a capability's label
     has no length limit (2026-09-13 audit). Within a hundred characters,
     nearer still ranks higher. */
  if (at >= 0) return at === 0 ? 0 : 1 + Math.min(at, 99) / 100
  const keywords = command.keywords?.toLowerCase() ?? ''
  if (keywords.includes(q)) return 50
  /* ⚠️ **EVERY WORD, IN EITHER FIELD, IN ANY ORDER — once the phrase has had its
     chance.** Only a contiguous phrase inside one field matched, so "import
     folder" found nothing — the label says "Import a folder…" and the keywords
     say "add folder" — while "add folder" found the row (2026-09-13 audit). A
     one-word query has already been asked of both fields above, so this only
     ever answers for several. */
  if (q.split(' ').every((word) => label.includes(word) || keywords.includes(word))) return 55
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
