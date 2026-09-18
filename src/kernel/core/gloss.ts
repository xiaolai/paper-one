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
 * ⚠️ **AN AGENT MAY ANSWER A GLOSS NOW, AND THIS SAID IT MUST NOT.** The rule
 * was F8 — Codex or Claude "would open a session and start a turn to define one
 * word, seconds and a subscription turn spent" — and the owner overturned it on
 * 2026-09-18, because the only alternative was a 2.5 GB download every reader
 * had to take before Look up worked at all. The provider `inference` binds
 * chooses among the local model, an endpoint, Claude and Codex (its
 * `glossRoute.ts` has the order and the reasons). What is still true, and still
 * by construction: a gloss is ONE request for one definition in one fixed
 * shape, never the companion's conversational `ask`, and the kernel knows
 * nothing of which route answered it.
 *
 * ⚠️ **WHO BINDS THIS PORT IS A CONVENTION, NOT A CHECK — THIS PARAGRAPH SAID
 * THE REGISTRY WOULD THROW IF `companion` TRIED, AND IT WOULD NOT.** The
 * registry hands every capability the same `services`, `bindGloss` included,
 * and the slot behind it (`exclusiveSlot` in `services.ts`) refuses only a
 * SECOND binding. A capability that bound it before `inference` did, or in a
 * composition without `inference`, would own the port without complaint — and
 * it is `inference` that would then throw. What holds today is that `inference`
 * is the only caller of `bindGloss` under `src/` (2026-09-13 audit).
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

import type { AnswerLanguages } from './glossLanguage'

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
  /**
   * What to write the definition in — one language, or two in order (WI-17.5).
   *
   * AN INSTRUCTION, NOT CONTEXT: it widens nothing the model reads about the
   * book, which is the rule above. It is here because it changes the answer,
   * and a provider that caches has to key on everything that does — a lookup
   * made in English must not be served back after the reader chose 中文.
   *
   * ONE OR TWO BY TYPE. A request with no language is a request the kernel
   * failed to resolve, and `answerLanguages` always resolves one — so the
   * empty case is not a state a provider should have to decide about, and
   * neither is a third language nothing asks for. This said NON-EMPTY, and the
   * type allowed any number (2026-09-13 audit); see `AnswerLanguages`.
   */
  readonly answerIn: AnswerLanguages
}

/**
 * What a lookup comes back with: the definition, and the part of speech when
 * the provider could tell.
 *
 * ⚠️ **IT WAS A BARE STRING UNTIL 2026-09-18**, and the reader asked for the
 * line §10's prototype draws between the headword and the meaning — a part of
 * speech, small, italic, muted. It belongs to the PROVIDER rather than to any
 * surface, because it is a fact about the word IN THIS SENTENCE and only the
 * thing that read the sentence knows it: `close` is a verb on one page and an
 * adjective on the next, and no word list can settle which. A UI that guessed
 * would be inventing the one part of a dictionary entry that looks most like a
 * fact.
 *
 * ⚠️ **`text` IS THE DEFINITION AND IS NEVER EMPTY.** A provider that cannot
 * tell the part of speech leaves it ABSENT — it must never move the answer into
 * `partOfSpeech` and leave `text` blank, because `text` is what is drawn under
 * the amber term, and an empty amber mark beside a word reads as *this word
 * means nothing*. That is the same rule that makes an empty answer a rejection
 * rather than a definition, one field along. `definitionOf` in `inference`'s
 * `glossProvider.ts` is the reference implementation, and it fails in exactly
 * that direction: a reply it cannot read is drawn WHOLE as the definition, and
 * a part of speech it cannot read is dropped, never the meaning beside it.
 */
export interface Definition {
  /**
   * The meaning, as the reader reads it. One or two sentences — and TWO LINES
   * when two languages were asked for (WI-17.5), which is why no surface may
   * collapse its line breaks.
   */
  readonly text: string
  /**
   * The word class, written the way the answer is written — `adverb`, `名词`,
   * `nom`.
   *
   * OPTIONAL BECAUSE IT CANNOT BE RELIED ON, and that is not a defect to be
   * fixed later: it is whatever a local model wrote, so a model that wrote
   * nothing usable, or something that is not a label, leaves this absent rather
   * than the reader reading a fabrication. There is no closed vocabulary to
   * check it against either — `GlossContext.answerIn` may name any language, so
   * a list of English part-of-speech words would reject every correct answer in
   * every other one.
   */
  readonly partOfSpeech?: string | undefined
}

export interface GlossProvider {
  /** False when nothing can define anything — see `installAt` for why not. */
  readonly available: boolean
  /**
   * WHERE the reader goes to get something that can define — the id of a
   * settings section — or `null` when there is nowhere.
   *
   * ⚠️ **"INSTALL" IS THE FIELD'S NAME AND NO LONGER ITS MEANING.** It was the
   * Local models section, and the offer read "Install one": the local model was
   * the only thing that could answer. Since 2026-09-18 an endpoint, Claude or
   * Codex can answer too and the local model is an opt-in download, so
   * `inference` names its Look up section (`inference:gloss`), where the reader
   * chooses what answers, and the offer reads "Choose one". The kernel never
   * learns which section it is, which is the rule below.
   *
   * ⚠️ **IT WAS A BOOLEAN, `installable`, AND "WHETHER" WAS NOT ENOUGH.** The
   * install offer opened Settings at its top, with the section that installs a
   * model collapsed further down under another band, because a yes/no could
   * not say which section it meant and the kernel may not name a capability's.
   * The provider is the one object that knows both whether and where, so it
   * answers both, as one field — two fields could disagree.
   *
   * ⚠️ **THIS IS THE DIFFERENCE BETWEEN A DEAD BUTTON AND A LIVE ONE**, and
   * it is why `available: false` is not enough on its own. Two situations look
   * identical to the reader UI and are not the same at all:
   *
   * - `inference` is composed and nothing is set up to answer yet. Nothing can
   *   define anything **today**, and an endpoint, a signed-in CLI or a 2.5 GB
   *   download away it can. The Look up control stays and offers the section
   *   where the choice is — §07's rule is about controls that cannot act, and
   *   one that opens the way to an answer acts.
   * - `inference` is not composed at all — a browser client, iOS, Android.
   *   There is no Look up section to send anybody to, so offering one would be
   *   the app naming a feature that host will never have. The control is
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
  readonly installAt: string | null
  /**
   * Get ready to define, without defining anything.
   *
   * ⚠️ **THE FIRST LOOKUP OF A SESSION PAID FOR THE RUNTIME, AND THE READER
   * PAID IT STANDING STILL.** Nothing started the daemon before a gloss was
   * asked for, so the first ask bound a process, probed accelerators and loaded
   * a model before a single token was generated — `glossProvider`'s own words
   * are *"a cold start can take seconds"* — while a popover sat empty beside a
   * word. Every later lookup was quick, because the daemon is shared. One
   * gesture, two very different waits, and nothing in the UI said why.
   *
   * VOID, NOT A PROMISE, and that is the whole shape of it: there is nothing to
   * wait for and nothing to fail. A caller that could await it would be a
   * caller that could block a reader on it, which is the thing being fixed. It
   * must never throw and never reject — a warm that fails changes nothing about
   * what the reader sees, because the real ask reports its own failure in their
   * words, and reporting it twice would put a runtime error in front of someone
   * who has not asked for anything yet.
   *
   * Idempotent, and cheap to call again: the implementation starts a daemon
   * only when one is not already up.
   */
  warm(): void
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
   *
   * Resolves with a `Definition` rather than the definition's text, so the part
   * of speech arrives from the one place that can know it — see `Definition`.
   */
  gloss(term: string, context: GlossContext, signal: AbortSignal): Promise<Definition>
}

/**
 * The default: there is nothing to define with, and nowhere to get one.
 *
 * `installAt` is NULL, which is what stops a host with no `inference` from
 * drawing a Look up button that offers a choice it cannot make. A build
 * that composes `inference` replaces this whole object at `bindGloss`.
 *
 * `gloss` throws rather than returning a sentence, because the UI must never
 * reach it — `available` is false, so every affordance that would call it is
 * either absent or showing the way to something that can answer, per §07. If this ever throws,
 * that is a bug in the caller and it should be loud rather than showing the
 * reader a fabricated definition under an amber mark.
 */
export const NO_GLOSS: GlossProvider = {
  available: false,
  installAt: null,
  /* Nothing to warm: there is no runtime behind this and never will be, which
     is what `available: false` says. It is written out rather than left off
     because the port requires it, and a caller warming whatever it was handed
     must not have to ask which kind it got. */
  warm() {},
  async gloss() {
    throw new Error('No gloss provider is bound. Check `available` before calling gloss().')
  },
}
