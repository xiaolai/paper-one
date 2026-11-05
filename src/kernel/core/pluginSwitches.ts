import { notifyAll } from './notify'
import { defineSetting, type SettingsStore } from './ports'
import { stringList } from './settings'

/**
 * The reader's "Optional features" switches.
 *
 * AN OFF-LIST, so a capability added by a later version starts on rather than
 * needing a row of its own in every reader's settings. An id in it that this build
 * did not compose is left alone: a cut capability that comes back comes back as the
 * reader left it, which is why the store keeps unknown keys too.
 *
 * ⚠️ **NOT IN `KERNEL_SETTINGS`, AND IT MUST NOT JOIN IT.** That table mirrors the
 * reducer's preferences, and `writeKernelPreferences` rewrites every key in it on
 * any preference change, from the reducer's copy. A write here that the reducer
 * knew nothing of would be overwritten by the next change of theme.
 */
// Stryker disable next-line StringLiteral: an empty key makes `defineSetting` throw while this module is imported, so every covering suite fails to load and Stryker's vitest runner reports it Survived — the key itself is asserted by `pluginSwitches.test.ts`, which reads the stored list under it.
export const pluginsOff = defineSetting<readonly string[]>('kernel.pluginsOff', [], stringList)

/** What the store says is off: the set a composition root hands the registry. */
export function readSwitchedOff(store: Pick<SettingsStore, 'get'>): ReadonlySet<string> {
  return new Set(store.get(pluginsOff))
}

/**
 * The switches for one run of the app. The shape of `createP2pSwitch`, for the same
 * reason: the answer outlives the panel that asked, because Settings unmounts when
 * it closes.
 *
 * ⚠️ **A CHANGE TAKES EFFECT AT THE NEXT LAUNCH.** The app composes once and no
 * per-capability teardown exists, so `launchedOff` is what this run is actually
 * doing, and `needsReopen` is the difference. Unlike P2P, going back to the launch's
 * answer needs no reopening: nothing was closed, because nothing acts until a launch.
 */
export interface PluginSwitches {
  /** The current answer, including a change made in this run. */
  readonly isOff: (id: string) => boolean
  /** Whether what this run is doing still differs from the answer. */
  readonly needsReopen: (id: string) => boolean
  readonly set: (id: string, off: boolean) => void
  /** Told when a switch changes. */
  readonly subscribe: (listener: () => void) => () => void
}

export function createPluginSwitches(launchedOff: ReadonlySet<string>, store: SettingsStore): PluginSwitches {
  const listeners = new Set<() => void>()
  const isOff = (id: string): boolean => store.get(pluginsOff).includes(id)
  return {
    isOff,
    needsReopen: (id) => isOff(id) !== launchedOff.has(id),
    set: (id, off) => {
      if (isOff(id) === off) return
      const others = store.get(pluginsOff).filter((one) => one !== id)
      store.set(pluginsOff, off ? [...others, id] : others)
      notifyAll(listeners, 'optional feature switch')
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
