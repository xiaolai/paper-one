// @vitest-environment jsdom
/**
 * The promises a speaker makes, whichever engine is behind it.
 *
 * `useSpeech` drives `Speaker` over Web Speech or `EngineSpeaker` over a
 * downloaded pack, and is not told which. That only holds if both keep the
 * same promises, and a promise stated in one suite and not the other is a
 * promise the hook cannot rely on — which is how a reading ends up turning two
 * pages on one engine and none on the other.
 *
 * ⚠️ **THIS IS A CONTRACT SUITE, NOT A SECOND COPY OF EITHER SUITE.** Each
 * speaker keeps its own cases for what is peculiar to it — the platform's late
 * `end` after `cancel`, the engine's render landing after the reader moved on.
 * What is here is only what BOTH must do, driven through the public four
 * methods and the three callbacks and nothing else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineSpeaker } from './engineSpeaker'
import { FakeAudioHost, pcmOf } from './enginePlayer.testkit'
import { FakeSynth, FakeUtterance } from './speechSynth.testkit'
import { Speaker, type SpeakPrefs, type SpeakerCallbacks } from './speech'
import type { SpokenAudio } from '../../core/ports'

const RATE = 24_000

/** A voice good enough for the floor to admit, so `no-voice` is not the answer. */
const GOOD_VOICE = {
  name: 'Nicky',
  lang: 'en-US',
  voiceURI: 'com.apple.voice.enhanced.en-US.Nicky',
  default: false,
  localService: true,
}

interface Harness {
  readonly name: string
  /** Build a speaker whose callbacks the test can read. */
  make(): {
    speaker: {
      speak(text: string, lang: string | null, prefs?: SpeakPrefs): boolean
      pause(): void
      resume(): void
      stop(): void
    }
    onWord: ReturnType<typeof vi.fn>
    onDone: ReturnType<typeof vi.fn>
    onNoBoundaries: ReturnType<typeof vi.fn>
    /** Let whatever the speaker is waiting on settle. */
    settle(): Promise<void>
    /** Make the current utterance end on its own. */
    endNaturally(): void
    /** A language nothing can read, so `no-voice` is the answer. */
    readonly unreadable: string
  }
}

const platform: Harness = {
  name: 'Speaker, over Web Speech',
  make() {
    const synth = new FakeSynth()
    synth.voices = [GOOD_VOICE] as never
    const cb: SpeakerCallbacks = { onWord: vi.fn(), onDone: vi.fn(), onNoBoundaries: vi.fn() }
    const speaker = new Speaker(cb, synth as unknown as SpeechSynthesis)
    return {
      speaker,
      onWord: cb.onWord as ReturnType<typeof vi.fn>,
      onDone: cb.onDone as ReturnType<typeof vi.fn>,
      onNoBoundaries: cb.onNoBoundaries as ReturnType<typeof vi.fn>,
      settle: async () => {
        await vi.advanceTimersByTimeAsync(0)
      },
      endNaturally: () => {
        synth.speaking = false
        synth.queued.at(-1)?.dispatchEvent(new Event('end'))
      },
      /* Icelandic: the fake offers one English voice, so nothing can read it. */
      unreadable: 'is-IS',
    }
  },
}

const engine: Harness = {
  name: 'EngineSpeaker, over a downloaded pack',
  make() {
    const host = new FakeAudioHost()
    const cb: SpeakerCallbacks = { onWord: vi.fn(), onDone: vi.fn(), onNoBoundaries: vi.fn() }
    const answer: SpokenAudio = { pcm: pcmOf(RATE), sampleRate: RATE, words: [], skipped: [] }
    const speaker = new EngineSpeaker(cb, {
      render: async () => answer,
      host: () => host,
      choose: (lang) => (lang === 'is-IS' ? null : { packId: 'english-kokoro', voiceId: 'af_heart' }),
    })
    return {
      speaker,
      onWord: cb.onWord as ReturnType<typeof vi.fn>,
      onDone: cb.onDone as ReturnType<typeof vi.fn>,
      onNoBoundaries: cb.onNoBoundaries as ReturnType<typeof vi.fn>,
      settle: async () => {
        await vi.advanceTimersByTimeAsync(0)
      },
      endNaturally: () => {
        host.sources.at(-1)?.onended?.()
      },
      unreadable: 'is-IS',
    }
  },
}

/* `Speaker` constructs the platform's own utterance type, so the global has to
 * be there. Restored afterwards rather than left, because another suite in this
 * file's project may be relying on its absence. */
const original = globalThis.SpeechSynthesisUtterance

beforeEach(() => {
  vi.useFakeTimers()
  globalThis.SpeechSynthesisUtterance = FakeUtterance as unknown as typeof SpeechSynthesisUtterance
})

afterEach(() => {
  vi.useRealTimers()
  globalThis.SpeechSynthesisUtterance = original
})

describe.each([platform, engine])('$name', (harness) => {
  it('refuses empty text synchronously, and says so before returning', () => {
    const { speaker, onDone } = harness.make()
    expect(speaker.speak('   \n ', 'en')).toBe(false)
    /* SYNCHRONOUSLY, because the caller's next line reads the result: a
     * reading told later would light the Listen control and then drop it. */
    expect(onDone).toHaveBeenCalledWith('empty')
  })

  it('refuses a language it has no voice for, and says no-voice', () => {
    const { speaker, onDone, unreadable } = harness.make()
    expect(speaker.speak('some words', unreadable)).toBe(false)
    expect(onDone).toHaveBeenCalledWith('no-voice')
  })

  it('answers true when a reading has begun', async () => {
    const { speaker, onDone, settle } = harness.make()
    expect(speaker.speak('some words', 'en')).toBe(true)
    await settle()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('reports exactly one ending for one utterance', async () => {
    const { speaker, onDone, settle, endNaturally } = harness.make()
    speaker.speak('some words', 'en')
    await settle()
    endNaturally()
    await settle()
    endNaturally()
    await settle()
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith('ended')
  })

  it('reports nothing for a stop, because the caller already knows', async () => {
    const { speaker, onDone, settle } = harness.make()
    speaker.speak('some words', 'en')
    await settle()
    speaker.stop()
    await settle()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('does not report an ending that belongs to a replaced utterance', async () => {
    /* ⚠️ THE DEFECT BOTH SPEAKERS ARE BUILT AROUND, arriving by different
     * routes: the platform delivers a cancelled utterance's `end` late, and
     * the engine's render lands after the reader has moved on. Read as an
     * ending, either one tells the reading a section finished that nobody
     * heard — which is pages turning while one word plays. */
    const { speaker, onDone, settle, endNaturally } = harness.make()
    speaker.speak('first', 'en')
    await settle()
    speaker.speak('second', 'en')
    await settle()
    endNaturally()
    await settle()
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('reports nothing at all once it has been stopped, however long after', async () => {
    const { speaker, onDone, settle, endNaturally } = harness.make()
    speaker.speak('some words', 'en')
    await settle()
    speaker.stop()
    endNaturally()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('takes a pause and a resume when nothing is speaking without failing', async () => {
    const { speaker, onDone, settle } = harness.make()
    expect(() => {
      speaker.pause()
      speaker.resume()
      speaker.stop()
    }).not.toThrow()
    await settle()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('can be stopped twice', async () => {
    const { speaker, onDone, settle } = harness.make()
    speaker.speak('some words', 'en')
    await settle()
    speaker.stop()
    speaker.stop()
    await settle()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('reads again after a reading has ended', async () => {
    const { speaker, onDone, settle, endNaturally } = harness.make()
    speaker.speak('first', 'en')
    await settle()
    endNaturally()
    await settle()
    expect(speaker.speak('second', 'en')).toBe(true)
    await settle()
    endNaturally()
    await settle()
    expect(onDone).toHaveBeenCalledTimes(2)
    expect(onDone).toHaveBeenNthCalledWith(2, 'ended')
  })
})
