import { describe, expect, it } from 'vitest'
import {
  blockIndexAt,
  sentenceIndexAt,
  stepParagraph,
  stepSentence,
  type ReadingPlan,
} from './readingCursor'
import { sentenceSpansOf } from './wordSnap/sentenceOf'

/**
 * A plan built the way the hook builds one: real sentence spans over real text,
 * with block starts given as `collectText` would give them.
 *
 * The spans are NOT written by hand. Hand-written ones would let this file agree
 * with itself about where sentences end while disagreeing with the splitter the
 * reading actually uses — which is the drift `sentenceOf.reading.test.ts` exists
 * to prevent one level down, and it would be pointless to reintroduce here.
 */
function plan(text: string, blocks: readonly number[], locale = 'en'): ReadingPlan {
  return { sentences: sentenceSpansOf(text, locale), blocks }
}

/* Two paragraphs, two sentences each. The block separator is a single space,
   exactly as `collectText` writes it, so the offsets below are the real ones. */
const P1 = 'One here. Two there.'
const P2 = 'Three everywhere. Four beyond.'
const TWO_PARAGRAPHS = `${P1} ${P2}`
const BLOCKS = [0, P1.length + 1]

describe('the plan the hook builds', () => {
  it('finds four sentences and two paragraphs', () => {
    const p = plan(TWO_PARAGRAPHS, BLOCKS)
    expect(p.sentences).toHaveLength(4)
    expect(blockIndexAt(p, 0)).toBe(0)
    expect(blockIndexAt(p, 1)).toBe(0)
    expect(blockIndexAt(p, 2)).toBe(1)
    expect(blockIndexAt(p, 3)).toBe(1)
  })
})

describe('sentenceIndexAt', () => {
  const p = plan(TWO_PARAGRAPHS, BLOCKS)

  it('answers for every offset in the section, because the spans tile it', () => {
    /* Totality is the property, not a sample: a position the reading cannot turn
       into a cursor is a position the transport cannot resume from. */
    for (let at = 0; at < TWO_PARAGRAPHS.length; at += 1) {
      const index = sentenceIndexAt(p, at)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(p.sentences.length)
    }
  })

  it('puts the first character in the first sentence', () => {
    expect(sentenceIndexAt(p, 0)).toBe(0)
  })

  it('puts an offset past the end in the last sentence', () => {
    expect(sentenceIndexAt(p, TWO_PARAGRAPHS.length + 50)).toBe(3)
  })

  it('answers zero for a section with nothing in it', () => {
    expect(sentenceIndexAt({ sentences: [], blocks: [] }, 7)).toBe(0)
  })
})

describe('stepSentence', () => {
  const p = plan(TWO_PARAGRAPHS, BLOCKS)

  it('moves one forward and one back', () => {
    expect(stepSentence(p, 1, 1)).toBe(2)
    expect(stepSentence(p, 1, -1)).toBe(0)
  })

  it('crosses a paragraph boundary without treating it as an edge', () => {
    /* Sentence 1 is the last of paragraph one; forward is the first of two. */
    expect(stepSentence(p, 1, 1)).toBe(2)
    expect(blockIndexAt(p, 2)).toBe(1)
  })

  it('answers null at the section edges rather than clamping', () => {
    /* ⚠️ **CLAMPING WOULD BE A DEAD BUTTON.** The reading's answer at the last
       sentence is the next SECTION, which only the hook can do — so the edge is
       reported rather than absorbed. */
    expect(stepSentence(p, 0, -1)).toBeNull()
    expect(stepSentence(p, 3, 1)).toBeNull()
  })

  it('answers null for every step in an empty section', () => {
    const empty: ReadingPlan = { sentences: [], blocks: [] }
    expect(stepSentence(empty, 0, 1)).toBeNull()
    expect(stepSentence(empty, 0, -1)).toBeNull()
  })
})

describe('stepParagraph', () => {
  const p = plan(TWO_PARAGRAPHS, BLOCKS)

  it('goes forward to the first sentence of the next paragraph', () => {
    expect(stepParagraph(p, 0, 1)).toBe(2)
    expect(stepParagraph(p, 1, 1)).toBe(2)
  })

  it('restarts the current paragraph before leaving it', () => {
    /* ⚠️ **THE BACK BUTTON CONVENTION, AND IT IS DELIBERATE.** From the SECOND
       sentence of a paragraph, back means "this paragraph again" — a listener who
       has drifted wants to re-hear what is playing far more often than the thing
       before it, and going straight back would make one press unable to do it. */
    expect(stepParagraph(p, 3, -1)).toBe(2)
    expect(stepParagraph(p, 1, -1)).toBe(0)
  })

  it('leaves for the previous paragraph only from its first sentence', () => {
    expect(stepParagraph(p, 2, -1)).toBe(0)
  })

  it('answers null past the last paragraph and before the first', () => {
    expect(stepParagraph(p, 3, 1)).toBeNull()
    expect(stepParagraph(p, 0, -1)).toBeNull()
  })

  it('answers null for a section with no blocks', () => {
    expect(stepParagraph({ sentences: sentenceSpansOf('A sentence.', 'en'), blocks: [] }, 0, 1)).toBeNull()
  })
})

describe('a paragraph that does not begin a sentence', () => {
  /**
   * A heading has no full stop, so the sentence containing it runs on into the
   * paragraph after it — the block boundary falls INSIDE a sentence.
   *
   * ⚠️ **A STEP MUST NOT OVERSHOOT THERE.** Taking "the first sentence starting
   * at or after the block" would skip the sentence the heading is part of and
   * land the voice in the paragraph AFTER the one the reader asked for.
   */
  const raw = 'Chapter One Call me Ishmael. Some years ago.'
  const blocks = [0, 'Chapter One '.length]
  const p = plan(raw, blocks)

  it('has a block boundary inside a sentence', () => {
    const first = p.sentences[0]
    expect(first).toBeDefined()
    expect(blocks[1]).toBeGreaterThan(first?.start ?? 0)
    expect(blocks[1]).toBeLessThan(first?.end ?? 0)
  })

  it('steps to the sentence containing the boundary, not past it', () => {
    expect(stepParagraph(p, 0, 1)).toBe(0)
  })
})

describe('a section of one sentence', () => {
  const p = plan('Only this.', [0])

  it('has no step in either direction', () => {
    expect(stepSentence(p, 0, 1)).toBeNull()
    expect(stepSentence(p, 0, -1)).toBeNull()
    expect(stepParagraph(p, 0, 1)).toBeNull()
    expect(stepParagraph(p, 0, -1)).toBeNull()
  })
})
