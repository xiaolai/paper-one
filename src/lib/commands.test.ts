import { describe, expect, it } from 'vitest'
import { PANE_SHORTCUTS, buildCommands, filterCommands, score, type Command } from './commands'
import { initialState, type AppState } from './state'

function context(over: Partial<AppState> = {}) {
  const dispatched: unknown[] = []
  const ctx = {
    state: { ...initialState, ...over },
    dispatch: (action: unknown) => dispatched.push(action),
    hasBook: true,
    markSelection: null,
    openBookPicker: () => {},
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
    const commands = buildCommands(context().ctx)
    expect(find(commands, 'pane:toc')?.combo).toBe('⌘1')
    expect(find(commands, 'pane:notes')?.combo).toBe('⌘2')
    expect(find(commands, 'pane:search')?.combo).toBe('⌘3')
    expect(find(commands, 'pane:stats')?.combo).toBe('⌘5')
    expect(find(commands, 'pane:toggle')?.combo).toBe('⌘\\')
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
    // The invariant, and the reason ⌘4 was unbound until Cards existed: a
    // shortcut pointing at a panel nothing renders is a keystroke that gets
    // swallowed to do nothing, which is indistinguishable from a broken key.
    const commands = buildCommands(context().ctx)
    for (const shortcut of PANE_SHORTCUTS) {
      expect(find(commands, `pane:${shortcut.pane}`)).toBeDefined()
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
