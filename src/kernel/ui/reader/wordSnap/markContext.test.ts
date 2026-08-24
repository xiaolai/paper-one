import { describe, expect, it } from 'vitest'
import { CONTEXT_CHARS, NO_CONTEXT, markContext } from './markContext'
import { buildFixture, elem, txt } from './domFake.testkit'
import { FakeRange } from './selectionFake.testkit'

/**
 * The text on either side of a mark, which is what makes a quote findable.
 *
 * Same lane and same fakes as the rest of this directory: no DOM environment, a
 * keyed tree from `domFake.testkit`, and `FakeRange` for a range that walks it.
 *
 * The cases that matter are the EDGES — a mark at the start of a section has no
 * prefix and a mark at the end has no suffix, and both are legitimate answers
 * rather than failures. Everything else is about making two copies of the same
 * sentence, set by two publishers, produce the same context.
 */

/** `<div><p>Call me Ishmael. Some years ago</p></div>` in one text node. */
function oneParagraph(text: string) {
  const fixture = buildFixture(elem('div', { id: 'page' }, [elem('p', {}, [txt(text)])]))
  return {
    at(from: number, to: number): Range {
      const node = fixture.text(text)
      return new FakeRange(node, from, node, to).asRange()
    },
  }
}

describe('markContext', () => {
  it('reads the text on each side of the mark', () => {
    const p = oneParagraph('Call me Ishmael. Some years ago')
    // "Ishmael"
    const { prefix, suffix } = markContext(p.at(8, 15))
    expect(prefix).toBe('Call me ')
    expect(suffix).toBe('. Some years ago')
  })

  it('keeps only the last characters before, and the first after', () => {
    const long = 'x'.repeat(200) + 'MARK' + 'y'.repeat(200)
    const p = oneParagraph(long)
    const { prefix, suffix } = markContext(p.at(200, 204))
    expect(prefix).toHaveLength(CONTEXT_CHARS)
    expect(suffix).toHaveLength(CONTEXT_CHARS)
    // The characters ADJACENT to the mark, not the far end of the paragraph.
    expect(prefix).toBe('x'.repeat(CONTEXT_CHARS))
    expect(suffix).toBe('y'.repeat(CONTEXT_CHARS))
  })

  /*
   * §16 E2 — THE STORED BUDGET DOES NOT MOVE, and the number is pinned as a
   * LITERAL rather than through the constant, because every other case in this
   * file reads `CONTEXT_CHARS` and would pass at any value it took.
   *
   * The pressure to widen it is real and arrives from a plausible direction:
   * `useGloss` used to spend this field as the sentence a model is asked to
   * define a word in, and 32 characters a side is far too little for that — the
   * measured case handed the model 70 characters out of 183, starting mid-word.
   * The fix (WI-16.4) walks the document for the sentence instead, precisely so
   * that this stays what it is.
   *
   * What widening it would cost: a prefix and a suffix are stored on EVERY mark
   * and carried in the sync feed, so tripling this triples the annotation
   * payload of every book on every device — to buy a re-anchoring hint that is
   * already "enough to disambiguate, short enough to store".
   */
  it('stores thirty-two characters a side, which the gloss must not widen', () => {
    expect(CONTEXT_CHARS).toBe(32)

    const long = 'x'.repeat(200) + 'MARK' + 'y'.repeat(200)
    const p = oneParagraph(long)
    const { prefix, suffix } = markContext(p.at(200, 204))

    expect(prefix).toHaveLength(32)
    expect(suffix).toHaveLength(32)
  })

  it('honours a caller that wants a different amount', () => {
    //           0123456789
    const p = oneParagraph('abcdefghijklmnop')
    // Marking 'i' at index 8: the three before it are 'fgh', not 'efg'.
    expect(markContext(p.at(8, 9), 3)).toEqual({ prefix: 'fgh', suffix: 'jkl' })
  })

  /* Both are ordinary, and neither is an error. A mark on the first words of a
   * chapter has nothing in front of it. */
  it('returns an empty prefix at the start of the text', () => {
    const p = oneParagraph('Call me Ishmael.')
    expect(markContext(p.at(0, 4)).prefix).toBe('')
  })

  it('returns an empty suffix at the end of the text', () => {
    const p = oneParagraph('Call me Ishmael.')
    const text = 'Call me Ishmael.'
    expect(markContext(p.at(text.length - 8, text.length)).suffix).toBe('')
  })

  /* The reason context is stored at all is to survive being compared against
   * ANOTHER publisher's setting of the same passage, where the source is
   * indented differently and wrapped at a different column. Whitespace runs are
   * an artefact of the file, not a fact about the sentence. */
  it('collapses whitespace, so two settings of one sentence agree', () => {
    const tight = oneParagraph('one two MARK three four')
    const loose = oneParagraph('one   two\n\n  MARK three\t\tfour')
    expect(markContext(tight.at(8, 12))).toEqual(markContext(loose.at(13, 17)))
  })

  it('drops soft hyphens, which are hyphenation and not text', () => {
    const text = 'under­stand MARK after'
    const p = oneParagraph(text)
    // The soft hyphen is a CHARACTER and occupies an offset, so 'MARK' starts
    // at 12 rather than at 11 — which is exactly why it has to be stripped
    // from the stored context and not from the offsets.
    const at = text.indexOf('MARK')
    expect(text.slice(at, at + 4)).toBe('MARK')
    expect(markContext(p.at(at, at + 4)).prefix).toBe('understand ')
  })

  /* Context spans block boundaries, because a mark at the top of a paragraph is
   * preceded by the end of the one before it and that is the real context. */
  it('reads across a block boundary', () => {
    const fixture = buildFixture(
      elem('div', { id: 'page' }, [
        elem('p', {}, [txt('the end of one.')]),
        elem('p', {}, [txt('MARK begins another')]),
      ]),
    )
    const node = fixture.text('MARK begins another')
    const context = markContext(new FakeRange(node, 0, node, 4).asRange())
    expect(context.prefix).toContain('end of one.')
    expect(context.suffix).toBe(' begins another')
  })

  it('declines rather than throwing when the range is not in text', () => {
    const fixture = buildFixture(elem('div', { id: 'page' }, [elem('p', {}, [txt('hello')])]))
    const element = fixture.element('page') as unknown as Text
    expect(markContext(new FakeRange(element, 0, element, 0).asRange())).toEqual(NO_CONTEXT)
  })
})
