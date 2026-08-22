import { describe, expect, it } from 'vitest'
import {
  COMPANION_SYSTEM_PROMPT,
  MAX_CONTEXT_CHARS,
  UNKNOWN_CITATION_NOTE,
  buildQuestion,
  citedIndices,
  numberPassages,
  renderPassages,
  resolveCitations,
  type SourcePassage,
} from './passages'

const source = (text: string, n: number): SourcePassage => ({
  text,
  cfi: `epubcfi(/6/4!/4/${n})`,
  label: `¶${n}`,
})

const paragraph = (n: number): SourcePassage =>
  source(`This is passage number ${n}, and it is long enough to be worth citing in an answer.`, n)

describe('numberPassages', () => {
  it('numbers from one, in order', () => {
    const passages = numberPassages([paragraph(1), paragraph(2), paragraph(3)])
    expect(passages.map((p) => p.n)).toEqual([1, 2, 3])
  })

  it('carries the cfi and label the model never sees', () => {
    const [first] = numberPassages([paragraph(1)])
    expect(first?.cfi).toBe('epubcfi(/6/4!/4/1)')
    expect(first?.label).toBe('¶1')
  })

  it('collapses whitespace so a line break is not a different passage', () => {
    const [first] = numberPassages([source('a  long\n\n  passage that is quite definitely long enough', 1)])
    expect(first?.text).toBe('a long passage that is quite definitely long enough')
  })

  /* A stray heading or a one-word line is not something a claim can cite, and
   * numbering it wastes an index the model may then use for what it meant. */
  it('skips passages too short to cite', () => {
    const passages = numberPassages([source('Chapter One', 1), paragraph(2)])
    expect(passages).toHaveLength(1)
    expect(passages[0]?.cfi).toBe('epubcfi(/6/4!/4/2)')
  })

  it('stops at the budget rather than sending a whole chapter', () => {
    const many = Array.from({ length: 500 }, (_, i) => paragraph(i + 1))
    const passages = numberPassages(many)
    const total = passages.reduce((sum, p) => sum + p.text.length, 0)
    expect(total).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
    expect(passages.length).toBeLessThan(many.length)
  })

  /* A budget smaller than the first passage must still send it: an empty
   * context asks the model to answer from nothing, which is the one thing
   * §13 forbids. */
  it('always sends at least one passage, however small the budget', () => {
    const passages = numberPassages([paragraph(1), paragraph(2)], 1)
    expect(passages).toHaveLength(1)
  })

  it('renumbers contiguously after a skip', () => {
    const passages = numberPassages([source('Short', 1), paragraph(2), paragraph(3)])
    expect(passages.map((p) => p.n)).toEqual([1, 2])
  })
})

describe('renderPassages', () => {
  it('numbers each passage in the form the prompt asks for', () => {
    const rendered = renderPassages(numberPassages([paragraph(1), paragraph(2)]))
    expect(rendered).toContain('[1] This is passage number 1')
    expect(rendered).toContain('[2] This is passage number 2')
  })

  /* THE MODEL NEVER SEES A LOCATION. F4: handed the word "CFI" it will emit a
   * syntactically plausible one that points at nothing. */
  it('sends no cfi and no label', () => {
    const rendered = renderPassages(numberPassages([paragraph(1)]))
    expect(rendered).not.toContain('epubcfi')
    expect(rendered).not.toContain('¶')
  })
})

describe('citedIndices', () => {
  it('reads a single citation', () => {
    expect(citedIndices('The whale is white [3].')).toEqual([3])
  })

  it('reads the several forms a model produces unasked', () => {
    expect(citedIndices('a [1] b [2][3] c [4, 5]')).toEqual([1, 2, 3, 4, 5])
  })

  it('does not repeat an index cited twice', () => {
    expect(citedIndices('[2] and again [2]')).toEqual([2])
  })

  it('leaves bracketed prose alone', () => {
    expect(citedIndices('a [sic] b [the narrator] c')).toEqual([])
  })

  it('finds nothing in an answer with no citations', () => {
    expect(citedIndices('I cannot answer that from these passages.')).toEqual([])
  })

  it('ignores a zero, which is not a passage number', () => {
    expect(citedIndices('[0]')).toEqual([])
  })
})

describe('resolveCitations', () => {
  const passages = numberPassages([paragraph(1), paragraph(2)])

  it('maps a real index back to its location', () => {
    const resolved = resolveCitations('As it says [2].', passages)
    expect(resolved.citations).toEqual([{ cfi: 'epubcfi(/6/4!/4/2)', label: '¶2' }])
    expect(resolved.hadUnknownCitation).toBe(false)
  })

  /* ── WI-15.5's ACCEPTANCE, VERBATIM ────────────────────────────────────
   * "a fabricated [47] in a model's output produces an answer with no
   * citation and a visible note, never a citation pointing somewhere
   * plausible." */
  it('drops a fabricated index and says so', () => {
    const resolved = resolveCitations('The whale is white [47].', passages)
    expect(resolved.citations).toEqual([])
    expect(resolved.hadUnknownCitation).toBe(true)
  })

  it('never resolves a fabricated index to the nearest real passage', () => {
    const resolved = resolveCitations('[3]', passages)
    /* 3 is one past the end. A lenient implementation would clamp to 2, which
     * is precisely the citation-pointing-somewhere-plausible failure. */
    expect(resolved.citations).toEqual([])
  })

  it('keeps the real citations and drops only the invented one', () => {
    const resolved = resolveCitations('a [1] b [47] c [2]', passages)
    expect(resolved.citations.map((c) => c.label)).toEqual(['¶1', '¶2'])
    expect(resolved.hadUnknownCitation).toBe(true)
  })

  it('has a note to show when something was dropped', () => {
    expect(UNKNOWN_CITATION_NOTE).toMatch(/removed/)
  })

  it('resolves nothing, and flags nothing, for an answer with no citations', () => {
    const resolved = resolveCitations('I cannot answer that from these passages.', passages)
    expect(resolved.citations).toEqual([])
    expect(resolved.hadUnknownCitation).toBe(false)
  })

  it('resolves against an empty table without throwing', () => {
    const resolved = resolveCitations('[1]', [])
    expect(resolved.citations).toEqual([])
    expect(resolved.hadUnknownCitation).toBe(true)
  })
})

describe('the prompt', () => {
  it('tells the model to cite only numbers it was given', () => {
    expect(COMPANION_SYSTEM_PROMPT).toMatch(/[Nn]ever invent a number/)
  })

  it('carries §13’s two voice rules', () => {
    expect(COMPANION_SYSTEM_PROMPT).toMatch(/only the numbered passages/)
    expect(COMPANION_SYSTEM_PROMPT).toMatch(/outside the passages, say/)
  })

  /* The word the model must never be handed. F4 is the whole reason the
   * numbering exists. */
  it('never mentions a CFI', () => {
    expect(COMPANION_SYSTEM_PROMPT.toLowerCase()).not.toContain('cfi')
  })
})

describe('buildQuestion', () => {
  const passages = numberPassages([paragraph(1)])

  it('carries the book, the chapter, the passages and the question', () => {
    const prompt = buildQuestion('Moby-Dick', 'Chapter 4', passages, null, 'Why the whale?')
    expect(prompt).toContain('Book: Moby-Dick')
    expect(prompt).toContain('Chapter: Chapter 4')
    expect(prompt).toContain('[1] This is passage number 1')
    expect(prompt).toContain('Question: Why the whale?')
  })

  it('includes the reader’s selection when there is one', () => {
    const prompt = buildQuestion('Moby-Dick', 'Chapter 4', passages, 'call me Ishmael', 'Who?')
    expect(prompt).toContain('call me Ishmael')
  })

  it('says nothing about a selection when there is none', () => {
    const prompt = buildQuestion('Moby-Dick', 'Chapter 4', passages, null, 'Who?')
    expect(prompt).not.toMatch(/has selected/)
  })

  it('treats a whitespace-only selection as none', () => {
    const prompt = buildQuestion('Moby-Dick', 'Chapter 4', passages, '   \n ', 'Who?')
    expect(prompt).not.toMatch(/has selected/)
  })
})
