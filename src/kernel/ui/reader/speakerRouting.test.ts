import { describe, expect, it } from 'vitest'
import { routedSpeaker, speakerFor, type SpeakerLike } from './speakerRouting'
import { qualify } from './engineVoice'
import type { VoicePack } from '../../core/ports'

function pack(over: Partial<VoicePack> = {}): VoicePack {
  return {
    id: 'english-kokoro',
    name: 'English',
    summary: '',
    family: 'kokoro',
    languages: ['en'],
    bytes: 1,
    minimumMemoryGb: 4,
    voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', note: '' }],
    installed: true,
    ...over,
  }
}

function fake(): SpeakerLike & { calls: string[]; began: boolean } {
  const self = {
    calls: [] as string[],
    began: true,
    speak(text: string) {
      self.calls.push(`speak:${text}`)
      return self.began
    },
    pause() {
      self.calls.push('pause')
    },
    resume() {
      self.calls.push('resume')
    },
    stop() {
      self.calls.push('stop')
    },
    prepare(text: string) {
      self.calls.push(`prepare:${text}`)
    },
  }
  return self
}

describe('which speaker reads a book', () => {
  it('sends a language a pack reads to the engine', () => {
    expect(speakerFor([pack()], 'en-GB', {})).toBe('engine')
  })

  it('sends everything else to the platform', () => {
    // ⚠️ The case this routing exists for: a reader with the English pack
    // opening a French book. The pack cannot read it and the platform might.
    expect(speakerFor([pack()], 'fr', {})).toBe('platform')
    expect(speakerFor([pack({ installed: false })], 'en', {})).toBe('platform')
    expect(speakerFor([], 'en', {})).toBe('platform')
    expect(speakerFor([pack()], null, {})).toBe('platform')
  })

  it('follows the reader’s own choice', () => {
    const prefs = { voices: { en: qualify('kokoro', 'af_heart') } }
    expect(speakerFor([pack()], 'en', prefs)).toBe('engine')
  })
})

describe('routing a reading', () => {
  it('speaks a pack’s language through the engine', () => {
    const engine = fake()
    const platform = fake()
    const speaker = routedSpeaker(engine, platform, () => [pack()])
    expect(speaker.speak('hello', 'en')).toBe(true)
    expect(engine.calls).toContain('speak:hello')
    expect(platform.calls).not.toContain('speak:hello')
  })

  it('speaks everything else through the platform', () => {
    const engine = fake()
    const platform = fake()
    const speaker = routedSpeaker(engine, platform, () => [pack()])
    speaker.speak('bonjour', 'fr')
    expect(platform.calls).toContain('speak:bonjour')
    expect(engine.calls).not.toContain('speak:bonjour')
  })

  it('stops BOTH before every passage, not just the one being replaced', () => {
    // ⚠️ Two engines with independent queues. Stopping only the one about to
    // be used leaves the other still speaking the previous section — two
    // voices at once.
    const engine = fake()
    const platform = fake()
    const speaker = routedSpeaker(engine, platform, () => [pack()])
    speaker.speak('hello', 'en')
    expect(engine.calls[0]).toBe('stop')
    expect(platform.calls[0]).toBe('stop')
  })

  it('stops BOTH when the reading stops, not only the one that was reading', () => {
    /* The same reason as the case above, on the other road: the reader presses
       Stop once, and a speaker left unasked goes on reading the passage it had
       already queued. */
    const engine = fake()
    const platform = fake()
    const speaker = routedSpeaker(engine, platform, () => [pack()])
    speaker.speak('hello', 'en')
    engine.calls.length = 0
    platform.calls.length = 0
    speaker.stop()
    expect(engine.calls).toEqual(['stop'])
    expect(platform.calls).toEqual(['stop'])
  })

  it('routes pause and resume to the one that is reading', () => {
    const engine = fake()
    const platform = fake()
    const speaker = routedSpeaker(engine, platform, () => [pack()])
    speaker.speak('hello', 'en')
    speaker.pause()
    speaker.resume()
    expect(engine.calls).toContain('pause')
    expect(engine.calls).toContain('resume')
    expect(platform.calls).not.toContain('pause')
  })

  it('reaches neither with a pause before anything has been read', () => {
    const engine = fake()
    const platform = fake()
    const speaker = routedSpeaker(engine, platform, () => [pack()])
    speaker.pause()
    speaker.resume()
    expect(engine.calls).toEqual([])
    expect(platform.calls).toEqual([])
  })

  it('reaches neither with a pause after a refusal', () => {
    // A refusal is not a reading. Left current, a later pause would reach a
    // speaker that had already reported `no-voice`.
    const engine = fake()
    const platform = fake()
    engine.began = false
    const speaker = routedSpeaker(engine, platform, () => [pack()])
    expect(speaker.speak('hello', 'en')).toBe(false)
    speaker.pause()
    expect(engine.calls).not.toContain('pause')
  })

  it('stops both, and forgets which was reading', () => {
    const engine = fake()
    const platform = fake()
    const speaker = routedSpeaker(engine, platform, () => [pack()])
    speaker.speak('hello', 'en')
    speaker.stop()
    engine.calls.length = 0
    speaker.pause()
    expect(engine.calls).toEqual([])
  })

  it('reads the catalogue afresh, so a pack downloaded mid-chapter is used', () => {
    // ⚠️ A speaker built over a snapshot goes on using the platform voice
    // until the reading is restarted, which is not something a reader would
    // ever guess to do.
    const engine = fake()
    const platform = fake()
    let packs: VoicePack[] = []
    const speaker = routedSpeaker(engine, platform, () => packs)
    speaker.speak('first', 'en')
    expect(platform.calls).toContain('speak:first')
    packs = [pack()]
    speaker.speak('second', 'en')
    expect(engine.calls).toContain('speak:second')
  })
})

describe('rendering the next passage ahead', () => {
  it('prepares on the engine where the next passage goes there', () => {
    const engine = fake()
    const platform = fake()
    const speaker = routedSpeaker(engine, platform, () => [pack()])
    speaker.prepare?.('the next one', 'en')
    expect(engine.calls).toContain('prepare:the next one')
  })

  it('prepares nothing for a passage the platform will read', () => {
    // A render nobody will play, on a model that has to be loaded to make it.
    const engine = fake()
    const platform = fake()
    const speaker = routedSpeaker(engine, platform, () => [pack()])
    speaker.prepare?.('la suite', 'fr')
    expect(engine.calls).toEqual([])
    expect(platform.calls).toEqual([])
  })

  it('does not fail where the target cannot prepare', () => {
    const platform = fake()
    const noPrepare: SpeakerLike = {
      speak: () => true,
      pause: () => {},
      resume: () => {},
      stop: () => {},
    }
    const speaker = routedSpeaker(noPrepare, platform, () => [pack()])
    expect(() => speaker.prepare?.('anything', 'en')).not.toThrow()
  })
})
