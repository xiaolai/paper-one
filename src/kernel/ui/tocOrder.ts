/**
 * The table of contents as a flat list, in the order a reader moves through it.
 *
 * ⚠️ **ONE ANSWER, BECAUSE TWO WOULD DISAGREE ABOUT WHICH CHAPTER IS NEXT.** The
 * flatten was private to `Contents.tsx`, which renders the tree as an indented
 * list; read-aloud's chapter step needs exactly the same order, and a second
 * traversal written beside it is how "next chapter" ends up meaning one thing in
 * the contents pane and another under the voice. It lives here, above both, so
 * the pane and the reader share it rather than each keeping a copy.
 *
 * Sits in `ui/` rather than in `ui/reader/` or `ui/pane/` on purpose: both of
 * those import from here already, so nothing new crosses between them.
 */

import type { TocItem } from 'foliate-js/view.js'

export interface FlatTocEntry {
  /** Null for a grouping heading with no destination — see `TocItem.href`. */
  readonly href: string | null
  readonly label: string
  readonly depth: number
}

/** The TOC is a tree; a reader walks it as an indented list. */
export function flattenToc(items: readonly TocItem[], depth = 0): FlatTocEntry[] {
  return items.flatMap((item) => [
    { label: item.label, href: item.href, depth: Math.min(depth, 2) },
    ...(item.subitems ? flattenToc(item.subitems, depth + 1) : []),
  ])
}

/**
 * The href of the chapter before or after `currentHref`, or null at either end.
 *
 * ⚠️ **HEADINGS WITH NO DESTINATION ARE SKIPPED, NOT COUNTED.** A part divider —
 * `BOOK TWO` with no `href` — is a row in the contents and not a place, so
 * stepping onto it would be a chapter step that navigates nowhere and looks like
 * a dead button. Filtering them out first also means the step is over the same
 * list a reader could click through.
 *
 * ⚠️ **AND MATCHING IS ON `href`, NEVER ON THE LABEL.** `Contents.tsx` records
 * why in its own props: labels repeat across a book — "Chapter 1", "Epígrafe" —
 * so a label match finds the first duplicate and the step jumps to the wrong
 * part of the book.
 *
 * Null when the current href is not in the TOC at all, which is a real state: a
 * reader can be in a spine item no contents entry points at, and guessing a
 * neighbour for it would move them somewhere they did not ask for.
 */
export function stepChapter(
  toc: readonly TocItem[],
  currentHref: string,
  by: -1 | 1,
): string | null {
  const places = flattenToc(toc).filter((entry) => entry.href !== null)
  const at = places.findIndex((entry) => entry.href === currentHref)
  if (at === -1) return null
  return places[at + by]?.href ?? null
}
