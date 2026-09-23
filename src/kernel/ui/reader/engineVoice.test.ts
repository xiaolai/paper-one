import { describe, expect, it } from 'vitest'
import {
  engineVoiceFor,
  installedPacksFor,
  missingPackNotice,
  packVoiceOf,
  packsFor,
  qualify,
  unqualify,
} from './engineVoice'
import type { VoicePack } from '../../core/ports'

function pack(over: Partial<VoicePack> = {}): VoicePack {
  return {
    id: 'english-kokoro',
    name: 'English',
    summary: 'Kokoro 82M, read on this device.',
    family: 'kokoro',
    languages: ['en'],
    bytes: 336_822_660,
    minimumMemoryGb: 4,
    voices: [
      { id: 'af_heart', name: 'Heart', language: 'en-US', note: '' },
      { id: 'bf_emma', name: 'Emma', language: 'en-GB', note: '' },
    ],
    installed: true,
    ...over,
  }
}

const CHINESE = pack({
  id: 'chinese-qwen',
  name: 'Chinese',
  family: 'qwen',
  languages: ['zh'],
  bytes: 2_498_416_818,
  minimumMemoryGb: 8,
  voices: [{ id: 'Vivian', name: 'Vivian', language: 'zh-CN', note: '' }],
})

describe('writing a choice down', () => {
  it('qualifies by the engine family, because two packs may ship one name', () => {
    expect(qualify('kokoro', 'af_heart')).toBe('kokoro:af_heart')
    expect(unqualify('kokoro:af_heart')).toEqual({ family: 'kokoro', voiceId: 'af_heart' })
  })

  it('leaves a stored Web Speech identifier alone', () => {
    // ⚠️ A reader who picked a system voice before any of this existed must
    // keep it. An Apple identifier has dots and no colon; treating it as ours
    // would silently drop their choice.
    expect(unqualify('com.apple.voice.compact.en-US.Samantha')).toBeNull()
    expect(unqualify('Microsoft David Desktop - English (United States)')).toBeNull()
  })

  it('cannot tell a URN-shaped identifier from ours, and does not pretend to', () => {
    // ⚠️ Firefox spells a `voiceURI` `urn:moz-tts:...`, which is the same
    // syntax as ours and splits the same way. Stated rather than papered over:
    // what makes it harmless is that `engineVoiceFor` only accepts a family
    // matching an INSTALLED PACK, and no pack is called `urn`.
    expect(unqualify('urn:moz-tts:sapi:Microsoft David')).toEqual({
      family: 'urn',
      voiceId: 'moz-tts:sapi:Microsoft David',
    })
    const chosen = { en: 'urn:moz-tts:sapi:Microsoft David' }
    expect(engineVoiceFor([pack()], 'en', chosen)).toEqual({
      packId: 'english-kokoro',
      voiceId: 'af_heart',
    })
  })

  it('refuses a name with nothing on one side of the colon', () => {
    expect(unqualify(':af_heart')).toBeNull()
    expect(unqualify('kokoro:')).toBeNull()
    expect(unqualify('')).toBeNull()
    expect(unqualify('af_heart')).toBeNull()
  })

  it('keeps a voice id that itself contains a colon', () => {
    expect(unqualify('qwen:Uncle_Fu:2')).toEqual({ family: 'qwen', voiceId: 'Uncle_Fu:2' })
  })
})

describe('which packs can read a language', () => {
  it('matches on the primary subtag', () => {
    const all = [pack(), CHINESE]
    expect(packsFor(all, 'en-GB').map((p) => p.id)).toEqual(['english-kokoro'])
    expect(packsFor(all, 'zh-Hans-CN').map((p) => p.id)).toEqual(['chinese-qwen'])
    expect(packsFor(all, 'fr')).toEqual([])
  })

  it('answers none for a book that declares no language', () => {
    // Choosing one would be choosing the book's language for it, which is the
    // rule `bestVoice` already follows for platform voices.
    expect(packsFor([pack(), CHINESE], null)).toEqual([])
    expect(packsFor([pack(), CHINESE], '  ')).toEqual([])
  })
})

describe('the voice that reads this book', () => {
  it('takes the reader’s own choice', () => {
    const chosen = { en: qualify('kokoro', 'bf_emma') }
    expect(engineVoiceFor([pack()], 'en-GB', chosen)).toEqual({
      packId: 'english-kokoro',
      voiceId: 'bf_emma',
    })
  })

  it('falls back to the first voice of the first pack', () => {
    expect(engineVoiceFor([pack()], 'en')).toEqual({ packId: 'english-kokoro', voiceId: 'af_heart' })
  })

  it('ignores a pack that is not installed', () => {
    expect(engineVoiceFor([pack({ installed: false })], 'en')).toBeNull()
  })

  it('answers none for a language no installed pack reads', () => {
    expect(engineVoiceFor([pack(), CHINESE], 'fr')).toBeNull()
    expect(engineVoiceFor([], 'en')).toBeNull()
  })

  it('answers none for a book that declares no language', () => {
    expect(engineVoiceFor([pack()], null)).toBeNull()
  })

  it('falls through a choice whose pack is no longer installed', () => {
    // ⚠️ The alternative is a book that stops being readable because of a
    // preference — the same rule `chosenVoice` follows for a platform voice
    // that has gone.
    const chosen = { en: qualify('kokoro', 'af_heart') }
    const removed = [pack({ installed: false }), pack({ id: 'other', family: 'other', voices: [{ id: 'x', name: 'X', language: 'en', note: '' }] })]
    expect(engineVoiceFor(removed, 'en', chosen)).toEqual({ packId: 'other', voiceId: 'x' })
  })

  it('falls through a choice naming a voice the pack does not have', () => {
    const chosen = { en: qualify('kokoro', 'gone') }
    expect(engineVoiceFor([pack()], 'en', chosen)).toEqual({
      packId: 'english-kokoro',
      voiceId: 'af_heart',
    })
  })

  it('ignores a stored Web Speech identifier rather than failing on it', () => {
    const chosen = { en: 'com.apple.voice.compact.en-US.Samantha' }
    expect(engineVoiceFor([pack()], 'en', chosen)).toEqual({
      packId: 'english-kokoro',
      voiceId: 'af_heart',
    })
  })

  it('matches the choice by family and not by pack id', () => {
    // The same voice from a re-cut pack is the same voice.
    const recut = pack({ id: 'english-kokoro-v2' })
    const chosen = { en: qualify('kokoro', 'bf_emma') }
    expect(engineVoiceFor([recut], 'en', chosen)).toEqual({
      packId: 'english-kokoro-v2',
      voiceId: 'bf_emma',
    })
  })
})

describe('telling a reader what would give this book a voice', () => {
  it('names the pack and its size', () => {
    const notice = missingPackNotice([pack({ installed: false })], 'en')
    expect(notice).toContain('English')
    expect(notice).toContain('321 MB')
    expect(notice).toContain('Settings')
  })

  it('says gigabytes where a pack is one', () => {
    expect(missingPackNotice([{ ...CHINESE, installed: false }], 'zh')).toContain('2.3 GB')
  })

  it('says nothing where the pack is already installed', () => {
    expect(missingPackNotice([pack()], 'en')).toBeNull()
  })

  it('says nothing where no pack reads the language at all', () => {
    // There is nothing a reader could do about French, so advice would be
    // advice that does not work — which is what phase 29's message would have
    // been for every language.
    expect(missingPackNotice([pack({ installed: false })], 'fr')).toBeNull()
    expect(missingPackNotice([], 'en')).toBeNull()
  })
})

describe('naming a chosen voice back to a reader', () => {
  it('answers the pack a language can be read by, only once it is here', () => {
    // ONE RULE for the reading and for the picker. A picker with its own filter
    // is a second copy of it, and the first symptom of the two disagreeing is a
    // list whose selected row is not the voice being heard.
    expect(installedPacksFor([pack(), CHINESE], 'en')).toEqual([pack()])
    expect(installedPacksFor([pack({ installed: false })], 'en')).toEqual([])
    expect(installedPacksFor([pack()], 'fr')).toEqual([])
  })

  it('finds the catalogue rows an engine voice names', () => {
    // ⚠️ `engineVoiceFor` answers two ids, which is the right shape to SEND and
    // the wrong one to SHOW. Without this the Voice row could not say "Heart".
    const found = packVoiceOf([pack(), CHINESE], { packId: 'english-kokoro', voiceId: 'bf_emma' })
    expect(found?.pack.name).toBe('English')
    expect(found?.voice.name).toBe('Emma')
  })

  it('answers nothing for a pack or a voice that is not in the catalogue', () => {
    // A pack removed between the reading resolving a voice and the picker
    // drawing it: the row falls back rather than naming something that is gone.
    expect(packVoiceOf([pack()], { packId: 'chinese-qwen', voiceId: 'Vivian' })).toBeNull()
    expect(packVoiceOf([pack()], { packId: 'english-kokoro', voiceId: 'nobody' })).toBeNull()
  })
})
