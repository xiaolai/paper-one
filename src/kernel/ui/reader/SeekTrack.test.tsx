// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SeekTrack, fractionAt, shownFraction } from './SeekTrack'

/**
 * The one seek control, shared by both shells.
 *
 * ⚠️ **THESE CASES MOVED HERE WITH THE COMPONENT.** They were written against
 * `app/shell/ProgressFooter`, which the desktop cannot import; rather than
 * copy the control, the control moved to the kernel and its cases came with
 * it. The footer keeps only what is the FOOTER's — the readouts beside the
 * track, and the row that must not reflow under the thumb.
 */

afterEach(cleanup)

const box = (left: number, width: number) => ({ left, width })

describe('fractionAt', () => {
  it('reads a position along the track', () => {
    expect(fractionAt(150, box(100, 200))).toBeCloseTo(0.25)
    expect(fractionAt(200, box(100, 200))).toBeCloseTo(0.5)
  })

  it('clamps a pointer that left the track, either side', () => {
    /* A drag that leaves the track by a pixel must not ask for -0.01 of a
       book, or for 1.2 of one. */
    expect(fractionAt(0, box(100, 200))).toBe(0)
    expect(fractionAt(9999, box(100, 200))).toBe(1)
  })

  it('answers 0 for a track with no width rather than dividing by zero', () => {
    /* A footer measured before layout. NaN here would reach `goToFraction`. */
    expect(fractionAt(50, box(0, 0))).toBe(0)
  })

  it('takes both ends exactly', () => {
    expect(fractionAt(100, box(100, 200))).toBe(0)
    expect(fractionAt(300, box(100, 200))).toBe(1)
  })
})

describe('shownFraction', () => {
  it('follows the thumb while dragging, and the book otherwise', () => {
    expect(shownFraction(0.3, null)).toBe(0.3)
    expect(shownFraction(0.3, 0.8)).toBe(0.8)
  })

  it('clamps, so a malformed relocation cannot draw past the ends', () => {
    expect(shownFraction(-1, null)).toBe(0)
    expect(shownFraction(2, null)).toBe(1)
  })

  it('reads a non-finite fraction as the start, never as NaN%', () => {
    expect(shownFraction(Number.NaN, null)).toBe(0)
  })
})

describe('SeekTrack, as a readout', () => {
  it('is a progressbar and takes no focus when it cannot seek', () => {
    render(<SeekTrack fraction={0.37} />)
    const track = screen.getByRole('progressbar')
    expect(track.getAttribute('aria-valuenow')).toBe('37')
    expect(track.getAttribute('tabindex')).toBeNull()
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('names itself even as a read-only progressbar', () => {
    /* A value with no name tells assistive technology a number and not what
       it counts. */
    render(<SeekTrack fraction={0.37} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-label')).toBe('How far through the book')
  })
})

describe('SeekTrack, as a seek', () => {
  const withSeek = (onSeek: (f: number) => void, fraction = 0.5) => {
    render(<SeekTrack fraction={fraction} onSeek={onSeek} />)
    const track = screen.getByRole('slider')
    track.setPointerCapture = vi.fn()
    track.releasePointerCapture = vi.fn()
    track.hasPointerCapture = vi.fn(() => true)
    track.getBoundingClientRect = vi.fn(
      () => ({ left: 0, width: 100, top: 0, height: 3, right: 100, bottom: 3, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    )
    return track
  }

  it('announces itself as a slider, with a name and a spoken value', () => {
    const track = withSeek(vi.fn())
    expect(track.getAttribute('aria-label')).toBe('How far through the book')
    expect(track.getAttribute('aria-valuetext')).toBe('50% through the book')
    expect(track.getAttribute('tabindex')).toBe('0')
  })

  it('does NOT seek while the thumb is moving — only on release', () => {
    /* ⚠️ The rule this whole component exists to honour: every relocation
       reaches `book.setPosition`, and a position write is a row in
       `sync/journal.jsonl` that REPLICATES. A per-frame seek would push
       hundreds of positions to another machine for one gesture. */
    const onSeek = vi.fn()
    const track = withSeek(onSeek)
    fireEvent.pointerDown(track, { isPrimary: true, button: 0, clientX: 10, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 40, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 70, pointerId: 1 })
    expect(onSeek).not.toHaveBeenCalled()
    fireEvent.pointerUp(track, { clientX: 70, pointerId: 1 })
    expect(onSeek).toHaveBeenCalledTimes(1)
    expect(onSeek).toHaveBeenCalledWith(0.7)
  })

  it('previews where the thumb is, not where the book is', () => {
    const track = withSeek(vi.fn(), 0.5)
    fireEvent.pointerDown(track, { isPrimary: true, button: 0, clientX: 90, pointerId: 1 })
    /* The TRACK's own value. The words beside it are the caller's, and
       `ProgressFooter.test.tsx` holds that half — see `onPreview`. */
    expect(track.getAttribute('aria-valuenow')).toBe('90')
  })

  it('does NOT seek when the gesture is cancelled, and puts the preview back', () => {
    /* ⚠️ **THIS CASE USED TO ASSERT THE DEFECT.** It required a cancelled drag
       to commit, which is what the code did — `pointercancel` was wired to the
       release handler. A cancel is the SYSTEM taking the gesture away: a
       scroll claiming it, a rejected palm, the window losing the pointer.
       Committing on one relocates the book and REPLICATES a position the
       reader never chose. Found by audit 2026-09-25; the test was wrong
       before the code was. */
    const onSeek = vi.fn()
    const track = withSeek(onSeek, 0.5)
    fireEvent.pointerDown(track, { isPrimary: true, button: 0, clientX: 90, pointerId: 1 })
    expect(track.getAttribute('aria-valuenow')).toBe('90')
    fireEvent.pointerCancel(track, { clientX: 90, pointerId: 1 })
    expect(onSeek).not.toHaveBeenCalled()
    expect(track.getAttribute('aria-valuenow')).toBe('50')
  })

  it('ignores a second finger, and does not let it commit or end the drag', () => {
    const onSeek = vi.fn()
    const track = withSeek(onSeek, 0.5)
    fireEvent.pointerDown(track, { isPrimary: true, button: 0, clientX: 20, pointerId: 1 })
    fireEvent.pointerDown(track, { isPrimary: true, button: 0, clientX: 95, pointerId: 2 })
    fireEvent.pointerMove(track, { clientX: 95, pointerId: 2 })
    expect(track.getAttribute('aria-valuenow')).toBe('20')
    fireEvent.pointerUp(track, { clientX: 95, pointerId: 2 })
    expect(onSeek).not.toHaveBeenCalled()
    fireEvent.pointerUp(track, { clientX: 30, pointerId: 1 })
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(0.3)
  })

  it('commits against the box measured when the gesture STARTED', () => {
    /* ⚠️ The track is `flex: 1` in a row that GAINS the time label the moment
       the preview passes 0 %, so it narrows mid-gesture. Remeasuring on
       release committed a different place than the reader was shown. */
    const onSeek = vi.fn()
    const track = withSeek(onSeek, 0)
    fireEvent.pointerDown(track, { isPrimary: true, button: 0, clientX: 50, pointerId: 1 })
    /* The row reflows: the track is now half as wide. */
    track.getBoundingClientRect = vi.fn(
      () => ({ left: 0, width: 50, top: 0, height: 3, right: 50, bottom: 3, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    )
    fireEvent.pointerUp(track, { clientX: 50, pointerId: 1 })
    expect(onSeek).toHaveBeenCalledWith(0.5)
  })

  it('ignores a secondary button and a non-primary pointer', () => {
    const onSeek = vi.fn()
    const track = withSeek(onSeek)
    fireEvent.pointerDown(track, { isPrimary: true, button: 2, clientX: 90, pointerId: 1 })
    fireEvent.pointerUp(track, { clientX: 90, pointerId: 1 })
    fireEvent.pointerDown(track, { isPrimary: false, button: 0, clientX: 90, pointerId: 2 })
    fireEvent.pointerUp(track, { clientX: 90, pointerId: 2 })
    expect(onSeek).not.toHaveBeenCalled()
  })

  it('moves by one percent on an arrow, and five on a page key', () => {
    const onSeek = vi.fn()
    const track = withSeek(onSeek, 0.5)
    fireEvent.keyDown(track, { key: 'ArrowRight' })
    expect(onSeek).toHaveBeenLastCalledWith(0.51)
    fireEvent.keyDown(track, { key: 'ArrowLeft' })
    expect(onSeek).toHaveBeenLastCalledWith(0.49)
    fireEvent.keyDown(track, { key: 'PageUp' })
    expect(onSeek).toHaveBeenLastCalledWith(0.55)
    fireEvent.keyDown(track, { key: 'PageDown' })
    expect(onSeek).toHaveBeenLastCalledWith(0.45)
  })

  it('goes to the ends on Home and End', () => {
    const onSeek = vi.fn()
    const track = withSeek(onSeek, 0.5)
    fireEvent.keyDown(track, { key: 'Home' })
    expect(onSeek).toHaveBeenLastCalledWith(0)
    fireEvent.keyDown(track, { key: 'End' })
    expect(onSeek).toHaveBeenLastCalledWith(1)
  })

  it('clamps a key press at the ends rather than leaving the book', () => {
    const onSeek = vi.fn()
    const track = withSeek(onSeek, 1)
    fireEvent.keyDown(track, { key: 'ArrowRight' })
    expect(onSeek).toHaveBeenLastCalledWith(1)
  })

  it('passes a key it does not use through to the page', () => {
    const onSeek = vi.fn()
    const track = withSeek(onSeek)
    fireEvent.keyDown(track, { key: 'a' })
    expect(onSeek).not.toHaveBeenCalled()
  })
})

describe('SeekTrack — the preview it publishes', () => {
  it('tells the caller where the thumb is, and that it has let go', () => {
    /* The readouts beside the track follow the THUMB, not the book, or a
       reader dragging to 80 % reads "37 %". */
    const seen: Array<number | null> = []
    render(<SeekTrack fraction={0.5} onSeek={vi.fn()} onPreview={(at) => seen.push(at)} />)
    const track = screen.getByRole('slider')
    track.setPointerCapture = vi.fn()
    track.releasePointerCapture = vi.fn()
    track.hasPointerCapture = vi.fn(() => true)
    track.getBoundingClientRect = vi.fn(
      () => ({ left: 0, width: 100, top: 0, height: 3, right: 100, bottom: 3, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    )
    fireEvent.pointerDown(track, { isPrimary: true, button: 0, clientX: 80, pointerId: 1 })
    fireEvent.pointerUp(track, { clientX: 80, pointerId: 1 })
    expect(seen).toEqual([0.8, null])
  })

  it('publishes nothing when there is no listener', () => {
    render(<SeekTrack fraction={0.5} onSeek={vi.fn()} />)
    const track = screen.getByRole('slider')
    track.setPointerCapture = vi.fn()
    track.getBoundingClientRect = vi.fn(
      () => ({ left: 0, width: 100, top: 0, height: 3, right: 100, bottom: 3, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    )
    expect(() =>
      fireEvent.pointerDown(track, { isPrimary: true, button: 0, clientX: 40, pointerId: 1 }),
    ).not.toThrow()
  })
})

describe('SeekTrack — a gesture that ends without a release', () => {
  /* ⚠️ **THE ONE-GESTURE-AT-A-TIME GUARD IS WHAT MAKES THIS SEVERE.** A
     gesture ref left set is not merely a stuck preview: every later pointer
     is refused, so the track is dead until the book is reopened. */
  const seekable = (onSeek = vi.fn()) => {
    render(<SeekTrack fraction={0.5} onSeek={onSeek} />)
    const track = screen.getByRole('slider')
    track.setPointerCapture = vi.fn()
    track.releasePointerCapture = vi.fn()
    track.hasPointerCapture = vi.fn(() => true)
    track.getBoundingClientRect = vi.fn(
      () => ({ left: 0, width: 100, top: 0, height: 3, right: 100, bottom: 3, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    )
    return { track, onSeek }
  }

  it('clears when capture is lost, without committing', () => {
    /* The browser releases capture when the captured element is removed,
       hidden or disabled, and neither `pointerup` nor `pointercancel`
       arrives. */
    const { track, onSeek } = seekable()
    fireEvent.pointerDown(track, { isPrimary: true, button: 0, clientX: 90, pointerId: 1 })
    expect(track.getAttribute('aria-valuenow')).toBe('90')
    fireEvent.lostPointerCapture(track, { pointerId: 1 })
    expect(onSeek).not.toHaveBeenCalled()
    expect(track.getAttribute('aria-valuenow')).toBe('50')
  })

  it('accepts a new gesture after capture was lost', () => {
    /* The half that makes it severe rather than cosmetic. */
    const { track, onSeek } = seekable()
    fireEvent.pointerDown(track, { isPrimary: true, button: 0, clientX: 90, pointerId: 1 })
    fireEvent.lostPointerCapture(track, { pointerId: 1 })
    fireEvent.pointerDown(track, { isPrimary: true, button: 0, clientX: 20, pointerId: 2 })
    fireEvent.pointerUp(track, { clientX: 20, pointerId: 2 })
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(0.2)
  })

  it('ignores a lost capture belonging to another pointer', () => {
    const { track, onSeek } = seekable()
    fireEvent.pointerDown(track, { isPrimary: true, button: 0, clientX: 90, pointerId: 1 })
    fireEvent.lostPointerCapture(track, { pointerId: 9 })
    expect(track.getAttribute('aria-valuenow')).toBe('90')
    fireEvent.pointerUp(track, { clientX: 90, pointerId: 1 })
    expect(onSeek).toHaveBeenCalledWith(0.9)
  })

  it('drops a gesture when seeking is taken away mid-drag', () => {
    /* With `onSeek` gone the release and cancel handlers are not attached at
       all, so the gesture in flight had nothing left to end it — the same
       stranded state, reached from the other side. */
    const onSeek = vi.fn()
    const { rerender } = render(<SeekTrack fraction={0.5} onSeek={onSeek} />)
    const track = screen.getByRole('slider')
    track.setPointerCapture = vi.fn()
    track.getBoundingClientRect = vi.fn(
      () => ({ left: 0, width: 100, top: 0, height: 3, right: 100, bottom: 3, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    )
    fireEvent.pointerDown(track, { isPrimary: true, button: 0, clientX: 90, pointerId: 1 })
    expect(track.getAttribute('aria-valuenow')).toBe('90')

    rerender(<SeekTrack fraction={0.5} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')
    expect(onSeek).not.toHaveBeenCalled()
  })
})
