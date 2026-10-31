import { describe, expect, it, vi } from 'vitest'
import { createPluginSwitches, pluginsOff, readSwitchedOff } from './pluginSwitches'
import { KERNEL_SETTINGS, SETTINGS_STORAGE_KEY, createSettingsStore, readKernelPreferences, writeKernelPreferences } from './settings'

/** A store over a flat map, optionally holding `values` already. */
function storeOver(values: Record<string, unknown> = {}) {
  const kept = new Map([[SETTINGS_STORAGE_KEY, JSON.stringify({ version: 1, values })]])
  return createSettingsStore({
    storage: { getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => void kept.set(key, value) },
  })
}

describe('the off-list', () => {
  it('starts empty, so a capability nobody has heard of defaults to on', () => {
    expect(readSwitchedOff(storeOver())).toEqual(new Set())
  })

  it('reads what was stored, and a junk entry costs only itself', () => {
    expect(readSwitchedOff(storeOver({ 'kernel.pluginsOff': ['a', 7, 'b'] }))).toEqual(new Set(['a', 'b']))
  })

  it('treats a value of the wrong shape as nothing being off', () => {
    expect(readSwitchedOff(storeOver({ 'kernel.pluginsOff': 'a' }))).toEqual(new Set())
  })

  /* WHY IT IS NOT IN THAT TABLE: `writeKernelPreferences` rewrites every key in it
     from the reducer's copy, so a switch stored there would be undone by the next
     change of theme. This is the failure, run. */
  it('survives the preferences being rewritten, because it is not in their table', () => {
    const store = storeOver()
    createPluginSwitches(new Set(), store).set('a', true)
    expect(Object.values(KERNEL_SETTINGS).map((one) => one.key)).not.toContain(pluginsOff.key)
    writeKernelPreferences(store, readKernelPreferences(store))
    expect(store.get(pluginsOff)).toEqual(['a'])
  })
})

describe('the switches for one run', () => {
  it('answers the store, including a change made in this run', () => {
    const switches = createPluginSwitches(new Set(), storeOver())
    expect(switches.isOff('a')).toBe(false)
    switches.set('a', true)
    expect(switches.isOff('a')).toBe(true)
    switches.set('a', false)
    expect(switches.isOff('a')).toBe(false)
  })

  it('asks for a reopen only while the answer differs from what this run launched on', () => {
    const switches = createPluginSwitches(new Set(['was-off']), storeOver({ 'kernel.pluginsOff': ['was-off'] }))
    expect(switches.needsReopen('was-off')).toBe(false)
    expect(switches.needsReopen('was-on')).toBe(false)
    switches.set('was-off', false)
    switches.set('was-on', true)
    expect(switches.needsReopen('was-off')).toBe(true)
    expect(switches.needsReopen('was-on')).toBe(true)
    /* Nothing acted on the change, so going back needs no launch. */
    switches.set('was-off', true)
    switches.set('was-on', false)
    expect(switches.needsReopen('was-off')).toBe(false)
    expect(switches.needsReopen('was-on')).toBe(false)
  })

  it('leaves another id in the list alone, including one this build did not compose', () => {
    const store = storeOver({ 'kernel.pluginsOff': ['cut-from-this-build'] })
    const switches = createPluginSwitches(new Set(), store)
    switches.set('a', true)
    switches.set('a', false)
    expect(store.get(pluginsOff)).toEqual(['cut-from-this-build'])
  })

  it('does not list an id twice', () => {
    const store = storeOver()
    const switches = createPluginSwitches(new Set(), store)
    switches.set('a', true)
    switches.set('a', true)
    expect(store.get(pluginsOff)).toEqual(['a'])
  })

  it('tells a subscriber of a change and of nothing else, until it stops', () => {
    const switches = createPluginSwitches(new Set(), storeOver())
    const heard = vi.fn()
    const stop = switches.subscribe(heard)
    switches.set('a', true)
    switches.set('a', true)
    expect(heard).toHaveBeenCalledTimes(1)
    stop()
    switches.set('a', false)
    expect(heard).toHaveBeenCalledTimes(1)
  })
})
