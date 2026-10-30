// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  bodyOf,
  canonicalTextOf,
  extractSections,
  MAX_SECTION_CHARS,
  parseFailed,
} from './passageText'
import { indexText, reanchorIn } from './reanchor'

/**
 * WI-31.0's hand-labelled fixture, and the bake-off it settles.
 *
 * ⚠️ **THE EXPECTED TEXT IS LABELLED BY HAND, NOT TAKEN FROM EITHER WALK.** The
 * plan is explicit that foliate's own in-book search *"is not an oracle for what
 * a searchable passage is"* — it was measured missing ruby base text and `alt`
 * text and matching hidden footnotes and duplicated MathML — so comparing two
 * extractors against each other would only prove they agree.
 *
 * What each row below asserts is what a READER would say is in the chapter.
 */
const parse = (html: string): Document =>
  new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html')

describe('the canonical text of a section', () => {
  it('puts a space at a paragraph break rather than running two words together', () => {
    /* ⚠️ **THE ROW THE PHASE TURNS ON.** Without the block edge this is
     * `doneStart` — a word in neither paragraph, which invents matches that
     * cross a break and loses every real one, because the other side of the
     * comparison HAS the boundary. */
    expect(canonicalTextOf(parse('<p>done</p><p>Start</p>'))).toBe('done Start')
  })

  it('is exactly what the resolver searches, with no extra transform', () => {
    /* The single most important property in the phase: one walk, both ends. */
    const doc = parse('<p>The whale was large.</p>')
    expect(canonicalTextOf(doc)).toBe(indexText(bodyOf(doc)).text)
  })

  it('walks a whole Document, which indexText alone answers empty for', () => {
    /* ⚠️ **THE KNOWN POSITIVE FOR `bodyOf`.** `indexText` dispatches on
     * `nodeType` and a `Document` is 9 — neither element nor text — so the walk
     * returns before descending and the section comes back with no words in it.
     * An index built that way reports success and can never answer a query.
     *
     * This case is here rather than as an assertion about `bodyOf`'s return
     * value because what matters is the CONSEQUENCE: reproduce the empty answer,
     * then show that the module does not have it. `check-browser-safe.mjs`'s
     * rule — *a detector that finds nothing looks exactly like a clean result* —
     * applies to an extractor exactly as well. */
    const doc = parse('<p>The whale was large.</p>')
    expect(indexText(doc).text).toBe('')
    expect(canonicalTextOf(doc)).toBe('The whale was large.')
    // And a body handed over directly is unaffected.
    expect(canonicalTextOf(doc.body)).toBe('The whale was large.')
  })

  it('keeps ruby BASE text, which the reader’s own in-book search misses', () => {
    /* Measured in the plan: foliate's matcher answers 0 for `東京` over this
     * markup. A library hit must not be blind to it. */
    const text = canonicalTextOf(parse('<ruby>東<rt>とう</rt>京<rt>きょ</rt></ruby>'))
    expect(text).toContain('東')
    expect(text).toContain('京')
  })

  it('does not index a script or a stylesheet', () => {
    const text = canonicalTextOf(
      parse('<p>real</p><script>var secret = 1</script><style>.a{color:red}</style>'),
    )
    expect(text).toBe('real')
  })

  it('does index a footnote the reader can reach, because a note is text in the book', () => {
    const text = canonicalTextOf(parse('<p>body</p><aside id="fn1">the note</aside>'))
    expect(text).toContain('the note')
  })

  it('keeps case, because the resolver compares on it', () => {
    /* `reanchor.ts` deliberately does not fold case — *"case is meaningful in a
     * quote"* — and the index text is that same string. Folding happens on the
     * Rust side, for MATCHING only, and the quote handed back is the book's own
     * spelling. */
    expect(canonicalTextOf(parse('<p>The US and us</p>'))).toBe('The US and us')
  })

  it('folds the typography two builds of one work disagree about', () => {
    const curly = canonicalTextOf(parse('<p>“it’s” — so</p>'))
    const straight = canonicalTextOf(parse('<p>"it\'s" — so</p>'))
    expect(curly).toBe(straight)
  })

  it('collapses a run of whitespace, including one made of markup', () => {
    expect(canonicalTextOf(parse('<p>a   b\n\n  c</p>'))).toBe('a b c')
  })

  it('drops a soft hyphen, which is a fact about a line break', () => {
    /* ⚠️ **BUILT FROM ITS CODE POINT, NOT WRITTEN AND NOT ESCAPED.** This line
     * held a RAW soft hyphen until `no-invisible-characters.test.mjs` refused
     * it — because `\u00ad` typed into a tool call is a valid JSON escape and
     * is DECODED before the edit reaches the file, which is the trap AGENTS.md
     * records for `\u2028` and which is invisible in the diff either way.
     * `fromCharCode` cannot be decoded into anything. */
    const soft = String.fromCharCode(0x00ad)
    expect(canonicalTextOf(parse(`<p>hyphen${soft}ation</p>`))).toBe('hyphenation')
  })

  it('is bounded, and the bound is a decision about size and not about content', () => {
    const long = 'x'.repeat(MAX_SECTION_CHARS + 1000)
    expect(canonicalTextOf(parse(`<p>${long}</p>`))).toHaveLength(MAX_SECTION_CHARS)
  })

  it('never cuts between a surrogate pair', () => {
    /* ⚠️ **ONE EMOJI AT THE BOUND COST THE WHOLE BOOK.** `slice` counts UTF-16
     * code units, so a cut inside an astral character leaves a lone high
     * surrogate — which JavaScript tolerates, `JSON` carries as an escape, and
     * serde refuses on the other side of the wire, making the entire book
     * unreadable. Found by the second audit round. */
    const text = canonicalTextOf(parse(`<p>${'x'.repeat(MAX_SECTION_CHARS - 1)}😀tail</p>`))
    expect(text).toHaveLength(MAX_SECTION_CHARS - 1)
    const last = text.charCodeAt(text.length - 1)
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    /* And it is still valid: every code point round-trips through JSON. */
    expect(JSON.parse(JSON.stringify(text))).toBe(text)
    expect(/\p{Surrogate}/u.test(text)).toBe(false)
  })
})

describe('extracting a book', () => {
  const walkOf = (sections: readonly (string | null)[]) => ({
    sections: sections.length,
    documentFor: async (index: number) => {
      const html = sections[index]
      return html === null || html === undefined ? null : parse(html)
    },
    live: () => true,
    breathe: async () => {},
  })

  it('answers one canonical string per section', async () => {
    const found = await extractSections(walkOf(['<p>one</p>', '<p>two</p>']))
    expect(found.complete).toBe(true)
    expect(found.sections).toEqual([
      { index: 0, text: 'one' },
      { index: 1, text: 'two' },
    ])
  })

  it('keeps the real spine index when a section yields nothing', async () => {
    /* The index number is what the landing parses, so a gap must not shift it. */
    const found = await extractSections(walkOf(['<p>one</p>', '', '<p>three</p>']))
    expect(found.sections.map((one) => one.index)).toEqual([0, 2])
  })

  it('treats a section a backend does not build as empty, not as a failure', async () => {
    const found = await extractSections(walkOf(['<p>one</p>', null]))
    expect(found.complete).toBe(true)
    expect(found.unreadable).toEqual([])
  })

  it('records a section that would not parse rather than skipping it silently', async () => {
    /* ⚠️ **A CHAPTER MISSING FROM SEARCH LOOKS EXACTLY LIKE A CHAPTER WITH NO
     * MATCHES.** The gap has to be visible. */
    const found = await extractSections({
      sections: 2,
      documentFor: async (index) => {
        if (index === 1) throw new Error('this section will not parse')
        return parse('<p>one</p>')
      },
      live: () => true,
      breathe: async () => {},
    })
    expect(found.unreadable).toEqual([1])
    expect(found.sections).toHaveLength(1)
    expect(found.complete).toBe(true)
  })

  it('stops the moment it is no longer wanted, and says the walk is incomplete', async () => {
    let seen = 0
    const found = await extractSections({
      sections: 10,
      documentFor: async () => {
        seen += 1
        return parse('<p>one</p>')
      },
      live: () => seen < 2,
      breathe: async () => {},
    })
    expect(found.complete).toBe(false)
    expect(seen).toBeLessThan(10)
  })

  it('asks whether it is still wanted BEFORE the slow step, not after', async () => {
    const documentFor = vi.fn(async () => parse('<p>one</p>'))
    const found = await extractSections({
      sections: 4,
      documentFor,
      live: () => false,
      breathe: async () => {},
    })
    expect(documentFor).not.toHaveBeenCalled()
    expect(found.complete).toBe(false)
  })

  it('hands the main thread back between sections', async () => {
    /* ~139 ms for forty cold sections is fine as forty pieces and is not fine
     * as one task — `reanchorPass`'s own argument, and the same numbers. */
    const breathe = vi.fn(async () => {})
    await extractSections({ ...walkOf(['<p>a</p>', '<p>b</p>', '<p>c</p>']), breathe })
    expect(breathe).toHaveBeenCalledTimes(2)
  })

  it('answers incomplete for a book with no spine rather than claiming it is empty', async () => {
    for (const sections of [0, -1, 1.5, Number.NaN]) {
      const found = await extractSections({ ...walkOf([]), sections })
      expect(found.complete).toBe(false)
      expect(found.sections).toEqual([])
    }
  })
})

describe('what the index holds can be found again by the resolver', () => {
  /* ⚠️ **THE CONTRACT BETWEEN THE TWO HALVES, ASSERTED DIRECTLY.** Everything
   * else in this phase is downstream of it: a quote taken out of the canonical
   * text must be findable in the canonical text of the same document. */
  const cases: readonly { readonly name: string; readonly html: string; readonly at: readonly [number, number] }[] = [
    { name: 'an ordinary sentence', html: '<p>Call me Ishmael. Some years ago.</p>', at: [8, 15] },
    { name: 'across a paragraph break', html: '<p>done</p><p>Start here</p>', at: [0, 10] },
    { name: 'Chinese', html: '<p>从前有一棵柳树，春天柳树发芽了。</p>', at: [5, 7] },
    { name: 'curly typography', html: '<p>“it’s” — so he said</p>', at: [0, 12] },
  ]

  for (const one of cases) {
    it(`finds ${one.name} again`, () => {
      const doc = parse(one.html)
      const text = canonicalTextOf(doc)
      const quote = text.slice(one.at[0], one.at[1])
      expect(quote).not.toBe('')
      const found = reanchorIn(indexText(bodyOf(doc)), {
        quote,
        prefix: text.slice(Math.max(0, one.at[0] - 48), one.at[0]),
        suffix: text.slice(one.at[1], one.at[1] + 48),
      })
      expect(found.kind).toBe('found')
    })
  }
})

describe('a failed parse is a failed section, not a chapter of error text', () => {
  /* ⚠️ **`DOMParser` HANDS BACK A DOCUMENT FOR MALFORMED XHTML RATHER THAN
   * THROWING**, so the `catch` around `documentFor` never sees it. EPUB content
   * is XHTML, and an XML parse fails on anything a publisher's toolchain got
   * slightly wrong — at 1 959 books that is not rare. Indexed, the browser's
   * error message BECOMES the chapter: searching for `error` or `line` returns
   * true-looking hits into a page that does not exist, and the real text is
   * unreachable for ever at that generation with the book checkpointed as
   * complete. Found by an independent audit. */
  function failedParse(): Document {
    return new DOMParser().parseFromString('<p>unclosed & bare ampersand', 'application/xhtml+xml')
  }

  it('is what a real malformed XHTML parse produces', () => {
    /* The known positive. A detector nobody has seen fire on the real thing is
     * a detector that finds nothing and looks clean — the lesson
     * `check-browser-safe.mjs` paid for twice. */
    const doc = failedParse()
    expect(doc.getElementsByTagName('parsererror').length).toBeGreaterThan(0)
    expect(parseFailed(bodyOf(doc))).toBe(true)
  })

  it('is caught when the error element is the root it is handed', () => {
    /* ⚠️ **THE OTHER ENGINE SHAPE, AND WITHOUT THIS CASE THAT BRANCH IS
     * UNREACHABLE.** Measured in Paper's own WebKit on mbp16, 2026-09-24: a
     * failed XHTML parse leaves `documentElement` as the partial content's own
     * element (`p`), `doc.body` NULL — so `bodyOf` falls through to the
     * Document — and `getElementsByTagName` is what finds the error. Firefox
     * makes the error the document element instead, which is the shape this
     * covers. Without it the `localName` test is a branch no production caller
     * can reach and no test can kill, which this repository has a long list of.
     */
    const doc = failedParse()
    const error = doc.getElementsByTagName('parsererror')[0]
    expect(error).toBeDefined()
    expect(parseFailed(error as Node)).toBe(true)
  })

  it('leaves an ordinary chapter alone', () => {
    const doc = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Call me Ishmael.</p></body></html>',
      'application/xhtml+xml',
    )
    expect(parseFailed(bodyOf(doc))).toBe(false)
  })

  it('is recorded as unreadable rather than indexed', async () => {
    const broken = failedParse()
    const fine = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>The whale was large.</p></body></html>',
      'application/xhtml+xml',
    )
    const walked = await extractSections({
      sections: 2,
      documentFor: async (index) => (index === 0 ? bodyOf(broken) : bodyOf(fine)),
      live: () => true,
      breathe: async () => {},
    })
    expect(walked.unreadable).toEqual([0])
    expect(walked.sections.map((one) => one.index)).toEqual([1])
    expect(walked.sections[0]?.text).toContain('whale')
    for (const one of walked.sections) {
      expect(one.text).not.toContain('parsererror')
      expect(one.text.toLowerCase()).not.toContain('this page contains')
    }
  })
})
