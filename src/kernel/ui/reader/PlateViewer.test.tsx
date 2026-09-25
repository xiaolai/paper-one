// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PlateViewer, clampPan } from './PlateViewer'
import type { PlateDetail } from './plate'

/**
 * The plate viewer.
 *
 * WHAT THESE CASES DELIBERATELY DO NOT TEST: the focus trap, `aria-modal`, Esc
 * and the inertness of the page behind. Those belong to `OverlaySheet` and are
 * covered there — asserting them again here would pin one component's
 * behaviour in another's file, and the point of reusing the sheet is that this
 * file has no opinion about any of it.
 */

const plate = (over: Partial<PlateDetail> = {}): PlateDetail => ({
  src: 'blob:a',
  alt: 'Figure 1-1. The traditional approach',
  width: 1560,
  height: 329,
  ...over,
})

const image = () => screen.getByRole('img') as HTMLImageElement

/**
 * jsdom has NO LAYOUT, so `clientWidth` is 0 on every element and the pan
 * clamp — which is a function of how far the scaled plate overhangs the stage
 * — pins every offset to 0. Three cases failed on exactly that and not on the
 * component. Give the stage and the plate a size, the way a browser would.
 */
const laidOut = (img: HTMLImageElement, plate = 400, stage = 200) => {
  Object.defineProperty(img, 'clientWidth', { value: plate, configurable: true })
  Object.defineProperty(img, 'clientHeight', { value: plate, configurable: true })
  const host = img.parentElement!
  Object.defineProperty(host, 'clientWidth', { value: stage, configurable: true })
  Object.defineProperty(host, 'clientHeight', { value: stage, configurable: true })
}

/* This project wires no global cleanup, so every render here would otherwise
   stack in one document and `getByRole` would find several. */
afterEach(cleanup)

describe('PlateViewer', () => {
  it('draws nothing at all when there is no plate', () => {
    const { container } = render(<PlateViewer plate={null} onClose={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })

  it('shows the image, and names the dialog with the book’s own words', () => {
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    expect(image().src).toContain('blob:a')
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe(
      'Figure 1-1. The traditional approach',
    )
  })

  it('falls back to a generic name rather than announcing an unnamed dialog', () => {
    /* `aria-label=""` tells a screen reader there is a dialog and not what is
       in it, which is worse than a generic word. */
    render(<PlateViewer plate={plate({ alt: '' })} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Figure')
  })

  it('shows the caption only when the book wrote one', () => {
    const { rerender } = render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    expect(screen.getByText('Figure 1-1. The traditional approach')).toBeTruthy()
    rerender(<PlateViewer plate={plate({ alt: '' })} onClose={vi.fn()} />)
    expect(screen.queryByText('Figure 1-1. The traditional approach')).toBeNull()
  })

  it('closes from its own control', () => {
    const onClose = vi.fn()
    render(<PlateViewer plate={plate()} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close this figure' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('opens fitted, so the reader sees the whole plate first', () => {
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    expect(image().style.transform).toBe('translate(0px, 0px) scale(1)')
    expect(image().getAttribute('data-zoomed')).toBe('false')
  })

  it('zooms on a double-click and returns to fitted on the next one', () => {
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    fireEvent.doubleClick(image())
    expect(image().style.transform).toBe('translate(0px, 0px) scale(2)')
    expect(image().getAttribute('data-zoomed')).toBe('true')
    fireEvent.doubleClick(image())
    expect(image().style.transform).toBe('translate(0px, 0px) scale(1)')
  })

  it('will not zoom out past fitted, however far the wheel is turned', () => {
    /* Below 1 the plate is smaller than the window, which is the state the
       reader opened the viewer to escape. */
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    for (let turn = 0; turn < 20; turn++) fireEvent.wheel(image(), { deltaY: 120 })
    expect(image().style.transform).toContain('scale(1)')
  })

  it('will not zoom in past its ceiling, however far the wheel is turned', () => {
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    for (let turn = 0; turn < 200; turn++) fireEvent.wheel(image(), { deltaY: -120 })
    expect(image().style.transform).toContain('scale(6)')
  })

  it('pans only once there is something off-screen to pan to', () => {
    /* A fitted plate that slides under the pointer reads as a broken drag. */
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    const img = image()
    laidOut(img)
    img.setPointerCapture = vi.fn()
    img.releasePointerCapture = vi.fn()
    img.hasPointerCapture = vi.fn(() => true)

    fireEvent.pointerDown(img, { isPrimary: true, button: 0, clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(img, { clientX: 60, clientY: 40, pointerId: 1 })
    expect(img.style.transform).toBe('translate(0px, 0px) scale(1)')

    fireEvent.doubleClick(img)
    fireEvent.pointerDown(img, { isPrimary: true, button: 0, clientX: 10, clientY: 10, pointerId: 1 })
    expect(img.getAttribute('data-dragging')).toBe('true')
    fireEvent.pointerMove(img, { clientX: 60, clientY: 40, pointerId: 1 })
    expect(img.style.transform).toBe('translate(50px, 30px) scale(2)')
    fireEvent.pointerUp(img, { pointerId: 1 })
    expect(img.getAttribute('data-dragging')).toBe('false')
  })

  it('ignores a secondary button and a non-primary pointer', () => {
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    const img = image()
    img.setPointerCapture = vi.fn()
    fireEvent.doubleClick(img)
    fireEvent.pointerDown(img, { isPrimary: true, button: 2, clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(img, { clientX: 99, clientY: 99, pointerId: 1 })
    expect(img.style.transform).toBe('translate(0px, 0px) scale(2)')
    fireEvent.pointerDown(img, { isPrimary: false, button: 0, clientX: 10, clientY: 10, pointerId: 2 })
    fireEvent.pointerMove(img, { clientX: 99, clientY: 99, pointerId: 2 })
    expect(img.style.transform).toBe('translate(0px, 0px) scale(2)')
  })

  it('does not keep panning after the pointer is released', () => {
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    const img = image()
    laidOut(img)
    img.setPointerCapture = vi.fn()
    img.releasePointerCapture = vi.fn()
    img.hasPointerCapture = vi.fn(() => true)
    fireEvent.doubleClick(img)
    fireEvent.pointerDown(img, { isPrimary: true, button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(img, { clientX: 20, clientY: 0, pointerId: 1 })
    fireEvent.pointerUp(img, { pointerId: 1 })
    fireEvent.pointerMove(img, { clientX: 500, clientY: 500, pointerId: 1 })
    expect(img.style.transform).toBe('translate(20px, 0px) scale(2)')
  })

  it('releases the pointer on a cancel, so a dragged-away gesture does not stick', () => {
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    const img = image()
    img.setPointerCapture = vi.fn()
    const release = vi.fn()
    img.releasePointerCapture = release
    img.hasPointerCapture = vi.fn(() => true)
    fireEvent.doubleClick(img)
    fireEvent.pointerDown(img, { isPrimary: true, button: 0, clientX: 0, clientY: 0, pointerId: 7 })
    fireEvent.pointerCancel(img, { pointerId: 7 })
    expect(release).toHaveBeenCalledWith(7)
    expect(img.getAttribute('data-dragging')).toBe('false')
  })

  it('does not release a pointer it never captured', () => {
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    const img = image()
    const release = vi.fn()
    img.releasePointerCapture = release
    img.hasPointerCapture = vi.fn(() => false)
    img.setPointerCapture = vi.fn()
    fireEvent.doubleClick(img)
    fireEvent.pointerDown(img, { isPrimary: true, button: 0, clientX: 0, clientY: 0, pointerId: 3 })
    fireEvent.pointerUp(img, { pointerId: 3 })
    expect(release).not.toHaveBeenCalled()
  })

  it('opens a SECOND plate fitted, not at the first one’s zoom and offset', () => {
    /* Without the reset, opening a second figure shows it scrolled to a corner
       of an image the reader has not seen yet. */
    const { rerender } = render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    const img = image()
    laidOut(img)
    img.setPointerCapture = vi.fn()
    fireEvent.doubleClick(img)
    fireEvent.pointerDown(img, { isPrimary: true, button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(img, { clientX: 40, clientY: 40, pointerId: 1 })
    expect(image().style.transform).toBe('translate(40px, 40px) scale(2)')

    rerender(<PlateViewer plate={plate({ src: 'blob:b' })} onClose={vi.fn()} />)
    expect(image().style.transform).toBe('translate(0px, 0px) scale(1)')
  })

  it('stops the wheel reaching the page behind it', () => {
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    const event = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })
    image().dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('clampPan — the plate stays reachable', () => {
  /* ⚠️ **AN UNBOUNDED PAN LOSES THE PLATE AND THE CONTROLS WITH IT.** The
     drag and zoom handlers are on the image, so a plate dragged off the stage
     cannot be dragged back — the reader must close and reopen the viewer.
     Found by audit, 2026-09-25. */
  const stage = { width: 200, height: 200 }

  it('allows no movement at all while the plate fits', () => {
    /* At scale 1 a 400px plate is LAID OUT to fit, so `clientWidth` is already
       the fitted size; the overhang is zero and so is the freedom. */
    expect(clampPan({ x: 90, y: -90 }, 1, stage, { width: 200, height: 200 })).toEqual({ x: 0, y: 0 })
  })

  it('allows exactly the overhang, and not a pixel more', () => {
    /* 200px plate at 2x inside a 200px stage overhangs 100px each way. */
    const small = { width: 200, height: 200 }
    expect(clampPan({ x: 9999, y: -9999 }, 2, stage, small)).toEqual({ x: 100, y: -100 })
    expect(clampPan({ x: 40, y: -40 }, 2, stage, small)).toEqual({ x: 40, y: -40 })
  })

  it('clamps each axis on its own', () => {
    const wide = { width: 400, height: 100 }
    expect(clampPan({ x: 9999, y: 9999 }, 1, stage, wide)).toEqual({ x: 100, y: 0 })
  })

  it('never returns a negative bound for a plate smaller than the stage', () => {
    expect(clampPan({ x: 5, y: 5 }, 1, stage, { width: 50, height: 50 })).toEqual({ x: 0, y: 0 })
  })

  it('grows the freedom with the zoom', () => {
    expect(clampPan({ x: 9999, y: 0 }, 3, stage, { width: 200, height: 200 }).x).toBe(200)
  })
})

describe('PlateViewer — what the audit found', () => {
  const laid = () => {
    const img = image()
    Object.defineProperty(img, 'clientWidth', { value: 400, configurable: true })
    Object.defineProperty(img, 'clientHeight', { value: 400, configurable: true })
    const host = img.parentElement!
    Object.defineProperty(host, 'clientWidth', { value: 200, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 200, configurable: true })
    img.setPointerCapture = vi.fn()
    img.releasePointerCapture = vi.fn()
    img.hasPointerCapture = vi.fn(() => true)
    return img
  }

  it('recentres when the wheel brings it back to fitted', () => {
    /* Zoom in, drag away, wheel back out: the plate used to stay displaced and
       clipped at a size where it fits the window entirely. */
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    const img = laid()
    fireEvent.doubleClick(img)
    fireEvent.pointerDown(img, { isPrimary: true, button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(img, { clientX: 60, clientY: 60, pointerId: 1 })
    fireEvent.pointerUp(img, { pointerId: 1 })
    expect(img.style.transform).not.toContain('translate(0px, 0px)')
    for (let turn = 0; turn < 30; turn++) fireEvent.wheel(img, { deltaY: 120 })
    expect(img.style.transform).toBe('translate(0px, 0px) scale(1)')
  })

  it('ignores a horizontal trackpad swipe instead of shrinking the plate', () => {
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    const img = laid()
    fireEvent.doubleClick(img)
    const before = img.style.transform
    const event = new WheelEvent('wheel', { deltaY: 0, deltaX: -120, bubbles: true, cancelable: true })
    img.dispatchEvent(event)
    expect(img.style.transform).toBe(before)
    expect(event.defaultPrevented).toBe(false)
  })

  it('ignores a second finger during a drag, and does not let it end one', () => {
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    const img = laid()
    fireEvent.doubleClick(img)
    fireEvent.pointerDown(img, { isPrimary: true, button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(img, { clientX: 20, clientY: 0, pointerId: 1 })
    const afterFirst = img.style.transform

    fireEvent.pointerDown(img, { isPrimary: true, button: 0, clientX: 500, clientY: 500, pointerId: 2 })
    fireEvent.pointerMove(img, { clientX: 900, clientY: 900, pointerId: 2 })
    expect(img.style.transform).toBe(afterFirst)

    fireEvent.pointerUp(img, { pointerId: 2 })
    expect(img.getAttribute('data-dragging')).toBe('true')
    fireEvent.pointerMove(img, { clientX: 40, clientY: 0, pointerId: 1 })
    expect(img.style.transform).not.toBe(afterFirst)
  })

  it('cannot be dragged off the stage and stranded', () => {
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    const img = laid()
    fireEvent.doubleClick(img)
    fireEvent.pointerDown(img, { isPrimary: true, button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(img, { clientX: 99999, clientY: 99999, pointerId: 1 })
    /* 400px plate at 2x in a 200px stage: 300px of overhang each way. */
    expect(img.style.transform).toBe('translate(300px, 300px) scale(2)')
  })

  it('can be zoomed and panned from the keyboard alone', () => {
    /* ⚠️ Every other route in is a pointer gesture, so without this the whole
       feature was unreachable without a trackpad. */
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    const img = laid()
    expect(img.getAttribute('tabindex')).toBe('0')
    fireEvent.keyDown(img, { key: '+' })
    expect(img.style.transform).toContain('scale(1.25)')
    fireEvent.keyDown(img, { key: 'ArrowRight' })
    expect(img.style.transform).not.toContain('translate(0px, 0px)')
    fireEvent.keyDown(img, { key: '0' })
    expect(img.style.transform).toBe('translate(0px, 0px) scale(1)')
  })

  it('leaves a key it does not use to the page', () => {
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    const img = laid()
    const event = new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true })
    img.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('PlateViewer — what the SECOND audit round found', () => {
  const laid = (plateSize = 400, stageSize = 200) => {
    const img = image()
    Object.defineProperty(img, 'clientWidth', { value: plateSize, configurable: true })
    Object.defineProperty(img, 'clientHeight', { value: plateSize, configurable: true })
    const host = img.parentElement!
    Object.defineProperty(host, 'clientWidth', { value: stageSize, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: stageSize, configurable: true })
    img.setPointerCapture = vi.fn()
    img.releasePointerCapture = vi.fn()
    img.hasPointerCapture = vi.fn(() => true)
    return img
  }

  it('ends a drag when the zoom changes under it, instead of going stale', () => {
    /* ⚠️ A drag in flight holds a pan snapshot taken at the OLD zoom. Wheeling
       mid-drag re-clamps the pan underneath it, so every later move was
       computed from an offset that no longer existed — the plate stuck, then
       jumped once the pointer crossed the stale origin. */
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    const img = laid()
    fireEvent.doubleClick(img)
    fireEvent.pointerDown(img, { isPrimary: true, button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(img, { clientX: 30, clientY: 0, pointerId: 1 })
    expect(img.getAttribute('data-dragging')).toBe('true')

    fireEvent.wheel(img, { deltaY: -120 })
    expect(img.getAttribute('data-dragging')).toBe('false')

    const afterZoom = img.style.transform
    fireEvent.pointerMove(img, { clientX: 900, clientY: 900, pointerId: 1 })
    expect(img.style.transform).toBe(afterZoom)
  })

  it('keyboard zoom also ends a drag in flight', () => {
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    const img = laid()
    fireEvent.doubleClick(img)
    fireEvent.pointerDown(img, { isPrimary: true, button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.keyDown(img, { key: '+' })
    expect(img.getAttribute('data-dragging')).toBe('false')
  })

  it('re-clamps the pan when the stage shrinks under it', async () => {
    /* ⚠️ The clamp only ever ran during a gesture. Pan to the edge, then make
       the window smaller: the overhang shrinks, the stored offset does not,
       and the plate ends up entirely off the stage — taking its own drag and
       zoom handlers with it. */
    const observers: Array<() => void> = []
    const real = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        observers.push(cb)
      }
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver

    try {
      render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
      const img = laid()
      fireEvent.doubleClick(img)
      fireEvent.pointerDown(img, { isPrimary: true, button: 0, clientX: 0, clientY: 0, pointerId: 1 })
      fireEvent.pointerMove(img, { clientX: 9999, clientY: 0, pointerId: 1 })
      fireEvent.pointerUp(img, { pointerId: 1 })
      expect(img.style.transform).toBe('translate(300px, 0px) scale(2)')

      /* The window shrinks: the plate now fits, so nothing may be offset. */
      Object.defineProperty(img, 'clientWidth', { value: 100, configurable: true })
      Object.defineProperty(img, 'clientHeight', { value: 100, configurable: true })
      act(() => {
        for (const fire of observers) fire()
      })
      expect(img.style.transform).toBe('translate(0px, 0px) scale(2)')
    } finally {
      globalThis.ResizeObserver = real
    }
  })
})

describe('PlateViewer — the drag snapshot, and the three writers that invalidate it', () => {
  /* ⚠️ **ONE RULE, NOT THREE FIXES.** A drag holds the pointer's origin and
     the pan as it was when the finger went down; every later move is computed
     from that. Any OTHER writer of `pan` leaves the snapshot describing a
     position the plate is no longer in — the next move jumps, or an interval
     of the drag does nothing. Zoom turned up in round 2; keyboard panning and
     the resize reclamp turned up in round 3. A fourth writer must call
     `stopDrag` too. */
  const laid = () => {
    const img = image()
    Object.defineProperty(img, 'clientWidth', { value: 400, configurable: true })
    Object.defineProperty(img, 'clientHeight', { value: 400, configurable: true })
    const host = img.parentElement!
    Object.defineProperty(host, 'clientWidth', { value: 200, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 200, configurable: true })
    img.setPointerCapture = vi.fn()
    img.releasePointerCapture = vi.fn()
    img.hasPointerCapture = vi.fn(() => true)
    return img
  }

  const dragging = (img: HTMLImageElement) => {
    fireEvent.doubleClick(img)
    fireEvent.pointerDown(img, { isPrimary: true, button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(img, { clientX: 30, clientY: 0, pointerId: 1 })
  }

  it('keyboard panning ends the drag rather than stranding its origin', () => {
    render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
    const img = laid()
    dragging(img)
    fireEvent.keyDown(img, { key: 'ArrowRight' })
    expect(img.getAttribute('data-dragging')).toBe('false')
    const after = img.style.transform
    fireEvent.pointerMove(img, { clientX: 31, clientY: 0, pointerId: 1 })
    expect(img.style.transform).toBe(after)
  })

  it('a resize ends the drag rather than stranding its snapshot', () => {
    const observers: Array<() => void> = []
    const real = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) { observers.push(cb) }
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    try {
      render(<PlateViewer plate={plate()} onClose={vi.fn()} />)
      const img = laid()
      dragging(img)
      act(() => { for (const fire of observers) fire() })
      expect(img.getAttribute('data-dragging')).toBe('false')
      const after = img.style.transform
      fireEvent.pointerMove(img, { clientX: 70, clientY: 0, pointerId: 1 })
      expect(img.style.transform).toBe(after)
    } finally {
      globalThis.ResizeObserver = real
    }
  })
})
