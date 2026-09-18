/**
 * A stand-in for the platform's speech synthesis.
 *
 * Enough of it to drive `Speaker`: utterances are EventTargets, and `cancel`
 * does what the real one does — it stops the audio but still delivers the
 * cancelled utterance's `end`, LATE. That late event is the whole reason the
 * generation counter exists, and it cannot be reproduced any other way.
 *
 * Shared between the `Speaker` suite and the hook's, because the hook is
 * mounted over `window.speechSynthesis` and the two fakes had begun to differ
 * on what `cancel` does — which is the one behaviour both suites turn on.
 */
export class FakeUtterance extends EventTarget {
  /** Unset until a caller sets it, exactly as on the platform object — so
   *  `declare`, not a field: a field is an own property holding `undefined`,
   *  and "the property is absent" is what one of the tests asserts. */
  declare lang?: string

  constructor(readonly text: string) {
    super()
  }
}

/**
 * ⚠️ **AN `EventTarget`, BECAUSE THE ENGINE IS ONE.** `voiceschanged` is how a
 * real engine says its voice list has arrived, and `Voice.canSay` subscribes to
 * it so a control drawn against an empty list corrects itself rather than
 * staying wrong for the session. A plain object cannot be told that happened,
 * and a fake that cannot reproduce the event is a fake the case cannot use.
 */
export class FakeSynth extends EventTarget {
  readonly queued: FakeUtterance[] = []
  speaking = false
  paused = false
  cancelled = 0
  /**
   * What `getVoices()` answers — EMPTY BY DEFAULT, which is what a real engine
   * answers before its list has loaded, and the case `canSay` treats as
   * unknown. A case that wants a known list assigns one.
   */
  voices: { lang: string }[] = []

  getVoices(): { lang: string }[] {
    return this.voices
  }

  speak(utterance: FakeUtterance): void {
    this.queued.push(utterance)
    this.speaking = true
  }

  cancel(): void {
    this.cancelled += 1
    this.speaking = false
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }
}
