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
    at() {
      self.calls.push('at')
      return { positionMs: 1234, durationMs: 5678 }
    },
    seekToMs(ms: number) {
      self.calls.push(`seekToMs:${ms}`)
      return true
    },
    seekToOffset(offset: number) {
      self.calls.push(`seekToOffset:${offset}`)
      return true
    },
    seekToFraction(fraction: number) {
      self.calls.push(`seekToFraction:${fraction}`)
      return true
    },
    spokenOffset() {
      self.calls.push('spokenOffset')
      return 42
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

describe('seeking, which only the speaker that is reading can do', () => {
  /* ⚠️ THE `prepare` CASES THAT USED TO BE HERE ARE GONE WITH IT. The look-ahead
     was refused by the owner on 2026-09-30 — the whole section is rendered once
     and kept, with no render the reader has not asked for. What replaced it is
     the four members below, which a reading can only have once it is one buffer. */

  it('reaches only the speaker that is reading', () => {
    const engine = fake()
    const platform = fake()
    const speaker = routedSpeaker(engine, platform, () => [pack()])
    speaker.speak('a passage', 'en')
    engine.calls.length = 0
    platform.calls.length = 0
    expect(speaker.seekToMs?.(500)).toBe(true)
    expect(speaker.seekToOffset?.(7)).toBe(true)
    expect(speaker.seekToFraction?.(0.5)).toBe(true)
    expect(speaker.at?.()).toEqual({ positionMs: 1234, durationMs: 5678 })
    expect(engine.calls).toEqual(['seekToMs:500', 'seekToOffset:7', 'seekToFraction:0.5', 'at'])
    expect(platform.calls, 'the speaker that is not reading hears nothing').toEqual([])
  })

  it('reaches the platform speaker where that is the one reading', () => {
    const engine = fake()
    const platform = fake()
    const speaker = routedSpeaker(engine, platform, () => [pack()])
    /* French: no pack can read it, so the platform takes the passage. */
    speaker.speak('la suite', 'fr')
    platform.calls.length = 0
    expect(speaker.seekToMs?.(500)).toBe(true)
    expect(platform.calls).toEqual(['seekToMs:500'])
  })

  it('asks the reading speaker where in the text it is', () => {
    const engine = fake()
    const platform = fake()
    const speaker = routedSpeaker(engine, platform, () => [pack()])
    speaker.speak('a passage', 'en')
    engine.calls.length = 0
    /* `speak` STOPS BOTH first — see the header — so the platform's list is
       cleared here rather than asserted empty from the start. */
    platform.calls.length = 0
    expect(speaker.spokenOffset?.()).toBe(42)
    expect(engine.calls).toEqual(['spokenOffset'])
    expect(platform.calls, 'and not the one that is quiet').toEqual([])
  })

  it('answers null for a speaker that cannot say where it is, and for none at all', () => {
    /* ⚠️ **BOTH OPTIONAL CHAINS ARE LOAD-BEARING AND NEITHER WAS REACHED — FOUND
       BY THE MUTATION SWEEP.** `current` is null between utterances, and the
       PLATFORM speaker genuinely has no `spokenOffset`: Web Speech reports no
       position in an utterance, so there is no offset to give. Either way the
       caller leaves its cursor alone, which is the same answer it had before this
       member existed. */
    const engine = fake()
    const platform = fake()
    delete (platform as { spokenOffset?: unknown }).spokenOffset
    const speaker = routedSpeaker(engine, platform, () => [pack()])
    expect(speaker.spokenOffset?.(), 'nothing is reading').toBeNull()
    /* French: no pack can read it, so the platform takes it — and it cannot say. */
    speaker.speak('la suite', 'fr')
    expect(speaker.spokenOffset?.()).toBeNull()
  })

  it('answers no between utterances rather than reaching the last speaker used', () => {
    /* `current` is null before a `speak` and after a `stop`, and there is nothing
       to seek in either — a seek that reached the last speaker used would start a
       sound over a reading the reader has ended. */
    const engine = fake()
    const platform = fake()
    const speaker = routedSpeaker(engine, platform, () => [pack()])
    expect(speaker.seekToMs?.(500)).toBe(false)
    expect(speaker.at?.()).toBeNull()
    speaker.speak('a passage', 'en')
    speaker.stop()
    engine.calls.length = 0
    expect(speaker.seekToMs?.(500)).toBe(false)
    expect(speaker.seekToOffset?.(1)).toBe(false)
    expect(speaker.seekToFraction?.(1)).toBe(false)
    expect(speaker.at?.()).toBeNull()
    expect(engine.calls).toEqual([])
  })

  it('answers no where the speaker reading cannot seek at all', () => {
    /* Web Speech declares none of these. `?? false` is what makes "cannot" and
       "did not" one answer for a caller that only wants to know whether the
       reading moved. */
    const platform = fake()
    const cannot: SpeakerLike = {
      speak: () => true,
      pause: () => {},
      resume: () => {},
      stop: () => {},
    }
    const speaker = routedSpeaker(cannot, platform, () => [pack()])
    speaker.speak('a passage', 'en')
    expect(speaker.seekToMs?.(500)).toBe(false)
    expect(speaker.seekToOffset?.(1)).toBe(false)
    expect(speaker.seekToFraction?.(0.5)).toBe(false)
    expect(speaker.at?.()).toBeNull()
  })

  it('answers no after a refused speak, which is not a reading', () => {
    const engine = fake()
    engine.began = false
    const platform = fake()
    const speaker = routedSpeaker(engine, platform, () => [pack()])
    expect(speaker.speak('a passage', 'en')).toBe(false)
    expect(speaker.seekToMs?.(500)).toBe(false)
  })
})
