/**
 * The VOICE — saying a word out loud, in the machine's own speech engine.
 *
 * **THE SYSTEM VOICE IS THE VOICE.** The kernel's default (`systemVoice()`,
 * over `window.speechSynthesis`) is what pronounces a looked-up term, and today
 * no capability binds another. So pronunciation works with nothing installed,
 * no capability composed, in a browser client and on a phone. `bindVoice` stays
 * the kernel's port — the seam a better voice would bind through — but nothing
 * uses it now.
 *
 * ⚠️ **A NEURAL VOICE WAS BOUND OVER IT, AND IS DELETED.** `inference` bound
 * Kokoro, through the runtime, as a preference with this one as its fallback.
 * It went for four reasons: a neural TTS model is at its weakest on exactly
 * what a lookup asks of it — one word, where quality falls off below roughly
 * ten to twenty tokens; Kokoro's Mandarin voices are graded C and D; the local
 * runtime is now llama.cpp's `llama-server`, which has no speech route, so
 * keeping it meant keeping Lemonade or staging a second engine; and the system
 * voice was measured working in the running app — 73 voices across 39
 * languages on this Mac. `ui/reader/systemVoice.ts` records the measurement.
 *
 * ⚠️ **AND THIS HEADER USED TO BLAME THE PLATFORM FOR THE NEURAL VOICE'S
 * FAILURE.** That was wrong, and the correction matters to whoever brings one
 * back: the failure was Paper's. It asked Lemonade's sound-effects route
 * (`/api/v1/audio/generations`) where speech is `/v1/audio/speech` with an
 * `input` field, the backend that serves Kokoro was blocked from being fetched
 * (`no_fetch_executables`), and the model was registered under the wrong name.
 * The platform was never the obstacle.
 *
 * ⚠️ **AND THE PORT ASKS ABOUT A LANGUAGE, NOT ABOUT ITSELF** — `canSay(lang)`
 * rather than `available`. "Something can speak" is the right question for
 * reading a chapter aloud and the wrong one here: a term pronounced in a voice
 * for the wrong language is a wrong answer the reader cannot check, which is
 * the same objection this file's header raises against invented IPA. See
 * `canSay` for the rule, including why an empty voice list means *unknown*.
 *
 * ## What it is for, and what it replaced
 *
 * §10's prototype draws a dictionary entry as a headword, a pronunciation, a
 * part of speech and a meaning, and the pronunciation was going to be IPA.
 * **It cannot be.** A language model has no phonetic data; asked for IPA it
 * produces something that LOOKS like a transcription, and a wrong one is worse
 * than none — the reader has no way to tell, and the whole point of the amber
 * mark is that machine-written text is legible AS machine-written. So the
 * reader hears the word instead of reading an invention. A speech engine is
 * not a guesser: what comes out of it is the word.
 *
 * ## Why it is a kernel port, and why it is NOT part of `GlossProvider`
 *
 * `LookUpFace` is the kernel's, and any voice better than the machine's own
 * would be a capability's — a model it installs and a runtime it supervises —
 * so the ability to speak has to be able to cross the same boundary the gloss
 * already crosses: the kernel imports nothing from a capability
 * (`.dependency-cruiser.cjs`, `no-kernel-to-capabilities`). A kernel-owned port
 * with a working default is the established answer: `MutationRecorder`,
 * `ContentBlobPort`, `SettingsStore`, `Diagnostics`, `GlossProvider`, and this.
 *
 * Hanging it off `GlossProvider` was the obvious alternative and is the wrong
 * shape, for three reasons that are all about the object rather than about the
 * wiring:
 *
 * - **It is a different machine with a different install.** `available` on the
 *   gloss means "a TEXT model can define a word"; this asks whether anything at
 *   all can say one IN A GIVEN LANGUAGE, which is not even the same shape of
 *   question. They are two engines and two failure modes, and a reader can
 *   easily have one and not the other — a machine that speaks and has no text
 *   model downloaded is the ordinary first launch. Two availability fields on
 *   one object, one of them named for the file it lives in, is how `installAt`
 *   came to disagree with `available` — "one snapshot, two readings", recorded
 *   in `gloss.ts`, and it is why this port has exactly ONE such question rather
 *   than an `available` beside a `canSay`.
 * - **Speaking is not about the lookup.** The lookup is the first caller, not
 *   the owner: the same voice is what reading a chapter aloud will use, and a
 *   read-aloud reaching through an object called the gloss provider would be the
 *   `hasDictionary` mistake — a fact parked on whatever object was nearest.
 * - **The gloss port is a request/response contract and this is a STATE.** A
 *   gloss resolves once, and `useGloss` holds its own `asking`/`ready`; an
 *   utterance is a thing that is happening, which a surface subscribes to.
 *
 * ## Why there is no `installAt`
 *
 * `GlossProvider.installAt` exists because a Look up control with no model is
 * still worth drawing — it can offer the download, and §07's rule is about
 * controls that cannot ACT. Pronunciation is different: it is one glyph beside a
 * headword inside an answer the reader already has, and a second install offer
 * inside a definition would be Paper advertising a download in the middle of
 * telling somebody what a word means. So the control is ABSENT when nothing can
 * speak: a control that cannot do anything is §07's "disabled and says why"
 * with nothing to say.
 *
 * ⚠️ **AND THAT RULE IS NOW ALMOST NEVER REACHED, WHICH IS THE POINT.** It was
 * written when "nothing can speak" meant "no neural model", which was the
 * common case; with the system speaker as THE voice it means "this machine
 * has no speech engine at all" — a build with no `window.speechSynthesis`. The
 * rule is unchanged and still the right one; what changed is how often it is
 * true. A reader who installs no model now hears the word in their own system
 * voice rather than seeing no control, which is what the download offer this
 * paragraph refuses would have been for.
 *
 * ## ⚠️ THERE IS ANOTHER "VOICE" IN THIS KERNEL, AND IT IS NOT THIS ONE
 *
 * `core/public/binding.ts` has `VoiceBinding`, `VoiceStanding`, `voicesOf` and
 * `blockVoice` — a PERSON's voice in the circle, in the sense of having a say.
 * This one is literal: speech, out of the machine's engine. The two never meet
 * in a type, and the literal sense has the better claim on the bare word,
 * because it is what the app already does out loud — the lookup's pronunciation
 * control. Said here so the next reader who greps for `Voice` knows which two
 * things they found.
 *
 * ## `say` does not reject, and nothing awaits it
 *
 * A failure is a STATE the surface draws, not a rejection it has to catch. That
 * is the same decision `GlossProvider.warm` records — a caller that could await
 * it is a caller that could block a reader on it — and it is what lets the
 * control be a two-state button rather than a promise chain with its own error
 * handling in the view.
 */

/** What the voice is doing. */
export type Speaking = 'idle' | 'speaking' | 'failed'

export interface Voice {
  /**
   * Whether a term in `lang` can be said aloud — the one question this port
   * answers about itself.
   *
   * ⚠️ **IT WAS `available: boolean`, AND A BOOLEAN IS THE WRONG SHAPE FOR
   * TWO REASONS THAT BOTH END IN A READER BEING MISLED.**
   *
   * - **An engine can be present with nothing behind it.** WebKitGTK answers
   *   `'speechSynthesis' in window` with no speech-dispatcher installed, which
   *   is the DEFAULT state on Linux: the utterance is accepted, no error is
   *   raised, and the reader hears silence. `speechAvailable` says so in its own
   *   comment.
   * - **A voice for the WRONG language is worse than no voice.** For reading a
   *   chapter aloud a mispronouncing voice still reads the book; for
   *   PRONUNCIATION the whole point is hearing the word correctly, and an
   *   English voice mangling a Chinese term is worse than an absent control —
   *   the reader has no way to know and will believe what they heard. This is
   *   the same argument `core/voice.ts`'s header makes against inventing IPA,
   *   one step along: a wrong answer the reader cannot check.
   *
   * So the question carries the language, and the two callers of the speech
   * engine no longer share one answer: the Listen control asks
   * `speechAvailable` (can this build read aloud at all) and this asks whether
   * THIS word can be said properly.
   *
   * ⚠️ **AND AN EMPTY VOICE LIST IS `UNKNOWN`, NOT `NO`.** `getVoices()` answers
   * `[]` until the engine has loaded its list and fired `voiceschanged`, so
   * reading emptiness as "no voices" would remove the control for the first
   * moments of every session. Empty ALLOWS the press — a false positive costs
   * one press, a false negative costs the feature — and a populated list is
   * authoritative: no matching voice in it means the control is absent, which is
   * §07's rule for a control that cannot act. That is this repository's
   * absent-versus-unreadable distinction applied to a voice list: absent is
   * unknown, present-and-without-a-match is a real no.
   *
   * ⚠️ **A VOICE THAT ANSWERS `UNKNOWN` MUST CORRECT ITSELF.** The
   * implementation subscribes to the engine's `voiceschanged` and notifies
   * through `subscribe`, so a control drawn against an empty list disappears
   * when the list arrives without one. Without that, an optimistic answer would
   * stay wrong for the whole session.
   *
   * `null` is "the passage declared no language", which is a real answer and not
   * a gap: the utterance is then left to the reader's own default voice, so any
   * voice at all will do. See `Voice.say`.
   *
   * READ PER CALL, never captured, so a reader who installs a voice while the
   * popup is open gets it without a restart.
   */
  canSay(lang: string | null): boolean
  /** What it is doing right now. */
  state(): Speaking
  /**
   * Told whenever `state()` may have changed; the returned function stops
   * listening.
   *
   * A STORE, in the shape `useSyncExternalStore` wants, because that is what the
   * reader sees: a control that says Stop while a word is playing and goes back
   * to saying Play when it ends. The work line port is the same pair for the
   * same reason.
   */
  subscribe(listener: () => void): () => void
  /**
   * Say `text` aloud, in `lang` where one is known.
   *
   * NEVER REJECTS AND RETURNS NOTHING — see the header. A press that cannot be
   * served (nothing installed, something already speaking) does nothing at all
   * rather than raising something a view would have to translate.
   *
   * ⚠️ **THE LANGUAGE IS THE BOOK'S, NEVER THE INTERFACE'S.** A term is looked
   * up inside a passage, and the passage's own `lang` is what says how to
   * pronounce it — `localeAt`, the nearest declared language above the
   * selection, which the lookup already resolves at the press to decide what
   * language to ANSWER in (WI-17.5) and now carries on the state. The reading's
   * own `documentLang` is the same fact one level up.
   *
   * ABSENT rather than `''` when the passage declares none, and that is not
   * cosmetic: WebKit reads an empty `lang` on an utterance as a language it has
   * no voice for, where an unset one leaves the reader's own system default
   * alone. `documentLang` records the measurement.
   *
   * OPTIONAL, because a caller with no passage behind it — a test, and any
   * future surface that speaks something that is not in a book — has no honest
   * answer to give, and inventing one would be the `hasDictionary` failure in
   * miniature: a default that quietly decides a fact about the text.
   */
  say(text: string, lang?: string | null): void
  /** Stop, and clear any failure with it. Safe when nothing is speaking. */
  stop(): void
}

/**
 * The port for a machine that cannot speak at all.
 *
 * ⚠️ **NO LONGER THE KERNEL'S DEFAULT, AND THIS SAID IT WAS.** The default is
 * `systemVoice()` — see the header — so a browser client, a phone and a build
 * without `inference` all speak rather than drawing nothing. What this remains
 * is the honest null object, and what reaches for it now is every surface test
 * written against a face with no voice. (It had a second caller, the neural
 * voice's `fallback` in a test that wanted no second way to say a word; that
 * went with the neural voice. A build with no speech engine does not need it
 * either: `systemVoice()` answers `canSay` false there on its own.)
 *
 * `canSay` is FALSE for every language, which is what stops a control being
 * drawn that could never say anything. `subscribe` hands back a working
 * unsubscribe rather than
 * `undefined`: a store that returned nothing there throws inside
 * `useSyncExternalStore`'s cleanup, on unmount, in exactly the builds that
 * never bound a voice — the defect `NO_WORK_LINE` records in its own test.
 */
export const NO_VOICE: Voice = {
  /* NO, FOR EVERY LANGUAGE, including the no-language case: there is nothing
     here to say anything with, which is a known answer rather than an unknown
     one. */
  canSay: () => false,
  state: () => 'idle',
  subscribe: () => () => {},
  /* Silent rather than throwing, unlike `NO_GLOSS.gloss`. The difference is
     whether a caller can be expected to have checked: `gloss()` is reached only
     from a path that has already read `available`, so reaching the default is a
     bug worth being loud about, while `say` is a button's own handler and the
     button is simply not drawn — a throw here would be a crash in a control
     nobody can see. */
  say() {},
  stop() {},
}
