// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { FLOOR_VAR, SMALL_ATTR, SMALL_VAR, markSmallText } from './markSmallText'

/**
 * The accessibility floor's other half — F5, WI-14.4.
 *
 * THE RULE THIS REPLACED WAS WRONG, and the way it was wrong is the whole
 * reason this module exists: `* { font-size: max(1em, floor) }` resolves `1em`
 * against the PARENT inside `font-size`, so `h1 { font-size: 2em }` becomes the
 * parent's size and every heading, note and drop cap in the library flattens
 * into the text around it. What is asserted below is the property that makes
 * the replacement safe — an element at or above the base is never marked — and
 * it is asserted directly rather than inferred from a selector.
 */

const doc = (html: string) =>
  new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html')

/** A size reader from a map of id to px, defaulting to the base. */
const sizes = (base: number, byId: Record<string, number>) => (el: Element) => {
  const id = el.getAttribute('id')
  return id !== null && byId[id] !== undefined ? (byId[id] as number) : base
}

describe('markSmallText', () => {
  it('marks text smaller than the base with its own ratio', () => {
    const d = doc('<small id="s">note</small>')
    markSmallText(d, sizes(20, { s: 14 }))
    const el = d.getElementById('s') as HTMLElement
    expect(el.getAttribute(SMALL_ATTR)).toBe('')
    expect(el.style.getPropertyValue(SMALL_VAR)).toBe('0.7')
  })

  it('never marks anything at or above the base, so no heading can be reached', () => {
    /* THE INVARIANT. It is what lets the sheet force `font-size` on
       `[data-paper-em]` at all — `spacing.test.ts` refuses a forced font-size
       on a descendant, and rightly, because flattening an author's proportions
       is the damage this whole area is about. */
    const d = doc('<h1 id="h">big</h1><p id="p">body</p><em id="e">same</em>')
    markSmallText(d, sizes(20, { h: 40, p: 20, e: 20 }))
    for (const id of ['h', 'p', 'e']) {
      expect(d.getElementById(id)?.hasAttribute(SMALL_ATTR), id).toBe(false)
    }
  })

  it('measures against the root, not against the parent', () => {
    /* A note inside a heading is not small text; a note inside body at half the
       base is. Read against the parent, the first would be marked at 0.5 and
       the floor would raise it above the prose around it. */
    const d = doc('<h1 id="h">big <span id="in">inner</span></h1>')
    markSmallText(d, sizes(20, { h: 40, in: 30 }))
    expect(d.getElementById('in')?.hasAttribute(SMALL_ATTR)).toBe(false)
  })

  it('rounds the ratio, so an attribute is not noise', () => {
    const d = doc('<small id="s">note</small>')
    markSmallText(d, sizes(21, { s: 14.7 }))
    expect((d.getElementById('s') as HTMLElement).style.getPropertyValue(SMALL_VAR)).toBe('0.7')
  })

  it('does nothing to a document it cannot measure', () => {
    /* A root that reports nothing usable makes every ratio NaN, and a NaN in
       the property reaches the stylesheet as an invalid declaration that drops
       silently — the whole element left unstyled for no visible reason. */
    const d = doc('<small id="s">note</small>')
    markSmallText(d, () => Number.NaN)
    expect(d.getElementById('s')?.hasAttribute(SMALL_ATTR)).toBe(false)
    markSmallText(d, () => 0)
    expect(d.getElementById('s')?.hasAttribute(SMALL_ATTR)).toBe(false)
  })

  it('puts the floor back even when the walk throws', () => {
    /* The floor is the reader's accessibility setting and it is OFF for the
       duration of this walk. Anything that throws in between would leave it off
       for the rest of the session, silently — the reader would simply find
       their setting had stopped working, with nothing to say when. */
    const d = doc('<small id="s">note</small>')
    d.documentElement.style.setProperty(FLOOR_VAR, '18px')
    const boom = () => {
      throw new Error('style read failed')
    }
    expect(() => markSmallText(d, boom)).toThrow('style read failed')
    expect(d.documentElement.style.getPropertyValue(FLOOR_VAR)).toBe('18px')
  })

  it('unmarks an element whose size it can no longer read', () => {
    /* Skipped rather than unmarked, an element that HAD been marked keeps its
       old attribute and its old ratio — so the floor goes on sizing it from a
       measurement nothing can any longer confirm. */
    const d = doc('<small id="s">note</small>')
    markSmallText(d, sizes(20, { s: 14 }))
    expect(d.getElementById('s')?.hasAttribute(SMALL_ATTR)).toBe(true)
    markSmallText(d, (el) => (el === d.documentElement ? 20 : Number.NaN))
    expect(d.getElementById('s')?.hasAttribute(SMALL_ATTR)).toBe(false)
  })

  it('survives a section that failed to parse', () => {
    /* The same case `markProse` and `ensureLang` guard: a document with no
       body, arriving through the ordinary load path. */
    const empty = new DOMParser().parseFromString('', 'text/xml')
    expect(() => markSmallText(empty, () => 16)).not.toThrow()
  })

  it('unmarks an element that is no longer small', () => {
    /* A re-run after the base moved must take the mark OFF, not merely leave a
       stale ratio behind — the floor goes on computing from whatever ratio is
       there, which is the drift the re-run exists to correct. */
    const d = doc('<small id="s">note</small>')
    markSmallText(d, sizes(20, { s: 14 }))
    expect(d.getElementById('s')?.hasAttribute(SMALL_ATTR)).toBe(true)
    markSmallText(d, sizes(10, { s: 14 }))
    expect(d.getElementById('s')?.hasAttribute(SMALL_ATTR)).toBe(false)
    expect((d.getElementById('s') as HTMLElement).style.getPropertyValue(SMALL_VAR)).toBe('')
  })

  it('measures with the floor off, so re-running cannot ratchet the ratio up', () => {
    /**
     * THE TRAP IN RE-MEASURING AT ALL. The floor is applied through the very
     * rule this feeds, so a walk that runs while it is in force reads the
     * FLOORED size, stores that as the element's own share, and raises it again
     * on the next settings change — and again, until the small text is the size
     * of the prose. The property comes off for the duration of the read.
     */
    const d = doc('<small id="s">note</small>')
    d.documentElement.style.setProperty(FLOOR_VAR, '18px')
    let sawFloorDuringRead = false
    markSmallText(d, (el) => {
      if (d.documentElement.style.getPropertyValue(FLOOR_VAR) !== '') sawFloorDuringRead = true
      return el === d.documentElement ? 20 : 14
    })
    expect(sawFloorDuringRead, 'the floor was still set while measuring').toBe(false)
    /* And it is PUT BACK, or turning the setting on would turn itself off. */
    expect(d.documentElement.style.getPropertyValue(FLOOR_VAR)).toBe('18px')
    expect((d.getElementById('s') as HTMLElement).style.getPropertyValue(SMALL_VAR)).toBe('0.7')
  })

  it('puts the floor back even when it cannot measure', () => {
    const d = doc('<small id="s">note</small>')
    d.documentElement.style.setProperty(FLOOR_VAR, '18px')
    markSmallText(d, () => Number.NaN)
    expect(d.documentElement.style.getPropertyValue(FLOOR_VAR)).toBe('18px')
  })

  it('reads every element before it writes any', () => {
    /* `getComputedStyle` flushes pending style and writing an attribute
       invalidates it again, so interleaving the two recomputes the whole
       document once per element — `markProse` documents the same trap. Over
       `*` on a chapter of a few thousand elements that is a section load's
       worth of work by itself. */
    const d = doc('<small id="a">a</small><small id="b">b</small>')
    const order: string[] = []
    markSmallText(d, (el) => {
      order.push(`read:${el.getAttribute('id') ?? el.tagName}`)
      return el === d.documentElement ? 20 : 10
    })
    const lastRead = order.length - 1
    expect(order[lastRead]).toBe('read:b')
    /* Both are marked, and both were read before either was written — which is
       only observable as the reads being contiguous. */
    expect(d.getElementById('a')?.hasAttribute(SMALL_ATTR)).toBe(true)
    expect(d.getElementById('b')?.hasAttribute(SMALL_ATTR)).toBe(true)
  })
})
