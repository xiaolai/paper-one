import { describe, expect, it } from 'vitest'
import { asProgress, offered, packOf, packsFor, progressOf, qualify, unqualify } from './rows'
import type { VoicePack } from '../../../kernel'

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

const pack = (over: Partial<VoicePack> = {}): VoicePack => ({ ...(packOf(ROW) as VoicePack), ...over })

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

describe('naming a voice', () => {
  it('qualifies by engine, because two packs may ship the same name', () => {
    expect(qualify('kokoro', 'af_heart')).toBe('kokoro:af_heart')
    expect(unqualify('kokoro:af_heart')).toEqual({ family: 'kokoro', voiceId: 'af_heart' })
  })

  it('leaves a stored WebView identifier alone', () => {
    // A reader who chose a system voice before this existed must keep it, and
    // an Apple identifier has dots and no colon.
    expect(unqualify('com.apple.voice.compact.en-US.Samantha')).toBeNull()
    expect(unqualify('com.apple.speech.synthesis.voice.Alex')).toBeNull()
  })

  it('refuses a name with nothing on one side of the colon', () => {
    expect(unqualify(':af_heart')).toBeNull()
    expect(unqualify('kokoro:')).toBeNull()
    expect(unqualify('')).toBeNull()
  })

  it('keeps a voice id that itself contains a colon', () => {
    expect(unqualify('qwen:Uncle_Fu:2')).toEqual({ family: 'qwen', voiceId: 'Uncle_Fu:2' })
  })
})

describe('what this machine may be offered', () => {
  it('refuses a pack the Mac has too little memory for', () => {
    // Not a warning: a 2.5 GB download followed by the system killing the app
    // on the first sentence is worse than not being offered it.
    expect(offered(pack(), 16)).toBe(true)
    expect(offered(pack(), 8)).toBe(true)
    expect(offered(pack(), 4)).toBe(false)
  })

  it('finds the packs that can read a language, by its primary subtag', () => {
    const zh = pack()
    const en = pack({ id: 'english-kokoro', family: 'kokoro', languages: ['en'] })
    expect(packsFor([zh, en], 'zh-Hans-CN').map((p) => p.id)).toEqual(['chinese-qwen'])
    expect(packsFor([zh, en], 'en-GB').map((p) => p.id)).toEqual(['english-kokoro'])
    expect(packsFor([zh, en], 'fr')).toEqual([])
  })
})
