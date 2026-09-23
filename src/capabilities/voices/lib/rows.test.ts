import { describe, expect, it } from 'vitest'
import { asProgress, packOf, progressOf, spokenOf } from './rows'

/* A callable carrying a row's own fields. `Object.assign` cannot build one:
   `name` is a function's own non-writable property and every pack and voice
   has a `name`, so the assignment throws before the test begins. */
const callableWith = (fields: object): unknown =>
  Object.defineProperties(() => {}, Object.getOwnPropertyDescriptors(fields))

const ROW = {
  id: 'chinese-qwen',
  name: 'Chinese',
  summary: 'Qwen3-TTS 0.6B, read on this device.',
  family: 'qwen',
  languages: ['zh'],
  bytes: 2_498_416_818,
  minimumMemoryGb: 8,
  voices: [{ id: 'Vivian', name: 'Vivian', language: 'zh-CN', note: 'Bright young woman.' }],
  installed: false,
}

describe('reading what the plugin answers', () => {
  it('reads a pack row', () => {
    const read = packOf(ROW)
    expect(read?.id).toBe('chinese-qwen')
    expect(read?.voices[0]?.name).toBe('Vivian')
    expect(read?.bytes).toBe(2_498_416_818)
  })

  it('refuses a row with a size that is not a number', () => {
    // The failure this catches reaches the reader: a download offered as
    // `undefined MB`, which is what a cast would have rendered.
    expect(packOf({ ...ROW, bytes: null })).toBeNull()
    expect(packOf({ ...ROW, bytes: 'lots' })).toBeNull()
    expect(packOf({ ...ROW, bytes: Number.NaN })).toBeNull()
  })

  it('refuses a row missing anything a reader decides with', () => {
    for (const key of ['id', 'name', 'summary', 'family'] as const) {
      expect(packOf({ ...ROW, [key]: '' }), key).toBeNull()
      expect(packOf({ ...ROW, [key]: undefined }), key).toBeNull()
    }
    expect(packOf({ ...ROW, installed: 'yes' })).toBeNull()
    expect(packOf({ ...ROW, languages: 'zh' })).toBeNull()
    expect(packOf({ ...ROW, minimumMemoryGb: 'eight' })).toBeNull()
    expect(packOf({ ...ROW, minimumMemoryGb: Number.POSITIVE_INFINITY })).toBeNull()
    expect(packOf({ ...ROW, minimumMemoryGb: Number.NaN })).toBeNull()
  })

  it('refuses anything that is not a row at all', () => {
    expect(packOf(null)).toBeNull()
    expect(packOf('chinese-qwen')).toBeNull()
    expect(packOf([])).toBeNull()
    /* A function CARRYING every field a pack has is what makes the `typeof`
       test the clause that decides: a plain string or number is refused by the
       field checks further down whether or not the shape test runs. What
       crosses from Rust is JSON, so a callable is never a pack. */
    expect(packOf(callableWith(ROW))).toBeNull()
  })

  it('takes a floor of zero as a floor, not as none', () => {
    // `< 0` and `<= 0` differ on exactly this row, and zero is a real answer:
    // a pack that asks for no particular amount of memory.
    expect(packOf({ ...ROW, minimumMemoryGb: 0 })?.minimumMemoryGb).toBe(0)
  })

  it('refuses a languages list with anything in it that is not a language', () => {
    /* A MIXED list is the case that separates `every` from `some`: a list where
       one entry is a language and one is not must be refused whole, because the
       one that is not reaches the reader's language filter. */
    expect(packOf({ ...ROW, languages: ['zh', 7] })).toBeNull()
    expect(packOf({ ...ROW, languages: [] })?.languages, 'no languages is a list').toEqual([])
  })

  it('refuses a voices field that is not a list, without throwing on it', () => {
    // Without the shape check this reaches `.map`, which a string does not have.
    expect(() => packOf({ ...ROW, voices: 'Vivian' })).not.toThrow()
    expect(packOf({ ...ROW, voices: 'Vivian' })).toBeNull()
  })

  it('refuses a voice that is not a voice, whatever is wrong with it', () => {
    const withVoices = (voices: unknown) => packOf({ ...ROW, voices })
    const voice = { id: 'v', name: 'V', language: 'zh' }
    expect(() => withVoices([null])).not.toThrow()
    expect(withVoices([null]), 'null is typeof object').toBeNull()
    expect(withVoices([callableWith(voice)]), 'a callable is no voice').toBeNull()
    expect(withVoices([{ name: 'V', language: 'zh' }]), 'no id').toBeNull()
    expect(withVoices([{ ...voice, id: '' }]), 'an empty id').toBeNull()
    expect(withVoices([{ ...voice, id: 7 }]), 'an id that is not a name').toBeNull()
    expect(withVoices([{ id: 'v', language: 'zh' }]), 'no name').toBeNull()
    expect(withVoices([{ id: 'v', name: 'V' }]), 'no language').toBeNull()
    /* One good voice beside one bad one refuses the PACK — `some`, not
       `every`. A pack that quietly dropped the bad row would offer a voice
       list shorter than the engine's, with nothing saying so. */
    expect(withVoices([voice, null])).toBeNull()
    expect(withVoices([voice])?.voices).toHaveLength(1)
  })

  it('refuses a size that is negative or fractional', () => {
    /* ⚠️ `Number.isFinite` alone let both through. A negative size reaches the
       reader as "unknown size" on a row that is still offered for download, and
       a fractional byte count is not a count of bytes. */
    expect(packOf({ ...ROW, bytes: -1 })).toBeNull()
    expect(packOf({ ...ROW, bytes: 1.5 })).toBeNull()
    expect(packOf({ ...ROW, minimumMemoryGb: -8 })).toBeNull()
    expect(packOf({ ...ROW, bytes: 0 })?.bytes, 'zero is a real size — unknown').toBe(0)
  })

  it('refuses a note that is not a string, instead of coercing it', () => {
    /* ⚠️ It was `String(voice.note ?? '')`, the one field converted rather than
       checked — and `String` THROWS on an object with a non-callable
       `toString`, which is valid JSON. That throw left `packOf`, left
       `catalogue`, and took the whole pane to its error state over one row. */
    const withNote = (note: unknown) => packOf({ ...ROW, voices: [{ ...ROW.voices[0], note }] })
    expect(() => withNote({ toString: 1 })).not.toThrow()
    expect(withNote({ toString: 1 })).toBeNull()
    expect(withNote(7)).toBeNull()
    expect(withNote(undefined)?.voices[0]?.note, 'absent is an empty note').toBe('')
  })
})

describe('reading a download’s progress', () => {
  it('reads each kind', () => {
    expect(progressOf({ pack: 'p', kind: 'downloading', received: 1, total: 2 })).toEqual({
      pack: 'p',
      kind: 'downloading',
      received: 1,
      total: 2,
    })
    expect(progressOf({ pack: 'p', kind: 'verifying' })).toEqual({ pack: 'p', kind: 'verifying' })
    expect(progressOf({ pack: 'p', kind: 'installed' })).toEqual({ pack: 'p', kind: 'installed' })
  })

  it('refuses a downloading event with no numbers', () => {
    // `412 MB of undefined` is what this stops reaching the screen.
    expect(progressOf({ pack: 'p', kind: 'downloading' })).toBeNull()
    expect(progressOf({ pack: 'p', kind: 'downloading', received: 1 })).toBeNull()
    expect(progressOf({ pack: 'p', kind: 'downloading', received: Number.NaN, total: 2 })).toBeNull()
  })

  it('refuses an event about no pack, or of a kind it does not know', () => {
    expect(progressOf({ kind: 'verifying' })).toBeNull()
    expect(progressOf({ pack: '', kind: 'verifying' })).toBeNull()
    /* The numbers are deliberate: without them the counts refuse the event
       anyway, and the kind check — the thing this case is about — is never the
       clause that decides. */
    expect(progressOf({ pack: 'p', kind: 'exploding', received: 1, total: 2 })).toBeNull()
    expect(progressOf(undefined)).toBeNull()
    expect(progressOf(null), 'typeof null is “object”, so null needs its own answer').toBeNull()
  })

  it('turns an event into what the port promises', () => {
    expect(asProgress({ pack: 'p', kind: 'downloading', received: 5, total: 9 })).toEqual({
      kind: 'downloading',
      received: 5,
      total: 9,
    })
    expect(asProgress({ pack: 'p', kind: 'installed' })).toEqual({ kind: 'installed' })
  })
})

describe('reading a rendered passage', () => {
  const TIMING = { start: 0, length: 5, startMs: 0, endMs: 240 }
  const SKIP = { text: 'Coenties', why: 'no pronunciation' }
  const SPOKEN = { pcm: [0, 255, 7, 8], sampleRate: 24_000, words: [TIMING], skipped: [SKIP] }

  /* Every case here asserts the clause's OWN words. Two of these refusals share
     a subject — a list that is not a list, and a list whose rows are wrong —
     and a pattern loose enough to match both would let either one through. */
  const refusal = (row: unknown): string => {
    const cause = ((): unknown => {
      try {
        spokenOf(row)
        return null
      } catch (thrown: unknown) {
        return thrown
      }
    })()
    expect(cause, 'it refused').toBeInstanceOf(Error)
    return (cause as Error).message
  }

  it('reads a passage, and hands back real bytes rather than the list', () => {
    const read = spokenOf(SPOKEN)
    expect(read.pcm).toBeInstanceOf(Uint8Array)
    expect([...read.pcm]).toEqual([0, 255, 7, 8])
    expect(read.sampleRate).toBe(24_000)
    expect(read.words).toEqual([TIMING])
    expect(read.skipped).toEqual([SKIP])
  })

  it('refuses anything that is not a passage at all', () => {
    expect(refusal(null)).toBe('the render answered with no passage')
    expect(refusal(undefined)).toBe('the render answered with no passage')
    expect(refusal('pcm')).toBe('the render answered with no passage')
    expect(refusal(callableWith(SPOKEN))).toBe('the render answered with no passage')
  })

  it('refuses samples that are not bytes, rather than wrapping them round', () => {
    /* `Uint8Array.from` never fails: handed `[256, -1, 1.5]` it answers
       `[0, 255, 1]`, which is a click in the middle of a sentence with nothing
       anywhere saying a byte was wrong. */
    const bytes = 'the render answered with samples that are not bytes'
    expect(refusal({ ...SPOKEN, pcm: 'AAAA' })).toBe(bytes)
    expect(refusal({ ...SPOKEN, pcm: [0, 256] })).toBe(bytes)
    expect(refusal({ ...SPOKEN, pcm: [0, -1] })).toBe(bytes)
    expect(refusal({ ...SPOKEN, pcm: [0, 1.5] })).toBe(bytes)
    expect(refusal({ ...SPOKEN, pcm: [0, '7'] })).toBe(bytes)
    // A MIXED list is what separates `every` from `some`.
    expect(refusal({ ...SPOKEN, pcm: [7, 300, 8, 9] })).toBe(bytes)
    // And both ends of the range are ordinary samples.
    expect([...spokenOf({ ...SPOKEN, pcm: [0, 255] }).pcm]).toEqual([0, 255])
  })

  it('refuses an odd number of bytes, which is not a whole sample', () => {
    expect(refusal({ ...SPOKEN, pcm: [0, 1, 2] })).toBe('the render answered with half a sample')
    expect([...spokenOf({ ...SPOKEN, pcm: [] }).pcm], 'no audio is even').toEqual([])
  })

  it('refuses a sample rate that would divide to nothing', () => {
    const rate = 'the render answered with no sample rate'
    expect(refusal({ ...SPOKEN, sampleRate: 0 })).toBe(rate)
    expect(refusal({ ...SPOKEN, sampleRate: -24_000 })).toBe(rate)
    expect(refusal({ ...SPOKEN, sampleRate: 24_000.5 })).toBe(rate)
    expect(refusal({ ...SPOKEN, sampleRate: '24000' })).toBe(rate)
    expect(refusal({ ...SPOKEN, sampleRate: Number.NaN })).toBe(rate)
    expect(spokenOf({ ...SPOKEN, sampleRate: 1 }).sampleRate, 'one hertz is a rate').toBe(1)
  })

  it('refuses word timings that are not timings', () => {
    const timings = 'the render answered with word timings that are not timings'
    expect(refusal({ ...SPOKEN, words: TIMING })).toBe(timings)
    expect(refusal({ ...SPOKEN, words: [null] })).toBe(timings)
    expect(refusal({ ...SPOKEN, words: ['first'] })).toBe(timings)
    for (const key of ['start', 'length', 'startMs', 'endMs'] as const) {
      expect(refusal({ ...SPOKEN, words: [{ ...TIMING, [key]: undefined }] }), key).toBe(timings)
      expect(refusal({ ...SPOKEN, words: [{ ...TIMING, [key]: -1 }] }), key).toBe(timings)
      expect(refusal({ ...SPOKEN, words: [{ ...TIMING, [key]: 1.5 }] }), key).toBe(timings)
    }
    // One good timing beside one bad one refuses the passage.
    expect(refusal({ ...SPOKEN, words: [TIMING, null] })).toBe(timings)
    expect(refusal({ ...SPOKEN, words: [callableWith(TIMING)] }), 'a callable is no timing').toBe(timings)
    expect(spokenOf({ ...SPOKEN, words: [] }).words, 'a silent passage has none').toEqual([])
  })

  it('refuses a skip list that is not one', () => {
    const skips = 'the render answered with a skip list that is not one'
    expect(refusal({ ...SPOKEN, skipped: SKIP })).toBe(skips)
    expect(refusal({ ...SPOKEN, skipped: [null] })).toBe(skips)
    expect(refusal({ ...SPOKEN, skipped: ['Coenties'] })).toBe(skips)
    expect(refusal({ ...SPOKEN, skipped: [{ why: 'no pronunciation' }] })).toBe(skips)
    expect(refusal({ ...SPOKEN, skipped: [{ text: 'Coenties' }] })).toBe(skips)
    expect(refusal({ ...SPOKEN, skipped: [SKIP, { text: 7, why: 'x' }] })).toBe(skips)
    expect(refusal({ ...SPOKEN, skipped: [callableWith(SKIP)] }), 'a callable is no skip').toBe(skips)
    expect(spokenOf({ ...SPOKEN, skipped: [] }).skipped, 'nothing skipped is a list').toEqual([])
  })
})
