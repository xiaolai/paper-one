import { collapse } from 'foliate-js/epubcfi.js'
import { compareCfi, compareMarks, removeMark, upsertMark, type Mark } from './marks'

/**
 * Which mark a selection is on.
 *
 * A mark and a selection are the same passage when their CFIs OVERLAP, not when
 * they are byte-identical. Two things made byte equality wrong:
 *
 *   Selecting part of an already-highlighted paragraph found nothing, so the
 *   toolbar offered "Mark" over a passage that was already marked and stacked a
 *   second highlight on the first. That bug predates any of this.
 *
 *   Snapping a selection to whole words means the same gesture now resolves to
 *   a WIDER range than it used to. Every mark made before that shipped is a
 *   range no gesture can reproduce any more — so under byte equality it becomes
 *   unreachable by the very gesture that created it, and re-marking it silently
 *   makes a duplicate. Overlap reaches those marks without rewriting a single
 *   stored CFI, which is what makes it revertible.
 *
 * The rationale, and the two alternatives that were rejected, are written up in
 * `.claude/tdd-guardian/decision-wi10-20260815-094442.md`.
 *
 * Everything here is pure string work over CFIs. No book has to be open, and no
 * DOM has to exist, which is what lets the rules be tested directly.
 */

/** A place in a book — the three fields identifying a passage, and no more. */
export interface Passage {
  readonly cfi: string
  readonly sectionIndex: number
  readonly bookId: string
}

/**
 * What foliate collapses an unusable CFI to.
 *
 * This sentinel is the validity check, and it is measured rather than assumed.
 * The obvious guard — foliate's own `isCFI` — does not do the job: it is the
 * regex `/^epubcfi\((.*)\)$/`, so `epubcfi(garbage)` passes it. Nor does a
 * try/catch alone: `''`, `'not a cfi'` and `'epubcfi('` all parse quite happily
 * into an EMPTY path, and an empty path sorts before every real CFI. An overlap
 * test built on comparison alone therefore finds one corrupt row in storage
 * overlapping every selection in the book — the failure is a mark that captures
 * everything, not a mark that matches nothing.
 *
 * The catch is still needed beside it: a range CFI missing its end
 * (`epubcfi(/6/4!/4/2,/1:5)`) throws on collapse rather than degenerating.
 */
const NOWHERE = 'epubcfi()'

/** The two ends of a CFI as point CFIs, or null if it addresses nowhere. */
function ends(cfi: string): readonly [string, string] | null {
  try {
    const start = collapse(cfi)
    const end = collapse(cfi, true)
    if (start === NOWHERE || end === NOWHERE) return null
    return [start, end]
  } catch {
    return null
  }
}

/**
 * Whether two CFIs cover any of the same text.
 *
 * Half-open, so ADJACENCY IS NOT OVERLAP: a selection ending exactly where a
 * mark begins is the next passage, not the same one, and marking it must make a
 * second mark rather than replace the first.
 *
 * Equality is handled on its own line because a collapsed CFI — a caret, with
 * no text between its ends — overlaps nothing at all under a strict comparison,
 * including itself. Byte-identical CFIs matched before this change and must
 * keep matching after it: the new behaviour has to be a superset of the old,
 * never a trade. A pair that is equal and unparseable still matches nothing.
 */
export function cfiOverlaps(a: string, b: string): boolean {
  const first = ends(a)
  if (first === null) return false
  if (a === b) return true
  const second = ends(b)
  if (second === null) return false
  return compareCfi(first[0], second[1]) < 0 && compareCfi(second[0], first[1]) < 0
}

/**
 * The mark a selection is on, or null.
 *
 * When a selection overlaps two marks the answer is the FIRST IN `compareMarks`
 * ORDER — the order the Notes list already reads in. The rule this replaced was
 * "greatest overlap, ties by creation order", and it was withdrawn because it
 * cannot be computed: `view.getCFI` emits CFIs with no character offsets at all
 * for a range that begins and ends at an element boundary, so there is no
 * amount of overlap to compare. Subtracting offsets that are not there yields
 * NaN, every comparison against NaN is false, and the winner quietly becomes
 * whichever mark the array yielded first — which is the one thing a tie-break
 * exists to prevent. Document order needs nothing measured, is total over
 * offset-less CFIs, and is already covered by foliate's own CFI test vectors.
 *
 * The section is checked before the CFI, for the reason `compareMarks` gives:
 * two CFIs from different spine items address positions in different documents
 * and are not comparable at all.
 */
export function findMark(marks: readonly Mark[], passage: Passage): Mark | null {
  let best: Mark | null = null
  for (const candidate of marks) {
    if (candidate.bookId !== passage.bookId) continue
    if (candidate.sectionIndex !== passage.sectionIndex) continue
    if (!cfiOverlaps(candidate.cfi, passage.cfi)) continue
    /* Scanned rather than sorted: sorting would mutate the caller's array,
     * which in the reader is React state held outside a setter. */
    if (best === null || compareMarks(candidate, best) < 0) best = candidate
  }
  return best
}

/**
 * Add a mark, replacing the one it supersedes.
 *
 * `upsertMark` keys on a byte-identical CFI, which stopped being enough the
 * moment a mark could be reached by a selection that does not reproduce its
 * anchor exactly: re-marking wrote a second, overlapping row, and foliate drew
 * both. This is the same rule stated against the same identity the toolbar uses
 * — so what "Re-mark" replaces is the mark it said was there.
 *
 * ONE mark goes, not every overlapping one. A selection spanning a paragraph
 * overlaps everything marked inside it, and those may carry written notes;
 * clearing them all would delete work the reader never asked to lose.
 * `upsertMark` still runs underneath, so the byte-exact rule it documents is
 * kept rather than replaced.
 */
export function upsertOverlapping(marks: readonly Mark[], mark: Mark): Mark[] {
  const superseded = findMark(marks, mark)
  return upsertMark(superseded === null ? marks : removeMark(marks, superseded.id), mark)
}
