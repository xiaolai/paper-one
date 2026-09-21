import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Command } from '../core/capability'
import { buildCommands, filterCommands, score } from './commands'
import { DEFAULT_STEP_IDX, READING_STEPS } from '../core/metrics'
import { PANES, PANE_SHORTCUTS, panesFor } from './panes'
import { resolveAccel, resolvePageKey } from './accel'
import { initialState, paneFits, screenJump, type AppState } from './state'

function context(over: Partial<AppState> = {}) {
  const dispatched: unknown[] = []
  const ctx = {
    state: { ...initialState, ...over },
    dispatch: (action: unknown) => dispatched.push(action),
    hasBook: true,
    markSelection: null,
    lookUp: null,
    toggleBookmark: null,
    bookmarked: false,
    openBookPicker: () => {},
    importFolder: () => {},
    importing: false,
    closeBook: () => {},
    openSwitcher: () => {},
    editTags: null,
    exportTags: null,
    importTags: null,
    jumpBack: null,
    jumpForward: null,
    exportMarks: null,
    importMarks: null,
  }
  return { ctx, dispatched }
}

const find = (commands: Command[], id: string) => commands.find((c) => c.id === id)

describe('buildCommands', () => {
  it('names the action, not the thing — a pane that is open offers to close', () => {
    const open = buildCommands(context({ pane: 'marginalia' }).ctx)
    expect(find(open, 'pane:marginalia')?.label).toBe('Close Marginalia')
    expect(find(open, 'pane:marginalia')?.on).toBe(true)

    const shut = buildCommands(context({ pane: null }).ctx)
    expect(find(shut, 'pane:marginalia')?.label).toBe('Open Marginalia')
    expect(find(shut, 'pane:marginalia')?.on).toBe(false)
  })

  it('carries §11 combos, so the palette shows what the handler binds', () => {
    /* FROM THE REGISTRY, not from a list written out here. The hand-written
     * version named four of the five panels that carry a digit and had already
     * drifted — it did not include Bookmarks, and nothing compared it with
     * `PANES`. A second copy of a registry is a second opinion about it. */
    /* DEVELOPER OPTIONS ON, because one of the five digits is Cards and Cards
       is unfinished — see `UNFINISHED_PANE_IDS`. The claim being made here is
       that a panel the palette OFFERS carries the digit the keyboard BINDS, and
       a panel nobody is offered has neither. The other half of that pairing —
       the digit going dead with the panel — is the case below. */
    const commands = buildCommands(context({ screen: 'reader', developer: true }).ctx)
    for (const { combo, pane } of PANE_SHORTCUTS) {
      expect(find(commands, `pane:${pane}`)?.combo, `pane:${pane}`).toBe(combo)
    }
    expect(find(commands, 'pane:toggle')?.combo).toBe('⌘\\')
  })

  /**
   * ⚠️ **AN UNFINISHED PANEL IS NOT IN THE PALETTE EITHER.**
   *
   * The rail, the palette and the digits all read `paneFits`, which is the
   * point of folding `paneOffered` into it: a reader who has not turned
   * developer options on cannot reach Cards by any of the three, and there is
   * no fourth route that was forgotten.
   */
  it('does not offer the unfinished panel until developer options are on', () => {
    const plain = buildCommands(context({ screen: 'reader' }).ctx)
    expect(find(plain, 'pane:cards')).toBeUndefined()
    expect(find(plain, 'pane:dev')).toBeUndefined()

    const developer = buildCommands(context({ screen: 'reader', developer: true }).ctx)
    expect(find(developer, 'pane:cards')).toBeDefined()
    expect(find(developer, 'pane:dev')).toBeDefined()
  })

  /* HIDING ONE LEAVES THE REST. Developer is not unfinished and is not hidden
     by `hiddenPanes`, so it is what says the switch is per-panel rather than a
     second master. */
  it('drops one that developer options hid', () => {
    const commands = buildCommands(
      context({ screen: 'reader', developer: true, hiddenPanes: ['cards'] }).ctx,
    )
    expect(find(commands, 'pane:cards')).toBeUndefined()
    expect(find(commands, 'pane:dev')).toBeDefined()
  })

  /**
   * One side pane, fitted.
   *
   * Three panels need an open book, and offering them from the library is a
   * palette entry that does something other than what it says — which is worse
   * than one that is missing, because the reader has already decided by the time
   * they press return.
   */
  it('offers only the panels the screen has', () => {
    const library = buildCommands(context({ screen: 'library' }).ctx)
    expect(find(library, 'pane:toc')).toBeUndefined()
    expect(find(library, 'pane:search')).toBeUndefined()
    expect(find(library, 'pane:companion')).toBeUndefined()

    // The cross-book ones stay: they are why the library has a pane at all.
    expect(find(library, 'pane:marginalia')).toBeDefined()
    expect(find(library, 'pane:settings')).toBeDefined()
    /* Cards is cross-book too, and unfinished — so on the shelf it is a
       question of the SCREEN once the reader has asked to see it at all. */
    const shown = buildCommands(context({ screen: 'library', developer: true }).ctx)
    expect(find(shown, 'pane:cards')).toBeDefined()
  })

  it('offers all of them in a book', () => {
    /* Every kernel panel the reader screen has, from the registry — the list
     * written out here omitted Reading, so "all of them" was a claim about
     * five of the eight. */
    const reader = buildCommands(context({ screen: 'reader' }).ctx)
    for (const pane of panesFor('reader')) {
      expect(find(reader, `pane:${pane.id}`), pane.id).toBeDefined()
    }
  })

  it('omits the ruler in paginated flow, where it cannot do anything', () => {
    // §06: the reducer clears rulerOn when the layout changes, so offering the
    // command here would be a row that silently does nothing.
    const paginated = buildCommands(context({ pageLayout: 'paginated' }).ctx)
    expect(find(paginated, 'reading:ruler')).toBeUndefined()

    const scrolled = buildCommands(context({ pageLayout: 'scrolled' }).ctx)
    expect(find(scrolled, 'reading:ruler')).toBeDefined()
  })

  /**
   * ⚠️ **THE PALETTE IS THE WHOLE OF THE EXPORT'S SURFACE**, so this is the only
   * place the feature can be found at all — see `KernelCommandContext`. The row
   * is absent where the engine is (a browser, a phone), because a command that
   * would be refused is worse than one that is not offered.
   */
  it('offers the audiobook export only where the engine is and a book is open', () => {
    const { ctx } = context()
    expect(find(buildCommands(ctx), 'book:audiobook')).toBeUndefined()

    const able = { ...ctx, exportAudiobook: { running: false, run: () => {} } }
    expect(find(buildCommands(able), 'book:audiobook')?.label).toBe('Export as audiobook…')

    /* No book, nothing to export — the same rule every other Book row follows. */
    const shut = { ...able, hasBook: false }
    expect(find(buildCommands(shut), 'book:audiobook')).toBeUndefined()
  })

  it('turns the export row into a stop while one is running', () => {
    /* One command, two states: the reader who started it looks in the same place
       to stop it, rather than hunting for a second row that only sometimes
       exists. */
    const { ctx } = context()
    const running = { ...ctx, exportAudiobook: { running: true, run: () => {} } }
    const row = find(buildCommands(running), 'book:audiobook')
    expect(row?.label).toBe('Stop exporting the audiobook')
    expect(row?.on).toBe(true)
  })

  it('offers marking only when something is selected', () => {
    const { ctx } = context()
    expect(find(buildCommands(ctx), 'book:mark')).toBeUndefined()

    const withSelection = { ...ctx, markSelection: () => {} }
    expect(find(buildCommands(withSelection), 'book:mark')?.combo).toBe('⌘D')
  })

  /* The same rule ⌘D follows for an absent selection: a palette row that runs
   * and changes nothing is worse than one that is not there, because the reader
   * has already decided by the time they press return. */
  it('offers bookmarking only where a place can be pinned down', () => {
    const { ctx } = context()
    expect(find(buildCommands(ctx), 'book:bookmark')).toBeUndefined()

    const somewhere = { ...ctx, toggleBookmark: () => {} }
    expect(find(buildCommands(somewhere), 'book:bookmark')?.combo).toBe('⌘B')
  })

  /* Says what pressing it DOES, against what is true right now — the same
   * wording the footer button carries, so one action cannot be described two
   * ways by two surfaces. */
  it('names the direction the bookmark toggle would go', () => {
    const { ctx } = context()
    const fresh = { ...ctx, toggleBookmark: () => {}, bookmarked: false }
    expect(find(buildCommands(fresh), 'book:bookmark')?.label).toBe('Bookmark this place')
    expect(find(buildCommands(fresh), 'book:bookmark')?.on).toBe(false)

    const kept = { ...ctx, toggleBookmark: () => {}, bookmarked: true }
    expect(find(buildCommands(kept), 'book:bookmark')?.label).toBe('Remove this bookmark')
    expect(find(buildCommands(kept), 'book:bookmark')?.on).toBe(true)
  })

  it('offers closing the book only when one is open', () => {
    const { ctx } = context()
    expect(find(buildCommands({ ...ctx, hasBook: false }), 'book:close')).toBeUndefined()
    expect(find(buildCommands(ctx), 'book:close')).toBeDefined()
  })

  it('ticks the theme that is actually set', () => {
    const commands = buildCommands(context({ theme: 'sepia' }).ctx)
    expect(find(commands, 'theme:sepia')?.on).toBe(true)
    expect(find(commands, 'theme:night')?.on).toBe(false)
  })

  it('runs the action it advertises', () => {
    const { ctx, dispatched } = context({ pane: null })
    find(buildCommands(ctx), 'pane:marginalia')?.run()
    expect(dispatched).toEqual([{ type: 'openPane', pane: 'marginalia' }])
  })

  describe('reading size', () => {
    it('steps one §09 size at a time, in the direction it names', () => {
      const { ctx, dispatched } = context({ stepIdx: 3 })
      find(buildCommands(ctx), 'reading:bigger')?.run()
      find(buildCommands(ctx), 'reading:smaller')?.run()
      expect(dispatched).toEqual([
        { type: 'setStepIdx', idx: 4 },
        { type: 'setStepIdx', idx: 2 },
      ])
    })

    /* Same rule the ruler follows above: a command that cannot do anything is
     * not offered. At the largest size "Larger" would dispatch an index the
     * reducer clamps straight back, giving a palette row that visibly runs and
     * visibly changes nothing. */
    it('is not offered at the end of the ramp it would run off', () => {
      const biggest = buildCommands(context({ stepIdx: READING_STEPS.length - 1 }).ctx)
      expect(find(biggest, 'reading:bigger')).toBeUndefined()
      expect(find(biggest, 'reading:smaller')).toBeDefined()

      const smallest = buildCommands(context({ stepIdx: 0 }).ctx)
      expect(find(smallest, 'reading:smaller')).toBeUndefined()
      expect(find(smallest, 'reading:bigger')).toBeDefined()
    })

    it('offers the default size only when that is not already the size', () => {
      const moved = buildCommands(context({ stepIdx: 5 }).ctx)
      expect(find(moved, 'reading:size-default')).toBeDefined()
      find(moved, 'reading:size-default')?.run()

      const atDefault = buildCommands(context({ stepIdx: DEFAULT_STEP_IDX }).ctx)
      expect(find(atDefault, 'reading:size-default')).toBeUndefined()
    })

    it('names the size it would move to, in the §09 pixel sizes', () => {
      const commands = buildCommands(context({ stepIdx: 2 }).ctx)
      expect(find(commands, 'reading:bigger')?.label).toContain(`${READING_STEPS[3]!.size}`)
      expect(find(commands, 'reading:smaller')?.label).toContain(`${READING_STEPS[1]!.size}`)
    })
  })
})

/**
 * THE WHOLE MAP, ROW BY ROW (2026-09-14, mutation sweep).
 *
 * Every case above asks one row one question, and between them they never
 * read most of what the palette prints: the group a row is filed under, the
 * words it is found by, the label on the far side of a toggle, or what running
 * the row does. A row filed under no group, found by no word or running nothing
 * passed all of them — 146 such mutants did.
 */
describe('every row the palette prints', () => {
  /** A context offering every conditional row, each handler recording its own name. */
  const offering = (over: Partial<AppState>) => {
    const { ctx, dispatched } = context(over)
    const handler = (name: string) => () => {
      dispatched.push(name)
    }
    return {
      dispatched,
      ctx: {
        ...ctx,
        markSelection: handler('markSelection'),
        lookUp: handler('lookUp'),
        toggleBookmark: handler('toggleBookmark'),
        editTags: handler('editTags'),
        jumpBack: handler('jumpBack'),
        jumpForward: handler('jumpForward'),
        exportMarks: handler('exportMarks'),
        importMarks: handler('importMarks'),
        exportTags: handler('exportTags'),
        importTags: handler('importTags'),
        openBookPicker: handler('openBookPicker'),
        importFolder: handler('importFolder'),
        openSwitcher: handler('openSwitcher'),
        closeBook: handler('closeBook'),
      },
    }
  }

  /** Each row as the palette prints it, with what running it did in place of `run`. */
  const rowsOf = ({ ctx, dispatched }: ReturnType<typeof offering>) =>
    buildCommands(ctx).map(({ run, ...row }) => {
      const from = dispatched.length
      run()
      return { ...row, ran: dispatched.slice(from) }
    })

  it('names, files and finds each row exactly, in order, and runs what it names', () => {
    const PANE = 'pane panel sidebar'
    const THEME = 'colour color appearance'
    const reading = offering({
      screen: 'reader',
      pane: 'toc',
      side: 'left',
      rulerOn: true,
      scrollbarOn: false,
      progressLineOn: true,
      pageLayout: 'scrolled',
      stepIdx: 3,
      theme: 'sepia',
      typeface: 'instrument',
      themeFollowsOs: false,
    })
    expect(rowsOf(reading)).toEqual([
      { id: 'pane:toc', label: 'Close Contents', group: 'Panels', combo: '⌘1', keywords: PANE, on: true, ran: [{ type: 'closePane' }] },
      { id: 'pane:marginalia', label: 'Open Marginalia', group: 'Panels', combo: '⌘2', keywords: PANE, on: false, ran: [{ type: 'openPane', pane: 'marginalia' }] },
      { id: 'pane:search', label: 'Open Search', group: 'Panels', combo: '⌘3', keywords: PANE, on: false, ran: [{ type: 'openPane', pane: 'search' }] },
      { id: 'pane:settings', label: 'Open Settings', group: 'Panels', keywords: PANE, on: false, ran: [{ type: 'openPane', pane: 'settings' }] },
      { id: 'pane:toggle', label: 'Close the side pane', group: 'Panels', combo: '⌘\\', on: true, ran: [{ type: 'togglePane' }] },
      { id: 'pane:side', label: 'Move the pane to the right', group: 'Panels', keywords: 'position side', ran: [{ type: 'setSide', side: 'right' }] },
      { id: 'reading:ruler', label: 'Turn the reading ruler off', group: 'Reading', keywords: 'line guide focus', on: true, ran: [{ type: 'toggleRuler' }] },
      { id: 'reading:scrollbar', label: 'Show the scrollbar', group: 'Reading', keywords: 'scroll bar gutter position', on: false, ran: [{ type: 'toggleScrollbar' }] },
      { id: 'reading:progress', label: 'Hide the progress rule', group: 'Reading', keywords: 'progress bar edge colour color how far', on: true, ran: [{ type: 'toggleProgressLine' }] },
      { id: 'reading:flow', label: 'Switch to pages', group: 'Reading', keywords: 'flow paginated scrolled layout', ran: [{ type: 'setPageLayout', layout: 'paginated' }] },
      { id: 'reading:bigger', label: `Larger type — ${READING_STEPS[4]!.size}px`, group: 'Reading', combo: '⌘+', keywords: 'size text bigger increase zoom', ran: [{ type: 'setStepIdx', idx: 4 }] },
      { id: 'reading:smaller', label: `Smaller type — ${READING_STEPS[2]!.size}px`, group: 'Reading', combo: '⌘−', keywords: 'size text smaller decrease zoom', ran: [{ type: 'setStepIdx', idx: 2 }] },
      { id: 'reading:size-default', label: `Default type size — ${READING_STEPS[DEFAULT_STEP_IDX]!.size}px`, group: 'Reading', combo: '⌘0', keywords: 'size text reset', ran: [{ type: 'setStepIdx', idx: DEFAULT_STEP_IDX }] },
      { id: 'theme:paper', label: 'Theme — Paper', group: 'Appearance', keywords: THEME, on: false, ran: [{ type: 'setTheme', theme: 'paper' }] },
      { id: 'theme:slate', label: 'Theme — Slate', group: 'Appearance', keywords: THEME, on: false, ran: [{ type: 'setTheme', theme: 'slate' }] },
      { id: 'theme:sepia', label: 'Theme — Sepia', group: 'Appearance', keywords: THEME, on: true, ran: [{ type: 'setTheme', theme: 'sepia' }] },
      { id: 'theme:sage', label: 'Theme — Sage', group: 'Appearance', keywords: THEME, on: false, ran: [{ type: 'setTheme', theme: 'sage' }] },
      { id: 'theme:night', label: 'Theme — Night', group: 'Appearance', keywords: THEME, on: false, ran: [{ type: 'setTheme', theme: 'night' }] },
      /* The face's GROUP is in its keywords, in the lower case every other row's are. */
      { id: 'typeface:literata', label: 'Typeface — Literata', group: 'Appearance', keywords: 'font family type serif, for reading', on: false, ran: [{ type: 'setTypeface', typeface: 'literata' }] },
      { id: 'typeface:instrument', label: 'Typeface — Instrument Sans', group: 'Appearance', keywords: 'font family type sans', on: true, ran: [{ type: 'setTypeface', typeface: 'instrument' }] },
      { id: 'typeface:plex', label: 'Typeface — IBM Plex Mono', group: 'Appearance', keywords: 'font family type monospaced', on: false, ran: [{ type: 'setTypeface', typeface: 'plex' }] },
      { id: 'theme:follow', label: 'Follow the system appearance', group: 'Appearance', on: false, ran: [{ type: 'setThemeFollowsOs', follows: true }] },
      { id: 'book:mark', label: 'Mark the selection', group: 'Book', combo: '⌘D', keywords: 'highlight annotate', ran: ['markSelection'] },
      { id: 'book:bookmark', label: 'Bookmark this place', group: 'Book', combo: '⌘B', keywords: 'bookmark place keep return ribbon', on: false, ran: ['toggleBookmark'] },
      { id: 'book:tags', label: 'Tags for this book…', group: 'Book', combo: '⌘T', keywords: 'tag label subject shelve', ran: ['editTags'] },
      { id: 'jump:back', label: 'Back to where you were', group: 'Book', combo: '⌘[', keywords: 'back return jump history previous where was undo navigate', ran: ['jumpBack'] },
      { id: 'jump:forward', label: 'Forward again', group: 'Book', combo: '⌘]', keywords: 'forward jump history next redo navigate', ran: ['jumpForward'] },
      /* No `on`: a jump always names the other screen, so it has no state to be on. */
      { id: 'screen:library', label: 'Library', group: 'Book', combo: '⌘L', keywords: 'shelf books home library', ran: [{ type: 'goScreen', screen: 'library' }] },
      { id: 'book:open', label: 'Add books…', group: 'Book', keywords: 'import file epub open', ran: ['openBookPicker'] },
      { id: 'book:import-folder', label: 'Import a folder…', group: 'Book', keywords: 'add folder bulk collection recursive many', ran: ['importFolder'] },
      { id: 'book:switch', label: 'Switch book…', group: 'Book', keywords: 'library recent', ran: ['openSwitcher'] },
      { id: 'book:close', label: 'Close the book', group: 'Book', ran: ['closeBook'] },
      /* ⚠️ **LIBRARY AFTER BOOK, AND THIS TABLE USED TO PIN BOOK, LIBRARY, BOOK.**
         The palette draws a heading whenever the group changes, so that order
         put "Book" on screen twice; `contiguous` joins a split group now, and
         the table says the order the reader sees. */
      { id: 'marks:export', label: 'Export your marks and cards…', group: 'Library', keywords: 'mark note card highlight annotation backup save export file json markdown archive', ran: ['exportMarks'] },
      { id: 'marks:import', label: 'Import marks from a file… (merge)', group: 'Library', keywords: 'mark note card highlight annotation restore load import merge file json archive backup', ran: ['importMarks'] },
      { id: 'tags:export', label: 'Export your tags…', group: 'Library', keywords: 'tag backup save export file json archive', ran: ['exportTags'] },
      { id: 'tags:import', label: 'Import tags from a file… (merge)', group: 'Library', keywords: 'tag restore load import merge file json archive backup', ran: ['importTags'] },
    ])
  })

  /* THE FAR SIDE OF EVERY ROW THAT HAS ONE. The table above sees each toggle
     one way round, so a row that said, lit or did the same thing both ways
     would pass it. */
  it('says, lights and does the other thing from the other side of each toggle', () => {
    const FLIPPED = [
      { over: { screen: 'reader', pane: null }, id: 'pane:toggle', label: 'Open the side pane', on: false, ran: [{ type: 'togglePane' }] },
      { over: { screen: 'reader', pane: 'toc', side: 'right' }, id: 'pane:side', label: 'Move the pane to the left', ran: [{ type: 'setSide', side: 'left' }] },
      { over: { rulerOn: false }, id: 'reading:ruler', label: 'Turn the reading ruler on', on: false, ran: [{ type: 'toggleRuler' }] },
      { over: { scrollbarOn: true }, id: 'reading:scrollbar', label: 'Hide the scrollbar', on: true, ran: [{ type: 'toggleScrollbar' }] },
      { over: { progressLineOn: false }, id: 'reading:progress', label: 'Show the progress rule', on: false, ran: [{ type: 'toggleProgressLine' }] },
      { over: { pageLayout: 'paginated' }, id: 'reading:flow', label: 'Switch to scrolling', ran: [{ type: 'setPageLayout', layout: 'scrolled' }] },
      { over: { themeFollowsOs: true }, id: 'theme:follow', label: 'Stop following the system appearance', on: true, ran: [{ type: 'setThemeFollowsOs', follows: false }] },
      { over: { screen: 'library' }, id: 'screen:library', label: 'Back to the book', ran: [{ type: 'goScreen', screen: 'reader' }] },
    ] as const
    for (const { over, id, ...expected } of FLIPPED) {
      expect(rowsOf(offering(over)).find((row) => row.id === id), id).toMatchObject(expected)
    }
  })

  /* ⚠️ **A JUMP IS NEVER "ON", AND THIS ROW USED TO SAY IT WAS.** `on` means a
     command names a state that is currently on; the screen jump always names the
     OTHER screen, so on the library — labelled "Back to the book" — it drew a
     checkmark beside a place the reader was not. The case above pinned that as
     correct. Asked of both screens, because both are where somebody looks. */
  it('never marks the screen jump as on, whichever screen the reader is on', () => {
    for (const screen of ['reader', 'library'] as const) {
      const jump = rowsOf(offering({ screen })).find((row) => row.id === 'screen:library')
      expect(jump, screen).toBeDefined()
      expect(jump && 'on' in jump ? jump.on : undefined, screen).toBeUndefined()
    }
  })

  /* AND EACH GROUP IS ONE HEADING. The palette draws one whenever the group
     changes as it walks the list, so a group whose rows are not together is
     drawn twice — which "Book" was, around the Library rows. */
  it('keeps every group together, so none is drawn under two headings', () => {
    for (const screen of ['reader', 'library'] as const) {
      const groups = rowsOf(offering({ screen })).map((row) => row.group)
      const runs = groups.filter((group, at) => group !== groups[at - 1])
      expect(new Set(runs).size, `${screen}: ${runs.join(', ')}`).toBe(runs.length)
    }
  })

  /* THE SHELF'S OWN ROW, which a table read from the reader cannot see. */
  it('files the removed books under Library, on the shelf', () => {
    expect(rowsOf(offering({ screen: 'library' })).find((row) => row.id === 'library:trash')).toEqual({
      id: 'library:trash',
      label: 'Removed books…',
      group: 'Library',
      keywords: 'trash deleted removed restore undo recover bin',
      ran: [{ type: 'toggleLayer', layer: 'trashOpen' }],
    })
  })

  /* AND NOTHING THE CONTEXT CANNOT DO. A handed-in action is a row exactly when
     its handler is there — a row built without one would run nothing. */
  it('offers each handed-in action only with its handler', () => {
    const bare = context({ screen: 'reader' }).ctx
    const without = buildCommands(bare).map((command) => command.id)
    const GATED = [
      ['book:mark', { markSelection: () => {} }],
      ['book:bookmark', { toggleBookmark: () => {} }],
      ['book:tags', { editTags: () => {} }],
      ['jump:back', { jumpBack: () => {} }],
      ['jump:forward', { jumpForward: () => {} }],
      ['marks:export', { exportMarks: () => {} }],
      ['marks:import', { importMarks: () => {} }],
      ['tags:export', { exportTags: () => {} }],
      ['tags:import', { importTags: () => {} }],
    ] as const
    for (const [id, handler] of GATED) {
      const added = buildCommands({ ...bare, ...handler })
        .map((command) => command.id)
        .filter((one) => !without.includes(one))
      expect(added, id).toEqual([id])
    }
  })

  /* SHOWING, WHICH NEEDS A PANEL AS WELL AS A SCREEN THAT DRAWS ONE: with none
     open there is nothing to move. The contributed screen is the case below. */
  it('offers to move the pane only while one is open', () => {
    const shut = buildCommands(context({ screen: 'reader', pane: null }).ctx)
    expect(find(shut, 'pane:toggle')).toBeDefined()
    expect(find(shut, 'pane:side')).toBeUndefined()
  })
})

/**
 * The invariant `commands.ts` claims in its own header — "the palette shows the
 * same combo the handler binds, and neither can quietly stop matching the
 * other" — and which nothing enforced until the size shortcuts were added.
 *
 * Read from App's SOURCE rather than by dispatching a synthetic KeyboardEvent,
 * for the reason the ⌘1…5 test above gives: the two things that must agree live
 * in different files, and a test that asks the registry about itself can only
 * ever agree with itself. A combo advertised in the palette and bound nowhere
 * is a row that prints a keystroke which does nothing.
 */
describe('advertised combos are bound', () => {
  /**
   * Everything a bound key could want, so a guard is never what answers.
   *
   * The point of the check below is the MAP, not the guards — those have their
   * own cases further down. A context with anything missing would let a key
   * pass for the wrong reason: absent, rather than declined.
   */
  const anything = {
    platform: 'macos',
    screen: 'reader',
    pane: null,
    hasSelection: true,
    canBookmark: true,
    onReader: true,
    hasBook: true,
    canJumpBack: true,
    canJumpForward: true,
  } as const

  /**
   * Ctrl+Q is a quit only where nothing else owns the key. macOS has an
   * application menu whose Quit item takes ⌘Q before the webview sees it;
   * Windows and Linux have no menu bar, so with decorations off the close
   * button was the only quit — and a held key must not fire a close per
   * repeat, on the rule every other toggle follows.
   */
  it('binds Ctrl+Q to quit off macOS, and leaves ⌘Q to the platform on it', () => {
    expect(resolveAccel({ key: 'q', repeat: false }, { ...anything, platform: 'windows' })).toEqual({ kind: 'quit' })
    expect(resolveAccel({ key: 'q', repeat: false }, { ...anything, platform: 'linux' })).toEqual({ kind: 'quit' })
    expect(resolveAccel({ key: 'q', repeat: false }, anything)).toBeNull()
    expect(resolveAccel({ key: 'q', repeat: true }, { ...anything, platform: 'windows', pressTaken: true })).toEqual({ kind: 'held' })
  })

  /**
   * Repeat suppression comes from the ACTION'S KIND, not a second key list.
   * The hand-kept set this replaced had drifted: `l` was bound and unlisted,
   * so a held ⌘L flickered between reader and library, and a held ⌘D wrote a
   * mark and a tombstone per repeat — ⌘B's defect on another key. The walks
   * (⌘+, ⌘[) stay repeatable on purpose; everything else is one press.
   */
  /* AND A SUPPRESSED REPEAT IS TAKEN — `held` — never `null`, which hands the
     key to the platform: the first press was Paper's and every repeat after it
     went to whatever the webview does with the combo (2026-09-13 audit). */
  it('suppresses a repeat for every binding that is not a walk — including the two the old list missed', () => {
    expect(resolveAccel({ key: 'l', repeat: false }, anything)).toEqual({ kind: 'toggleScreen' })
    expect(resolveAccel({ key: 'l', repeat: true }, { ...anything, pressTaken: true })).toEqual({ kind: 'held' })
    const selecting = { ...anything, hasSelection: true }
    expect(resolveAccel({ key: 'd', repeat: false }, selecting)).toEqual({ kind: 'markSelection' })
    expect(resolveAccel({ key: 'd', repeat: true }, { ...selecting, pressTaken: true })).toEqual({ kind: 'held' })
    /* A repeat of a press that was not bound here stays the platform's. */
    expect(resolveAccel({ key: 'd', repeat: true }, { ...selecting, hasSelection: false, pressTaken: false })).toBeNull()
    /* The walks still repeat. */
    expect(resolveAccel({ key: '=', repeat: true }, { ...anything, pressTaken: true })).toEqual({ kind: 'stepBy', delta: 1 })
    expect(
      resolveAccel({ key: '[', repeat: true }, { ...anything, canJumpBack: true, pressTaken: true }),
    ).toEqual({ kind: 'jumpBack' })
  })

  /**
   * Caps Lock is not Shift. With it latched every letter arrives uppercase,
   * and the letter shortcuts all went dead; with Shift genuinely down the
   * combo is a different one and stays unbound.
   */
  it('reads a Caps-Locked letter as the letter, and a shifted one as a different combo', () => {
    const bookmarkable = { ...anything, onReader: true, canBookmark: true }
    expect(resolveAccel({ key: 'B', repeat: false }, bookmarkable)).toEqual({ kind: 'toggleBookmark' })
    expect(resolveAccel({ key: 'B', repeat: false, shiftKey: true }, bookmarkable)).toBeNull()
    /* ⚠️ AND NOT ONLY BECAUSE THE ENGINE UPPERCASED IT. The case was the only
       thing standing for Shift, so an engine reporting the unshifted letter
       under ⌘ — `b`, with Shift down — bookmarked (2026-09-13 audit). */
    expect(resolveAccel({ key: 'b', repeat: false, shiftKey: true }, bookmarkable)).toBeNull()
    /* As a real event reports it: `shiftKey` is false, not absent. */
    expect(resolveAccel({ key: 'B', repeat: false, shiftKey: false }, bookmarkable)).toEqual({ kind: 'toggleBookmark' })
  })

  /**
   * What a printed combo requires the handler to bind.
   *
   * Explicit rather than derived from the glyph, because the two are genuinely
   * not the same string and pretending otherwise is how this test first failed
   * against correct code. The palette prints ⌘− with a true minus (U+2212),
   * which is right for a page of type and is not a key any keyboard reports;
   * `KeyboardEvent.key` gives a hyphen-minus. And a key with a shifted twin has
   * to bind BOTH — ⌘+ on a US layout is ⌘⇧= and reports '+', while ⌘= reports
   * '=' — or the shortcut works only for readers who happened to hold shift.
   *
   * Panel digits are absent on purpose: ⌘1…5 is bound from PANE_SHORTCUTS, and
   * the test above already checks that table against the renderer.
   */
  /* A key, or — for a chord that stacks Control on the accelerator — the whole
     event a real press produces, because `key` alone cannot say Control was
     down and `accel.ts` binds such a chord on the physical key. */
  type Press = string | { readonly key: string; readonly code: string; readonly ctrlKey: boolean }
  const KEYS_FOR_COMBO: Record<string, readonly Press[]> = {
    '⌘K': ['k'],
    /* ONE BACKSLASH, which it could not be while this searched App's source:
       the source spells that key as an escaped pair, so the table had to
       hold the escaped form in order to find it. That is the search method
       leaking into what the test claims — the key a keyboard actually
       reports is a single backslash. */
    '⌘\\': ['\\'],
    '⌘D': ['d'],
    '⌘B': ['b'],
    /* ⌘T was escaping this check for exactly the reason ⌘B was — `editTags`
     * was null in the fixture, so the command was never built and its combo
     * never reached the table. Switching every conditional command on is what
     * surfaced it. */
    '⌘T': ['t'],
    '⌘L': ['l'],
    '⌘+': ['=', '+'],
    '⌘−': ['-', '_'],
    '⌘0': ['0'],
    '⌘[': ['['],
    '⌘]': [']'],
  }

  it('binds every combo the palette prints', () => {
    /*
     * EVERY CONDITIONAL COMMAND SWITCHED ON, and on the READER screen.
     *
     * This ran on the library with `toggleBookmark` and `editTags` null, so the
     * commands that only exist under a condition were never built and their
     * combos were never examined — ⌘B could have been advertised and bound to
     * nothing and this would still have passed. The screen matters for the same
     * reason: three panels do not exist on the library, so ⌘6 was absent too.
     *
     * The pane digits are excluded through `PANE_SHORTCUTS` rather than a
     * `⌘[1-5]` regex. The regex was a second copy of the registry written as a
     * character range, and it silently stopped covering the registry the moment
     * a sixth panel arrived: ⌘6 fell through into the table lookup below, which
     * would have failed for the right reason by luck rather than by design.
     */
    const everything = {
      ...context({ screen: 'reader' }).ctx,
      markSelection: () => {},
      lookUp: () => {},
      toggleBookmark: () => {},
      editTags: () => {},
      exportTags: () => {},
      importTags: () => {},
      jumpBack: () => {},
      jumpForward: () => {},
      exportMarks: () => {},
      importMarks: () => {},
    }
    const digits = new Set(PANE_SHORTCUTS.map((entry) => entry.combo))
    const advertised = new Set(
      buildCommands(everything)
        .map((command) => command.combo)
        .filter((combo): combo is string => combo !== undefined)
        .filter((combo) => !digits.has(combo)),
    )
    expect(advertised.size).toBeGreaterThan(0)
    // The commands this test exists for must actually be in the set it checks.
    expect(advertised.has('⌘B')).toBe(true)
    expect(advertised.has('⌘D')).toBe(true)

    for (const combo of advertised) {
      const keys = KEYS_FOR_COMBO[combo]
      // A new combo with no entry here is the failure, not an exemption: it
      // means the palette prints a keystroke this test cannot confirm exists.
      expect(keys, `no expected key for ${combo}`).toBeDefined()
      for (const press of keys ?? []) {
        /* THE KEY IS PUT THROUGH THE MAP, not looked for in App's source. The
           search was the whole weakness: a literal in a comment satisfied it,
           and so did one in an unreachable branch or behind the wrong
           modifier. Now the combo the palette prints has to actually produce
           an action from the key a keyboard reports. */
        const event = typeof press === 'string' ? { key: press } : press
        expect(
          resolveAccel({ ...event, repeat: false }, anything),
          `${combo} prints, but '${event.key}' resolves to nothing`,
        ).not.toBeNull()
      }
    }
  })

  /* THE DIGITS, which the check above excludes because they come from the pane
     registry rather than the command list. Excluded there and unchecked
     everywhere was the hole: deleting the digit branch entirely left the suite
     green, because the only other test of it asserted that the PANELS render. */
  it('binds every panel digit the rail advertises, and toggles the open one', () => {
    /* DEVELOPER OPTIONS ON, because ⌘4 is Cards and Cards is unfinished. What
       is being checked here is that an OFFERED panel's digit works; that a
       panel nobody is offered has a dead digit is the case below, and the two
       together are the whole rule. */
    const offered = { ...anything, developer: true }
    for (const { digit, pane } of PANE_SHORTCUTS) {
      expect(resolveAccel({ key: digit, repeat: false }, offered), `⌘${digit}`).toEqual({
        kind: 'openPane',
        pane,
      })
      /* The same key on the panel it opened closes it — the palette row for an
         open panel says "Close" and carries this combo. */
      expect(resolveAccel({ key: digit, repeat: false }, { ...offered, pane })).toEqual({
        kind: 'closePane',
      })
    }
  })

  /**
   * ⚠️ **A DIGIT FOR A PANEL NOBODY IS OFFERED IS DEAD**, the same way a digit
   * for a panel this screen has not got is dead. A key that opens something the
   * rail does not draw is the mirror of a rail button that opens nothing.
   */
  it('leaves an unfinished panel’s digit unbound until developer options are on', () => {
    const cards = PANE_SHORTCUTS.find(({ pane }) => pane === 'cards')
    expect(cards, 'Cards no longer carries a digit — this check needs rewriting').toBeDefined()
    expect(resolveAccel({ key: cards!.digit, repeat: false }, anything)).toBeNull()
    expect(
      resolveAccel({ key: cards!.digit, repeat: false }, { ...anything, developer: true }),
    ).toEqual({ kind: 'openPane', pane: 'cards' })
    /* And hidden inside developer options, it goes dead again. */
    expect(
      resolveAccel(
        { key: cards!.digit, repeat: false },
        { ...anything, developer: true, hiddenPanes: ['cards'] },
      ),
    ).toBeNull()
  })

  /**
   * ⌘⌃⌥D, the only way into developer options.
   */
  describe('the developer chord', () => {
    /* ⚠️ **THE EXACT EVENT A REAL PRESS PRODUCES**, measured in the running app
       on 2026-08-30 rather than assumed: `{ key: 'd', code: 'KeyD' }` with all
       three modifiers down. The first version of this binding guessed that
       macOS would rewrite the character under Option — ⌥D alone is `∂` — and
       matched a set of three spellings on that reasoning. With Command held the
       unmodified character is reported, so the guess happened to work and its
       stated reason was false. `code` is what the binding reads now. */
    it('is bound with all three modifiers', () => {
      expect(
        resolveAccel({ key: 'd', code: 'KeyD', repeat: false, ctrlKey: true, altKey: true }, anything),
      ).toEqual({ kind: 'toggleDeveloper' })
    })

    /* THE PHYSICAL KEY, so nothing a modifier or a layout does to the character
       can unbind it — Caps Lock, AltGr on a Windows layout, or an Option that
       does rewrite it in some combination this app has not measured. */
    it('does not care what the character came out as', () => {
      for (const key of ['d', 'D', '∂']) {
        expect(
          resolveAccel({ key, code: 'KeyD', repeat: false, ctrlKey: true, altKey: true }, anything),
          key,
        ).toEqual({ kind: 'toggleDeveloper' })
      }
    })

    /* And a different physical key with the same modifiers is not the chord,
       which is what stops `code` being a looser test than `key` rather than a
       different one. */
    it('is not bound on another key', () => {
      expect(
        resolveAccel({ key: 'e', code: 'KeyE', repeat: false, ctrlKey: true, altKey: true }, anything),
      ).toBeNull()
    })

    /* ⚠️ **⌘D STILL MARKS THE SELECTION.** `d` was already bound, and nothing
       else in the map reads `ctrlKey` or `altKey` — so without an exclusive
       match ahead of the switch, the four-key chord marked a passage instead. */
    it('does not take ⌘D away from marking', () => {
      expect(resolveAccel({ key: 'd', repeat: false }, anything)).toEqual({ kind: 'markSelection' })
    })

    /* Two of the three modifiers is not the chord.
       ⌃⌘D WAS "markSelection" HERE, THEN Look up (phase 17, L4), AND IS NOW
       UNBOUND — see the chord's own describe below. What this case exists to
       hold is that it is NOT the developer chord, which has been true
       throughout.
       ⌥⌘D WAS "markSelection" TOO, until the 2026-09-13 audit: a letter is
       bound under the accelerator alone, so with Option it is no binding. */
    it('needs both Control and Option', () => {
      /* Control alone was Look up until that feature was deleted; the key is
         the platform's again, which is still not the developer chord. */
      expect(
        resolveAccel({ key: 'd', code: 'KeyD', repeat: false, ctrlKey: true }, anything),
      ).toBeNull()
      expect(
        resolveAccel({ key: 'd', code: 'KeyD', repeat: false, altKey: true }, anything),
      ).toBeNull()
    })

    /* EXACTLY THOSE THREE. Shift was never read, so ⇧ on top of the chord was
       still the chord; now it is no binding at all, whichever case the engine
       reports the letter in (2026-09-13 audit). */
    it('is not bound with Shift added', () => {
      const shifted = { code: 'KeyD', repeat: false, ctrlKey: true, altKey: true, shiftKey: true }
      for (const key of ['d', 'D']) {
        expect(resolveAccel({ ...shifted, key }, anything), key).toBeNull()
        expect(resolveAccel({ ...shifted, key }, { ...anything, platform: 'windows' }), `${key} off a Mac`).toBeNull()
      }
    })

    /* A REPEAT IS THE SAME PRESS. Holding it would flicker developer options
       on and off for as long as the key is down — the rule `REPEATABLE` states,
       arriving on a new binding. Taken, not handed to the platform. */
    it('does not fire again while the key is held', () => {
      expect(
        resolveAccel({ key: 'd', code: 'KeyD', repeat: true, ctrlKey: true, altKey: true }, { ...anything, pressTaken: true }),
      ).toEqual({ kind: 'held' })
    })
  })

  /**
   * ⚠️ **⌃⌘D WAS LOOK UP AND IS NOW UNBOUND.** Phase 17 gave it macOS's own
   * Look Up meaning; the whole feature is deleted, and the key went back to the
   * platform rather than to something else. On a Mac that means the system's
   * Look Up answers it again, which is what a reader pressing it expects.
   *
   * The DEVELOPER chord shares the physical key and is matched before the
   * letters, so it is asserted here beside its neighbour rather than taken on
   * trust — that ordering is the thing a removal could quietly break.
   */
  describe('⌃⌘D, and the developer chord beside it', () => {
    const press = (over: Record<string, unknown>) => ({ key: 'd', code: 'KeyD', repeat: false, ...over })

    it('leaves ⌃⌘D to the platform on a Mac, and Ctrl+Shift+D off one', () => {
      expect(resolveAccel(press({ ctrlKey: true }), anything)).toBeNull()
      for (const platform of ['windows', 'linux'] as const) {
        expect(resolveAccel(press({ key: 'D', ctrlKey: true, shiftKey: true }), { ...anything, platform }), platform).toBeNull()
      }
    })

    /* Off a Mac, Control IS the accelerator, so Ctrl+D there is the plain ⌘D
       this key has always been — the one binding the removal must not disturb. */
    it('leaves Ctrl+D marking off a Mac, and ⌘D marking on one', () => {
      expect(resolveAccel(press({ ctrlKey: true }), { ...anything, platform: 'windows' })).toEqual({ kind: 'markSelection' })
      expect(resolveAccel(press({}), anything)).toEqual({ kind: 'markSelection' })
    })

    it('still toggles developer options on ⌘⌃⌥D, on every platform', () => {
      expect(resolveAccel(press({ ctrlKey: true, altKey: true }), anything)).toEqual({ kind: 'toggleDeveloper' })
      expect(
        resolveAccel(press({ ctrlKey: true, altKey: true }), { ...anything, platform: 'windows' }),
      ).toEqual({ kind: 'toggleDeveloper' })
    })
  })

  /**
   * ⚠️ **A LETTER IS BOUND UNDER THE ACCELERATOR ALONE** (2026-09-13 audit).
   * Nothing in the map read a modifier for the letters, so ⌥⌘B bookmarked, ⌃⌘L
   * left the book and Ctrl+Alt+Q closed the window. Every letter, each extra
   * modifier on its own: one binding that forgot the rule is the defect.
   */
  describe('the letters and their modifiers', () => {
    const LETTERS = [
      { key: 'k', kind: 'togglePalette' },
      { key: 'l', kind: 'toggleScreen' },
      { key: 'd', kind: 'markSelection' },
      { key: 'b', kind: 'toggleBookmark' },
      { key: 't', kind: 'editTags' },
    ] as const
    const windows = { ...anything, platform: 'windows' } as const

    it('binds each letter with nothing but the accelerator, on either platform', () => {
      for (const { key, kind } of LETTERS) {
        expect(resolveAccel({ key, repeat: false }, anything), `⌘${key}`).toEqual({ kind })
        /* Off a Mac Control IS the accelerator, so it is no extra modifier. */
        expect(resolveAccel({ key, repeat: false, ctrlKey: true }, windows), `Ctrl+${key}`).toEqual({ kind })
      }
      expect(resolveAccel({ key: 'q', repeat: false, ctrlKey: true }, windows)).toEqual({ kind: 'quit' })
    })

    it('binds no letter with Shift, Option or — on a Mac — Control added', () => {
      for (const { key } of LETTERS) {
        expect(resolveAccel({ key, repeat: false, shiftKey: true }, anything), `⇧⌘${key}`).toBeNull()
        expect(resolveAccel({ key, repeat: false, altKey: true }, anything), `⌥⌘${key}`).toBeNull()
        expect(resolveAccel({ key, repeat: false, ctrlKey: true }, anything), `⌃⌘${key}`).toBeNull()
      }
      /* The quit, which closes the window. */
      expect(resolveAccel({ key: 'q', repeat: false, ctrlKey: true, altKey: true }, windows)).toBeNull()
      expect(resolveAccel({ key: 'q', repeat: false, ctrlKey: true, shiftKey: true }, windows)).toBeNull()
    })

    /* THE CHARACTERS ARE NOT LETTERS, and their modifiers are the layout's:
       ⌘+ arrives as ⇧= on a US board, reporting '+' with Shift down. */
    it('still binds a character that took Shift to type', () => {
      expect(resolveAccel({ key: '+', repeat: false, shiftKey: true }, anything)).toEqual({ kind: 'stepBy', delta: 1 })
      expect(resolveAccel({ key: '_', repeat: false, shiftKey: true }, anything)).toEqual({ kind: 'stepBy', delta: -1 })
      /* And Option: `[` is ⌥5 on a German Mac. */
      expect(resolveAccel({ key: '[', repeat: false, altKey: true }, anything)).toEqual({ kind: 'jumpBack' })
    })
  })

  /**
   * ⚠️ **META WAS NEVER READ** (2026-09-13 audit, #85, round 3). Round 1 closed
   * Shift, Option and — on a Mac — Control, and stopped there: off a Mac the
   * fourth modifier is Meta (⊞, Super), and nothing in the map looked at it, so
   * Ctrl+Meta+Q closed the window on Windows and Ctrl+Alt+Meta+D toggled
   * developer options. The modifier that is neither the accelerator nor any
   * layout's is Control on a Mac and Meta everywhere else, and no binding takes
   * it — letter, character, digit or chord.
   */
  describe('the modifier that is neither the accelerator nor a layout’s', () => {
    const windows = { ...anything, platform: 'windows', developer: true } as const
    const mac = { ...anything, developer: true } as const
    const KEYS = ['k', 'l', 'd', 'b', 't', '\\', '[', ']', '=', '+', '-', '_', '0', ...PANE_SHORTCUTS.map((entry) => entry.digit)]

    it('binds nothing with Meta added off a Mac', () => {
      for (const key of [...KEYS, 'q']) {
        /* THE PREMISE: every one of these is bound under Control alone, so a
           `null` below is the modifier's doing and not a missing binding. */
        expect(resolveAccel({ key, repeat: false, ctrlKey: true }, windows), `Ctrl+${key}`).not.toBeNull()
        expect(resolveAccel({ key, repeat: false, ctrlKey: true, metaKey: true }, windows), `Ctrl+Meta+${key}`).toBeNull()
      }
      const chord = { key: 'd', code: 'KeyD', repeat: false, ctrlKey: true } as const
      expect(resolveAccel({ ...chord, altKey: true, metaKey: true }, windows), 'Ctrl+Alt+Meta+D').toBeNull()
      expect(resolveAccel({ ...chord, key: 'D', shiftKey: true, metaKey: true }, windows), 'Ctrl+Shift+Meta+D').toBeNull()
    })

    /* Round 1 refused Control for the LETTERS on a Mac and nowhere else, on the
       reasoning that a character's modifiers are the layout's. Shift and Option
       are; Control is not, on any Mac layout. */
    it('binds no character or digit with Control added on a Mac', () => {
      for (const key of KEYS) {
        expect(resolveAccel({ key, repeat: false, metaKey: true }, mac), `⌘${key}`).not.toBeNull()
        expect(resolveAccel({ key, repeat: false, metaKey: true, ctrlKey: true }, mac), `⌃⌘${key}`).toBeNull()
      }
    })

    /* ⚠️ **THE ACCELERATOR IS A MODIFIER TOO, AND A REAL EVENT CARRIES IT.** Every
       case above this block leaves ⌘ off a Mac event, because `App` checks it
       before asking. A map that counted Meta as extra on a Mac would pass all of
       them and bind nothing in the running app. */
    it('still binds every key and the developer chord with the accelerator itself down', () => {
      for (const key of KEYS) {
        expect(resolveAccel({ key, repeat: false, metaKey: true }, mac), `⌘${key}`).not.toBeNull()
      }
      const d = { key: 'd', code: 'KeyD', repeat: false } as const
      expect(resolveAccel({ ...d, metaKey: true, ctrlKey: true, altKey: true }, mac)).toEqual({ kind: 'toggleDeveloper' })
      expect(resolveAccel({ ...d, ctrlKey: true, altKey: true }, windows)).toEqual({ kind: 'toggleDeveloper' })
    })

    /* ⚠️ **ALTGR ARRIVES AS CONTROL AND ALT OFF A MAC** (2026-09-14). Chromium on
       Windows — and so WebView2 — reports AltGr as `ctrlKey` and `altKey`
       together, with `key` the character it types. Alt was left free for a
       layout, and Control is the accelerator there, so on a German layout
       AltGr+8, which types `[`, arrived as Ctrl+Alt+[ and jumped back instead of
       typing the bracket. Off a Mac, Control with Alt is a character being typed. */
    it('binds nothing off a Mac under Control and Alt together, which is AltGr typing', () => {
      for (const key of [...KEYS, 'q', '@', '{', '}', '~', '€', '|']) {
        expect(resolveAccel({ key, repeat: false, ctrlKey: true, altKey: true }, windows), `Ctrl+Alt+${key}`).toBeNull()
      }
    })

    /* The developer chord is the one binding that names Alt off a Mac, and it
       keeps it — only where the key reports the plain letter. On a layout where
       AltGr+D types a character (Hungarian: đ), `key` is that character, and the
       chord must not swallow it. */
    it('keeps the developer chord off a Mac only where the key is the plain letter', () => {
      const chord = { code: 'KeyD', repeat: false, ctrlKey: true, altKey: true } as const
      expect(resolveAccel({ ...chord, key: 'd' }, windows)).toEqual({ kind: 'toggleDeveloper' })
      expect(resolveAccel({ ...chord, key: 'đ' }, windows), 'AltGr+D typing đ took the developer chord').toBeNull()
      expect(resolveAccel({ ...chord, key: 'đ', metaKey: true }, mac), '⌘⌃⌥D on a Mac is matched on the key it is').toEqual({
        kind: 'toggleDeveloper',
      })
    })
  })

  /* ⌘\ WHERE THERE IS NO PANE is left to the platform rather than taken to do
     nothing — which is the whole of what `null` promises (2026-09-13 audit). */
  it('leaves ⌘\\ unbound on a contributed screen, which has no pane', () => {
    expect(resolveAccel({ key: '\\', repeat: false }, anything)).toEqual({ kind: 'togglePane' })
    expect(resolveAccel({ key: '\\', repeat: false }, { ...anything, screen: 'circle:circle' })).toBeNull()
  })

  /* A DIGIT FOR A PANEL THIS SCREEN DOES NOT HAVE does nothing, rather than
     opening whatever `openPane` would fall back to. */
  it('leaves a digit unbound on a screen with no such panel', () => {
    const missing = PANE_SHORTCUTS.find(({ pane }) => !paneFits('library', pane))
    expect(missing, 'no panel is reader-only any more — this check needs rewriting').toBeDefined()
    expect(
      resolveAccel({ key: missing!.digit, repeat: false }, { ...anything, screen: 'library' }),
    ).toBeNull()
  })

  /* THE GUARDS, each on its own: a combo swallowed in order to do nothing is
     worse than one left unbound, because the platform's meaning goes with it. */
  it('declines a combo whose condition is not met, instead of eating the key', () => {
    expect(resolveAccel({ key: 'd', repeat: false }, { ...anything, hasSelection: false })).toBeNull()
    expect(resolveAccel({ key: 'b', repeat: false }, { ...anything, canBookmark: false })).toBeNull()
    /* Not from the shelf, even with a place to keep: the reader is mounted
       underneath with a live position, and nothing on screen would show it. */
    expect(resolveAccel({ key: 'b', repeat: false }, { ...anything, onReader: false })).toBeNull()
    expect(resolveAccel({ key: 't', repeat: false }, { ...anything, hasBook: false })).toBeNull()
    /* ⌘[ and ⌘] with nothing that way are LEFT TO THE PLATFORM, not swallowed.
       The palette drops both rows on the same condition, so a reader never
       sees a row whose printed key does nothing. */
    expect(resolveAccel({ key: '[', repeat: false }, { ...anything, canJumpBack: false })).toBeNull()
    expect(resolveAccel({ key: ']', repeat: false }, { ...anything, canJumpForward: false })).toBeNull()
  })

  /* HOLDING A TOGGLE IS ONE PRESS. Held ⌘B wrote a row and a tombstone to the
     book's marks file on every repeat, and its final state depended on where
     the reader let go. The size steps are deliberately exempt — holding ⌘+ to
     walk up the ramp is a real gesture with a real result at each repeat. */
  it('ignores an auto-repeat on the toggles and honours it on the size steps', () => {
    /* TAKEN AND NOT ACTED ON — `held`, not `null`, which would hand every
       repeat after the first press to the platform (2026-09-13 audit). A digit
       for a panel this reader is not offered is unbound whether it repeats or
       not, and stays the platform's. */
    for (const key of ['k', '\\', 't', 'b', ...PANE_SHORTCUTS.map((e) => e.digit)]) {
      const once = resolveAccel({ key, repeat: false }, anything)
      expect(resolveAccel({ key, repeat: true }, { ...anything, pressTaken: once !== null }), `held ⌘${key}`).toEqual(once === null ? null : { kind: 'held' })
    }
    for (const key of ['k', '\\', 't', 'b']) {
      expect(resolveAccel({ key, repeat: true }, { ...anything, pressTaken: true }), `held ⌘${key}`).toEqual({ kind: 'held' })
    }
    expect(resolveAccel({ key: '=', repeat: true }, { ...anything, pressTaken: true })).toEqual({ kind: 'stepBy', delta: 1 })
    expect(resolveAccel({ key: '-', repeat: true }, { ...anything, pressTaken: true })).toEqual({ kind: 'stepBy', delta: -1 })
  })

  /* ⚠️ **WHETHER A REPEAT IS TAKEN IS THE PRESS'S ANSWER, NOT THE MOMENT'S**
     (2026-09-13 audit, #86, round 3). `held` fixed the first repeat and nothing
     after it: ⌘D marks the selection and marking CLEARS it, so from the next
     repeat on the binding resolved to `null` and the rest of the hold went to
     the platform. ⌘[ on the press that empties the stack is the same defect on
     a walk. A key belongs to whoever took its first press until it comes up. */
  it('keeps taking a held press’s repeats after its own action removed what it was bound under', () => {
    expect(resolveAccel({ key: 'd', repeat: true }, { ...anything, hasSelection: false, pressTaken: true })).toEqual({ kind: 'held' })
    expect(resolveAccel({ key: '[', repeat: true }, { ...anything, canJumpBack: false, pressTaken: true })).toEqual({ kind: 'held' })
    expect(resolveAccel({ key: ']', repeat: true }, { ...anything, canJumpForward: false, pressTaken: true })).toEqual({ kind: 'held' })
  })

  /* And the other owner keeps it too: a press the platform had is the
     platform's for as long as it is held, whatever became bindable meanwhile. */
  it('leaves a repeat to the platform when the platform had the press', () => {
    expect(resolveAccel({ key: 'd', repeat: true }, { ...anything, pressTaken: false })).toBeNull()
    expect(resolveAccel({ key: '=', repeat: true }, { ...anything, pressTaken: false })).toBeNull()
    expect(resolveAccel({ key: '[', repeat: true }, { ...anything, pressTaken: false })).toBeNull()
    /* Absent is false, as every optional field in the context reads. */
    expect(resolveAccel({ key: 'k', repeat: true }, anything)).toBeNull()
  })

  it('resolves ⌘[ and ⌘] when the stack has somewhere to go, and repeats them', () => {
    expect(resolveAccel({ key: '[', repeat: false }, anything)).toEqual({ kind: 'jumpBack' })
    expect(resolveAccel({ key: ']', repeat: false }, anything)).toEqual({ kind: 'jumpForward' })
    /* NOT REFUSED ON REPEAT, unlike every toggle. Holding ⌘[ to walk back
       several jumps is a real gesture with a real result at each press, and
       the stack bottoms out on its own — `goBack` returns null on an empty
       one. Refusing the repeat would make the reader press it n times. */
    expect(resolveAccel({ key: '[', repeat: true }, { ...anything, pressTaken: true })).toEqual({ kind: 'jumpBack' })
    expect(resolveAccel({ key: ']', repeat: true }, { ...anything, pressTaken: true })).toEqual({ kind: 'jumpForward' })
  })

  it('advertises every reading-size key it binds, so none is a secret', () => {
    // The other direction. A bound key with no command is a keystroke that
    // works and that nothing tells the reader about.
    const sized = buildCommands(context({ stepIdx: 3 }).ctx).map((c) => c.combo)
    expect(sized).toContain('⌘+')
    expect(sized).toContain('⌘−')
    expect(sized).toContain('⌘0')
  })

  /* WHAT EACH SIZE KEY DOES, not only that it does something: the check above
     asks for an answer that is not null, and ⌘0 answering `{}` passed it. */
  it('resolves each reading-size key to the step it names', () => {
    expect(resolveAccel({ key: '=', repeat: false }, anything)).toEqual({ kind: 'stepBy', delta: 1 })
    expect(resolveAccel({ key: '+', repeat: false, shiftKey: true }, anything)).toEqual({ kind: 'stepBy', delta: 1 })
    expect(resolveAccel({ key: '-', repeat: false }, anything)).toEqual({ kind: 'stepBy', delta: -1 })
    expect(resolveAccel({ key: '_', repeat: false, shiftKey: true }, anything)).toEqual({ kind: 'stepBy', delta: -1 })
    expect(resolveAccel({ key: '0', repeat: false }, anything)).toEqual({ kind: 'resetStep' })
  })
})

describe('PANE_SHORTCUTS', () => {
  it('binds §11\'s ⌘1…4 to contents, marginalia, search and cards', () => {
    /* FOUR, AND THE NAME SAYS FOUR — THE SECOND TIME THIS NAME OUTLIVED A PANEL.
     *
     * It said six once, naming a Bookmarks panel left behind when bookmarks
     * moved into Marginalia: a test whose report described a panel the app does
     * not have, printed on every green run. That was fixed, and the comment
     * saying so is the paragraph you are reading.
     *
     * Then the Reading pane went (WI-12.5) and the name said five, naming
     * `stats` — the same defect, in the same sentence, surviving the fix for
     * itself. `test:ledger` records a title without reading it, and an
     * assertion about the rows cannot see the words above it, so nothing was
     * capable of catching either round.
     *
     * The test below now READS ITS OWN TITLE and holds it to the rows. That is
     * the only thing here that could have caught this, and the second instance
     * is what makes it worth writing rather than a third comment promising to
     * be careful.
     *
     * THE DIGITS ARE NOT THE RAIL'S ORDER. They are the order the panels were
     * published in, and a digit belongs to a panel rather than to a position —
     * renumbering to match the rail would move ⌘3 off Search for every reader
     * who has it in their fingers. ⌘2 stayed with Marginalia through its rename
     * from Notes for the same reason. */
    expect(PANE_SHORTCUTS.map((s) => [s.digit, s.pane])).toEqual([
      ['1', 'toc'],
      ['2', 'marginalia'],
      ['3', 'search'],
      ['4', 'cards'],
    ])

    /* THE TITLE, HELD TO THE ROWS.
     *
     * Twice now this name has described a panel the app does not have, and both
     * times every check below it passed. A name is what a reader of a green run
     * sees; nothing else in the suite is read as often or checked as little.
     *
     * The range and the list both come from `PANE_SHORTCUTS`, so a panel added
     * or removed fails HERE, in the test that names it, rather than in whatever
     * reads the report months later. */
    const title = expect.getState().currentTestName ?? ''
    const labelOf = (id: string) => PANES.find((pane) => pane.id === id)?.label.toLowerCase() ?? id
    expect(title, 'the title must state the range the rows actually cover').toContain(
      `⌘1…${PANE_SHORTCUTS.length}`,
    )
    const listed = (title.split(' to ')[1] ?? '').split(/,\s*|\s+and\s+/).filter(Boolean)
    expect(listed, 'the title must name each bound panel, and no other').toEqual(
      PANE_SHORTCUTS.map((one) => labelOf(one.pane)),
    )
  })

  it('binds every digit to a panel that actually renders', () => {
    /* The invariant, and the reason ⌘4 was unbound until Cards existed: a
     * shortcut pointing at a panel nothing renders is a keystroke that gets
     * swallowed to do nothing, which is indistinguishable from a broken key.
     *
     * Checked against the RENDERER, not against `buildCommands`. Both derive
     * from the same PANES table, so asking one about the other could only ever
     * agree with itself — the missing SidePane branch this is meant to catch
     * would have passed. Reading the source is the same technique the reader's
     * layout guard uses, for the same reason: the two things that must agree
     * live in different files, and nothing else makes them fail together. */
    const pane = readFileSync(
      fileURLToPath(new URL('./pane/SidePane.tsx', import.meta.url)),
      'utf8',
    )
    for (const shortcut of PANE_SHORTCUTS) {
      expect(pane).toContain(`pane === '${shortcut.pane}'`)
    }
  })
})

describe('score', () => {
  const command: Command = {
    id: 'x',
    label: 'Open Marginalia',
    group: 'Panels',
    keywords: 'pane panel sidebar',
    run: () => {},
  }

  it('ranks a label prefix above a match inside the label', () => {
    expect(score(command, 'open')).toBeLessThan(score({ ...command, label: 'Reopen Marginalia' }, 'open') ?? Infinity)
  })

  it('ranks a label match above a keyword match', () => {
    const byLabel = score(command, 'marginalia')
    const byKeyword = score(command, 'sidebar')
    expect(byLabel).not.toBeNull()
    expect(byKeyword).not.toBeNull()
    expect(byLabel!).toBeLessThan(byKeyword!)
  })

  it('misses cleanly, so the row can be dropped rather than shown at rank zero', () => {
    expect(score(command, 'zzz')).toBeNull()
  })

  it('matches everything on an empty query', () => {
    expect(score(command, '   ')).toBe(0)
  })

  /* ⚠️ **A LABEL MATCH STAYS AHEAD OF A KEYWORD MATCH, however far in**
     (2026-09-13 audit). `1 + at / 100` put a match five thousand characters
     into a capability's label at 51, behind the keywords' 50. */
  it('ranks a label match above a keyword match however far into the label it is', () => {
    const long = { ...command, label: `${'x'.repeat(5000)} whale` }
    expect(score(long, 'whale')!).toBeLessThan(score(command, 'sidebar')!)
  })

  /* ⚠️ **EVERY WORD, IN EITHER FIELD, ONCE THE PHRASE HAS HAD ITS CHANCE**
     (2026-09-13 audit). "import folder" found nothing while "add folder" found
     the row, because only a contiguous phrase inside one field matched. */
  it('matches every word of a query across the label and the keywords, below a phrase', () => {
    const folder: Command = { id: 'f', label: 'Import a folder…', group: 'Book', keywords: 'add folder bulk', run: () => {} }
    const words = score(folder, 'import folder')
    expect(words).not.toBeNull()
    expect(words!).toBeGreaterThan(score(folder, 'add folder')!)
    expect(words!).toBeLessThan(score(folder, 'book')!)
    /* In any order — and a word in neither field is still a miss. */
    expect(score(folder, 'bulk import')).toBe(words)
    expect(score(folder, 'import whale')).toBeNull()
  })

  /* WORDS, NOT LETTERS: a query whose letters are all somewhere is a miss. */
  it('does not match a word by its letters', () => {
    expect(score(command, 'ream')).toBeNull()
  })

  it('reads a command that has no keywords', () => {
    const bare: Command = { id: 'b', label: 'Open Marginalia', group: 'Panels', run: () => {} }
    expect(score(bare, 'sidebar')).toBeNull()
    expect(score(bare, 'open marginalia')).toBe(0)
  })

  /* THE RANKS THEMSELVES, not only their order against one other row: every
     case above compared two scores, so a prefix scored as a match inside the
     label, or a nearer match inside it ranking BEHIND a farther one, passed. */
  it('gives each kind of match its own rank, nearer ranking higher inside the label', () => {
    const bare: Command = { id: 'b', label: 'Open Marginalia', group: 'Panels', run: () => {} }
    expect(score(command, 'open')).toBe(0)
    /* A label that ENDS with the query is not a prefix. */
    expect(score(command, 'marginalia')).toBeCloseTo(1.05, 9)
    expect(score({ ...command, label: 'Reopen Marginalia' }, 'open')).toBeCloseTo(1.02, 9)
    expect(score(command, 'sidebar')).toBe(50)
    expect(score(command, 'open sidebar')).toBe(55)
    /* The group answers only to its own beginning. */
    expect(score(bare, 'pan')).toBe(60)
    expect(score(bare, 'els')).toBeNull()
  })

  /* NO KEYWORDS IS NO WORDS: a missing field must add nothing to what finds
     the row. Asked letter by letter, so no stand-in string can hide. */
  it('finds a command with no keywords by nothing but its label and group', () => {
    const bare: Command = { id: 'b', label: 'Open Marginalia', group: 'Panels', run: () => {} }
    const shown = `${bare.label} ${bare.group}`.toLowerCase()
    const absent = [...'abcdefghijklmnopqrstuvwxyz!'].filter((letter) => !shown.includes(letter))
    expect(absent.length).toBeGreaterThan(0)
    for (const letter of absent) {
      expect(score(bare, letter), letter).toBeNull()
    }
  })
})

/* The folder import is no longer in the library's toolbar — it is offered in
 * the empty state, which disappears the moment there is one book, and here.
 * From then on the palette is the ONLY permanent way to reach it, so these pin
 * the two things that would make it unreachable without failing anything else:
 * the command going missing, and it going missing under the name a reader who
 * learned the old button would type. */
describe('importing a folder', () => {
  it('is offered whether or not a book is open, because seeding a shelf is not a reading action', () => {
    for (const hasBook of [true, false]) {
      const { ctx } = context()
      const commands = buildCommands({ ...ctx, hasBook })
      expect(find(commands, 'book:import-folder')?.label).toBe('Import a folder…')
    }
  })

  it('runs the import rather than the book picker — the two were one keystroke apart', () => {
    const { ctx } = context()
    let imported = 0
    let picked = 0
    const commands = buildCommands({
      ...ctx,
      importFolder: () => (imported += 1),
      openBookPicker: () => (picked += 1),
    })
    find(commands, 'book:import-folder')!.run()
    expect(imported).toBe(1)
    expect(picked).toBe(0)
  })

  /* The guard that used to live on the toolbar button's `disabled` and did not
   * travel with the control when it moved into the palette. Without it, ⌘K
   * during an import starts a second one. */
  it('is not offered while an import is already running', () => {
    const { ctx } = context()
    const running = buildCommands({ ...ctx, importing: true })
    expect(find(running, 'book:import-folder')).toBeUndefined()
    // …and comes back afterwards, rather than being lost for the session.
    const idle = buildCommands({ ...ctx, importing: false })
    expect(find(idle, 'book:import-folder')).toBeDefined()
  })

  it('is findable by the name it used to have in the toolbar', () => {
    const commands = buildCommands(context().ctx)
    // "Add folder" is gone from the label; a reader who learned it there still
    // types it, so it has to survive as a keyword or the control is lost to
    // everyone who already knew it.
    const ranked = filterCommands(commands, 'add folder')
    expect(ranked.some((one) => one.id === 'book:import-folder')).toBe(true)
  })
})

describe('filterCommands', () => {
  it('puts the best match first', () => {
    const commands = buildCommands(context({ pane: null }).ctx)
    const ranked = filterCommands(commands, 'marginalia')
    expect(ranked[0]?.label).toBe('Open Marginalia')
  })

  it('drops misses entirely', () => {
    const commands = buildCommands(context().ctx)
    expect(filterCommands(commands, 'qqqq')).toEqual([])
  })

  /* BY RANK, NOT BY WHERE A ROW SAT. The case above finds its best match first
     in a list that already had it first, so a filter that never sorted passed. */
  it('orders every match by its rank, whatever order the rows came in', () => {
    const row = (id: string, label: string, group: string, keywords?: string): Command => ({
      id,
      label,
      group,
      ...(keywords === undefined ? {} : { keywords }),
      run: () => {},
    })
    const commands = [
      row('group', 'Songs', 'Whales'),
      row('keyword', 'Sea life', 'Book', 'whale dolphin'),
      row('inside', 'A whale of a time', 'Book'),
      row('miss', 'Ships', 'Book'),
      row('prefix', 'Whale song', 'Book'),
    ]
    expect(filterCommands(commands, 'whale').map((command) => command.id)).toEqual(['prefix', 'inside', 'keyword', 'group'])
  })
})

describe('the tag archive commands', () => {
  /** The shared context with the archive hooks swapped in. */
  const withArchive = (over: { exportTags?: (() => void) | null; importTags?: (() => void) | null }) => ({
    ...context().ctx,
    ...over,
  })

  /* Offered only where there is a filesystem to write to — `canArchiveTags` is
     false in a plain browser tab, and a row that opens a dialog which cannot
     exist is the app describing a feature it does not have. */
  it('offers export and import when the archive is available', () => {
    const ids = buildCommands(withArchive({ exportTags: () => {}, importTags: () => {} })).map((c) => c.id)
    expect(ids).toContain('tags:export')
    expect(ids).toContain('tags:import')
  })

  it('offers neither when it is not', () => {
    const ids = buildCommands(withArchive({ exportTags: null, importTags: null })).map((c) => c.id)
    expect(ids).not.toContain('tags:export')
    expect(ids).not.toContain('tags:import')
  })

  it('says merge in the import label, because that is what it does', () => {
    /* The word is the reassurance: an import never removes a tag, so restoring
       an old file cannot silently undo a month of filing. */
    const row = buildCommands(withArchive({ importTags: () => {} })).find((c) => c.id === 'tags:import')
    /* THE LABEL, which this title always named and which this case never read:
       it asserted the keywords, and the label had no "merge" in it from the
       day the row was written (2026-09-13 audit). */
    expect(row?.label).toBe('Import tags from a file… (merge)')
    expect(row?.keywords).toContain('merge')
  })
})

/**
 * Contributed commands — WI-5.6. The composition's commands come after the
 * kernel's, built from a context derived from the same state, so what they say
 * is true at the same moment.
 */
describe('contributed commands', () => {
  it('are appended after the kernel\'s, with a context derived from the same state', () => {
    const seen: unknown[] = []
    const { ctx, dispatched } = context({ screen: 'library', pane: 'marginalia' })
    const commands = buildCommands({
      ...ctx,
      contributed: (capability) => {
        seen.push(capability)
        return [{ id: 'example:hello', label: 'Say hello', group: 'Example', run: () => capability.openPane('example:pane') }]
      },
    })
    expect(commands.at(-1)?.id).toBe('example:hello')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ screen: 'library', pane: 'marginalia', hasBook: true })
    commands.at(-1)?.run()
    expect(dispatched).toEqual([{ type: 'openPane', pane: 'example:pane' }])
  })

  it('are absent when nothing is contributed', () => {
    const { ctx } = context()
    expect(buildCommands(ctx).some((c) => c.id.startsWith('example:'))).toBe(false)
  })
})

/**
 * A capability's PANELS, as rows (2026-09-13 audit). Circle and Publish
 * contribute panes and no commands, and the panel rows came from `PANES`
 * alone, so neither could be opened by name.
 */
describe('contributed panels', () => {
  const circle = { id: 'circle:book', label: 'Circle', screens: ['reader'] } as const

  it('get an “Open …” row where the rail draws them, which opens them', () => {
    const { ctx, dispatched } = context({ screen: 'reader', pane: null })
    const row = find(buildCommands({ ...ctx, contributedPanes: [circle] }), 'pane:circle:book')
    expect(row?.label).toBe('Open Circle')
    expect(row?.group).toBe('Panels')
    row?.run()
    expect(dispatched).toEqual([{ type: 'openPane', pane: 'circle:book' }])
  })

  it('offer to close the one that is open', () => {
    const { ctx, dispatched } = context({ screen: 'reader', pane: 'circle:book' })
    const row = find(buildCommands({ ...ctx, contributedPanes: [circle] }), 'pane:circle:book')
    expect(row?.label).toBe('Close Circle')
    expect(row?.on).toBe(true)
    row?.run()
    expect(dispatched).toEqual([{ type: 'closePane' }])
  })

  it('get no row on a screen the contribution did not name', () => {
    const { ctx } = context({ screen: 'library' })
    expect(find(buildCommands({ ...ctx, contributedPanes: [circle] }), 'pane:circle:book')).toBeUndefined()
  })
})

/* ⚠️ **NO PANE ROWS WHERE THERE IS NO PANE** (2026-09-13 audit). A contributed
   screen keeps `pane` set for the trip back and draws none, and the palette
   offered to close it and to move it to the other side. */
describe('the pane rows on a contributed screen', () => {
  it('offer neither the toggle nor the side there, and both on the shelf', () => {
    const away = buildCommands(context({ screen: 'circle:circle', pane: 'library' }).ctx)
    expect(find(away, 'pane:toggle')).toBeUndefined()
    expect(find(away, 'pane:side')).toBeUndefined()
    const shelf = buildCommands(context({ screen: 'library', pane: 'library' }).ctx)
    expect(find(shelf, 'pane:toggle')).toBeDefined()
    expect(find(shelf, 'pane:side')).toBeDefined()
  })
})

describe('the way into the removed books', () => {
  /* ⌘K IS THE ONLY DOOR, so if this command is missing the sheet may as well
     not exist. `trash.list` and `book.restore` were services for two phases
     with no surface reaching either, while the remove confirmation promised
     recovery "for two weeks" on screen — the gap this closes. */
  it('is offered on the shelf', () => {
    const { ctx, dispatched } = context({ screen: 'library' })
    const command = find(buildCommands(ctx), 'library:trash')
    expect(command?.label).toBe('Removed books…')
    command?.run()
    expect(dispatched).toEqual([{ type: 'toggleLayer', layer: 'trashOpen' }])
  })

  it('is not offered in the reader, where there is no shelf to restore to', () => {
    expect(find(buildCommands(context({ screen: 'reader' }).ctx), 'library:trash')).toBeUndefined()
  })

  it('answers to the words a reader would actually type', () => {
    /* Nobody hunting for a book they deleted searches "trash" first. They
       search "deleted", or "restore", or "undo" — and a palette entry nobody
       can find is the same as no entry. */
    const commands = buildCommands(context({ screen: 'library' }).ctx)
    for (const word of ['deleted', 'restore', 'undo', 'recover', 'trash']) {
      expect(filterCommands(commands, word).map((c) => c.id), word).toContain('library:trash')
    }
  })
})

/**
 * ⚠️ **→ AND THE RIGHT CHEVRON MOVED OPPOSITE WAYS IN A RIGHT-TO-LEFT BOOK.**
 * The arrows were bound to `next`/`prev` — an ORDER — while the chevrons and
 * the trackpad go through `goLeft`/`goRight` — a SIDE — which the fork resolves
 * from the book's own `dir`. So in an RTL book the → key turned to the next
 * page, which is on the left, and the → chevron beside it turned to the
 * previous one. An arrow key is a side, exactly as a chevron is; PageUp,
 * PageDown and Space are an order and stay one.
 */
describe('resolvePageKey', () => {
  const press = (key: string, over: { code?: string; shiftKey?: boolean } = {}) => ({
    key,
    code: over.code ?? key,
    shiftKey: over.shiftKey ?? false,
  })

  it('sends the arrows to a side and the paging keys to an order', () => {
    expect(resolvePageKey(press('ArrowRight'))).toBe('goRight')
    expect(resolvePageKey(press('ArrowLeft'))).toBe('goLeft')
    expect(resolvePageKey(press('PageDown'))).toBe('next')
    expect(resolvePageKey(press('PageUp'))).toBe('prev')
  })

  it('reads Space by key or by code, and ⇧Space as the previous page', () => {
    expect(resolvePageKey(press(' '))).toBe('next')
    expect(resolvePageKey(press('Spacebar', { code: 'Space' }))).toBe('next')
    expect(resolvePageKey(press(' ', { shiftKey: true }))).toBe('prev')
  })

  /* ⇧arrow is a SELECTION in every text surface there is, and ⇧PageDown is
     nothing this app binds — both left to the platform, not swallowed. */
  it('leaves a shifted arrow to the selection and an unbound key to the platform', () => {
    expect(resolvePageKey(press('ArrowRight', { shiftKey: true }))).toBeNull()
    expect(resolvePageKey(press('ArrowLeft', { shiftKey: true }))).toBeNull()
    expect(resolvePageKey(press('PageDown', { shiftKey: true }))).toBeNull()
    expect(resolvePageKey(press('ArrowUp'))).toBeNull()
    expect(resolvePageKey(press('Home'))).toBeNull()
    expect(resolvePageKey(press('a'))).toBeNull()
    /* A SYSTEM-MODIFIED KEY IS NOT A READING KEY. The caller strips only the
       platform's primary accelerator, so Ctrl-, Meta- and Alt-arrows — window
       management, word movement, history — arrived looking plain and turned
       the page out from under the gesture they belong to. */
    expect(resolvePageKey({ ...press('ArrowRight'), altKey: true })).toBeNull()
    expect(resolvePageKey({ ...press('ArrowLeft'), ctrlKey: true })).toBeNull()
    expect(resolvePageKey({ ...press('PageDown'), metaKey: true })).toBeNull()
    expect(resolvePageKey({ ...press(' '), metaKey: true })).toBeNull()
  })

  /**
   * THE SIDE IS RESOLVED BY THE BOOK, and this pins where. `goRight` is `prev`
   * in an RTL book because the fork reads `book.dir` — the same fact the
   * chevrons and the wheel already rely on. Read from the shipped source, the
   * way `pageTurn.test.ts` pins the paginator: a rebase that dropped it would
   * put the arrows back to disagreeing with the chevrons, silently, and only
   * in books written right to left.
   */
  it('and the fork resolves that side from the book’s direction', () => {
    const view = readFileSync(
      fileURLToPath(import.meta.resolve('foliate-js/view.js')),
      'utf8',
    )
    expect(view).toMatch(/goRight\(\)\s*\{\s*return this\.book\.dir === 'rtl' \? this\.prev\(\) : this\.next\(\)/)
    expect(view).toMatch(/goLeft\(\)\s*\{\s*return this\.book\.dir === 'rtl' \? this\.next\(\) : this\.prev\(\)/)
  })
})

describe('the ⌘L command agrees with every other surface that offers it', () => {
  /* ⚠️ **THE ASSERTION THAT STOPS THIS CLASS COMING BACK.** The palette, the
     titlebar button and the keyboard handler each derived ⌘L's destination and
     its label independently. With two screens the three formulas were
     equivalent, so nothing noticed; with a third, the titlebar named one
     destination and performed another. Pinning the palette to `screenJump`
     means a fourth surface written from a comparison of its own fails HERE
     rather than in a reader's hands. */

  for (const screen of ['library', 'reader', 'circle:circle'] as const) {
    for (const hasBook of [true, false]) {
      it(`dispatches and names the shared jump from ${screen} (book: ${hasBook})`, () => {
        const { ctx, dispatched } = context({ screen })
        const command = find(buildCommands({ ...ctx, hasBook }), 'screen:library')
        const jump = screenJump(screen, hasBook)

        expect(command?.label).toBe(jump.label)
        command?.run()

        expect(dispatched).toEqual([{ type: 'goScreen', screen: jump.to }])
      })
    }
  }
})


describe('a contributed command that shadows a kernel one', () => {
  /**
   * ⚠️ **COMPOSITION VALIDATION CHECKS CONTRIBUTED IDS AGAINST EACH OTHER AND NEVER
   * AGAINST THE KERNEL'S.** A capability legitimately named `book` contributing
   * `book:open` produced two rows carrying one id — duplicate React keys, and
   * identity-based keyboard selection resolving to whichever came first. The reader
   * pressed the capability's row and got the kernel's action.
   */
  const shadow: Command = {
    id: 'book:open',
    group: 'Book',
    label: 'Open something else',
    run: () => {},
  }
  const mine: Command = { id: 'circle:share', group: 'Book', label: 'Share', run: () => {} }

  it('keeps the kernel command and drops the contribution', () => {
    const plain = buildCommands(context().ctx)
    const kernel = find(plain, 'book:open')
    expect(kernel).toBeDefined()

    const withShadow = buildCommands({ ...context().ctx, contributed: () => [shadow] })
    expect(withShadow.filter((c) => c.id === 'book:open')).toHaveLength(1)
    expect(find(withShadow, 'book:open')?.label).toBe(kernel?.label)
  })

  it('says which id it dropped, rather than dropping it silently', () => {
    const seen: string[] = []
    buildCommands({
      ...context().ctx,
      contributed: () => [shadow],
      onDuplicate: (id: string) => seen.push(id),
    })
    expect(seen).toEqual(['book:open'])
  })

  it('still admits a contribution whose id is its own', () => {
    /* So the guard cannot pass by refusing every contribution. */
    const commands = buildCommands({ ...context().ctx, contributed: () => [mine] })
    expect(find(commands, 'circle:share')).toBeDefined()
  })

  it('refuses a second contribution repeating the first', () => {
    const seen: string[] = []
    const commands = buildCommands({
      ...context().ctx,
      contributed: () => [mine, { ...mine, label: 'Share again' }],
      onDuplicate: (id: string) => seen.push(id),
    })
    expect(commands.filter((c) => c.id === 'circle:share')).toHaveLength(1)
    expect(seen).toEqual(['circle:share'])
  })
})
