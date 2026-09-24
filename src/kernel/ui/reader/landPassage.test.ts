// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { landPassage, whyNotLanded, type Landing } from './landPassage'
import { canonicalTextOf } from './passageText'

const parse = (html: string): Document =>
  new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html')

/** A hit as the index would produce one, cut out of the canonical text. */
function hitIn(html: string, from: number, to: number, sectionIndex = 0) {
  const text = canonicalTextOf(parse(html))
  return {
    sectionIndex,
    quote: text.slice(from, to),
    prefix: text.slice(Math.max(0, from - 48), from),
    suffix: text.slice(to, to + 48),
  }
}

describe('landing a library hit', () => {
  it('lands on the words, and the cfi names the section it came from', async () => {
    const html = '<p>Call me Ishmael. Some years ago.</p>'
    const found = await landPassage(hitIn(html, 8, 15, 3), async () => parse(html))
    expect(found.kind).toBe('landed')
    if (found.kind !== 'landed') return
    /* The spine step is `/6/(2n+2)` for section n — section 3 is `/6/8`. */
    expect(found.cfi).toMatch(/^epubcfi\(\/6\/8!/u)
  })

  it('needs no open book and no rendering — one section is parsed', async () => {
    /* ⚠️ **THE CLAIM THE PLAN'S FIRST DRAFT GOT BACKWARDS.** A CFI is a PATH,
     * so a hit in chapter 40 of a book opened at chapter 1 resolves like any
     * other; and `view.search()` — stateful and destructive — is never
     * involved. What this asserts is that exactly ONE document was asked for. */
    const documentFor = vi.fn(async () => parse('<p>the whale was large</p>'))
    await landPassage(hitIn('<p>the whale was large</p>', 4, 9, 39), documentFor)
    expect(documentFor).toHaveBeenCalledTimes(1)
    expect(documentFor).toHaveBeenCalledWith(39)
  })

  it('uses the context to choose between repeated occurrences', async () => {
    /* ⚠️ **A QUOTE ALONE JUMPS TO THE FIRST OCCURRENCE, WHICH IS A WRONG
     * LANDING THAT LOOKS LIKE A RIGHT ONE.** */
    const html =
      '<p>The first time we saw the whale it was calm and grey and far away indeed.</p>' +
      '<p>Much later, storms behind us, we saw the whale again in the burning evening light.</p>'
    const text = canonicalTextOf(parse(html))
    const second = text.indexOf('the whale', text.indexOf('the whale') + 1)
    const found = await landPassage(
      {
        sectionIndex: 0,
        quote: 'the whale',
        prefix: text.slice(second - 48, second),
        suffix: text.slice(second + 9, second + 57),
      },
      async () => parse(html),
    )
    expect(found.kind).toBe('landed')
    if (found.kind !== 'landed') return
    expect(found.occurrences).toBe(2)
    /* And it is the SECOND one: the range's own text, read back from the
     * document, sits after the first occurrence. */
    expect(found.cfi).toMatch(/^epubcfi\(\/6\/2!/u)
  })

  it('refuses rather than guessing when the context cannot choose', async () => {
    const html = '<p>the whale. the whale. the whale.</p>'
    const found = await landPassage(
      { sectionIndex: 0, quote: 'the whale', prefix: '', suffix: '' },
      async () => parse(html),
    )
    expect(found.kind).toBe('ambiguous')
    if (found.kind !== 'ambiguous') return
    expect(found.occurrences).toBe(3)
  })

  it('settles an ambiguous passage on the offset the index recorded', async () => {
    /* ⚠️ **THE INDEX KNEW, AND NOTHING READ IT.** `PassageHit.offset` crosses
     * the wire saying where the quote starts, and the landing disambiguated on
     * context alone — so a passage in a repetitive section was refused while
     * the answer was in the hit. Measured on the real 1 962-book library,
     * 2026-09-24: 5 of 216 landings refused this way, and over 50 hits the
     * offset matched the resolver's own canonical text 50 times out of 50. */
    const html = '<p>the whale. the whale. the whale.</p>'
    /* The THIRD occurrence: "the whale. the whale. " is 22 characters. */
    const found = await landPassage(
      { sectionIndex: 0, quote: 'the whale', prefix: '', suffix: '', offset: 22 },
      async () => parse(html),
    )
    expect(found.kind).toBe('landed')
    if (found.kind !== 'landed') return
    expect(found.occurrences).toBe(3)
  })

  it('refuses when the offset does not hold the quote, rather than trusting it', async () => {
    /* ⚠️ **VERIFIED BEFORE USE, BECAUSE THE OFFSET DESCRIBES BYTES THIS DEVICE
     * MAY NOT HAVE.** The index is built from one build of a book and the
     * landing parses whatever is on disk now — the second-writer limit
     * `freshness.ts` records. An offset that does not point at the quote is
     * evidence the two disagree, and the honest answer is the refusal. */
    const found = await landPassage(
      { sectionIndex: 0, quote: 'the whale', prefix: '', suffix: '', offset: 4 },
      async () => parse('<p>the whale. the whale. the whale.</p>'),
    )
    expect(found.kind).toBe('ambiguous')
    if (found.kind !== 'ambiguous') return
    expect(found.occurrences).toBe(3)
  })

  it('treats a missing offset as no evidence, never as position zero', async () => {
    /* ⚠️ **`startsWith(quote, undefined)` MEANS POSITION 0.** So an absent
     * offset would silently claim the FIRST occurrence is the one the index
     * meant — a wrong landing in place of an honest refusal, which is the one
     * outcome this module exists to avoid. Every caller that is not a
     * `PassageHit` hands in a passage with no offset. */
    const found = await landPassage(
      { sectionIndex: 0, quote: 'the whale', prefix: '', suffix: '' },
      async () => parse('<p>the whale. the whale. the whale.</p>'),
    )
    expect(found.kind).toBe('ambiguous')
  })

  it('refuses an offset past the end of the section', async () => {
    const found = await landPassage(
      { sectionIndex: 0, quote: 'the whale', prefix: '', suffix: '', offset: 9_999 },
      async () => parse('<p>the whale. the whale.</p>'),
    )
    expect(found.kind).toBe('ambiguous')
  })

  it('does not reach for the offset when the context already chose', async () => {
    /* The ordinary path is untouched: an offset is consulted only where
     * `reanchorIn` says it cannot choose, so a hit whose context decides lands
     * on the context's answer even when the offset names another occurrence. */
    const html = '<p>alpha the whale beta. gamma the whale delta.</p>'
    const found = await landPassage(
      { sectionIndex: 0, quote: 'the whale', prefix: 'gamma ', suffix: ' delta', offset: 6 },
      async () => parse(html),
    )
    expect(found.kind).toBe('landed')
    if (found.kind !== 'landed') return
    expect(found.occurrences).toBe(2)
  })

  it('says the quote is absent when the index is behind the book', async () => {
    const found = await landPassage(
      { sectionIndex: 0, quote: 'the unicorn', prefix: '', suffix: '' },
      async () => parse('<p>the whale</p>'),
    )
    expect(found.kind).toBe('absent')
  })

  it('says there is no such section rather than reporting an absent quote', async () => {
    /* Four causes, four sentences — a landing failure reported as one thing
     * sends the reader to the wrong remedy. */
    expect((await landPassage(hitIn('<p>a</p>', 0, 1, 9), async () => null)).kind).toBe('no-section')
    for (const bad of [-1, 1.5, Number.NaN]) {
      const found = await landPassage({ ...hitIn('<p>a</p>', 0, 1), sectionIndex: bad }, async () =>
        parse('<p>a</p>'),
      )
      expect(found.kind).toBe('no-section')
    }
  })

  it('names a section that would not parse rather than swallowing it', async () => {
    const found = await landPassage(hitIn('<p>a</p>', 0, 1), async () => {
      throw new Error('the chapter is not in the archive')
    })
    expect(found.kind).toBe('unreadable')
    if (found.kind !== 'unreadable') return
    expect(found.why).toContain('not in the archive')
  })

  it('lands a quote that crosses a paragraph break, because both walks agree about it', async () => {
    const html = '<p>done</p><p>Start here</p>'
    const found = await landPassage(hitIn(html, 0, 10), async () => parse(html))
    expect(found.kind).toBe('landed')
  })

  it('lands Chinese', async () => {
    const html = '<p>从前有一棵柳树，春天柳树发芽了。</p>'
    const text = canonicalTextOf(parse(html))
    const second = text.indexOf('柳树', text.indexOf('柳树') + 1)
    const found = await landPassage(
      {
        sectionIndex: 0,
        quote: '柳树',
        prefix: text.slice(0, second),
        suffix: text.slice(second + 2),
      },
      async () => parse(html),
    )
    expect(found.kind).toBe('landed')
  })
})

describe('what the reader is told when a landing fails', () => {
  it('says nothing at all when it worked', () => {
    expect(whyNotLanded({ kind: 'landed', cfi: 'epubcfi(/6/2!/4)' as never, occurrences: 1 })).toBeNull()
  })

  it('gives a different sentence for each cause', () => {
    const cases: readonly Landing[] = [
      { kind: 'absent' },
      { kind: 'ambiguous', occurrences: 3 },
      { kind: 'no-section' },
      { kind: 'unreadable', why: 'boom' },
    ]
    const said = cases.map((one) => whyNotLanded(one))
    expect(new Set(said).size).toBe(cases.length)
    expect(said.every((one) => typeof one === 'string' && one.length > 0)).toBe(true)
  })

  it('does not blame an edition change, which is the wrong default', () => {
    /* ⚠️ `bookId` identifies the EXACT bytes, so another edition is normally
     * another book. Same-byte ambiguity is the common case. */
    const said = whyNotLanded({ kind: 'absent' }) ?? ''
    expect(said.toLowerCase()).not.toContain('edition')
  })

  it('names how many places an ambiguous passage was found in', () => {
    expect(whyNotLanded({ kind: 'ambiguous', occurrences: 7 })).toContain('7')
  })
})
