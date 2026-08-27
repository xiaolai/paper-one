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
 * ## The system dictionary is gone, and this is now the whole feature
 *
 * `Look up` used to have three modes — hand the passage to Dictionary.app,
 * gloss it, or both — with a stored `kernel.lookUp` preference, a cycle
 * button in the companion's settings pane, and a `look_up` command in Rust
 * that shelled out to `open dict://…`. All of it is deleted.
 *
 * The hand-off was never Paper's feature. macOS already offers it on the
 * right-click menu of any selection, so Paper's copy of it was a second route
 * to somebody else's window — and it cost a mode, a setting, a settings row,
 * a resolver pair and a native command to carry. The `both` mode was worse
 * than redundant: `open` raises Dictionary.app, so the default lookup spent a
 * model run producing a gloss behind a window the reader was no longer
 * looking at.
 *
 * So there is ONE behaviour, and with one behaviour there is nothing to
 * choose between — which is why the mode, the setting and the row went with
 * it rather than being re-answered.
 *
 * ## What the reader sees
 *
 * A gloss is AMBER. It is machine-written text appearing in the reader, and
 * `marks.ts` has reserved the `companion` kind, its amber tint and the `wave`
 * style for exactly this. A definition from a dictionary is authoritative and
 * a gloss from a 4B model is not; the reader must be able to tell without
 * being told, which is what the mark is for.
 */

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
  /** False when nothing can define anything — see `installable` for why not. */
  readonly available: boolean
  /**
   * Whether an unavailable gloss is one the reader could go and install.
   *
   * ⚠️ **THIS IS THE DIFFERENCE BETWEEN A DEAD BUTTON AND A LIVE ONE**, and
   * it is why `available: false` is not enough on its own. Two situations look
   * identical to the reader UI and are not the same at all:
   *
   * - `inference` is composed and no model is downloaded yet. Nothing can
   *   define anything **today**, and a 2.5 GB download away it can. The Look
   *   up control stays and offers the download — §07's rule is about controls
   *   that cannot act, and one that starts an install acts.
   * - `inference` is not composed at all — a browser client, iOS, Android.
   *   There is no models pane to send anybody to, so offering an install would
   *   be the app naming a feature that host will never have. The control is
   *   absent, which is the same answer Windows and Linux got before the gloss
   *   existed.
   *
   * THE PROVIDER ANSWERS IT, not the composition root and not a platform
   * predicate, because the provider is the only thing that knows. The deleted
   * `hasDictionary` went the other way — a fact the root worked out and passed
   * down through `KernelServicesOptions` — and it acquired a `= false` default
   * on the way, which on macOS silently removed the system dictionary from the
   * cycle for as long as the production caller forgot to pass it. A field on
   * the object that knows cannot be defaulted wrong by a caller that does not.
   */
  readonly installable: boolean
  /**
   * Define `term` as it is used in `context`.
   *
   * A PROMISE, not a generator, and that is a decision rather than an
   * omission: two sentences streamed into a popover beside a word is jitter,
   * not progress. The reader wants it to appear, not to arrive.
   *
   * Rejects on failure — the caller shows the failure, apart from the
   * definition and never in amber. It must never resolve with an apology,
   * because an apology rendered in amber reads as a definition.
   *
   * ⚠️ **THE REJECTION IS READ BY THE READER**, so an implementation owes it a
   * sentence they can act on rather than one written for a maintainer. This is
   * the only lookup Paper has: with the Dictionary.app hand-off deleted there
   * is nothing behind it, so "it did not work" with no reason attached is the
   * end of the road rather than a nudge toward the other mode.
   */
  gloss(term: string, context: GlossContext, signal: AbortSignal): Promise<string>
}

/**
 * The default: there is nothing to define with, and nowhere to get one.
 *
 * `installable` is FALSE, which is what stops a host with no `inference` from
 * drawing a Look up button that offers a download it cannot perform. A build
 * that composes `inference` replaces this whole object at `bindGloss`.
 *
 * `gloss` throws rather than returning a sentence, because the UI must never
 * reach it — `available` is false, so every affordance that would call it is
 * either absent or showing the install prompt per §07. If this ever throws,
 * that is a bug in the caller and it should be loud rather than showing the
 * reader a fabricated definition under an amber mark.
 */
export const NO_GLOSS: GlossProvider = {
  available: false,
  installable: false,
  async gloss() {
    throw new Error('No gloss provider is bound. Check `available` before calling gloss().')
  },
}
