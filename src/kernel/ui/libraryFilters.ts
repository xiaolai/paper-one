import { Check, Circle, CircleDot } from 'lucide-react'
import type { ReadingStatus } from '../core/library'
import type { ParsedQuery } from '../core/searchQuery'

/**
 * How the shelf's narrowing terms are PRESENTED — the words, the marks, and
 * the one threshold two surfaces share.
 *
 * ITS OWN MODULE BECAUSE TWO SURFACES NEED IT. These lived in `LibraryPanel`
 * and were exported from there for the screen's narrow menu to import, which
 * points a screen at a pane for a registry neither one owns. Nothing here
 * renders; it is what the two renderers agree about.
 *
 * `searchQuery.STATUSES` is still the parser's list and the authority on which
 * terms are LEGAL. This is what those terms look like, which is UI and belongs
 * beside the surfaces rather than in core beside the regex.
 */

interface StatusRow {
  readonly status: ReadingStatus
  readonly label: string
  readonly Icon: typeof Circle
}

/**
 * The three reading states, with the words and the marks they wear.
 *
 * EXPORTED because the shelf's narrow menu offers the same three, and a second
 * copy of a registry is a second opinion about it — the same reason `panes.ts`
 * exists. `searchQuery.STATUSES` is the parser's list and stays the authority
 * on which terms are legal; this is what those terms LOOK like, which is UI and
 * belongs here rather than in core beside the regex.
 */
export const STATUS_ROWS: readonly StatusRow[] = [
  { status: 'reading', label: 'Reading', Icon: CircleDot },
  { status: 'unread', label: 'Unread', Icon: Circle },
  { status: 'finished', label: 'Finished', Icon: Check },
]

/**
 * Past this many rows a surface offers a field to narrow the tag list by name.
 *
 * EXPORTED because the shelf's narrow menu has the same problem and must not
 * answer it with a different number — a reader who sees a filter field at
 * thirteen tags here and not there has learned nothing about either.
 */
export const FILTER_ABOVE = 12

/** What a tag is doing to the shelf: nothing, narrowing to it, or hiding it. */
export type TagState = 'off' | 'on' | 'excluded'

/**
 * What the query says about one tag — the SAME answer in both surfaces.
 *
 * THREE STATES, NOT TWO, and the missing third was a real defect rather than a
 * missing nicety. The narrow menu asked only "is this tag required", so an
 * EXCLUDED tag came back `false` and its row's press took the not-required
 * branch: `-tag:Sea` became `tag:Sea`. The reader pressed the one control
 * offered for clearing an exclusion and the shelf narrowed to the exact books
 * they had been hiding. The Library panel has always had the three; this is
 * that rule, in one place, so the two cannot answer differently again.
 *
 * Excluded is tested FIRST: a query naming a tag both ways is contradictory,
 * and reporting the exclusion is the reading that matches the shelf, which
 * shows nothing.
 */
export function tagStateIn(
  parsed: Pick<ParsedQuery, 'tags' | 'excluded'>,
  tag: string,
  key: (t: string) => string,
): TagState {
  const target = key(tag)
  if (parsed.excluded.some((t) => key(t) === target)) return 'excluded'
  return parsed.tags.some((t) => key(t) === target) ? 'on' : 'off'
}
