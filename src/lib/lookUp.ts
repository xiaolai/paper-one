import { invoke } from '@tauri-apps/api/core'
import { inTauri } from './appStorage'
import type { Platform } from './metrics'

/**
 * Looking a passage up in the system's own dictionary.
 *
 * macOS ONLY, and the interface says so rather than the implementation
 * discovering it: `hasDictionary` is what the reader consults before drawing
 * the control, so a platform with nothing to look words up in shows no button
 * instead of a button that fails. A disabled control would be the app naming a
 * feature it does not have — the same failure as a tooltip naming a key nothing
 * binds.
 *
 * WHY IT HANDS OFF RATHER THAN DRAWING THE DEFINITION HERE. The panel in the
 * design would need `DCSCopyTextDefinition`, and what that returns is not
 * presentable: the headword comes back doubled, the body is whatever
 * dictionaries the reader happens to have enabled, run together with no
 * structure, and a multi-word selection returns nothing at all. Parsing that
 * into a typeset panel means heuristics over text whose shape is set by the
 * reader's own dictionary choices — it would look right on this machine and
 * wrong on the next. Dictionary.app is the honest version of the same feature
 * until there is something better to render.
 */

/** Whether this platform has a dictionary to hand a passage to. */
export function hasDictionary(platform: Platform): boolean {
  return platform === 'macos' && inTauri()
}

/**
 * The longest term worth sending.
 *
 * A `dict://` lookup of a whole paragraph finds nothing, and the reader can
 * select a whole chapter — so this is not a defensive round number, it is the
 * point past which the feature cannot work anyway. A headword and a short
 * phrase both fit comfortably.
 */
const MAX_TERM = 120

/**
 * Hand a passage to the system dictionary.
 *
 * Resolves when the request has been made, NOT when anything has been shown:
 * what happens after `open` is the system's, and there is nothing to report
 * back. It rejects only when the command itself could not run, which the caller
 * turns into a notice — a lookup that silently did nothing is the failure this
 * whole path is easiest to get wrong in.
 */
export async function lookUp(term: string): Promise<void> {
  const trimmed = term.trim().replace(/\s+/g, ' ')
  if (trimmed === '' || trimmed.length > MAX_TERM) return
  await invoke('look_up', { term: trimmed })
}
