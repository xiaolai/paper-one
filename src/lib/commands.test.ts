import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildCommands, filterCommands, score, type Command } from './commands'
import { DEFAULT_STEP_IDX, READING_STEPS } from './metrics'
import { PANE_SHORTCUTS } from './panes'
import { initialState, type AppState } from './state'

function context(over: Partial<AppState> = {}) {
  const dispatched: unknown[] = []
  const ctx = {
    state: { ...initialState, ...over },
    dispatch: (action: unknown) => dispatched.push(action),
    hasBook: true,
    markSelection: null,
    openBookPicker: () => {},
    importFolder: () => {},
    importing: false,
    closeBook: () => {},
    openSwitcher: () => {},
  }
  return { ctx, dispatched }
}

const find = (commands: Command[], id: string) => commands.find((c) => c.id === id)

describe('buildCommands', () => {
  it('names the action, not the thing — a pane that is open offers to close', () => {
    const open = buildCommands(context({ pane: 'notes' }).ctx)
    expect(find(open, 'pane:notes')?.label).toBe('Close Notes')
    expect(find(open, 'pane:notes')?.on).toBe(true)

    const shut = buildCommands(context({ pane: null }).ctx)
    expect(find(shut, 'pane:notes')?.label).toBe('Open Notes')
    expect(find(shut, 'pane:notes')?.on).toBe(false)
  })

  it('carries §11 combos, so the palette shows what the handler binds', () => {
    // On the READER, where every panel exists — see the library case below.
    const commands = buildCommands(context({ screen: 'reader' }).ctx)
    expect(find(commands, 'pane:toc')?.combo).toBe('⌘1')
    expect(find(commands, 'pane:notes')?.combo).toBe('⌘2')
    expect(find(commands, 'pane:search')?.combo).toBe('⌘3')
    expect(find(commands, 'pane:stats')?.combo).toBe('⌘5')
    expect(find(commands, 'pane:toggle')?.combo).toBe('⌘\\')
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
    expect(find(library, 'pane:notes')).toBeDefined()
    expect(find(library, 'pane:cards')).toBeDefined()
    expect(find(library, 'pane:settings')).toBeDefined()
  })

  it('offers all of them in a book', () => {
    const reader = buildCommands(context({ screen: 'reader' }).ctx)
    for (const id of ['toc', 'search', 'companion', 'notes', 'cards']) {
      expect(find(reader, `pane:${id}`)).toBeDefined()
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

  it('offers marking only when something is selected', () => {
    const { ctx } = context()
    expect(find(buildCommands(ctx), 'book:mark')).toBeUndefined()

    const withSelection = { ...ctx, markSelection: () => {} }
    expect(find(buildCommands(withSelection), 'book:mark')?.combo).toBe('⌘D')
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
    find(buildCommands(ctx), 'pane:notes')?.run()
    expect(dispatched).toEqual([{ type: 'openPane', pane: 'notes' }])
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
  const app = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8')

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
  const KEYS_FOR_COMBO: Record<string, readonly string[]> = {
    '⌘K': ['k'],
    '⌘\\': ['\\\\'],
    '⌘D': ['d'],
    '⌘L': ['l'],
    '⌘+': ['=', '+'],
    '⌘−': ['-', '_'],
    '⌘0': ['0'],
  }

  it('binds every combo the palette prints', () => {
    const advertised = new Set(
      buildCommands({ ...context().ctx, markSelection: () => {} })
        .map((command) => command.combo)
        .filter((combo): combo is string => combo !== undefined)
        .filter((combo) => !/^⌘[1-5]$/.test(combo)),
    )
    expect(advertised.size).toBeGreaterThan(0)

    for (const combo of advertised) {
      const keys = KEYS_FOR_COMBO[combo]
      // A new combo with no entry here is the failure, not an exemption: it
      // means the palette prints a keystroke this test cannot confirm exists.
      expect(keys, `no expected key for ${combo}`).toBeDefined()
      for (const key of keys ?? []) {
        expect(app, `${combo} prints, but App binds no '${key}'`).toContain(`'${key}'`)
      }
    }
  })

  it('advertises every reading-size key it binds, so none is a secret', () => {
    // The other direction. A bound key with no command is a keystroke that
    // works and that nothing tells the reader about.
    const sized = buildCommands(context({ stepIdx: 3 }).ctx).map((c) => c.combo)
    expect(sized).toContain('⌘+')
    expect(sized).toContain('⌘−')
    expect(sized).toContain('⌘0')
  })
})

describe('PANE_SHORTCUTS', () => {
  it('binds §11\'s ⌘1…5 to contents, notes, search, cards and stats', () => {
    expect(PANE_SHORTCUTS.map((s) => [s.digit, s.pane])).toEqual([
      ['1', 'toc'],
      ['2', 'notes'],
      ['3', 'search'],
      ['4', 'cards'],
      ['5', 'stats'],
    ])
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
      fileURLToPath(new URL('../pane/SidePane.tsx', import.meta.url)),
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
    label: 'Open Notes',
    group: 'Panels',
    keywords: 'pane panel sidebar',
    run: () => {},
  }

  it('ranks a label prefix above a match inside the label', () => {
    expect(score(command, 'open')).toBeLessThan(score({ ...command, label: 'Reopen Notes' }, 'open') ?? Infinity)
  })

  it('ranks a label match above a keyword match', () => {
    const byLabel = score(command, 'notes')
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
    const ranked = filterCommands(commands, 'notes')
    expect(ranked[0]?.label).toBe('Open Notes')
  })

  it('drops misses entirely', () => {
    const commands = buildCommands(context().ctx)
    expect(filterCommands(commands, 'qqqq')).toEqual([])
  })
})
