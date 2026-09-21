import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkDetail, View } from 'foliate-js/view.js'
import { FOOTNOTE } from '../../core/metrics'
import { PARK_OFFSET } from '../../core/placement'
import { Footnotes, noteSpace, releaseNoteView, watchNoteLinks, type NoteSession } from './footnotes'

/**
 * `FootnoteHandler`, replaced by an `EventTarget` a test can dispatch on — the
 * seam `session.footnoteDispose.test.ts` uses, for the reason it gives: the
 * note's view reaches `Footnotes` only through the handler's `before-render`
 * and `render`, and there is no other way in. One handler per click, recorded
 * as it is built, and `handle` answers from `answers` in order.
 *
 * The three helper suites below do not touch the handler; the mock is inert
 * for them.
 */
const foliate = vi.hoisted(() => ({
  handlers: [] as EventTarget[],
  answers: [] as (Promise<void> | 'decline' | 'throw')[],
}))

/**
 * The two treatments a note's document gets besides the script strip.
 *
 * Mocked because what is under test here is that the note document gets them at
 * all — each has its own suite for what it does, and neither shows its work on
 * a document fake small enough to be readable.
 */
const treatments = vi.hoisted(() => ({ small: [] as unknown[], generated: [] as unknown[] }))
vi.mock('./markSmallText', () => ({ markSmallText: (doc: unknown) => treatments.small.push(doc) }))
vi.mock('./generatedContent', () => ({
  suppressEmptyGeneratedContent: (doc: unknown) => treatments.generated.push(doc),
}))

vi.mock('foliate-js/footnotes.js', () => ({
  FootnoteHandler: class extends EventTarget {
    constructor() {
      super()
      foliate.handlers.push(this)
    }
    handle() {
      const answer = foliate.answers.shift() ?? Promise.resolve()
      if (answer === 'decline') return undefined
      if (answer === 'throw') throw new Error('this backend has no resolveHref')
      return answer
    }
  },
}))

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

  it('says so when closing threw, rather than swallowing it', () => {
    /* The teardown must not stop the note going away, and it must not go
       quietly either: what fails here is a renderer letting go of its
       observers. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cause = new Error('renderer already gone')
    releaseNoteView({
      close: () => {
        throw cause
      },
      remove: () => {},
    } as never)
    expect(warn).toHaveBeenCalledWith('Paper: a note view would not close cleanly', cause)
    warn.mockRestore()
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

/* ------------------------------------------------------------------------- */

/** A box that says where it is, which is all a host or a mount is asked. */
function box(left = 0, top = 0) {
  const appended: unknown[] = []
  return {
    appended,
    getBoundingClientRect: () => ({ left, top, width: 0, height: 0 }),
    appendChild: (node: unknown) => {
      appended.push(node)
      return node
    },
  }
}

/** The session a note is owned by: its latch, its callbacks, its reader. */
function owner() {
  const calls: Record<string, unknown[][]> = {}
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      ;(calls[name] ??= []).push(args)
    }
  let disposed = false
  const host = box(5, 7)
  const session: NoteSession = {
    host: host as unknown as HTMLElement,
    disposed: () => disposed,
    onFootnote: rec('onFootnote'),
    onLink: rec('onLink'),
    onExternalLink: rec('onExternalLink'),
    goTo: rec('goTo'),
    applyVars: rec('applyVars'),
    styleNote: rec('styleNote'),
  }
  return { session, calls, host, dispose: () => (disposed = true) }
}

/** A note's view: its listeners, its renderer's attributes, and its teardown. */
function noteView({ renderer = true } = {}) {
  const listeners: Record<string, ((event: Event) => void)[]> = {}
  const attributes = new Map<string, string>()
  const released: string[] = []
  const view = {
    close: () => released.push('close'),
    remove: () => released.push('remove'),
    addEventListener: (type: string, fn: (event: Event) => void) => {
      ;(listeners[type] ??= []).push(fn)
    },
    style: { cssText: '' },
    renderer: renderer
      ? { setAttribute: (name: string, value: string) => void attributes.set(name, value) }
      : undefined,
  }
  const emit = (type: string, detail: unknown) => {
    const event = new CustomEvent(type, { detail, cancelable: true })
    for (const fn of listeners[type] ?? []) fn(event)
    return event
  }
  return { view: view as unknown as View, listeners, attributes, released, emit }
}

/** A reference marker in a book page, framed at `(100, 50)` in the window. */
function reference({ role = null as string | null, framed = true, measurable = true } = {}) {
  const doc: Record<string, unknown> = {
    defaultView: framed
      ? {
          frameElement: {
            getBoundingClientRect: () => ({ left: 100, top: 50, width: 600, height: 800 }),
            offsetWidth: 600,
            offsetHeight: 800,
          },
        }
      : null,
    getElementById: () => null,
  }
  doc['createRange'] = () => {
    if (!measurable) throw new Error('this document is gone')
    /* A range measures NOTHING until something is selected in it — a collapsed
       one has no box, which is what `rangeBoxInHost` refuses. */
    let selected: unknown = null
    return {
      selectNode: (node: unknown) => (selected = node),
      startContainer: { ownerDocument: doc },
      getBoundingClientRect: () =>
        selected ? { left: 10, top: 20, width: 8, height: 12 } : { left: 0, top: 0, width: 0, height: 0 },
    }
  }
  return {
    getAttribute: (name: string) => (name === 'href' ? 'notes.xhtml#n1' : name === 'role' ? role : null),
    getAttributeNS: () => null,
    matches: () => false,
    parentElement: null,
    ownerDocument: doc,
  } as unknown as Element
}

const book = {} as View['book']
const link = (a = reference()): { detail: LinkDetail; event: Event } => ({
  detail: { a, href: 'notes.xhtml#n1' } as unknown as LinkDetail,
  event: new Event('link', { cancelable: true }),
})

/** One click on a reference; the handler that click built. */
function click(notes: Footnotes, a?: Element) {
  const before = foliate.handlers.length
  const { detail, event } = link(a)
  const taken = notes.open(book, detail, event)
  return { taken, detail, event, handler: foliate.handlers[before] }
}

function beforeRender(handler: EventTarget | undefined, note: { view: View }) {
  handler?.dispatchEvent(new CustomEvent('before-render', { detail: { view: note.view } }))
}
function render(handler: EventTarget | undefined, note: { view: View }) {
  handler?.dispatchEvent(
    new CustomEvent('render', { detail: { view: note.view, href: 'notes.xhtml#n1', type: 'footnote' } }),
  )
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Footnotes', () => {
  beforeEach(() => {
    foliate.handlers.length = 0
    foliate.answers.length = 0
    treatments.small.length = 0
    treatments.generated.length = 0
  })
  afterEach(() => vi.restoreAllMocks())

  describe('offering a link', () => {
    it('takes nothing from a view with no book, and builds no handler', () => {
      const notes = new Footnotes(owner().session)
      const { detail, event } = link()
      expect(notes.open(undefined, detail, event)).toBe(false)
      expect(foliate.handlers).toEqual([])
    })

    it('hands a backlink back to the ordinary link path', () => {
      const notes = new Footnotes(owner().session)
      const { detail, event } = link(reference({ role: 'doc-backlink' }))
      expect(notes.open(book, detail, event)).toBe(false)
      expect(foliate.handlers).toEqual([])
    })

    it('answers false for a link the handler declines, and leaves the open note current', async () => {
      const { session, calls } = owner()
      const notes = new Footnotes(session)
      const first = click(notes)
      foliate.answers.push('decline')
      /* Following an ordinary link is not dismissing a note. */
      expect(click(notes).taken).toBe(false)
      const note = noteView()
      beforeRender(first.handler, note)
      render(first.handler, note)
      expect(calls['onFootnote']?.at(-1)?.[0]).toMatchObject({ view: note.view })
      expect(note.released).toEqual([])
    })
  })

  describe('a note the handler takes', () => {
    it('is styled, flowed as one scrolled column, parked on the host and shown at its anchor', () => {
      const { session, calls, host } = owner()
      const notes = new Footnotes(session)
      const { taken, handler } = click(notes)
      expect(taken).toBe(true)
      const note = noteView()
      beforeRender(handler, note)

      expect(calls['styleNote']).toEqual([[note.view]])
      expect(Object.fromEntries(note.attributes)).toEqual({
        margin: '0px',
        gap: '0px',
        'max-column-count': '1',
        flow: 'scrolled',
      })
      expect(Object.keys(note.listeners).sort()).toEqual(['external-link', 'link', 'load'])
      expect((note.view as unknown as { style: { cssText: string } }).style.cssText).toBe(
        `position:absolute;left:${PARK_OFFSET}px;top:0;width:${FOOTNOTE.maxWidth}px;height:${FOOTNOTE.maxHeight}px`,
      )
      expect(host.appended).toEqual([note.view])

      render(handler, note)
      /* The anchor is measured from the host when nothing else was reported:
         the frame at (100, 50), the marker at (10, 20) inside it, the host at
         (5, 7). */
      expect(calls['onFootnote']).toEqual([
        [
          {
            view: note.view,
            href: 'notes.xhtml#n1',
            type: 'footnote',
            at: { left: 105, top: 63, width: 8, height: 12, right: 113, bottom: 75 },
          },
        ],
      ])
    })

    it('goes into the mount it was given, sized by the stylesheet, and measured from the box it reported', () => {
      const { session, calls, host } = owner()
      const notes = new Footnotes(session)
      const mount = box()
      notes.setMount(mount as unknown as HTMLElement, box(30, 40) as unknown as HTMLElement)
      const { handler } = click(notes)
      const note = noteView()
      beforeRender(handler, note)
      render(handler, note)
      expect(mount.appended).toEqual([note.view])
      expect(host.appended).toEqual([])
      expect((note.view as unknown as { style: { cssText: string } }).style.cssText).toBe('')
      expect(calls['onFootnote']?.[0]?.[0]).toMatchObject({ at: { left: 80, top: 30 } })
    })

    it('goes back to the host once the mount is taken away', () => {
      const { session, host } = owner()
      const notes = new Footnotes(session)
      notes.setMount(box() as unknown as HTMLElement)
      notes.setMount(null)
      const { handler } = click(notes)
      const note = noteView()
      beforeRender(handler, note)
      expect(host.appended).toEqual([note.view])
    })

    it('is shown even by a view with no renderer to configure', () => {
      /* The fixed-layout renderer implements none of `setAttribute`'s
         neighbours, and a note view arriving without a renderer at all must
         still be mounted rather than throw inside the dispatch. */
      const { session, calls, host } = owner()
      const notes = new Footnotes(session)
      const { handler } = click(notes)
      const note = noteView({ renderer: false })
      expect(() => beforeRender(handler, note)).not.toThrow()
      expect(host.appended).toEqual([note.view])
      render(handler, note)
      expect(calls['onFootnote']?.[0]?.[0]).toMatchObject({ view: note.view })
    })

    it('has no anchor for a marker whose page cannot be measured', () => {
      const { session, calls } = owner()
      const notes = new Footnotes(session)
      /* The last has no document at all, which is what a section re-render
         leaves behind — and is measured through the same road as a document
         that will not give a range. */
      const orphan = { ...(reference() as unknown as Record<string, unknown>), ownerDocument: null } as unknown as Element
      for (const a of [reference({ measurable: false }), reference({ framed: false }), orphan]) {
        const { handler } = click(notes, a)
        const note = noteView()
        beforeRender(handler, note)
        render(handler, note)
        expect(calls['onFootnote']?.at(-1)?.[0]).toMatchObject({ at: null })
      }
    })

    it('lets go of the note it replaces', () => {
      const notes = new Footnotes(owner().session)
      const first = click(notes)
      const older = noteView()
      beforeRender(first.handler, older)
      render(first.handler, older)
      const second = click(notes)
      beforeRender(second.handler, noteView())
      expect(older.released).toEqual(['close', 'remove'])
    })
  })

  describe('a note that arrives too late', () => {
    it('is released, not shown, when the book closed first', () => {
      const { session, calls, dispose } = owner()
      const notes = new Footnotes(session)
      const { handler } = click(notes)
      dispose()
      const note = noteView()
      beforeRender(handler, note)
      render(handler, note)
      expect(note.released).toEqual(['close', 'remove'])
      expect(calls['styleNote']).toBeUndefined()
      expect(calls['onFootnote']).toBeUndefined()
    })

    it('is released, not shown, when the reader closed it while it resolved', () => {
      const { session, calls, host } = owner()
      const notes = new Footnotes(session)
      const { handler } = click(notes)
      notes.close()
      const note = noteView()
      beforeRender(handler, note)
      render(handler, note)
      expect(note.released).toEqual(['close', 'remove'])
      expect(host.appended).toEqual([])
      expect(calls['onFootnote']).toEqual([[null]])
    })

    it('is released at render when a newer click came between, and the newer one is shown', () => {
      const { session, calls } = owner()
      const notes = new Footnotes(session)
      const first = click(notes)
      const older = noteView()
      beforeRender(first.handler, older)
      const second = click(notes)
      render(first.handler, older)
      expect(older.released).toEqual(['close', 'remove'])
      expect(calls['onFootnote']).toBeUndefined()
      const newer = noteView()
      beforeRender(second.handler, newer)
      render(second.handler, newer)
      expect(calls['onFootnote']?.[0]?.[0]).toMatchObject({ view: newer.view })
    })

    it('is not shown when the book closed between the two events', () => {
      const { session, calls, dispose } = owner()
      const notes = new Footnotes(session)
      const { handler } = click(notes)
      const note = noteView()
      beforeRender(handler, note)
      dispose()
      render(handler, note)
      expect(calls['onFootnote']).toBeUndefined()
    })
  })

  describe('a note that cannot be shown in place', () => {
    it('jumps there instead when the handler throws, telling the host where the reader left from', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { session, calls } = owner()
      const notes = new Footnotes(session)
      const shown = click(notes)
      const open = noteView()
      beforeRender(shown.handler, open)
      foliate.answers.push('throw')
      const { taken, detail, event } = click(notes)
      expect(taken, 'the link is still handled — by the jump').toBe(true)
      expect(warn).toHaveBeenCalledWith('Paper: that note could not be resolved', 'notes.xhtml#n1', expect.any(Error))
      expect(open.released, 'the note already mounted is let go').toEqual(['close', 'remove'])
      expect(calls['onFootnote']).toEqual([[null]])
      expect(calls['onLink']).toEqual([[detail, event]])
      expect(calls['goTo']).toEqual([['notes.xhtml#n1']])
    })

    it('jumps there when the render fails, and the failed request is the current one', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { session, calls } = owner()
      const notes = new Footnotes(session)
      foliate.answers.push(Promise.reject(new Error('the note would not render')))
      click(notes)
      await settle()
      expect(warn).toHaveBeenCalledWith('Paper: that note could not be shown in place', 'notes.xhtml#n1', expect.any(Error))
      expect(calls['goTo']).toEqual([['notes.xhtml#n1']])
      /* And the request it failed for is over: a render arriving now is not shown. */
    })

    it('leaves a newer note alone when an older request fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { session, calls } = owner()
      const notes = new Footnotes(session)
      let fail: (cause: unknown) => void = () => {}
      foliate.answers.push(new Promise<void>((_, reject) => (fail = reject)))
      click(notes)
      click(notes)
      fail(new Error('too late to matter'))
      await settle()
      expect(warn).toHaveBeenCalledWith('Paper: a superseded note could not be shown in place', 'notes.xhtml#n1', expect.any(Error))
      expect(calls['goTo']).toBeUndefined()
      expect(calls['onFootnote']).toBeUndefined()
    })

    it('does nothing at all once the book has closed', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { session, calls, dispose } = owner()
      const notes = new Footnotes(session)
      let fail: (cause: unknown) => void = () => {}
      foliate.answers.push(new Promise<void>((_, reject) => (fail = reject)))
      click(notes)
      dispose()
      fail(new Error('after the book closed'))
      await settle()
      expect(warn).not.toHaveBeenCalled()
      expect(calls).toEqual({})
    })
  })

  describe("the note's own document and links", () => {
    function shown() {
      const own = owner()
      const notes = new Footnotes(own.session)
      const { handler } = click(notes)
      const note = noteView()
      beforeRender(handler, note)
      render(handler, note)
      return { ...own, notes, note }
    }

    it('gets the accessibility floor and the dead-content sweep the page gets', () => {
      const { note } = shown()
      const doc = { getElementsByTagNameNS: () => [], querySelectorAll: () => [] }
      note.emit('load', { doc })
      expect(treatments.small).toEqual([doc])
      expect(treatments.generated).toEqual([doc])
    })

    it("strips the note document's scripts and gives it the reader's settings, until the book closes", () => {
      const { note, calls, dispose } = shown()
      const removed: string[] = []
      const doc = {
        getElementsByTagNameNS: () => [{ remove: () => removed.push('script') }],
        querySelectorAll: () => [],
        body: null,
        documentElement: null,
        defaultView: null,
        styleSheets: [],
        getElementById: () => null,
      }
      note.emit('load', { doc })
      expect(removed).toEqual(['script'])
      expect(calls['applyVars']).toEqual([[doc]])
      dispose()
      note.emit('load', { doc })
      expect(calls['applyVars']).toHaveLength(1)
    })

    it('moves the reader, not the note, for a link inside it — and closes the note first', () => {
      const { note, calls } = shown()
      const event = note.emit('link', { href: 'ch02.xhtml#back' })
      expect(event.defaultPrevented).toBe(true)
      expect(calls['onFootnote']?.at(-1)).toEqual([null])
      expect(calls['onLink']?.[0]?.[0]).toEqual({ href: 'ch02.xhtml#back' })
      expect(calls['goTo']).toEqual([['ch02.xhtml#back']])
    })

    it("hands a note's external link to the host, and tells the host nothing once the book has closed", () => {
      const { note, calls, dispose } = shown()
      note.emit('external-link', { href_: 'https://example.org' })
      expect(calls['onExternalLink']).toHaveLength(1)
      dispose()
      note.emit('external-link', { href_: 'https://example.org' })
      note.emit('link', { href: 'ch02.xhtml' })
      expect(calls['onExternalLink']).toHaveLength(1)
      expect(calls['onLink']).toBeUndefined()
    })
  })

  describe('which note the reader is waiting for', () => {
    /**
     * ⚠️ **A COUNTER THAT MOVED BACKWARDS WOULD REOPEN A DISMISSED NOTE.** Each
     * request carries the number it claimed, and anything arriving under an
     * older one is released. That holds only while the number never repeats: a
     * count that went down by one would hand a later request the number a
     * request the reader had already left behind was holding, and that request's
     * render would pass the check and replace the note on screen.
     */
    const dismissedThenClicked = (leave: (notes: Footnotes) => void) => {
      const own = owner()
      const notes = new Footnotes(own.session)
      const left = click(notes)
      leave(notes)
      const next = click(notes)
      const stale = noteView()
      beforeRender(left.handler, stale)
      render(left.handler, stale)
      return { ...own, notes, stale, next }
    }

    it('never shows a note the reader closed, however many clicks followed', () => {
      const { stale, calls } = dismissedThenClicked((notes) => notes.close())
      expect(stale.released).toEqual(['close', 'remove'])
      expect(calls['onFootnote']).toEqual([[null]])
    })

    it('never shows a note left behind when the book closed the flow for good', () => {
      const { stale, calls } = dismissedThenClicked((notes) => notes.release())
      expect(stale.released).toEqual(['close', 'remove'])
      expect(calls['onFootnote']).toBeUndefined()
    })

    it('never shows a note left behind by one that could not be resolved', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { stale, calls } = dismissedThenClicked((notes) => {
        foliate.answers.push('throw')
        click(notes)
      })
      expect(stale.released).toEqual(['close', 'remove'])
      /* The jump the failure made, and nothing about the stale note. */
      expect(calls['onFootnote']).toEqual([[null]])
      expect(warn).toHaveBeenCalled()
    })
  })

  describe('closing', () => {
    it('lets go of the open note and tells the host — but not once the book has closed', () => {
      const { session, calls, dispose } = owner()
      const notes = new Footnotes(session)
      const { handler } = click(notes)
      const note = noteView()
      beforeRender(handler, note)
      notes.close()
      expect(note.released).toEqual(['close', 'remove'])
      expect(calls['onFootnote']).toEqual([[null]])
      dispose()
      notes.close()
      expect(calls['onFootnote']).toEqual([[null]])
    })

    it('releases for good without telling anyone, and nothing in flight is shown afterwards', () => {
      const { session, calls } = owner()
      const notes = new Footnotes(session)
      const open = click(notes)
      const note = noteView()
      beforeRender(open.handler, note)
      const pending = click(notes)
      notes.release()
      expect(note.released).toEqual(['close', 'remove'])
      const late = noteView()
      beforeRender(pending.handler, late)
      expect(late.released, 'superseded by the release').toEqual(['close', 'remove'])
      expect(calls['onFootnote']).toBeUndefined()
    })

    it('does not release a view twice when render follows a release at before-render', () => {
      const { session } = owner()
      const notes = new Footnotes(session)
      const { handler } = click(notes)
      notes.close()
      const note = noteView()
      beforeRender(handler, note)
      render(handler, note)
      expect(note.released).toEqual(['close', 'remove'])
    })
  })
})
