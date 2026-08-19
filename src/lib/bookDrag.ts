/**
 * Books dragged WITHIN the app — from the shelf onto a tag row in the Library
 * panel, which tags them.
 *
 * Its own MIME type, so the window's file-drop handler (`useFileDrop`) can tell
 * this drag from a book being dropped in from the Finder: that handler keys its
 * visible response on `Files` and ignores everything else, so a drag carrying
 * only this type crosses the window without lighting the import state up. It
 * still calls `preventDefault` on `dragover`, which is what lets any drop
 * anywhere fire at all — including the one a tag row wants.
 *
 * Ids, not books. The receiver has the shelf and looks them up; carrying
 * records across the drag would be a second copy of the truth in flight.
 */
export const BOOK_DRAG_TYPE = 'application/x-paper-books'

export function writeBookDrag(transfer: DataTransfer, bookIds: readonly string[]): void {
  transfer.setData(BOOK_DRAG_TYPE, JSON.stringify(bookIds))
  transfer.effectAllowed = 'copy'
}

/** True when a drag carries books from the shelf. Cheap; safe on `dragover`. */
export function hasBookDrag(transfer: DataTransfer | null): boolean {
  return Array.from(transfer?.types ?? []).includes(BOOK_DRAG_TYPE)
}

/**
 * The ids a drop carried, or null when it carried none — or carried something
 * that only claims to be a list. A drop is an external input like any other:
 * whatever is in it is checked before it is believed.
 */
export function readBookDrag(transfer: DataTransfer | null): string[] | null {
  const raw = transfer?.getData(BOOK_DRAG_TYPE)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every((one) => typeof one === 'string')) return null
    // No drag carries zero books — `[]` is malformed, and the contract above
    // says "carried none → null" so every caller has ONE emptiness to check.
    if (parsed.length === 0) return null
    return parsed
  } catch {
    return null
  }
}
