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

  it('highlights the whole sentence for an engine that reports no words', async () => {
    // ⚠️ Qwen answers no timings. `Speaker` drops the follow-along entirely,
    // which is right for a platform voice that cannot say — but here the
    // sentence IS known, so the honest unit is the sentence.
    const { speaker, cb } = speakerOver(async () => audio({ words: [] }))
    speaker.speak('a whole sentence', 'zh')
    await vi.advanceTimersByTimeAsync(0)
    expect(cb.onWord).toHaveBeenCalledWith(0, 'a whole sentence'.length)
    expect(cb.onNoBoundaries).toHaveBeenCalledTimes(1)
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
