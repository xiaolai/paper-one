/**
 * How small each piece of small text is, as a share of the reader's base.
 *
 * WHY THIS EXISTS AT ALL — F5. The median book's smallest relative size is 0.70
 * of the base and the 5th percentile is 0.50, so at the smallest reading step
 * (17px) that is 11.9px in a typical book and **8.5px in one book in twenty**.
 * The reader chose the step; the book chose the 0.50, against a base that has
 * since moved out from under it. A floor under the smallest text is the
 * Accessibility setting in WI-14.4.
 *
 * WHY IT CANNOT BE ONE CSS RULE, which is what the plan assumed for every
 * setting. The obvious rule is
 *
 *     * { font-size: max(1em, var(--paper-min-size)) !important }
 *
 * and it is WRONG in a way that is easy to miss and impossible to miss once
 * seen: inside `font-size`, `1em` is the PARENT's size, not the element's. So
 * `h1 { font-size: 2em }` resolves to `max(parent, floor)` — the parent's size —
 * and every heading, drop cap, note and pull quote in the library flattens into
 * the size of the text around it. `spacing.test.ts` has said for a long time
 * that forcing `font-size` on a descendant does exactly that, and it caught this
 * rule the day it was written.
 *
 * WHAT CSS CANNOT ASK, AND THIS ANSWERS: how big is this element ALREADY,
 * relative to the root. Measured once and written on the element, the floor
 * becomes expressible without touching the author's proportions:
 *
 *     [data-paper-em] { font-size: max(calc(var(--paper-em) * 1rem), <floor>) }
 *
 * Above the floor the element keeps its own ratio exactly; below it, it is
 * raised to the floor and no further. Same shape as `markProse` and
 * `markFigures` — a question about the DOCUMENT, answered as an attribute so
 * the sheet can select on it.
 *
 * ONLY WHAT IS SMALLER THAN THE BASE IS MARKED, and that is the property that
 * makes the whole thing safe rather than merely clever: an element at or above
 * `1rem` is never marked, so no rule can ever reach a heading. A test asserts
 * it, because "the selector happens not to match today" is not a guarantee.
 *
 * MEASURED ONCE PER BASE, AND THE FIRST VERSION OF THIS NOTE OVERSTATED IT. It
 * said the ratio "is a fact about the BOOK, not about the settings: every size
 * in the document is relative to the root". That is true of `em`, `rem` and
 * `%`, and FALSE of an absolute one — a book with `.note { font-size: 12px }`
 * keeps its 12px while the root moves, so the stored ratio drifts and the floor
 * computes from a size the element no longer has. Roughly 1% of the library
 * sizes text absolutely, which is small and is not zero.
 *
 * So the walk re-runs when the BASE moves, and only then — `applyBookVars` in
 * `bookCss` compares `--paper-size` before and after writing the contract. The
 * reading step and the typeface are the two settings that move it; brightness,
 * the theme and the other fifteen never do, and cost nothing here.
 *
 * AND IT MEASURES WITH THE FLOOR OFF, which is the trap in re-measuring at all:
 * the floor is applied through the very rule this feeds, so measuring while it
 * is in force reads the FLOORED size, stores that as the element's own ratio,
 * and ratchets it upward on every settings change. The property is removed for
 * the duration of the read and put back.
 *
 * CFI-SAFE, like the other two marks. foliate's CFIs index element and
 * character-data nodes; an attribute and a custom property on an existing
 * element add neither.
 */

/**
 * The attribute the sheet selects on, and the property it reads.
 *
 * EXPORTED AND INTERPOLATED, never restated. `bookCss` builds the rule from
 * these, so the mark and the selector cannot drift apart — a rename here that
 * left a literal behind would be a rule matching nothing, silently, which is
 * the failure mode this whole area keeps producing.
 */
export const SMALL_ATTR = 'data-paper-em'
export const SMALL_VAR = '--paper-em'

/** The floor's own property — removed while measuring; see `markSmallText`. */
export const FLOOR_VAR = '--paper-min-size'

/**
 * Below this share of the root, an element counts as small text.
 *
 * EXACTLY ONE, not a threshold with a margin. The question is only "is this
 * smaller than the base", because anything at or above the base cannot be
 * below a floor that is itself below the base. A margin here would either mark
 * body text for no reason or miss text at 0.99 that a floor would still raise.
 */
const BASE = 1

/** Rounded, because a ratio of 0.7000000000000001 in an attribute is noise. */
function ratio(size: number, root: number): number {
  return Math.round((size / root) * 1000) / 1000
}

/** How the walk reads a size — the seam, so the traversal can be tested. */
export type SizeReader = (el: Element) => number

/**
 * Mark every element set smaller than the reader's base with its own ratio.
 *
 * READ EVERY ELEMENT BEFORE WRITING ANY, for the reason `markProse` gives:
 * `getComputedStyle` flushes pending style and writing an attribute
 * invalidates it again, so interleaving the two recomputes the whole document
 * once per element. Over `*` rather than a handful of selectors that would be
 * a section load's worth of work by itself.
 *
 * `*` IS THE HONEST SELECTOR AND THE ONLY ONE. Small text is wherever the book
 * put it — a note, a caption, a run of small caps mid-sentence, a `<td>`, a
 * class nobody else uses — and there is no list of elements that finds it. The
 * cost is one style read per element per section load, paid once.
 */
export function markSmallText(doc: Document, readSize?: SizeReader): void {
  /* A section that failed to parse hands back a document with neither, which
     is the same case `markProse` and `ensureLang` guard. */
  const win = doc.defaultView
  const body = doc.body as HTMLElement | null
  const root = doc.documentElement as HTMLElement | null
  if (!body || !root || (!win && !readSize)) return

  /* THE FLOOR COMES OFF FOR THE DURATION OF THE READ. It is applied through the
     rule this feeds, so measuring with it in force reads the floored size,
     stores it as the element's own ratio, and ratchets upward every time the
     walk runs again. Restored below, in the same task — `getComputedStyle`
     flushes style synchronously, so nothing paints in between. */
  const floor = root.style?.getPropertyValue(FLOOR_VAR) ?? ''
  if (floor !== '') root.style.removeProperty(FLOOR_VAR)

  /* `finally`, NOT A LINE AT EACH EXIT. The floor is the reader's accessibility
     setting and it is OFF for the duration of this walk; anything that throws
     in between — a hostile `getComputedStyle`, a detached node — would leave it
     off for the rest of the session, silently, and the reader would simply find
     their setting had stopped working. */
  try {
    const read: SizeReader = readSize ?? ((el) => Number.parseFloat(win!.getComputedStyle(el).fontSize))
    const base = read(root)
    /* A root that reports nothing usable makes every ratio Infinity or NaN, and
       a NaN in the attribute reaches the stylesheet as an invalid declaration
       that drops silently. Nothing to measure against is nothing to mark. */
    if (!Number.isFinite(base) || base <= 0) return

    const seen: [Element, number | null][] = []
    for (const el of body.querySelectorAll('*')) {
      const size = read(el)
      /* NULL MEANS UNMARK, and an unreadable size takes that branch rather than
         `continue`. Skipped, an element that had been marked keeps its old
         attribute and its old ratio — so the floor goes on sizing it from a
         measurement nothing can any longer confirm. */
      if (!Number.isFinite(size) || size <= 0) {
        seen.push([el, null])
        continue
      }
      const share = ratio(size, base)
      /* A re-run after the base moved has to take the mark OFF an element that
         is no longer small — left on, it keeps a stale ratio and the floor goes
         on computing from it, which is the drift this re-run exists to
         correct. */
      seen.push([el, share < BASE ? share : null])
    }
    for (const [el, share] of seen) {
      if (share === null) {
        el.removeAttribute(SMALL_ATTR)
        ;(el as HTMLElement).style?.removeProperty(SMALL_VAR)
        continue
      }
      el.setAttribute(SMALL_ATTR, '')
      ;(el as HTMLElement).style?.setProperty(SMALL_VAR, String(share))
    }
  } finally {
    if (floor !== '') root.style.setProperty(FLOOR_VAR, floor)
  }
}
