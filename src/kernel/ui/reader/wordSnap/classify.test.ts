import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isSnappableScript, isWordLike, resolveSegmenterLocale } from './classify'
import { DOM_IDENTIFIERS, importSpecifiers, scan } from './sourceScan.testkit'

/**
 * Segments of a string, by the same real `Intl.Segmenter` the reader uses.
 *
 * Real ICU, never a fixture list of pre-split strings: the point of the
 * mixed-script case below is that the segmentation and the classification are
 * asserted together, so a shift in either one is visible.
 */
function wordSegments(text: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
  return [...segmenter.segment(text)].map((part) => part.segment)
}

describe('isWordLike', () => {
  /*
   * The whole reason this function exists rather than reading the segment
   * record's own `isWordLike` flag. Node's ICU calls `3.14`, `1,000` and `42`
   * word-like; WebKit does not. `10km` is word-like in both, which is what
   * makes a flag-reading implementation look fine on the first case anyone
   * tries. Classification is by character, so both engines agree.
   */
  const wordLike: ReadonlyArray<readonly [string, string]> = [
    ['a decimal', '3.14'],
    ['a grouped integer', '1,000'],
    ['a bare integer', '42'],
    ['a measurement', '10km'],
    // Breaks any implementation reaching for /[0-9]/ instead of \p{N}.
    ['Arabic-Indic digits', '٤٢'],
    ['a plain word', 'English'],
  ]

  it.each(wordLike)('%s (%j) is word-like', (_label, segment) => {
    expect(isWordLike(segment)).toBe(true)
  })

  /*
   * Emoji are So and the zero-width joiner is Cf, so both slip past a
   * punctuation-based test; the soft hyphen and word joiner are Cf too. A lone
   * Format character is not a word — the complement of WI-3's rule that a
   * Format character INSIDE a word does not break it.
   */
  const notWordLike: ReadonlyArray<readonly [string, string]> = [
    ['plus', '+'],
    ['em dash U+2014', '—'],
    ['left double quote U+201C', '“'],
    ['right single quote U+2019', '’'],
    ['one space', ' '],
    ['two spaces', '  '],
    ['a newline', '\n'],
    ['a lone soft hyphen U+00AD', '­'],
    ['a lone word joiner U+2060', '⁠'],
    ['an emoji', '\u{1F600}'],
    ['a ZWJ emoji sequence', '\u{1F469}‍\u{1F680}'],
  ]

  it.each(notWordLike)('%s (%j) is not word-like', (_label, segment) => {
    expect(isWordLike(segment)).toBe(false)
  })

  const degenerate: ReadonlyArray<readonly [string, string]> = [
    ['the empty string', ''],
    ['a lone high surrogate', '\uD800'],
    ['a lone low surrogate', '\uDC00'],
  ]

  it.each(degenerate)('%s (%j) is not word-like and does not throw', (_label, segment) => {
    expect(() => isWordLike(segment)).not.toThrow()
    expect(isWordLike(segment)).toBe(false)
  })
})

describe('isSnappableScript', () => {
  /*
   * Six scripts, one row each rather than one lumped assertion, so dropping a
   * single script from the block list fails a named row.
   */
  const blocked: ReadonlyArray<readonly [string, string]> = [
    ['Han', '中文'],
    ['Han, second sample', '测试'],
    ['Hiragana', 'ここ'],
    ['Katakana', 'カタカナ'],
    ['Thai', 'สวัสดี'],
    ['Lao', 'ລາວ'],
    ['Khmer', 'ខ្មែរ'],
    ['Myanmar', 'မြန်မာ'],
  ]

  it.each(blocked)('%s (%j) is not snappable', (_label, segment) => {
    expect(isSnappableScript(segment)).toBe(false)
  })

  /*
   * U+30FC is Script=Common. An implementation written with `\p{Script=...}`
   * — the plausible one — calls it neutral and therefore snappable, and the
   * bug surfaces only on Japanese text carrying a long-vowel mark.
   * Script_Extensions gives Hiragana + Katakana, which is the right answer.
   */
  it('resolves U+30FC through Script_Extensions to Kana, not Common', () => {
    expect(isSnappableScript('ー')).toBe(false)
    // The same character as ICU actually hands it over, third segment.
    expect(wordSegments('ここでーす')[2]).toBe('ー')
    expect(isSnappableScript(wordSegments('ここでーす')[2] ?? '')).toBe(false)
  })

  /*
   * U+3099 is Script=Inherited. Reading it as neutral, or as "adopt whatever
   * the neighbouring character is" by string adjacency, returns true.
   */
  it('resolves U+3099 through Script_Extensions, not to Inherited', () => {
    expect(isSnappableScript('゙')).toBe(false)
    expect(isSnappableScript('が')).toBe(false)
  })

  /*
   * The pair is the assertion. Under a code-unit loop — `for (let i = 0; i <
   * s.length; i++)` or `s.split('')` — U+20000 decomposes into two surrogate
   * halves, each Script=Unknown and therefore unblocked, so astral CJK
   * silently becomes snappable and returns the same answer as the lone
   * surrogate. Two different answers is what proves the walk is by code point.
   */
  it('classifies astral Han by code point, not by code unit', () => {
    expect(isSnappableScript('\u{20000}')).toBe(false)
    expect(isSnappableScript('\uD840')).toBe(true)
  })

  /*
   * Deciding from the first code point makes 'ab中' snappable; deciding from
   * the last makes '中ab' snappable. Both orders present, so neither shortcut
   * survives.
   */
  const mixedBlocked: ReadonlyArray<readonly [string, string]> = [
    ['Latin then Han', 'ab中'],
    ['Han then Latin', '中ab'],
    ['Latin around astral Han', 'a\u{20000}b'],
  ]

  it.each(mixedBlocked)('%s (%j) is not snappable', (_label, segment) => {
    expect(isSnappableScript(segment)).toBe(false)
  })

  /*
   * The behaviour the per-edge gate exists for: an English word inside a
   * Chinese sentence still snaps. Gating on the document language, or on the
   * surrounding text, makes this false.
   *
   * Segmentation and classification are asserted together so a change in ICU's
   * splitting shows up as a failure rather than being absorbed.
   *
   * NOTE — this expectation diverges from the test matrix, which has
   * [false, false, false, true, false, false], marking the two space segments
   * unsnappable. That value cannot be reconciled with the astral case in the
   * same section, which requires `isSnappableScript('\uD840')` to be `true`:
   * a lone surrogate carries no more word content than a space does, so no
   * single rule returns `true` for one and `false` for the other except by
   * special-casing whitespace. Choosing the special case would also break
   * WI-3's "an edge in whitespace trims inward" — a gate that fails on
   * whitespace stops the trim. So the contract implemented here is the narrow
   * one the plan's acceptance criteria describe: NOT snappable exactly when
   * the segment contains a character from a blocked script. Everything else,
   * space and lone surrogate alike, is transparent to the gate.
   */
  it('keeps a Latin segment snappable regardless of what surrounds it', () => {
    const segments = wordSegments('读一段 English 文字')

    expect(segments).toEqual(['读', '一段', ' ', 'English', ' ', '文字'])
    expect(segments.map(isSnappableScript)).toEqual([false, false, true, true, true, false])
  })

  /* Pins the clause above as a decision rather than an accident: the gate
   * blocks scripts, and nothing else. WI-3 relies on this to trim an edge
   * sitting in whitespace or punctuation inward to the neighbouring word. */
  it('is transparent to segments that carry no blocked script', () => {
    expect(isSnappableScript(' ')).toBe(true)
    expect(isSnappableScript('+')).toBe(true)
    expect(isSnappableScript('')).toBe(true)
    expect(isSnappableScript('42')).toBe(true)
  })
})

/*
 * Every input below was measured against this machine's `Intl` before being
 * written down. The lists are shared between the cases so that the totality
 * check at the end covers exactly the same inputs the individual cases pin,
 * rather than a hand-copied subset that can drift away from them.
 */

/** Underscore spellings, as they arrive from a real EPUB's `lang` attribute.
 *  `new Intl.Segmenter('en_US')` throws; `'en-US'` does not. */
const UNDERSCORE_LOCALES: ReadonlyArray<readonly [string, string]> = [
  ['en_US', 'en-US'],
  // Not an `en` tag on purpose: see the note on the round-trip list below.
  ['zh_Hans_CN', 'zh-Hans-CN'],
]

/** Each one measured to make `new Intl.Segmenter` throw. */
const MALFORMED_LOCALES: ReadonlyArray<readonly [string, string]> = [
  ['the empty string', ''],
  ['punctuation', '???'],
  ['a one-letter subtag', 'x'],
  ['the C locale', 'C'],
  ['a grandfathered tag', 'i-klingon'],
  ['a leading separator', '-en'],
  ['a trailing separator', 'en-'],
  ['an empty extension', 'en-u-'],
  ['a digit', '0'],
  ['an emoji', '\u{1F600}'],
  ['200 characters', 'a'.repeat(200)],
  ['a space where a hyphen belongs', 'en US'],
]

/** Both spellings of "absent": `getAttribute('lang')` gives `null` on an unset
 *  attribute, `element.lang` gives `''`. The empty string is already in the
 *  malformed list, which is where it resolves from. */
const ABSENT_LOCALES: ReadonlyArray<readonly [string, string | null | undefined]> = [
  ['null', null],
  ['undefined', undefined],
]

/** Constructs as-is, so it is returned as-is. */
const WELL_FORMED_LOCALES: readonly string[] = [
  'en',
  'en-GB',
  'zh-Hans',
  'de-DE-u-co-phonebk',
  /* `und` and `qqq` are not real languages and `POSIX` canonicalises to
   * lowercase `posix` — the three that separate pass-through from
   * canonicalisation. */
  'und',
  'qqq',
  'POSIX',
]

describe('resolveSegmenterLocale', () => {
  /*
   * `zh_Hans_CN` is the load-bearing row. This machine's host default is
   * `en-US`, so every `en` fixture is satisfied by a stubbed `return undefined`
   * — it constructs, it resolves to en-something, it segments. Asserting the
   * returned string for a NON-default locale is the only assertion here that a
   * "return undefined when in doubt" implementation cannot pass.
   */
  it.each(UNDERSCORE_LOCALES)('repairs %j to %j', (raw, expected) => {
    expect(resolveSegmenterLocale(raw)).toBe(expected)
  })

  it.each(MALFORMED_LOCALES)('degrades %s (%j) to the host default', (_label, raw) => {
    expect(() => resolveSegmenterLocale(raw)).not.toThrow()
    expect(resolveSegmenterLocale(raw)).toBeUndefined()
  })

  /* Not `toBe('en')`: `makePdf.ts` hardcodes `lang="en"` on its generated
   * pages and EPUBs supply neither spelling, so "absent" must mean the host's
   * own locale rather than a guess baked into this module. */
  it.each(ABSENT_LOCALES)('resolves %s to the host default', (_label, raw) => {
    expect(resolveSegmenterLocale(raw)).toBeUndefined()
  })

  it.each(WELL_FORMED_LOCALES)('returns %j unchanged', (raw) => {
    expect(resolveSegmenterLocale(raw)).toBe(raw)
  })

  /*
   * The acceptance criterion that cannot be met by a regex: validation is by
   * construction, so a tag that merely LOOKS like a tag — `i-klingon` passes
   * any plausible shape check — still degrades instead of throwing later, deep
   * inside the selection publish path.
   *
   * Constructing is not the whole assertion; the Segmenter is made to do real
   * work, because a tag that is accepted but unusable would pass a bare
   * construction check.
   */
  it('returns only values that construct a working Segmenter, for every input', () => {
    const inputs: ReadonlyArray<string | null | undefined> = [
      ...UNDERSCORE_LOCALES.map(([raw]) => raw),
      ...MALFORMED_LOCALES.map(([, raw]) => raw),
      ...ABSENT_LOCALES.map(([, raw]) => raw),
      ...WELL_FORMED_LOCALES,
    ]

    const resolved = inputs.map((raw) => {
      expect(() => resolveSegmenterLocale(raw)).not.toThrow()
      return resolveSegmenterLocale(raw)
    })

    for (const locale of resolved) {
      const segmenter = new Intl.Segmenter(locale, { granularity: 'word' })
      expect([...segmenter.segment('the quick brown fox')]).toHaveLength(7)
    }

    /* Non-vacuity. Without this the loop above is satisfied by a function that
     * returns `undefined` for everything, since `undefined` constructs. */
    expect(resolved.filter((locale) => locale !== undefined)).toHaveLength(
      UNDERSCORE_LOCALES.length + WELL_FORMED_LOCALES.length,
    )
  })
})

const SOURCE_PATH = fileURLToPath(new URL('./classify.ts', import.meta.url))

describe('classify.ts is a pure module', () => {
  /*
   * The vitest lane has no DOM environment, and this asserts it out loud.
   * Without the guard, purity is enforced by an environment nobody is
   * watching: switching the config to `environment: 'jsdom'` would let DOM
   * access creep into this module with the suite still green.
   */
  it('runs with no DOM globals present at all', () => {
    expect(globalThis.document).toBeUndefined()
    expect(globalThis.window).toBeUndefined()
    expect(globalThis.getSelection).toBeUndefined()
    // And the module still answers, in that environment.
    expect(isWordLike('word')).toBe(true)
    expect(isSnappableScript('word')).toBe(true)
    expect(resolveSegmenterLocale('zh_Hans_CN')).toBe('zh-Hans-CN')
  })

  it('strips comments and string contents before the identifier scan', () => {
    const sample = "// no Selection here\nconst a = 'window'\n/* Range */\nconst b = a\n"
    const { codeOnly } = scan(sample)

    expect(codeOnly).toBe("\nconst a = ''\n\nconst b = a\n")
    expect(codeOnly.match(DOM_IDENTIFIERS)).toBeNull()
  })

  it('finds specifiers that leave the wordSnap directory', () => {
    const sample = "import { publish } from '../session'\nimport './sibling'\n"

    expect(importSpecifiers(sample)).toEqual(['../session', './sibling'])
  })

  it('names no DOM identifier outside its own prose', () => {
    const raw = readFileSync(SOURCE_PATH, 'utf8')
    const { codeOnly } = scan(raw)

    /* Non-vacuity: the module's docstring is required to name what it does not
     * touch, so a raw-source regex would fail on the documentation alone. If
     * this line ever fails, the docstring lost its purity note — restore it
     * rather than deleting this assertion. */
    expect(raw.match(DOM_IDENTIFIERS)).not.toBeNull()
    expect(codeOnly.match(DOM_IDENTIFIERS) ?? []).toEqual([])
  })

  it('imports nothing from outside src/reader/wordSnap/', () => {
    const { withoutComments } = scan(readFileSync(SOURCE_PATH, 'utf8'))
    const outside = importSpecifiers(withoutComments).filter((s) => !s.startsWith('./'))

    expect(outside).toEqual([])
  })
})
