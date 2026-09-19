// @vitest-environment jsdom
import { startTransition, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Annotation, MarkStyle, MarkTint } from '../../core/marks'
import type { SelectionSnapshot } from './session'
import { SelectionTools, type SelectionToolsProps } from './SelectionTools'

/**
 * The popup itself, RENDERED — which faces it draws and where it puts them.
 *
 * THE THREE FACES — the bar, the mark styles and the copy options — and where
 * the popup puts each of them. A fourth face drew a language model's definition
 * and is deleted with the rest of the AI features; the cases that were about it
 * went with it, and the placement rules it shared with the rows did not.
 *
 * jsdom lays nothing out, so the geometry is supplied: a 1000×800 stage with the
 * book's frame filling it, a selected line at (400, 300) 200×20, and a popup
 * whose size is decided by the face it is showing — which is what the real one
 * does, every face being a different width. With that, `place` is real and every
 * expected number below is arithmetic: above the line is `300 − GAP(8) − height`,
 * and centred is `500`.
 */

afterEach(cleanup)

/**
 * Every element a `ResizeObserver` is watching, with the way to say it changed.
 *
 * RECORDED rather than stubbed out, because the popup is one of them: it can
 * change size with no render (a late font re-wraps an answer), and the only way
 * to show that it is placed again is to be the observer that says so.
 */
const watching: { readonly observer: object; readonly target: Element; readonly changed: () => void }[] = []
globalThis.ResizeObserver = class {
  readonly #callback: (entries: never[], observer: unknown) => void
  constructor(callback: (entries: never[], observer: unknown) => void) {
    this.#callback = callback
  }
  observe(target: Element) {
    /* As the real one does: watching nothing is a caller's mistake, not a no-op. */
    if (!(target instanceof Element)) throw new TypeError(`ResizeObserver.observe: ${String(target)} is not an Element`)
    watching.push({ observer: this, target, changed: () => this.#callback([], this) })
  }
  unobserve() {}
  disconnect() {
    for (let at = watching.length - 1; at >= 0; at -= 1) {
      if (watching[at]?.observer === this) watching.splice(at, 1)
    }
  }
} as never

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect

/** The popup's size, per face. Tests change it to make an answer arrive. */
let sizes: Record<string, { width: number; height: number }>

beforeEach(() => {
  sizes = {
    bar: { width: 240, height: 40 },
    marks: { width: 320, height: 40 },
    copy: { width: 160, height: 40 },
  }
})

/* The popup is the only element this component measures besides the stage,
   which carries its own box. Anything else asking is a change worth hearing
   about, not something to answer with zeros. */
Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
  const face = this.getAttribute('role') === 'toolbar' ? this.getAttribute('data-face') : null
  const size = face === null ? undefined : sizes[face]
  if (!size) throw new Error(`unexpected measurement of <${this.tagName.toLowerCase()}> (face ${String(face)})`)
  return rect(0, 0, size.width, size.height)
}

const STAGE = rect(0, 0, 1000, 800)

interface Scene {
  readonly selection: SelectionSnapshot
  readonly stage: HTMLElement
  /** Lay the selected words out somewhere else — what a reflow or a page turn does. */
  readonly move: (...lines: DOMRect[]) => void
}

/**
 * A selection whose lines are `lines`, in a book frame that fills the stage
 * unless `frameBox` says otherwise.
 *
 * ONE STAGE AND ONE SELECTION PER SCENE, kept across rerenders as `Reader`
 * keeps them: a new selection turns the popup back to the bar, and a new stage
 * re-measures, so minting either per render would test a different popup.
 */
function sceneOn(lines: DOMRect | readonly DOMRect[], stageBox: DOMRect = STAGE, frameBox: DOMRect = STAGE): Scene {
  let laidOut = ([] as DOMRect[]).concat(lines)
  const stage = document.createElement('div')
  stage.getBoundingClientRect = () => stageBox
  const frame = { getBoundingClientRect: () => frameBox, offsetWidth: frameBox.width, offsetHeight: frameBox.height }
  const view = { frameElement: frame, addEventListener() {}, removeEventListener() {} }
  const range = { startContainer: { ownerDocument: { defaultView: view, body: null } }, getClientRects: () => laidOut }
  const selection = { cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:4)', sectionIndex: 0, text: 'gams', prefix: '', suffix: '', range: range as unknown as Range }
  return {
    selection,
    stage,
    move: (...next) => {
      laidOut = next
    },
  }
}

const LINE = rect(400, 300, 200, 20)

function propsFor({ selection, stage }: Scene, over: Partial<SelectionToolsProps> = {}): SelectionToolsProps {
  return {
    selection,
    stage,
    column: null,
    marked: null,
    position: 0,
    appearance: { tint: 'yellow', style: 'fill' },
    onApply: () => {},
    canMark: true,
    onNote: () => {},
    onCopy: () => {},
    onCite: () => {},
    onRemove: () => {},
    ...over,
  }
}

const toolbar = (): HTMLElement => screen.getByRole('toolbar', { name: 'Selection tools' })
const placedAt = () => ({ top: toolbar().style.top, left: toolbar().style.left })

/** Which faces' own controls are on screen — one signature control each. */
const drawn = () => ({
  bar: screen.queryByRole('button', { name: 'Write a note on this passage' }) !== null,
  marks: screen.queryByRole('button', { name: 'Highlight marks' }) !== null,
  copy: screen.queryByRole('button', { name: 'Copy the passage with its book, author and place' }) !== null,
})

const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

/**
 * Every control on the face being shown, in order — what a screen reader hears,
 * the tooltip, whether it is pressed, and whether it is drawn lit (on the button
 * or on the disc inside it).
 */
const controls = () =>
  within(toolbar())
    .getAllByRole('button')
    .map((button) => ({
      name: button.getAttribute('aria-label'),
      title: button.getAttribute('title'),
      pressed: button.getAttribute('aria-pressed'),
      lit: button.getAttribute('data-lit') ?? button.querySelector('[data-lit]')?.getAttribute('data-lit') ?? null,
    }))

/** What a control is called and titled, for a face whose controls are not toggles. */
const plain = (name: string, title: string) => ({ name, title, pressed: null, lit: null })

/** A reader's mark or a companion's, on the passage `sceneOn` selects. */
const markOn = (kind: Annotation['kind'], tint: MarkTint, style: MarkStyle): Annotation => ({
  id: 'mark-1',
  bookId: 'book-1',
  cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:4)',
  sectionIndex: 0,
  text: 'gams',
  prefix: '',
  suffix: '',
  note: '',
  kind,
  tint,
  style,
  chapter: '',
  createdAt: 0,
})

describe('the selection popup, rendered', () => {
  it('draws the bar alone, centred on the line and hung a gap above it', () => {
    render(<SelectionTools {...propsFor(sceneOn(LINE))} />)

    expect(toolbar().getAttribute('data-face')).toBe('bar')
    expect(drawn()).toEqual({ bar: true, marks: false, copy: false })
    expect(placedAt()).toEqual({ top: '252px', left: '500px' })
  })

  /* ⚠️ **A PASSAGE WITH NO ANCHOR WAS OFFERED MARK AND NOTE** (2026-09-13 audit,
     #202). `useMarking` refuses to mark it — an empty CFI is not an anchor —
     so both buttons did nothing when pressed. A control that cannot act is not
     drawn. */
  it('offers neither Mark, its styles, nor a note for a passage that cannot be marked', () => {
    render(<SelectionTools {...propsFor(sceneOn(LINE), { canMark: false })} />)

    expect(screen.queryByRole('button', { name: /^Mark this passage/u })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Choose a colour and a style' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Write a note on this passage' })).toBeNull()
    /* What needs no anchor is still there. */
    expect(screen.getByRole('button', { name: 'Copy this passage' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'More ways to copy this passage' })).toBeTruthy()
  })

  it('turns to one face at a time through its own controls', () => {
    render(<SelectionTools {...propsFor(sceneOn(LINE))} />)

    press('Choose a colour and a style')
    expect(toolbar().getAttribute('data-face')).toBe('marks')
    expect(drawn()).toEqual({ bar: false, marks: true, copy: false })

    press('Back to the selection tools')
    expect(toolbar().getAttribute('data-face')).toBe('bar')
    expect(drawn()).toEqual({ bar: true, marks: false, copy: false })

    press('More ways to copy this passage')
    expect(toolbar().getAttribute('data-face')).toBe('copy')
    expect(drawn()).toEqual({ bar: false, marks: false, copy: true })
  })

  /* The chevron must stay under the pointer that pressed it: every face is a
     different width, and re-centring each one slides the popup sideways. */
  it('keeps the bar’s left edge for the other faces, and places the bar afresh', () => {
    render(<SelectionTools {...propsFor(sceneOn(LINE))} />)
    // The bar, 240 wide and centred on 500, has its left edge at 380.
    expect(placedAt().left).toBe('500px')

    press('Choose a colour and a style')
    // 320 wide from 380, where re-centring would have put its left edge at 340.
    expect(placedAt()).toEqual({ top: '252px', left: '540px' })

    press('Back to the selection tools')
    expect(placedAt().left).toBe('500px')

    press('More ways to copy this passage')
    // 160 wide from 380, where re-centring would have put it at 420.
    expect(placedAt().left).toBe('460px')
  })

  it('still keeps a held edge inside the stage', () => {
    render(<SelectionTools {...propsFor(sceneOn(rect(700, 300, 200, 20)))} />)
    // Centred on 800, 240 wide: left edge 680.
    expect(placedAt().left).toBe('800px')

    press('Choose a colour and a style')
    /* 320 wide from 680 would end at 1000, past the stage's 8px inset, so
       the edge is pulled back to 1000 − 8 − 320 = 672. */
    expect(placedAt().left).toBe('832px')
  })

  /* AND INSIDE THE COLUMN AS IT IS NOW. The edge was kept against the column
     the bar was placed in; a pane opening moves the column under an open face,
     which must come back inside the new one rather than hang off its left. */
  it('pulls a kept edge inside a column that has moved since the bar was placed', () => {
    const scene = sceneOn(rect(210, 300, 100, 20))
    const { rerender } = render(<SelectionTools {...propsFor(scene)} />)
    // Centred on 260, 240 wide: left edge 140.
    expect(placedAt().left).toBe('260px')

    press('Choose a colour and a style')
    // 320 wide from the kept 140.
    expect(placedAt().left).toBe('300px')

    rerender(<SelectionTools {...propsFor(scene, { column: { left: 200, width: 800 } })} />)
    // The column now starts at 200, so the edge is pushed to 200 + 8 = 208.
    expect(placedAt().left).toBe('368px')
  })

  /* ⚠️ **A POPUP CAN CHANGE SIZE WITH NOTHING RE-RENDERING IT** — a face whose
     font arrives late re-wraps — and it used to stay placed at the size it had
     been. The popup is CENTRED on the selection, so its width decides its left
     edge and a width that moves under it leaves it off-centre.

     ⚠️ **THIS WAS ABOUT THE DELETED LOOKUP FACE'S HEIGHT**, which was as tall as
     a language model's answer and was measured for exactly this reason. Every
     face left is one row, so the height is the constant `POPUP_H` and what a
     re-measure can still change is the width. The observer is the same one and
     is still the only thing that can report either. */
  describe('when it changes size on its own', () => {
    it('is placed again', () => {
      render(<SelectionTools {...propsFor(sceneOn(LINE))} />)
      // Centred on the line: 500 is the line's own centre, whatever the width.
      expect(placedAt()).toEqual({ top: '252px', left: '500px' })

      /* Wider than the room can centre: 990 on a 1000 stage leaves 5px each
         side, inside the 8px inset, so `place` PINS the leading edge and the
         popup is no longer centred on the line. */
      sizes.bar = { width: 990, height: 40 }
      const popup = watching.filter(({ target }) => target === toolbar())
      expect(popup.length, 'nothing is watching the popup itself').toBeGreaterThan(0)
      act(() => {
        for (const one of popup) one.changed()
      })

      // Pinned at the 8px inset, then turned back into a centre: 8 + 990 / 2.
      expect(placedAt()).toEqual({ top: '252px', left: '503px' })
    })

    /* Every time, not only the first: a signal that re-renders once and then
       carries the same value re-renders nothing the second time it is sent. */
    it('is placed again each time, not only the first', () => {
      render(<SelectionTools {...propsFor(sceneOn(LINE))} />)
      const resized = (width: number) => {
        sizes.bar = { width, height: 40 }
        act(() => {
          for (const one of watching.filter(({ target }) => target === toolbar())) one.changed()
        })
      }

      resized(990)
      expect(placedAt().left).toBe('503px')
      resized(600)
      // Still centred on the line — 600 fits either side of 500 inside the stage.
      expect(placedAt().left).toBe('500px')
      resized(1000)
      // Pinned again, one step further out: 8 + 1000 / 2.
      expect(placedAt().left).toBe('508px')
    })

    /* `place` can move a surface and cannot shrink one, so a face bigger than
       the room it is in ran on past the edge. The face is told its room here;
       that it scrolls inside it is the stylesheet's half, asserted in
       `screens/Reader.layout.test.ts`. */
    it('is bounded by the room it is placed in', () => {
      render(<SelectionTools {...propsFor(sceneOn(rect(400, 100, 200, 20), rect(0, 0, 1000, 200)))} />)

      // A 200-tall, 1000-wide stage, less the 8px inset at each edge.
      expect(toolbar().style.maxHeight).toBe('184px')
      expect(toolbar().style.maxWidth).toBe('984px')
    })
  })

  /* ⚠️ **EVERY FACE, AND IT WAS ONLY THE LOOKUP** (2026-09-13 audit, #159,
     round 3). The rows were left unbounded on the grounds that "a bound could
     only clip a control" — true of a bound with nothing to scroll, and the
     reason a row hung straight off a column narrower than itself, where `place`
     could only pin its leading edge and let the rest run over the margin. Every
     face is one popup in one room, so each is asked the same question here: a
     150-wide column in a 200-tall stage, which none of the four fits. */
  describe('in a column narrower than any of its faces', () => {
    const scene = () => sceneOn(rect(400, 100, 200, 20), rect(0, 0, 1000, 200))
    const narrow = { left: 450, width: 150 }
    /* The column's width and the stage's height, less the 8px inset at each edge. */
    const room = { maxWidth: '134px', maxHeight: '184px' }
    const bound = () => ({ maxWidth: toolbar().style.maxWidth, maxHeight: toolbar().style.maxHeight })

    it('bounds the bar', () => {
      render(<SelectionTools {...propsFor(scene(), { column: narrow })} />)
      expect(toolbar().getAttribute('data-face')).toBe('bar')
      expect(bound()).toEqual(room)
    })

    it('bounds the marks face', () => {
      render(<SelectionTools {...propsFor(scene(), { column: narrow })} />)
      press('Choose a colour and a style')
      expect(toolbar().getAttribute('data-face')).toBe('marks')
      expect(bound()).toEqual(room)
    })

    it('bounds the copy face', () => {
      render(<SelectionTools {...propsFor(scene(), { column: narrow })} />)
      press('More ways to copy this passage')
      expect(toolbar().getAttribute('data-face')).toBe('copy')
      expect(bound()).toEqual(room)
    })
  })

  /* ⚠️ THE SESSION REPUBLISHES THE SAME PASSAGE ON EVERY KEYUP IN THE BOOK, as a
     new snapshot object — and a new object used to count as a new selection, so
     any key sent a reader in the marks face back to the bar. */
  it('keeps the face a reader turned to when the same passage is published again', () => {
    const scene = sceneOn(LINE)
    const { rerender } = render(<SelectionTools {...propsFor(scene)} />)
    press('Choose a colour and a style')

    rerender(<SelectionTools {...propsFor({ ...scene, selection: { ...scene.selection } })} />)
    expect(toolbar().getAttribute('data-face')).toBe('marks')

    /* A different passage is a new selection, and does get the bar. */
    rerender(
      <SelectionTools
        {...propsFor({ ...scene, selection: { ...scene.selection, cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:10)', text: 'whale' } })}
      />,
    )
    expect(toolbar().getAttribute('data-face')).toBe('bar')
  })

  describe('with the keyboard', () => {
    const focused = () =>
      document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName

    /* ⚠️ EACH FACE IS ITS OWN ELEMENT, so the pressed control is unmounted by its
       own press — and focus used to fall to <body> with it. */
    it('carries focus into the face it turns to, and back to the chevron that opened it', () => {
      render(<SelectionTools {...propsFor(sceneOn(LINE))} />)
      const chevron = screen.getByRole('button', { name: 'Choose a colour and a style' })
      chevron.focus()

      fireEvent.click(chevron)
      expect(toolbar().getAttribute('data-face')).toBe('marks')
      expect(focused()).toBe('Back to the selection tools')

      fireEvent.click(document.activeElement as HTMLElement)
      expect(toolbar().getAttribute('data-face')).toBe('bar')
      expect(focused()).toBe('Choose a colour and a style')
    })

    /* A pointer never puts focus in the popup — its pointerdown is cancelled to
       keep the book's selection — so a press that began outside moves nothing. */
    it('leaves focus where it was for a press that did not start inside the popup', () => {
      const field = document.createElement('input')
      document.body.append(field)
      field.focus()
      try {
        render(<SelectionTools {...propsFor(sceneOn(LINE))} />)
        press('Choose a colour and a style')

        expect(toolbar().getAttribute('data-face')).toBe('marks')
        expect(document.activeElement).toBe(field)
      } finally {
        field.remove()
      }
    })

    /* The same promise with nothing focused anywhere, which is what a pointer
       press in the real app looks like: a turn it did not start with focus in
       the popup puts none there. */
    it('moves no focus for a press made with nothing focused', () => {
      render(<SelectionTools {...propsFor(sceneOn(LINE))} />)
      ;(document.activeElement as HTMLElement | null)?.blur()
      expect(document.activeElement, 'something was still focused before the press').toBe(document.body)

      press('Choose a colour and a style')

      expect(toolbar().getAttribute('data-face')).toBe('marks')
      expect(document.activeElement).toBe(document.body)
    })

    /* A PRESS THAT DOES NOT TURN THE POPUP LEAVES FOCUS ALONE. Copy acts on the
       passage and stays on the bar, so the control that was pressed is still
       there and focus has no reason to move.

       ⚠️ **THIS WAS WRITTEN ABOUT LOOK UP**, whose press asked App and could be
       answered with no lookup at all — the same shape, on a control that is
       deleted. Copy is the one that is left, and it is the stronger case: Look
       up called `turnFrom` first, so the effect ran and decided to do nothing,
       while Copy never sets the ref at all. */
    it('leaves focus on a control whose press did not turn the popup', () => {
      const scene = sceneOn(LINE)
      const { rerender } = render(<SelectionTools {...propsFor(scene)} />)
      const copy = screen.getByRole('button', { name: 'Copy this passage' })
      copy.focus()

      fireEvent.click(copy)
      rerender(<SelectionTools {...propsFor(scene)} />)

      expect(toolbar().getAttribute('data-face')).toBe('bar')
      expect(focused()).toBe('Copy this passage')
    })

    /* `document.activeElement` is null for a document with no element to
       report, and that is not a reader who moved on. */
    it('carries focus in even when the document names no active element', () => {
      render(<SelectionTools {...propsFor(sceneOn(LINE))} />)
      const chevron = screen.getByRole('button', { name: 'Choose a colour and a style' })
      chevron.focus()

      const nothing = vi.spyOn(document, 'activeElement', 'get')
      try {
        /* Live for `turnFrom`'s own read, which has to find the chevron INSIDE
           the popup or nothing is turned at all, and null for the effect's. */
        nothing.mockReturnValueOnce(chevron)
        nothing.mockReturnValue(null)
        fireEvent.click(chevron)
      } finally {
        nothing.mockRestore()
      }

      expect(focused()).toBe('Back to the selection tools')
    })

    /* The popup scrolls inside its bound, and focusing a control in it must not
       scroll the book's page or the popup to bring that control into view. jsdom
       scrolls nothing, so what is asked of the platform is what can be read. */
    it('moves focus without scrolling anything to it', () => {
      render(<SelectionTools {...propsFor(sceneOn(LINE))} />)
      const chevron = screen.getByRole('button', { name: 'Choose a colour and a style' })
      chevron.focus()
      const focus = vi.spyOn(HTMLElement.prototype, 'focus')
      try {
        fireEvent.click(chevron)
        expect(focused()).toBe('Back to the selection tools')
        expect(focus.mock.calls).toEqual([[{ preventScroll: true }]])
      } finally {
        focus.mockRestore()
      }
    })

    /* The popup can vanish in the very render that turns it — the column moves
       off the line as the face changes. There is no face to put focus in, and
       when the popup comes back it comes back without a crash. */
    it('turns nothing when the popup goes away in the same render', () => {
      const scene = sceneOn(LINE)
      const { rerender } = render(<SelectionTools {...propsFor(scene)} />)
      const chevron = screen.getByRole('button', { name: 'Choose a colour and a style' })
      chevron.focus()

      act(() => {
        fireEvent.click(chevron)
        rerender(<SelectionTools {...propsFor(scene, { column: { left: 700, width: 300 } })} />)
      })
      expect(screen.queryByRole('toolbar')).toBeNull()

      rerender(<SelectionTools {...propsFor(scene)} />)
      expect(toolbar().getAttribute('data-face')).toBe('marks')
    })
  })

  /* ⚠️ THE KEPT EDGE WAS WRITTEN DURING RENDER, so a render React threw away left
     its edge behind. A transition that suspends is such a render: this one
     narrows the column to 500, which clamps the bar's edge to 508, and never
     commits — so the bar on screen never left 380. The face turned to next has
     to hang from the bar the reader saw.
     THE COLUMN STILL OVERLAPS THE SELECTED LINE, deliberately. Moved clear of it
     (`left: 600` against a line ending at 600) the anchor is detached, the popup
     returns before it places anything, and the abandoned render writes nothing —
     a test that passes against the defect it was written for. */
  it('keeps the edge of the bar that was on screen, not of a render that never was', async () => {
    const scene = sceneOn(LINE)
    const never = new Promise<never>(() => {})
    function Suspends({ when }: { readonly when: boolean }) {
      if (when) throw never
      return null
    }
    let squeeze = () => {}
    function Host() {
      const [column, setColumn] = useState<SelectionToolsProps['column']>(null)
      squeeze = () => startTransition(() => setColumn({ left: 500, width: 400 }))
      return (
        <>
          <SelectionTools {...propsFor(scene, { column })} />
          <Suspends when={column !== null} />
        </>
      )
    }
    render(<Host />)
    expect(placedAt().left).toBe('500px')

    await act(async () => {
      squeeze()
    })
    expect(placedAt().left, 'the suspended render committed after all, which proves nothing').toBe('500px')

    press('Choose a colour and a style')
    // 320 wide from the edge the reader saw, 380; the thrown-away render said 508.
    expect(placedAt()).toEqual({ top: '252px', left: '540px' })
  })

  /* WHAT THE BAR OFFERS IS DECIDED HERE, AND ONLY HERE. `UNFINISHED_PANE_IDS`
     hides a panel on every shell, but it does not reach a button on this bar —
     so each face's controls are pinned exactly: which, in what order, and what a
     screen reader hears for each. */
  describe('what it offers', () => {
    it('offers an unmarked passage exactly Mark, its styles, Note, Copy and the other ways to copy', () => {
      const onApply = vi.fn()
      const onNote = vi.fn()
      const onCopy = vi.fn()
      const onCite = vi.fn()
      render(<SelectionTools {...propsFor(sceneOn(LINE), { onApply, onNote, onCopy, onCite })} />)

      expect(controls()).toEqual([
        plain('Mark this passage — highlight, yellow', 'Highlight · Yellow'),
        plain('Choose a colour and a style', 'Mark styles'),
        plain('Write a note on this passage', 'Note'),
        plain('Copy this passage', 'Copy'),
        plain('More ways to copy this passage', 'Copy options'),
      ])
      /* The glyph is drawn in the tint a press lays down. */
      expect(screen.getByRole('button', { name: 'Mark this passage — highlight, yellow' }).style.color).toBe(
        'var(--mark-yellow-rule)',
      )

      press('Mark this passage — highlight, yellow')
      press('Write a note on this passage')
      press('Copy this passage')
      /* A press on the bar is a decision, so Mark does not keep the selection. */
      expect(onApply.mock.calls).toEqual([[{ tint: 'yellow', style: 'fill' }, false]])
      expect([onNote, onCopy, onCite].map((one) => one.mock.calls.length)).toEqual([1, 1, 0])

      press('More ways to copy this passage')
      expect(controls()).toEqual([
        plain('Back to the selection tools', 'Back'),
        plain('Copy the passage on its own', 'Copy'),
        plain('Copy the passage with its book, author and place', 'Copy with citation'),
      ])
      press('Copy the passage on its own')
      press('Copy the passage with its book, author and place')
      expect([onCopy, onCite].map((one) => one.mock.calls.length)).toEqual([2, 1])
    })

    it('offers a marked passage its own mark to repeat and a way to remove it', () => {
      const onApply = vi.fn()
      const onRemove = vi.fn()
      render(
        <SelectionTools
          {...propsFor(sceneOn(LINE), { marked: markOn('highlight', 'green', 'underline'), onApply, onRemove })}
        />,
      )

      expect(controls()).toEqual([
        plain('Mark this passage — underline, green', 'Underline · Green'),
        plain('Choose a colour and a style', 'Mark styles'),
        plain('Write a note on this passage', 'Note'),
        plain('Copy this passage', 'Copy'),
        plain('More ways to copy this passage', 'Copy options'),
        plain('Remove this mark', 'Remove'),
      ])
      expect(screen.getByRole('button', { name: 'Mark this passage — underline, green' }).style.color).toBe(
        'var(--mark-green-rule)',
      )

      press('Mark this passage — underline, green')
      press('Remove this mark')
      expect(onApply.mock.calls).toEqual([[{ tint: 'green', style: 'underline' }, false]])
      expect(onRemove).toHaveBeenCalledTimes(1)
    })

    it('lights the passage’s own style and tint on the marks face, and applies each choice there keeping the selection', () => {
      const onApply = vi.fn()
      render(<SelectionTools {...propsFor(sceneOn(LINE), { marked: markOn('highlight', 'green', 'underline'), onApply })} />)
      press('Choose a colour and a style')

      expect(controls()).toEqual([
        plain('Back to the selection tools', 'Back'),
        { name: 'Highlight marks', title: 'Highlight', pressed: 'false', lit: 'false' },
        { name: 'Underline marks', title: 'Underline', pressed: 'true', lit: 'true' },
        { name: 'Mark this passage in yellow', title: 'Yellow', pressed: 'false', lit: 'false' },
        { name: 'Mark this passage in green', title: 'Green', pressed: 'true', lit: 'true' },
        { name: 'Mark this passage in purple', title: 'Purple', pressed: 'false', lit: 'false' },
      ])

      /* Each changes one axis of the mark in front of the reader and keeps the
         other, and keeps the selection so the next choice can be compared. */
      press('Highlight marks')
      press('Mark this passage in purple')
      expect(onApply.mock.calls).toEqual([
        [{ tint: 'green', style: 'fill' }, true],
        [{ tint: 'purple', style: 'underline' }, true],
      ])
    })

    /* No reader can choose a wave, but the appearance handed down is typed for
       one — `MARK_STYLES` still admits a stored one — and a control is named
       for what it would do. */
    it('names the wave, when that is the appearance a press would repeat', () => {
      render(<SelectionTools {...propsFor(sceneOn(LINE), { appearance: { tint: 'purple', style: 'wave' } })} />)
      expect(controls()[0]).toEqual(plain('Mark this passage — wave, purple', 'Wave · Purple'))
    })

    /* Clicking the host clears the book's selection in some engines before the
       click handler runs, so the press has to cancel its own pointerdown. */
    it('cancels the pointerdown of a press, so the book’s selection outlives it', () => {
      render(<SelectionTools {...propsFor(sceneOn(LINE))} />)
      expect(fireEvent.pointerDown(screen.getByRole('button', { name: 'Copy this passage' }))).toBe(false)
    })
  })

  describe('from one passage to the next', () => {
    /* Each of the four facts that make a passage, changed ALONE. The text on its
       own is the case for two passages foliate cannot address, whose CFIs are
       both empty. */
    it('gives a new passage the bar, whichever of its document, section, CFI or text is the new part', () => {
      const scene = sceneOn(LINE)
      const unaddressed = { ...scene.selection, cfi: '' }
      const passages: readonly (readonly [string, SelectionSnapshot, SelectionSnapshot])[] = [
        ['document', scene.selection, { ...scene.selection, range: sceneOn(LINE).selection.range }],
        ['section', scene.selection, { ...scene.selection, sectionIndex: 1 }],
        ['CFI', scene.selection, { ...scene.selection, cfi: 'epubcfi(/6/4!/4/2,/1:20,/1:24)' }],
        ['text', unaddressed, { ...unaddressed, text: 'whale' }],
      ]
      for (const [what, from, to] of passages) {
        const { rerender, unmount } = render(<SelectionTools {...propsFor({ ...scene, selection: from })} />)
        press('Choose a colour and a style')
        rerender(<SelectionTools {...propsFor({ ...scene, selection: to })} />)
        expect(toolbar().getAttribute('data-face'), `a new ${what}`).toBe('bar')
        unmount()
      }
    })

    it('draws nothing without a selection, and gives a passage selected again the bar', () => {
      const scene = sceneOn(LINE)
      const { rerender } = render(<SelectionTools {...propsFor(scene, { selection: null })} />)
      expect(screen.queryByRole('toolbar')).toBeNull()

      rerender(<SelectionTools {...propsFor(scene)} />)
      press('Choose a colour and a style')
      rerender(<SelectionTools {...propsFor(scene, { selection: null })} />)
      expect(screen.queryByRole('toolbar')).toBeNull()

      /* The same passage, chosen again after it was let go. */
      rerender(<SelectionTools {...propsFor(scene)} />)
      expect(toolbar().getAttribute('data-face')).toBe('bar')
    })
  })

  describe('following the words', () => {
    it('is placed on a new selection’s line', () => {
      const scene = sceneOn(LINE)
      const { rerender } = render(<SelectionTools {...propsFor(scene)} />)

      rerender(<SelectionTools {...propsFor({ ...scene, selection: sceneOn(rect(100, 500, 200, 20)).selection })} />)
      // 500 − 8 − 40 above a line centred on 200.
      expect(placedAt()).toEqual({ top: '452px', left: '200px' })
    })

    /* A page turn moves the text with nothing the host can observe; the position
       is the only thing that says so. */
    it('is measured again when the reader’s position moves the words from under it', () => {
      const scene = sceneOn(LINE)
      const { rerender } = render(<SelectionTools {...propsFor(scene, { position: 0 })} />)

      scene.move(rect(100, 500, 200, 20))
      rerender(<SelectionTools {...propsFor(scene, { position: 0 })} />)
      expect(placedAt(), 'measured again with no reason to').toEqual({ top: '252px', left: '500px' })

      rerender(<SelectionTools {...propsFor(scene, { position: 1 })} />)
      expect(placedAt()).toEqual({ top: '452px', left: '200px' })
    })

    /* A reflow — the pane opening, a font step, the window resizing — moves the
       words under a selection that outlives it. Selected AFTER mounting, so the
       watch has to be taken for this selection rather than the first render's. */
    it('follows the words when the page reflows under a live selection', () => {
      const scene = sceneOn(LINE)
      const { rerender } = render(<SelectionTools {...propsFor(scene, { selection: null })} />)
      rerender(<SelectionTools {...propsFor(scene)} />)
      expect(placedAt()).toEqual({ top: '252px', left: '500px' })

      scene.move(rect(100, 500, 200, 20))
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      expect(placedAt()).toEqual({ top: '452px', left: '200px' })
    })

    it('draws nothing while there is no stage to place it in, and returns with one', () => {
      const scene = sceneOn(LINE)
      const { rerender } = render(<SelectionTools {...propsFor(scene)} />)

      rerender(<SelectionTools {...propsFor(scene, { stage: null })} />)
      expect(screen.queryByRole('toolbar')).toBeNull()

      rerender(<SelectionTools {...propsFor(scene)} />)
      expect(placedAt()).toEqual({ top: '252px', left: '500px' })
    })

    it('stops watching the popup once it has gone', () => {
      const scene = sceneOn(LINE)
      const { rerender } = render(<SelectionTools {...propsFor(scene)} />)
      const popup = toolbar()
      expect(watching.some(({ target }) => target === popup)).toBe(true)

      rerender(<SelectionTools {...propsFor(scene, { selection: null })} />)
      expect(watching.some(({ target }) => target === popup)).toBe(false)
    })

    /* A line with no width is still a line — a selection ending at a line break
       can report one — and so is one with no height; a rect with neither is
       nothing, and must not be what the popup hangs from. */
    it('hangs from a line with no width or no height, and never from a rect with neither', () => {
      render(<SelectionTools {...propsFor(sceneOn(rect(500, 300, 0, 20)))} />)
      expect(placedAt()).toEqual({ top: '252px', left: '500px' })
      cleanup()

      render(<SelectionTools {...propsFor(sceneOn(rect(400, 300, 200, 0)))} />)
      expect(placedAt()).toEqual({ top: '252px', left: '500px' })
      cleanup()

      render(<SelectionTools {...propsFor(sceneOn([rect(900, 700, 0, 0), LINE]))} />)
      expect(placedAt()).toEqual({ top: '252px', left: '500px' })
    })

    /* A range's rects are not clipped to what is shown: in a paginated book the
       next page's lines resolve to rects beside this one. The frame here is half
       the stage, so a line at 600 is on a page nobody can see. */
    it('ignores a line on a page that is not being shown', () => {
      render(
        <SelectionTools
          {...propsFor(sceneOn([rect(600, 50, 200, 20), rect(100, 300, 200, 20)], STAGE, rect(0, 0, 500, 800)))}
        />,
      )
      expect(placedAt()).toEqual({ top: '252px', left: '200px' })
    })

    it('draws nothing for a line wholly outside the column it is bounded by', () => {
      render(<SelectionTools {...propsFor(sceneOn(LINE), { column: { left: 700, width: 300 } })} />)
      expect(screen.queryByRole('toolbar')).toBeNull()
    })

    /* No room above the first line, so it hangs below — below the LAST line,
       not the first, or it would cover the rest of what the reader chose. */
    it('hangs below every selected line when there is no room above them', () => {
      render(
        <SelectionTools {...propsFor(sceneOn([rect(400, 10, 200, 20), rect(400, 30, 200, 20), rect(400, 50, 120, 20)]))} />,
      )
      // The third line's foot is at 70, and the bar hangs 8 below it.
      expect(placedAt()).toEqual({ top: '78px', left: '500px' })
    })

    /* THE SELECTION IS KEPT CLEAR OF AS ONE BLOCK: every line, unioned, across
       and down. Over a column break that block spans both columns, so the head
       of the next column still counts as over the first line — in a book whose
       columns run left to right, and in one whose columns run right to left. */
    it('keeps clear of the whole block a selection spans across a column break, in either direction', () => {
      /* The foot of the left column, then the head of the right one. */
      render(<SelectionTools {...propsFor(sceneOn([rect(100, 700, 200, 20), rect(600, 40, 200, 20)]))} />)
      // No room above the block's top at 40, so below the first line: 720 + 8.
      expect(placedAt()).toEqual({ top: '728px', left: '200px' })
      cleanup()

      /* The foot of the right column, then the head of the left one. */
      render(<SelectionTools {...propsFor(sceneOn([rect(600, 700, 300, 20), rect(100, 40, 200, 20)]))} />)
      expect(placedAt()).toEqual({ top: '728px', left: '750px' })
    })

    it('slides the bar just inside the stage at its edge, rather than snapping it to the line’s start', () => {
      render(<SelectionTools {...propsFor(sceneOn(rect(10, 300, 100, 20)))} />)
      // Centred it would start at −60; slid to the 8px inset it is centred on 128, where snapping to the line would be 130.
      expect(placedAt()).toEqual({ top: '252px', left: '128px' })
    })

    /* 70 tall: no room above a line at 10, none below it either, so it is pinned
       inside the stage — 70 − 8 − 40 — rather than hung past its foot. */
    it('pins the bar inside a stage too short to hang it above or below the line', () => {
      render(<SelectionTools {...propsFor(sceneOn(rect(400, 10, 200, 20), rect(0, 0, 1000, 70)))} />)
      expect(placedAt()).toEqual({ top: '22px', left: '500px' })
    })

    /* The same half-pixel rule the height keeps, for the width a held edge is
       measured with. */
    it('keeps a held edge through half a pixel of width, and follows a whole one', () => {
      const scene = sceneOn(LINE)
      const { rerender } = render(<SelectionTools {...propsFor(scene)} />)
      press('Choose a colour and a style')
      expect(placedAt().left).toBe('540px')

      sizes.marks = { width: 320.5, height: 40 }
      rerender(<SelectionTools {...propsFor(scene)} />)
      expect(placedAt().left).toBe('540px')

      sizes.marks = { width: 321, height: 40 }
      rerender(<SelectionTools {...propsFor(scene)} />)
      // 321 wide from the bar's edge at 380.
      expect(placedAt().left).toBe('540.5px')
    })

    /* Until it has been measured the popup has no width to keep an edge for, so
       it is centred on the line itself — the stylesheet's translate does the
       centring — even where a measured one would be slid inside the stage. */
    describe('before it has a width', () => {
      beforeEach(() => {
        sizes.bar = { width: 0, height: 40 }
      })

      it('is centred on the line itself', () => {
        render(<SelectionTools {...propsFor(sceneOn(rect(960, 300, 80, 20)))} />)
        expect(placedAt()).toEqual({ top: '252px', left: '1000px' })
      })

      /* A popup with no width over a line with none has no reach across, so a
         line lying wholly beside it is not in its path — which only the block's
         own width can say. Counted in its way, it would put the bar below. */
      it('does not dodge a line lying wholly beside its path', () => {
        render(<SelectionTools {...propsFor(sceneOn([rect(400, 300, 0, 20), rect(200, 50, 200, 20)]))} />)
        expect(placedAt()).toEqual({ top: '252px', left: '400px' })
      })
    })
  })
})
