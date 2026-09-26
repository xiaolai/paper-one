// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProgressFooter } from './ProgressFooter'

/**
 * The footer's own concerns: the readouts beside the track, and the row that
 * must not reflow under the reader's thumb.
 *
 * ⚠️ **THE SLIDER'S BEHAVIOUR IS NOT TESTED HERE AND MUST NOT BE.** It belongs
 * to `kernel/ui/reader/SeekTrack`, which both shells share; asserting it again
 * here would pin one component's behaviour in another's file and make the two
 * able to disagree — which is the whole reason the control was moved.
 */

afterEach(cleanup)


describe('ProgressFooter, as a readout', () => {

  it('is inert while hidden, so an invisible slider cannot be reached', () => {
    /* ⚠️ `aria-hidden` and `opacity: 0` disable nothing: the hidden footer kept
       a focusable slider with live pointer handlers, and the chrome hides
       exactly when the reader is selecting text. */
    const { container } = render(<ProgressFooter fraction={0.37} visible={false} onSeek={vi.fn()} />)
    const foot = container.querySelector('[data-visible]')
    expect(foot?.hasAttribute('inert')).toBe(true)
  })


  it('shows the percentage', () => {
    render(<ProgressFooter fraction={0.37} visible />)
    expect(screen.getByText('37%')).toBeTruthy()
  })

  it('gives no time estimate before the reader has moved', () => {
    /* "0% · ~6 h left" is a real-sounding figure from an assumed word count,
       about a book nobody has opened. */
    render(<ProgressFooter fraction={0} visible />)
    expect(screen.queryByText(/left/u)).toBeNull()
  })
})

describe('ProgressFooter, and the print edition’s page', () => {
  it('shows it beside the percentage when the book carries one', () => {
    render(<ProgressFooter fraction={0.37} visible printPage="213" />)
    expect(screen.getByText('p. 213')).toBeTruthy()
  })

  it('shows nothing at all when the book carries none', () => {
    /* ⚠️ NEVER A SYNTHESISED NUMBER. A page counted from this window is a fact
       about this window, and putting one in the slot a real page uses makes
       the real one untrustworthy. 93 % of books take this branch. */
    render(<ProgressFooter fraction={0.37} visible />)
    expect(screen.queryByText(/^p\./u)).toBeNull()
  })

  it('treats a whitespace-only page as none', () => {
    render(<ProgressFooter fraction={0.37} visible printPage="   " />)
    expect(screen.queryByText(/^p\./u)).toBeNull()
  })

  it('keeps a page the publisher did not spell as a number', () => {
    render(<ProgressFooter fraction={0.04} visible printPage="xiv" />)
    expect(screen.getByText('p. xiv')).toBeTruthy()
  })
})

describe('ProgressFooter — the layout must not move under the thumb', () => {
  it('keeps the time-label slot present at 0 %, so the track cannot narrow mid-drag', () => {
    /* ⚠️ The label used to be ABSENT below 1 %, so the row reflowed the instant
       a drag preview passed 0 — and the track is `flex: 1`, so it narrowed
       under the reader's thumb and its visible endpoints stopped matching its
       seek targets. Capturing the box at pointer-down fixed what was
       COMMITTED; this fixes what is SHOWN. Second audit round, 2026-09-25. */
    const { container } = render(<ProgressFooter fraction={0} visible />)
    const slots = container.querySelectorAll('[data-visible] > span')
    cleanup()
    const { container: moved } = render(<ProgressFooter fraction={0.4} visible />)
    expect(moved.querySelectorAll('[data-visible] > span')).toHaveLength(slots.length)
  })

  it('still says nothing about time before the reader has moved', () => {
    /* The rule the slot must not break: "~6 h left" for a book nobody has
       opened is a real-sounding figure from an assumed word count. */
    render(<ProgressFooter fraction={0} visible />)
    expect(screen.queryByText(/left|Nearly done/u)).toBeNull()
  })
})

describe('ProgressFooter — the readouts follow the THUMB, not the book', () => {
  it('shows the place being dragged to, not the place the book is at', () => {
    /* ⚠️ Without this a reader drags to 80 % and reads "37 %" — the number
       beside the control contradicting the control. `SeekTrack` publishes the
       preview and both sides derive it with `shownFraction`, so they cannot
       disagree about what is being previewed. */
    render(<ProgressFooter fraction={0.37} visible onSeek={vi.fn()} />)
    const track = screen.getByRole('slider')
    track.setPointerCapture = vi.fn()
    track.getBoundingClientRect = vi.fn(
      () => ({ left: 0, width: 100, top: 0, height: 3, right: 100, bottom: 3, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    )
    expect(screen.getByText('37%')).toBeTruthy()
    fireEvent.pointerDown(track, { isPrimary: true, button: 0, clientX: 80, pointerId: 1 })
    expect(screen.getByText('80%')).toBeTruthy()
  })
})

describe('ProgressFooter — the estimate is the book\'s own length now', () => {
  /* ⚠️ **IT WAS AN ASSUMED 90,000 WORDS FOR EVERY BOOK.** Measured over 400
     books of the real library that is an excellent MEDIAN — 95,715 — and wrong
     by more than 2x for a third of the shelf, more than 3x for 17 %. The
     longest book measured, 988,448 words, was told "about 6 hours" for eleven
     hours of reading. `readingTime.ts` holds the arithmetic and the corpus. */

  it('says nothing about time when the book\'s length is unknown', () => {
    /* Every PDF takes this path: a fixed-layout book reports section sizes that
       are progress weights, not file sizes. Silence beats a confident number
       about nothing. */
    render(<ProgressFooter fraction={0.5} visible />)
    expect(screen.queryByText(/left|Nearly done/u)).toBeNull()
  })

  it('reads a short book as short, which the old constant could not', () => {
    /* 1,207 words is the shortest on the shelf. The assumption said six hours. */
    render(<ProgressFooter fraction={0.5} visible words={1_207} />)
    expect(screen.getByText(/min left|Nearly done/u)).toBeTruthy()
    expect(screen.queryByText(/h left/u)).toBeNull()
  })

  it('reads a long book as long, which is the case it was most wrong about', () => {
    render(<ProgressFooter fraction={0.5} visible words={988_448} />)
    expect(screen.getByText(/~33 h left/u)).toBeTruthy()
  })

  it('still says nothing before the reader has moved', () => {
    render(<ProgressFooter fraction={0} visible words={95_715} />)
    expect(screen.queryByText(/left|Nearly done/u)).toBeNull()
  })

  it('follows the THUMB while dragging, not the book', () => {
    /* Dragging to 90 % should say how long is left from there. */
    /* 25,000 words: half of it is 50 minutes, which stays in the minutes
       branch. At 90 min the reading crosses to hours and the case would be
       asserting the rounding rather than the preview. */
    render(<ProgressFooter fraction={0.5} visible words={250 * 100} onSeek={vi.fn()} />)
    const track = screen.getByRole('slider')
    track.setPointerCapture = vi.fn()
    track.getBoundingClientRect = vi.fn(
      () => ({ left: 0, width: 100, top: 0, height: 3, right: 100, bottom: 3, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    )
    expect(screen.getByText('~50 min left')).toBeTruthy()
    fireEvent.pointerDown(track, { isPrimary: true, button: 0, clientX: 90, pointerId: 1 })
    expect(screen.getByText('~10 min left')).toBeTruthy()
  })
})
