// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
 * ⚠️ **THE CLASS, NOT THE INSTANCE.** Two settings were forgotten in this list
 * on two separate occasions, and each time the fix was to add the missing name.
 * This derives the expectation from `KERNEL_SETTINGS` instead, so the NEXT
 * setting added without a dependency fails here rather than shipping as a
 * preference that silently does not save.
 *
 * A source scan, deliberately, and the one place one is right: the defect is a
 * missing entry in a literal array, which is a fact about the source and about
 * nothing else. What makes it different from the scans it sits beside is that
 * the expected set is COMPUTED — it cannot fall behind the thing it checks.
 */
/**
 * The dependency array of the write effect, as source.
 *
 * ⚠️ **THE CLOSING BRACKET IS FOUND AFTER THE OPENING ONE, AND IT WAS NOT.**
 * The first version searched the whole hook for `])` from index zero, which
 * matched an earlier callback's — so `end` came before `start`, `slice`
 * returned the empty string, and every `includes` was false. It reported all
 * eighteen settings missing, which happened to look like a finding. The
 * non-vacuity case below is what said otherwise: a detector that finds nothing
 * and one that finds everything are the same bug wearing different faces.
 */
function writeEffectDeps(source: string): string {
  const hook = source.slice(source.indexOf('export function useAppState'))
  const start = hook.indexOf('}, [')
  const end = hook.indexOf('])', start)
  return start === -1 || end === -1 ? '' : hook.slice(start, end)
}

describe('the write effect names every preference', () => {
  it('lists a dependency for each of them', () => {
    /* From the repository root, not `import.meta.url`: this file opts into
       jsdom for the hook, and there `import.meta.url` is an http URL that
       `fileURLToPath` refuses — the trap `useGloss.test.ts` already records.
       `readFileSync` throws if the path is wrong, so a moved file fails loudly
       rather than scanning nothing. */
    const source = readFileSync(resolve('src/kernel/ui/state.ts'), 'utf8')
    const deps = writeEffectDeps(source)

    const missing = Object.keys(KERNEL_SETTINGS).filter((name) => {
      /* `textSize` is `stepIdx` in state and `spacing` is listed field by field
         — both are named in the array, which is all this asks. */
      if (name === 'spacing') return !deps.includes('prefs.spacing.')
      return !deps.includes(`prefs.${name}`)
    })

    expect(missing, 'settings a reader can change and never save').toEqual([])
  })

  /* NON-VACUITY: the scan must be able to fail. A name no setting has must not
     be found, or the check above passes over an empty comparison. */
  it('can actually tell a missing one', () => {
    /* From the repository root, not `import.meta.url`: this file opts into
       jsdom for the hook, and there `import.meta.url` is an http URL that
       `fileURLToPath` refuses — the trap `useGloss.test.ts` already records.
       `readFileSync` throws if the path is wrong, so a moved file fails loudly
       rather than scanning nothing. */
    const source = readFileSync(resolve('src/kernel/ui/state.ts'), 'utf8')
    const deps = writeEffectDeps(source)

    expect(deps).not.toContain('prefs.somethingNoSettingHas')
    expect(deps, 'the parse found the dependency array at all').toContain('prefs.theme')
  })
})
