// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Setting } from '../core/ports'
import { KERNEL_SETTINGS, createSettingsStore, type KernelSettingName } from '../core/settings'
import { preferencesOf, setReadingStyle, useAppState, type Action, type ContributedPanes } from './state'

/**
 * `useAppState` by BEHAVIOUR — a real render, a real dispatch, a real store.
 *
 * ⚠️ **NOT IN `state.persistence.test.tsx`, WHICH ASKS THE SAME KIND OF
 * QUESTION**, because that file reads `state.ts` as text and `pnpm mutants`
 * leaves a reading test out of the module's run whole. Nothing in this file may
 * read a source file, or every case below stops counting.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

function storeOverMap() {
  const map = new Map<string, string>()
  return createSettingsStore({
    storage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
    },
  })
}

describe('the hook at launch', () => {
  it('starts from what the store remembered', () => {
    const settings = storeOverMap()
    settings.set(KERNEL_SETTINGS.theme, 'night')

    const { result } = renderHook(() => useAppState(settings))

    expect(result.current[0].theme).toBe('night')
  })

  it('opens on the reader when the page was loaded naming a book', () => {
    window.history.replaceState(null, '', '/?book=%2Fsample.epub')

    const { result } = renderHook(() => useAppState(storeOverMap()))

    expect(result.current[0].screen).toBe('reader')
  })
})

describe('the hook on a change', () => {
  it('reduces the action and writes the change to the store', () => {
    const settings = storeOverMap()
    const { result } = renderHook(() => useAppState(settings))

    act(() => result.current[1]({ type: 'setTheme', theme: 'night', fromOs: true }))

    expect(result.current[0].theme).toBe('night')
    expect(settings.get(KERNEL_SETTINGS.theme), 'the store, not just the state').toBe('night')
  })

  /* The composition is static in the app, but the hook still owes the reducer
     the panes it was rendered with — not the ones it happened to mount with. */
  it('fits panels against the contributed panes of the latest render', () => {
    const settings = storeOverMap()
    const { result, rerender } = renderHook(({ contributed }) => useAppState(settings, contributed), {
      initialProps: { contributed: [] as ContributedPanes },
    })

    rerender({ contributed: [{ id: 'sync:status', screens: ['library'] }] })
    act(() => result.current[1]({ type: 'openPane', pane: 'sync:status' }))

    expect(result.current[0].pane).toBe('sync:status')
  })

  /* `SettingsStore` is a port: the shipped store never throws, another may, and
     a preference that will not persist must not take the render with it. */
  it('reports a store that throws on a write, and keeps rendering', () => {
    const settings = storeOverMap()
    const cause = new Error('the disk is full')
    vi.spyOn(settings, 'set').mockImplementation(() => {
      throw cause
    })
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { result } = renderHook(() => useAppState(settings))

    expect(report).toHaveBeenCalledWith('Paper: could not save a preference', cause)
    expect(result.current[0].screen).toBe('library')
  })
})

/**
 * ⚠️ **EVERY PREFERENCE IN `KERNEL_SETTINGS` REACHES THE STORE ON ITS OWN.**
 *
 * The write effect lists each preference by name, and a name left out is a
 * setting the reader can change and never save — twice so far. The source scan
 * in `state.persistence.test.tsx` holds that list; this holds the BEHAVIOUR, one
 * action at a time so no other field's change can carry the omitted one along.
 * The table is keyed by `KernelSettingName`, so a new setting with no row here
 * is a compile error, and the run below says the same without the compiler.
 */
describe('every preference a reader changes is saved', () => {
  const CHANGE: Readonly<Record<KernelSettingName, Action>> = {
    developer: { type: 'toggleDeveloper' },
    hiddenPanes: { type: 'setPaneHidden', pane: 'cards', hidden: true },
    theme: { type: 'setTheme', theme: 'night', fromOs: true },
    themeFollowsOs: { type: 'setThemeFollowsOs', follows: false },
    typeface: { type: 'setTypeface', typeface: 'plex' },
    textSize: { type: 'setStepIdx', idx: 3 },
    pageLayout: { type: 'setPageLayout', layout: 'paginated' },
    side: { type: 'setSide', side: 'left' },
    rulerOn: { type: 'toggleRuler' },
    scrollbarOn: { type: 'toggleScrollbar' },
    progressLineOn: { type: 'toggleProgressLine' },
    spacing: { type: 'setSpacing', key: 'letter', idx: 3 },
    align: { type: 'setAlign', align: 'ragged' },
    brightness: { type: 'setBrightness', idx: 1 },
    contrast: { type: 'setContrast', idx: 1 },
    markTint: { type: 'setMarkTint', tint: 'purple' },
    markStyle: { type: 'setMarkStyle', style: 'underline' },
    readingStyle: setReadingStyle('separation', 'both'),
    readingVoice: { type: 'setReadingVoice', lang: 'en', voice: 'com.apple.voice.premium.en-US.Ava' },
    readingRate: { type: 'setReadingRate', rate: 1.25 },
  sentenceGapMs: { type: 'setSentenceGap', ms: 300 },
  paragraphGapMs: { type: 'setParagraphGap', ms: 900 },
  }

  it('has a change for every setting in the table', () => {
    expect(Object.keys(CHANGE).sort()).toEqual(Object.keys(KERNEL_SETTINGS).sort())
  })

  it.each(Object.keys(KERNEL_SETTINGS) as KernelSettingName[])('writes %s', (name) => {
    /* Widened for the lookup, as `writeKernelPreferences` does: iterating the
       table erases the link between a setting and its value type. */
    const setting = KERNEL_SETTINGS[name] as Setting<unknown>
    const settings = storeOverMap()
    const { result } = renderHook(() => useAppState(settings))
    const before = settings.get(setting)

    act(() => result.current[1](CHANGE[name]))

    const chosen = preferencesOf(result.current[0])[name]
    expect(chosen, 'the action moved the preference at all').not.toEqual(before)
    expect(settings.get(setting)).toEqual(chosen)
  })
})
