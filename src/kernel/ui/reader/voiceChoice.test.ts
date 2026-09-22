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
  NO_GOOD_VOICE,
  type VoiceFacts,
} from './voiceChoice'

/**
 * The compact, super-compact and old-family identifiers below are REAL, read off
 * macOS 27 through a `WKWebView`'s own `speechSynthesis.getVoices()` — so this
 * file is also the record of what those families look like. The `enhanced` and
 * `premium` rows are the shape Apple's identifiers give those tiers; on
 * 2026-09-21 none reached the WebView even when installed, which is why the
 * floor turns read aloud off on a Mac (see `voiceChoice.ts`).
 */
const voice = (name: string, lang: string, voiceURI: string): VoiceFacts => ({ name, lang, voiceURI })

/* ABOVE THE FLOOR */
const AVA_PREMIUM = voice('Ava', 'en-US', 'com.apple.voice.premium.en-US.Ava')
const AVA_ENHANCED = voice('Ava', 'en-US', 'com.apple.voice.enhanced.en-US.Ava')
const ZOE_ENHANCED = voice('Zoe', 'en-US', 'com.apple.voice.enhanced.en-US.Zoe')
const DANIEL_ENHANCED = voice('Daniel', 'en-GB', 'com.apple.voice.enhanced.en-GB.Daniel')
const TINGTING_ENHANCED = voice('Tingting', 'zh-CN', 'com.apple.voice.enhanced.zh-CN.Tingting')
const MEIJIA_ENHANCED = voice('Meijia', 'zh-TW', 'com.apple.voice.enhanced.zh-TW.Meijia')
const MEIJIA_PREMIUM = voice('Meijia', 'zh-TW', 'com.apple.voice.premium.zh-TW.Meijia')
/** What a voice looks like anywhere but macOS and iOS — its tier cannot be read. */
const ESPEAK = voice('English', 'en-GB', 'urn:moz-tts:sapi:English?en-GB')

/* BELOW THE FLOOR — everything a Mac's WebView offers */
const SAMANTHA_COMPACT = voice('Samantha', 'en-US', 'com.apple.voice.compact.en-US.Samantha')
const SAMANTHA_SUPER = voice('Samantha', 'en-US', 'com.apple.voice.super-compact.en-US.Samantha')
const TINGTING_COMPACT = voice('Tingting', 'zh-CN', 'com.apple.voice.compact.zh-CN.Tingting')
const MEIJIA_SUPER = voice('Meijia', 'zh-TW', 'com.apple.voice.super-compact.zh-TW.Meijia')
const ZARVOX = voice('Zarvox', 'en-US', 'com.apple.speech.synthesis.voice.Zarvox')
const BOING = voice('Boing', 'en-US', 'com.apple.speech.synthesis.voice.Boing')
const ALEX = voice('Alex', 'en-US', 'com.apple.speech.synthesis.voice.Alex')
const FRED = voice('Fred', 'en-US', 'com.apple.speech.synthesis.voice.Fred')

/** What a voice the engine synthesises on a server looks like. */
const REMOTE = { ...voice('Cloud', 'en-US', 'urn:remote:cloud'), localService: false }

describe('tierOf', () => {
  it('reads the tier out of an Apple identifier', () => {
    expect(tierOf(AVA_PREMIUM.voiceURI)).toBe('premium')
    expect(tierOf(DANIEL_ENHANCED.voiceURI)).toBe('enhanced')
    expect(tierOf(SAMANTHA_COMPACT.voiceURI)).toBe('compact')
    expect(tierOf(SAMANTHA_SUPER.voiceURI)).toBe('super-compact')
  })

  it('calls the whole old family legacy — the voices and the sound effects alike', () => {
    /* THE ORDER OF THE TWO CHECKS IN `tierOf` IS WHAT THIS MEASURES. Both
     * families begin `com.apple.`, and an old-family identifier contains no tier
     * word — so a tier scan running first answers `unknown`, which is ABOVE the
     * floor, and Boing reads the book. */
    for (const one of [ALEX, FRED, ZARVOX, BOING]) expect(tierOf(one.voiceURI), one.name).toBe('legacy')
    expect(tierOf('com.apple.speech.synthesis.voice.Bahh')).toBe('legacy')
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

/**
 * NO VOICE RATHER THAN A BAD ONE — the owner's rule, 2026-09-21.
 *
 * Where the identifier names the tier, only Enhanced and Premium read a book.
 * Everything below is EXCLUDED, not ranked low: ranked low it would still be
 * chosen whenever it was all there was, which on a Mac is always.
 */
describe('the floor', () => {
  const belowTheFloor = [SAMANTHA_COMPACT, SAMANTHA_SUPER, ALEX, FRED, ZARVOX, BOING]

  it('chooses nothing below it, even when nothing else speaks the language', () => {
    expect(bestVoice(belowTheFloor, 'en-US')).toBeNull()
    expect(voiceOptions(belowTheFloor, 'en-US')).toEqual([])
    expect(voiceGroups(belowTheFloor, 'en-US')).toEqual([])
  })

  it('takes a voice above it over every voice below it', () => {
    expect(bestVoice([...belowTheFloor, ZOE_ENHANCED], 'en-US')).toBe(ZOE_ENHANCED)
  })

  it('refuses a stored choice below it, so the automatic pick answers', () => {
    /* A compact voice chosen before there was a floor is exactly what an
       existing settings file holds. */
    const installed = [SAMANTHA_COMPACT, AVA_PREMIUM]
    expect(chosenVoice(installed, 'en-US', { en: SAMANTHA_COMPACT.voiceURI })).toBeNull()
    expect(voiceFor(installed, 'en-US', { en: SAMANTHA_COMPACT.voiceURI })).toEqual({ kind: 'voice', voice: AVA_PREMIUM })
  })

  it('keeps a voice whose tier it cannot read', () => {
    /* The regression this guards: a floor that refused what it could not parse
       would take read aloud away everywhere but Apple's platforms. */
    expect(bestVoice([ESPEAK], 'en-GB')).toBe(ESPEAK)
  })

  /**
   * THE MAC, AS MEASURED. Every family the WebView offered on macOS 27 —
   * compact, super-compact and the old family — before and after four good
   * voices were installed: the reading of any book there is `none`.
   */
  it('turns read aloud off on the voices a Mac WebView actually offers', () => {
    const mac = [SAMANTHA_COMPACT, SAMANTHA_SUPER, TINGTING_COMPACT, MEIJIA_SUPER, ALEX, FRED, ZARVOX, BOING]
    for (const lang of ['en-US', 'zh-CN', 'zh-TW', null]) {
      expect(voiceFor(mac, lang), String(lang)).toEqual({ kind: 'none' })
    }
  })
})

describe('bestVoice', () => {
  it('prefers the better tier for the same language', () => {
    expect(bestVoice([ZOE_ENHANCED, AVA_PREMIUM], 'en-US')).toBe(AVA_PREMIUM)
    expect(bestVoice([AVA_PREMIUM, ZOE_ENHANCED], 'en-US')).toBe(AVA_PREMIUM)
  })

  it('prefers the right region over the better tier', () => {
    /* The rule `scoreOf` is built around, pitted against itself rather than
     * read off the formula: a Simplified-Chinese book read by a Traditional
     * voice is worse than the same book read by a lesser Simplified one. */
    expect(bestVoice([MEIJIA_PREMIUM, TINGTING_ENHANCED], 'zh-CN')).toBe(TINGTING_ENHANCED)
    expect(bestVoice([AVA_PREMIUM, DANIEL_ENHANCED], 'en-GB')).toBe(DANIEL_ENHANCED)
  })

  it('matches across regions when nothing exact is offered', () => {
    expect(bestVoice([DANIEL_ENHANCED], 'en-US')).toBe(DANIEL_ENHANCED)
    expect(bestVoice([MEIJIA_ENHANCED], 'zh-CN')).toBe(MEIJIA_ENHANCED)
  })

  it('reads zh_TW and zh-Hans as Chinese', () => {
    expect(bestVoice([TINGTING_ENHANCED], 'zh_TW')).toBe(TINGTING_ENHANCED)
    expect(bestVoice([TINGTING_ENHANCED], 'zh-Hans')).toBe(TINGTING_ENHANCED)
  })

  it('picks nothing when the document declares no language', () => {
    expect(bestVoice([AVA_PREMIUM], null)).toBeNull()
    expect(bestVoice([AVA_PREMIUM], '')).toBeNull()
    expect(bestVoice([AVA_PREMIUM], '   ')).toBeNull()
  })

  it('picks nothing when no voice speaks the language at all', () => {
    expect(bestVoice([AVA_PREMIUM, ZOE_ENHANCED], 'ja-JP')).toBeNull()
  })

  it('ranks a voice it cannot read below one it can', () => {
    const unknownHere = voice('English', 'en-US', 'urn:moz-tts:sapi:English?en-US')
    expect(bestVoice([unknownHere, ZOE_ENHANCED], 'en-US')).toBe(ZOE_ENHANCED)
    expect(bestVoice([unknownHere], 'en-US')).toBe(unknownHere)
  })

  it('breaks a tie toward the voice the engine listed first', () => {
    expect(bestVoice([ZOE_ENHANCED, AVA_ENHANCED], 'en-US')).toBe(ZOE_ENHANCED)
    expect(bestVoice([AVA_ENHANCED, ZOE_ENHANCED], 'en-US')).toBe(AVA_ENHANCED)
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
  it('prefers the right script over a higher tier', () => {
    expect(bestVoice([MEIJIA_PREMIUM, TINGTING_ENHANCED], 'zh-CN')).toBe(TINGTING_ENHANCED)
    expect(bestVoice([TINGTING_ENHANCED, MEIJIA_PREMIUM], 'zh-TW')).toBe(MEIJIA_PREMIUM)
  })

  it('reads a region tag as its script, which nobody wrote down', () => {
    expect(bestVoice([MEIJIA_PREMIUM, TINGTING_ENHANCED], 'zh-Hans')).toBe(TINGTING_ENHANCED)
    expect(bestVoice([TINGTING_ENHANCED, MEIJIA_PREMIUM], 'zh-Hant')).toBe(MEIJIA_PREMIUM)
  })

  it('separates two scripts of one language beyond Chinese', () => {
    const latin = voice('Nikola', 'sr-Latn', 'com.apple.voice.enhanced.sr-Latn.Nikola')
    const cyrillic = voice('Sofija', 'sr-Cyrl', 'com.apple.voice.enhanced.sr-Cyrl.Sofija')
    expect(bestVoice([latin, cyrillic], 'sr-Cyrl')).toBe(cyrillic)
    expect(bestVoice([cyrillic, latin], 'sr-Latn')).toBe(latin)
  })

  it('still picks a wrong-script voice when it is the only one', () => {
    /* ⚠️ **AND THIS IS WHY SCRIPT IS A RANK AND NOT A GATE.** A wrong accent is
       not an inability to say the words; refusing it would leave the book
       unread when a voice that can read it is there. */
    expect(bestVoice([MEIJIA_PREMIUM], 'zh-CN')).toBe(MEIJIA_PREMIUM)
    expect(bestVoice([TINGTING_ENHANCED], 'zh-TW')).toBe(TINGTING_ENHANCED)
  })

  it('is not thrown by a tag no runtime can parse', () => {
    expect(() => bestVoice([TINGTING_ENHANCED], 'not a tag!!')).not.toThrow()
    /* A VALID primary subtag with a remainder `Intl.Locale` refuses: the script
       is unknown, so the voice ranks with a wrong-script one rather than below
       it. (`zh!!!` reads no `zh` at all, so nothing matches and null is right.) */
    expect(bestVoice([TINGTING_ENHANCED], 'zh-Hans-!!!')).toBe(TINGTING_ENHANCED)
    expect(bestVoice([TINGTING_ENHANCED], 'zh!!!')).toBeNull()
  })

  it('does not count two scripts it could not read as the same one', () => {
    /* Neither tag parses, so neither script is known — and two unknowns are not
       a match. Read as one, the broken voice would outrank a real Traditional
       voice for this (equally broken) Simplified tag. */
    const broken = voice('Broken', 'zh-!!!', 'com.apple.voice.enhanced.zh.Broken')
    expect(bestVoice([broken, MEIJIA_PREMIUM], 'zh-Hans-!!!')).toBe(MEIJIA_PREMIUM)
  })

  it('matches no voice to a tag that names no language', () => {
    /* `-x` has an empty primary subtag; a voice that declares no language must
       not be taken for one that speaks it. */
    expect(bestVoice([voice('Nameless', '', 'urn:tts:nameless')], '-x')).toBeNull()
  })

  it('keeps language above every tier, by construction', () => {
    /* The weight is derived from the tier table rather than written as `10`, so
       changing the tiers cannot silently invert the policy. */
    expect(bestVoice([AVA_PREMIUM, TINGTING_ENHANCED], 'zh-CN')).toBe(TINGTING_ENHANCED)
  })
})

describe('chosenVoice', () => {
  const installed = [ZOE_ENHANCED, AVA_PREMIUM, TINGTING_ENHANCED, MEIJIA_ENHANCED]

  it('honours a choice stored for the document language', () => {
    expect(chosenVoice(installed, 'en-US', { en: ZOE_ENHANCED.voiceURI })).toBe(ZOE_ENHANCED)
  })

  it('serves a zh-TW book from a choice made on a zh-CN one', () => {
    expect(chosenVoice(installed, 'zh-TW', { zh: MEIJIA_ENHANCED.voiceURI })).toBe(MEIJIA_ENHANCED)
  })

  /**
   * ⚠️ **A SIMPLIFIED VOICE WAS USED FOR A TRADITIONAL BOOK.** The choice is
   * stored under the primary language — `zh` for both — so Tingting, chosen for a
   * mainland book, answered for a Taiwanese one. The stored choice refuses to
   * cross a known script now, and the automatic pick answers instead.
   */
  it('does not read a Traditional book in a voice chosen in Simplified', () => {
    expect(chosenVoice(installed, 'zh-TW', { zh: TINGTING_ENHANCED.voiceURI })).toBeNull()
  })

  it('keeps the chosen voice for a book that names no script and no region', () => {
    expect(chosenVoice(installed, 'zh', { zh: MEIJIA_ENHANCED.voiceURI })).toBe(MEIJIA_ENHANCED)
  })

  it('ignores a choice made for another language', () => {
    expect(chosenVoice(installed, 'zh-CN', { en: AVA_PREMIUM.voiceURI })).toBeNull()
  })

  it('refuses a choice whose language no longer matches the voice', () => {
    expect(chosenVoice(installed, 'zh-CN', { zh: AVA_PREMIUM.voiceURI })).toBeNull()
  })

  it('falls through when the chosen voice is no longer installed', () => {
    expect(chosenVoice(installed, 'en-US', { en: 'com.apple.voice.premium.en-US.Gone' })).toBeNull()
  })

  it('refuses a stored choice for another language even where the scripts agree', () => {
    /* English and French are both Latin script, so the script check cannot be
       what refuses this — the language check has to. */
    expect(chosenVoice([AVA_PREMIUM], 'fr-FR', { fr: AVA_PREMIUM.voiceURI })).toBeNull()
  })

  it('keeps a stored voice whose own tag names no script, for a book that names one', () => {
    const bare = voice('Bare', 'zh', 'com.apple.voice.enhanced.zh.Bare')
    expect(chosenVoice([bare], 'zh-TW', { zh: bare.voiceURI })).toBe(bare)
  })

  it('reads a script the voice tag states outright, with no region to imply one', () => {
    const hant = voice('Hant', 'zh-Hant', 'com.apple.voice.enhanced.zh-Hant.Hant')
    expect(chosenVoice([hant], 'zh-CN', { zh: hant.voiceURI })).toBeNull()
  })

  it('keeps a stored voice whose tag cannot be parsed, as a script it does not know', () => {
    const broken = voice('Broken', 'zh-!!!', 'com.apple.voice.enhanced.zh.Broken')
    expect(chosenVoice([broken], 'zh-TW', { zh: broken.voiceURI })).toBe(broken)
  })

  it("never takes Automatic's empty value for a voice whose identifier is empty", () => {
    /* `''` is what the picker's Automatic row stores. */
    const blank = voice('Blank', 'en-US', '')
    expect(chosenVoice([blank, AVA_PREMIUM], 'en-US', { en: '' })).toBeNull()
  })

  it('honours a language-less choice for a book whose tag is only blanks', () => {
    expect(chosenVoice([AVA_PREMIUM], '   ', { '': AVA_PREMIUM.voiceURI })).toBe(AVA_PREMIUM)
  })

  it('has nothing to honour with no choice, no language, or an empty choice', () => {
    expect(chosenVoice(installed, 'en-US', {})).toBeNull()
    expect(chosenVoice(installed, null, { en: AVA_PREMIUM.voiceURI })).toBeNull()
    expect(chosenVoice(installed, 'en-US', { en: '' })).toBeNull()
  })
})

describe('voiceFor', () => {
  const installed = [ZOE_ENHANCED, SAMANTHA_COMPACT, AVA_PREMIUM]

  it("takes the reader's choice over the better voice", () => {
    expect(voiceFor(installed, 'en-US', { en: ZOE_ENHANCED.voiceURI })).toEqual({ kind: 'voice', voice: ZOE_ENHANCED })
  })

  it('falls back to the best voice when the choice is stale', () => {
    expect(voiceFor(installed, 'en-US', { en: 'com.apple.voice.premium.en-US.Gone' })).toEqual({
      kind: 'voice',
      voice: AVA_PREMIUM,
    })
  })

  it('needs no choice at all', () => {
    expect(voiceFor(installed, 'en-US')).toEqual({ kind: 'voice', voice: AVA_PREMIUM })
  })

  /**
   * ⚠️ **NULL USED TO MEAN "THE PLATFORM'S DEFAULT", WHICH READ THE BOOK ANYWAY.**
   * A book the floor refused every voice for was handed to the platform, which on
   * a Mac chose the compact voice the floor had just refused. `none` is its own
   * answer so the reading can decline.
   */
  it('answers none for a declared language no good voice speaks', () => {
    expect(voiceFor([SAMANTHA_COMPACT, SAMANTHA_SUPER], 'en-US')).toEqual({ kind: 'none' })
    /* A good voice for ANOTHER language is not a reading of this one. */
    expect(voiceFor([AVA_PREMIUM], 'zh-CN')).toEqual({ kind: 'none' })
  })

  it('leaves an engine that has listed nothing to the platform, having nothing to judge', () => {
    /* `getVoices()` is empty until the engine loads its list; refusing on that
       would refuse on silence. */
    expect(voiceFor([], 'en-US')).toEqual({ kind: 'platform' })
    expect(voiceFor([], null)).toEqual({ kind: 'platform' })
  })

  it('leaves a book with no language to the platform when good voices exist', () => {
    /* Choosing one would be choosing the book's language for it. */
    expect(voiceFor([AVA_PREMIUM, SAMANTHA_COMPACT], null)).toEqual({ kind: 'platform' })
    expect(voiceFor([ESPEAK], '   ')).toEqual({ kind: 'platform' })
  })

  it('answers none for a book with no language when nothing clears the floor', () => {
    expect(voiceFor([SAMANTHA_COMPACT, TINGTING_COMPACT], null)).toEqual({ kind: 'none' })
  })
})

describe('voiceOptions', () => {
  const installed = [SAMANTHA_SUPER, ZARVOX, SAMANTHA_COMPACT, BOING, AVA_PREMIUM, ZOE_ENHANCED, TINGTING_ENHANCED]

  it('offers nothing below the floor', () => {
    expect(voiceOptions(installed, 'en-US')).toEqual([AVA_PREMIUM, ZOE_ENHANCED])
  })

  it('offers only voices that speak the language', () => {
    expect(voiceOptions(installed, 'en-US')).not.toContain(TINGTING_ENHANCED)
    expect(voiceOptions(installed, 'zh-CN')).toEqual([TINGTING_ENHANCED])
  })

  it('puts the voice the app would have chosen first', () => {
    /* The invariant that keeps the picker honest: its first row IS the default. */
    for (const lang of ['en-US', 'en-GB', 'zh-CN', 'zh-TW']) {
      expect(voiceOptions(installed, lang)[0] ?? null, lang).toBe(bestVoice(installed, lang))
    }
  })

  it('offers every readable voice when the document declares no language', () => {
    for (const nothing of [null, '', '   ']) {
      expect(voiceOptions(installed, nothing)).toEqual([AVA_PREMIUM, ZOE_ENHANCED, TINGTING_ENHANCED])
    }
  })
})

describe('voiceGroups', () => {
  const installed = [SAMANTHA_SUPER, ZARVOX, SAMANTHA_COMPACT, AVA_PREMIUM, ZOE_ENHANCED, DANIEL_ENHANCED, TINGTING_ENHANCED]

  /**
   * THE GROUPS ARE THE RANKED LIST'S CONSECUTIVE RUNS, not tiers gathered from
   * anywhere in it — so an other-region voice of a tier already seen joins that
   * run only when it comes next in score order, as Daniel does here.
   */
  it('orders the groups the way the voices are actually ranked', () => {
    const groups = voiceGroups(installed, 'en-US')
    expect(groups.map((group) => group.tier)).toEqual(['premium', 'enhanced'])
    expect(groups[1]?.voices).toEqual([ZOE_ENHANCED, DANIEL_ENHANCED])
  })

  it('keeps two voices of one name apart, because the heading is what tells them apart', () => {
    /* Apple ships Ava as both Enhanced and Premium; merged into one group the
       list would show the same word twice. */
    const groups = voiceGroups([AVA_ENHANCED, AVA_PREMIUM], 'en-US')
    expect(groups).toEqual([
      { tier: 'premium', voices: [AVA_PREMIUM] },
      { tier: 'enhanced', voices: [AVA_ENHANCED] },
    ])
  })

  it('drops empty tiers rather than drawing a heading over nothing', () => {
    expect(voiceGroups([TINGTING_ENHANCED], 'zh-CN').map((group) => group.tier)).toEqual(['enhanced'])
  })

  it('offers nothing below the floor and nothing from another language', () => {
    const flat = voiceGroups(installed, 'en-US').flatMap((group) => group.voices)
    for (const refused of [SAMANTHA_SUPER, ZARVOX, SAMANTHA_COMPACT, TINGTING_ENHANCED]) {
      expect(flat).not.toContain(refused)
    }
  })

  it("starts with the app's own choice, like the flat list does", () => {
    expect(voiceGroups(installed, 'en-US')[0]?.voices[0]).toBe(bestVoice(installed, 'en-US'))
  })

  it('groups the whole readable list when the document declares no language', () => {
    expect(voiceGroups(installed, null)).toEqual([
      { tier: 'premium', voices: [AVA_PREMIUM] },
      { tier: 'enhanced', voices: [ZOE_ENHANCED, DANIEL_ENHANCED, TINGTING_ENHANCED] },
    ])
  })
})

describe('a voice the engine speaks on a server', () => {
  it('is never chosen automatically', () => {
    /* Web Speech permits a remote voice, and Paper reads whole sections aloud —
       so choosing one would send a book off the machine. */
    expect(bestVoice([REMOTE], 'en-US')).toBeNull()
    expect(bestVoice([REMOTE, ZOE_ENHANCED], 'en-US')).toBe(ZOE_ENHANCED)
  })

  it('is not offered in the picker', () => {
    expect(voiceOptions([REMOTE, ZOE_ENHANCED], 'en-US')).toEqual([ZOE_ENHANCED])
  })

  it('is refused even when the reader has stored it', () => {
    expect(chosenVoice([REMOTE], 'en-US', { en: REMOTE.voiceURI })).toBeNull()
  })

  it('leaves a book only it could read unread, rather than sending it to the platform', () => {
    /* The hole the old null left open: the platform's default on a machine with
       only remote voices IS remote, so the text went out anyway. */
    expect(voiceFor([REMOTE], 'en-US')).toEqual({ kind: 'none' })
  })

  it('does not refuse a voice that simply did not say', () => {
    /* Absent is unknown, not remote — a fixture and an older engine both land
       there, and refusing on silence would take read-aloud off machines that
       are fine. */
    expect(bestVoice([ZOE_ENHANCED], 'en-US')).toBe(ZOE_ENHANCED)
  })
})

describe('a sound effect the reader has stored', () => {
  it('is refused, so the automatic pick answers instead', () => {
    const installed = [ZARVOX, ZOE_ENHANCED]
    expect(chosenVoice(installed, 'en-US', { en: ZARVOX.voiceURI })).toBeNull()
    expect(voiceFor(installed, 'en-US', { en: ZARVOX.voiceURI })).toEqual({ kind: 'voice', voice: ZOE_ENHANCED })
  })
})

describe('the picker cannot disagree with the choice', () => {
  /**
   * ⚠️ **IT DID.** `voiceGroups` sorted its groups by tier alone, so with an
   * other-region Premium and an exact-language Enhanced installed the first row
   * was the Premium while `bestVoice` took the Enhanced — language outranks tier.
   */
  it('puts the group holding the chosen voice first', () => {
    const premiumElsewhere = voice('Ava', 'en-GB', 'com.apple.voice.premium.en-GB.Ava')
    const installed = [premiumElsewhere, ZOE_ENHANCED]
    const groups = voiceGroups(installed, 'en-US')
    expect(groups[0]?.tier).toBe('enhanced')
    expect(groups[0]?.voices[0]).toBe(bestVoice(installed, 'en-US'))
  })
})

/**
 * ⚠️ **EVERY VOICE OFF APPLE'S PLATFORMS SCORES THE SAME, SO THE TIEBREAK IS
 * THE WHOLE DECISION THERE.** `tierOf` answers `unknown` for a `voiceURI` it
 * cannot parse, and only Apple spells them the way it parses — so on Windows,
 * on Linux, on Android and in a browser on any of them, every same-language
 * voice ties, and the engine's own default is the only signal there is.
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

  it("takes the engine's own default over the one that merely came first", () => {
    expect(bestVoice([zira, david], 'en-US')).toBe(david)
  })

  it('offers it first in the picker too, so the two still cannot disagree', () => {
    const installed = [zira, david]
    expect(voiceOptions(installed, 'en-US')[0]).toBe(bestVoice(installed, 'en-US'))
  })

  it('falls back to the engine order when nothing claims to be the default', () => {
    /* STABILITY IS THE POINT: the same book must get the same voice twice. */
    expect(bestVoice([zira, { ...david, default: false }], 'en-US')).toBe(zira)
  })

  it('never lets the default outrank a legible tier', () => {
    const defaultEnhanced = { ...ZOE_ENHANCED, default: true }
    expect(bestVoice([defaultEnhanced, AVA_PREMIUM], 'en-US')).toBe(AVA_PREMIUM)
  })

  it('never lets the default outrank the language', () => {
    const defaultEnglish = { ...ZOE_ENHANCED, default: true }
    expect(bestVoice([defaultEnglish, TINGTING_ENHANCED], 'zh-CN')).toBe(TINGTING_ENHANCED)
  })

  it('never lets the default lift a voice over the floor', () => {
    /* WebKit flags EVERY voice default — measured 2026-09-21 — so the flag on a
       compact voice or a sound effect says nothing, and lifts nothing. */
    expect(bestVoice([{ ...ZARVOX, default: true }], 'en-US')).toBeNull()
    expect(bestVoice([{ ...SAMANTHA_COMPACT, default: true }], 'en-US')).toBeNull()
  })
})

describe('a book that declares no language', () => {
  const installed = [SAMANTHA_SUPER, ZARVOX, SAMANTHA_COMPACT, TINGTING_ENHANCED, REMOTE, ALEX, AVA_PREMIUM]

  /**
   * ⚠️ **THE PICKER USED TO BE EMPTY HERE, AND THE GROUP WAS HIDDEN.** A book
   * with no `dc:language` is exactly where `bestVoice` declines — so the one
   * case the reader most needed to correct was the one with no control in it.
   */
  it('offers every readable voice rather than nothing', () => {
    expect(voiceOptions(installed, null)).toEqual([AVA_PREMIUM, TINGTING_ENHANCED])
  })

  it('still refuses to guess a language automatically', () => {
    expect(bestVoice(installed, null)).toBeNull()
  })

  it("honours the reader's choice, which is the whole point", () => {
    expect(voiceFor(installed, null, { '': TINGTING_ENHANCED.voiceURI })).toEqual({
      kind: 'voice',
      voice: TINGTING_ENHANCED,
    })
  })

  it('refuses a stored choice below the floor, or a remote one', () => {
    for (const refused of [ZARVOX, REMOTE, SAMANTHA_COMPACT, ALEX]) {
      expect(chosenVoice(installed, null, { '': refused.voiceURI }), refused.name).toBeNull()
    }
  })

  it('does not let a language-less choice answer for a book that names one', () => {
    /* `''` is its own key, not a wildcard. */
    expect(chosenVoice(installed, 'zh-CN', { '': AVA_PREMIUM.voiceURI })).toBeNull()
    expect(voiceFor(installed, 'zh-CN', { '': AVA_PREMIUM.voiceURI })).toEqual({
      kind: 'voice',
      voice: TINGTING_ENHANCED,
    })
  })

  it('and a language choice does not answer for a book with none', () => {
    expect(chosenVoice(installed, null, { en: AVA_PREMIUM.voiceURI })).toBeNull()
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

describe('what the reader is told', () => {
  it('says nothing good enough is available here — not to install a voice, which on a Mac is false advice', () => {
    expect(NO_GOOD_VOICE).toBe('No high-quality voice can read this book here, so it is not read in a low-quality one.')
  })
})
