import { beforeEach, describe, expect, it } from 'vitest'
import { noteSpace, releaseNoteView, watchNoteLinks } from './footnotes'

/**
 * Letting go of a note's view.
 *
 * The order is the whole of it: `remove()` without `close()` leaves the
 * paginator's ResizeObserver on a container that has just gone to zero, and
 * the re-render it triggers reads `documentElement` off a document that is no
 * longer there. Closing a footnote took the book down with it.
 */
describe('releaseNoteView', () => {
  it('closes before it detaches', () => {
    const order: string[] = []
    releaseNoteView({
      close: () => order.push('close'),
      remove: () => order.push('remove'),
    } as never)
    expect(order).toEqual(['close', 'remove'])
  })

  it('still detaches when closing throws', () => {
    /* A teardown that fails must not leave the note on screen. The reader
       asked for it to go away, and that has to happen either way. */
    const order: string[] = []
    releaseNoteView({
      close: () => {
        order.push('close')
        throw new Error('renderer already gone')
      },
      remove: () => order.push('remove'),
    } as never)
    expect(order).toEqual(['close', 'remove'])
  })
})

/**
 * Which box a note's anchor rect is measured from.
 *
 * `at` is consumed as the `left` and `top` of an absolutely positioned box, so
 * it has to be measured from the element those resolve against. Taken from the
 * element foliate renders into, as it was, every rect is valid and every note
 * is drawn off by the stage's padding plus the column's titlebar inset — a
 * whole class of wrongness that no type and no rendering test can see, because
 * every number involved is correct.
 */
describe('noteSpace', () => {
  const boxed = (name: string) => ({ name, getBoundingClientRect: () => ({}) })
  const host = boxed('host') as unknown as HTMLElement

  it('takes the box the popover reported, which is the space `left` resolves in', () => {
    const within = boxed('stage') as unknown as HTMLElement
    expect(noteSpace(within, host)).toBe(within)
  })

  it('falls back to the host before the popover has mounted', () => {
    /* And the fallback is the OLD behaviour, deliberately: a wiring failure
       should put the note back where it used to be, not nowhere. */
    expect(noteSpace(null, host)).toBe(host)
  })

  it('falls back to the host for something that cannot be measured', () => {
    /* The capability, not the constructor — naming `HTMLElement` here throws
       in these suites, which have no DOM. */
    const within = { nodeName: 'DIV' } as unknown as HTMLElement
    expect(noteSpace(within, host)).toBe(host)
  })

  it('never reads `offsetParent`, which is the mistake it exists to prevent', () => {
    /* Derived as `mount.offsetParent`, this returned the POPOVER — parked at
       `left: -99999` — and every note was `detached` and invisible. If this
       ever consults it again, the getter says so. */
    let asked = 0
    const within = {
      getBoundingClientRect: () => ({}),
      get offsetParent() {
        asked += 1
        return null
      },
    } as unknown as HTMLElement
    expect(noteSpace(within, host)).toBe(within)
    expect(asked).toBe(0)
  })
})

/**
 * A link inside a NOTE moves the reader, not the note.
 *
 * Unhandled, foliate ends the note's own `link` event in `noteView.goTo(href)`
 * — so the `↩` at the end of an endnote loaded the whole chapter into a 90px
 * box while the reader stayed where they were. Measured in the app before the
 * fix, against *What's Our Problem?*.
 */
describe('watchNoteLinks', () => {
  /** A note view that hands its listeners straight back, with no DOM. */
  const noteView = () => {
    const on: Record<string, (event: Event) => void> = {}
    return {
      view: {
        addEventListener: (name: string, fn: (event: Event) => void) => {
          on[name] = fn
        },
      },
      fire: (name: string, detail: unknown) => {
        const event = { preventDefault: () => order.push('preventDefault'), detail } as never
        on[name]?.(event)
        return event
      },
    }
  }
  let order: string[] = []
  beforeEach(() => {
    order = []
  })

  const host = () => ({
    onLink: () => order.push('onLink'),
    onExternalLink: () => order.push('onExternalLink'),
    close: () => order.push('close'),
    goTo: (href: string) => order.push(`goTo:${href}`),
  })

  it('cancels the note view, closes the note, then moves the reader', () => {
    const note = noteView()
    watchNoteLinks(note.view, host())
    note.fire('link', { href: 'ch01.xhtml#ref' })
    /* `preventDefault` first, or the note navigates itself; `onLink` before
       `goTo`, or the origin is recorded from where the reader has already
       arrived and ⌘[ leads nowhere. */
    expect(order).toEqual(['preventDefault', 'close', 'onLink', 'goTo:ch01.xhtml#ref'])
  })

  it('hands an external link to the host, and does not navigate the book', () => {
    const note = noteView()
    watchNoteLinks(note.view, host())
    note.fire('external-link', { href_: 'https://example.org/x' })
    /* NOT cancelled here — the host cancels, as it does for the book, and
       decides where the href goes. Nothing moves the reader. */
    expect(order).toEqual(['onExternalLink'])
  })
})
