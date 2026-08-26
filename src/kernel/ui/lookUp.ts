import { inTauri } from './inTauri'
import type { Platform } from '../core/metrics'

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
 *
 * ## There is now something better to render, on some machines
 *
 * That last line was an invitation, and WI-15.13 takes it. A GLOSS —
 * `GlossProvider` on the kernel, bound by `inference` — is one or two
 * sentences about the word IN THE SENTENCE IT SITS IN, which is precisely the
 * case the system dictionary handles worst: it doubles the headword, gives
 * every sense of *close* rather than the one on the page, **and a multi-word
 * selection returns nothing at all**. The selection popover offers Look up on
 * any selection under 120 characters, so selecting a phrase on macOS today
 * opens Dictionary.app onto a blank result. The gloss is the fix for that
 * case, and it is the only lookup a Windows or Linux reader has ever had.
 *
 * ⚠️ **NOTHING BELOW REGRESSES THE EXISTING BEHAVIOUR.** With no model
 * installed, [`decideLookUp`] answers `system` on macOS and `none` everywhere
 * else — which is exactly `hasDictionary` and exactly today. Everything here
 * is addition.
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
export const MAX_TERM = 120

/** What a Look up gesture should actually do. */
export type LookUpAction = 'system' | 'gloss' | 'both' | 'none'

/**
 * What to do when the reader asks to look something up.
 *
 * The three inputs are the platform's dictionary, whether a gloss is bound,
 * and the reader's stored preference. NO REGRESSION IS THE RULE: with no
 * gloss, this is `hasDictionary(platform) ? 'system' : 'none'` and nothing
 * else — the same two outcomes the feature has always had.
 *
 * Kept here rather than in the reader so the rule has one home and a test,
 * and so `Reader.tsx` reads as one call rather than three nested conditions.
 */
export function decideLookUp(
  dictionary: boolean,
  gloss: boolean,
  preference: LookUpAction,
): LookUpAction {
  if (!gloss) return dictionary ? 'system' : 'none'
  if (!dictionary) return 'gloss'
  /* Both halves exist, so the reader's choice decides — and `both` earns its
   * keep on the phrase case, where the system dictionary returns nothing and
   * the gloss does not. */
  return preference === 'none' ? 'system' : preference
}

/**
 * Whether a term is short enough to be worth looking up at all.
 *
 * ⚠️ **COUNTED IN CODE POINTS, AND IT USED TO BE CODE UNITS.** `String.length`
 * is UTF-16 units, so an emoji or a CJK extension character counts twice; the
 * Rust boundary this mirrors (`lib.rs`'s `MAX_LOOKUP`) uses `chars().count()`,
 * which counts scalars. The two disagreed for any selection containing an
 * astral character — a passage the native side would happily accept, refused
 * by the interface before it ever got there, with no explanation available to
 * a reader who had selected sixty perfectly ordinary-looking characters.
 *
 * Two checks of one rule have to be the same rule. `Array.from` iterates by
 * code point, which is what the comparison needs.
 */
export function isLookUpTerm(term: string): boolean {
  const trimmed = term.trim().replace(/\s+/g, ' ')
  return trimmed !== '' && Array.from(trimmed).length <= MAX_TERM
}

