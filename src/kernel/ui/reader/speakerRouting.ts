/**
 * One speaker to the reading, two underneath.
 *
 * A reader may have the English pack installed and open a French book. The
 * pack cannot read it and the platform might, so the choice is **per book**
 * rather than per session — which means neither speaker can be the one the
 * reading holds.
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
  /** Render the next passage ahead of time. Only the engine speaker has one. */
  prepare?(text: string, lang: string | null, prefs?: SpeakPrefs): void
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
export function routedSpeaker(
  engine: SpeakerLike,
  platform: SpeakerLike,
  packs: () => readonly VoicePack[],
): SpeakerLike {
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
    prepare(text, lang, prefs = {}) {
      /* Only where the next passage would go, and only where that speaker can
       * render ahead. Preparing on the platform speaker is meaningless — Web
       * Speech has nothing to prepare — and preparing on the engine for a
       * passage the platform will read is a render nobody will play. */
      if (speakerFor(packs(), lang, prefs) !== 'engine') return
      engine.prepare?.(text, lang, prefs)
    },
  }
}
