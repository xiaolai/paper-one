// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TAG_PREFS_STORAGE_KEY, isPinned } from '../../core/tagPrefs'
import { useTagPrefs } from './useTagPrefs'

/**
 * The tag preferences say when they are not being kept (WI-20.36).
 *
 * The write effect advanced its "last written" marker BEFORE `setItem`, and
 * reported a throw to the console only — so a pin, a colour, a hidden subject
 * or a saved view showed as kept until the next launch, when it was gone, and
 * nothing on screen had ever said otherwise. Codex's case, made executable.
 */

/** A storage that can be told to refuse, with what it holds visible. */
function storage(entries: Record<string, string> = {}, refuse = false) {
  const held = new Map(Object.entries(entries))
  let refusing = refuse
  return {
    held,
    refuse: (on: boolean) => {
      refusing = on
    },
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (refusing) throw new Error('quota')
      held.set(key, value)
    },
  }
}

describe('useTagPrefs and a store that refuses', () => {
  afterEach(cleanup)
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {})

  it("Codex's case: the pin is gone at the next mount, and the refusal was published", () => {
    const warn = quiet()
    const store = storage({}, true)
    const first = renderHook(() => useTagPrefs(store))
    expect(first.result.current.persistent).toBe(true)

    act(() => first.result.current.togglePinned('Sea'))
    // Kept for the session — the pin is drawn — and SAID to be only that.
    expect(isPinned(first.result.current.prefs, 'Sea')).toBe(true)
    expect(first.result.current.persistent).toBe(false)
    expect(store.held.size).toBe(0)
    first.unmount()

    const second = renderHook(() => useTagPrefs(storage()))
    expect(isPinned(second.result.current.prefs, 'Sea')).toBe(false)
    warn.mockRestore()
  })

  /* The file store queues the write BEFORE it throws for the previous one, so
     a refusal is not necessarily forever — the next change tries again, and
     a write that lands says so. */
  it('tries again on the next change, and says so when the store takes it', () => {
    const warn = quiet()
    const store = storage({}, true)
    const hook = renderHook(() => useTagPrefs(store))
    act(() => hook.result.current.togglePinned('Sea'))
    expect(hook.result.current.persistent).toBe(false)

    store.refuse(false)
    act(() => hook.result.current.togglePinned('Sky'))
    expect(hook.result.current.persistent).toBe(true)
    // Both decisions, in the one write that landed — pins are kept by key.
    expect(store.held.get(TAG_PREFS_STORAGE_KEY)).toContain('"sea"')
    expect(store.held.get(TAG_PREFS_STORAGE_KEY)).toContain('"sky"')
    warn.mockRestore()
  })

  it('with no storage at all is not persistent from the start', () => {
    const hook = renderHook(() => useTagPrefs(null))
    expect(hook.result.current.persistent).toBe(false)
  })

  it('does not rewrite a launch that changed nothing', () => {
    const store = storage({ [TAG_PREFS_STORAGE_KEY]: JSON.stringify({ pinned: ['Sea'] }) })
    const setItem = vi.spyOn(store, 'setItem')
    renderHook(() => useTagPrefs(store))
    expect(setItem).not.toHaveBeenCalled()
  })
})
