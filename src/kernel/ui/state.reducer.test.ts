import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SPACING, FIGURE_HEIGHTS, FIGURE_WIDTHS, MINIMUM_SIZES } from '../core/metrics'
import { createSettingsStore } from '../core/settings'
import {
  bootState,
  defaultPaneFor,
  hasOpenLayer,
  initialState,
  paneFits,
  readerTakesInput,
  reducer,
  screenFor,
  screenJump,
  setReadingStyle,
  useAppState,
  type AppState,
  type Layer,
} from './state'

/**
 * `state.ts` by BEHAVIOUR ONLY — and this file must never read a source file.
 *
 * ⚠️ **THE MUTATION GATE COULD NOT COUNT A SINGLE TEST OF THIS MODULE.**
 * `state.test.ts` and `state.persistence.test.tsx` both read `state.ts` as text,
 * and since 2026-09-14 `pnpm mutants` leaves every such test out of a subject's
 * run — whole files, not the reading cases alone — because instrumented text is
 * not the text they assert on. So the reducer's hundreds of behaviour
 * assertions in those two files killed nothing, and the first sweep after the
 * change left 272 mutants standing, 229 of them on lines no counted test
 * reached. The cases here are what the gate CAN count; one read of a source
 * file added here would silently take all of them out of it again.
 *
 * Every case compares the WHOLE state where it can, so a branch that returns a
 * fragment, or quietly moves a field it was not asked about, fails here too.
 */

const at = (over: Partial<AppState>): AppState => ({ ...initialState, ...over })

describe('the seed a launch starts from', () => {
  it('is the library, on its own panel, with nothing typed and no chrome or pin', () => {
    const { screen, pane, lastPane, libraryQuery, chromeOn, rulerPinned } = initialState
    expect({ screen, pane, lastPane, libraryQuery, chromeOn, rulerPinned }).toEqual({
      screen: 'library',
      pane: 'library',
      lastPane: 'library',
      libraryQuery: '',
      chromeOn: false,
      rulerPinned: false,
    })
  })

  it('sets the pane on the right, the book at its designed spacing, and yellow bands', () => {
    const { side, spacing, markTint, markStyle } = initialState
    expect({ side, spacing, markTint, markStyle }).toEqual({
      side: 'right',
      spacing: DEFAULT_SPACING,
      markTint: 'yellow',
      markStyle: 'fill',
    })
  })

  /* Its pane is OPEN, so the first ⌘\ shuts it rather than opening one. */
  it('has its pane open, so the first toggle closes it', () => {
    expect(reducer(initialState, { type: 'togglePane' })).toEqual({ ...initialState, pane: null })
  })
})

describe('changing screen, by behaviour', () => {
  it('fits the open pane to the new screen from the remembered panel, and shuts every layer', () => {
    const shelf = at({ screen: 'library', pane: 'library', lastPane: 'search', trashOpen: true })
    expect(reducer(shelf, { type: 'goScreen', screen: 'reader' })).toEqual({
      ...shelf,
      screen: 'reader',
      pane: 'search',
      trashOpen: false,
    })
  })

  it('leaves a closed pane closed on the new screen', () => {
    const shut = at({ screen: 'library', pane: null, lastPane: 'marginalia' })
    expect(reducer(shut, { type: 'goScreen', screen: 'reader' })).toEqual({ ...shut, screen: 'reader' })
  })
})

describe('the library query, by behaviour', () => {
  it('stores what was typed, and resolves a functional update against the held query', () => {
    const typed = reducer(initialState, { type: 'setLibraryQuery', query: 'tag:Sea' })
    expect(typed).toEqual({ ...initialState, libraryQuery: 'tag:Sea' })
    expect(reducer(typed, { type: 'setLibraryQuery', query: (prev) => `${prev} is:unread` }).libraryQuery).toBe(
      'tag:Sea is:unread',
    )
  })

  it('is the same state when the query has not moved, either way it was asked', () => {
    const typed = reducer(initialState, { type: 'setLibraryQuery', query: 'tag:Sea' })
    expect(reducer(typed, { type: 'setLibraryQuery', query: 'tag:Sea' })).toBe(typed)
    expect(reducer(typed, { type: 'setLibraryQuery', query: (prev) => prev })).toBe(typed)
  })
})

describe('the theme, by behaviour', () => {
  it('stops following the OS on an explicit pick', () => {
    expect(reducer(initialState, { type: 'setTheme', theme: 'night' })).toEqual({
      ...initialState,
      theme: 'night',
      themeFollowsOs: false,
    })
  })

  it('keeps following the OS when the OS pushed the change', () => {
    expect(reducer(initialState, { type: 'setTheme', theme: 'night', fromOs: true })).toEqual({
      ...initialState,
      theme: 'night',
    })
  })

  it('turns following the OS off and on as its own switch', () => {
    const off = reducer(initialState, { type: 'setThemeFollowsOs', follows: false })
    expect(off).toEqual({ ...initialState, themeFollowsOs: false })
    expect(reducer(off, { type: 'setThemeFollowsOs', follows: true })).toEqual(initialState)
  })
})

describe('the side pane, by behaviour', () => {
  it('opens the panel asked for, remembers it, and shuts the palette it was chosen from', () => {
    const reading = at({ screen: 'reader', pane: null, lastPane: 'toc', paletteOpen: true })
    expect(reducer(reading, { type: 'openPane', pane: 'marginalia' })).toEqual({
      ...reading,
      pane: 'marginalia',
      lastPane: 'marginalia',
      paletteOpen: false,
    })
  })

  it('opens what the screen has when the panel asked for does not fit it', () => {
    const shelf = at({ screen: 'library', pane: 'library', lastPane: 'library' })
    expect(reducer(shelf, { type: 'openPane', pane: 'toc' })).toEqual({ ...shelf, lastPane: 'toc' })
  })

  it('toggles shut, and back open on the remembered panel', () => {
    const shelf = at({ screen: 'library', pane: 'marginalia', lastPane: 'marginalia' })
    const shut = reducer(shelf, { type: 'togglePane' })
    expect(shut).toEqual({ ...shelf, pane: null })
    expect(reducer(shut, { type: 'togglePane' })).toEqual(shelf)
  })

  it('does not toggle on a screen a capability owns', () => {
    const away = at({ screen: 'circle:circle', pane: 'marginalia', lastPane: 'marginalia' })
    expect(reducer(away, { type: 'togglePane' })).toBe(away)
  })

  it('closes, keeping everything else', () => {
    const reading = at({ screen: 'reader', pane: 'toc', lastPane: 'toc' })
    expect(reducer(reading, { type: 'closePane' })).toEqual({ ...reading, pane: null })
  })

  it('moves to the side asked for', () => {
    expect(reducer(initialState, { type: 'setSide', side: 'left' })).toEqual({ ...initialState, side: 'left' })
  })
})

describe('developer options, by behaviour', () => {
  it('turn on keeping the open panel, reveal an unfinished one, and take it away again', () => {
    const reading = at({ screen: 'reader', pane: 'toc', lastPane: 'toc' })
    const on = reducer(reading, { type: 'toggleDeveloper' })
    expect(on).toEqual({ ...reading, developer: true })

    const opened = reducer(on, { type: 'openPane', pane: 'cards' })
    expect(opened).toEqual({ ...on, pane: 'cards', lastPane: 'cards' })

    expect(reducer(opened, { type: 'toggleDeveloper' })).toEqual({ ...reading, developer: false })
  })

  it('leave a closed pane closed either way', () => {
    const shut = at({ screen: 'reader', pane: null, lastPane: 'toc' })
    expect(reducer(shut, { type: 'toggleDeveloper' })).toEqual({ ...shut, developer: true })
  })

  it('hide a panel once, and are the same state when the list already says so', () => {
    const on = at({ screen: 'reader', pane: 'toc', lastPane: 'toc', developer: true })
    const hidden = reducer(on, { type: 'setPaneHidden', pane: 'cards', hidden: true })
    expect(hidden).toEqual({ ...on, hiddenPanes: ['cards'] })
    expect(reducer(hidden, { type: 'setPaneHidden', pane: 'cards', hidden: true })).toBe(hidden)
    expect(reducer(on, { type: 'setPaneHidden', pane: 'cards', hidden: false })).toBe(on)
  })

  /* TWO IDS, so showing one is visibly not "clear the list". `hiddenPanes` is
     `readonly string[]` rather than `PaneId[]` — a remembered id may name a
     panel this build no longer has — which is why `dev` serves here even though
     it is not itself an unfinished panel, and why the pair used to be
     `['cards', 'companion']` and typechecked long after `companion` stopped
     being a pane at all. */
  it('show one hidden panel again and leave the others hidden', () => {
    const both = at({ screen: 'reader', pane: 'toc', lastPane: 'toc', developer: true, hiddenPanes: ['cards', 'dev'] })
    expect(reducer(both, { type: 'setPaneHidden', pane: 'cards', hidden: false })).toEqual({
      ...both,
      hiddenPanes: ['dev'],
    })
  })
})

describe('the layers, by behaviour', () => {
  it('toggle one open, shutting whichever was open, and shut it again', () => {
    const palette = at({ paletteOpen: true })
    const trash = reducer(palette, { type: 'toggleLayer', layer: 'trashOpen' })
    expect(trash).toEqual({ ...initialState, trashOpen: true })
    expect(reducer(trash, { type: 'toggleLayer', layer: 'trashOpen' })).toEqual(initialState)
  })

  it('close only the layer named', () => {
    const palette = at({ paletteOpen: true })
    expect(reducer(palette, { type: 'closeLayer', layer: 'trashOpen' })).toEqual(palette)
    expect(reducer(palette, { type: 'closeLayer', layer: 'paletteOpen' })).toEqual(initialState)
  })

  it('go on Escape, and Escape over none is the same state', () => {
    expect(reducer(at({ switcherOpen: true }), { type: 'dismissTop' })).toEqual(initialState)
    expect(reducer(initialState, { type: 'dismissTop' })).toBe(initialState)
  })

  /* Each clause of "the book has the reader's input" asked alone, from a state
     where every other clause says yes. */
  it('keep the book from the reader’s input, as do another screen and a pane drawn as a sheet', () => {
    const reading = at({ screen: 'reader', pane: null })
    expect(readerTakesInput(reading, false)).toBe(true)
    expect(readerTakesInput({ ...reading, screen: 'library' }, true)).toBe(false)
    expect(readerTakesInput({ ...reading, tagsOpen: true }, true)).toBe(false)
    expect(readerTakesInput({ ...reading, pane: 'toc' }, false)).toBe(false)
    expect(readerTakesInput({ ...reading, pane: 'toc' }, true)).toBe(true)
  })

  it('are reported open when any one of them is, and not when none is', () => {
    const layers: readonly Layer[] = ['paletteOpen', 'switcherOpen', 'tagsOpen', 'trashOpen']
    for (const layer of layers) expect(hasOpenLayer(at({ [layer]: true })), layer).toBe(true)
    expect(hasOpenLayer(initialState)).toBe(false)
  })
})

describe('the chrome and the ruler, by behaviour', () => {
  it('shows the chrome when asked', () => {
    expect(reducer(initialState, { type: 'setChrome', on: true })).toEqual({ ...initialState, chromeOn: true })
  })

  it('turns the ruler on in scrolled flow, pins it, and unpins it as it turns off', () => {
    const on = reducer(initialState, { type: 'toggleRuler' })
    expect(on).toEqual({ ...initialState, rulerOn: true })
    const pinned = reducer(on, { type: 'pinRuler' })
    expect(pinned).toEqual({ ...on, rulerPinned: true })
    expect(reducer(pinned, { type: 'toggleRuler' })).toEqual(initialState)
  })

  it('refuses the ruler in paginated flow', () => {
    const paginated = at({ pageLayout: 'paginated' })
    expect(reducer(paginated, { type: 'toggleRuler' })).toBe(paginated)
  })
})

describe('the reading settings, by behaviour', () => {
  it('stores a size step, and drops one that is not a number', () => {
    expect(reducer(initialState, { type: 'setStepIdx', idx: 3 })).toEqual({ ...initialState, stepIdx: 3 })
    expect(reducer(initialState, { type: 'setStepIdx', idx: Number.NaN })).toBe(initialState)
  })

  it('moves one spacing, and is the same state when it has not moved or is not a number', () => {
    const open = reducer(initialState, { type: 'setSpacing', key: 'letter', idx: 3 })
    expect(open).toEqual({ ...initialState, spacing: { ...initialState.spacing, letter: 3 } })
    expect(reducer(open, { type: 'setSpacing', key: 'letter', idx: 3 })).toBe(open)
    expect(reducer(initialState, { type: 'setSpacing', key: 'letter', idx: Number.NaN })).toBe(initialState)
  })

  it('moves brightness and contrast each on its own, clamped', () => {
    expect(reducer(initialState, { type: 'setBrightness', idx: 1 })).toEqual({ ...initialState, brightness: 1 })
    expect(reducer(initialState, { type: 'setContrast', idx: 2 })).toEqual({ ...initialState, contrast: 2 })
    expect(reducer(initialState, { type: 'setBrightness', idx: -3 })).toEqual({ ...initialState, brightness: 0 })
    expect(reducer(initialState, { type: 'setContrast', idx: -3 })).toEqual({ ...initialState, contrast: 0 })
  })

  it('is the same state for a brightness or contrast that has not moved or is not a number', () => {
    const dim = reducer(initialState, { type: 'setBrightness', idx: 1 })
    expect(reducer(dim, { type: 'setBrightness', idx: 1 })).toBe(dim)
    const flat = reducer(initialState, { type: 'setContrast', idx: 2 })
    expect(reducer(flat, { type: 'setContrast', idx: 2 })).toBe(flat)
    expect(reducer(initialState, { type: 'setBrightness', idx: Number.NaN })).toBe(initialState)
    expect(reducer(initialState, { type: 'setContrast', idx: Number.NaN })).toBe(initialState)
  })

  it('sets the alignment, and is the same state when it has not moved', () => {
    const ragged = reducer(initialState, { type: 'setAlign', align: 'ragged' })
    expect(ragged).toEqual({ ...initialState, align: 'ragged' })
    expect(reducer(ragged, { type: 'setAlign', align: 'ragged' })).toBe(ragged)
  })

  it('sets the typeface', () => {
    expect(reducer(initialState, { type: 'setTypeface', typeface: 'plex' })).toEqual({ ...initialState, typeface: 'plex' })
  })

  it('toggles the scrollbar and the progress line, each alone', () => {
    expect(reducer(initialState, { type: 'toggleScrollbar' })).toEqual({ ...initialState, scrollbarOn: true })
    expect(reducer(initialState, { type: 'toggleProgressLine' })).toEqual({ ...initialState, progressLineOn: true })
  })

  it('takes a pinned ruler down with it into paginated flow', () => {
    const ruled = at({ rulerOn: true, rulerPinned: true })
    expect(reducer(ruled, { type: 'setPageLayout', layout: 'paginated' })).toEqual({
      ...ruled,
      pageLayout: 'paginated',
      rulerOn: false,
      rulerPinned: false,
    })
  })

  it('goes back to scrolled flow touching nothing else', () => {
    const paginated = at({ pageLayout: 'paginated' })
    expect(reducer(paginated, { type: 'setPageLayout', layout: 'scrolled' })).toEqual({ ...paginated, pageLayout: 'scrolled' })
  })

  it('sets the mark tint and the mark style, each alone', () => {
    expect(reducer(initialState, { type: 'setMarkTint', tint: 'purple' })).toEqual({ ...initialState, markTint: 'purple' })
    expect(reducer(initialState, { type: 'setMarkStyle', style: 'underline' })).toEqual({
      ...initialState,
      markStyle: 'underline',
    })
  })
})

describe('the reading style, by behaviour', () => {
  it('builds the action from a key and its value', () => {
    expect(setReadingStyle('figureWidth', 2)).toEqual({ type: 'setReadingStyle', key: 'figureWidth', value: 2 })
  })

  it('clamps each of the three scaled settings to its own scale', () => {
    expect(reducer(initialState, setReadingStyle('figureWidth', 99)).readingStyle.figureWidth).toBe(FIGURE_WIDTHS.steps.length - 1)
    expect(reducer(initialState, setReadingStyle('figureHeight', 99)).readingStyle.figureHeight).toBe(FIGURE_HEIGHTS.steps.length - 1)
    expect(reducer(initialState, setReadingStyle('minimumSize', 99)).readingStyle.minimumSize).toBe(MINIMUM_SIZES.steps.length - 1)
  })

  it('stores a closed-set setting as given, and is the same state when it has not moved', () => {
    const both = reducer(initialState, setReadingStyle('separation', 'both'))
    expect(both).toEqual({ ...initialState, readingStyle: { ...initialState.readingStyle, separation: 'both' } })
    expect(reducer(both, setReadingStyle('separation', 'both'))).toBe(both)
  })

  it('drops a scaled setting that is not a number', () => {
    expect(reducer(initialState, setReadingStyle('figureWidth', Number.NaN))).toBe(initialState)
  })
})

describe('which panel fits where, by behaviour', () => {
  const contributed = [
    { id: 'example:pane', screens: ['reader'] },
    { id: 'sync:status', screens: ['library'] },
  ] as const

  it('fits a contributed panel where ONE contribution among several says', () => {
    expect(paneFits('library', 'sync:status', { contributed })).toBe(true)
    expect(paneFits('library', 'gone:pane', { contributed })).toBe(false)
  })

  it('reads an audience that does not say as one with developer options off', () => {
    expect(paneFits('reader', 'cards')).toBe(false)
    expect(paneFits('reader', 'cards', { developer: true })).toBe(true)
  })

  it('fits no kernel panel on a screen a capability owns', () => {
    expect(paneFits('circle:circle', 'marginalia')).toBe(false)
  })

  it('keeps every book-only panel off the shelf, developer options or not', () => {
    for (const pane of ['toc', 'search'] as const) {
      expect(paneFits('library', pane, { developer: true }), pane).toBe(false)
    }
  })

  it('falls back to Contents in the reader and to Library everywhere else', () => {
    expect(defaultPaneFor('reader')).toBe('toc')
    expect(defaultPaneFor('library')).toBe('library')
    expect(defaultPaneFor('circle:circle')).toBe('library')
  })
})

describe('where a launch and ⌘L go, by behaviour', () => {
  it('opens the reader for a launch that names a book, and the library otherwise', () => {
    expect(screenFor('?book=/sample.epub')).toBe('reader')
    expect(screenFor('')).toBe('library')
  })

  it('goes out to the Library from the reader', () => {
    expect(screenJump('reader', true)).toEqual({ to: 'library', label: 'Library' })
  })

  it('names the way back to an open book, and the way to open one when there is none', () => {
    expect(screenJump('library', true)).toEqual({ to: 'reader', label: 'Back to the book' })
    expect(screenJump('library', false)).toEqual({ to: 'reader', label: 'Open a book' })
  })
})

describe('bootState, by behaviour', () => {
  it('is the seed exactly, for a launch with nothing stored and no book', () => {
    expect(bootState('')).toEqual(initialState)
  })

  it('lands a launch that names a book on the reader, on its default panel', () => {
    expect(bootState('?book=/sample.epub')).toEqual({ ...initialState, screen: 'reader', pane: 'toc', lastPane: 'toc' })
  })

  it('starts from what was remembered, with no ruler in paginated flow', () => {
    const boot = bootState('', { theme: 'night', pageLayout: 'paginated', rulerOn: true })
    expect(boot).toEqual({ ...initialState, theme: 'night', pageLayout: 'paginated', rulerOn: false })
  })

  it('keeps a remembered ruler in scrolled flow', () => {
    expect(bootState('', { rulerOn: true })).toEqual({ ...initialState, rulerOn: true })
  })
})

/**
 * THE HOOK WHERE THERE IS NO `window` — which is why it is in this file, the
 * one that runs in Node, and not beside the hook's jsdom cases.
 *
 * `useAppState` reads the launch's search only when a window exists. Rendered on
 * the server's side of React, the guard is the whole difference between a
 * library screen and a `ReferenceError` out of the initializer.
 */
describe('useAppState with no window', () => {
  it('boots onto the library rather than reaching for a location', () => {
    expect(typeof window).toBe('undefined')
    function Probe() {
      const [state] = useAppState(createSettingsStore({ storage: null }))
      return createElement('output', null, state.screen)
    }
    expect(renderToString(createElement(Probe))).toBe('<output>library</output>')
  })
})
