import { describe, expect, it } from 'vitest'
import { SENTENCE_CORPUS } from './sentenceCorpus'
import { sentenceOf, sentenceSpansOf } from './sentenceOf'

/**
 * `sentenceSpansOf` is the READING path — every sentence of a section, in order,
 * so the voice can speak one at a time and the reader can move by one.
 *
 * ⚠️ **THE POINT OF THIS FILE IS THAT IT IS NOT A SECOND ANSWER.** `sentenceOf`
 * decides where a sentence ends for a selection; this decides it for a reading;
 * and if the two ever disagree, a reader who selects a sentence and a reader who
 * listens to one are being told different things about the same prose. Both go
 * through one `squeeze` and one `merged`, and the corpus below is what holds
 * them to it.
 */

/** Ranges tile `raw` with no gap and no overlap — see `sentenceSpansOf`. */
function covers(raw: string, spans: readonly { start: number; end: number }[]): boolean {
  if (spans.length === 0) return raw.trim() === ''
  if (spans[0]?.start !== 0) return false
  if (spans[spans.length - 1]?.end !== raw.length) return false
  return spans.every((span, at) => (at === 0 ? true : span.start === spans[at - 1]?.end))
}

describe('sentenceSpansOf covers the text it is given', () => {
  /**
   * ⚠️ **A GAP HERE IS A SILENTLY UNREAD LINE.** If two sentences do not meet,
   * whatever lies between them is in no sentence, so the reading walks straight
   * past it — no error, no pause, just a line of the book the reader never
   * hears. That is unfindable from the outside, so it is asserted from the
   * inside, over every row of the corpus rather than a few chosen strings.
   */
  for (const row of SENTENCE_CORPUS) {
    it(`tiles ${row.id} with no gap`, () => {
      const spans = sentenceSpansOf(row.raw, row.locale)
      expect(covers(row.raw, spans)).toBe(true)
    })
  }

  it('answers nothing for text with nothing to say', () => {
    expect(sentenceSpansOf('', 'en')).toEqual([])
    expect(sentenceSpansOf('   \n\t  ', 'en')).toEqual([])
  })

  it('never answers an empty range, which reads as a refused utterance', () => {
    for (const row of SENTENCE_CORPUS) {
      for (const span of sentenceSpansOf(row.raw, row.locale)) {
        expect(span.end).toBeGreaterThan(span.start)
      }
    }
  })
})

describe('a range with nothing in it to say', () => {
  /**
   * ⚠️ **A SEPARATOR ALONE WAS A SENTENCE.** `end > start` drops only a ZERO-length
   * range, and U+2028 is one character — so a text beginning with one produced a
   * first "sentence" holding just the separator. The reading hands that to the
   * engine, and an utterance that ends immediately reads as a fault rather than a
   * pause.
   *
   * Merged into the previous range rather than dropped, because dropping opens the
   * coverage hole `covers` exists to refuse.
   */
  const LS = String.fromCharCode(0x2028)
  const PS = String.fromCharCode(0x2029)

  it('does not make a sentence out of a leading separator', () => {
    const raw = `${LS}Hello there.`
    const spans = sentenceSpansOf(raw, 'en')
    expect(spans).toHaveLength(1)
    expect(covers(raw, spans)).toBe(true)
  })

  it('does not make one out of each of a run of separators', () => {
    const raw = `One here.${LS}${PS}${LS}Two there.`
    const spans = sentenceSpansOf(raw, 'en')
    expect(spans).toHaveLength(2)
    expect(covers(raw, spans)).toBe(true)
    for (const span of spans) expect(raw.slice(span.start, span.end).trim()).not.toBe('')
  })

  it('leaves every range with something a voice can pronounce', () => {
    /* Over the whole corpus, not a chosen string: no range may be blank once the
       separators and the soft hyphens are taken out. */
    for (const row of SENTENCE_CORPUS) {
      for (const span of sentenceSpansOf(row.raw, row.locale)) {
        const body = row.raw.slice(span.start, span.end).replace(/\u00ad/gu, '').trim()
        expect(body, `${row.id} produced a range with nothing to say`).not.toBe('')
      }
    }
  })
})

describe('a book that quotes another script', () => {
  /**
   * ⚠️ **THE DECLARED LANGUAGE DECIDES, WHATEVER THE TEXT — AND THAT IS A RECORDED
   * DECISION, NOT AN OVERSIGHT.** `sentenceOf.guards.test.ts` states it in as many
   * words: *"A DECLARED LANGUAGE KEEPS THE LANGUAGE'S RULE, whatever the text: `en`
   * merges a Cyrillic initial, and a tag meaning 'not a language' merges nothing."*
   *
   * The cost is real and the corpus records it: `latin-abbreviation-in-han-under-zh`
   * carries the hand-written correct answer `他说 Mr. Smith 来了。` beside the
   * `Smith 来了。` the implementation returns, marked UNCOVERED, with the note that
   * deciding per script RUN is "a second feature".
   *
   * ⚠️ **I IMPLEMENTED THAT AND TOOK IT BACK OUT.** Reading each segment's own tail
   * covers the CJK case and breaks the other direction: under `en` a Cyrillic `А.`
   * stops being merged, and under `ru`, `und`, `mul` and `zxx` English text starts
   * being merged — three tests that state their intent. Every variant I could
   * construct trades one documented behaviour for another, and which orthography
   * governs a mixed-script book is a judgement about books rather than a defect
   * with a right answer. It is the owner's call, and the corpus is already the
   * honest record of it.
   *
   * What is pinned here is the behaviour that HOLDS, so the next reader meets it as
   * a fact rather than rediscovering it as a surprise.
   */
  it('does not repair a Latin abbreviation inside a book declaring Chinese', () => {
    const raw = '他说 Mr. Smith 来了。她走了。'
    const spans = sentenceSpansOf(raw, 'zh')
    /* THREE, not two: the split after `Mr. ` is the shortfall the corpus names. */
    expect(spans).toHaveLength(3)
    expect(raw.slice(spans[0]?.start, spans[0]?.end).trim()).toBe('他说 Mr.')
  })

  it('does repair it when the book declares a Latin language', () => {
    /* The same text under `en`: one sentence, because the declaration governs. */
    const raw = '他说 Mr. Smith 来了。她走了。'
    const spans = sentenceSpansOf(raw, 'en')
    expect(spans.length).toBeLessThan(3)
  })

  it('still splits the Chinese sentences, which the shortfall does not touch', () => {
    const raw = '他说。然后走了。'
    expect(sentenceSpansOf(raw, 'zh')).toHaveLength(2)
  })
})

describe('the reading and the selection agree on where a sentence ends', () => {
  /**
   * For every corpus row whose sentence `sentenceOf` actually names, the reading
   * span holding that row's term must contain the same words.
   *
   * ⚠️ **COMPARED ON SQUEEZED CONTENT, NOT CHARACTER FOR CHARACTER.** A reading
   * span is cut from `raw`, so it carries the source's own wrapping and
   * indentation; `sentenceOf` answers with squeezed text. Comparing those
   * literally would fail on whitespace that neither path disagrees about. What
   * must match is the prose.
   *
   * Rows using `before`/`after` or `requireComplete` are LEFT OUT with a reason:
   * those exercise the term query's edge gate — what lies across a window
   * boundary, and whether an incomplete sentence may be returned — and a whole
   * text walk has no window and no edges. Excluding them keeps this test about
   * the shared question instead of asserting the paths agree about a question
   * only one of them is asked.
   */
  const shared = SENTENCE_CORPUS.filter(
    (row) =>
      row.actual !== 'none' &&
      row.before === undefined &&
      row.after === undefined &&
      row.requireComplete === undefined,
  )

  it('has rows to compare, so an empty filter cannot pass this silently', () => {
    expect(shared.length).toBeGreaterThan(5)
  })

  /**
   * The prose, with the whitespace and the soft hyphens the squeeze removes.
   *
   * ⚠️ **THE SOFT HYPHEN IS NOT COSMETIC HERE.** `squeeze` drops U+00AD, so
   * `sentenceOf` answers `hyphenation` where the raw text holds `hy\u00adphen\u00adation`.
   * Comparing without dropping it made this test fail over a character neither
   * path disagrees about, which is a test measuring itself.
   */
  const prose = (text: string) =>
    text
      .replace(/\u00ad/gu, '')
      .trim()
      .split(/\s+/u)
      .join(' ')

  for (const row of shared) {
    it(`agrees on ${row.id}`, () => {
      const answer = sentenceOf(row.raw, row.termStart, row.termEnd, {
        locale: row.locale,
        maxSentenceChars: row.maxSentenceChars,
      })
      if (!answer.ok) return

      /* OVERLAP, NOT CONTAINMENT — and `spans-two-sentences` is why. Its term
       * is `there. Three`, chosen to straddle a boundary, and `sentenceOf`
       * answers with BOTH sentences because sending half of what the reader
       * selected would define a term the sentence does not hold. No single
       * reading span can contain such a term, so requiring one asserted
       * something the corpus says on purpose is false. */
      const touched = sentenceSpansOf(row.raw, row.locale).filter(
        (s) => s.start < row.termEnd && row.termStart < s.end,
      )
      expect(touched.length, 'no reading span overlaps the row term').toBeGreaterThan(0)
      const from = touched[0]?.start ?? 0
      const to = touched[touched.length - 1]?.end ?? 0
      expect(prose(row.raw.slice(from, to))).toContain(prose(answer.sentence))
    })
  }
})

describe("what an EPUB's own line wrapping does to segmentation", () => {
  /**
   * ⚠️ **MEASURED 2026-09-20, AND IT IS THE REASON THIS FUNCTION SQUEEZES.**
   * `Intl.Segmenter` treats a newline as a paragraph separator (UAX #29 SB4), so
   * segmenting the DOM's own text splits a sentence at every source line break.
   * EPUBs are hard-wrapped as a matter of course, so this is the common case and
   * not an edge one.
   */
  it('keeps one sentence together across a hard-wrapped line', () => {
    const raw = 'He walked into the\n    room and sat down quietly.'
    const spans = sentenceSpansOf(raw, 'en')
    expect(spans).toHaveLength(1)
    expect(covers(raw, spans)).toBe(true)
  })

  it('keeps an abbreviation together across a hard-wrapped line', () => {
    /* ⚠️ **FLATTENING NEWLINES TO SPACES IS NOT ENOUGH, WHICH WAS MEASURED
       TOO.** Without collapsing, the segment before the wrap is `He met Mr.` and
       then five spaces, and `endsInAbbreviation` reads a tail of whitespace — so
       the merge does not fire and `Mr.` ends a sentence. Collapsing is what
       makes the tail `Mr. ` again. */
    const spans = sentenceSpansOf('He met Mr.\n    Smith today. Next one.', 'en')
    expect(spans).toHaveLength(2)
    expect(spans[0]?.start).toBe(0)
  })

  it('still separates two real sentences', () => {
    const raw = 'He sat down. She stood up.'
    const spans = sentenceSpansOf(raw, 'en')
    expect(spans).toHaveLength(2)
    expect(raw.slice(spans[0]?.start, spans[0]?.end).trim()).toBe('He sat down.')
    expect(raw.slice(spans[1]?.start, spans[1]?.end).trim()).toBe('She stood up.')
  })

  it('separates Chinese sentences across a hard-wrapped line', () => {
    const raw = '他走进房间\n    然后坐下了。她站起来。'
    const spans = sentenceSpansOf(raw, 'zh')
    expect(spans).toHaveLength(2)
    expect(raw.slice(spans[1]?.start, spans[1]?.end).trim()).toBe('她站起来。')
    expect(covers(raw, spans)).toBe(true)
  })

  it('takes leading whitespace into the first sentence rather than losing it', () => {
    /* The squeeze drops it, so the map points past it — and a first span
       starting there would leave those characters in no sentence at all. */
    const raw = '\n\n   He sat down.'
    const spans = sentenceSpansOf(raw, 'en')
    expect(spans[0]?.start).toBe(0)
    expect(covers(raw, spans)).toBe(true)
  })

  it('reads a text with no terminator at all as one sentence', () => {
    const raw = 'a heading with no full stop'
    expect(sentenceSpansOf(raw, 'en')).toEqual([{ start: 0, end: raw.length }])
  })

  it('answers with no declared locale, where each segment speaks for itself', () => {
    /* `undefined` is the book declaring no language — the case the Windows leg
       found, where asking the HOST's locale cut an English book after `Mr.` */
    const raw = 'He met Mr. Smith at noon. Then he left.'
    const spans = sentenceSpansOf(raw, undefined)
    expect(spans).toHaveLength(2)
    expect(raw.slice(spans[0]?.start, spans[0]?.end).trim()).toBe('He met Mr. Smith at noon.')
  })
})

/**
 * ⚠️ **`Capt. Smith` WAS CUT IN TWO.** The title list held the forms of address
 * and nothing that precedes a rank or an office, and ICU splits after every one.
 * Each title added is a word that in practice never ENDS a sentence, which is the
 * only thing that makes merging across it safe.
 */
describe('a rank or an office before a name', () => {
  const sentences = (raw: string) => sentenceSpansOf(raw, 'en').map((span) => raw.slice(span.start, span.end).trim())

  it.each(['Capt.', 'Lt.', 'Col.', 'Gen.', 'Sgt.', 'Rev.', 'Gov.', 'Sen.', 'Fr.'])(
    'reads %s Smith as one sentence, not two',
    (title) => {
      expect(sentences(`${title} Smith came in. Then he sat.`)).toEqual([`${title} Smith came in.`, 'Then he sat.'])
    },
  )

  /* The ambiguity this pass accepts, pinned so it is a decision rather than a
     surprise: `St.` merges because a title before a name is the commoner shape. */
  it('still reads St. Paul as one sentence', () => {
    expect(sentences('We met at St. Paul today. Then we left.')).toEqual(['We met at St. Paul today.', 'Then we left.'])
  })
})
