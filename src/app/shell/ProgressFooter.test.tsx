// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProgressFooter, minutesLeft } from './ProgressFooter'

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

describe('minutesLeft', () => {
  it('counts down as the reader advances', () => {
    expect(minutesLeft(0)).toBe(360)
    expect(minutesLeft(1)).toBe(0)
  })

  it('clamps a fraction outside the book', () => {
    expect(minutesLeft(-1)).toBe(360)
    expect(minutesLeft(2)).toBe(0)
  })
})

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
