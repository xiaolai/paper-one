import { invoke } from '@tauri-apps/api/core'
import { MAX_TERM } from './lookUp'

/**
 * Handing a word to the system's dictionary — the one part of looking up that
 * needs the platform.
 *
 * ## Why this is its own file
 *
 * `lookUp.ts` has four exports. Three — `hasDictionary`, `decideLookUp`,
 * `isLookUpTerm` — are pure and carry thirteen tests. This one was the fourth,
 * and its single `invoke` made `screens/Reader.tsx` — eighty modules, the whole
 * reading surface — impossible to bundle for a browser.
 *
 * There is an irony worth keeping: `hasDictionary` is **macOS only**, so
 * `decideLookUp` answers `none` in a browser and on Windows and Linux. The
 * feature that locked the reader out of a browser is a button that would never
 * have been drawn there.
 *
 * The fourth instance of one defect — after `extensionFor`, `sizePortOver` and
 * `inTauri`. `scripts/check-browser-safe.mjs` is what makes the fifth loud.
 *
 * ## What the caller gets, and what it must do
 *
 * The command opens Dictionary.app and returns as soon as the OS has taken it;
 * a definition never comes back. It rejects only when the command itself could
 * not run, which the caller turns into a notice — **a lookup that silently did
 * nothing is the failure this path is easiest to get wrong in.**
 *
 * The bound is `MAX_TERM`, imported rather than restated, so this and
 * `isLookUpTerm` cannot disagree about what is too long to look up.
 */
export async function lookUp(term: string): Promise<void> {
  const trimmed = term.trim().replace(/\s+/g, ' ')
  if (trimmed === '' || trimmed.length > MAX_TERM) return
  await invoke('look_up', { term: trimmed })
}
