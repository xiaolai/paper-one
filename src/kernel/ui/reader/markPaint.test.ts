import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DrawAnnotationDetail, View } from 'foliate-js/view.js'
import { foreignWeight } from '../../core/circle/foreign'
import { resolvedCfiForTesting } from '../../core/resolvedCfi.testkit'
import {
  attachForeign,
  attachMark,
  paintAnnotation,
  type ForeignAnchor,
  type MarkAnchor,
  type MarkPainters,
  type MarkPalette,
} from './markPaint'

/**
 * Drawing a mark, with no DOM and no session.
 *
 * The session's own suite drives these through `draw-annotation`; this one asks
 * the painting policy directly, option by option, because every option a painter
 * is handed is a decision — which painter, which colour, which document, which
 * element the band is measured against, which way the rule goes.
 */

const painters = { fill: 'FILL', underline: 'UNDERLINE', wave: 'WAVE' } as unknown as MarkPainters
const palette: MarkPalette = {
  fill: { yellow: 'fill-yellow', green: 'fill-green', purple: 'fill-purple' },
  rule: { yellow: 'rule-yellow', green: 'rule-green', purple: 'rule-purple' },
  foreign: 'friend',
  stranger: 'stranger',
}

/** A document that measures only what it is told to, and refuses a non-element
 *  the way `getComputedStyle` does. */
function bookDoc(modes: Map<object, string> = new Map(), view = true) {
  const doc = {
    body: null as unknown,
    defaultView: view
      ? {
          getComputedStyle: (el: unknown) => {
            if (el === null || typeof el !== 'object') throw new TypeError('not an Element')
            return { writingMode: modes.get(el) ?? '' }
          },
        }
      : null,
  }
  doc.body = { nodeType: 1, ownerDocument: doc }
  return doc as unknown as Document & { body: Element }
}
const element = (doc: unknown) => ({ nodeType: 1, ownerDocument: doc }) as unknown as Element
const textIn = (parent: Element) =>
  ({ nodeType: 3, ownerDocument: parent.ownerDocument, parentElement: parent }) as unknown as Node

function painting(annotation: unknown, { doc, container }: { doc?: unknown; container?: Node | undefined } = {}) {
  const draws: { fn: unknown; options: unknown }[] = []
  const detail = {
    annotation,
    doc,
    range: container ? { startContainer: container } : undefined,
    draw: (fn: unknown, options?: unknown) => draws.push({ fn, options }),
  } as unknown as DrawAnnotationDetail
  return { answer: paintAnnotation(detail, painters, palette), draws }
}

const mine = (over: Record<string, unknown> = {}) => ({ value: 'epubcfi(/6/4!/4/2)', kind: 'highlight', ...over })

describe('paintAnnotation — the reader\'s own marks', () => {
  it('fills a band in the fill colour, measured against the element the words are in', () => {
    const doc = bookDoc()
    const p = element(doc)
    const { answer, draws } = painting(mine({ tint: 'green', style: 'fill' }), { doc, container: textIn(p) })
    /* The ELEMENT, not the text node the range starts in: the band is measured
       against the font of the words, which a text node has no style of. */
    expect(draws).toEqual([{ fn: 'FILL', options: { color: 'fill-green', doc, at: p } }])
    expect(answer, 'a reader\'s own mark is reported').toBe(true)
  })

  it('measures against the container itself when the range starts on an element', () => {
    const doc = bookDoc()
    const figure = element(doc)
    const { draws } = painting(mine({ style: 'fill' }), { doc, container: figure as unknown as Node })
    expect(draws[0]?.options).toMatchObject({ at: figure })
  })

  it('draws a rule in the rule colour, told which way the text runs', () => {
    const modes = new Map<object, string>()
    const doc = bookDoc(modes)
    const p = element(doc)
    modes.set(p, 'vertical-rl')
    const { answer, draws } = painting(mine({ tint: 'purple', style: 'underline' }), { doc, container: textIn(p) })
    expect(draws).toEqual([{ fn: 'UNDERLINE', options: { color: 'rule-purple', writingMode: 'vertical-rl' } }])
    expect(answer).toBe(true)
  })

  it('reads a stored mark with no tint or style, or one it does not know, as a yellow fill', () => {
    for (const annotation of [mine(), mine({ tint: 'blue', style: 'dotted' })]) {
      const { draws } = painting(annotation)
      expect(draws).toEqual([{ fn: 'FILL', options: { color: 'fill-yellow', doc: null, at: null } }])
    }
  })

  it('finds the document through the range when the event carries none', () => {
    const doc = bookDoc()
    const p = element(doc)
    const { draws } = painting(mine({ style: 'fill' }), { container: textIn(p) })
    expect(draws[0]?.options).toMatchObject({ doc, at: p })
  })
})

describe('paintAnnotation — which way a rule goes', () => {
  const ruleFor = (doc: unknown, container?: Node) =>
    (painting(mine({ style: 'wave' }), { doc, container }).draws[0]?.options as { writingMode?: string })
      .writingMode

  it("measures the marked element when it is in this document, and the body when it is not", () => {
    const modes = new Map<object, string>()
    const doc = bookDoc(modes)
    const p = element(doc)
    modes.set(p, 'vertical-lr')
    modes.set(doc.body, 'horizontal-tb')
    expect(ruleFor(doc, textIn(p))).toBe('vertical-lr')
    const stranger = element(bookDoc())
    expect(ruleFor(doc, textIn(stranger)), 'an element of another document').toBe('horizontal-tb')
  })

  it('answers nothing for a document with no view, one with no body, and a style with no value', () => {
    expect(ruleFor(bookDoc(new Map(), false))).toBeUndefined()
    const bodiless = bookDoc()
    ;(bodiless as unknown as { body: null }).body = null
    expect(ruleFor(bodiless)).toBeUndefined()
    expect(ruleFor(bookDoc())).toBeUndefined()
    expect(ruleFor(null)).toBeUndefined()
  })
})

describe("paintAnnotation — other readers' passages", () => {
  const theirs = (kind: string, readers?: unknown) => ({ value: 'epubcfi(/6/4!/4/2)', kind, readers })

  it("underlines a friend's passage in the friend hue, heavier for more readers, and does not report it", () => {
    const doc = bookDoc()
    const { answer, draws } = painting(theirs('circle', 4), { doc })
    expect(draws).toEqual([
      { fn: 'UNDERLINE', options: { color: 'friend', width: foreignWeight(4), writingMode: undefined } },
    ])
    expect(foreignWeight(4)).not.toBe(foreignWeight(1))
    expect(answer, 'a foreign passage is not one of the reader\'s marks').toBe(false)
  })

  it("draws a stranger's in the stranger hue", () => {
    const { answer, draws } = painting(theirs('public', 2))
    expect(draws).toEqual([{ fn: 'UNDERLINE', options: { color: 'stranger', width: foreignWeight(2), writingMode: undefined } }])
    expect(answer).toBe(false)
  })

  it('reads a count that is not one as a single reader', () => {
    for (const readers of ['4', -2, 0, Number.NaN, undefined]) {
      const { draws } = painting(theirs('circle', readers))
      expect((draws[0]?.options as { width: number }).width, String(readers)).toBe(foreignWeight(1))
    }
  })
})

describe('paintAnnotation — what it refuses', () => {
  it('draws nothing, and reports nothing, for a kind it does not paint or an annotation that is not there', () => {
    for (const annotation of [mine({ kind: 'bookmark' }), mine({ kind: 42 }), mine({ kind: null }), { value: 'x' }, undefined]) {
      const { answer, draws } = painting(annotation)
      expect(draws, JSON.stringify(annotation)).toEqual([])
      expect(answer).toBe(false)
    }
  })
})

/** A view that records what it is asked to annotate, and can be told to fail. */
function annotating(fail?: 'reject' | 'throw') {
  const calls: { annotation: Record<string, unknown>; remove: boolean | undefined }[] = []
  const cause = new Error('this CFI does not resolve yet')
  const view = {
    addAnnotation: (annotation: Record<string, unknown>, remove?: boolean) => {
      calls.push({ annotation, remove })
      if (fail === 'throw') throw cause
      return fail === 'reject' ? Promise.reject(cause) : Promise.resolve()
    },
  } as unknown as View
  return { view, calls, cause }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('attachMark', () => {
  const anchor: MarkAnchor = {
    cfi: resolvedCfiForTesting('epubcfi(/6/4!/4/2)'),
    sectionIndex: 0,
    kind: 'highlight',
    tint: 'green',
    style: 'underline',
  }
  afterEach(() => vi.restoreAllMocks())

  it('hands foliate the anchor and the three values the painter reads back', () => {
    const { view, calls } = annotating()
    attachMark(view, anchor)
    attachMark(view, anchor, { remove: true })
    expect(calls).toEqual([
      { annotation: { value: 'epubcfi(/6/4!/4/2)', kind: 'highlight', tint: 'green', style: 'underline' }, remove: false },
      { annotation: { value: 'epubcfi(/6/4!/4/2)', kind: 'highlight', tint: 'green', style: 'underline' }, remove: true },
    ])
  })

  it('stays quiet about a speculative offer that did not take, whichever way it failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    attachMark(annotating('reject').view, anchor)
    expect(() => attachMark(annotating('throw').view, anchor)).not.toThrow()
    await settle()
    expect(error).not.toHaveBeenCalled()
  })

  it('reports a mark the reader made that did not appear, and one they removed that did not go', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const drawn = annotating('reject')
    attachMark(drawn.view, anchor, { report: true })
    const erased = annotating('throw')
    attachMark(erased.view, anchor, { remove: true, report: true })
    await settle()
    expect(error.mock.calls).toEqual([
      ['Paper: could not erase a mark', erased.cause],
      ['Paper: could not draw a mark', drawn.cause],
    ])
  })
})

describe('attachForeign', () => {
  const foreign = (over: Partial<ForeignAnchor> = {}): ForeignAnchor => ({
    cfi: resolvedCfiForTesting('epubcfi(/6/4!/4/2)'),
    sectionIndex: 0,
    key: 'circle:alice:pub1',
    audience: 'circle',
    readers: 3,
    ...over,
  })

  it("sends the passage with its key, its readers, and the painter kind its audience says", async () => {
    const { view, calls } = annotating()
    await expect(attachForeign(view, foreign())).resolves.toBe(true)
    await expect(attachForeign(view, foreign({ audience: 'public', key: 'public:k' }), true)).resolves.toBe(true)
    expect(calls).toEqual([
      { annotation: { value: 'epubcfi(/6/4!/4/2)', key: 'circle:alice:pub1', kind: 'circle', readers: 3 }, remove: false },
      { annotation: { value: 'epubcfi(/6/4!/4/2)', key: 'public:k', kind: 'public', readers: 3 }, remove: true },
    ])
  })

  it('answers false, and does not throw, when the passage does not take', async () => {
    /* The session's reconciliation keeps an anchor it could not erase, so the
       answer has to be the literal false it tests for, not merely falsy. */
    await expect(attachForeign(annotating('reject').view, foreign(), true)).resolves.toBe(false)
    await expect(attachForeign(annotating('throw').view, foreign())).resolves.toBe(false)
  })
})
