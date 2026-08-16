/**
 * Which rows of a grid are worth rendering.
 *
 * A shelf renders every cell, which is right at twenty books and a wall at two
 * thousand: each cell carries a cover that has to be read off disk, decoded, and
 * held as a blob URL, so the cost is not the DOM node but everything hanging off
 * it. Rendering only what is near the viewport turns a library-sized shelf back
 * into a screen-sized one.
 *
 * PURE ARITHMETIC, deliberately. Nothing here touches the DOM, measures an
 * element, or knows what React is — it takes four numbers and returns a range.
 * Virtualisation is where off-by-one errors live and they are invisible in a
 * browser: a row short at the bottom looks like the end of the library, and a
 * row short at the top looks like a scroll glitch. As arithmetic it can simply
 * be asserted.
 */

export interface GridWindow {
  /** First row to render, inclusive. */
  readonly firstRow: number
  /** Last row to render, inclusive. */
  readonly lastRow: number
  readonly firstIndex: number
  /** Exclusive, so it slices directly. */
  readonly endIndex: number
  /** Space to leave above and below, in pixels. */
  readonly padTop: number
  readonly padBottom: number
}

export interface GridMetrics {
  readonly total: number
  readonly columns: number
  readonly rowHeight: number
  readonly scrollTop: number
  readonly viewportHeight: number
  /**
   * Rows to render beyond the viewport, above and below.
   *
   * Not zero, and not tuned to the pixel. A cover is read from disk and decoded,
   * so a cell that first exists when it is already on screen arrives blank and
   * fills in a moment later — visibly. Two rows of warning is enough time at any
   * plausible scroll speed, and costs a handful of cells.
   */
  readonly overscanRows?: number
}

export function gridWindow({
  total,
  columns,
  rowHeight,
  scrollTop,
  viewportHeight,
  overscanRows = 2,
}: GridMetrics): GridWindow {
  /* Degenerate inputs resolve to "render everything" rather than to nothing.
   * A zero row height or column count means the grid has not been measured yet
   * — the first render, before a ref attaches — and a shelf that renders
   * NOTHING in that frame flashes empty on every mount. Rendering everything is
   * wrong only in cost, and only for one frame. */
  if (total <= 0) return { firstRow: 0, lastRow: -1, firstIndex: 0, endIndex: 0, padTop: 0, padBottom: 0 }
  if (columns <= 0 || rowHeight <= 0 || viewportHeight <= 0) {
    const rows = Math.ceil(total / Math.max(1, columns))
    return {
      firstRow: 0,
      lastRow: rows - 1,
      firstIndex: 0,
      endIndex: total,
      padTop: 0,
      padBottom: 0,
    }
  }

  const rows = Math.ceil(total / columns)
  const firstVisible = Math.floor(scrollTop / rowHeight)
  const lastVisible = Math.floor((scrollTop + viewportHeight) / rowHeight)

  /* Clamped to the grid at BOTH ends. A negative scrollTop is not hypothetical —
   * macOS rubber-banding produces one on every overscroll — and an unclamped
   * first row goes negative, which slices from the end of the array and shows
   * the last books in the library at the top of the shelf. */
  const lastRow = Math.min(rows - 1, lastVisible + overscanRows)
  /* Clamped to `lastRow` as well as to zero, and that second clamp is not
   * belt-and-braces — it is the case where the shelf SHRINKS under a scrolled
   * viewport. Remove a book, or type into the search box, while scrolled
   * halfway down two thousand books and `scrollTop` still describes the old
   * shelf: `firstRow` lands past the end, `firstIndex` comes out above
   * `endIndex`, and the slice between them is empty. The shelf renders nothing
   * at all, which reads as the library having been wiped rather than as a
   * scroll position that needs a moment to catch up. */
  const firstRow = Math.min(Math.max(0, firstVisible - overscanRows), lastRow)

  return {
    firstRow,
    lastRow,
    firstIndex: firstRow * columns,
    // Bounded by `total`, not by the row: the last row is usually part-full, and
    // slicing past the end would pad the grid with undefined cells.
    endIndex: Math.min(total, (lastRow + 1) * columns),
    padTop: firstRow * rowHeight,
    padBottom: Math.max(0, (rows - 1 - lastRow) * rowHeight),
  }
}

/**
 * Whether virtualising is worth it at all.
 *
 * Below this, the window arithmetic, the spacer elements and the scroll listener
 * cost more than they save, and they add a class of bug — a shelf that renders
 * the wrong slice — to a screen that had none. Most readers never cross it.
 */
export const VIRTUALISE_ABOVE = 60
