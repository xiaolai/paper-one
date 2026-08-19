import { describe, expect, it } from 'vitest'
import { PREMEASURE, gridWindow } from './virtualGrid'

/**
 * Virtualisation is where off-by-one errors live, and in a browser they are
 * invisible: a row short at the bottom looks like the end of the library, and a
 * row short at the top looks like a scroll glitch. As arithmetic they are just
 * numbers, which is why none of this touches the DOM.
 */

const base = { total: 100, columns: 4, rowHeight: 200, scrollTop: 0, viewportHeight: 800 }

describe('gridWindow', () => {
  it('renders the visible rows plus the overscan', () => {
    const win = gridWindow(base)
    // 800 / 200 = 4 visible rows, plus 2 below. Nothing above at the top.
    expect(win.firstRow).toBe(0)
    expect(win.lastRow).toBe(6)
    expect(win.firstIndex).toBe(0)
    expect(win.endIndex).toBe(28)
  })

  it('moves the window as the shelf scrolls', () => {
    const win = gridWindow({ ...base, scrollTop: 2000 })
    expect(win.firstRow).toBe(8)
    expect(win.padTop).toBe(1600)
  })

  /**
   * macOS rubber-banding produces a negative `scrollTop` on every overscroll.
   *
   * Unclamped, the first row goes negative — which slices from the END of the
   * array and shows the last books in the library at the top of the shelf.
   */
  it('clamps a negative scroll position', () => {
    const win = gridWindow({ ...base, scrollTop: -400 })
    expect(win.firstRow).toBe(0)
    expect(win.firstIndex).toBe(0)
    expect(win.padTop).toBe(0)
  })

  it('clamps past the end rather than slicing beyond it', () => {
    const win = gridWindow({ ...base, scrollTop: 100_000 })
    expect(win.lastRow).toBe(24)
    expect(win.endIndex).toBe(100)
    expect(win.padBottom).toBe(0)
  })

  /* The last row is usually part-full; slicing by the row would pad the grid
   * with undefined cells. */
  it('bounds the end by the book count, not by the row', () => {
    const win = gridWindow({ ...base, total: 98, scrollTop: 100_000 })
    expect(win.endIndex).toBe(98)
  })

  it('leaves the right space above and below', () => {
    const win = gridWindow({ ...base, scrollTop: 2000 })
    const rows = Math.ceil(100 / 4)
    expect(win.padTop).toBe(win.firstRow * 200)
    expect(win.padBottom).toBe((rows - 1 - win.lastRow) * 200)
  })

  it('renders nothing for an empty shelf', () => {
    const win = gridWindow({ ...base, total: 0 })
    expect(win.endIndex).toBe(0)
    expect(win.firstIndex).toBe(0)
  })

  /**
   * Before the grid has been measured — the first render, before a ref attaches
   * — every metric is zero. Rendering NOTHING then makes the shelf flash empty
   * on every mount; rendering EVERYTHING mounted two thousand cells and
   * started their cover loads for one frame, and the image requests did not
   * un-send when the measured render unmounted them. A bounded screenful is
   * the middle path: never blank, never the whole shelf.
   */
  it('renders a bounded screenful when the grid has not been measured yet', () => {
    expect(gridWindow({ ...base, rowHeight: 0 }).endIndex).toBe(PREMEASURE)
    expect(gridWindow({ ...base, viewportHeight: 0 }).endIndex).toBe(PREMEASURE)
    expect(gridWindow({ ...base, columns: 0 }).endIndex).toBe(PREMEASURE)
    // Starting at the top, so the measurer has a first cell to measure.
    expect(gridWindow({ ...base, rowHeight: 0 }).firstIndex).toBe(0)
    // A small shelf is unaffected — the bound only bites past a screenful.
    expect(gridWindow({ ...base, total: 10, rowHeight: 0 }).endIndex).toBe(10)
  })

  /**
   * The shelf shrank under a scrolled viewport.
   *
   * Remove a book, or type into the search box, while scrolled halfway down two
   * thousand books: `scrollTop` still describes the shelf that was there. Before
   * the clamp, `firstRow` landed past the end, `firstIndex` came out ABOVE
   * `endIndex`, and the slice between them was empty — the shelf rendered
   * nothing, which reads as the library having been wiped.
   */
  it('still renders the last rows when the shelf shrinks under the scroll', () => {
    const win = gridWindow({ ...base, total: 12, scrollTop: 50_000 })
    expect(win.firstIndex).toBeLessThan(win.endIndex)
    expect(win.endIndex).toBe(12)
  })

  it('never returns a window outside the shelf', () => {
    for (const scrollTop of [-1000, 0, 137, 4000, 50_000]) {
      const win = gridWindow({ ...base, scrollTop })
      expect(win.firstIndex).toBeGreaterThanOrEqual(0)
      expect(win.endIndex).toBeLessThanOrEqual(base.total)
      expect(win.firstIndex).toBeLessThanOrEqual(win.endIndex)
    }
  })
})
