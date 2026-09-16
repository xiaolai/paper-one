import { describe, expect, it } from 'vitest'
import {
  ANSWER_CHOICES,
  ANSWER_LANGUAGES,
  FALLBACK_LANGUAGE,
  answerLabel,
  answerLanguages,
  isAnswerChoice,
  readerLanguage,
  supportedLanguage,
} from './glossLanguage'
import { KERNEL_SETTINGS } from './settings'

/**
 * The answer language (WI-17.5). The list is measured, not chosen — see the
 * module's header — so what these pin is the RESOLUTION: which tag means which
 * supported language, and what each choice falls back to.
 */

const tagOf = (tag: string | undefined) => supportedLanguage(tag)?.tag ?? null

describe('supportedLanguage', () => {
  it.each([
    ['en', 'en'],
    ['en-US', 'en'],
    ['en-GB', 'en'],
    ['pt-BR', 'pt'],
    ['es-419', 'es'],
    ['fr-CA', 'fr'],
    ['de-AT', 'de'],
    ['it', 'it'],
    ['vi-VN', 'vi'],
    ['ko-KR', 'ko'],
  ])('reads %s as %s — the language, whatever the region', (tag, expected) => {
    expect(tagOf(tag)).toBe(expected)
  })

  /* THE SCRIPT IS THE LANGUAGE A CHINESE READER READS. Simplified by region
     and by script alike; Traditional is not offered, because the model
     answered it in Simplified characters. */
  it.each([
    ['zh', 'zh-Hans'],
    ['zh-CN', 'zh-Hans'],
    ['zh-SG', 'zh-Hans'],
    ['zh-Hans', 'zh-Hans'],
    ['zh-Hans-HK', 'zh-Hans'],
  ])('reads %s as Simplified Chinese', (tag, expected) => {
    expect(tagOf(tag)).toBe(expected)
  })

  it.each(['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant'])('does not offer %s as Simplified by another name', (tag) => {
    expect(tagOf(tag)).toBeNull()
  })

  /* Measured poor — see the evidence file. A reader on one of these systems
     gets a fallback, not an answer the model gave badly. */
  it.each(['ja', 'ru', 'ar', 'fi', 'th', 'nl'])('does not offer %s', (tag) => {
    expect(tagOf(tag)).toBeNull()
  })

  /* EPUBs ship `lang="en_US"`. */
  it('reads an underscore where a hyphen belongs', () => {
    expect(tagOf('en_US')).toBe('en')
  })

  /* A tag read out of a document's `lang` attribute can carry the spaces its
     markup had around it, and `Intl.Locale` refuses a padded one. */
  it('reads a tag with spaces around it', () => {
    expect(tagOf('  en-US ')).toBe('en')
  })

  it('is null for nothing, for whitespace, and for a tag that will not parse', () => {
    expect(tagOf(undefined)).toBeNull()
    expect(tagOf('  ')).toBeNull()
    expect(tagOf('not a tag!')).toBeNull()
  })
})

describe('readerLanguage', () => {
  it('is the reader’s language when Paper answers in it, English otherwise', () => {
    expect(readerLanguage('de-DE').tag).toBe('de')
    expect(readerLanguage('ja-JP')).toBe(FALLBACK_LANGUAGE)
    expect(readerLanguage(undefined)).toBe(FALLBACK_LANGUAGE)
  })
})

describe('answerLanguages', () => {
  const tags = (...args: Parameters<typeof answerLanguages>) => answerLanguages(...args).map((one) => one.tag)

  it('answers in the reader’s language by default', () => {
    expect(tags('reader', { reader: 'zh-CN', book: 'en' })).toEqual(['zh-Hans'])
  })

  it('answers in the book’s language for an immersion reader', () => {
    expect(tags('book', { reader: 'zh-CN', book: 'en-US' })).toEqual(['en'])
  })

  /* A Chinese reader with a Japanese book: the book's language is not one
     Paper answers well in, and the language they read beats one nobody chose. */
  it('falls back from an unsupported book language to the reader’s, not to English', () => {
    expect(tags('book', { reader: 'zh-CN', book: 'ja' })).toEqual(['zh-Hans'])
  })

  it('answers in both, the book’s language first', () => {
    expect(tags('both', { reader: 'zh-CN', book: 'en' })).toEqual(['en', 'zh-Hans'])
  })

  it('asks once when the book and the reader share a language', () => {
    expect(tags('both', { reader: 'en-GB', book: 'en-US' })).toEqual(['en'])
  })

  it('answers in a named language whatever the reader and book are', () => {
    expect(tags('es', { reader: 'zh-CN', book: 'en' })).toEqual(['es'])
  })

  it('falls back to English for a reader Paper does not answer in', () => {
    expect(tags('reader', { reader: 'ru-RU', book: 'en' })).toEqual(['en'])
    expect(tags('both', { reader: 'ru-RU', book: 'fr' })).toEqual(['fr', 'en'])
  })

  /* THE RESOLVER'S OWN DEFENCE, and not what a reader with such a file meets:
     the setting refuses a tag that is off the list before it gets here — see
     the next case. A caller that skipped the setting still must not send a
     language measured to be poor. */
  it('answers in English for a named tag that is not on the list', () => {
    expect(tags('ja' as never, { reader: 'zh-CN', book: 'en' })).toEqual(['en'])
  })

  /* WHAT A STORED TAG A LATER BUILD DROPPED ACTUALLY BECOMES — found by the
     2026-09-13 audit, against a comment here that said English. The setting
     reads it as its own fallback, `reader`, so a Chinese reader gets Chinese. */
  it('reads a stored tag that is off the list as the reader’s own language', () => {
    const setting = KERNEL_SETTINGS.lookUpLanguage
    const choice = setting.parse('ja') ?? setting.fallback

    expect(choice).toBe('reader')
    expect(tags(choice, { reader: 'zh-CN', book: 'en' })).toEqual(['zh-Hans'])
  })
})

describe('the setting’s values', () => {
  it('are the three modes, then every language, in order', () => {
    expect(ANSWER_CHOICES).toEqual(['reader', 'book', 'both', ...ANSWER_LANGUAGES.map((one) => one.tag)])
  })

  it('accept exactly those', () => {
    expect(ANSWER_CHOICES.every(isAnswerChoice)).toBe(true)
    expect(isAnswerChoice('ja')).toBe(false)
    expect(isAnswerChoice('')).toBe(false)
    expect(isAnswerChoice(3)).toBe(false)
  })

  /* THE FALLBACK AND CHINESE ARE NAMED, NOT FOUND BY POSITION — found by the
     2026-09-13 audit. They were read as `[0]` and `[1]`, so reordering the list
     the Settings pane shows would have changed what a lookup answers in, with no
     type error to say so. English still leads the list; nothing reads that. */
  it('fall back to English, which is on the list', () => {
    expect(FALLBACK_LANGUAGE.tag).toBe('en')
    expect(ANSWER_LANGUAGES).toContain(FALLBACK_LANGUAGE)
  })

  it('resolve Chinese to the list’s own Simplified Chinese', () => {
    expect(supportedLanguage('zh-CN')).toBe(ANSWER_LANGUAGES.find((one) => one.tag === 'zh-Hans'))
  })
})

describe('answerLabel', () => {
  it('files the tags in order', () => {
    expect(answerLabel(answerLanguages('both', { reader: 'zh-CN', book: 'en' }))).toBe('en+zh-Hans')
    expect(answerLabel([])).toBe('')
  })
})
