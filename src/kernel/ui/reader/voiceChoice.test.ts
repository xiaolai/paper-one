import { describe, expect, it } from 'vitest'
import {
  bestVoice,
  voiceGroups,
  chosenVoice,
  primaryOf,
  tierOf,
  voiceFor,
  voiceOptions,
  type VoiceFacts,
} from './voiceChoice'

/**
 * The identifiers below are REAL, read off macOS 27 on 2026-09-20 through a
 * `WKWebView`'s own `speechSynthesis.getVoices()` — so this file is also the
 * record of what the three families look like. The `enhanced` and `premium`
 * rows are the shape a downloaded voice takes; none was installed on that
 * machine, which is why the pick had nothing better than `compact` to find.
 */
const voice = (name: string, lang: string, voiceURI: string): VoiceFacts => ({ name, lang, voiceURI })

const SAMANTHA_COMPACT = voice('Samantha', 'en-US', 'com.apple.voice.compact.en-US.Samantha')
const SAMANTHA_SUPER = voice('Samantha', 'en-US', 'com.apple.voice.super-compact.en-US.Samantha')
const AVA_PREMIUM = voice('Ava', 'en-US', 'com.apple.voice.premium.en-US.Ava')
const DANIEL_ENHANCED = voice('Daniel', 'en-GB', 'com.apple.voice.enhanced.en-GB.Daniel')
const TINGTING_COMPACT = voice('Tingting', 'zh-CN', 'com.apple.voice.compact.zh-CN.Tingting')
const MEIJIA_SUPER = voice('Meijia', 'zh-TW', 'com.apple.voice.super-compact.zh-TW.Meijia')
const ZARVOX = voice('Zarvox', 'en-US', 'com.apple.speech.synthesis.voice.Zarvox')
const BOING = voice('Boing', 'en-US', 'com.apple.speech.synthesis.voice.Boing')
/** What a voice looks like anywhere but macOS and iOS. */
const ESPEAK = voice('English', 'en-GB', 'urn:moz-tts:sapi:English?en-GB')

describe('tierOf', () => {
  it('reads the tier out of an Apple identifier', () => {
    expect(tierOf(AVA_PREMIUM.voiceURI)).toBe('premium')
    expect(tierOf(DANIEL_ENHANCED.voiceURI)).toBe('enhanced')
    expect(tierOf(SAMANTHA_COMPACT.voiceURI)).toBe('compact')
    expect(tierOf(SAMANTHA_SUPER.voiceURI)).toBe('super-compact')
  })

  it('calls the whole novelty family novelty, not unknown', () => {
    /* THE ORDER OF THE TWO CHECKS IN `tierOf` IS WHAT THIS MEASURES. Both
     * families begin `com.apple.`, and a novelty identifier contains no tier
     * word — so a tier scan running first answers `unknown`, which is a
     * SELECTABLE rank, and Boing reads the book. */
    expect(tierOf(ZARVOX.voiceURI)).toBe('novelty')
    expect(tierOf(BOING.voiceURI)).toBe('novelty')
    expect(tierOf('com.apple.speech.synthesis.voice.Albert')).toBe('novelty')
  })

  it('calls anything that is not Apple unknown', () => {
    expect(tierOf(ESPEAK.voiceURI)).toBe('unknown')
    expect(tierOf('')).toBe('unknown')
    /* NOT a tier word in the tier position. `com.apple.voice.<tier>.` is the
     * shape; a family Apple has not shipped must not read as one it has. */
    expect(tierOf('com.apple.voice.gorgeous.en-US.Nobody')).toBe('unknown')
  })
})

describe('primaryOf', () => {
  it('folds every spelling of one language together', () => {
    expect(primaryOf('zh-CN')).toBe('zh')
    expect(primaryOf('zh_TW')).toBe('zh')
    expect(primaryOf('zh-Hans')).toBe('zh')
    expect(primaryOf('EN-us')).toBe('en')
    expect(primaryOf('  en  ')).toBe('en')
  })

  it('answers empty for empty, rather than inventing a language', () => {
    expect(primaryOf('')).toBe('')
    expect(primaryOf('   ')).toBe('')
  })
})

describe('bestVoice', () => {
  it('prefers the better tier for the same language', () => {
    expect(bestVoice([SAMANTHA_SUPER, SAMANTHA_COMPACT, AVA_PREMIUM], 'en-US')).toBe(AVA_PREMIUM)
    expect(bestVoice([SAMANTHA_SUPER, SAMANTHA_COMPACT], 'en-US')).toBe(SAMANTHA_COMPACT)
  })

  it('prefers the right region over the better tier', () => {
    /* The rule `scoreOf` is built around, pitted against itself rather than
     * read off the formula: a Simplified-Chinese book read by a Traditional
     * voice is worse than the same book read by a smaller Simplified one. */
    expect(bestVoice([MEIJIA_SUPER, TINGTING_COMPACT], 'zh-CN')).toBe(TINGTING_COMPACT)
    const premiumElsewhere = voice('Ava', 'en-US', 'com.apple.voice.premium.en-US.Ava')
    const compactHere = voice('Daniel', 'en-GB', 'com.apple.voice.compact.en-GB.Daniel')
    expect(bestVoice([premiumElsewhere, compactHere], 'en-GB')).toBe(compactHere)
  })

  it('matches across regions when nothing exact is offered', () => {
    expect(bestVoice([DANIEL_ENHANCED], 'en-US')).toBe(DANIEL_ENHANCED)
    expect(bestVoice([MEIJIA_SUPER], 'zh-CN')).toBe(MEIJIA_SUPER)
  })

  it('reads zh_TW and zh-Hans as Chinese', () => {
    expect(bestVoice([TINGTING_COMPACT], 'zh_TW')).toBe(TINGTING_COMPACT)
    expect(bestVoice([TINGTING_COMPACT], 'zh-Hans')).toBe(TINGTING_COMPACT)
  })

  it('never picks a novelty voice, even as the only match', () => {
    /* NOT "ranked last" — null, so the utterance keeps the platform's own
     * voice, which is never one of these. */
    expect(bestVoice([ZARVOX, BOING], 'en-US')).toBeNull()
    expect(bestVoice([ZARVOX, SAMANTHA_SUPER], 'en-US')).toBe(SAMANTHA_SUPER)
  })

  it('picks nothing when the document declares no language', () => {
    expect(bestVoice([AVA_PREMIUM], null)).toBeNull()
    expect(bestVoice([AVA_PREMIUM], '')).toBeNull()
    expect(bestVoice([AVA_PREMIUM], '   ')).toBeNull()
  })

  it('picks nothing when no voice speaks the language at all', () => {
    expect(bestVoice([AVA_PREMIUM, SAMANTHA_COMPACT], 'ja-JP')).toBeNull()
  })

  it('still picks on a platform whose identifiers it cannot read', () => {
    /* The regression this guards: a tier check that refused what it could not
     * parse would pick no voice anywhere but macOS and iOS. */
    expect(bestVoice([ESPEAK], 'en-GB')).toBe(ESPEAK)
  })

  it('ranks an unreadable identifier above super-compact and below compact', () => {
    const unknownHere = voice('English', 'en-US', 'urn:moz-tts:sapi:English?en-US')
    expect(bestVoice([SAMANTHA_SUPER, unknownHere], 'en-US')).toBe(unknownHere)
    expect(bestVoice([unknownHere, SAMANTHA_COMPACT], 'en-US')).toBe(SAMANTHA_COMPACT)
  })

  it('breaks a tie toward the voice the engine listed first', () => {
    const first = voice('First', 'en-US', 'com.apple.voice.compact.en-US.First')
    const second = voice('Second', 'en-US', 'com.apple.voice.compact.en-US.Second')
    expect(bestVoice([first, second], 'en-US')).toBe(first)
    expect(bestVoice([second, first], 'en-US')).toBe(second)
  })
})

describe('chosenVoice', () => {
  const installed = [SAMANTHA_COMPACT, AVA_PREMIUM, TINGTING_COMPACT, MEIJIA_SUPER]

  it('honours a choice stored for the document language', () => {
    expect(chosenVoice(installed, 'en-US', { en: SAMANTHA_COMPACT.voiceURI })).toBe(SAMANTHA_COMPACT)
  })

  it('serves a zh-TW book from a choice made on a zh-CN one', () => {
    expect(chosenVoice(installed, 'zh-TW', { zh: MEIJIA_SUPER.voiceURI })).toBe(MEIJIA_SUPER)
  })

  it('ignores a choice made for another language', () => {
    /* The failure this prevents: a reader picks a voice they like for English,
     * opens a Chinese book, and hears it read in English. */
    expect(chosenVoice(installed, 'zh-CN', { en: AVA_PREMIUM.voiceURI })).toBeNull()
  })

  it('refuses a choice whose language no longer matches the voice', () => {
    expect(chosenVoice(installed, 'zh-CN', { zh: AVA_PREMIUM.voiceURI })).toBeNull()
  })

  it('falls through when the chosen voice is no longer installed', () => {
    /* Voices come and go with what the machine has. A preference naming one
     * that has gone must not leave the reader with no voice. */
    expect(chosenVoice(installed, 'en-US', { en: 'com.apple.voice.premium.en-US.Gone' })).toBeNull()
  })

  it('has nothing to honour with no choice, no language, or an empty choice', () => {
    expect(chosenVoice(installed, 'en-US', {})).toBeNull()
    expect(chosenVoice(installed, null, { en: AVA_PREMIUM.voiceURI })).toBeNull()
    expect(chosenVoice(installed, 'en-US', { en: '' })).toBeNull()
  })
})

describe('voiceFor', () => {
  const installed = [SAMANTHA_SUPER, SAMANTHA_COMPACT, AVA_PREMIUM]

  it("takes the reader's choice over the better voice", () => {
    expect(voiceFor(installed, 'en-US', { en: SAMANTHA_SUPER.voiceURI })).toBe(SAMANTHA_SUPER)
  })

  it('falls back to the best voice when the choice is stale', () => {
    expect(voiceFor(installed, 'en-US', { en: 'com.apple.voice.premium.en-US.Gone' })).toBe(AVA_PREMIUM)
  })

  it('needs no choice at all', () => {
    expect(voiceFor(installed, 'en-US')).toBe(AVA_PREMIUM)
  })
})

describe('voiceOptions', () => {
  const installed = [SAMANTHA_SUPER, ZARVOX, SAMANTHA_COMPACT, BOING, AVA_PREMIUM, TINGTING_COMPACT]

  it('offers no sound effects', () => {
    const offered = voiceOptions(installed, 'en-US')
    expect(offered).not.toContain(ZARVOX)
    expect(offered).not.toContain(BOING)
  })

  it('offers only voices that speak the language', () => {
    expect(voiceOptions(installed, 'en-US')).not.toContain(TINGTING_COMPACT)
    expect(voiceOptions(installed, 'zh-CN')).toEqual([TINGTING_COMPACT])
  })

  it('puts the voice the app would have chosen first', () => {
    /* The invariant that keeps the picker honest: its first row IS the default.
     * A picker whose top entry is not what the app uses makes the default look
     * like a mistake, and it is how the two orderings drift apart. */
    for (const lang of ['en-US', 'en-GB', 'zh-CN', 'zh-TW']) {
      const offered = voiceOptions(installed, lang)
      expect(offered[0] ?? null).toBe(bestVoice(installed, lang))
    }
  })

  it('offers nothing for a document that declares no language', () => {
    expect(voiceOptions(installed, null)).toEqual([])
    expect(voiceOptions(installed, '')).toEqual([])
  })
})

describe('voiceGroups', () => {
  const installed = [SAMANTHA_SUPER, ZARVOX, SAMANTHA_COMPACT, AVA_PREMIUM, DANIEL_ENHANCED, TINGTING_COMPACT]

  it('orders the groups best tier first', () => {
    expect(voiceGroups(installed, 'en-US').map((group) => group.tier)).toEqual([
      'premium',
      'enhanced',
      'compact',
      'super-compact',
    ])
  })

  it('keeps two voices of one name apart, because the heading is what tells them apart', () => {
    /* This Mac offers two Samanthas and two Tingtings, differing only in tier.
     * Merged into one group the list shows the same word twice. */
    const groups = voiceGroups(installed, 'en-US')
    expect(groups.find((group) => group.tier === 'compact')?.voices).toEqual([SAMANTHA_COMPACT])
    expect(groups.find((group) => group.tier === 'super-compact')?.voices).toEqual([SAMANTHA_SUPER])
  })

  it('drops empty tiers rather than drawing five headings over one voice', () => {
    expect(voiceGroups([TINGTING_COMPACT], 'zh-CN').map((group) => group.tier)).toEqual(['compact'])
  })

  it('offers no sound effects and nothing from another language', () => {
    const flat = voiceGroups(installed, 'en-US').flatMap((group) => group.voices)
    expect(flat).not.toContain(ZARVOX)
    expect(flat).not.toContain(TINGTING_COMPACT)
  })

  it("starts with the app's own choice, like the flat list does", () => {
    const groups = voiceGroups(installed, 'en-US')
    expect(groups[0]?.voices[0]).toBe(bestVoice(installed, 'en-US'))
  })

  it('offers nothing for a document that declares no language', () => {
    expect(voiceGroups(installed, null)).toEqual([])
  })
})
