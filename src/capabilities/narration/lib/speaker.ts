/**
 * Reading aloud: one utterance at a time, through the platform's engine.
 *
 * Web Speech, which is what a WebView gives us: no credentials, and the voices
 * the reader already has installed.
 *
 * ⚠️ **THIS SAID "NO NETWORK" AND THAT WAS NOT TRUE OF THE API.** It is true of
 * every voice macOS installs, and the specification allows a voice — INCLUDING
 * THE DEFAULT — to be synthesised on a server; Chrome's default voices are.
 * Paper reads a book aloud section after section, so on such an engine that is a
 * book's text leaving the machine. `voiceChoice.ts` never CHOOSES a voice that
 * reports `localService: false`, which is as far as this layer can go: leaving
 * `utterance.voice` unset uses the platform's default, and on a machine whose
 * only voices are remote that default is remote. Refusing to read aloud at all
 * there is a product decision and is recorded as one, not taken quietly here.
 *
 * ## One utterance is one SENTENCE, not one section
 *
 * ⚠️ **THIS FILE SAID "WHOLE SECTIONS" AND HAD SINCE `115575b`.** `useSpeech`
 * queues a sentence at a time, because Web Speech can neither seek inside an
 * utterance nor change its rate once it has started — so pause, speed, and the
 * sentence and paragraph steps are all impossible while a section is one
 * utterance. Two consequences belong here rather than in the hook:
 *
 * - `onboundary` reports a character offset into THE STRING THAT WAS SPOKEN,
 *   which is now one sentence. The caller rebases it; see `cursorRef`.
 * - `BOUNDARY_GRACE_MS` measures one utterance's speech, and a sentence can end
 *   before 2.5 s of it. So on an engine that reports no boundaries at all, a
 *   book of short sentences never reaches `onNoBoundaries`. That is deliberately
 *   left alone: the callback's only effect is to stop drawing the band and
 *   remove it, and an engine that reports nothing never drew one — so there is
 *   nothing to stop and nothing to remove. Carrying the timer across utterances
 *   would mean keeping one alive across the `speak` that starts the next
 *   sentence — and every path that retires a reading clears it precisely so a
 *   stale timer cannot blame a reading that is no longer the same one.
 * - What DOES cross utterances is the band itself, and that was a real defect:
 *   see `speakSentence` in `useSpeech.ts`, which clears it before each sentence.
 *
 * The handoff warns that boundary events are unreliable on WebKitGTK, which is
 * Linux. That is handled by feature detection rather than by a platform check
 * — see `Speaker`: if no boundary arrives shortly after speech starts, the
 * follow-along highlight is abandoned and the reading continues. Guessing from
 * the user agent would be wrong on the engines that do support it.
 */

import { voiceFor } from './voiceChoice'

/**
 * Why an utterance is over. `ended` is the only one worth continuing from.
 *
 * `taken` is the one that is about ANOTHER utterance: the single engine was
 * handed something else to say, which cancels this one — see `engineHeldBy`.
 * It is neither an ending nor a failure, and it has to be its own word because
 * the two callers want opposite things from it. A reading treats it as an end
 * and stops, visibly, rather than walking on into the next section; the
 * lookup's pronunciation treats it as `idle` rather than drawing "Paper
 * couldn't say that aloud" over a reader who has just pressed Listen.
 */
export type DoneReason = 'ended' | 'empty' | 'error' | 'taken' | 'no-voice'

/**
 * What the reader has decided about how the book should sound.
 *
 * PASSED PER UTTERANCE, not held on the `Speaker`. A reading walks many
 * sections and a section is one utterance, so a preference read at `speak` time
 * reaches the next section — a reader who changes the voice mid-chapter hears it
 * at the next one rather than after a restart. Holding it on the speaker would
 * mean either a stale copy or a second way to push updates into an object whose
 * whole job is one utterance at a time.
 *
 * Both optional, and absent means *leave the platform's own*: an engine's
 * default voice and rate are what the reader chose in their system settings, and
 * overwriting them with a guess is how an app ends up sounding worse than the
 * thing it replaced.
 */
export interface SpeakPrefs {
  /** Chosen voice per primary language subtag — `{ en: '…Ava', zh: '…Tingting' }`. */
  readonly voices?: Readonly<Record<string, string>>
  /** A multiplier on the engine's own default; 1 is that default. */
  readonly rate?: number
  /**
   * How loud, from 0 (silent) to 1 (as the voice produces it) — the
   * `narration.readingVolume` setting as a fraction.
   *
   * ⚠️ **PLAYBACK'S ALONE, AND 0 IS NOT STOPPING.** No render request and no
   * audiobook hears of it, so a clip is the same clip at any volume; and nothing
   * may branch on it being 0, because a reading's band, page turns and next
   * section all hang off the voice going through the motions.
   */
  readonly volume?: number
  /**
   * Silence after a sentence and after a paragraph, in milliseconds.
   *
   * ⚠️ **NOT THE ENGINE'S TO HONOUR — `useSpeech` WAITS.** Web Speech has no
   * break, no SSML and no `preUtteranceDelay`, so there is nothing to hand an
   * utterance. They live on `SpeakPrefs` anyway because that is what the reading
   * reads its preferences from, and the native engine WILL take them directly:
   * `AVSpeechUtterance.preUtteranceDelay` and `postUtteranceDelay` exist and
   * default to 0 (measured on macOS 27, 2026-09-20).
   */
  readonly sentenceGapMs?: number
  readonly paragraphGapMs?: number
  /**
   * Read a note's BODY where the book leaves one on the page.
   *
   * ⚠️ **ON `SpeakPrefs` BECAUSE THE READING AND THE EXPORT MUST AGREE.** It is
   * not the Speaker's — no utterance carries it — but this is the one value the
   * reading reads its preferences from, and the audiobook walks the same text
   * through the same `collectText`. Two defaults, one per path, is how a reader
   * gets a book that speaks one thing and exports another. See `NOTE_BODIES` in
   * `speechSkip.ts` for why it is a choice at all.
   */
  readonly notesAloud?: boolean
}

export interface SpeakerCallbacks {
  /**
   * A word began. Called only for boundaries the engine reports — an engine
   * that reports none says so ONCE through `onNoBoundaries` instead.
   */
  onWord: (index: number, length: number) => void
  /**
   * Speech finished, and why. `ended` is the text running out — a section
   * read to its last word; `empty` is a section with nothing to read, reported
   * synchronously from inside `speak`; `error` is the engine giving up;
   * `no-voice` is the floor refusing every voice this engine has for the text,
   * also reported synchronously — see `voiceFor`. Not called for `stop()`,
   * whose caller already knows.
   */
  onDone: (reason: DoneReason) => void
  /**
   * Called once if the engine turns out not to report word boundaries, so the
   * caller can drop the follow-along highlight rather than leaving a stale one
   * parked on the first word for the rest of the chapter.
   */
  onNoBoundaries: () => void
}

/**
 * The rate range Web Speech defines. Outside it the engine's behaviour is its
 * own business, so a stored value beyond either end is left unset rather than
 * passed on or clamped.
 */
const MIN_ENGINE_RATE = 0.1
const MAX_ENGINE_RATE = 10

/**
 * How long to wait for the first boundary event before concluding the engine
 * does not send them. Generous: the first word can be slow to start on a cold
 * voice, and a false negative costs the highlight for the whole chapter.
 */
const BOUNDARY_GRACE_MS = 2500

/**
 * Which `Speaker` last handed each engine an utterance.
 *
 * ⚠️ **`window.speechSynthesis` IS ONE ENGINE SERVING ONE UTTERANCE, AND THIS
 * MACHINERY IS WHAT MAKES A SECOND SPEAKER SAFE.** There is exactly ONE today —
 * the reading (`useSpeech`). There were two: the lookup popup's pronunciation
 * spoke through the same engine from `systemVoice.ts`, WHICH NO LONGER EXISTS,
 * having gone with the AI features. The comment here described that arrangement
 * in the present tense for long enough to mislead an audit, so what follows is
 * the DEFECT it was built for rather than a roster of callers.
 *
 * `speak` begins with `stop()`, so a second speaker CANCELS the first — and a
 * cancelled utterance still delivers its `end`, late, with the first speaker's
 * own generation still current. Its `#finish` therefore read that end as "the
 * section finished". For a reading that means `continueReading()`: pages walking
 * forward hunting the next section while the reader listens to one word.
 *
 * So whoever speaks last HOLDS the engine, and a speaker that no longer holds it
 * reports `taken` rather than whatever its stale event said. No amount of
 * per-utterance guarding can answer that: the event is indistinguishable from a
 * real ending.
 *
 * PER ENGINE, and a `WeakMap` rather than one module-level holder, for a reason
 * that is about the tests as much as the app: every suite here drives a
 * `FakeSynth` of its own, and one shared holder would have a speaker over one
 * fake stealing the engine from a speaker over another — reporting `taken` for
 * utterances nothing had cancelled. Keyed on the engine, two speakers coordinate
 * exactly when they share one.
 */
const engineHeldBy = new WeakMap<SpeechSynthesis, object>()

export class Speaker {
  /**
   * Which utterance is current.
   *
   * `speechSynthesis.cancel()` does not silence the utterance it cancels: its
   * `end` — or `error` — still arrives, just late. Without a way to tell whose
   * event it is, that stale end clears the NEW utterance's boundary timer and
   * reports `onDone` while the new one is still speaking, so the Listen control
   * snaps back to idle a moment after it was pressed.
   *
   * A counter rather than the utterance object, so nothing is retained: every
   * handler closes over the generation it was registered under and does nothing
   * unless it is still the current one.
   */
  #generation = 0
  /* Stryker disable next-line BooleanLiteral: `speak` writes this before it wires the only reader, the grace timer its utterance arms */
  #sawBoundary = false
  #graceTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Whether `onNoBoundaries` has already been called in this reading.
   *
   * ⚠️ **THE CONTRACT SAYS ONCE AND NOTHING KEPT COUNT.** After the grace ran out
   * the first time, every pause and resume armed a fresh timer — and `resume`
   * armed it WITHOUT clearing the one before, so two resumes left two timers
   * running and each called back. The consumer's `setFollowsWords(false)` is
   * idempotent, which is why it never showed; the leaked timers and a callback
   * documented as once and delivered many times were real regardless.
   *
   * Reset in `stop()`, NOT held for the Speaker's life: `useSpeech` reuses one
   * Speaker across readings and resets `followsWords` to true at each `start`,
   * so a permanent flag would let the highlight come back in the next reading
   * and park on its first word with nothing left to correct it.
   *
   * ⚠️ **AND THAT RESET IS WHY THE VALUE HERE CANNOT BE OBSERVED.** The only
   * reader is `#armGrace`'s timer, armed from handlers `speak` registers — and
   * `speak`'s second statement is `stop()`, which writes `false` here. So this
   * initialiser is answered before anything can ask, `true` would behave exactly
   * as `false` does, and the mutation of it is disabled on that ground rather
   * than left as a survivor nothing could kill.
   *
   * Delete the reset in `stop()` and the directive below stops being true — and
   * that deletion fails a case of its own, `measures the engine afresh once a
   * reading has stopped`, which is what keeps this argument checkable.
   */
  /* Stryker disable next-line BooleanLiteral: `speak` calls `stop`, which writes this, before any reader exists */
  #reportedNoBoundaries = false
  /** This speaker's claim on the one engine — see `engineHeldBy`. */
  readonly #token = {}
  readonly #synth: SpeechSynthesis
  readonly #cb: SpeakerCallbacks

  constructor(callbacks: SpeakerCallbacks, synth: SpeechSynthesis = window.speechSynthesis) {
    this.#cb = callbacks
    this.#synth = synth
  }

  /**
   * Speak, and report whether anything was actually queued.
   *
   * The boolean matters: a section with no readable text calls `onDone`
   * SYNCHRONOUSLY, before this returns. A caller that sets its own "speaking"
   * flag afterwards would overwrite the done it has already been told about,
   * leaving the Listen control stuck on with nothing playing.
   *
   * LONG, AND LEFT LONG: it is one utterance's setup, in the order the engine
   * needs it — claim the engine, cancel what was there, build the utterance,
   * choose its voice and rate, wire its four events, hand it over. The one part
   * that WAS duplicated elsewhere, the boundary-grace timer, is `#armGrace` now,
   * and it had drifted before it was pulled out; what remains is used once and
   * reads top to bottom. A helper per step would be a name per line.
   */
  speak(text: string, lang: string | null, prefs: SpeakPrefs = {}): boolean {
    /* CLAIMED BEFORE THE CANCEL, not after it. `stop()` on the next line is
       what cancels the other speaker's utterance, and an engine free to deliver
       that utterance's `end` SYNCHRONOUSLY from inside `cancel()` would find the
       previous holder still recorded and be told its section had finished. The
       claim is honest either way: an empty text still cancels, so it has still
       taken the engine. */
    engineHeldBy.set(this.#synth, this.#token)
    this.stop()
    const generation = ++this.#generation
    if (!text.trim()) {
      this.#cb.onDone('empty')
      return false
    }

    /* THE VOICE, CHOSEN RATHER THAN INHERITED — and REFUSED when nothing is good
     * enough, before an utterance exists. Left unset, WebKit hands an English
     * book `com.apple.voice.super-compact.en-US.Samantha`, the most compressed
     * voice Apple ships. `voiceFor` reads the tier out of `voiceURI` and takes
     * the best one at or above the floor that speaks the document's language —
     * see `voiceChoice.ts`.
     *
     * ⚠️ **`none` IS NOT SPOKEN AT ALL — the owner's rule: no voice rather than
     * a bad one.** It used to be a null that left the property alone, which gave
     * the platform's default, which on a Mac is the compact voice the floor had
     * just refused. `platform` still leaves it alone: that is an engine that has
     * listed nothing yet, or a book with no language among good voices, and
     * there is nothing here to judge. Assigning `null` is not the same thing as
     * leaving it on every engine, exactly as `documentLang` records for an
     * empty `lang`. */
    const answer = voiceFor(this.#synth.getVoices(), lang, prefs.voices ?? {})
    if (answer.kind === 'none') {
      this.#cb.onDone('no-voice')
      return false
    }

    const utterance = new SpeechSynthesisUtterance(text)
    /* Only when there is one. Assigning `''` is not a no-op on every engine —
     * see `documentLang` — and the platform's own default is the one the
     * reader chose in their system settings. */
    if (lang) utterance.lang = lang
    if (answer.kind === 'voice') utterance.voice = answer.voice

    /* The rate is a multiplier on the engine's default, so 1 IS the default and
     * assigning it changes nothing — which is why an absent preference and a
     * preference of 1 may safely take the same branch, and why the coalesce
     * below is not a speed Paper picked for anybody.
     *
     * ⚠️ **THE BOUNDS ARE THE SPEC'S, AND THIS ONLY CHECKED FOR POSITIVE.** Web
     * Speech defines the range as 0.1 to 10 and leaves anything outside it to
     * the engine — so a hand-edited `0.01` or `100` passed a guard whose comment
     * claimed it stopped unsafe values. Out of range is REFUSED rather than
     * clamped: a reader who typed 100 into a settings file gets the engine's own
     * speed, not a number Paper invented for them.
     *
     * ⚠️ **AND THE TWO CHECKS IN FRONT OF THE RANGE COULD NOT CHANGE ITS
     * ANSWER.** This read `prefs.rate !== undefined && Number.isFinite(prefs.rate)`
     * ahead of the bounds, and every comparison against `undefined` or `NaN` is
     * false while an infinity fails one bound — so both clauses were unobservable,
     * and a mutation of either failed no test by construction rather than by
     * accident. The absent case reaches the same assignment through `?? 1`, which
     * is what keeps the types honest without a clause no test can reach.
     * `speech.test.ts` holds both bounds at their exact values. */
    const rate = prefs.rate ?? 1
    if (rate >= MIN_ENGINE_RATE && rate <= MAX_ENGINE_RATE) {
      utterance.rate = rate
    }

    /* EVERY UTTERANCE, and this is the only place one is made: every road through
     * `useSpeech` — a start, the next sentence, a step, a section turn — comes
     * here with the preferences as they stand. An utterance's volume is fixed when
     * it starts, so a change lands at the next sentence. 1 is the spec's own
     * default, so assigning it changes nothing. */
    utterance.volume = prefs.volume ?? 1

    this.#sawBoundary = false

    utterance.addEventListener('boundary', (event) => {
      if (generation !== this.#generation) return
      const { charIndex, charLength, name } = event as SpeechSynthesisEvent & {
        charLength?: number
        name?: string
      }
      // Sentence boundaries arrive on the same event in some engines; the
      // highlight is per word, so the rest are ignored rather than flashing a
      // whole sentence.
      if (name && name !== 'word') return
      this.#sawBoundary = true
      /* THE ENGINE'S OWN LENGTH WHEN IT GIVES A USABLE ONE, the word's span in
         the text otherwise. This read `charLength && charLength > 0`, whose
         first half could not change the answer — 0 and absence both fail the
         second — so a mutation of it failed no test by construction. */
      const length = charLength ?? 0
      this.#cb.onWord(charIndex, length > 0 ? length : wordLengthAt(text, charIndex))
    })

    /* Both guarded by generation. `cancel()` does not suppress the cancelled
     * utterance's end — it merely makes it late — so an unguarded handler
     * reports the OLD utterance finishing while the new one is speaking. */
    utterance.addEventListener('end', () => this.#finish(generation, 'ended'))
    // An error is still an end as far as the caller is concerned: the controls
    // must come back rather than staying stuck on "speaking". It is named as
    // one, though, so the caller does not read it as a section finished and
    // go on to the next.
    utterance.addEventListener('error', () => this.#finish(generation, 'error'))

    /* The grace period starts when the voice does, not when the utterance is
     * queued. A cold voice can take seconds to begin — a downloadable macOS
     * voice is fetched on first use — and a timer started at queue time spends
     * that wait counting down, then concludes from the silence that this engine
     * does not report boundaries and drops the follow-along for the whole
     * chapter. `start` is also the safety net for an engine that never begins:
     * no start, no timer, and the highlight simply never appears rather than
     * being actively disabled. */
    utterance.addEventListener('start', () => {
      if (generation !== this.#generation) return
      this.#armGrace()
    })

    this.#synth.speak(utterance)
    return true
  }

  pause(): void {
    /* ⚠️ **ONLY WHILE THIS SPEAKER HOLDS THE ENGINE — `stop()`'s rule, which
     * these two did not follow.** `pause` and `resume` act on the one shared
     * engine, so without this a speaker pauses or releases an utterance that is
     * not its own: the lookup's pronunciation could hold the reading, and the
     * reading could release a pronunciation mid-word. The argument is the same
     * one written out at length in `stop()` and it applies to all three. */
    if (engineHeldBy.get(this.#synth) !== this.#token) return
    if (this.#synth.speaking && !this.#synth.paused) {
      /* The grace timer measures SPEECH, not wall-clock. Left running, a pause
       * inside the first 2.5 s ran it out over silence and `onNoBoundaries`
       * dropped the follow-along for the whole reading on an engine that
       * reports boundaries perfectly well (audit round 1, #502). Cleared here
       * and re-armed whole on resume — generous twice is still cheap, and a
       * false negative costs the highlight for the chapter. */
      this.#clearGrace()
      this.#synth.pause()
    }
  }

  resume(): void {
    if (engineHeldBy.get(this.#synth) !== this.#token) return
    if (!this.#synth.paused) return
    this.#synth.resume()
    /* RE-ARMED WHOLE, AND WITHOUT ASKING FIRST WHETHER A BOUNDARY HAS ALREADY
       ARRIVED. This read `if (!this.#sawBoundary)`, which was unobservable: the
       timer asks the same question when it fires, and the flag can only be
       cleared by `speak`, which retires the generation a pending timer holds. So
       the early exit saved a timer that could never report anything, and no test
       could tell it apart from arming one. One question, asked where the answer
       is used. */
    this.#armGrace()
  }

  stop(): void {
    this.#clearGrace()
    /* A reading ended, so the next one measures the engine afresh — see
       `#reportedNoBoundaries`. */
    this.#reportedNoBoundaries = false
    // Retires the current generation, so the cancelled utterance's late end
    // cannot report itself as the current one finishing.
    this.#generation += 1
    /* ⚠️ **ONLY WHILE THIS SPEAKER HOLDS THE ENGINE, AND IT USED TO BE
     * UNCONDITIONAL** — "cancel() on an idle synth is harmless", which is true
     * of an idle one and false of an engine somebody else is using. With two
     * speakers over one engine (see `engineHeldBy`) an unconditional cancel is a
     * speaker silencing an utterance that is not its own: the lookup popup calls
     * `Voice.stop` on EVERY selection change, so a reader listening to the book
     * who merely opened and dismissed a lookup had the reading cancelled — and
     * the engine still held by the READING, so its `end` came back as `ended`
     * and the pages walked on into the next section.
     *
     * Not holding it means this speaker's own utterance is already gone, so
     * there is nothing of its own left to cancel. `speak` claims the engine
     * BEFORE calling this, which is what keeps a new utterance replacing the old
     * one — including one this speaker queued for a previous section. */
    if (engineHeldBy.get(this.#synth) !== this.#token) return
    this.#synth.cancel()
    /**
     * ⚠️ **`cancel()` IS NOT A RESET — IT EMPTIES THE QUEUE AND LEAVES THE PAUSE
     * FLAG SET.** `paused` belongs to the ENGINE, not to an utterance, so a
     * reading stopped while paused left the shared engine paused: the next
     * `speak` — this reader pressing Listen again, or the lookup's
     * pronunciation — was queued behind it and never spoken, with every control
     * reporting active playback over silence. `speechSynth.testkit.ts` models
     * the same thing, which is what made it provable without a browser.
     *
     * AFTER the cancel, never before: resuming first would let the paused
     * utterance speak the instant it was released.
     */
    if (this.#synth.paused) this.#synth.resume()
  }

  #finish(generation: number, reason: DoneReason): void {
    if (generation !== this.#generation) return
    /* RETIRED BEFORE THE CALLBACK. An utterance is one ending, but an engine
     * is free to send `error` AND `end` for it — WebKit does on some voices —
     * and both handlers held the same live generation, so `onDone` fired
     * twice and the second one cancelled the continuation the first had
     * started (audit round 1, #503). */
    this.#generation += 1
    this.#clearGrace()
    /* AND WHOSE ENGINE IT IS DECIDES WHAT THIS EVENT MEANT. Another speaker
       having taken it since is exactly what cancelled this utterance, so the
       `end` (or `error`) the engine delivered is not this utterance ending —
       see `engineHeldBy`, and `DoneReason.taken` for what each caller does
       with it. */
    this.#cb.onDone(engineHeldBy.get(this.#synth) === this.#token ? reason : 'taken')
  }

  #clearGrace(): void {
    /* UNCONDITIONAL: clearing no timer is a no-op by the spec, so a guard here
       could not change what happens and no test could tell it was there. */
    clearTimeout(this.#graceTimer ?? undefined)
    this.#graceTimer = null
  }

  /**
   * Start measuring whether this engine reports word boundaries.
   *
   * ⚠️ **ONE PLACE, BECAUSE TWO COPIES HAD ALREADY DRIFTED.** The `start` handler
   * cleared the old timer before arming a new one and `resume` did not, so the
   * two paths into the same measurement disagreed about whether a timer could
   * be doubled — the drift an audit predicted from the duplication, arriving
   * before anybody looked. Both call this now, and it clears first, every time.
   *
   * ⚠️ **AND THE TIMER NO LONGER ASKS WHICH READING IT BELONGS TO.** It used to
   * capture the generation and compare it on firing, and that comparison could
   * not come back false: a PENDING grace timer always belongs to the current
   * reading, because all three writes to `#generation` — `speak`, `stop` and
   * `#finish` — clear it within a line of the bump. Unreachable, so no test
   * could kill it, and no `disable` could cover it without hiding the reachable
   * half of the same line.
   *
   * The invariant it was guessing at is ASSERTED instead, once per path, in
   * `speech.test.ts` — the three cases around 'does not blame the current
   * utterance for a stale missing boundary'. A fourth bump that forgets the
   * clear fails there, loudly, rather than being absorbed here in silence.
   */
  #armGrace(): void {
    /* CLEARED FIRST, EVERY TIME — so the measurement runs from the most recent
       start rather than from the first one. An engine that says `start` twice
       for one utterance would otherwise have its grace expire 2.5 s after the
       first, over speech that had only just begun again. */
    this.#clearGrace()
    this.#graceTimer = setTimeout(() => {
      this.#graceTimer = null
      /* THE TWO WAYS THE ANSWER IS ALREADY IN: a boundary arrived, or this
         engine has been reported once already. Both were ARM-time guards as
         well, where neither could change anything — the arming paths are
         reached only with the flags in the state that arms. Asked once, where
         the answer is used. */
      if (this.#sawBoundary || this.#reportedNoBoundaries) return
      this.#reportedNoBoundaries = true
      this.#cb.onNoBoundaries()
    }, BOUNDARY_GRACE_MS)
  }
}

/**
 * The length of the word starting at `index`.
 *
 * WebKit reports `charLength` as 0 on some voices, and a zero-length highlight
 * is invisible — which looks exactly like boundaries not working at all.
 */
export function wordLengthAt(text: string, index: number): number {
  const match = /^\S+/.exec(text.slice(index))
  return match ? match[0].length : 1
}

/**
 * Whether this build has a speech engine at all — the READING's question.
 *
 * ⚠️ **THE API'S PRESENCE, AND IT IS WEAKER THAN IT LOOKS.** An engine can be
 * present with nothing behind it: WebKitGTK answers this with no
 * speech-dispatcher installed, which is the DEFAULT state on Linux, and then
 * accepts an utterance, raises no error and makes no sound. So a true here is
 * "there is an engine to ask", not "the reader will hear something".
 *
 * ⚠️ **AND THE LOOKUP'S PRONUNCIATION MUST NOT SHARE THIS ANSWER** — this
 * paragraph used to argue that it should, on the ground that one answer cannot
 * be right by accident. That is true and beside the point: the two callers are
 * asking different questions. Reading a chapter in whatever voice the machine
 * has is still reading the chapter; saying one WORD in a voice for the wrong
 * language is a wrong answer the reader cannot check. `Voice.canSay` is the
 * stricter question, and it reads the voice list — which this deliberately does
 * not, because `getVoices()` is empty until the engine has loaded it and an
 * emptiness test here would drop the Listen control for the first moments of
 * every session.
 */
export function speechAvailable(): boolean {
  if (typeof window === 'undefined') return false
  /* ⚠️ **A PROPERTY'S NAME IS NOT A WORKING ENGINE, AND THAT IS ALL THIS
   * CHECKED.** `'speechSynthesis' in window` is true of a webview that declares
   * the property and leaves it null, and of one with the engine but no
   * `SpeechSynthesisUtterance` to hand it — so the Listen control was drawn,
   * and the first press threw at construction or at `speak`, far from any
   * reason a reader could act on. The three things `Speaker` actually calls are
   * what is checked now: the utterance constructor, and `speak` and `cancel` on
   * a real engine. It still does NOT read the voice list, for the reason above. */
  const synth = (window as { speechSynthesis?: unknown }).speechSynthesis as
    | { speak?: unknown; cancel?: unknown }
    | null
    | undefined
  return (
    typeof (window as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance === 'function' &&
    typeof synth === 'object' &&
    synth !== null &&
    typeof synth.speak === 'function' &&
    typeof synth.cancel === 'function'
  )
}
