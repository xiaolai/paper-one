import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineSpeaker, RENDER_TIMEOUT_MS } from './engineSpeaker'
import { FakeAudioHost, pcmOf } from './enginePlayer.testkit'
import type { SpokenAudio } from '../../core/ports'
import type { SpeakerCallbacks } from './speech'

const RATE = 24_000

function audio(over: Partial<SpokenAudio> = {}): SpokenAudio {
  return { pcm: pcmOf(RATE), sampleRate: RATE, words: [], skipped: [], ...over }
}

function callbacks(): SpeakerCallbacks & { onWord: ReturnType<typeof vi.fn> } {
  return { onWord: vi.fn(), onDone: vi.fn(), onNoBoundaries: vi.fn() } as never
}

/** A speaker over a render the test controls. */
function speakerOver(render: (text: string) => Promise<SpokenAudio>, host = new FakeAudioHost()) {
  const cb = callbacks()
  const speaker = new EngineSpeaker(cb, {
    render: (request) => render(request.text),
    host: () => host,
    choose: (lang) => (lang === 'xx' ? null : { packId: 'english-kokoro', voiceId: 'af_heart' }),
  })
  return { speaker, cb, host }
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
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS + 10)
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

  it('says it has no boundaries once, not once a sentence', async () => {
    const { speaker, cb } = speakerOver(async () => audio({ words: [] }))
    speaker.speak('one', 'zh')
    await vi.advanceTimersByTimeAsync(0)
    speaker.speak('two', 'zh')
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

describe('rendering the next sentence ahead of time', () => {
  it('uses the prepared render rather than asking again', async () => {
    const asked: string[] = []
    const { speaker } = speakerOver(async (text) => {
      asked.push(text)
      return audio()
    })
    speaker.prepare('the next one', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(asked).toEqual(['the next one'])
    speaker.speak('the next one', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(asked).toEqual(['the next one'])
  })

  it('does not prepare the same sentence twice', async () => {
    const asked: string[] = []
    const { speaker } = speakerOver(async (text) => {
      asked.push(text)
      return audio()
    })
    speaker.prepare('again', 'en')
    speaker.prepare('again', 'en')
    await vi.advanceTimersByTimeAsync(0)
    speaker.prepare('again', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(asked).toEqual(['again'])
  })

  it('renders properly when the reader asks for something else', async () => {
    const asked: string[] = []
    const { speaker } = speakerOver(async (text) => {
      asked.push(text)
      return audio()
    })
    speaker.prepare('guessed wrong', 'en')
    await vi.advanceTimersByTimeAsync(0)
    speaker.speak('what they actually wanted', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(asked).toEqual(['guessed wrong', 'what they actually wanted'])
  })

  it('keeps a failed look-ahead to itself', async () => {
    // The sentence has not been asked for yet, so the reader is told nothing;
    // `speak` will render it again and report properly if it fails then.
    const { speaker, cb } = speakerOver(async () => {
      throw new Error('no')
    })
    speaker.prepare('the next one', 'en')
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onDone).not.toHaveBeenCalled()
  })

  it('prepares nothing for empty text or a language it cannot read', async () => {
    const asked: string[] = []
    const { speaker } = speakerOver(async (text) => {
      asked.push(text)
      return audio()
    })
    speaker.prepare('  ', 'en')
    speaker.prepare('something', 'xx')
    await vi.advanceTimersByTimeAsync(0)
    expect(asked).toEqual([])
  })
})
