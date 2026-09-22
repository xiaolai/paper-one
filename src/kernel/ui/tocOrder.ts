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
  /**
   * How deep in the tree, UNCLAMPED.
   *
   * ⚠️ **THIS USED TO BE `Math.min(depth, 2)`, INSIDE THE SHARED TRAVERSAL.** The
   * 2 is a fact about the contents pane's indent tokens — §09 has three of them —
   * and nothing about the book. Applied here it discarded the real hierarchy for
   * every caller, including read-aloud's chapter step, which has no indents and
   * no reason to care. A traversal that answers what the book says, and a
   * renderer that clamps to what it can draw, are two jobs; `Contents.tsx` does
   * the clamping now, where the tokens are.
   */
  readonly depth: number
  /**
   * Where this row sits in the tree, as the child indices down to it: `0.2.1`.
   *
   * ⚠️ **A REACT KEY MAY NOT BE THE FLATTENED INDEX, AND MAY NOT BE THE HREF
   * EITHER.** The index moves when anything above is inserted; the href is not
   * unique, because a part divider and its first chapter may legally target the
   * same destination — which is the same duplication `stepChapter` below has to
   * dedupe for. The path is unique by construction and stable for as long as the
   * book's own tree is.
   */
  readonly path: string
}

/**
 * The TOC is a tree; a reader walks it as an indented list.
 *
 * ⚠️ **ITERATIVE, AND IT WAS `flatMap` WITH A SPREAD PER LEVEL.** That copies
 * every descendant array again at each level up the tree — quadratic in the
 * number of entries for a deep one — and recurses once per level, so a
 * pathologically nested TOC could exhaust the stack on a book's own data. An
 * explicit stack has neither property. The order is unchanged: an entry, then
 * its subtree, depth first.
 */
export function flattenToc(items: readonly TocItem[]): FlatTocEntry[] {
  const out: FlatTocEntry[] = []
  /* Pushed in reverse so the LAST sibling is popped last — depth-first in
     document order, which is the order a reader reads and clicks. */
  const pending: { item: TocItem; depth: number; path: string }[] = []
  /* ONE CONDITION PER LOOP. Both used to carry a bound AND an `undefined` guard
     — `at >= 0` beside `item === undefined`, `length > 0` beside `next ===
     undefined` — and with two conditions saying the same thing, either could be
     changed without anything noticing. Reading by `entries()` has no index to
     fall off, and popping until nothing comes back has no length to misjudge. */
  const push = (list: readonly TocItem[], depth: number, prefix: string) => {
    for (const [at, item] of [...list.entries()].reverse()) {
      pending.push({ item, depth, path: prefix === '' ? String(at) : `${prefix}.${at}` })
    }
  }
  push(items, 0, '')
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { item, depth, path } = next
    out.push({ label: item.label, href: item.href, depth, path })
    if (item.subitems) push(item.subitems, depth + 1, path)
  }
  return out
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
  /**
   * ⚠️ **DUPLICATE DESTINATIONS WERE COUNTED AS SEPARATE CHAPTERS.** A part
   * divider and its first chapter may legally target the same href — so with
   * `findIndex` taking the first occurrence, "next" from the parent returned the
   * CURRENT href and did nothing, and "previous" from the child skipped a
   * chapter. Deduplicated by destination first, because that is what a step
   * actually moves between: two rows that go to the same place are one place.
   */
  const seen = new Set<string>()
  const places: string[] = []
  for (const entry of flattenToc(toc)) {
    /* `!href`, not `=== null`: an EMPTY href is no more a destination than a
       missing one — `Contents.tsx` already reads it that way — and counted as a
       place it let a reader in a section the contents never names (`''`) step
       relative to a heading. */
    if (!entry.href || seen.has(entry.href)) continue
    seen.add(entry.href)
    places.push(entry.href)
  }
  const at = places.indexOf(currentHref)
  if (at === -1) return null
  return places[at + by] ?? null
}

/**
 * A chapter step over the book's contents, for a reader at `here`: whether each
 * direction goes anywhere, and the step itself.
 *
 * ⚠️ **ONE LOOKUP SERVES BOTH HALVES**, so what the transport DRAWS and what the
 * step TAKES cannot disagree. They were computed separately once — a fresh
 * `stepChapter` inside the action, another for the buttons — and reconciled only
 * by both being correct.
 *
 * ⚠️ **PULLED OUT OF `App.tsx` SO EVERY BRANCH IS REACHABLE.** Inside the host,
 * `go` is only ever pressed through a button `can` has already drawn, so its
 * "nowhere to go" answer could not be reached by any test that drove the app —
 * and that answer is the contract `useSpeech` relies on to keep a pending gap
 * when a step declines. Here it is a function call.
 */
export function chapterSteps(
  toc: readonly TocItem[],
  here: string,
  goTo: (href: string) => void,
): { can: (by: -1 | 1) => boolean; go: (by: -1 | 1) => boolean } {
  return {
    can: (by) => stepChapter(toc, here, by) !== null,
    go: (by) => {
      const href = stepChapter(toc, here, by)
      if (href === null) return false
      goTo(href)
      return true
    },
  }
}
