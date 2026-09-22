import { describe, expect, it } from 'vitest'
import { directionOf } from './direction'

/**
 * Which way a section's text runs.
 *
 * THREE SOURCES AND AN ORDER between them, which is the whole of it. The
 * ribbon positions itself against the PAGE rather than the window — its CSS is
 * written with `inset-inline-end` — so an RTL book reported as LTR puts it at
 * the wrong corner of the page it marks, with the arithmetic that finds the
 * page's edge mirrored along with it.
 *
 * Shaped objects rather than a jsdom document: what is under test is which of
 * the three is believed, and each case here is one of them contradicting
 * another. A real document would have to be coaxed into these states through
 * the very cascade this is deciding how to read.
 */
describe('directionOf', () => {
  const asDoc = (over: {
    computed?: string
    bodyComputed?: string
    htmlDir?: string | null
    bodyDir?: string | null
    root?: boolean
  }): Document => {
    const html =
      over.root === false
        ? null
        : ({ getAttribute: () => over.htmlDir ?? null } as unknown as HTMLElement)
    const body =
      over.bodyDir === undefined && over.bodyComputed === undefined
        ? null
        : ({ getAttribute: () => over.bodyDir ?? null } as unknown as HTMLElement)
    return {
      documentElement: html,
      body,
      defaultView:
        over.computed || over.bodyComputed
          ? {
              getComputedStyle: (el: unknown) => ({
                direction: el === body ? (over.bodyComputed ?? over.computed) : over.computed,
              }),
            }
          : null,
    } as unknown as Document
  }

  it('believes what the page COMPUTED to, over what it declared', () => {
    /* The author's stylesheet has had its say by the time a section renders,
       and it can overrule the attribute in either direction. */
    expect(directionOf(asDoc({ computed: 'rtl', htmlDir: 'ltr' }))).toBe('rtl')
    expect(directionOf(asDoc({ computed: 'ltr', htmlDir: 'rtl' }))).toBe('ltr')
  })

  it("believes the BODY's computed direction when the root computes ltr", () => {
    /* `dir` does not propagate upward: `<body dir="rtl">` leaves `html`'s
       computed direction at `ltr` in every real engine, so reading the root
       alone answered `ltr` for every such book and the arrows ran backwards
       (audit round 1, #499). */
    expect(directionOf(asDoc({ computed: 'ltr', bodyComputed: 'rtl' }))).toBe('rtl')
    expect(directionOf(asDoc({ computed: 'ltr', bodyComputed: 'ltr', bodyDir: 'rtl' }))).toBe('ltr')
  })

  it('falls back to the declared direction with no view to compute against', () => {
    // A section that failed to parse hands back a document with no window.
    expect(directionOf(asDoc({ htmlDir: 'rtl' }))).toBe('rtl')
    expect(directionOf(asDoc({ bodyDir: 'rtl' }))).toBe('rtl')
  })

  it('answers ltr for a document that says nothing, and for one with no root', () => {
    expect(directionOf(asDoc({}))).toBe('ltr')
    expect(directionOf(asDoc({ root: false }))).toBe('ltr')
  })
})
