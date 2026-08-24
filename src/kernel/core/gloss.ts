/**
 * The gloss — a definition of the word in front of the reader, in the
 * sentence it actually sits in.
 *
 * A different shape from an answer, and the difference is not cosmetic. It is
 * one or two sentences rather than a stream, it needs no citation because the
 * citation is the selection the reader is looking at, and it is wanted in
 * milliseconds because a reader has stopped reading to wait for it.
 *
 * WHY THIS IS A KERNEL PORT AND NOT A CAPABILITY'S PROPERTY. `lookUp.ts`
 * lives in `src/kernel/ui/`, and the ADR's first rule is that the kernel
 * imports nothing from a capability (`.dependency-cruiser.cjs`,
 * `no-kernel-to-capabilities`). Where it must call into one it goes through a
 * kernel-owned port with a no-op default — `MutationRecorder`,
 * `ContentBlobPort`, `SettingsStore`, `Diagnostics` — and this is the fifth.
 *
 * WHY IT IS NOT THE COMPANION'S. Two capabilities racing to bind one port is
 * worse than either owning it outright, so `gloss` is bound by `inference`
 * and `ask` is bound by `companion`. That also gives the dictionary a
 * lifetime independent of the conversation: with `companion` absent, failed,
 * or set to an agent, the gloss still works.
 *
 * ⚠️ **THE GLOSS MUST NOT REACH AN AGENT**, and it is enforced by
 * construction rather than by a rule someone has to remember. Codex or Claude
 * would open a session and start a turn to define one word — seconds, and a
 * subscription turn spent, for a gesture a reader makes dozens of times a
 * chapter. So `gloss` is bound only by `inference`, the agent adapters
 * implement `ask` and nothing else, and there is no code path from a
 * selection to a session. `companion` cannot bind this port; the registry
 * would throw if it tried.
 *
 * ## What the reader sees
 *
 * A gloss is AMBER. It is machine-written text appearing in the reader, and
 * `marks.ts` has reserved the `companion` kind, its amber tint and the `wave`
 * style for exactly this. A definition from Apple's dictionary is
 * authoritative and a gloss from a 4B model is not; the reader must be able
 * to tell without being told, which is what the mark is for.
 */

import { defineSetting, type Setting } from './ports'

/**
 * What the model is allowed to see when it defines a term.
 *
 * The sentence and nothing more. That is the whole point of the feature — a
 * dictionary gives every sense of *close*, and this gives the one that is on
 * the page. Widening this to the paragraph or the chapter would make it a
 * small companion answer, which is a different feature that already exists.
 */
export interface GlossContext {
  /** The sentence the term sits in, as it appears in the book. */
  readonly sentence: string
  /** The book's title, for a term whose sense is set by the subject. */
  readonly bookTitle: string
}

export interface GlossProvider {
  /** False when nothing can define anything — the control stays as it was. */
  readonly available: boolean
  /**
   * Define `term` as it is used in `context`.
   *
   * A PROMISE, not a generator, and that is a decision rather than an
   * omission: two sentences streamed into a popover beside a word is jitter,
   * not progress. The reader wants it to appear, not to arrive.
   *
   * Rejects on failure — the caller shows the system dictionary or a notice.
   * It must never resolve with an apology, because an apology rendered in
   * amber reads as a definition.
   */
  gloss(term: string, context: GlossContext, signal: AbortSignal): Promise<string>
}

/**
 * The default: there is nothing to define with.
 *
 * `gloss` throws rather than returning a sentence, because the UI must never
 * reach it — `available` is false, so every affordance that would call it
 * either stays on the system dictionary or is absent per §07. If this ever
 * throws, that is a bug in the caller and it should be loud rather than
 * showing the reader a fabricated definition under an amber mark.
 */
export const NO_GLOSS: GlossProvider = {
  available: false,
  async gloss() {
    throw new Error('No gloss provider is bound. Check `available` before calling gloss().')
  },
}

/**
 * What `Look up` does, by platform and by what is installed.
 *
 * A CLOSED set of three, which is why the settings row can be a cycle button
 * where the route list cannot: there is a system dictionary or there is not,
 * and there is a local model or there is not. It cannot gain a fourth state.
 */
export const LOOK_UP_MODES = ['system', 'gloss', 'both'] as const
export type LookUpMode = (typeof LOOK_UP_MODES)[number]

export function isLookUpMode(raw: unknown): raw is LookUpMode {
  return typeof raw === 'string' && (LOOK_UP_MODES as readonly string[]).includes(raw)
}

/**
 * Which modes are offerable, given the platform and what is installed.
 *
 * NO REGRESSION IS THE RULE THIS ENCODES. With no model installed, macOS
 * offers exactly what it offers today and Windows and Linux still show no
 * control at all — everything the gloss adds is addition. The `hasDictionary`
 * argument is `lookUp.ts`'s own answer, passed in rather than recomputed, so
 * there is one place that decides what a platform has.
 */
export function availableModes(hasDictionary: boolean, hasGloss: boolean): readonly LookUpMode[] {
  if (hasDictionary && hasGloss) return LOOK_UP_MODES
  if (hasDictionary) return ['system']
  if (hasGloss) return ['gloss']
  /* Neither. The caller shows no control — an empty list is what says so,
   * and it is why this returns a list rather than a mode. */
  return []
}

/**
 * The mode to actually use, given what the reader chose and what exists.
 *
 * A stored preference outlives the thing it names: a reader who chose `gloss`
 * and then removed the model has a setting pointing at nothing. Rather than
 * failing, or silently rewriting their choice, this falls back to whatever
 * IS available and leaves the stored value alone — so re-installing the model
 * restores what they asked for without them having to ask twice.
 */
export function effectiveMode(chosen: LookUpMode, available: readonly LookUpMode[]): LookUpMode | null {
  if (available.length === 0) return null
  if (available.includes(chosen)) return chosen
  /* `both` degrades to whichever half survived, in that order — the system
   * dictionary first, because it is the behaviour that predates this feature
   * and the one a reader is least surprised by. */
  if (available.includes('system')) return 'system'
  return available[0] ?? null
}

/**
 * The reader's `Look up` preference.
 *
 * A KERNEL setting, under `kernel.`, and the namespace is the argument: this
 * value decides what `ui/lookUp.ts` does when the reader asks to look
 * something up, and that file is the kernel's. `inference` binds the provider
 * and draws the row; it does not own the question.
 *
 * THE DEFAULT IS `both`, AND IT USED TO BE `system`. The old default was
 * justified as making the no-regression rule true "at the storage layer as
 * well as in the code" — but the code alone already makes it true, and
 * unconditionally: `decideLookUp`'s first branch is `if (!gloss) return
 * dictionary ? 'system' : 'none'`, which never reads the preference at all.
 * `lookUp.test.ts` pins exactly that with `decideLookUp(true, false, 'gloss')`
 * → `'system'`. The storage-layer half was belt and braces.
 *
 * What the braces cost: a reader who downloaded a 2.3 GB model still got
 * Dictionary.app, because the stored key is absent, the fallback reads
 * `system`, and `decideLookUp(true, true, 'system')` honours it. The feature
 * was installed, bound, available — and silent until the reader found a
 * settings row telling them so. A default that hides what was just installed
 * is the wrong default.
 *
 * `both` RATHER THAN `gloss`, because the two halves fail on different inputs.
 * A `dict://` lookup of a phrase finds nothing at all — that is the case
 * `LookUpAction`'s `both` was introduced for — while the gloss answers it; and
 * the system dictionary is instant and offline where the gloss costs a model
 * run. Defaulting to one of them would trade a working answer for the other's
 * blind spot. `system` and `gloss` are each one cycle away for a reader who
 * wants only one.
 */
export const LOOK_UP_SETTING: Setting<LookUpMode> = defineSetting('kernel.lookUp', 'both', (raw) =>
  isLookUpMode(raw) ? raw : undefined,
)

/** What each mode is called in the settings row's cycle. */
export const LOOK_UP_LABELS: Readonly<Record<LookUpMode, string>> = Object.freeze({
  system: 'System dictionary',
  gloss: 'Gloss',
  both: 'Both',
})
