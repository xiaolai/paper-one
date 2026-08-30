import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_STEP_IDX, READING_STEPS, readingStep } from '../core/metrics'
import { BUNDLED_FACES, faceById } from '../core/typefaces'
import { createSettingsStore, readKernelPreferences } from '../core/settings'
import { bootState, defaultPaneFor, initialState, paneFits, preferencesOf, reducer, screenFor, type AppState } from './state'
import { paneOffered } from '../core/uiTypes'

/**
 * The reducer's reading-size case.
 *
 * Written when the size control was built, because until then nothing in the
 * app dispatched `setStepIdx` at all — the clamp, the rounding and the
 * non-finite guard were reachable only from a test that did not exist. A guard
 * nothing exercises is a guard nobody knows is broken.
 */

const step = (state: AppState, idx: number): AppState =>
  reducer(state, { type: 'setStepIdx', idx })

describe('setStepIdx', () => {
  it('stores a step in range', () => {
    expect(step(initialState, 0).stepIdx).toBe(0)
    expect(step(initialState, 6).stepIdx).toBe(6)
  })

  it('clamps rather than storing an index that has no step', () => {
    expect(step(initialState, -5).stepIdx).toBe(0)
    expect(step(initialState, 99).stepIdx).toBe(READING_STEPS.length - 1)
  })

  it('rounds, so a fractional index still lands on a real step', () => {
    expect(step(initialState, 2.4).stepIdx).toBe(2)
    expect(step(initialState, 2.6).stepIdx).toBe(3)
  })

  /* NaN survives Math.min/Math.max unchanged, so without this guard it reached
   * the array lookup and every downstream reader fell back independently. */
  it('drops a non-finite index instead of storing it', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(step(initialState, bad)).toBe(initialState)
    }
  })

  /* The property that matters to everything downstream: bookCss, the renderer's
   * max-inline-size and the host prose grid all index READING_STEPS with
   * whatever this stores. Any reachable value must name a real step. */
  it('leaves stepIdx indexing a real step for every input', () => {
    for (const idx of [-99, -1, 0, 3, 6, 7, 1e9, 2.5, Number.NaN]) {
      const { stepIdx } = step(initialState, idx)
      expect(READING_STEPS[stepIdx]).toBeDefined()
      expect(readingStep(stepIdx)).toBe(READING_STEPS[stepIdx])
    }
  })

  it('changes nothing but the size', () => {
    const next = step(initialState, 5)
    expect({ ...next, stepIdx: DEFAULT_STEP_IDX }).toEqual(initialState)
  })
})

describe('setTypeface', () => {
  it('sets the face and nothing else', () => {
    const next = reducer(initialState, { type: 'setTypeface', typeface: 'plex' })
    expect(next.typeface).toBe('plex')
    expect({ ...next, typeface: initialState.typeface }).toEqual(initialState)
  })

  it('opens on §14’s face', () => {
    expect(initialState.typeface).toBe('literata')
  })
})

describe('toggleScrollbar', () => {
  it('opens hidden', () => {
    expect(initialState.scrollbarOn).toBe(false)
  })

  it('turns on and back off, touching nothing else', () => {
    const on = reducer(initialState, { type: 'toggleScrollbar' })
    expect(on.scrollbarOn).toBe(true)
    expect({ ...on, scrollbarOn: false }).toEqual(initialState)
    expect(reducer(on, { type: 'toggleScrollbar' })).toEqual(initialState)
  })
})

describe('toggleProgressLine', () => {
  it('opens hidden', () => {
    expect(initialState.progressLineOn).toBe(false)
  })

  it('turns on and back off, touching nothing else', () => {
    const on = reducer(initialState, { type: 'toggleProgressLine' })
    expect(on.progressLineOn).toBe(true)
    expect({ ...on, progressLineOn: false }).toEqual(initialState)
    expect(reducer(on, { type: 'toggleProgressLine' })).toEqual(initialState)
  })

  /* Two edge marks that answer different questions — how much of this section
   * is off screen, and how far through the book you are. Neither implies the
   * other, and a reader who wants both must be able to have both. */
  it('is independent of the scrollbar', () => {
    const both = reducer(
      reducer(initialState, { type: 'toggleScrollbar' }),
      { type: 'toggleProgressLine' },
    )
    expect(both.scrollbarOn).toBe(true)
    expect(both.progressLineOn).toBe(true)
  })
})

/**
 * The scroll port's three hooks, checked against the fork that reads them.
 *
 * They are custom property NAMES agreed between two repositories, and a
 * disagreement is silent in both directions: a stylesheet declaration naming a
 * property nobody sets falls back to its default, and a property nobody reads
 * is simply inert. Either way the app renders plausibly and the scrollbar is
 * back in the middle of the page.
 *
 * Read from the INSTALLED module, not from the checkout, because what ships is
 * whatever `package.json` pins — and the pin has been moved without the working
 * copy following it before.
 */
describe('the scroll port hooks match the fork', () => {
  const paginator = readFileSync(
    fileURLToPath(new URL('../../../node_modules/foliate-js/paginator.js', import.meta.url)),
    'utf8',
  )
  const reader = readFileSync(
    fileURLToPath(new URL('./screens/Reader.tsx', import.meta.url)),
    'utf8',
  )

  it('sets exactly the properties the installed paginator reads', () => {
    for (const hook of [
      '--paper-scroll-pad-start',
      '--paper-scroll-pad-end',
      '--paper-scrollbar-width',
    ]) {
      expect(paginator, `the fork must read ${hook}`).toContain(`var(${hook},`)
      expect(reader, `Reader must set ${hook}`).toContain(hook)
    }
  })

  /* Inert defaults are what make this a hook rather than a fork of behaviour:
   * a host that sets none of them must get upstream's rendering exactly. */
  it('leaves upstream rendering untouched when the host sets nothing', () => {
    expect(paginator).toContain('var(--paper-scroll-pad-start, 0px)')
    expect(paginator).toContain('var(--paper-scroll-pad-end, 0px)')
    expect(paginator).toContain('var(--paper-scrollbar-width, auto)')
  })

  /* The rule they live in. If a rebase moves these declarations out from under
   * the scrolled-flow selector they would apply in paginated flow too, where
   * padding on the port shifts the page rather than the scrollbar. */
  it('reads them only in scrolled flow', () => {
    const rule = paginator.slice(
      paginator.indexOf(':host([flow="scrolled"]) #container'),
    )
    const end = rule.indexOf('}')
    expect(rule.slice(0, end)).toContain('--paper-scrollbar-width')
  })
})

/**
 * The one failure mode a typeface picker has, and it is silent.
 *
 * A `font-family` naming a family with no `@font-face` rule is not an error.
 * CSS skips it and takes the next entry in the chain, so the book renders in
 * Georgia — or in whatever the platform offers — while every value in the app
 * says otherwise. That is not hypothetical here: `bookCss`'s own header records
 * the month in which every book in Paper was set in Georgia, because
 * `@font-face` does not cross an iframe boundary and nothing reported it.
 *
 * So the registry, the CSS stacks and the imports are checked against each
 * other from SOURCE. Reading the files is the only way — a test that asks the
 * registry about itself agrees with itself, and the three things that must
 * match live in three files.
 */
describe('every offered typeface is a font that exists', () => {
  const read = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
  const main = read('../../main.tsx')

  /* Crimson Pro is still BUNDLED and no longer OFFERED: the interface sets its
   * empty states and note bodies in it, so the webfont must stay, while as a
   * reading choice it duplicated Literata's role and was the face whose small
   * x-height made a size mean two different things. Bundled and offered are
   * separate lists now, and this asserts the relationship rather than an equal
   * count — every offered bundled face must be one main.tsx actually loads. */
  it('bundles a family for every face it offers as bundled', () => {
    const imported = new Set(
      [...main.matchAll(/@fontsource[^'"]*\/([a-z-]+)/g)].map((m) => m[1]),
    )
    const wanted: Record<string, string> = {
      literata: 'literata',
      instrument: 'instrument-sans',
      plex: 'ibm-plex-mono',
    }
    for (const face of BUNDLED_FACES) {
      const pkg = wanted[face.id]
      expect(pkg, `no @fontsource package known for ${face.id}`).toBeDefined()
      expect(imported.has(pkg as string), `main.tsx must import ${pkg}`).toBe(true)
    }
  })

  it('leads every BUNDLED book stack with a family the app actually loads', () => {
    /* Only the bundled ones. A system face's stack leads with a family this app
     * never loads — that is what makes it a system face — so asserting a
     * `@font-face` behind every entry would have failed the moment the reader's
     * own fonts were offered, and asserting it behind none would have stopped
     * catching the bug this test exists for: a bundled face named slightly
     * wrong falls through to Georgia with nothing on screen to say so. */
    const LEADS: Record<string, string> = {
      literata: "'Literata Variable'",
      instrument: "'Instrument Sans Variable'",
      plex: "'IBM Plex Mono'",
    }
    for (const [id, lead] of Object.entries(LEADS)) {
      const face = faceById(id)
      expect(face.id, `${id} is not in the registry`).toBe(id)
      expect(face.stack.startsWith(lead), `${id} must lead with ${lead}`).toBe(true)
    }
  })

  /* THE PREVIEW IS THE BOOK'S OWN STACK. There used to be a second table of
   * preview stacks in the settings panel, so a face could be sampled in one
   * thing and read in another with nothing comparing them. The panel reads
   * `face.stack` now, which is the same string `bookCss` sets the book in —
   * asserted here rather than trusted, because it is one edit from being a
   * copy again. */
  it('samples a face in the same stack the book is set in', () => {
    const picker = read('./pane/FacePicker.tsx')
    expect(picker).toContain('fontFamily: face.stack')
    expect(read('./pane/Settings.tsx')).not.toContain('PREVIEW_STACKS')
  })

  /* The picker corrects each sample by the same x-height scale the book gets,
   * or a list of eight faces at one nominal size is a list of eight sizes —
   * measured on this machine, 8.0px to 9.3px of x-height at a flat 17. */
  it('shows every sample at the same optical size', () => {
    const picker = read('./pane/FacePicker.tsx')
    expect(picker).toContain('opticalScale(face)')
    expect(picker).toContain('--face-scale')
  })
})

/**
 * Which screen a launch starts on.
 *
 * Paper opened onto the reader, which for anyone not mid-book is an empty
 * screen offering to be given something — and it is what you get after quitting
 * with ten books on the shelf. The library is what the app HAS.
 */
describe('screenFor', () => {
  it('opens on the library', () => {
    expect(screenFor('')).toBe('library')
    expect(screenFor('?theme=night')).toBe('library')
  })

  /* Asking for a book IS picking one, and it is the only launch that arrives
   * already knowing what it wants. `?book=` also bypasses `openBook`, which is
   * what dispatches to the reader everywhere else — so without this the book
   * would load behind a library screen nobody asked for. */
  it('opens on the reader when the launch named a book', () => {
    expect(screenFor('?book=/sample.epub')).toBe('reader')
    expect(screenFor('?theme=night&book=/sample.epub')).toBe('reader')
  })

  /* `?book=` with nothing after it names no book. Treating the empty string as
   * a request opens the reader onto the same empty screen this change exists to
   * stop showing. */
  it('ignores an empty book parameter', () => {
    expect(screenFor('?book=')).toBe('library')
  })
})

/**
 * One side pane, fitted to the screen.
 *
 * Three panels have nothing to show without an open book, and the pane opened
 * onto one of them by default — so the first thing Paper showed a reader with a
 * full shelf was a panel saying it was not available.
 */
describe('the pane follows the screen', () => {
  const at = (over: Partial<AppState>) => ({ ...initialState, ...over })

  it('knows which panels need a book', () => {
    /* `bookmarks` is here and `notes` is not, which is the one pairing worth
     * stating: bookmarks are read per book and there is no cross-book read to
     * show, so the panel could only ever say 'open a book first'. Notes
     * browses every book's marks, which is why it stays.
     *
     * ⚠️ `companion` AND `cards` NOW NEED A SECOND THING as well as a book —
     * they are unfinished, so they need a reader who asked to see them. The
     * screen rule below is asked with developer options ON, which is the only
     * state in which the screen rule is the one that decides. */
    const dev = { developer: true }
    for (const pane of ['toc', 'search', 'companion'] as const) {
      expect(paneFits('reader', pane, dev)).toBe(true)
      expect(paneFits('library', pane, dev)).toBe(false)
    }
    // Cross-book by design, and the reason the library has a pane at all.
    for (const pane of ['marginalia', 'cards', 'library', 'settings'] as const) {
      expect(paneFits('library', pane, dev)).toBe(true)
    }
  })

  /* The mirror: the collection view is about the SHELF, and in the reader the
   * shelf is hidden. Permitted everywhere it leaked onto the reader's rail and,
   * worse, followed the reader into their first book as `lastPane`. */
  it('knows which panels need the shelf', () => {
    expect(paneFits('reader', 'library')).toBe(false)
    for (const pane of ['marginalia', 'settings'] as const) {
      expect(paneFits('reader', pane)).toBe(true)
    }
    // Unfinished, so it needs developer options as well as the right screen.
    expect(paneFits('reader', 'cards', { developer: true })).toBe(true)
  })

  /**
   * ⚠️ **THE UNFINISHED PANELS ARE NOT OFFERED, AND THEY USED TO BE.**
   *
   * `companion` and `cards` draw a panel that does not answer what it promises,
   * so they are shown only to a reader who asked for them with ⌘⌃⌥D. The rule
   * is `paneOffered` and it is folded into `paneFits` — see there for why one
   * function rather than a second check every caller must remember.
   */
  describe('the unfinished panels', () => {
    it('fit nowhere until developer options are on', () => {
      for (const pane of ['companion', 'cards'] as const) {
        expect(paneFits('reader', pane)).toBe(false)
        expect(paneFits('library', pane)).toBe(false)
      }
    })

    it('fit their own screens once they are', () => {
      expect(paneFits('reader', 'companion', { developer: true })).toBe(true)
      expect(paneFits('reader', 'cards', { developer: true })).toBe(true)
      expect(paneFits('library', 'cards', { developer: true })).toBe(true)
    })

    /* THE SCREEN RULE STILL APPLIES. Developer options reveal a panel; they do
       not put a book-only panel on the shelf. */
    it('still obey the screen they belong to', () => {
      expect(paneFits('library', 'companion', { developer: true })).toBe(false)
    })

    /* Hiding one is only meaningful under developer options, and turning the
       master switch off gives the plain app back whatever was ticked. */
    it('can be hidden individually while developer options are on', () => {
      const hidden = { developer: true, hiddenPanes: ['cards'] }
      expect(paneFits('reader', 'cards', hidden)).toBe(false)
      expect(paneFits('reader', 'companion', hidden)).toBe(true)
    })

    /* The Developer panel is the mirror image: it exists only under the switch,
       and it is not itself unfinished. */
    it('are joined by the Developer panel, which needs the same switch', () => {
      expect(paneFits('reader', 'dev')).toBe(false)
      expect(paneFits('library', 'dev')).toBe(false)
      expect(paneFits('reader', 'dev', { developer: true })).toBe(true)
      expect(paneFits('library', 'dev', { developer: true })).toBe(true)
    })
  })

  /**
   * ⚠️ **TURNING DEVELOPER OPTIONS OFF MUST MOVE YOU OFF WHAT IT TOOK AWAY.**
   *
   * The panel on screen can be one of the unfinished ones, and nothing else
   * re-asks `paneFor` when the switch flips — so without this the reader is
   * left with a title over a panel the rail no longer draws and the reducer can
   * no longer reach, which is the state `paneFor` exists to make unreachable.
   */
  describe('developer options', () => {
    it('reveal the unfinished panels and take them back', () => {
      const on = reducer(at({ screen: 'reader' }), { type: 'toggleDeveloper' })
      expect(on.developer).toBe(true)
      const opened = reducer(on, { type: 'openPane', pane: 'cards' })
      expect(opened.pane).toBe('cards')

      const off = reducer(opened, { type: 'toggleDeveloper' })
      expect(off.developer).toBe(false)
      expect(off.pane).toBe('toc')
    })

    /* A CLOSED PANE STAYS CLOSED — the rule `paneFor` keeps everywhere else. */
    it('do not open a pane the reader had closed', () => {
      const closed = at({ screen: 'reader', pane: null })
      expect(reducer(closed, { type: 'toggleDeveloper' }).pane).toBeNull()
    })

    /* The remembered panel is re-resolved too, or the next ⌘\\ reopens
       something the reader is no longer offered. */
    it('do not leave an unreachable panel remembered', () => {
      const on = reducer(at({ screen: 'reader' }), { type: 'toggleDeveloper' })
      const opened = reducer(on, { type: 'openPane', pane: 'companion' })
      const off = reducer(opened, { type: 'toggleDeveloper' })
      expect(off.lastPane).toBe('toc')
    })

    it('hide and show one panel at a time', () => {
      const on = reducer(at({ screen: 'reader' }), { type: 'toggleDeveloper' })
      const hidden = reducer(on, { type: 'setPaneHidden', pane: 'cards', hidden: true })
      expect(hidden.hiddenPanes).toEqual(['cards'])
      expect(paneFits('reader', 'cards', hidden)).toBe(false)
      expect(paneFits('reader', 'companion', hidden)).toBe(true)

      const shown = reducer(hidden, { type: 'setPaneHidden', pane: 'cards', hidden: false })
      expect(shown.hiddenPanes).toEqual([])
    })

    /* Hiding the panel you are looking at moves you off it. */
    it('move off a panel they hide', () => {
      const on = reducer(at({ screen: 'reader' }), { type: 'toggleDeveloper' })
      const opened = reducer(on, { type: 'openPane', pane: 'cards' })
      const hidden = reducer(opened, { type: 'setPaneHidden', pane: 'cards', hidden: true })
      expect(hidden.pane).toBe('toc')
    })

    /* ⚠️ **A PANE REMEMBERED FOR THE OTHER SCREEN SURVIVES.** Both actions
       re-resolved `lastPane` through `paneFits`, which also asks about the
       CURRENT screen — so toggling developer options while reading replaced a
       `library` remembered for the shelf with the reader's default, erasing a
       perfectly good memory for a screen they were not on. Only OFFERED-ness
       may touch it; `goScreen` never rewrites it for the same reason. */
    it('leave a pane remembered for the other screen alone', () => {
      const reading = at({ screen: 'reader', pane: 'toc', lastPane: 'library' })
      expect(reducer(reading, { type: 'toggleDeveloper' }).lastPane).toBe('library')
      const hidden = reducer(
        { ...reading, developer: true },
        { type: 'setPaneHidden', pane: 'cards', hidden: true },
      )
      expect(hidden.lastPane).toBe('library')
    })

    /* But a remembered pane that is no longer OFFERED does go, or the next
       ⌘\\ reopens something the reader cannot be shown. */
    it('replace a remembered pane the reader is no longer offered', () => {
      const on = at({ screen: 'reader', pane: 'toc', lastPane: 'cards', developer: true })
      expect(reducer(on, { type: 'toggleDeveloper' }).lastPane).toBe('toc')
    })

    /* Ticking twice is not two entries — the list is a set. */
    it('do not record the same panel twice', () => {
      const on = reducer(at({ screen: 'reader' }), { type: 'toggleDeveloper' })
      const once = reducer(on, { type: 'setPaneHidden', pane: 'cards', hidden: true })
      const twice = reducer(once, { type: 'setPaneHidden', pane: 'cards', hidden: true })
      expect(twice.hiddenPanes).toEqual(['cards'])
    })
  })

  /**
   * ⚠️ **NO DEFAULT, FROM ANY SOURCE, MAY NAME A PANEL THE READER IS NOT SHOWN.**
   *
   * This is the assertion the two-defaults defect was missing. `defaultPaneFor`
   * here and `KERNEL_DEFAULT_PANE` in `core/registry.ts` both answer "which
   * panel when the wanted one is gone"; Companion became unfinished, one of
   * them moved, and the other did not — so `resolvePaneId` went on resolving an
   * unknown stored id to a panel the rail refuses to draw. Nothing failed,
   * because nothing asked.
   *
   * Both halves are guarded now: the constant in `composition.contract.test.ts`,
   * and every screen's answer here. Derived from `SCREENS` rather than listed,
   * so a third screen cannot arrive without one.
   */
  it('never defaults to a panel an ordinary reader is not offered', () => {
    for (const screen of ['reader', 'library'] as const) {
      const fallback = defaultPaneFor(screen)
      expect(paneOffered(fallback, false), `${screen} falls back to ${fallback}`).toBe(true)
      /* AND IT MUST FIT THE SCREEN IT IS THE DEFAULT FOR, which is the other
         half of the same requirement: a fallback that fits nowhere is how every
         path through the reducer lands on a panel that is not there. */
      expect(paneFits(screen, fallback), `${fallback} fits ${screen}`).toBe(true)
    }
  })

  /* NON-VACUITY: the check must be able to fail. An unfinished panel is exactly
     what it is guarding against, so it has to answer false for one. */
  it('would notice a default that is not offered', () => {
    expect(paneOffered('companion', false)).toBe(false)
    expect(paneOffered('cards', false)).toBe(false)
  })

  it('does not carry the Library panel into the first book opened from the shelf', () => {
    // As it is at boot: on the library, with the Library panel open and remembered.
    const onShelf = at({ screen: 'library', pane: 'library', lastPane: 'library' })
    const inBook = reducer(onShelf, { type: 'goScreen', screen: 'reader' })
    /* ⚠️ CONTENTS, AND IT USED TO BE COMPANION — `defaultPaneFor` says why. A
       default that most readers are not offered fits nowhere, and a fallback
       that fits nowhere is how the reducer lands on a panel that is not there. */
    expect(inBook.pane).toBe('toc')
  })

  it('moves off a book-only panel on the way to the library', () => {
    const next = reducer(at({ screen: 'reader', pane: 'companion' }), {
      type: 'goScreen',
      screen: 'library',
    })
    expect(next.pane).toBe('library')
  })

  it('leaves a panel that works on both alone', () => {
    /* `lastPane` too — the reducer prefers it, and with it left at the initial
     * `companion` this test only ever passed because the fallback happened to
     * be Notes. Setting it is what makes this test "leave alone" rather than
     * "fall back to the same answer by luck". */
    const next = reducer(at({ screen: 'reader', pane: 'marginalia', lastPane: 'marginalia' }), {
      type: 'goScreen',
      screen: 'library',
    })
    expect(next.pane).toBe('marginalia')
  })

  /* `lastPane` is what the toggle reopens, and leaving it alone is how going to
   * the library and back returns you to the panel you were reading with rather
   * than to whatever the library substituted. */
  /* ⚠️ **SEARCH, AND THIS USED TO USE COMPANION.** The panel has to be three
     things at once for the case to mean anything: book-only, so leaving the
     reader displaces it; OFFERED to every reader, or it is displaced for the
     wrong reason; and NOT `defaultPaneFor('reader')`, or coming back to it
     proves nothing, since the default is what a forgotten panel lands on.
     Companion stopped being the second the day it became unfinished, and Toc
     is now the third. Search is all three. */
  it('gives the book panel back when you return to the book', () => {
    const away = reducer(at({ screen: 'reader', pane: 'search', lastPane: 'search' }), {
      type: 'goScreen',
      screen: 'library',
    })
    expect(away.pane).toBe('library')
    expect(away.lastPane).toBe('search')
    const back = reducer(away, { type: 'goScreen', screen: 'reader' })
    expect(back.pane).toBe('search')
  })

  /* CLOSED STAYS CLOSED. `paneFor` answers "which panel", never "is the pane
   * open", and asking it about a null pane opened one on every screen change —
   * the same conflation as a pane that shuts itself, from the other side. */
  it('does not open a pane the reader had closed', () => {
    const shut = at({ screen: 'reader', pane: null, lastPane: 'companion' })
    expect(reducer(shut, { type: 'goScreen', screen: 'library' }).pane).toBeNull()
  })

  it('reopens a fitting panel when the toggle is used on the library', () => {
    const shut = at({ screen: 'library', pane: null, lastPane: 'companion' })
    expect(reducer(shut, { type: 'togglePane' }).pane).toBe('library')
  })

  /* A palette entry the reader chose BY NAME falls back rather than failing;
   * the ⌘-digit is guarded at the key handler instead, because a key that
   * silently does something else is worse than one that does nothing. */
  it('falls back when asked for a panel this screen does not have', () => {
    const next = reducer(at({ screen: 'library' }), { type: 'openPane', pane: 'toc' })
    expect(next.pane).toBe('library')
  })
})

/**
 * The state a launch begins in, which no reducer case can vouch for.
 *
 * `paneFor` runs on TRANSITIONS, so moving the reader off Companion on the way
 * to the library did nothing about arriving there — and Paper now opens on the
 * library. `initialState.pane` was Companion, so the first thing a reader saw
 * was the panel saying it was not available: the one moment it mattered most
 * was the one moment nothing checked. Found by looking at the running app.
 */
/* The library's query is app state so the pane can write it. Functional
 * updates are resolved by the REDUCER against the state it holds — the library
 * screen used to resolve them against its render's value, so two updates in
 * one batch read the same stale string and the second clobbered the first. */
describe('setLibraryQuery', () => {
  it('sets a plain string', () => {
    expect(reducer(initialState, { type: 'setLibraryQuery', query: 'tag:Sea' }).libraryQuery).toBe('tag:Sea')
  })
  it('resolves a functional update against the state the reducer holds', () => {
    const one = reducer(initialState, { type: 'setLibraryQuery', query: 'a' })
    const two = reducer(one, { type: 'setLibraryQuery', query: (prev) => `${prev} b` })
    const three = reducer(two, { type: 'setLibraryQuery', query: (prev) => `${prev} c` })
    expect(three.libraryQuery).toBe('a b c')
  })
  it('returns the same state object when nothing changed, so nothing re-renders', () => {
    const one = reducer(initialState, { type: 'setLibraryQuery', query: 'x' })
    expect(reducer(one, { type: 'setLibraryQuery', query: 'x' })).toBe(one)
    expect(reducer(one, { type: 'setLibraryQuery', query: (p) => p })).toBe(one)
  })
})

describe('bootState', () => {
  it('does not open the library on a panel the library does not have', () => {
    const boot = bootState('')
    expect(boot.screen).toBe('library')
    expect(paneFits(boot.screen, boot.pane!)).toBe(true)
    // The panel about the shelf, on the shelf — see `defaultPaneFor`.
    expect(boot.pane).toBe('library')
  })

  it('keeps the book panel when the launch named a book', () => {
    const boot = bootState('?book=/sample.epub')
    expect(boot.screen).toBe('reader')
    /* The READER's default panel, by name. This compared against
     * `initialState.pane`, which pinned nothing once the seed became coherent
     * with its own library screen — the reader boot takes its panel from
     * `paneFor`, and Companion is the panel §03 puts beside a book. */
    expect(boot.pane).toBe('toc')
  })

  /* `lastPane` is what the toggle reopens, so it has to agree with the panel
   * that is actually showing — or the first ⌘\ closes and reopens onto
   * something else. */
  it('starts with lastPane agreeing with the panel on screen', () => {
    const boot = bootState('')
    expect(boot.lastPane).toBe(boot.pane)
  })
})

/**
 * That `useAppState` actually USES `bootState`.
 *
 * Testing the function proves it is right, not that it is reached — this suite
 * passed with the hook still assembling its own state inline, which is exactly
 * the bug. There is no renderer here to observe a hook, so the source is read
 * instead, the same way the palette's combos are checked against the key
 * handler in `commands.test.ts`.
 */
describe('the hook starts from bootState', () => {
  it('does not assemble its own initial state', () => {
    const source = readFileSync(fileURLToPath(new URL('./state.ts', import.meta.url)), 'utf8')
    const hook = source.slice(source.indexOf('export function useAppState'))
    /* The reducer is wrapped (it closes over the contributed panes, WI-5.6),
     * so the pin is two facts rather than one spelling: the wrapper delegates
     * to `reducer`, and the initial state is `bootState(`. */
    expect(hook).toMatch(/const reduce = useCallback\(\(state: AppState, action: Action\) => reducer\(state, action, contributed\)/)
    expect(hook).toMatch(/useReducer\(\s*reduce,\s*bootState\(/)
  })

  /* And it reads the settings store into that call — the whole point of the
   * store is that a launch starts from what was remembered. */
  it('hands the remembered preferences to bootState', () => {
    const source = readFileSync(fileURLToPath(new URL('./state.ts', import.meta.url)), 'utf8')
    const hook = source.slice(source.indexOf('export function useAppState'))
    expect(hook).toMatch(/bootState\([^)]*readKernelPreferences\(settings\)/)
    expect(hook).toMatch(/writeKernelPreferences\(settings, prefs\)/)
  })
})

/**
 * The durable half of the state comes back on launch.
 *
 * `bootState` takes what the settings store remembered and starts from it —
 * that is what makes a chosen theme survive a relaunch, and a mobile build
 * survive being unloaded by its OS. Only the preferences travel; the transient
 * state (screen, layers, query) is decided fresh, as it always was.
 */
describe('bootState with remembered preferences', () => {
  it('starts from what was remembered, and from the defaults for the rest', () => {
    const boot = bootState('', { theme: 'night', themeFollowsOs: false, typeface: 'crimson-pro', textSize: 19 })
    expect(boot.theme).toBe('night')
    expect(boot.themeFollowsOs).toBe(false)
    expect(boot.typeface).toBe('crimson-pro')
    expect(boot.stepIdx).toBe(4)
    expect(boot.side).toBe(initialState.side)
    expect(boot.pageLayout).toBe(initialState.pageLayout)
    expect(boot.libraryQuery).toBe('')
    expect(boot.paletteOpen).toBe(false)
  })

  it('does not start with a ruler in paginated flow, whatever was remembered', () => {
    const boot = bootState('', { pageLayout: 'paginated', rulerOn: true })
    expect(boot.pageLayout).toBe('paginated')
    expect(boot.rulerOn).toBe(false)
    expect(bootState('', { pageLayout: 'scrolled', rulerOn: true }).rulerOn).toBe(true)
  })

  it('round-trips through preferencesOf', () => {
    const remembered = {
      /* NOT AT THEIR DEFAULTS, per this case's own rule below: `developer` is
         off by default and `hiddenPanes` is empty, so a field dropped anywhere
         along the round trip would put a reader back into the plain app on the
         next launch with no way to tell why. */
      developer: true,
      hiddenPanes: ['cards'],
      theme: 'sage' as const,
      themeFollowsOs: false,
      typeface: 'literata',
      textSize: 19,
      spacing: { letter: 2, word: 1, line: 3, paragraph: 0 },
      align: 'ragged' as const,
      brightness: 0,
      contrast: 1,
      pageLayout: 'scrolled' as const,
      side: 'left' as const,
      rulerOn: true,
      scrollbarOn: true,
      progressLineOn: true,
      markTint: 'purple' as const,
      markStyle: 'underline' as const,
      /* WI-14.4's fifteen, and NOT at their defaults — a round trip through
         values that happen to equal the seed proves only that the seed is the
         seed. Every one of these differs from `DEFAULT_READING_STYLE`, so a
         field dropped anywhere along `preferencesOf` → `bootState` fails here
         rather than silently resetting a reader's panel on the next launch,
         which is exactly what shipped before an audit noticed. */
      readingStyle: {
        separation: 'both' as const,
        flourish: 'drop-cap' as const,
        headingScale: 'paper' as const,
        blockquote: 'tint' as const,
        codeFace: 'paper' as const,
        codeWrap: 'wrap' as const,
        figureWidth: 0,
        figureFrame: 'shadow' as const,
        figureScalesWithText: true,
        figureHeight: 0,
        wideTables: 'shrink' as const,
        noteSize: 'publisher' as const,
        cjkSpacing: true,
        minimumSize: 2,
        fidelity: 'publisher' as const,
      },
    }
    expect(preferencesOf(bootState('', remembered))).toEqual(remembered)
  })

  /* THE TWO DEFAULT TABLES MUST AGREE, and nothing else checks it. A store
     with no values answers every `get` with the setting's own fallback, and
     that answer is spread over `initialState` by `bootState` — so a fallback
     that disagrees with `initialState` silently changes what a first launch
     looks like, in a table nobody reads beside the reducer's. Caught exactly
     this way during the kernel merge: `kernel.align` said ragged while
     `initialState.align` said justified. */
  it('has a settings fallback for every preference, equal to the initial state', () => {
    const empty = readKernelPreferences(createSettingsStore({ storage: null }))
    expect(empty).toEqual(preferencesOf(initialState))
  })
})

describe('a launch restores what the reader chose', () => {
  /* Paper persisted none of this: a reader who set Night at 19px got Paper at
     21px the next morning, every morning. `bootState` is where the stored
     preferences become the first render — read before React mounts, not in an
     effect, so there is no frame of the default theme to see. */
  const stored = {
    ...preferencesOf(initialState),
    theme: 'night' as const,
    textSize: 16,
    brightness: 0,
    markTint: 'purple' as const,
    markStyle: 'underline' as const,
    spacing: { letter: 2, word: 1, line: 3, paragraph: 0 },
  }

  it('boots into the stored theme, size and mark appearance', () => {
    const state = bootState('', stored)
    expect(state.theme).toBe('night')
    /* THE SIZE ROUND-TRIPS, NOT THE INDEX. 16px is index 1 of this ramp; the
       point of storing pixels is that it would still be 16px on a ramp where
       it is not. */
    expect(state.stepIdx).toBe(1)
    expect(readingStep(state.stepIdx).size).toBe(16)
    expect(state.brightness).toBe(0)
    expect(state.markTint).toBe('purple')
    expect(state.markStyle).toBe('underline')
    expect(state.spacing).toEqual(stored.spacing)
  })

  it('boots into the defaults when there is nothing stored', () => {
    // No store at all — a plain browser tab, or a disk that would not open.
    expect(bootState('').theme).toBe(initialState.theme)
  })

  it('still decides the screen and the pane itself', () => {
    /* Session facts are not persisted, and the ORDER in `bootState` is what
       guarantees it: a hand-edited file naming a screen or a panel must not put
       the reader somewhere they never left. */
    const withSession = { ...stored, screen: 'reader', pane: 'marginalia' } as never
    const state = bootState('', withSession)
    expect(state.screen).toBe('library')
    expect(state.pane).toBe(initialState.pane)
  })

  it('lets ?book= win over the stored preferences for the screen', () => {
    const state = bootState('?book=x', stored)
    expect(state.screen).toBe('reader')
    expect(state.theme).toBe('night')
  })
})

/**
 * Contributed panes — WI-5.6. The reducer's fitting rule has to know where a
 * capability's pane belongs, and has to send an id nobody composed to the
 * screen's default rather than open the pane onto nothing.
 */
describe('contributed panes', () => {
  const at = (over: Partial<AppState>) => ({ ...initialState, ...over })
  const contributed = [
    { id: 'example:pane' as const, screens: ['library', 'reader'] as const },
    { id: 'sync:status' as const, screens: ['library'] as const },
  ]

  it('fit where their contribution says, and nowhere when nobody composed them', () => {
    expect(paneFits('reader', 'example:pane', { contributed })).toBe(true)
    expect(paneFits('library', 'example:pane', { contributed })).toBe(true)
    expect(paneFits('reader', 'sync:status', { contributed })).toBe(false)
    expect(paneFits('library', 'sync:status', { contributed })).toBe(true)
    expect(paneFits('reader', 'gone:pane', { contributed })).toBe(false)
    expect(paneFits('reader', 'example:pane')).toBe(false)
  })

  it('open through the reducer like a kernel pane, and fall back when the screen has no such pane', () => {
    const opened = reducer(at({ screen: 'reader', pane: null }), { type: 'openPane', pane: 'example:pane' }, contributed)
    expect(opened.pane).toBe('example:pane')
    expect(opened.lastPane).toBe('example:pane')
    const shelfOnly = reducer(at({ screen: 'reader', pane: null }), { type: 'openPane', pane: 'sync:status' }, contributed)
    expect(shelfOnly.pane).toBe('toc')
    const nobody = reducer(at({ screen: 'library', pane: 'marginalia' }), { type: 'openPane', pane: 'gone:pane' }, contributed)
    expect(nobody.pane).toBe('library')
  })

  it('follow the screen: a shelf-only contributed pane yields to the reader default and comes back', () => {
    const onShelf = at({ screen: 'library', pane: 'sync:status', lastPane: 'sync:status' })
    const inBook = reducer(onShelf, { type: 'goScreen', screen: 'reader' }, contributed)
    expect(inBook.pane).toBe('toc')
    expect(inBook.lastPane).toBe('sync:status')
    const back = reducer(inBook, { type: 'goScreen', screen: 'library' }, contributed)
    expect(back.pane).toBe('sync:status')
  })

  it('reopen from lastPane on toggle, and not when the composition no longer has them', () => {
    const shut = at({ screen: 'reader', pane: null, lastPane: 'example:pane' })
    expect(reducer(shut, { type: 'togglePane' }, contributed).pane).toBe('example:pane')
    expect(reducer(shut, { type: 'togglePane' }).pane).toBe('toc')
  })
})

describe('the layers, and the one list that governs them', () => {
  /* `trashOpen` arrived with no reducer coverage at all: nothing asserted it
     was mutually exclusive with the others, that Escape reached it, or that
     changing screen closed it. The last is the one that would have bitten —
     `goScreen` used to name each layer by hand, so a new layer could be added
     to `LAYER_ORDER` (which decides the dismiss order) and forgotten in the
     closing, leaving a sheet about the shelf hanging over the reader. */
  const open = (state: AppState, layer: 'paletteOpen' | 'switcherOpen' | 'tagsOpen' | 'trashOpen') =>
    reducer(state, { type: 'toggleLayer', layer })

  it('opens and closes on the same action', () => {
    const shown = open(initialState, 'trashOpen')
    expect(shown.trashOpen).toBe(true)
    expect(open(shown, 'trashOpen').trashOpen).toBe(false)
  })

  it('holds at most one open at a time', () => {
    /* Two at once painted one over the other with Escape closing the wrong
       one — the reason the "modal layers" list was folded into this one. */
    const palette = open(initialState, 'paletteOpen')
    const trash = open(palette, 'trashOpen')
    expect(trash.trashOpen).toBe(true)
    expect(trash.paletteOpen).toBe(false)
  })

  it('lets Escape peel the trash sheet, in the declared order', () => {
    /* `dismissTop` walks `LAYER_ORDER`, so a layer that never appeared in it
       would be unreachable by the key every sheet in this app closes on. */
    const shown = open(initialState, 'trashOpen')
    expect(reducer(shown, { type: 'dismissTop' }).trashOpen).toBe(false)
  })

  it('closes every layer on a screen change, including ones added later', () => {
    for (const layer of ['paletteOpen', 'switcherOpen', 'tagsOpen', 'trashOpen'] as const) {
      const shown = open(initialState, layer)
      const moved = reducer(shown, { type: 'goScreen', screen: 'reader' })
      expect(moved[layer], layer).toBe(false)
    }
  })
})
