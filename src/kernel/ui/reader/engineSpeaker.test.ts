import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EngineSpeaker,
  MAX_DEADLINE_MS,
  RENDER_FLOOR_MS,
  RENDER_PER_CHAR_MS,
  deadlineFor,
  firstWordFrom,
  wordAtOffset,
} from './engineSpeaker'
import { FakeAudioHost, pcmOf } from './enginePlayer.testkit'
import type { ClipKey, SpeechRequest, SpokenAudio } from '../../core/ports'
import type { SpeakerCallbacks } from './speech'

const RATE = 24_000

/** The section a test is reading, unless it says otherwise. */
const CLIP: ClipKey = { bookId: 'book:a', section: 3, textDigest: 'fnv1a64:5:0000000000000001' }

function audio(over: Partial<SpokenAudio> = {}): SpokenAudio {
  return {
    pcm: pcmOf(RATE),
    sampleRate: RATE,
    words: [],
    skipped: [],
    evicted: { clips: 0, bytes: 0 },
    clipPath: '/tmp/audio/clips/book_a-3-0.wav',
    ...over,
  }
}

function callbacks(): SpeakerCallbacks & { onWord: ReturnType<typeof vi.fn> } {
  return { onWord: vi.fn(), onDone: vi.fn(), onNoBoundaries: vi.fn() } as never
}

/** A speaker over a render the test controls. */
function speakerOver(
  render: (text: string) => Promise<SpokenAudio>,
  host = new FakeAudioHost(),
  clip: ClipKey = CLIP,
) {
  const cb = callbacks()
  const asked: ClipKey[] = []
  /** Every request the engine was handed, whole — see the rate cases. */
  const requests: SpeechRequest[] = []
  const speaker = new EngineSpeaker(cb, {
    render: (request) => {
      asked.push(request.clip)
      requests.push(request)
      return render(request.text)
    },
    host: () => host,
    choose: (lang) => (lang === 'xx' ? null : { packId: 'english-kokoro', voiceId: 'af_heart' }),
    clip: () => clip,
  })
  return { speaker, cb, host, asked, requests }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('what it answers before anything is rendered', () => {
  it('refuses empty text synchronously, as the platform speaker does', async () => {
    const { speaker, cb } = speakerOver(async () => audio())
    expect(speaker.speak('   ', 'en')).toBe(false)
    expect(cb.onDone).toHaveBeenCalledWith('empty')
  })

  it('refuses a language no pack can read, and says no-voice', async () => {
    // The same answer the floor gives for a platform voice below it: no voice
    // rather than a bad one. Here it means no pack is installed.
    const { speaker, cb } = speakerOver(async () => audio())
    expect(speaker.speak('hello', 'xx')).toBe(false)
    expect(cb.onDone).toHaveBeenCalledWith('no-voice')
  })

  it('answers true once a render has been asked for', async () => {
    const { speaker, cb } = speakerOver(async () => audio())
    expect(speaker.speak('hello', 'en')).toBe(true)
    expect(cb.onDone).not.toHaveBeenCalled()
  })
})

describe('a render that lands after the reader has moved on', () => {
  it('is not played, and reports nothing', async () => {
    // ⚠️ THE CASE THIS CLASS EXISTS TO GET RIGHT. A render takes seconds; a
    // reader who stops in that window would otherwise hear the old sentence
    // start after they stopped it.
    let settle: (value: SpokenAudio) => void = () => {}
    const { speaker, cb, host } = speakerOver(
      () => new Promise<SpokenAudio>((resolve) => { settle = resolve }),
    )
    speaker.speak('first', 'en')
    speaker.stop()
    settle(audio())
    await vi.advanceTimersByTimeAsync(0)
    expect(host.sources).toHaveLength(0)
    expect(cb.onDone).not.toHaveBeenCalled()
  })

  it('does not play over the sentence that replaced it', async () => {
    const settles: ((value: SpokenAudio) => void)[] = []
    const { speaker, host } = speakerOver(
      () => new Promise<SpokenAudio>((resolve) => settles.push(resolve)),
    )
    speaker.speak('first', 'en')
    speaker.speak('second', 'en')
    // The first render answers last, which is the ordering that breaks this.
    settles[1]?.(audio())
    await vi.advanceTimersByTimeAsync(0)
    settles[0]?.(audio())
    await vi.advanceTimersByTimeAsync(0)
    expect(host.sources).toHaveLength(1)
  })

  it('reports an ending for the sentence that is current and no other', async () => {
    const { speaker, cb, host } = speakerOver(async () => audio())
    speaker.speak('first', 'en')
    await vi.advanceTimersByTimeAsync(0)
    speaker.speak('second', 'en')
    await vi.advanceTimersByTimeAsync(0)
    // The FIRST sound ends late, after its utterance was replaced.
    host.sources[0]?.onended?.()
    expect(cb.onDone).not.toHaveBeenCalled()
    host.sources[1]?.onended?.()
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onDone).toHaveBeenCalledWith('ended')
  })
})

describe('when a render fails', () => {
  it('reports an error rather than leaving the control lit', async () => {
    const { speaker, cb } = speakerOver(async () => {
      throw new Error('the voice could not say it')
    })
    speaker.speak('hello', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onDone).toHaveBeenCalledWith('error')
  })

  it('gives up on a render that never answers', async () => {
    const { speaker, cb } = speakerOver(() => new Promise<SpokenAudio>(() => {}))
    speaker.speak('hello', 'en')
    await vi.advanceTimersByTimeAsync(deadlineFor('hello') + 10)
    expect(cb.onDone).toHaveBeenCalledWith('error')
  })

  it('refuses silence of exactly the right length', async () => {
    // Everything about this render is correct except that there is nothing in
    // it. Playing it would report a sentence read that nobody heard.
    const { speaker, cb, host } = speakerOver(async () => audio({ pcm: new Uint8Array(RATE * 2) }))
    speaker.speak('hello', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(host.sources).toHaveLength(0)
    expect(cb.onDone).toHaveBeenCalledWith('error')
  })

  it('reports an error where there is nowhere to play', async () => {
    const cb = callbacks()
    const speaker = new EngineSpeaker(cb, {
      render: async () => audio(),
      host: () => null,
      choose: () => ({ packId: 'p', voiceId: 'v' }),
      clip: () => CLIP,
    })
    speaker.speak('hello', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onDone).toHaveBeenCalledWith('error')
  })
})

describe('following the words', () => {
  it('fires each word when the engine said it is spoken', async () => {
    const words = [
      { start: 0, length: 5, startMs: 100, endMs: 400 },
      { start: 6, length: 5, startMs: 500, endMs: 900 },
    ]
    const { speaker, cb } = speakerOver(async () => audio({ words }))
    speaker.speak('hello world', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onWord).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(cb.onWord).toHaveBeenCalledWith(0, 5)
    await vi.advanceTimersByTimeAsync(400)
    expect(cb.onWord).toHaveBeenCalledWith(6, 5)
  })

  it('stops firing words once the reader has stopped', async () => {
    const words = [{ start: 0, length: 5, startMs: 500, endMs: 900 }]
    const { speaker, cb } = speakerOver(async () => audio({ words }))
    speaker.speak('hello', 'en')
    await vi.advanceTimersByTimeAsync(0)
    speaker.stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(cb.onWord).not.toHaveBeenCalled()
  })

  it('reports no boundaries, and draws nothing, for an engine that reports no words', async () => {
    /* ⚠️ **THIS CASE PINNED THE DEFECT AND CALLED IT THE FEATURE.** It used to
       assert BOTH `onWord(0, text.length)` and `onNoBoundaries()` — under a
       comment saying the sentence is highlighted whole — and read through the
       integration that is the opposite of what happened: `useSpeech`'s
       `onNoBoundaries` removes the spoken-word band and sets `followsWords`
       false, so the band was drawn and wiped in the same tick and every later
       one was ignored. A unit test green over two callbacks nobody had traced
       together is how that survived. */
    const { speaker, cb } = speakerOver(async () => audio({ words: [] }))
    speaker.speak('a whole sentence', 'zh')
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onNoBoundaries).toHaveBeenCalledTimes(1)
    expect(cb.onWord, 'a band that is about to be revoked must not be drawn').not.toHaveBeenCalled()
  })

  it('says it has no boundaries once per READING, and again for the next one', async () => {
    /* ⚠️ **THIS CASE USED TO ASSERT ONCE PER SPEAKER, AND THAT WAS RIGHT WHEN AN
     * UTTERANCE WAS A SENTENCE.** Its old title — *"not once a sentence"* — says
     * so: a section of two hundred sentences would have reported two hundred
     * times, which is noise. Phase 34 hands the engine a whole SECTION, so once
     * per reading IS once per chapter.
     *
     * And once per speaker is now wrong, which an independent audit found on
     * 2026-09-30: `useSpeech.start()` sets `followsWords` back to true for every
     * new reading, so a second Chinese chapter reported nothing and the hook went
     * on publishing `followsWords: true` over a reading that has no words at all.
     * `stop()` resets the flag. */
    const { speaker, cb } = speakerOver(async () => audio({ words: [] }))
    speaker.speak('one', 'zh')
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onNoBoundaries).toHaveBeenCalledTimes(1)
    speaker.speak('two', 'zh')
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onNoBoundaries, 'the next reading is told too').toHaveBeenCalledTimes(2)
  })

  it('still says it only once WITHIN one reading', async () => {
    /* The half of the old case that survives: a render that lands during a pause
       reports it, and `resume` must not report it again. */
    const { speaker, cb } = speakerOver(async () => audio({ words: [] }))
    speaker.speak('one', 'zh')
    speaker.pause()
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onNoBoundaries).toHaveBeenCalledTimes(1)
    speaker.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onNoBoundaries).toHaveBeenCalledTimes(1)
  })
})

describe('pausing and resuming', () => {
  it('drives the sound that is playing', async () => {
    const { speaker, host } = speakerOver(async () => audio())
    speaker.speak('hello', 'en')
    await vi.advanceTimersByTimeAsync(0)
    host.advance(200)
    speaker.pause()
    expect(host.sources[0]?.stops).toBe(1)
    speaker.resume()
    expect(host.sources).toHaveLength(2)
  })

  it('does nothing before a render has landed, rather than failing', async () => {
    const { speaker } = speakerOver(() => new Promise<SpokenAudio>(() => {}))
    speaker.speak('hello', 'en')
    expect(() => {
      speaker.pause()
      speaker.resume()
    }).not.toThrow()
  })

  it('holds a render that lands while paused, instead of speaking over the reader', async () => {
    /* ⚠️ **THE DEFECT: `pause()` WAS `this.#playing?.pause()`, AND A RENDER IS
       NOT A PLAYER.** Between `speak` and the first sample there is no player
       at all — 450 ms for English, about five seconds for Chinese, longer on
       the sentence that loads the model — so a reader who pressed Pause in that
       window was not heard, the render landed, and the voice began speaking
       while the control said paused. */
    let land: (audio: SpokenAudio) => void = () => {}
    const { speaker, host } = speakerOver(() => new Promise<SpokenAudio>((resolve) => { land = resolve }))
    speaker.speak('hello', 'en')
    speaker.pause()
    land(audio())
    await vi.advanceTimersByTimeAsync(0)
    expect(host.sources[0]?.stops, 'the render is held at its first sample').toBe(1)
    speaker.resume()
    expect(host.sources, 'and speaks only once the reader says so').toHaveLength(2)
  })

  it('stops the word timers while paused, and rebuilds them from where the sound is', async () => {
    /* ⚠️ The timers were scheduled once, at `startMs` from the moment the audio
       began, so a pause stopped the SOUND and left the highlight walking
       through the sentence — and off the page, which turns it. */
    const words = [
      { start: 0, length: 5, startMs: 100, endMs: 200 },
      { start: 6, length: 5, startMs: 400, endMs: 500 },
    ]
    const { speaker, cb, host } = speakerOver(async () => audio({ words }))
    speaker.speak('hello world', 'en')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(150)
    host.advance(150)
    expect(cb.onWord).toHaveBeenCalledTimes(1)
    speaker.pause()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(cb.onWord, 'no word may be reported while the sound is stopped').toHaveBeenCalledTimes(1)
    speaker.resume()
    await vi.advanceTimersByTimeAsync(249)
    expect(cb.onWord, 'the remaining word lands where the audio does').toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(cb.onWord).toHaveBeenCalledTimes(2)
  })

  it('reports no word twice when a pause and resume straddle it', async () => {
    // A word already spoken is not respoken on resume: the rebuild skips
    // everything at or before the player's position.
    const words = [{ start: 0, length: 5, startMs: 100, endMs: 200 }]
    const { speaker, cb, host } = speakerOver(async () => audio({ words }))
    speaker.speak('hello', 'en')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(150)
    host.advance(150)
    speaker.pause()
    speaker.resume()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(cb.onWord).toHaveBeenCalledTimes(1)
  })

  it('forgets it was paused when the reading is stopped', async () => {
    // Otherwise the next `speak` would render, land, and hold at its first
    // sample for a pause the reader had already ended.
    const { speaker, host } = speakerOver(async () => audio())
    speaker.speak('hello', 'en')
    await vi.advanceTimersByTimeAsync(0)
    speaker.pause()
    speaker.stop()
    speaker.speak('again', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(host.sources.at(-1)?.stops, 'the new reading is not held').toBe(0)
  })

  it('ignores a resume nobody paused', async () => {
    const { speaker, host } = speakerOver(async () => audio())
    speaker.speak('hello', 'en')
    await vi.advanceTimersByTimeAsync(0)
    speaker.resume()
    expect(host.sources, 'no second source is begun').toHaveLength(1)
  })
})

describe('when the host refuses to play', () => {
  it('reports an error rather than leaving an unhandled rejection', async () => {
    /* ⚠️ **A HANDLER PASSED TO `then` DOES NOT CATCH THE OTHER HANDLER'S
       THROW.** `#play` builds a buffer and a source node; a host that refuses
       either throws inside the fulfilled branch, where the rejection handler
       beside it cannot see it. The reading then sat lit for ever, with an
       unhandled rejection in the console and no `onDone` anywhere. */
    const host = new FakeAudioHost()
    host.createBufferSource = () => {
      throw new Error('this host has no sources left')
    }
    const { speaker, cb } = speakerOver(async () => audio(), host)
    expect(speaker.speak('hello', 'en')).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onDone).toHaveBeenCalledWith('error')
  })
})

describe('the states one reading leaves the next', () => {
  /* Neither word begins at zero: a timer of zero milliseconds fires on the
     first turn of the loop, which hides the difference between a word that was
     scheduled and one that was reported before anything could pause it. */
  const WORDS = [
    { start: 0, length: 5, startMs: 100, endMs: 300 },
    { start: 6, length: 3, startMs: 400, endMs: 800 },
  ]

  it('begins unpaused, and a reading that ended leaves the next one unpaused too', async () => {
    /* ⚠️ A speaker born paused, or left paused by the reading before, holds
       every later render at its first sample: the control says it is reading
       and no sound ever comes. */
    const { speaker, cb, host } = speakerOver(async () => audio({ words: WORDS }))
    speaker.speak('first one', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(host.sources, 'it played at once').toHaveLength(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(cb.onWord).toHaveBeenCalledTimes(2)
    host.latest.end()
    expect(cb.onDone).toHaveBeenCalledWith('ended')

    speaker.speak('second one', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(host.sources, 'and so did the next').toHaveLength(2)
    await vi.advanceTimersByTimeAsync(500)
    expect(cb.onWord).toHaveBeenCalledTimes(4)
  })

  it('stops the reading it is replacing, rather than speaking over it', async () => {
    const { speaker, host } = speakerOver(async () => audio({ words: WORDS }))
    speaker.speak('first one', 'en')
    await vi.advanceTimersByTimeAsync(0)
    const first = host.latest
    speaker.speak('second one', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(first.stops, 'the first source was taken down').toBe(1)
    expect(host.sources).toHaveLength(2)
  })

  it('reports each word once, whatever order the transport is asked in', async () => {
    /* A `resume` with nothing paused used to rebuild the word timers beside
       the ones already running, so every remaining word was reported twice —
       and the reading's own highlight jumped back and forth. */
    const { speaker, cb } = speakerOver(async () => audio({ words: WORDS }))
    speaker.speak('first one', 'en')
    await vi.advanceTimersByTimeAsync(0)
    speaker.resume()
    speaker.resume()
    await vi.advanceTimersByTimeAsync(500)
    expect(cb.onWord).toHaveBeenCalledTimes(2)
  })

  it('resumes once, however many times it is asked', async () => {
    const { speaker, cb } = speakerOver(async () => audio({ words: WORDS }))
    speaker.speak('first one', 'en')
    await vi.advanceTimersByTimeAsync(0)
    speaker.pause()
    speaker.resume()
    speaker.resume()
    await vi.advanceTimersByTimeAsync(500)
    expect(cb.onWord).toHaveBeenCalledTimes(2)
  })

  it('says nothing more once a reading has been stopped or paused', async () => {
    /* One case per road that clears the timers — `pause`, `stop` and an
       ending — because with no staleness check inside the timer itself, the
       clearing IS the invariant. A road that forgets one fails here. */
    for (const road of ['pause', 'stop'] as const) {
      const { speaker, cb } = speakerOver(async () => audio({ words: WORDS }))
      speaker.speak('first one', 'en')
      await vi.advanceTimersByTimeAsync(0)
      speaker[road]()
      await vi.advanceTimersByTimeAsync(2000)
      expect(cb.onWord, road).not.toHaveBeenCalled()
    }
    const { speaker, cb, host } = speakerOver(async () => audio({ words: WORDS }))
    speaker.speak('first one', 'en')
    await vi.advanceTimersByTimeAsync(0)
    host.latest.end()
    await vi.advanceTimersByTimeAsync(2000)
    expect(cb.onWord, 'an ending').not.toHaveBeenCalled()
  })

  it('leaves no render deadline behind once the render has landed', async () => {
    /* The deadline is minutes to hours now. Left unclear, every section a reader
       listens to leaves one pending until long after the book is over. */
    const { speaker } = speakerOver(async () => audio({ words: WORDS }))
    speaker.speak('first one', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount(), 'one timer per word, and nothing else').toBe(WORDS.length)
  })

  it('says what went wrong with a render, rather than only that something did', async () => {
    /* `onDone('error')` is all the reading needs and all the reader gets, so
       the plugin's own words reached nobody at all — including the two-minute
       deadline's, which is the one failure nothing else explains. */
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { speaker, cb } = speakerOver(() => new Promise<SpokenAudio>(() => {}))
    speaker.speak('first one', 'en')
    /* THE PASSAGE'S OWN DEADLINE, not a constant: it scales with the text now —
       see `RENDER_PER_CHAR_MS`, which records what a flat two minutes cost. */
    await vi.advanceTimersByTimeAsync(deadlineFor('first one') + 10)
    expect(cb.onDone).toHaveBeenCalledWith('error')
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('could not be rendered'),
      expect.objectContaining({ message: 'the voice did not answer' }),
    )
    errors.mockRestore()
  })

  it('reports nothing for a render that failed after the reader moved on', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let refuse: (cause: unknown) => void = () => {}
    const { speaker, cb } = speakerOver(
      () =>
        new Promise<SpokenAudio>((_resolve, reject) => {
          refuse = reject
        }),
    )
    speaker.speak('first one', 'en')
    speaker.stop()
    refuse(new Error('the plugin refused'))
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onDone).not.toHaveBeenCalled()
    expect(errors, 'nor is it worth a line about a sentence nobody is waiting for').not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('refuses a render with nowhere to play it, and says so once, without calling it a failure', async () => {
    /* A build with no audio at all is not a render that went wrong, so there
       is nothing to write down about it — and reaching this through the
       failure road would put a line in the log of every such build, once a
       sentence. */
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cb = callbacks()
    const speaker = new EngineSpeaker(cb, {
      render: async () => audio({ words: WORDS }),
      host: () => null,
      choose: () => ({ packId: 'english-kokoro', voiceId: 'af_heart' }),
      clip: () => CLIP,
    })
    expect(speaker.speak('first one', 'en')).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onDone).toHaveBeenCalledWith('error')
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('reads a new sentence after a pause, rather than holding it at its first sample', async () => {
    /* ⚠️ The pause flag belongs to the READING, and a new one clears it. Left
       set, every later render is paused the moment it lands: the control says
       it is reading and no sound ever comes, which is exactly the defect the
       flag was added to fix, one reading later. */
    const { speaker, cb, host } = speakerOver(async () => audio({ words: WORDS }))
    speaker.speak('first one', 'en')
    await vi.advanceTimersByTimeAsync(0)
    speaker.pause()
    speaker.speak('second one', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(host.sources).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(500)
    expect(cb.onWord).toHaveBeenCalledTimes(2)
  })

  it('says an engine reports no words even when the reader paused before the render landed', async () => {
    /* Qwen answers no timings. Paused at its first sample, the reading would
       otherwise wait for a band that is never coming, with nothing saying so. */
    let settle: (value: SpokenAudio) => void = () => {}
    const { speaker, cb } = speakerOver(
      () =>
        new Promise<SpokenAudio>((resolve) => {
          settle = resolve
        }),
    )
    speaker.speak('first one', 'en')
    speaker.pause()
    settle(audio({ words: [] }))
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onNoBoundaries).toHaveBeenCalledTimes(1)
    expect(cb.onWord).not.toHaveBeenCalled()
  })

  it('does not say it where the engine DOES report words', async () => {
    let settle: (value: SpokenAudio) => void = () => {}
    const { speaker, cb } = speakerOver(
      () =>
        new Promise<SpokenAudio>((resolve) => {
          settle = resolve
        }),
    )
    speaker.speak('first one', 'en')
    speaker.pause()
    settle(audio({ words: WORDS }))
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onNoBoundaries).not.toHaveBeenCalled()
  })
})


describe('which section a render is for', () => {
  it('sends the clip key the deps answer, at speak time', async () => {
    /* ⚠️ THE KEY IS A DEP AND NOT AN ARGUMENT TO `speak`, because `SpeakerLike`
       is shared with the platform speaker, which has no use for one. Read at
       `speak` time so `useSpeech` can derive it from the same value the text
       comes from — held apart, the two could name different sections. */
    const { speaker, asked } = speakerOver(async () => audio())
    speaker.speak('hello', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(asked).toEqual([CLIP])
  })

  it('reads the dep again for every render rather than capturing it once', async () => {
    const holder = { clip: CLIP }
    const cb = callbacks()
    const asked: ClipKey[] = []
    const speaker = new EngineSpeaker(cb, {
      render: (request) => {
        asked.push(request.clip)
        return Promise.resolve(audio())
      },
      host: () => new FakeAudioHost(),
      choose: () => ({ packId: 'english-kokoro', voiceId: 'af_heart' }),
      clip: () => holder.clip,
    })
    speaker.speak('one', 'en')
    await vi.advanceTimersByTimeAsync(0)
    const second: ClipKey = { bookId: 'book:a', section: 4, textDigest: 'fnv1a64:3:0000000000000002' }
    holder.clip = second
    speaker.speak('two', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(asked).toEqual([CLIP, second])
  })
})

describe('where the reading has got to', () => {
  it('answers null before the render lands, and a position after it', async () => {
    /* ⚠️ NULL RATHER THAN ZEROS, and the reason is WI-34.0's measurement: a real
       section took 315 s to render, and a transport showing `0:00 / 0:00` for
       both "nothing yet" and "at the start" would be lying for five minutes. */
    let settle: (audio: SpokenAudio) => void = () => {}
    const { speaker } = speakerOver(() => new Promise((resolve) => (settle = resolve)))
    speaker.speak('hello', 'en')
    expect(speaker.at()).toBeNull()
    settle(audio())
    await vi.advanceTimersByTimeAsync(0)
    const where = speaker.at()
    expect(where).not.toBeNull()
    expect(where!.positionMs).toBe(0)
    expect(where!.durationMs).toBeCloseTo(1000, 0)
  })

  it('answers null again once the reading is stopped', async () => {
    const { speaker } = speakerOver(async () => audio())
    speaker.speak('hello', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(speaker.at()).not.toBeNull()
    speaker.stop()
    expect(speaker.at()).toBeNull()
  })
})

describe('seeking, which is what one buffer is for', () => {
  /* Four words over a second of audio, so every boundary is reachable and none
     of them is at zero — a timer of zero fires on the first turn of the loop,
     which hides a word that was scheduled from one already reported. */
  const WORDS = [
    { start: 0, length: 3, startMs: 100, endMs: 200 },
    { start: 4, length: 5, startMs: 300, endMs: 400 },
    { start: 10, length: 2, startMs: 500, endMs: 600 },
    { start: 13, length: 4, startMs: 700, endMs: 800 },
  ]

  async function reading() {
    const host = new FakeAudioHost()
    const { speaker, cb } = speakerOver(async () => audio({ words: WORDS }), host)
    speaker.speak('one three up four', 'en')
    await vi.advanceTimersByTimeAsync(0)
    return { speaker, cb, host }
  }

  it('answers false before there is anything to seek in', async () => {
    let settle: (audio: SpokenAudio) => void = () => {}
    const { speaker } = speakerOver(() => new Promise((resolve) => (settle = resolve)))
    speaker.speak('hello', 'en')
    expect(speaker.seekToMs(500)).toBe(false)
    expect(speaker.seekToOffset(4)).toBe(false)
    expect(speaker.seekToFraction(0.5)).toBe(false)
    settle(audio({ words: WORDS }))
    await vi.advanceTimersByTimeAsync(0)
    expect(speaker.seekToMs(500)).toBe(true)
  })

  it('begins a new source at the place asked for', async () => {
    const { speaker, host } = await reading()
    expect(host.sources).toHaveLength(1)
    speaker.seekToMs(500)
    expect(host.sources, 'a seek is a new source — a node cannot be moved').toHaveLength(2)
    expect(host.sources[1]!.started).toEqual([{ when: 0, offset: 0.5 }])
    expect(speaker.at()!.positionMs).toBeCloseTo(500, 0)
  })

  it('reports the words from the new place and not from the old one', async () => {
    const { speaker, cb } = await reading()
    /* Two words have been reported by 400 ms. */
    await vi.advanceTimersByTimeAsync(400)
    expect(cb.onWord.mock.calls).toEqual([
      [0, 3],
      [4, 5],
    ])
    cb.onWord.mockClear()
    speaker.seekToMs(600)
    /* The fourth word is the first one at or after 600 ms; the third started at
       500 and is behind us. */
    await vi.advanceTimersByTimeAsync(200)
    expect(cb.onWord.mock.calls).toEqual([[13, 4]])
  })

  it('does not re-report a word the seek landed exactly on', async () => {
    const { speaker, cb } = await reading()
    await vi.advanceTimersByTimeAsync(800)
    cb.onWord.mockClear()
    /* Back to exactly the third word's start: it IS the first word at or after
       500 ms, so it is reported — a reader who seeks to a word expects to hear
       it, which is not the same question as `said` counting what went before. */
    speaker.seekToMs(500)
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onWord.mock.calls).toEqual([[10, 2]])
  })

  it('highlights the word a seek lands INSIDE, rather than the one after it', async () => {
    /* ⚠️ **FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** `firstWordFrom` answers
       the first word starting AT OR AFTER the target, which is right when the
       target is a word's own start and wrong everywhere between two: the sound
       plays the word the reader landed inside while the band sits on the one
       before it, for as long as that word lasts.

       The scrubber is what makes this the ORDINARY case rather than an edge —
       1 000 steps over a forty-eight-minute section is a step of nearly three
       seconds, and a word is a fraction of that, so almost every drag lands
       mid-word.

       550 ms is inside the THIRD word (500–600). Before: the fourth was reported
       at 700 and the third never was, so the highlight stayed on the second for
       150 ms while the third was being spoken. */
    const { speaker, cb } = await reading()
    await vi.advanceTimersByTimeAsync(800)
    cb.onWord.mockClear()

    speaker.seekToMs(550)
    await vi.advanceTimersByTimeAsync(0)

    expect(cb.onWord.mock.calls, 'the word being spoken, at once').toEqual([[10, 2]])
    /* AND THE SCHEDULE AFTER IT IS UNTOUCHED: the fourth still arrives on its own
       time rather than being pulled forward or dropped. */
    cb.onWord.mockClear()
    await vi.advanceTimersByTimeAsync(200)
    expect(cb.onWord.mock.calls).toEqual([[13, 4]])
  })

  it('does not reach back to a word that has already ended', async () => {
    /* THE OTHER SIDE OF THE SAME BOUNDARY, and the reason the check is on `endMs`
       rather than simply backing up one: 650 ms is AFTER the third word ended and
       before the fourth began — silence between two words — so the word to draw is
       the one coming, not the one gone. */
    const { speaker, cb } = await reading()
    await vi.advanceTimersByTimeAsync(800)
    cb.onWord.mockClear()

    speaker.seekToMs(650)
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onWord.mock.calls, 'nothing yet — the next word has not started').toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(cb.onWord.mock.calls).toEqual([[13, 4]])
  })

  it('reports the first word for a seek inside it, not nothing', async () => {
    /* The first word has nothing before it, so the `words[after - 1]` lookup is
       `undefined` — which must read as *there is no covering word*, not as a
       reason to skip the bounds check. */
    const { speaker, cb } = await reading()
    await vi.advanceTimersByTimeAsync(800)
    cb.onWord.mockClear()

    speaker.seekToMs(150)
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onWord.mock.calls).toEqual([[0, 3]])
  })

  it('takes a character offset to the word that covers it', async () => {
    const { speaker, cb } = await reading()
    cb.onWord.mockClear()
    /* Offset 11 is inside `up`, which is word three. */
    expect(speaker.seekToOffset(11)).toBe(true)
    expect(speaker.at()!.positionMs).toBeCloseTo(500, 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onWord.mock.calls).toEqual([[10, 2]])
  })

  it('takes an offset in the whitespace to the word after it', async () => {
    // A reader who taps a gap most plausibly meant the word they are heading
    // towards, and answering `false` would make a tap near a space do nothing.
    const { speaker } = await reading()
    expect(speaker.seekToOffset(3)).toBe(true)
    expect(speaker.at()!.positionMs).toBeCloseTo(300, 0)
  })

  it('refuses an offset past every word rather than seeking to the end', async () => {
    const { speaker } = await reading()
    expect(speaker.seekToOffset(999)).toBe(false)
  })

  it('cannot seek by word where the engine reports none — the Chinese case', async () => {
    /* Qwen answers no word timings at all, so a Chinese reading is scrubbable and
       not seekable by word. Answering true and doing nothing would be worse. */
    const { speaker } = speakerOver(async () => audio({ words: [] }))
    speaker.speak('春天来了', 'zh')
    await vi.advanceTimersByTimeAsync(0)
    expect(speaker.seekToOffset(2)).toBe(false)
    expect(speaker.seekToFraction(0.5)).toBe(true)
    expect(speaker.at()!.positionMs).toBeCloseTo(500, 0)
  })

  it('clamps a fraction rather than refusing one', async () => {
    const { speaker } = await reading()
    expect(speaker.seekToFraction(-1)).toBe(true)
    expect(speaker.at()!.positionMs).toBe(0)
    expect(speaker.seekToFraction(2)).toBe(true)
    expect(speaker.at()!.positionMs).toBeCloseTo(1000, 0)
    expect(speaker.seekToFraction(Number.NaN)).toBe(true)
    expect(speaker.at()!.positionMs).toBe(0)
  })

  it('clamps a millisecond past the end to the end', async () => {
    const { speaker } = await reading()
    expect(speaker.seekToMs(99_999)).toBe(true)
    expect(speaker.at()!.positionMs).toBeCloseTo(1000, 0)
    expect(speaker.seekToMs(-5)).toBe(true)
    expect(speaker.at()!.positionMs).toBe(0)
  })

  it('seeking while paused moves the mark and starts no sound', async () => {
    const { speaker, host } = await reading()
    speaker.pause()
    const before = host.sources.length
    expect(speaker.seekToMs(600)).toBe(true)
    expect(host.sources, 'nothing begins under a reader who asked for silence').toHaveLength(before)
    expect(speaker.at()!.positionMs).toBeCloseTo(600, 0)
    speaker.resume()
    expect(host.sources).toHaveLength(before + 1)
    expect(host.latest.started).toEqual([{ when: 0, offset: 0.6 }])
  })

  it('a seek on a stopped reading does nothing and says so', async () => {
    const { speaker, host } = await reading()
    speaker.stop()
    const before = host.sources.length
    expect(speaker.seekToMs(500)).toBe(false)
    expect(host.sources).toHaveLength(before)
  })

  it('releases the old source, so two voices do not read at once', async () => {
    const { speaker, host } = await reading()
    speaker.seekToMs(500)
    const left = host.sources[0]!
    expect(left.stops, 'the source being left must be stopped').toBe(1)
    expect(left.disconnects, 'and disconnected, or it still reaches the output').toBe(1)
    expect(left.onended, 'and its handler cleared, or a late end reports an ending').toBeNull()
  })
})

describe('the two searches the seek is built on', () => {
  const WORDS = [
    { start: 0, length: 3, startMs: 100, endMs: 200 },
    { start: 4, length: 5, startMs: 300, endMs: 400 },
    { start: 10, length: 2, startMs: 500, endMs: 600 },
  ]

  it('counts the words entirely before a position', () => {
    expect(firstWordFrom(WORDS, 0)).toBe(0)
    expect(firstWordFrom(WORDS, 100)).toBe(0)
    expect(firstWordFrom(WORDS, 101)).toBe(1)
    expect(firstWordFrom(WORDS, 300)).toBe(1)
    expect(firstWordFrom(WORDS, 301)).toBe(2)
    expect(firstWordFrom(WORDS, 9999)).toBe(3)
    expect(firstWordFrom([], 500)).toBe(0)
  })

  it('finds the word covering an offset, and the one after a gap', () => {
    expect(wordAtOffset(WORDS, 0)).toBe(0)
    expect(wordAtOffset(WORDS, 2)).toBe(0)
    /* Offset 3 is the space after `one`: the word being headed towards. */
    expect(wordAtOffset(WORDS, 3)).toBe(1)
    expect(wordAtOffset(WORDS, 8)).toBe(1)
    expect(wordAtOffset(WORDS, 10)).toBe(2)
    expect(wordAtOffset(WORDS, 11)).toBe(2)
    expect(wordAtOffset(WORDS, 12)).toBeNull()
    expect(wordAtOffset(WORDS, -5)).toBe(0)
    expect(wordAtOffset(WORDS, Number.NaN)).toBeNull()
    expect(wordAtOffset([], 0)).toBeNull()
  })

  it('answers the same as a walk would, over a list too long to walk per frame', () => {
    /* ⚠️ A BINARY SEARCH, and WI-34.0 is what makes it sound: the words were
       measured monotonic on `startMs` AND on `endMs` over a real 48-minute
       section of 7 899 words. A binary search over an unordered array answers
       confidently and wrongly, so that measurement is the precondition. */
    const many = Array.from({ length: 5000 }, (_, i) => ({
      start: i * 6,
      length: 5,
      startMs: i * 400 + 100,
      endMs: i * 400 + 300,
    }))
    for (const ms of [0, 100, 101, 2_000_000, 400 * 2500 + 150]) {
      const walked = many.filter((w) => w.startMs < ms).length
      expect(firstWordFrom(many, ms)).toBe(walked)
    }
    for (const offset of [0, 5, 6, 29_999, 12_345]) {
      const walked = many.findIndex((w) => w.start + w.length > offset)
      expect(wordAtOffset(many, offset)).toBe(walked === -1 ? null : walked)
    }
  })
})

describe('how long a render is given', () => {
  it('scales with the passage, because a section is not a sentence', () => {
    /* ⚠️ **THE DEFECT THIS EXISTS FOR, MEASURED IN THE RUNNING APP ON
       2026-09-30.** A flat 120 s killed section 8 of a real book — 74.8 minutes of
       audio, about 7 minutes to render — with "the voice did not answer", while
       the render finished and 205 MB of correct audio sat in the store that
       nothing would play. The old bound was sized for a SENTENCE and its own
       comment said so. */
    expect(deadlineFor('')).toBe(RENDER_FLOOR_MS)
    expect(deadlineFor('hello')).toBe(RENDER_FLOOR_MS + 5 * RENDER_PER_CHAR_MS)
    /* The character-weighted median section of this shelf, WI-34.0's measurement:
       48 043 characters rendered in 5 min 15 s. The deadline is 48.2 minutes, a
       margin of about nine. */
    const weighted = deadlineFor('x'.repeat(48_043))
    expect(weighted).toBeGreaterThan(40 * 60 * 1000)
    expect(weighted / (315 * 1000)).toBeGreaterThan(5)
  })

  it('is capped at something a timer can actually express', () => {
    /* ⚠️ **`setTimeout` CLAMPS A DELAY PAST 2 147 483 647 ms TO ZERO**, so a
       deadline of 25 days fires IMMEDIATELY — which would refuse every render of
       a `MAX_SECTION_CHARS` passage on the first tick, the exact opposite of what
       a longer deadline is for. A single-file EPUB of a whole novel is one such
       section, and they exist. */
    const enormous = deadlineFor('x'.repeat(2_000_000))
    expect(enormous).toBe(MAX_DEADLINE_MS)
    expect(enormous).toBeLessThan(2_147_483_647)
    /* And just under the cap it still scales, or the cap would be the only value. */
    const under = deadlineFor('x'.repeat(1_000_000))
    expect(under).toBeLessThan(MAX_DEADLINE_MS)
    expect(under).toBeGreaterThan(RENDER_FLOOR_MS)
  })

  it('gives a long section longer than a short one, which is the whole point', async () => {
    /* Driven through the speaker rather than only asserted on the function: a
       passage past the OLD flat bound must not be refused at it. */
    const long = 'The quick brown fox jumps over the lazy dog. '.repeat(200)
    expect(long.length).toBeGreaterThan(8_000)
    const { speaker, cb } = speakerOver(() => new Promise(() => {}))
    speaker.speak(long, 'en')
    await vi.advanceTimersByTimeAsync(RENDER_FLOOR_MS + 10)
    expect(cb.onDone, 'the old flat deadline would have fired here').not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(deadlineFor(long))
    expect(cb.onDone).toHaveBeenCalledWith('error')
  })
})

describe('three defects an independent audit found', () => {
  const WORDS = [
    { start: 0, length: 3, startMs: 100, endMs: 200 },
    { start: 4, length: 5, startMs: 300, endMs: 400 },
    { start: 10, length: 2, startMs: 500, endMs: 600 },
  ]

  it('seeks to the word asked for, not past it when the clock ticks', async () => {
    /* ⚠️ **THE POSITION WAS SAMPLED AFTER RESTARTING THE SOURCE.** The context
       clock can advance between the two, so a seek to a word's EXACT start
       reported a position a millisecond past it, `firstWordFrom` counted that
       word as said, and the word the reader asked for was never highlighted.
       Reproduced here by advancing the fake clock inside `createBufferSource`,
       which is the moment between the restart and the sample. */
    const host = new FakeAudioHost()
    const { speaker, cb } = speakerOver(async () => audio({ words: WORDS }), host)
    speaker.speak('one three up', 'en')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(600)
    cb.onWord.mockClear()
    /* ⚠️ **THE CLOCK HAS TO TICK BETWEEN `begin()` AND THE SAMPLE**, which is
       exactly the window the defect lived in — advancing it inside
       `createBufferSource` is too early, because `begin` reads `currentTime`
       AFTER making the node. A getter that moves on every read is the window. */
    let now = host.currentTime
    Object.defineProperty(host, 'currentTime', {
      configurable: true,
      get: () => {
        const answer = now
        now += 0.003
        return answer
      },
    })
    speaker.seekToMs(300)
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onWord.mock.calls, 'the word at the exact target is reported').toEqual([[4, 5]])
  })

  it('does not schedule timers for a reading that resuming just ended', async () => {
    /* ⚠️ **`resume()` CAN CALL `onEnded` SYNCHRONOUSLY** when the paused position
       is past the buffer, which reaches `#ended` and `stop()` — and the schedule
       that followed armed timers for a reading that had just finished, so
       `onWord` fired after `onDone('ended')`. A seek makes that position
       reachable, so it is not theoretical. */
    const host = new FakeAudioHost()
    const { speaker, cb } = speakerOver(async () => audio({ words: WORDS }), host)
    speaker.speak('one three up', 'en')
    await vi.advanceTimersByTimeAsync(0)
    /* ⚠️ **THE CONTEXT CLOCK IS MOVED WITHOUT RUNNING THE TIMERS**, which is the
       real shape: the sound reaches its end and `onended` has not been delivered
       yet, so no word has been reported. `said` is therefore still 0 when
       `resume` ends the reading synchronously. */
    host.advance(1000)
    speaker.pause()
    cb.onWord.mockClear()
    speaker.resume()
    expect(cb.onDone).toHaveBeenCalledWith('ended')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(cb.onWord, 'no word may be reported after the reading ended').not.toHaveBeenCalled()
  })
})

/**
 * ⚠️ **FOURTEEN SURVIVORS THE MUTATION SWEEP FOUND, IN FOUR PLACES NOTHING
 * REACHED.** Each is a road a CHINESE reading takes and an English one does not:
 * Qwen answers no word timings at all, so the empty-words branches, the
 * no-boundaries report and everything downstream of them are its ordinary case
 * and nobody else's.
 */
describe('a reading with no word timings, which is every Chinese chapter', () => {
  it('says so again when a seek lands, having already said it once', async () => {
    /* ⚠️ **THE GUARD IN `#noWordBoundaries` HAD NOTHING REACHING IT TWICE WITHIN
       ONE READING** — the render reports it, and nothing else did. A seek on a
       Chinese reading goes down the same road, so without the flag the reader's
       band would be removed and `followsWords` set false a second time for every
       drag of the scrubber. */
    const { speaker, cb } = speakerOver(async () => audio({ words: [] }))
    speaker.speak('春天', 'zh')
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onNoBoundaries).toHaveBeenCalledTimes(1)

    expect(speaker.seekToMs(500), 'the sound can still be moved').toBe(true)
    expect(cb.onNoBoundaries, 'and it is not announced again').toHaveBeenCalledTimes(1)
    expect(speaker.seekToFraction(0.9)).toBe(true)
    expect(cb.onNoBoundaries).toHaveBeenCalledTimes(1)
  })

  it('moves the sound on a seek, and schedules no word for it', async () => {
    /* ⚠️ **THE SEEK MUST STILL WORK.** A Chinese reading can be scrubbed and
       cannot be stepped — the sound has a position and a length like any other,
       and only the follow-along is missing. */
    const host = new FakeAudioHost()
    const { speaker, cb } = speakerOver(async () => audio({ words: [] }), host)
    speaker.speak('春天', 'zh')
    await vi.advanceTimersByTimeAsync(0)
    const before = host.sources.length
    speaker.seekToMs(500)
    expect(host.sources, 'a new source at the offset').toHaveLength(before + 1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(cb.onWord, 'and no word was ever reported').not.toHaveBeenCalled()
  })

  it('builds no word timers for a seek made while paused', async () => {
    /* ⚠️ **`resume` BUILDS THEM FROM THE PLAYER'S POSITION, AND IT IS THE ONLY
       THING THAT SHOULD — FOUND BY THE MUTATION SWEEP.** Scheduled here as well,
       every word from the seek onwards would be reported TWICE: once by the
       timers a paused seek left armed and once by the ones `resume` builds. The
       band would jump between two places a reading apart. */
    const { speaker, cb } = speakerOver(async () =>
      audio({
        words: [
          { start: 0, length: 3, startMs: 100, endMs: 200 },
          { start: 4, length: 5, startMs: 300, endMs: 400 },
        ],
      }),
    )
    speaker.speak('one three', 'en')
    await vi.advanceTimersByTimeAsync(0)
    speaker.pause()
    cb.onWord.mockClear()

    speaker.seekToMs(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(cb.onWord, 'nothing is sounding, so nothing is reported').not.toHaveBeenCalled()

    speaker.resume()
    await vi.advanceTimersByTimeAsync(500)
    expect(cb.onWord.mock.calls, 'each word once, from the one road that builds them').toEqual([
      [0, 3],
      [4, 5],
    ])
  })

  it('cannot be seeked by offset, and says so rather than guessing', async () => {
    const { speaker } = speakerOver(async () => audio({ words: [] }))
    speaker.speak('春天', 'zh')
    await vi.advanceTimersByTimeAsync(0)
    expect(speaker.seekToOffset(0), 'there is no word to land on').toBe(false)
    expect(speaker.seekToOffset(99)).toBe(false)
  })

  it('answers no spoken offset, which leaves the caller’s cursor alone', async () => {
    /* `null` is what `useSpeech` reads to mean *the reading's sentence is not
       knowable* — as against zero, which would step from the top of the chapter. */
    const { speaker } = speakerOver(async () => audio({ words: [] }))
    expect(speaker.spokenOffset(), 'nothing is reading yet').toBeNull()
    speaker.speak('春天', 'zh')
    await vi.advanceTimersByTimeAsync(0)
    expect(speaker.spokenOffset(), 'and no words to answer with').toBeNull()
    speaker.stop()
    expect(speaker.spokenOffset(), 'nor once it is over').toBeNull()
  })

  it('answers the LAST word once everything has been said', async () => {
    /* ⚠️ **THE SECOND FALLBACK HAD NOTHING REACHING IT — FOUND BY THE MUTATION
       SWEEP, which replaced `at(-1)` with `at(+1)` and `??` with `&&`.** Once
       `said` has counted past the end, `words[said]` is `undefined` and the
       reading is on the LAST word — which is where the band is, and where a
       sentence step must count from. Three words, so the last and the second are
       different answers. */
    const { speaker } = speakerOver(async () =>
      audio({
        words: [
          { start: 0, length: 3, startMs: 100, endMs: 200 },
          { start: 4, length: 5, startMs: 300, endMs: 400 },
          { start: 10, length: 2, startMs: 500, endMs: 600 },
        ],
      }),
    )
    speaker.speak('one three up', 'en')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(600)
    expect(speaker.spokenOffset(), 'the last word, not the second').toBe(10)
  })

  it('answers a real offset where there ARE words, which is the other half', async () => {
    const { speaker } = speakerOver(async () =>
      audio({
        words: [
          { start: 0, length: 3, startMs: 0, endMs: 200 },
          { start: 14, length: 3, startMs: 1000, endMs: 1200 },
        ],
      }),
    )
    speaker.speak('One sentence. Two sentence.', 'en')
    await vi.advanceTimersByTimeAsync(0)
    /* The first word's timer fires at 0 ms, so by now it has been said and the
       reading IS at the second — which is what `said` counts and what the band
       draws. */
    expect(speaker.spokenOffset(), 'the word the reading is on').toBe(14)
    speaker.seekToMs(0)
    expect(speaker.spokenOffset(), 'and back to the first after a seek there').toBe(0)
    speaker.seekToMs(1000)
    expect(speaker.spokenOffset(), 'the word the seek landed on').toBe(14)
  })
})

/**
 * ⚠️ **THE READER'S SPEED REACHED THE ENGINE THROUGH A SPREAD NOTHING MEASURED —
 * FOUND BY THE MUTATION SWEEP, four survivors in one line.** Absent and present
 * are two different requests: the plugin reads an absent rate as the pack's own
 * default, which is a different reading from the one the reader asked for.
 */
describe('the reader’s speed, on the request', () => {
  it('carries the rate where there is one', async () => {
    const { speaker, requests } = speakerOver(async () => audio())
    speaker.speak('hello', 'en', { rate: 1.5 })
    await vi.advanceTimersByTimeAsync(0)
    expect(requests.at(-1)?.rate).toBe(1.5)
  })

  it('OMITS it where the reader has chosen none, rather than sending a default', async () => {
    /* ⚠️ **ABSENT IS NOT THE SAME AS 1.** The pack's own pace is what an absent
       rate asks for, and a Chinese pack has no speed control at all — so a `1`
       invented here would be a key claiming a speed the samples do not have,
       which is the defect `commands.rs`'s `effective_rate` records. */
    const { speaker, requests } = speakerOver(async () => audio())
    speaker.speak('hello', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(requests.at(-1)).not.toHaveProperty('rate')
    /* ⚠️ **AND AN EMPTY PREFS OBJECT IS THE SAME ANSWER**, which is what the app
       passes when the reader has chosen nothing — `exactOptionalPropertyTypes` is
       why `{ rate: undefined }` cannot even be written here. */
    speaker.speak('again', 'en', {})
    await vi.advanceTimersByTimeAsync(0)
    expect(requests.at(-1)).not.toHaveProperty('rate')
  })
})
