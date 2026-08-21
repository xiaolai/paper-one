import { useMemo, useRef, useState } from 'react'
import { Hash, ListFilter, Tag } from 'lucide-react'
import { ICON } from '../../core/metrics'
import { tagKey, type TagCount } from '../../core/library'
import { parseQuery, withStatus, withTag, withUntagged, withoutTag } from '../../core/searchQuery'
import { FILTER_ABOVE, STATUS_ROWS, tagStateIn } from '../libraryFilters'
import { useRowMenu } from '../hooks/useRowMenu'
import styles from './Library.module.css'

/**
 * The shelf's narrowing terms, as a menu at the end of the search field.
 *
 * THE QUERY LANGUAGE WAS ALREADY THERE AND ALREADY UNDISCOVERABLE. `parseQuery`
 * has understood `tag:Name`, `-tag:Name`, `is:reading` and `is:untagged` since
 * tags landed, and the Library panel's rows write exactly those terms into the
 * same field — but that is the only affordance there is. A reader who has not
 * opened the pane, or who is looking straight at the search field, has nothing
 * to tell them the field does more than match titles. The placeholder says
 * "or tag:Name, is:reading to narrow", which is documentation, not a control.
 *
 * So this is a second door onto the terms the first door already writes, and
 * that is the point rather than a duplication: the pane narrows the shelf while
 * you are filing books, and this narrows it while you are looking for one. Both
 * go through the same `with*` helpers, so a term added here and a term added
 * there are the same term, and either surface can take the other's off.
 *
 * IT TOGGLES, exactly as the panel's rows do. Choosing a term that is already
 * in the query removes it — otherwise the only way to undo a choice made here
 * would be to edit the query text by hand, which is the thing this exists to
 * avoid needing.
 */

export interface NarrowMenuProps {
  /** The search field's contents — `AppState.libraryQuery`. */
  query: string
  setQuery: (next: string) => void
  /** Every tag on the shelf with its count, most-used first — see `tagCounts`. */
  tags: readonly TagCount[]
  /** Open state lives with the caller, so only one shelf menu is ever open. */
  open: boolean
  setOpen: (open: boolean) => void
}

export function NarrowMenu({ query, setQuery, tags, open, setOpen }: NarrowMenuProps) {
  const anchorRef = useRef<HTMLDivElement | null>(null)
  /* Placement and dismissal are `useRowMenu`'s, the same as a book's `⋯` and
     the toolbar's two menus: click outside, Escape, or the anchor scrolling
     away all close it, and there is one way to close so no caller can invent a
     second. */
  const { moreRef, menuRef, menuStyle } = useRowMenu(open, anchorRef, () => setOpen(false), {
    side: 'bottom',
    align: 'end',
    /* THE KEYBOARD MODEL THAT `role="menu"` PROMISES. Declared without it, the
       promise was empty: focus stayed on the trigger, and ↑/↓, Home/End and the
       return-to-trigger on close did nothing — a reader on a keyboard was told
       there was a menu and handed no way into it. */
    menu: true,
  })

  const [filter, setFilter] = useState('')
  const parsed = parseQuery(query, tagKey)
  /**
   * Every tag the query NAMES, required or excluded.
   *
   * `-tag:Sea` narrows the shelf just as `tag:Sea` does, and this counted only
   * the required half — so an excluded tag was neither shown as active nor
   * pinned past the top of the list, and the surface that can write one had no
   * way to take it off again. The panel has always counted both.
   */
  const active = new Set([...parsed.tags, ...parsed.excluded].map(tagKey))

  /**
   * The tags this menu is showing.
   *
   * NO CAP. It offered the eight most-used and a row pointing at the panel for
   * the rest, which is not a design for a reader with fifty tags — it is a
   * dead end wearing a count. Every tag is here, the region scrolls, and past
   * `FILTER_ABOVE` there is a field to narrow them by name. That is the same
   * answer the Library panel already gives to the same problem, on the same
   * threshold, deliberately: a filter field that appears at thirteen tags in
   * one surface and never in the other teaches a reader nothing about either.
   *
   * The fold is `tagKey`'s, so `sea` finds `Sea`.
   *
   * AND IT NEVER HIDES AN ACTIVE TAG — the panel's rule, for the panel's
   * reason: what is narrowing the shelf must stay clearable where the
   * narrowing was done. A filtered-out active tag is one the reader can see the
   * effect of and cannot reach the switch for.
   */
  const shown = useMemo(() => {
    /* EVERY ACTIVE TERM GETS A ROW, INVENTING ONE IF IT MUST.
     *
     * The list comes from `tagCounts`, which counts what is on the shelf — so a
     * term naming a tag no book carries any more, or one the reader typed by
     * hand and misspelt, has no row to appear in. It still narrows the shelf,
     * to nothing, and the surface that can write a term had no way to take that
     * one off: the shelf was empty, the menu looked untouched, and the only way
     * out was editing the query text by hand, which is the thing this exists to
     * avoid needing. A count of zero is the honest thing to show. */
    const missing = [...parsed.tags, ...parsed.excluded]
      .filter((tag) => !tags.some((row) => tagKey(row.tag) === tagKey(tag)))
      .map((tag) => ({ tag, count: 0 }))
    const all = [...tags, ...missing]

    const q = tagKey(filter)
    if (q) return all.filter((row) => tagKey(row.tag).includes(q) || active.has(tagKey(row.tag)))
    /* UNFILTERED, THE MOST-USED ONLY — `tagCounts` already sorts by count, so
     * this is the top of that. A reader with a hundred tags does not scan a
     * hundred rows to find one; they either reach for one of the few they use
     * constantly, which are these, or they know its name, which is what the
     * field is for. Rendering all hundred on every open would cost the DOM for
     * a list nobody reads to the bottom of.
     *
     * Plus any ACTIVE tag that falls outside them, for the rule below: a term
     * narrowing the shelf must stay clearable from the surface that applied it,
     * and a rarely-used tag is exactly the kind that would drop off the top. */
    const top = all.slice(0, FILTER_ABOVE)
    const seen = new Set(top.map((row) => tagKey(row.tag)))
    return [...top, ...all.filter((row) => active.has(tagKey(row.tag)) && !seen.has(tagKey(row.tag)))]
    // `active` and `parsed` are derived from `query` and change with it.
  }, [tags, filter, query])

  /**
   * Apply a change and STAY OPEN.
   *
   * These terms combine — a status, untagged, and any number of tags all narrow
   * together — so closing on every pick made choosing two of them cost two trips
   * through the button. The shelf behind updates as each one lands, which is the
   * feedback that makes staying open worth more than the tidiness of closing.
   * Escape, a click outside, or the button again all still put it away.
   */
  const choose = (next: string) => setQuery(next)

  return (
    <div className={styles.narrowAnchor} ref={anchorRef}>
      <button
        type="button"
        ref={moreRef}
        className={styles.narrow}
        /* Lit while the query carries any term this menu can write, so the
           control reports the state rather than only offering to change it. A
           reader who narrowed the shelf and forgot has something to look at. */
        /* EXCLUSIONS COUNT. `-tag:Sea` narrows the shelf exactly as `tag:Sea`
           does, and leaving it out meant a reader who had excluded a tag and
           forgotten saw an unlit button over a shelf missing books — the one
           state this light exists to report. */
        data-on={
          parsed.status !== null ||
          parsed.untagged ||
          parsed.tags.length > 0 ||
          parsed.excluded.length > 0
        }
        aria-label="Narrow the shelf"
        title="Narrow the shelf"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ListFilter size={ICON.inline} strokeWidth={ICON.stroke} />
      </button>

      {open && (
        <div ref={menuRef} className={styles.menu} style={menuStyle} role="menu">
          {/* THE PANEL'S OWN REGISTRY, so the same state wears the same word
              and the same mark in both surfaces — see `STATUS_ROWS`. */}
          {STATUS_ROWS.map(({ status, label, Icon }) => {
            const on = parsed.status === status
            return (
              <button
                key={status}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                className={styles.menuItem}
                data-on={on}
                onClick={() => choose(withStatus(query, on ? null : status))}
              >
                <Icon size={ICON.inline} strokeWidth={ICON.stroke} />
                {label}
              </button>
            )
          })}

          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={parsed.untagged}
            className={styles.menuItem}
            data-on={parsed.untagged}
            onClick={() => choose(withUntagged(query, !parsed.untagged))}
          >
            <Tag size={ICON.inline} strokeWidth={ICON.stroke} />
            Untagged
          </button>

          {/* PAST THE THRESHOLD, OR WHILE A FILTER IS APPLIED. The second half is
              the panel's hard-won half: narrowing the shelf can drop the tag
              list back under the threshold, and unmounting the field then left
              its filter applied with nothing on screen to clear it by. */}
          {(tags.length > FILTER_ABOVE || filter !== '') && (
            <input
              type="search"
              /* IN THE ARROW WALK, without taking a menu role: it stays a
                 search field so it is announced as one — see `useRowMenu`. */
              data-menu-item=""
              className={styles.menuFilter}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter tags"
              aria-label="Filter tags"
            />
          )}

          <div className={styles.menuScroll}>
          {shown.map(({ tag, count }) => {
            /* THREE STATES, from the rule the Library panel uses — see
               `tagStateIn`. Asking only "is it required" made an excluded row
               take the not-required branch, so the press offered for clearing
               `-tag:Sea` wrote `tag:Sea` and narrowed the shelf to the very
               books the reader was hiding.

               BY KEY, not by spelling: `parsed` holds what the reader typed,
               and two spellings of one tag are one tag. */
            const state = tagStateIn(parsed, tag, tagKey)
            /* A press CLEARS whatever the tag is doing, and requires it when it
               is doing nothing. `withoutTag` takes off either form, so one call
               serves both — there is no third press that writes an exclusion,
               because this menu has never offered one and the query text
               remains the way to say it. */
            const clears = state !== 'off'
            return (
              <button
                key={tag}
                type="button"
                role="menuitemcheckbox"
                aria-checked={state === 'on'}
                className={styles.menuItem}
                data-on={state === 'on'}
                /* Said out loud, because "checked: false" is what an untouched
                   tag reports too and the two mean opposite things here. */
                data-excluded={state === 'excluded' ? 'true' : undefined}
                title={state === 'excluded' ? `Hiding ${tag} — press to clear` : undefined}
                onClick={() =>
                  choose(clears ? withoutTag(query, tag, tagKey) : withTag(query, tag, tagKey))
                }
              >
                <Hash size={ICON.inline} strokeWidth={ICON.stroke} />
                <span className={styles.menuLabel}>{tag}</span>
                <span className={styles.menuCount}>{count}</span>
              </button>
            )
          })}

          {filter !== '' && shown.length === 0 && (
            /* Says which filter is empty rather than showing a blank region,
               which reads as the tags having gone. */
            <div className={styles.menuEmpty}>No tag matches “{filter}”.</div>
          )}

          {/* WHAT IS NOT ON SCREEN, AND HOW TO REACH IT. Not a row that sends
              the reader somewhere else — the field above reaches every one of
              them without leaving the menu. This only says the list is a top,
              not the whole, which a list that silently stopped at twelve would
              not. */}
          {filter === '' && tags.length > shown.length && (
            <div className={styles.menuEmpty}>
              Showing the {shown.length} most used. Type to find any of {tags.length}.
            </div>
          )}
          </div>
        </div>
      )}
    </div>
  )
}
