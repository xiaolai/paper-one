// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KERNEL_SETTINGS, createSettingsStore } from '../core/settings'
import { useAppState } from './state'

/**
 * That a preference the reader changes actually reaches the store.
 *
 * ⚠️ **`state.test.ts` COULD NOT ASK THIS.** It says so itself — *"there is no
 * renderer here to observe a hook, so the source is read instead"* — and a
 * source scan is exactly the instrument that cannot see a missing dependency.
 * The write effect lists every preference by name, and twice now a new one has
 * been added to `KernelPreferences` and left out of that list: fifteen reading
 * settings the first time, `developer` and `hiddenPanes` the second. Both were
 * settings a reader could change and never save, and both looked perfect in
 * every existing test.
 *
 * So: a real render, a real dispatch, and a real read back out of the store.
 */

afterEach(cleanup)

function storeOverMap() {
  const map = new Map<string, string>()
  return createSettingsStore({
    storage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
    },
  })
}

describe('developer options survive a relaunch', () => {
  it('are written when the chord turns them on', () => {
    const settings = storeOverMap()
    const { result } = renderHook(() => useAppState(settings))

    act(() => result.current[1]({ type: 'toggleDeveloper' }))

    expect(result.current[0].developer).toBe(true)
    expect(settings.get(KERNEL_SETTINGS.developer), 'the store, not just the state').toBe(true)
  })

  it('are written when a panel is hidden inside them', () => {
    const settings = storeOverMap()
    const { result } = renderHook(() => useAppState(settings))

    act(() => result.current[1]({ type: 'toggleDeveloper' }))
    act(() => result.current[1]({ type: 'setPaneHidden', pane: 'cards', hidden: true }))

    expect(settings.get(KERNEL_SETTINGS.hiddenPanes)).toEqual(['cards'])
  })

  /* THE WHOLE POINT: a second launch over the same store comes up with them. */
  it('come back on the next launch', () => {
    const settings = storeOverMap()
    const first = renderHook(() => useAppState(settings))
    act(() => first.result.current[1]({ type: 'toggleDeveloper' }))
    cleanup()

    const { result } = renderHook(() => useAppState(settings))
    expect(result.current[0].developer).toBe(true)
  })

  /* And turning them off is written too — a flag that only ever persists ON is
     a flag a reader cannot put away. */
  it('are written when they are turned back off', () => {
    const settings = storeOverMap()
    const { result } = renderHook(() => useAppState(settings))

    act(() => result.current[1]({ type: 'toggleDeveloper' }))
    act(() => result.current[1]({ type: 'toggleDeveloper' }))

    expect(settings.get(KERNEL_SETTINGS.developer)).toBe(false)
  })
})

/**
 * ⚠️ **THE STORE IS READ ONCE, AT MOUNT** (2026-09-13 audit). The initial
 * state was an ordinary argument to `useReducer`, so `readKernelPreferences` —
 * a read and a parse per preference — ran on every render and was thrown away
 * on all but the first.
 */
describe('the settings store is read once', () => {
  it('is not read again by a render that changes no preference', () => {
    const settings = storeOverMap()
    const get = vi.spyOn(settings, 'get')
    const { result } = renderHook(() => useAppState(settings))
    const atMount = get.mock.calls.length
    expect(atMount, 'the mount read the preferences at all').toBeGreaterThan(0)

    act(() => result.current[1]({ type: 'setLibraryQuery', query: 'whale' }))

    expect(result.current[0].libraryQuery, 'the render happened').toBe('whale')
    expect(get.mock.calls.length).toBe(atMount)
  })
})
