import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_STEP_IDX, READING_STEPS, readingStep } from './metrics'
import { TYPEFACES } from './panes'
import { initialState, reducer, screenFor, type AppState } from './state'

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
    fileURLToPath(new URL('../../node_modules/foliate-js/paginator.js', import.meta.url)),
    'utf8',
  )
  const reader = readFileSync(
    fileURLToPath(new URL('../screens/Reader.tsx', import.meta.url)),
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
  const main = read('../main.tsx')
  const stacks = read('../reader/bookCss.ts')
  const settings = read('../pane/Settings.tsx')

  it('offers exactly the four families main.tsx bundles', () => {
    const imported = [...main.matchAll(/@fontsource[^'"]*\/([a-z-]+)/g)].map((m) => m[1])
    expect(new Set(imported)).toEqual(
      new Set(['instrument-sans', 'crimson-pro', 'literata', 'ibm-plex-mono']),
    )
    expect(TYPEFACES).toHaveLength(4)
  })

  it('leads every book stack with a family the app actually loads', () => {
    // The names verified against the live document's registered @font-face
    // rules: an approximation here would be the exact bug this test is for.
    const LEADS: Record<string, string> = {
      literata: "'Literata Variable'",
      crimson: "'Crimson Pro Variable'",
      instrument: "'Instrument Sans Variable'",
      plex: "'IBM Plex Mono'",
    }
    for (const { id } of TYPEFACES) {
      const lead = LEADS[id]
      expect(lead, `no expected family for ${id}`).toBeDefined()
      // `id: "'Family Name', …` — the double quote is the TS string opening,
      // the single quotes are CSS's, and the family must come FIRST in the
      // chain or the fallbacks decide what the book is set in.
      expect(stacks, `bookCss must lead ${id} with ${lead}`).toContain(`${id}: "${lead},`)
    }
  })

  it('previews every face it offers, so no row is drawn in the wrong type', () => {
    for (const { id } of TYPEFACES) expect(settings).toContain(`${id}:`)
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
