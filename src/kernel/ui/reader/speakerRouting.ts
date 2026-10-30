/**
 * One speaker to the reading, two underneath.
 *
 * A reader may have the English pack installed and open a French book. The
 * pack cannot read it and the platform might, so the choice is **per book**
 * rather than per session — which means neither speaker can be the one the
 * reading holds.
 *
 * ⚠️ **AND THE TWO NOW DIFFER IN THE UNIT THEY ARE GIVEN, WHICH IS PHASE 34.**
 * The engine speaker is handed a whole SECTION — one render, kept on disk, one
 * `words` array, seekable. The platform speaker is still handed one SENTENCE at
 * a time, because Web Speech cannot seek inside an utterance and a section-long
 * one would take `stepSentence`, `stepParagraph` and both gap settings with it.
 * `useSpeech` asks [`speakerFor`] which it is about to be, per section; that is
 * the same pure function this file already exported, so the unit and the routing
 * cannot disagree.
 *
 * ⚠️ **BOTH ARE STOPPED ON EVERY `speak`, NOT JUST THE ONE BEING REPLACED.**
 * The two engines are independent: Web Speech has its own queue and the engine
 * speaker its own render in flight, and stopping only the one about to be used
 * leaves the other still speaking the previous section. That is two voices at
 * once, which is the failure worth being blunt about — and it costs nothing,
 * since a stop on a speaker that is not speaking is a no-op on both.
 */

import type { VoicePack } from '../../core/ports'
import { engineVoiceFor } from './engineVoice'
import type { SpeakPrefs } from './speech'

/** What the reading needs of a speaker, whichever one it is. */
export interface SpeakerLike {
  speak(text: string, lang: string | null, prefs?: SpeakPrefs): boolean
  pause(): void
  resume(): void
  stop(): void
  /**
   * Where the reading has got to, and how long it is — `null` when nothing is
   * playing, and absent on a speaker that cannot say.
   *
   * ⚠️ **OPTIONAL BECAUSE WEB SPEECH GENUINELY CANNOT ANSWER IT**, which is a
   * different thing from the `AbortSignal` this repository records: that was a
   * capability declared and honoured by nobody, this is one the engine speaker
   * implements and the platform cannot. `speechSynthesis` reports no position in
   * an utterance and has no duration until it has finished speaking one.
   */
  at?(): { readonly positionMs: number; readonly durationMs: number } | null
  /** Go to a millisecond. Absent where the speaker cannot seek. */
  seekToMs?(ms: number): boolean
  /** Go to the word covering a character offset in the passage. */
  seekToOffset?(offset: number): boolean
  /** Go to a fraction of the way through — 0 the start, 1 the end. */
  seekToFraction?(fraction: number): boolean
  /**
   * Where the reading is in the passage's text, in characters.
   *
   * `null` where there is no reading, where the speaker cannot answer (Web
   * Speech), or where there are no word timings to answer with (a Chinese pack).
   * The caller leaves its cursor alone for all three, which is the same answer it
   * had before this existed.
   */
  spokenOffset?(): number | null
}

/** Where a passage in this language should be read. */
export function speakerFor(
  packs: readonly VoicePack[],
  lang: string | null,
  prefs: SpeakPrefs,
): 'engine' | 'platform' {
  /* `prefs.voices` straight through, with no `?? {}` in front of it:
     `engineVoiceFor` already takes an absent choice as none, and a stored
     choice it cannot match FALLS THROUGH to the first installed pack — so
     substituting an empty map here could never change the answer, only hide
     that it could not. */
  return engineVoiceFor(packs, lang, prefs.voices) ? 'engine' : 'platform'
}

/**
 * A speaker that routes each passage to whichever engine can read it.
 *
 * `packs` is a FUNCTION rather than a value: the catalogue changes while the
 * app runs — a reader downloads a pack mid-chapter — and a speaker built over
 * a snapshot would go on using the platform voice until the reading was
 * restarted.
 */
/**
 * A speaker that can answer all five of the seek members, not merely declare
 * them.
 *
 * ⚠️ **THE ROUTER ALWAYS DEFINES THEM, AND ITS TYPE USED TO SAY OTHERWISE —
 * FOUND BY THE MUTATION SWEEP.** `SpeakerLike` marks them optional because the
 * PLATFORM speaker genuinely has none: Web Speech reports no position in an
 * utterance. The router is not that speaker — it forwards each one, answering
 * `false` or `null` where the speaker currently reading cannot. Typed as merely
 * `SpeakerLike`, every caller wrote `speaker?.seekToFraction?.(…)`, and the
 * second chain could never come back undefined: ten unkillable mutants across
 * four call sites, all of them the type being vaguer than the value.
 */
export type SeekingSpeaker = SpeakerLike &
  Required<Pick<SpeakerLike, 'at' | 'seekToMs' | 'seekToOffset' | 'seekToFraction' | 'spokenOffset'>>

export function routedSpeaker(
  engine: SpeakerLike,
  platform: SpeakerLike,
  packs: () => readonly VoicePack[],
): SeekingSpeaker {
  /* Which one is reading now. Null between utterances, so a `pause` with
   * nothing speaking reaches neither rather than the last one used. */
  let current: SpeakerLike | null = null

  return {
    speak(text, lang, prefs = {}) {
      /* Both, always — see the header. */
      engine.stop()
      platform.stop()
      const target = speakerFor(packs(), lang, prefs) === 'engine' ? engine : platform
      current = target
      const began = target.speak(text, lang, prefs)
      /* A refusal is not a reading, so nothing is current after it. Left set,
       * a later `pause` would reach a speaker that had reported `no-voice`. */
      if (!began) current = null
      return began
    },
    pause() {
      current?.pause()
    },
    resume() {
      current?.resume()
    },
    stop() {
      current = null
      engine.stop()
      platform.stop()
    },
    /* ⚠️ **`prepare` HAS GONE FROM HERE, AND THE OWNER REFUSED ITS RETURN.** It
     * forwarded a look-ahead render to whichever speaker would take the next
     * passage. Phase 34 renders the whole section once and keeps it, and the
     * owner's decision on 2026-09-30 — with WI-34.0's numbers in hand — was the
     * whole section and NO look-ahead. What replaced it is below: the four
     * members a reading can only have once it is one buffer.
     *
     * ⚠️ **FORWARDED TO `current` AND NOT TO `engine`.** Between utterances
     * `current` is null and a seek reaches neither, which is right: there is
     * nothing to seek in. Asked of the platform speaker it answers `false`,
     * because the optional member is absent — `?? false` is what makes "cannot"
     * and "did not" one answer for a caller that only wants to know whether the
     * reading moved. */
    at() {
      return current?.at?.() ?? null
    },
    seekToMs(ms) {
      return current?.seekToMs?.(ms) ?? false
    },
    seekToOffset(offset) {
      return current?.seekToOffset?.(offset) ?? false
    },
    seekToFraction(fraction) {
      return current?.seekToFraction?.(fraction) ?? false
    },
    spokenOffset() {
      return current?.spokenOffset?.() ?? null
    },
  }
}
