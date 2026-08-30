import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildCommands, filterCommands, score, type Command } from './commands'
import { DEFAULT_STEP_IDX, READING_STEPS } from '../core/metrics'
import { PANES, PANE_SHORTCUTS, panesFor } from './panes'
import { resolveAccel, resolvePageKey } from './accel'
import { initialState, paneFits, type AppState } from './state'

function context(over: Partial<AppState> = {}) {
  const dispatched: unknown[] = []
  const ctx = {
    state: { ...initialState, ...over },
    dispatch: (action: unknown) => dispatched.push(action),
    hasBook: true,
    markSelection: null,
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
   * developer options on cannot reach Cards or Companion by any of the three,
   * and there is no fourth route that was forgotten.
   */
  it('does not offer the unfinished panels until developer options are on', () => {
    const plain = buildCommands(context({ screen: 'reader' }).ctx)
    expect(find(plain, 'pane:cards')).toBeUndefined()
    expect(find(plain, 'pane:companion')).toBeUndefined()
    expect(find(plain, 'pane:dev')).toBeUndefined()

    const developer = buildCommands(context({ screen: 'reader', developer: true }).ctx)
    expect(find(developer, 'pane:cards')).toBeDefined()
    expect(find(developer, 'pane:companion')).toBeDefined()
    expect(find(developer, 'pane:dev')).toBeDefined()
  })

  it('drops one that developer options hid', () => {
    const commands = buildCommands(
      context({ screen: 'reader', developer: true, hiddenPanes: ['cards'] }).ctx,
    )
    expect(find(commands, 'pane:cards')).toBeUndefined()
    expect(find(commands, 'pane:companion')).toBeDefined()
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
    expect(resolveAccel({ key: 'q', repeat: true }, { ...anything, platform: 'windows' })).toBeNull()
  })

  /**
   * Repeat suppression comes from the ACTION'S KIND, not a second key list.
   * The hand-kept set this replaced had drifted: `l` was bound and unlisted,
   * so a held ⌘L flickered between reader and library, and a held ⌘D wrote a
   * mark and a tombstone per repeat — ⌘B's defect on another key. The walks
   * (⌘+, ⌘[) stay repeatable on purpose; everything else is one press.
   */
  it('suppresses a repeat for every binding that is not a walk — including the two the old list missed', () => {
    expect(resolveAccel({ key: 'l', repeat: false }, anything)).toEqual({ kind: 'toggleScreen' })
    expect(resolveAccel({ key: 'l', repeat: true }, anything)).toBeNull()
    const selecting = { ...anything, hasSelection: true }
    expect(resolveAccel({ key: 'd', repeat: false }, selecting)).toEqual({ kind: 'markSelection' })
    expect(resolveAccel({ key: 'd', repeat: true }, selecting)).toBeNull()
    /* The walks still repeat. */
    expect(resolveAccel({ key: '=', repeat: true }, anything)).toEqual({ kind: 'stepBy', delta: 1 })
    expect(
      resolveAccel({ key: '[', repeat: true }, { ...anything, canJumpBack: true }),
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
  const KEYS_FOR_COMBO: Record<string, readonly string[]> = {
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
      for (const key of keys ?? []) {
        /* THE KEY IS PUT THROUGH THE MAP, not looked for in App's source. The
           search was the whole weakness: a literal in a comment satisfied it,
           and so did one in an unreachable branch or behind the wrong
           modifier. Now the combo the palette prints has to actually produce
           an action from the key a keyboard reports. */
        expect(
          resolveAccel({ key, repeat: false }, anything),
          `${combo} prints, but '${key}' resolves to nothing`,
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

    /* Two of the three modifiers is not the chord. */
    it('needs both Control and Option', () => {
      expect(
        resolveAccel({ key: 'd', code: 'KeyD', repeat: false, ctrlKey: true }, anything),
      ).toEqual({ kind: 'markSelection' })
      expect(
        resolveAccel({ key: 'd', code: 'KeyD', repeat: false, altKey: true }, anything),
      ).toEqual({ kind: 'markSelection' })
    })

    /* A REPEAT IS THE SAME PRESS. Holding it would flicker developer options
       on and off for as long as the key is down — the rule `REPEATABLE` states,
       arriving on a new binding. */
    it('does not fire again while the key is held', () => {
      expect(
        resolveAccel({ key: 'd', code: 'KeyD', repeat: true, ctrlKey: true, altKey: true }, anything),
      ).toBeNull()
    })
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
    for (const key of ['k', '\\', 't', 'b', ...PANE_SHORTCUTS.map((e) => e.digit)]) {
      expect(resolveAccel({ key, repeat: true }, anything), `held ⌘${key}`).toBeNull()
    }
    expect(resolveAccel({ key: '=', repeat: true }, anything)).toEqual({ kind: 'stepBy', delta: 1 })
    expect(resolveAccel({ key: '-', repeat: true }, anything)).toEqual({ kind: 'stepBy', delta: -1 })
  })

  it('resolves ⌘[ and ⌘] when the stack has somewhere to go, and repeats them', () => {
    expect(resolveAccel({ key: '[', repeat: false }, anything)).toEqual({ kind: 'jumpBack' })
    expect(resolveAccel({ key: ']', repeat: false }, anything)).toEqual({ kind: 'jumpForward' })
    /* NOT REFUSED ON REPEAT, unlike every toggle. Holding ⌘[ to walk back
       several jumps is a real gesture with a real result at each press, and
       the stack bottoms out on its own — `goBack` returns null on an empty
       one. Refusing the repeat would make the reader press it n times. */
    expect(resolveAccel({ key: '[', repeat: true }, anything)).toEqual({ kind: 'jumpBack' })
    expect(resolveAccel({ key: ']', repeat: true }, anything)).toEqual({ kind: 'jumpForward' })
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
      fileURLToPath(new URL('../../../node_modules/foliate-js/view.js', import.meta.url)),
      'utf8',
    )
    expect(view).toMatch(/goRight\(\)\s*\{\s*return this\.book\.dir === 'rtl' \? this\.prev\(\) : this\.next\(\)/)
    expect(view).toMatch(/goLeft\(\)\s*\{\s*return this\.book\.dir === 'rtl' \? this\.next\(\) : this\.prev\(\)/)
  })
})
