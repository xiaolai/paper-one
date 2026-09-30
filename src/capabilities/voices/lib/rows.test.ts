import { describe, expect, it } from 'vitest'
import { asProgress, clipOf, forgottenOf, packOf, pcmOfWav, progressOf, usageOf } from './rows'

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

describe('reading a rendered section', () => {
  const TIMING = { start: 0, length: 5, startMs: 0, endMs: 240 }
  const SKIP = { text: 'Coenties', why: 'no pronunciation' }
  const CLIP = {
    stem: 'book_a-3-0123456789abcdef',
    path: '/data/audio/clips/book_a-3-0123456789abcdef.wav',
    bytes: 48_044,
    sampleRate: 24_000,
    durationMs: 1000,
    words: [TIMING],
    skipped: [SKIP],
    evicted: { clips: 0, bytes: 0 },
  }

  /* Every case here asserts the clause's OWN words. Two of these refusals share
     a subject — a list that is not a list, and a list whose rows are wrong —
     and a pattern loose enough to match both would let either one through. */
  const refusal = (row: unknown): string => {
    const cause = ((): unknown => {
      try {
        clipOf(row)
        return null
      } catch (thrown: unknown) {
        return thrown
      }
    })()
    expect(cause, 'it refused').toBeInstanceOf(Error)
    return (cause as Error).message
  }

  it('reads a section', () => {
    const read = clipOf(CLIP)
    expect(read.stem).toBe(CLIP.stem)
    expect(read.path).toBe(CLIP.path)
    expect(read.bytes).toBe(48_044)
    expect(read.sampleRate).toBe(24_000)
    expect(read.durationMs).toBe(1000)
    expect(read.words).toEqual([TIMING])
    expect(read.skipped).toEqual([SKIP])
    expect(read.evicted).toEqual({ clips: 0, bytes: 0 })
  })

  it('refuses anything that is not a section at all', () => {
    expect(refusal(null)).toBe('the render answered with no section')
    expect(refusal(undefined)).toBe('the render answered with no section')
    expect(refusal('stem')).toBe('the render answered with no section')
    expect(refusal(callableWith(CLIP))).toBe('the render answered with no section')
  })

  it('refuses a missing or empty name for the audio', () => {
    const named = 'the render answered with no name for the audio'
    expect(refusal({ ...CLIP, stem: undefined })).toBe(named)
    expect(refusal({ ...CLIP, stem: '' })).toBe(named)
    expect(refusal({ ...CLIP, stem: 7 })).toBe(named)
  })

  it('refuses a missing or empty absolute path', () => {
    const named = 'the render answered with no absolute path to the audio'
    expect(refusal({ ...CLIP, path: undefined })).toBe(named)
    expect(refusal({ ...CLIP, path: '' })).toBe(named)
    expect(refusal({ ...CLIP, path: 7 })).toBe(named)
  })

  it('refuses an empty file, which plays as a chapter of silence', () => {
    const empty = 'the render answered with an empty file'
    expect(refusal({ ...CLIP, bytes: 0 })).toBe(empty)
    expect(refusal({ ...CLIP, bytes: -1 })).toBe(empty)
    expect(refusal({ ...CLIP, bytes: 1.5 })).toBe(empty)
    expect(refusal({ ...CLIP, bytes: '48044' })).toBe(empty)
    expect(clipOf({ ...CLIP, bytes: 1 }).bytes, 'one byte is a size').toBe(1)
  })

  it('refuses a sample rate that would divide to nothing', () => {
    const rate = 'the render answered with no sample rate'
    expect(refusal({ ...CLIP, sampleRate: 0 })).toBe(rate)
    expect(refusal({ ...CLIP, sampleRate: -24_000 })).toBe(rate)
    expect(refusal({ ...CLIP, sampleRate: 24_000.5 })).toBe(rate)
    expect(refusal({ ...CLIP, sampleRate: '24000' })).toBe(rate)
    expect(refusal({ ...CLIP, sampleRate: Number.NaN })).toBe(rate)
    expect(clipOf({ ...CLIP, sampleRate: 1 }).sampleRate, 'one hertz is a rate').toBe(1)
  })

  it('refuses a missing duration, and takes zero', () => {
    const named = 'the render answered with no duration'
    expect(refusal({ ...CLIP, durationMs: undefined })).toBe(named)
    expect(refusal({ ...CLIP, durationMs: -1 })).toBe(named)
    expect(refusal({ ...CLIP, durationMs: 1.5 })).toBe(named)
    /* Zero IS a duration: a section of one sample rounds to it, and refusing it
       would refuse a clip that plays. The same rule `sizeOf`/`arrivedOf` records
       — a value meaningless as one quantity is ordinary as another. */
    expect(clipOf({ ...CLIP, durationMs: 0 }).durationMs).toBe(0)
  })

  it('refuses word timings that are not timings', () => {
    const timings = 'the render answered with word timings that are not timings'
    expect(refusal({ ...CLIP, words: TIMING })).toBe(timings)
    expect(refusal({ ...CLIP, words: [null] })).toBe(timings)
    expect(refusal({ ...CLIP, words: ['first'] })).toBe(timings)
    for (const key of ['start', 'length', 'startMs', 'endMs'] as const) {
      expect(refusal({ ...CLIP, words: [{ ...TIMING, [key]: undefined }] }), key).toBe(timings)
      expect(refusal({ ...CLIP, words: [{ ...TIMING, [key]: -1 }] }), key).toBe(timings)
      expect(refusal({ ...CLIP, words: [{ ...TIMING, [key]: 1.5 }] }), key).toBe(timings)
    }
    // One good timing beside one bad one refuses the section.
    expect(refusal({ ...CLIP, words: [TIMING, null] })).toBe(timings)
    expect(refusal({ ...CLIP, words: [callableWith(TIMING)] }), 'a callable is no timing').toBe(timings)
    /* A Chinese render answers none at all, and that is a clip all the same. */
    expect(clipOf({ ...CLIP, words: [] }).words).toEqual([])
  })

  it('refuses word timings that are out of order, on either axis', () => {
    /* ⚠️ **ORDER IS A PRECONDITION OF THE SEEK.** `firstWordFrom` bisects
       `startMs` and `wordAtOffset` bisects `start + length`, so an unordered list
       does not skip a word — it answers an ARBITRARY index for every seek in the
       section, with nothing failing. Each axis is checked separately because a
       list can be sorted on one and not the other, and that is the half a reader
       would notice last. */
    const out = 'the render answered with word timings that are out of order'
    expect(
      refusal({
        ...CLIP,
        words: [
          { start: 0, length: 5, startMs: 500, endMs: 700 },
          { start: 6, length: 4, startMs: 0, endMs: 200 },
        ],
      }),
      'later in the text, earlier in the sound',
    ).toBe(out)
    expect(
      refusal({
        ...CLIP,
        words: [
          { start: 6, length: 4, startMs: 0, endMs: 200 },
          { start: 0, length: 5, startMs: 500, endMs: 700 },
        ],
      }),
      'in order by time, out of order by offset',
    ).toBe(out)
    /* EQUAL IS IN ORDER, and refusing it would refuse real renders: two words
       can begin in the same millisecond, and a zero-length word shares its
       neighbour's offset. */
    expect(
      clipOf({
        ...CLIP,
        words: [
          { start: 0, length: 5, startMs: 100, endMs: 200 },
          { start: 5, length: 0, startMs: 100, endMs: 200 },
          { start: 5, length: 3, startMs: 200, endMs: 300 },
        ],
      }).words,
    ).toHaveLength(3)
    expect(clipOf({ ...CLIP, words: [TIMING] }).words, 'one word is always in order').toHaveLength(1)
  })

  it('refuses a skip list that is not one', () => {
    const skips = 'the render answered with a skip list that is not one'
    expect(refusal({ ...CLIP, skipped: SKIP })).toBe(skips)
    expect(refusal({ ...CLIP, skipped: [null] })).toBe(skips)
    expect(refusal({ ...CLIP, skipped: ['Coenties'] })).toBe(skips)
    expect(refusal({ ...CLIP, skipped: [{ why: 'no pronunciation' }] })).toBe(skips)
    expect(refusal({ ...CLIP, skipped: [{ text: 'Coenties' }] })).toBe(skips)
    expect(refusal({ ...CLIP, skipped: [SKIP, { text: 7, why: 'x' }] })).toBe(skips)
    expect(refusal({ ...CLIP, skipped: [callableWith(SKIP)] }), 'a callable is no skip').toBe(skips)
    expect(clipOf({ ...CLIP, skipped: [] }).skipped, 'nothing skipped is a list').toEqual([])
  })

  it('takes an absent eviction as nothing forgotten, and refuses a malformed one', () => {
    /* ⚠️ ABSENT AND PRESENT-AND-WRONG ARE TWO ANSWERS, on the smallest possible
       value. A plugin that says nothing about eviction has evicted nothing; one
       that answers a shape this cannot read must not have its numbers shown to a
       reader as though they were counts. */
    expect(clipOf({ ...CLIP, evicted: undefined }).evicted).toEqual({ clips: 0, bytes: 0 })
    expect(clipOf({ ...CLIP, evicted: null }).evicted).toEqual({ clips: 0, bytes: 0 })
    const bad = 'the rendered reading answered with an eviction that is not counts'
    expect(refusal({ ...CLIP, evicted: 'two' })).toBe(bad)
    expect(refusal({ ...CLIP, evicted: { clips: 1 } })).toBe(bad)
    expect(refusal({ ...CLIP, evicted: { bytes: 1 } })).toBe(bad)
    expect(refusal({ ...CLIP, evicted: { clips: -1, bytes: 1 } })).toBe(bad)
    expect(refusal({ ...CLIP, evicted: { clips: 1.5, bytes: 1 } })).toBe(bad)
    expect(clipOf({ ...CLIP, evicted: { clips: 2, bytes: 96_088 } }).evicted).toEqual({
      clips: 2,
      bytes: 96_088,
    })
  })

  it('reads what an eviction took away on its own too', () => {
    expect(forgottenOf({ clips: 3, bytes: 1 })).toEqual({ clips: 3, bytes: 1 })
    expect(forgottenOf(undefined)).toEqual({ clips: 0, bytes: 0 })
    expect(forgottenOf(null)).toEqual({ clips: 0, bytes: 0 })
    expect(() => forgottenOf(7)).toThrow(/eviction that is not counts/u)
    expect(() => forgottenOf(callableWith({ clips: 1, bytes: 1 }))).toThrow(
      /eviction that is not counts/u,
    )
  })
})

describe('reading how much the rendered reading holds', () => {
  const USAGE = { bytes: 1_000, budget: 5 * 1024 * 1024 * 1024, clips: 2 }

  it('reads a usage row', () => {
    expect(usageOf(USAGE)).toEqual(USAGE)
    /* An empty store is every count at zero, which is an ordinary answer and not
       a missing one — the `sizeOf`/`arrivedOf` rule again. */
    expect(usageOf({ bytes: 0, budget: 0, clips: 0 })).toEqual({ bytes: 0, budget: 0, clips: 0 })
  })

  it('refuses anything that is not counts', () => {
    expect(() => usageOf(null)).toThrow(/answered with no usage/u)
    expect(() => usageOf('lots')).toThrow(/answered with no usage/u)
    expect(() => usageOf(callableWith(USAGE))).toThrow(/answered with no usage/u)
    for (const key of ['bytes', 'budget', 'clips'] as const) {
      expect(() => usageOf({ ...USAGE, [key]: undefined }), key).toThrow(/not counts/u)
      expect(() => usageOf({ ...USAGE, [key]: -1 }), key).toThrow(/not counts/u)
      expect(() => usageOf({ ...USAGE, [key]: 1.5 }), key).toThrow(/not counts/u)
      expect(() => usageOf({ ...USAGE, [key]: '1' }), key).toThrow(/not counts/u)
    }
  })
})

describe('reading a clip’s samples out of the file the plugin wrote', () => {
  /** The one WAV shape `wav.rs` writes, with `frames` samples of silence. */
  function wav(frames: number, over: Partial<{ rate: number; tag: string; channels: number; bits: number; declared: number; format: number; fmtSize: number }> = {}): Uint8Array {
    const data = frames * 2
    const out = new Uint8Array(44 + data)
    const view = new DataView(out.buffer)
    const ascii = (at: number, text: string) => {
      for (let i = 0; i < 4; i += 1) out[at + i] = text.charCodeAt(i)
    }
    ascii(0, 'RIFF')
    view.setUint32(4, 36 + data, true)
    ascii(8, 'WAVE')
    ascii(12, 'fmt ')
    view.setUint32(16, over.fmtSize ?? 16, true)
    view.setUint16(20, over.format ?? 1, true)
    view.setUint16(22, over.channels ?? 1, true)
    view.setUint32(24, over.rate ?? 24_000, true)
    view.setUint32(28, (over.rate ?? 24_000) * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, over.bits ?? 16, true)
    ascii(36, over.tag ?? 'data')
    view.setUint32(40, over.declared ?? data, true)
    return out
  }

  it('hands back the samples and nothing of the header', () => {
    const file = wav(4)
    const pcm = pcmOfWav(file, 24_000)
    expect(pcm).toHaveLength(8)
    expect(pcm.byteOffset, 'a view rather than a copy — a section is 140 MB').toBe(44)
  })

  it('refuses a file shorter than a header', () => {
    expect(() => pcmOfWav(new Uint8Array(43), 24_000)).toThrow(/shorter than a WAV header/u)
    /* Exactly a header and no samples is a render with no audio, which the
       engines refuse on their side — here it reads as an empty clip rather than
       a malformed one, because the shape is right. */
    expect(pcmOfWav(wav(0), 24_000)).toHaveLength(0)
  })

  it('refuses bytes that are not the shape Paper writes', () => {
    /* ⚠️ **ALL THREE MARKERS, AND ONLY `RIFF` WAS CORRUPTED — FOUND BY THE MUTATION
       SWEEP.** Each is a separate operand of one `||`, so a case that breaks the
       first leaves the other two unobservable: Stryker replaced each with `false`
       and both survived. They are three different files to meet — a raw stream, a
       RIFF container that is not audio, and one whose first chunk is something
       else — and a reader that checked only the first byte would accept two of
       them. */
    for (const [at, marker] of [
      [0, 'RIFF'],
      [8, 'WAVE'],
      [12, 'fmt '],
    ] as const) {
      const wrong = wav(2)
      wrong[at] = 'X'.charCodeAt(0)
      expect(() => pcmOfWav(wrong, 24_000), marker).toThrow(/not the WAV shape Paper writes/u)
    }
  })

  it('names an FLLR chunk rather than reading padding as audio', () => {
    /* ⚠️ THE `afconvert` TRAP, on these bytes. A tolerant reader hands the caller
       4 044 bytes of padding and calls it a chapter — a book of silence with no
       error anywhere. `narrate/wav.rs` refuses it by name and so does this. */
    expect(() => pcmOfWav(wav(2, { tag: 'FLLR' }), 24_000)).toThrow(
      /has FLLR where its samples belong, not data/u,
    )
  })

  it('refuses an encoding that is not plain PCM, which is read as noise otherwise', () => {
    /* ⚠️ **THE CHANNEL COUNT AND THE BIT DEPTH WERE READ AND THE FORMAT CODE WAS
       NOT** (independent audit, 2026-09-30). All three files below declare one
       16-bit channel at the right rate and hold the right number of bytes, so
       every other check in this reader passes them — and their samples are then
       read as signed 16-bit PCM. IEEE float is the one that matters: it is what a
       different encoder would plausibly write, and a whole chapter of it is
       audible as noise with nothing anywhere saying a byte was wrong. */
    expect(() => pcmOfWav(wav(2, { format: 3 }), 24_000)).toThrow(/encoded as 3, not as plain PCM/u)
    expect(() => pcmOfWav(wav(2, { format: 6 }), 24_000)).toThrow(/encoded as 6, not as plain PCM/u)
    expect(() => pcmOfWav(wav(2, { format: 0xfffe }), 24_000)).toThrow(
      /encoded as 65534, not as plain PCM/u,
    )
  })

  it('refuses a format chunk that is not the canonical sixteen bytes', () => {
    /* ⚠️ EVERY OFFSET THIS READER USES IS A CONSTANT THAT HOLDS ONLY FOR A
       16-BYTE CHUNK. A file declaring 32 puts its own format extension where the
       samples belong — and it passes every other check here, because `data` is
       looked for at a fixed 36 and the length at a fixed 40, both of which this
       file satisfies. The eight bytes handed back would be the extension. */
    expect(() => pcmOfWav(wav(4, { fmtSize: 32 }), 24_000)).toThrow(
      /states a 32-byte format chunk, not the 16 Paper writes/u,
    )
    expect(() => pcmOfWav(wav(4, { fmtSize: 18 }), 24_000)).toThrow(/18-byte format chunk/u)
  })

  it('refuses anything but mono 16-bit', () => {
    expect(() => pcmOfWav(wav(2, { channels: 2 }), 24_000)).toThrow(/not mono 16-bit/u)
    expect(() => pcmOfWav(wav(2, { bits: 8 }), 24_000)).toThrow(/not mono 16-bit/u)
  })

  it('refuses a rate the section does not agree with', () => {
    /* A clip played at the wrong rate is a voice at the wrong pitch, all the way
       through, with nothing failing. */
    expect(() => pcmOfWav(wav(2, { rate: 22_050 }), 24_000)).toThrow(
      /says 22050 Hz where the section says 24000 Hz/u,
    )
  })

  it('refuses a length the header disagrees with', () => {
    /* A short file reads as a short chapter, which `narrate` records as the worst
       failure available: complete-looking and wrong. */
    expect(() => pcmOfWav(wav(4, { declared: 4 }), 24_000)).toThrow(
      /says 4 bytes of audio and holds 8/u,
    )
  })

  it('refuses an odd number of bytes, which is not a whole sample', () => {
    const odd = new Uint8Array(45)
    const shape = wav(0)
    odd.set(shape.subarray(0, 44))
    new DataView(odd.buffer).setUint32(40, 1, true)
    expect(() => pcmOfWav(odd, 24_000)).toThrow(/ends on half a sample/u)
  })
})
