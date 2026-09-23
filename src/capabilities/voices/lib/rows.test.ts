import { describe, expect, it } from 'vitest'
import { asProgress, packOf, progressOf } from './rows'

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
    expect(packOf({ ...ROW, voices: [{ name: 'no id' }] })).toBeNull()
  })

  it('refuses anything that is not a row at all', () => {
    expect(packOf(null)).toBeNull()
    expect(packOf('chinese-qwen')).toBeNull()
    expect(packOf([])).toBeNull()
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
    expect(progressOf({ pack: 'p', kind: 'exploding' })).toBeNull()
    expect(progressOf(undefined)).toBeNull()
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
