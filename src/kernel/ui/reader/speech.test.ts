// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { collectText, offsetIn, placeOf, textAtPoint } from './speech'
import type { HostRect } from './coordinates'

/**
 * ⚠️ **THIS FILE RAN IN jsdom FOR MONTHS WITHOUT DECLARING IT, AND THIS COMMENT
 * IS WHAT PUT IT THERE.** Vitest looks for its environment docblock by scanning
 * the WHOLE file, not the first line — so the sentence that used to stand here,
 * explaining which token a file would opt in with, WAS that token. The
 * environment was set by prose about the environment. `document` was therefore
 * available, one case below uses it, and this header spent three paragraphs
 * arguing that the file had no DOM.
 *
 * It is declared on line 1 now, where Vitest's first match is deterministic and
 * where a reader looks; the token is not written out again anywhere below, and
 * `scripts/test-environment.test.mjs` refuses a test file that only mentions it
 * in prose. Same shape as this repository's `Stryker disable` trap — to a grep
 * it is a directive, to the tool it is a sentence — and the same fix: ask the
 * tool, not the text.
 *
 * ## What is asserted here, and what is left to the running app
 *
 * `rangeAt` and the geometry are NOT unit-tested here, and that argument is
 * unchanged: a jsdom case would assert against jsdom's APPROXIMATION of
 * WebKit's layout rather than against WebKit, and layout is precisely what
 * they get wrong. They are verified against the running app through the MCP
 * bridge, on the engine the reader ships on, which is better evidence for the
 * thing that goes wrong — the highlight landing on the wrong word.
 *
 * `collectText`'s WALK is here, because none of it is layout. The computed
 * styles it reads come from the case, through a stub `defaultView` of three
 * properties, so what is under test is what `collectText` does with an answer
 * rather than what jsdom would have answered. A document built with
 * `createHTMLDocument` has no `defaultView` at all, which is the other half:
 * the walk with no styles available is a real case the audiobook meets.
 *
 * The follow-along's page decision IS here, because it is arithmetic over two
 * rects — the measuring of those rects is `coordinates.ts`'s and the hook's,
 * and narration's `useSpeech.test.tsx` mounts the wiring over stubbed rects.
 * `Speaker`, the word it reports and `speechAvailable` went with the reading
 * into the narration capability, and are tested beside it.
 */

/**
 * Where a spoken word is, relative to the page on screen.
 *
 * Host-space rects, as `coordinates.ts` hands them over: a paginated section
 * is laid out in columns wider than the stage, so a word four pages on has a
 * perfectly good rect — one the reader cannot see.
 */
describe('placeOf', () => {
  const box = (left: number, top: number, width: number, height: number): HostRect => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  })
  /** A 1000×800 stage. */
  const page = box(0, 0, 1000, 800)

  it('a word on the page is visible, even one only partly on it', () => {
    expect(placeOf(box(100, 100, 60, 20), page, 'ltr')).toBe('visible')
    // Straddling the right edge: the line is on screen, the word is cut. Not
    // a reason to turn — the reader can see where the voice is.
    expect(placeOf(box(980, 100, 60, 20), page, 'ltr')).toBe('visible')
  })

  it('a word in the next column is ahead in a left-to-right book', () => {
    expect(placeOf(box(1200, 100, 60, 20), page, 'ltr')).toBe('ahead')
  })

  it('a word in the previous column is behind, and is never turned to', () => {
    // The reader flipped forward to peek. Turning "to" a word behind the view
    // would mean `prev`, and following the voice backwards would fight the
    // reader's hand; turning forward would run away from it page after page.
    expect(placeOf(box(-500, 100, 60, 20), page, 'ltr')).toBe('behind')
  })

  it('a right-to-left book reads the columns the other way', () => {
    expect(placeOf(box(-500, 100, 60, 20), page, 'rtl')).toBe('ahead')
    expect(placeOf(box(1200, 100, 60, 20), page, 'rtl')).toBe('behind')
  })

  it('in scrolled flow the vertical axis decides, whichever way the text runs', () => {
    expect(placeOf(box(100, 900, 60, 20), page, 'ltr')).toBe('ahead')
    expect(placeOf(box(100, 900, 60, 20), page, 'rtl')).toBe('ahead')
    expect(placeOf(box(100, -100, 60, 20), page, 'ltr')).toBe('behind')
  })
})

/* A document with no `<body>` — an XML document that is not XHTML, a section
   whose parse produced none — made `createTreeWalker(null, …)` throw, so one
   such section ended an audiobook export as a crash instead of a chapter with
   nothing in it. */
describe('collectText without a body', () => {
  it('answers no text, rather than throwing', () => {
    const doc = document.implementation.createDocument(null, 'root', null)
    expect(doc.body).toBeNull()
    expect(collectText(doc)).toEqual({ text: '', segments: [], blocks: [] })
  })
})

/**
 * The walk, which is where the audible defects have been.
 *
 * ⚠️ **NOT A LAYOUT TEST, AND THAT IS THE WHOLE REASON IT CAN LIVE HERE.** Every
 * computed style `collectText` reads is supplied by the case, so nothing below
 * depends on what jsdom would answer — only on what the walk does with an
 * answer. A document from `createHTMLDocument` has NO `defaultView`, which is
 * the second half: with no window there are no styles to ask for, and
 * `blockAncestor` falls back to the parent element. Both states are real — the
 * reader has a window, the audiobook's section walk does not.
 *
 * The three things being pinned are the three that have been wrong and audible:
 * one space between blocks and never two, no space inside a word an inline
 * element divides, and a block index for text that lays out inside no block at
 * all.
 */
describe('collectText', () => {
  /** A body, with the computed `display` of every element decided by the case. */
  const bodyOf = (html: string, display?: (el: Element) => string): Document => {
    const doc = document.implementation.createHTMLDocument('')
    doc.body.innerHTML = html
    if (display) {
      Object.defineProperty(doc, 'defaultView', {
        configurable: true,
        value: {
          getComputedStyle: (el: Element) => ({
            display: display(el),
            visibility: 'visible',
            contentVisibility: 'visible',
          }),
        },
      })
    }
    return doc
  }

  /* ⚠️ **ONE SPACE BETWEEN TWO PARAGRAPHS, WHATEVER THE INDENTATION AROUND
     THEM.** A pretty-printed chapter has a whitespace node between nearly every
     pair of elements, and each one that adds a separator shifts every boundary
     offset after it — the follow-along highlight then drifts for the rest of the
     section. A leading one must add nothing at all: there is no word in front of
     it to separate. */
  it('separates blocks with a single space, and never opens with one', () => {
    const collected = collectText(bodyOf(' <p>One</p> <span> </span> <p>Two</p>'))
    expect(collected.text).toBe('One Two')
    expect(collected.blocks, 'where each paragraph begins').toEqual([0, 4])
    expect(collected.segments.map(({ start, end }) => [start, end])).toEqual([
      [0, 3],
      [4, 7],
    ])
  })

  /* AND NO SPACE INSIDE A WORD AN INLINE ELEMENT DIVIDES. `co<em>operate</em>`
     is two text nodes in one line of prose; a separator between them makes the
     voice say "co operate", and a block index for the second makes a paragraph
     step land in the middle of a word. */
  it('does not open a block for an inline element inside one', () => {
    const collected = collectText(
      bodyOf('<p>co<em>operate</em></p>', (el) => (el.tagName === 'EM' ? 'inline' : 'block')),
    )
    expect(collected.text).toBe('cooperate')
    expect(collected.blocks, 'one paragraph, one block').toEqual([0])
  })

  /* ⚠️ **AND TEXT THAT LAYS OUT INSIDE NO BLOCK AT ALL STILL BELONGS TO ONE.**
     `blockAncestor` answers null when every ancestor is inline, and `null !==
     null` is false — so without the first-node guard the section would have text
     in no paragraph, and every paragraph step in it would find nowhere to go. */
  it('records a first block for text with no block ancestor', () => {
    const collected = collectText(bodyOf('<span>Hello</span><span> there</span>', () => 'inline'))
    expect(collected.text).toBe('Hello there')
    expect(collected.blocks).toEqual([0])
  })

  /* A note marker is dropped WITH a gap, because it sits between words — and a
     gap in front of the first word is not a gap, it is an indent the voice reads
     as a pause and every offset after it carries. */
  it('leaves a gap where a note marker was, but not before the first word', () => {
    const between = collectText(bodyOf('<p>He left.<a epub:type="noteref">1</a>Then she stayed.</p>'))
    expect(between.text).toBe('He left. Then she stayed.')

    const leading = collectText(bodyOf('<p><a epub:type="noteref">1</a>Hello.</p>'))
    expect(leading.text).toBe('Hello.')
    expect(leading.blocks).toEqual([0])
  })
})

describe('where a place in the document falls in the collected text', () => {
  /** A section whose prose runs over two paragraphs and an inline element. */
  function page() {
    const doc = document.implementation.createHTMLDocument('t')
    doc.body.innerHTML = '<p>One <em>two</em> three.</p><p>Four five.</p><p hidden>Not read.</p>'
    return doc
  }

  it('answers the offset of a caret inside a node the voice reads', () => {
    const doc = page()
    const spoken = collectText(doc)
    const first = doc.querySelector('p')!.firstChild!
    expect(offsetIn(spoken, first, 0)).toBe(0)
    expect(offsetIn(spoken, first, 4)).toBe(4)
    /* And the text it names is what `rangeAt` would give back, which is the
       round trip that makes the two directions one mapping. */
    const at = offsetIn(spoken, first, 4)!
    expect(spoken.text.slice(at, at + 3)).toBe('two')
  })

  it('clamps a caret past the end of a node to that node, in a LATER segment', () => {
    /* ⚠️ **THE CLAMP'S UPPER BOUND IS `end - start`, AND `end + start` WAS
       INDISTINGUISHABLE — FOUND BY THE MUTATION SWEEP.** In the FIRST segment
       `start` is 0, so the two arithmetics agree and every case here passed. The
       second paragraph is where they differ, and a caret one past the last
       character of a node is an ordinary place for one to sit: the browser puts it
       there for a click at the right-hand edge of a word. */
    const doc = page()
    const spoken = collectText(doc)
    const second = doc.querySelectorAll('p')[1]!.firstChild!
    const text = second.textContent ?? ''
    const end = offsetIn(spoken, second, text.length)
    expect(end, 'the position just past the node').not.toBeNull()
    expect(
      spoken.text.slice(end!),
      'and it is the END of that node, not somewhere beyond it',
    ).toBe('')
    /* And well past it is the same place, rather than running into nothing. */
    expect(offsetIn(spoken, second, text.length + 50)).toBe(end)
  })

  it('reaches a node inside an inline element, which is where a word splits', () => {
    const doc = page()
    const spoken = collectText(doc)
    const em = doc.querySelector('em')!.firstChild!
    const at = offsetIn(spoken, em, 0)
    expect(at).not.toBeNull()
    expect(spoken.text.slice(at!, at! + 3)).toBe('two')
  })

  it('reaches the second paragraph, so a tap is not confined to the first', () => {
    const doc = page()
    const spoken = collectText(doc)
    const second = doc.querySelectorAll('p')[1]!.firstChild!
    const at = offsetIn(spoken, second, 0)
    expect(at).not.toBeNull()
    expect(spoken.text.slice(at!, at! + 4)).toBe('Four')
  })

  it('answers null for text the voice does not read', () => {
    /* ⚠️ A REAL ANSWER RATHER THAN A GUESS: a hidden note has nowhere in the
       sound to go, so a tap on it must do nothing rather than land somewhere
       plausible. */
    const doc = page()
    const spoken = collectText(doc)
    const hidden = doc.querySelector('p[hidden]')!.firstChild!
    expect(offsetIn(spoken, hidden, 0)).toBeNull()
    /* And for a node from another document entirely. */
    expect(offsetIn(spoken, page().body, 0)).toBeNull()
  })

  it('clamps a caret that sits one past the last character of a node', () => {
    /* A caret may be at `node.length`, which belongs to the NEXT node — reported
       raw it would name a character in a segment this one does not cover. */
    const doc = page()
    const spoken = collectText(doc)
    const first = doc.querySelector('p')!.firstChild as Text
    const end = offsetIn(spoken, first, first.length + 50)
    expect(end).not.toBeNull()
    expect(end).toBeLessThanOrEqual(spoken.text.length)
    expect(offsetIn(spoken, first, -5)).toBe(0)
  })
})

describe('the caret under a point', () => {
  it('prefers the spelling WebKit has, which is the platform the voices run on', () => {
    /* ⚠️ `caretPositionFromPoint` is the standard and `caretRangeFromPoint` is
       what Safari and this app's WebView answer to. A reader that knew only the
       standard would find no caret on the one platform the downloaded voices run
       on at all. */
    const asked: string[] = []
    const node = document.createTextNode('x')
    const doc = {
      caretRangeFromPoint: (x: number, y: number) => {
        asked.push(`legacy ${x},${y}`)
        return { startContainer: node, startOffset: 3 } as unknown as Range
      },
      caretPositionFromPoint: () => {
        asked.push('standard')
        return { offsetNode: node, offset: 9 }
      },
    } as unknown as Document
    expect(textAtPoint(doc, 10, 20)).toEqual({ node, offset: 3 })
    expect(asked).toEqual(['legacy 10,20'])
  })

  it('falls back to the standard where the older one is absent', () => {
    const node = document.createTextNode('x')
    const doc = {
      caretPositionFromPoint: (x: number, y: number) => ({ offsetNode: node, offset: x + y }),
    } as unknown as Document
    expect(textAtPoint(doc, 2, 3)).toEqual({ node, offset: 5 })
  })

  it('answers null where there is no caret, and where the document has neither', () => {
    const empty = { caretRangeFromPoint: () => null } as unknown as Document
    expect(textAtPoint(empty, 0, 0)).toBeNull()
    const neither = {} as unknown as Document
    expect(textAtPoint(neither, 0, 0)).toBeNull()
    const noPosition = { caretPositionFromPoint: () => null } as unknown as Document
    expect(textAtPoint(noPosition, 0, 0)).toBeNull()
  })
})
