import { describe, expect, it } from 'vitest'
import type { TocItem } from 'foliate-js/view.js'
import { chapterSteps, flattenToc, stepChapter } from './tocOrder'

/**
 * `tocOrder` had NO test file, which is how a duplicate destination stayed
 * invisible: the contents pane renders the tree and never steps through it, and
 * the reading steps through it and never renders it. One module, two consumers,
 * and nothing asking it a question.
 */

const item = (label: string, href: string | null, subitems?: TocItem[]): TocItem =>
  ({ label, href, ...(subitems ? { subitems } : {}) }) as unknown as TocItem

describe('flattenToc', () => {
  it('reads a tree in the order a reader moves through it', () => {
    const toc = [item('One', '/1.html', [item('One.a', '/1a.html')]), item('Two', '/2.html')]
    expect(flattenToc(toc).map((e) => e.href)).toEqual(['/1.html', '/1a.html', '/2.html'])
  })

  /* ⚠️ **THIS PINNED A CLAMP AT 2, INSIDE THE SHARED TRAVERSAL.** The 2 is a
     fact about the contents pane's three indent tokens and about nothing in any
     book, so clamping here threw the real hierarchy away for every other caller
     — read-aloud's chapter step reads this same list and has no indents at all.
     The traversal reports what the book says; `Contents` clamps to what it can
     draw, and `Contents.test.tsx` holds it to that. */
  it('reports the real depth, however deep the book nests', () => {
    const deep = [item('A', '/a', [item('B', '/b', [item('C', '/c', [item('D', '/d')])])])]
    expect(flattenToc(deep).map((e) => e.depth)).toEqual([0, 1, 2, 3])
  })

  /* ⚠️ **A REACT KEY MAY BE NEITHER THE FLATTENED INDEX NOR THE HREF.** The index
     moves when anything above is inserted; the href is not unique, because a part
     divider and its first chapter may legally share a destination — the same
     duplication `stepChapter` has to dedupe for below. The tree path is unique by
     construction. */
  it('gives every entry a path unique to its place in the tree', () => {
    const toc = [
      item('One', '/dup.html', [item('One.a', '/dup.html')]),
      item('Two', '/dup.html'),
    ]
    const paths = flattenToc(toc).map((e) => e.path)
    expect(paths).toEqual(['0', '0.0', '1'])
    expect(new Set(paths).size, 'unique even where every href is the same').toBe(paths.length)
  })

  /* A depth no recursive flatten would survive. The old one spread each
     descendant array again at every level up the tree and recursed once per
     level, so a book's own data could exhaust the stack. */
  it('flattens a pathologically deep tree without recursing', () => {
    let nest = item('leaf', '/leaf')
    for (let at = 0; at < 20000; at += 1) nest = item(`n${at}`, `/n${at}`, [nest])
    const flat = flattenToc([nest])
    expect(flat.length).toBe(20001)
    expect(flat[flat.length - 1]?.href).toBe('/leaf')
    expect(flat[flat.length - 1]?.depth).toBe(20000)
  })
})

describe('stepChapter', () => {
  const toc = [item('One', '/1.html'), item('Two', '/2.html'), item('Three', '/3.html')]

  it('moves forward and back', () => {
    expect(stepChapter(toc, '/1.html', 1)).toBe('/2.html')
    expect(stepChapter(toc, '/2.html', -1)).toBe('/1.html')
  })

  it('answers null at either end', () => {
    expect(stepChapter(toc, '/1.html', -1)).toBeNull()
    expect(stepChapter(toc, '/3.html', 1)).toBeNull()
  })

  it('answers null for a place the contents never names', () => {
    /* A reader can be in a spine item no entry points at, and guessing a
       neighbour would move them somewhere they did not ask for. */
    expect(stepChapter(toc, '/nowhere.html', 1)).toBeNull()
  })

  it('skips a grouping heading, which is a row and not a place', () => {
    const withDivider = [item('One', '/1.html'), item('PART TWO', null), item('Two', '/2.html')]
    expect(stepChapter(withDivider, '/1.html', 1)).toBe('/2.html')
  })

  it('treats an EMPTY href as no destination either', () => {
    /* ⚠️ A nav that writes `href=""` rather than omitting it is a heading all the
       same. Counted as a place, it made `''` — the reader in a section the
       contents never names — a position with neighbours, and stepped them
       relative to a heading they were never at. */
    const withBlank = [item('PART ONE', ''), item('One', '/1.html'), item('Two', '/2.html')]
    expect(stepChapter(withBlank, '', 1), 'an unnamed place has no neighbours').toBeNull()
    expect(stepChapter(withBlank, '/1.html', -1), 'and a heading is not one').toBeNull()
    expect(stepChapter(withBlank, '/1.html', 1)).toBe('/2.html')
  })
})

describe('chapterSteps', () => {
  const toc = [item('One', '/1.html'), item('Two', '/2.html'), item('Three', '/3.html')]

  it('answers for each direction from where the reader is', () => {
    const first = chapterSteps(toc, '/1.html', () => {})
    expect([first.can(-1), first.can(1)]).toEqual([false, true])
    const last = chapterSteps(toc, '/3.html', () => {})
    expect([last.can(-1), last.can(1)]).toEqual([true, false])
  })

  it('goes to the neighbour, and says that it moved', () => {
    const went: string[] = []
    const steps = chapterSteps(toc, '/2.html', (href) => went.push(href))
    expect(steps.go(1)).toBe(true)
    expect(steps.go(-1)).toBe(true)
    expect(went).toEqual(['/3.html', '/1.html'])
  })

  it('declines a step with nowhere to go, and goes nowhere', () => {
    /* ⚠️ **THE ANSWER `useSpeech` IS BUILT ON.** A step that declines must say
       so, because the reading tears down a pending sentence gap only for a step
       that actually moved — a `true` here for a step into nothing would leave
       the voice silent with the transport still showing a reading. */
    const went: string[] = []
    const steps = chapterSteps(toc, '/3.html', (href) => went.push(href))
    expect(steps.go(1)).toBe(false)
    expect(went, 'nothing was navigated to').toEqual([])
  })

  it('offers nothing to a reader in a section the contents never names', () => {
    const steps = chapterSteps(toc, '', () => {})
    expect([steps.can(-1), steps.can(1)]).toEqual([false, false])
    expect(steps.go(1)).toBe(false)
  })
})

describe('a destination two entries share', () => {
  /**
   * ⚠️ **A PART DIVIDER AND ITS FIRST CHAPTER MAY LEGALLY TARGET THE SAME HREF**,
   * and `findIndex` takes the first occurrence — so "next" from the parent
   * answered the CURRENT href and the button did nothing, while "previous" from
   * the child skipped a chapter. Two rows that go to one place are one place.
   */
  const shared = [
    item('PART ONE', '/1.html', [item('Chapter One', '/1.html')]),
    item('Chapter Two', '/2.html'),
  ]

  it('moves forward rather than answering where it already is', () => {
    expect(stepChapter(shared, '/1.html', 1)).toBe('/2.html')
  })

  it('does not skip a chapter going back', () => {
    expect(stepChapter(shared, '/2.html', -1)).toBe('/1.html')
  })

  it('still treats genuinely distinct destinations as distinct', () => {
    /* So the deduplication cannot pass by collapsing everything. */
    expect(stepChapter(shared, '/2.html', 1)).toBeNull()
    expect(flattenToc(shared)).toHaveLength(3)
  })
})
