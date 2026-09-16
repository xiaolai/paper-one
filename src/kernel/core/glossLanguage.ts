/**
 * The language a definition is written in (phase 17, WI-17.5).
 *
 * A READER'S SETTING, NOT A DEFAULT SOMEBODY CHOSE. Paper is read worldwide,
 * and a dictionary that answers in the language whoever wrote it happened to
 * speak is useful in one country. Four answers cover the world without becoming
 * a language table the reader has to walk:
 *
 * | Choice   | For |
 * |---|---|
 * | `reader` | everyone, out of the box — the app's locale (the default) |
 * | `book`   | an immersion learner who wants a monolingual definition |
 * | `both`   | the 双语 case — the book's language, then the reader's |
 * | a tag    | a reader whose system locale is not the language they learn in |
 *
 * ## The list is CURATED, and it was measured before it was written
 *
 * Offering a language is not a promise the model is good in it, and a list that
 * quietly returns poor Finnish is not a product. On 2026-09-13 the shipped model
 * (Qwen3-4B-Instruct-2507, Q4_K_M) was asked to define the same words in 24
 * languages through the real `inference_gloss` command; the transcript is
 * `dev-docs/plans/evidence/wi-17-5-answer-languages.md`. What is below is what
 * came back with the RIGHT SENSE IN THE LANGUAGE ASKED. Everything else came
 * back with a wrong sense, broken grammar, or — Traditional Chinese — the right
 * words in the wrong script, and is not offered.
 *
 * ⚠️ **THE AUTOMATIC CHOICES OBEY THE SAME LIST.** `reader` on a Japanese
 * system, or `book` on a Russian book, would otherwise route around the curation
 * and produce exactly the answers it exists to refuse. An unsupported language
 * falls back — `book` to the reader's language, the reader's to English — and
 * the Settings row names what the choice actually resolves to, so the fallback
 * is visible rather than silent.
 *
 * The SOURCE language is not limited by any of this: a Chinese or Japanese
 * sentence defined in English measured as well as an English one.
 */

export interface AnswerLanguage {
  /** BCP 47, as it is filed on a recorded lookup. */
  readonly tag: string
  /** In English — what the model is told. */
  readonly name: string
  /** In itself — what the reader is shown. */
  readonly label: string
}

/* NAMED, because two of them are read by name: `FALLBACK_LANGUAGE`, and the
   Chinese branch of `supportedLanguage`. Both used to be read by POSITION —
   `[0]` and `[1]` — so reordering the list the Settings pane shows would have
   changed what a lookup answers in, with no type error to say so (2026-09-13
   audit). */
const ENGLISH = { tag: 'en', name: 'English', label: 'English' } as const
const SIMPLIFIED_CHINESE = { tag: 'zh-Hans', name: 'Simplified Chinese', label: '简体中文' } as const

/** The languages Paper answers in, in the order the Settings list shows them. Nothing reads a position in it. */
export const ANSWER_LANGUAGES = [
  ENGLISH,
  SIMPLIFIED_CHINESE,
  { tag: 'es', name: 'Spanish', label: 'Español' },
  { tag: 'fr', name: 'French', label: 'Français' },
  { tag: 'de', name: 'German', label: 'Deutsch' },
  { tag: 'pt', name: 'Portuguese', label: 'Português' },
  { tag: 'it', name: 'Italian', label: 'Italiano' },
  { tag: 'vi', name: 'Vietnamese', label: 'Tiếng Việt' },
  { tag: 'ko', name: 'Korean', label: '한국어' },
] as const satisfies readonly AnswerLanguage[]

export const FALLBACK_LANGUAGE: AnswerLanguage = ENGLISH

export type AnswerLanguageTag = (typeof ANSWER_LANGUAGES)[number]['tag']

export const ANSWER_MODES = ['reader', 'book', 'both'] as const
export type AnswerMode = (typeof ANSWER_MODES)[number]

/** What the setting stores: one of the three modes, or a language by tag. */
export type AnswerChoice = AnswerMode | AnswerLanguageTag

/** Every value the setting may hold, in the order the Settings list shows them. */
export const ANSWER_CHOICES: readonly AnswerChoice[] = [...ANSWER_MODES, ...ANSWER_LANGUAGES.map((one) => one.tag)]

export function isAnswerChoice(value: unknown): value is AnswerChoice {
  /* No `typeof` beside it: the list holds only strings, so it already refuses
     everything that is not one — a second check nothing could observe. */
  return (ANSWER_CHOICES as readonly unknown[]).includes(value)
}

/**
 * The supported language a locale tag means, or `null` when Paper does not
 * answer in it.
 *
 * BY LANGUAGE, NOT BY THE WHOLE TAG — `en-GB`, `pt-BR` and `es-419` are the
 * languages the list names — EXCEPT for Chinese, where the SCRIPT is the
 * language a reader reads. `zh-TW` and `zh-HK` maximise to Traditional, which
 * the model did not honour, so they are not Simplified by another name.
 * `Intl.Locale.maximize` is what knows `zh-SG` is Simplified and `zh-MO` is not;
 * a table of region codes here would be a worse copy of CLDR.
 *
 * TOTAL. An EPUB's `lang="en_US"` has the underscore a BCP 47 parser refuses,
 * and a malformed tag must cost the reader a fallback, never their lookup.
 */
export function supportedLanguage(tag: string | undefined): AnswerLanguage | null {
  /* SAID IN WORDS, because a passage with no `lang` is the ordinary case and
     should not read as an exception — `Intl.Locale` would throw on it and the
     `catch` below would answer the same `null`.

     ⚠️ **AND THE BLANK TAG BESIDE IT HID FOUR MUTANTS THAT TESTS KILL.**
     `|| tag.trim() === ''` really was undecidable — a blank tag reaches
     `Intl.Locale` as `''`, which it refuses — but the directive that said so
     disabled every ConditionalExpression on the line, this guard's own "refuse
     every tag" and "read `undefined.trim()`" among them (2026-09-14). A blank
     `lang` is malformed like `en_US`, so it takes the malformed tag's path and
     nothing here is disabled. */
  if (tag === undefined) return null
  /* The `try` covers the parse and nothing else: cleaning a tag cannot throw,
     and with the cleaning inside it an absent tag was answered by the `catch`,
     where the guard above could not be told from its absence. */
  const cleaned = tag.trim().replace(/_/gu, '-')
  let locale: Intl.Locale
  try {
    locale = new Intl.Locale(cleaned)
  } catch {
    return null
  }
  if (locale.language === 'zh') return locale.maximize().script === 'Hans' ? SIMPLIFIED_CHINESE : null
  return ANSWER_LANGUAGES.find((one) => one.tag === locale.language) ?? null
}

/**
 * One language, or two in order — never none, and never three. See
 * `GlossContext.answerIn`.
 *
 * ⚠️ **THE TYPE SAID "ONE OR MORE" WHILE THIS LINE SAID "ONE OR TWO"**, so a
 * type-correct caller could hand a provider five (2026-09-13 audit). The two
 * shapes `answerLanguages` returns are now the only two there are.
 */
export type AnswerLanguages = readonly [AnswerLanguage] | readonly [AnswerLanguage, AnswerLanguage]

/** Where the two automatic choices look. */
export interface AnswerContext {
  /** The app's locale — `navigator.language`. */
  readonly reader: string | undefined
  /** The passage's own `lang`, else the book's declared language. */
  readonly book: string | undefined
}

/** The reader's language as the list resolves it — for the lookup and for the row that names it. */
export function readerLanguage(reader: string | undefined): AnswerLanguage {
  return supportedLanguage(reader) ?? FALLBACK_LANGUAGE
}

/**
 * What to answer in: one language, or two in order.
 *
 * `book` FALLS BACK TO THE READER'S LANGUAGE, not to English. A Chinese reader
 * with a Japanese book and `book` chosen cannot have a Japanese definition
 * worth reading, and the language they read is a better second choice than
 * one nobody chose.
 *
 * `both` IS THE BOOK'S LANGUAGE FIRST — the monolingual sense, then the
 * translation — and collapses to one when the two are the same, rather than
 * asking the model for the same sentence twice.
 *
 * A named tag that is not on the list answers in English rather than in a
 * language measured to be poor. ⚠️ **THAT IS THIS FUNCTION'S OWN DEFENCE, AND
 * THIS PARAGRAPH SAID IT WAS WHAT A STORED TAG BECOMES — IT IS NOT.** A tag a
 * later build dropped never reaches here from the reader's file: the
 * `lookUpLanguage` setting in `settings.ts` refuses it and reads the choice as
 * `reader`, so a Chinese reader gets Chinese (2026-09-13 audit). English is for
 * a caller that skipped the setting.
 */
export function answerLanguages(choice: AnswerChoice, context: AnswerContext): AnswerLanguages {
  const reader = readerLanguage(context.reader)
  if (choice === 'reader') return [reader]
  const book = supportedLanguage(context.book) ?? reader
  if (choice === 'book') return [book]
  if (choice === 'both') return book.tag === reader.tag ? [book] : [book, reader]
  return [ANSWER_LANGUAGES.find((one) => one.tag === choice) ?? FALLBACK_LANGUAGE]
}

/** What a recorded lookup files as its language: the tags, in order. */
export function answerLabel(languages: readonly AnswerLanguage[]): string {
  return languages.map((one) => one.tag).join('+')
}
