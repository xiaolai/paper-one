import { describe, expect, it } from 'vitest'
import { createKernelServices } from '../../../kernel'
import { speakerFor } from './speakerRouting'
import { NO_GOOD_VOICE, voiceFor } from './voiceChoice'

/**
 * WHAT READING ALOUD DOES WITH NO ENGINE BOUND, which is what switching the
 * downloadable voices off leaves. That capability's own test shows the slot stays
 * empty; this is what the kernel then does with an empty slot, on its one path.
 *
 * `useVoicePacks` answers no packs for an empty slot (its own test holds that), so
 * `[]` here is exactly what the reading is given.
 */

const voice = (voiceURI: string, lang: string) => ({ voiceURI, name: voiceURI, lang, localService: true })
const READABLE = voice('com.apple.voice.premium.en-US.Ava', 'en-US')
const COMPACT = voice('com.apple.voice.compact.en-US.Samantha', 'en-US')

describe('reading aloud with no speech engine', () => {
  it('has an empty slot on services nothing bound', () => {
    expect(createKernelServices({ fs: null, storage: null }).speechEngines()).toBeNull()
  })

  it('goes to the platform speaker, which is Web Speech', () => {
    expect(speakerFor([], 'en-US', {})).toBe('platform')
  })

  it('reads in a system voice the floor admits', () => {
    expect(voiceFor([READABLE], 'en-US')).toEqual({ kind: 'voice', voice: READABLE })
  })

  /* A refusal the reader is told about, on the existing path: not a failure, and
     not a low-quality reading either. */
  it('answers none when no system voice clears the floor, and the refusal has its words', () => {
    expect(voiceFor([COMPACT], 'en-US')).toEqual({ kind: 'none' })
    expect(NO_GOOD_VOICE).toContain('is not read')
  })
})
