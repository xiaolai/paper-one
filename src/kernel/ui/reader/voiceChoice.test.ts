import { describe, expect, it } from 'vitest'
import {
  bestVoice,
  voiceGroups,
  chosenVoice,
  primaryOf,
  tierOf,
  voiceFor,
  voiceOptions,
  voiceKey,
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
/** In the same family as the sound effects, and a real voice — see `tierOf`. */
const ALEX = voice('Alex', 'en-US', 'com.apple.speech.synthesis.voice.Alex')
const FRED = voice('Fred', 'en-US', 'com.apple.speech.synthesis.voice.Fred')
/** What a voice the engine synthesises on a server looks like. */
const REMOTE = { ...voice('Cloud', 'en-US', 'urn:remote:cloud'), localService: false }
/** What a voice looks like anywhere but macOS and iOS. */
const ESPEAK = voice('English', 'en-GB', 'urn:moz-tts:sapi:English?en-GB')

describe('tierOf', () => {
  it('reads the tier out of an Apple identifier', () => {
    expect(tierOf(AVA_PREMIUM.voiceURI)).toBe('premium')
    expect(tierOf(DANIEL_ENHANCED.voiceURI)).toBe('enhanced')
    expect(tierOf(SAMANTHA_COMPACT.voiceURI)).toBe('compact')
    expect(tierOf(SAMANTHA_SUPER.voiceURI)).toBe('super-compact')
  })

  /**
   * ⚠️ **THE WHOLE FAMILY USED TO COUNT AS NOVELTY, WHICH LOST ALEX.** The rule
   * was the identifier PREFIX, argued for because it needs no list of names. The
   * family is not homogeneous: Alex, Fred, Kathy, Albert, Junior and Ralph share
   * it with Boing and Zarvox, and Alex is the voice many readers would pick over
   * everything else installed.
   */
  it('calls the real voices in the legacy family legacy, not novelty', () => {
    expect(tierOf(ALEX.voiceURI)).toBe('legacy')
    expect(tierOf(FRED.voiceURI)).toBe('legacy')
    expect(tierOf('com.apple.speech.synthesis.voice.Kathy')).toBe('legacy')
  })

  it('calls the whole novelty family novelty, not unknown', () => {
    /* THE ORDER OF THE TWO CHECKS IN `tierOf` IS WHAT THIS MEASURES. Both
     * families begin `com.apple.`, and a novelty identifier contains no tier
     * word — so a tier scan running first answers `unknown`, which is a
     * SELECTABLE rank, and Boing reads the book. */
    expect(tierOf(ZARVOX.voiceURI)).toBe('novelty')
    expect(tierOf(BOING.voiceURI)).toBe('novelty')
    expect(tierOf('com.apple.speech.synthesis.voice.Bahh')).toBe('novelty')
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

describe('the script a book is written in', () => {
  /**
   * ⚠️ **THIS MODULE'S HEADER SAID SCRIPT DECIDES AND THE CODE WAS BLIND TO IT.**
   * *"A Traditional-Chinese voice reading a Simplified book is a worse answer than
   * a smaller voice reading it correctly."* — and every tag sharing a primary
   * subtag scored identically, so `zh-CN` and `zh-TW` were interchangeable. The
   * same blindness pairs `sr-Latn` with `sr-Cyrl`.
   */
  const TINGTING = voice('Tingting', 'zh-CN', 'com.apple.voice.compact.zh-CN.Tingting')
  const MEIJIA_PREMIUM = voice('Meijia', 'zh-TW', 'com.apple.voice.premium.zh-TW.Meijia')

  it('prefers the right script over a higher tier', () => {
    /* A PREMIUM voice in the wrong script against a COMPACT one in the right
       script: the compact one wins, which is the header's claim made true. */
    expect(bestVoice([MEIJIA_PREMIUM, TINGTING], 'zh-CN')).toBe(TINGTING)
    expect(bestVoice([TINGTING, MEIJIA_PREMIUM], 'zh-TW')).toBe(MEIJIA_PREMIUM)
  })

  it('reads a region tag as its script, which nobody wrote down', () => {
    /* `zh-CN` carries no script subtag and means Hans; `maximize()` supplies it. */
    expect(bestVoice([MEIJIA_PREMIUM, TINGTING], 'zh-Hans')).toBe(TINGTING)
    expect(bestVoice([TINGTING, MEIJIA_PREMIUM], 'zh-Hant')).toBe(MEIJIA_PREMIUM)
  })

  it('separates two scripts of one language beyond Chinese', () => {
    const latin = voice('Nikola', 'sr-Latn', 'com.apple.voice.compact.sr-Latn.Nikola')
    const cyrillic = voice('Sofija', 'sr-Cyrl', 'com.apple.voice.compact.sr-Cyrl.Sofija')
    expect(bestVoice([latin, cyrillic], 'sr-Cyrl')).toBe(cyrillic)
    expect(bestVoice([cyrillic, latin], 'sr-Latn')).toBe(latin)
  })

  it('still picks a wrong-script voice when it is the only one', () => {
    /* ⚠️ **AND THIS IS WHY SCRIPT IS A RANK AND NOT A GATE.** Refusing the wrong
       script leaves `utterance.voice` unset, which is the PLATFORM's default — an
       English voice reading Chinese characters. A wrong accent is not an
       inability to say the words. */
    expect(bestVoice([MEIJIA_PREMIUM], 'zh-CN')).toBe(MEIJIA_PREMIUM)
    expect(bestVoice([TINGTING], 'zh-TW')).toBe(TINGTING)
  })

  it('is not thrown by a tag no runtime can parse', () => {
    /* A book's `dc:language` is whatever its author typed, and `Intl.Locale`
       answers a malformed tag with a RangeError. */
    expect(() => bestVoice([TINGTING], 'not a tag!!')).not.toThrow()
    /* A VALID primary subtag with a remainder `Intl.Locale` refuses. The script
       is unknown, so the voice ranks with a wrong-script one rather than below
       it — no worse off than before the script was consulted at all.
       (`zh!!!` is a different case: `primaryOf` reads no `zh` out of it, so no
       voice matches the language and null is the correct answer.) */
    expect(bestVoice([TINGTING], 'zh-Hans-!!!')).toBe(TINGTING)
    expect(bestVoice([TINGTING], 'zh!!!')).toBeNull()
  })

  it('keeps language above every tier, by construction', () => {
    /* The weight is derived from the tier table rather than written as `10`, so
       adding a tier cannot silently invert the policy. */
    const wrongLanguagePremium = voice('Ava', 'en-US', 'com.apple.voice.premium.en-US.Ava')
    expect(bestVoice([wrongLanguagePremium, TINGTING], 'zh-CN')).toBe(TINGTING)
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

  /**
   * ⚠️ **A SIMPLIFIED VOICE WAS USED FOR A TRADITIONAL BOOK.** The choice is
   * stored under the primary language — `zh` for both — so Tingting, chosen for a
   * mainland book, answered for a Taiwanese one, and `languageScore > 0` let it
   * through because the language matched. The automatic pick has refused to cross
   * a script since `b8b5e02`; the stored choice now refuses too, and the automatic
   * pick answers instead.
   */
  it('does not read a Traditional book in a voice chosen in Simplified', () => {
    expect(chosenVoice(installed, 'zh-TW', { zh: TINGTING_COMPACT.voiceURI })).toBeNull()
  })

  /* AND A BOOK THAT NEVER SAID WHICH SCRIPT KEEPS THE READER'S CHOICE. `zh` alone
     maximizes to Hans, which is a guess — fine for ranking, wrong for refusing a
     voice the reader explicitly picked. */
  it('keeps the chosen voice for a book that names no script and no region', () => {
    expect(chosenVoice(installed, 'zh', { zh: MEIJIA_SUPER.voiceURI })).toBe(MEIJIA_SUPER)
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

  /* ⚠️ **THIS ASSERTED AN EMPTY LIST, WHICH WAS THE GAP RATHER THAN THE RULE.**
     A book with no declared language is where `bestVoice` declines, so offering
     nothing left the reader unable to correct the platform's own pick. See the
     `a book that declares no language` suite for what it answers now. */
  it('offers every selectable voice when the document declares no language', () => {
    for (const nothing of [null, '', '   ']) {
      const offered = voiceOptions(installed, nothing)
      expect(offered.length).toBeGreaterThan(0)
      expect(offered).not.toContain(ZARVOX)
      expect(offered).not.toContain(BOING)
    }
  })
})

describe('voiceGroups', () => {
  const installed = [SAMANTHA_SUPER, ZARVOX, SAMANTHA_COMPACT, AVA_PREMIUM, DANIEL_ENHANCED, TINGTING_COMPACT]

  /**
   * ⚠️ **THIS ASSERTED TIER ORDER AND TIER ORDER WAS THE BUG.** It expected
   * premium, enhanced, compact, super-compact for an `en-US` document — but
   * `DANIEL_ENHANCED` is `en-GB`, and language outranks tier, so putting its
   * group second contradicted `bestVoice`. The groups follow the same score the
   * pick does now, which puts every exact-language group ahead of the
   * other-region one however good that one is.
   */
  it('orders the groups the way the voices are actually ranked', () => {
    expect(voiceGroups(installed, 'en-US').map((group) => group.tier)).toEqual([
      'premium',
      'compact',
      'super-compact',
      'enhanced',
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

  it('groups the whole list when the document declares no language', () => {
    const groups = voiceGroups(installed, null)
    expect(groups.length).toBeGreaterThan(0)
    /* Still by tier, best first, and still no sound effects. */
    expect(groups[0]?.tier).toBe('premium')
    expect(groups.flatMap((group) => group.voices)).not.toContain(ZARVOX)
  })
})

describe('the legacy family, split', () => {
  it('offers a classic voice rather than excluding it', () => {
    expect(bestVoice([ALEX], 'en-US')).toBe(ALEX)
    expect(voiceOptions([ALEX, ZARVOX], 'en-US')).toEqual([ALEX])
  })

  it('still prefers a modern voice to a classic one', () => {
    /* Alex is offered, not promoted: the compact voices are generally better for
       a whole book, and a reader who wants Alex can say so. */
    expect(bestVoice([ALEX, SAMANTHA_COMPACT], 'en-US')).toBe(SAMANTHA_COMPACT)
    expect(bestVoice([ALEX, SAMANTHA_SUPER], 'en-US')).toBe(ALEX)
  })
})

describe('a voice the engine speaks on a server', () => {
  it('is never chosen automatically', () => {
    /* Web Speech permits a remote voice, and Paper reads whole sections aloud —
       so choosing one would send a book off the machine. */
    expect(bestVoice([REMOTE], 'en-US')).toBeNull()
    expect(bestVoice([REMOTE, SAMANTHA_SUPER], 'en-US')).toBe(SAMANTHA_SUPER)
  })

  it('is not offered in the picker', () => {
    expect(voiceOptions([REMOTE, SAMANTHA_COMPACT], 'en-US')).toEqual([SAMANTHA_COMPACT])
  })

  it('is refused even when the reader has stored it', () => {
    expect(chosenVoice([REMOTE], 'en-US', { en: REMOTE.voiceURI })).toBeNull()
  })

  it('does not refuse a voice that simply did not say', () => {
    /* Absent is unknown, not remote — a fixture and an older engine both land
       there, and refusing on silence would take read-aloud off machines that
       are fine. */
    expect(bestVoice([SAMANTHA_COMPACT], 'en-US')).toBe(SAMANTHA_COMPACT)
  })
})

describe('a sound effect the reader has stored', () => {
  it('is refused, so the automatic pick answers instead', () => {
    /* `bestVoice` and `voiceOptions` both promise never to choose one; a stored
       preference walked past both, because a choice was only checked for
       language. A hand-edited settings file is where such a value comes from. */
    const installed = [ZARVOX, SAMANTHA_COMPACT]
    expect(chosenVoice(installed, 'en-US', { en: ZARVOX.voiceURI })).toBeNull()
    expect(voiceFor(installed, 'en-US', { en: ZARVOX.voiceURI })).toBe(SAMANTHA_COMPACT)
  })
})

describe('the picker cannot disagree with the choice', () => {
  /**
   * ⚠️ **IT DID.** `voiceGroups` sorted its groups by tier alone, so with an
   * `en-GB` Premium and an `en-US` Compact installed the first row was the
   * Premium while `bestVoice` took the Compact — language outranks tier. The
   * reader was shown a first row that was not the default.
   */
  it('puts the group holding the chosen voice first', () => {
    const premiumElsewhere = voice('Ava', 'en-GB', 'com.apple.voice.premium.en-GB.Ava')
    const compactHere = voice('Samantha', 'en-US', 'com.apple.voice.compact.en-US.Samantha')
    const installed = [premiumElsewhere, compactHere]
    const groups = voiceGroups(installed, 'en-US')
    expect(groups[0]?.tier).toBe('compact')
    expect(groups[0]?.voices[0]).toBe(bestVoice(installed, 'en-US'))
  })
})

/**
 * ⚠️ **EVERY VOICE OFF APPLE'S PLATFORMS SCORES THE SAME, SO THE TIEBREAK IS
 * THE WHOLE DECISION THERE.** `tierOf` answers `unknown` for a `voiceURI` it
 * cannot parse, and only Apple spells them the way it parses — so on Windows,
 * on Linux, on Android and in a browser on any of them, every same-language
 * voice ties. The first version of this module gave that tie to whichever the
 * engine listed first, which is an array index rather than a judgement, and
 * before the module existed a reader got the platform's own default. Ranking by
 * array order can therefore be WORSE than not ranking at all, on exactly the
 * platforms the ranking understands least.
 */
describe('a platform whose voiceURIs say nothing about quality', () => {
  const zira: VoiceFacts = { name: 'Microsoft Zira', lang: 'en-US', voiceURI: 'Microsoft Zira Desktop' }
  const david: VoiceFacts = {
    name: 'Microsoft David',
    lang: 'en-US',
    voiceURI: 'Microsoft David Desktop',
    default: true,
  }

  it('reads them all as one tier, which is what makes the tie the normal case', () => {
    expect(tierOf(zira.voiceURI)).toBe('unknown')
    expect(tierOf(david.voiceURI)).toBe('unknown')
  })

  it('takes the engine own default over the one that merely came first', () => {
    expect(bestVoice([zira, david], 'en-US')).toBe(david)
  })

  it('offers it first in the picker too, so the two still cannot disagree', () => {
    const installed = [zira, david]
    expect(voiceOptions(installed, 'en-US')[0]).toBe(bestVoice(installed, 'en-US'))
  })

  it('falls back to the engine order when nothing claims to be the default', () => {
    /* STABILITY IS THE POINT: the same book must get the same voice twice, and
       with no signal to prefer one, the engine's own order is that guarantee. */
    expect(bestVoice([zira, { ...david, default: false }], 'en-US')).toBe(zira)
  })

  it('never lets the default outrank a legible tier', () => {
    /* A downloaded Premium voice beats the compact one macOS still calls its
       default. The tiebreak answers "which does the vendor point at", which is
       a different question from "which is better" and loses to it. */
    const defaultCompact = { ...SAMANTHA_COMPACT, default: true }
    expect(bestVoice([defaultCompact, AVA_PREMIUM], 'en-US')).toBe(AVA_PREMIUM)
  })

  it('never lets the default outrank the language', () => {
    const defaultEnglish = { ...SAMANTHA_COMPACT, default: true }
    expect(bestVoice([defaultEnglish, TINGTING_COMPACT], 'zh-CN')).toBe(TINGTING_COMPACT)
  })

  it('still refuses a sound effect that the engine calls its default', () => {
    expect(bestVoice([{ ...ZARVOX, default: true }], 'en-US')).toBeNull()
  })
})

describe('a book that declares no language', () => {
  const installed = [SAMANTHA_SUPER, ZARVOX, SAMANTHA_COMPACT, TINGTING_COMPACT, REMOTE, ALEX]

  /**
   * ⚠️ **THE PICKER USED TO BE EMPTY HERE, AND THE GROUP WAS HIDDEN.** A book
   * with no `dc:language` is exactly where `bestVoice` declines — so the one
   * case the reader most needed to correct was the one with no control in it.
   */
  it('offers every selectable voice rather than nothing', () => {
    const offered = voiceOptions(installed, null)
    expect(offered).toContain(SAMANTHA_COMPACT)
    expect(offered).toContain(TINGTING_COMPACT)
    expect(offered).toContain(ALEX)
    /* The two refusals still hold with no language to rank by. */
    expect(offered).not.toContain(ZARVOX)
    expect(offered).not.toContain(REMOTE)
  })

  it('orders that list by tier, best first', () => {
    const offered = voiceOptions([SAMANTHA_SUPER, ALEX, SAMANTHA_COMPACT, AVA_PREMIUM], null)
    expect(offered).toEqual([AVA_PREMIUM, SAMANTHA_COMPACT, ALEX, SAMANTHA_SUPER])
  })

  it('still refuses to guess a language automatically', () => {
    /* The rule this module was built on, unchanged: choosing a voice for a book
       that has not said what it is would be picking a language for it. */
    expect(bestVoice(installed, null)).toBeNull()
  })

  it("honours the reader's choice, which is the whole point", () => {
    expect(voiceFor(installed, null, { '': TINGTING_COMPACT.voiceURI })).toBe(TINGTING_COMPACT)
  })

  it('refuses a sound effect or a remote voice even when stored', () => {
    expect(chosenVoice(installed, null, { '': ZARVOX.voiceURI })).toBeNull()
    expect(chosenVoice(installed, null, { '': REMOTE.voiceURI })).toBeNull()
  })

  it('does not let a language-less choice answer for a book that names one', () => {
    /* `''` is its own key, not a wildcard. A voice picked for an unlabelled book
       must not start reading the Chinese one. */
    expect(chosenVoice(installed, 'zh-CN', { '': SAMANTHA_COMPACT.voiceURI })).toBeNull()
    expect(voiceFor(installed, 'zh-CN', { '': SAMANTHA_COMPACT.voiceURI })).toBe(TINGTING_COMPACT)
  })

  it('and a language choice does not answer for a book with none', () => {
    expect(chosenVoice(installed, null, { en: SAMANTHA_COMPACT.voiceURI })).toBeNull()
  })
})

describe('voiceKey', () => {
  it('folds a declared language to its primary subtag', () => {
    expect(voiceKey('zh-CN')).toBe('zh')
    expect(voiceKey('EN-us')).toBe('en')
  })

  it("answers '' for a book that declares nothing, which is a real key", () => {
    expect(voiceKey(null)).toBe('')
    expect(voiceKey('')).toBe('')
    expect(voiceKey('   ')).toBe('')
  })
})
