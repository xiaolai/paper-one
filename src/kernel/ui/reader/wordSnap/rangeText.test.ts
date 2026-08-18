import { describe, expect, it } from 'vitest'
import { rangeText } from './rangeText'
import { buildFixture, elem, txt } from './domFake.testkit'
import { FakeRange } from './selectionFake.testkit'

/**
 * What a selection SAYS, as against where it sits.
 *
 * `session.test.ts` drives this module through a whole gesture, which is the
 * integration proof. What is here instead is everything that path cannot reach:
 * the two ways this declines and falls back to `range.toString()`, and the
 * markup real books are written in — where a block boundary is an element edge,
 * a whitespace-only text node holding the source's indentation, and another
 * element edge, all in a row. A fixture without that whitespace makes the join
 * look simpler than it is.
 *
 * The `unit` lane has no DOM environment and no jsdom, deliberately, so these
 * run against the same keyed fakes as the rest of the directory —
 * `domFake.testkit.ts` for the tree, `FakeRange` for a range that computes its
 * own text by walking it. That `<p>a</p><p>b</p>` really yields `'ab'` in WebKit
 * is a claim about WebKit, and modelling it faithfully is the most this lane can
 * do.
 *
 * **Live-lane partner: the `live` lane** — `node scripts/word-snap-live.mjs`,
 * checks `block-merge` and `br-merge`, which assert exactly that claim and its
 * fix in one real-engine run. The lane is manual-only — **check whether it has
 * been run before treating this pairing as met.**
 */

/** `<div><p>all done</p><p>Start here</p></div>` — the minimal block pair. */
function blocks(): { range: Range } {
  const fixture = buildFixture(
    elem('div', { id: 'page' }, [
      elem('p', { id: 'first' }, [txt('all done')]),
      elem('p', { id: 'second' }, [txt('Start here')]),
    ]),
  )
  return {
    range: new FakeRange(fixture.text('all done'), 4, fixture.text('Start here'), 5).asRange(),
  }
}

describe('rangeText', () => {
  it('leaves a selection inside one block exactly as it was', () => {
    /*
     * The no-regression case, at the level where it is a statement about this
     * module rather than about the session: a window with no block boundary in
     * it has no sentinel, so the join is the same concatenation `toString()`
     * would have produced — interior double spaces and source newlines
     * included. Anything cleverer here would silently rewrite the text of every
     * mark in the book.
     */
    const data = 'one  two\n  three'
    const fixture = buildFixture(elem('p', { id: 'para' }, [txt(data)]))
    const range = new FakeRange(fixture.text(data), 0, fixture.text(data), data.length).asRange()

    expect(rangeText(range)).toBe(data)
    expect(rangeText(range)).toBe(range.toString())
  })

  it('spells a block boundary that `toString` welds shut', () => {
    const { range } = blocks()

    expect(rangeText(range)).toBe('done\nStart')
    expect(range.toString()).toBe('doneStart')
  })

  it('spells the source whitespace around a boundary as one break, not three', () => {
    /*
     * `<p>all done </p>\n  <p> Start here</p>` — a trailing space, an
     * indentation-only text node between the elements, and a leading space.
     * That is what an EPUB looks like, and the naive join produces
     * `'done \n\n   Start'`: one boundary spelled four times over. It renders as
     * a single break, so it reads as a single break here.
     */
    const fixture = buildFixture(
      elem('div', { id: 'page' }, [
        elem('p', { id: 'first' }, [txt('all done ')]),
        txt('\n  '),
        elem('p', { id: 'second' }, [txt(' Start here')]),
      ]),
    )
    const range = new FakeRange(
      fixture.text('all done '),
      4,
      fixture.text(' Start here'),
      6,
    ).asRange()

    expect(rangeText(range)).toBe('done\nStart')
  })

  it('falls back to the range`s own text when the window cannot reach both edges', () => {
    /*
     * A selection longer than the flattener's budget has no flat coordinate for
     * its far edge, and there is nothing to join against. The published text is
     * then what shipped before this module existed — the block boundary is lost
     * again, which is a worse answer and not a wrong one. Losing the popup
     * instead would be the wrong answer.
     *
     * `maxChars: 4` is what forces it; the real bound is 20 000 and reaching it
     * takes a selection nobody makes by hand.
     */
    const { range } = blocks()

    expect(rangeText(range, { maxChars: 4 })).toBe('doneStart')
    expect(rangeText(range, { maxChars: 4 })).toBe(range.toString())
  })

  it('falls back when a boundary is not in a text node at all', () => {
    /* A selection over whole elements has element containers, and the
     * flattener's positions are text positions. Hand-built rather than taken
     * from `FakeRange`, whose boundaries are text nodes by construction — which
     * is the point: this shape cannot arise from the fake, only from WebKit. */
    const fixture = buildFixture(elem('p', { id: 'para' }, [txt('whole element')]))
    const range = {
      startContainer: fixture.element('para'),
      startOffset: 0,
      endContainer: fixture.element('para'),
      endOffset: 1,
      toString: () => 'whole element',
    } as unknown as Range

    expect(rangeText(range)).toBe('whole element')
  })

  it('strips a soft hyphen from what it says and never from the range', () => {
    const data = 'hyphen­ation'
    const fixture = buildFixture(elem('p', { id: 'para' }, [txt(data)]))
    const range = new FakeRange(fixture.text(data), 0, fixture.text(data), data.length).asRange()

    expect(rangeText(range)).toBe('hyphenation')
    // Untouched: stripping it from the range would move the highlight.
    expect(range.toString()).toContain('­')
  })
})
