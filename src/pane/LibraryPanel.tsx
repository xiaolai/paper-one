import { useState } from 'react'
import { BookOpen, Check, Circle, CircleDot, LibraryBig } from 'lucide-react'
import type { IndexedBook } from '../lib/bookIndex'
import { normalizeTag, statusCounts, tagCounts, tagKey, type ReadingStatus } from '../lib/library'
import { ICON } from '../lib/metrics'
import { parseQuery, withStatus, withTag, withoutTag } from '../lib/searchQuery'
import type { AppDispatch } from '../lib/state'
import styles from './SidePane.module.css'
import { TagRow } from './TagRow'

/**
 * Library — the collection view.
 *
 * What the side pane holds when the SHELF is the screen. In the reader the pane
 * is about this book; here it is about this collection: how many books stand
 * at each stage of being read, what they are tagged, and a way to narrow the
 * shelf to any of those with one click. The same job Notes does for marks,
 * done for books.
 *
 * SELECTION IS SCOPE, NOT NAVIGATION. A row does not go anywhere; it narrows
 * the shelf, exactly as typing `is:reading` or `tag:Sea` into the search field
 * would — because that is literally what it does. The panel writes into the
 * field and reads back out of it, so there is no scope here that the field
 * does not show, and clicking here and typing there are one thing. Clicking
 * an ON row clears it.
 *
 * THE COUNTS ARE THE POINT. A row without a number is a link; a row with one
 * is a fact about the collection — three in flight, two never opened, one done
 * — which is what makes opening the pane on the shelf worth doing.
 *
 * What is deliberately NOT here: adding books (the toolbar's `+` is the one
 * place, and this panel replaced an "Add books" panel that was one paragraph
 * and a second copy of that button); sorting (that is ORDER, not scope, and
 * it stays in the toolbar); search (it sits above the grid, where the eye is
 * when the grid is what is being searched); and any prose for an empty shelf
 * (the shelf's own empty state does the talking — a second paragraph here
 * would be two voices).
 */

interface StatusRow {
  readonly status: ReadingStatus
  readonly label: string
  readonly Icon: typeof Circle
}

const STATUS_ROWS: readonly StatusRow[] = [
  { status: 'reading', label: 'Reading', Icon: CircleDot },
  { status: 'unread', label: 'Unread', Icon: Circle },
  { status: 'finished', label: 'Finished', Icon: Check },
]

export interface LibraryPanelProps {
  readonly books: readonly IndexedBook[]
  /** The search field's contents — the one place scope lives. */
  readonly query: string
  readonly dispatch: AppDispatch
  /** Rename one of the reader's tags on every book carrying it — see `Library`. */
  readonly onRenameTag: (from: string, to: string) => void
  /** Take one of the reader's tags off every book carrying it. */
  readonly onRemoveTag: (tag: string) => void
  /** How many books `onRemoveTag` would touch — the number the confirm shows. */
  readonly ownTagCount: (tag: string) => number
  /* THE BACKGROUND PASS IS NOT REPORTED HERE ANY MORE. It was, and it was only
   * visible when this panel happened to be open — which is the wrong condition
   * for "what is the app doing". It reports from the shelf's own status bar
   * now, which is always on screen while the shelf is. */
}

export function LibraryPanel({
  books,
  query,
  dispatch,
  onRenameTag,
  onRemoveTag,
  ownTagCount,
}: LibraryPanelProps) {
  /* Which tag's menu is open — one across the panel, held here for the same
   * reason the shelf holds `menuFor` for its cards. */
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const parsed = parseQuery(query, tagKey)
  const counts = statusCounts(books)
  /* Tag counts are SCOPED to the current status, so a tag's number under
   * `is:reading` answers "how many of these are tagged so" — which is what a
   * reader narrowing further is asking. Status counts are not scoped, for the
   * opposite reason: they describe the collection, not the current view. */
  const counted = tagCounts(books, parsed.status ? { tags: [], status: parsed.status } : null)
  const activeTags = new Set(parsed.tags.map(tagKey))
  /* AN ACTIVE TAG IS ALWAYS LISTED, even at zero. Scoped to a status, a tag
   * with no books in that status fell out of `tagCounts` — and with it went
   * the lit row that was the reader's one way to clear it from the panel. The
   * chip under the search field could still clear it, but a panel that hides
   * the very scope it is applying is lying by omission. Merged in at count 0,
   * so what is narrowing the shelf is always visible where the narrowing is
   * done. `mine` is false for such a row — nothing on the shelf carries it —
   * so it offers no menu, correctly. */
  const tags = [
    ...counted,
    ...parsed.tags
      .filter((tag) => !counted.some((one) => tagKey(one.tag) === tagKey(tag)))
      .map((tag) => ({ tag, count: 0, mine: false })),
  ]
  const nothingScoped = parsed.status === null && parsed.tags.length === 0

  const setQuery = (next: string) => dispatch({ type: 'setLibraryQuery', query: next })

  return (
    <div className={styles.libraryPanel}>
      <button
        type="button"
        className={styles.scopeRow}
        data-on={nothingScoped}
        aria-pressed={nothingScoped}
        /* The reset. ON when nothing is scoped, so the panel always shows one
           row lit — the reader can see at a glance whether the shelf they are
           looking at is the whole shelf. Clicking it clears every scope but
           keeps free text, since the words typed are a search and not a
           scope; clearing them would be doing more than was asked. */
        onClick={() => setQuery(parseQuery(query, tagKey).text)}
      >
        <LibraryBig size={ICON.control} strokeWidth={ICON.stroke} />
        <span className={styles.scopeLabel}>All books</span>
        <span className={styles.scopeCount}>{counts.all}</span>
      </button>

      {STATUS_ROWS.map(({ status, label, Icon }) => {
        const on = parsed.status === status
        return (
          <button
            key={status}
            type="button"
            className={styles.scopeRow}
            data-on={on}
            aria-pressed={on}
            /* One status at a time — a book has one — so clicking a second
               row replaces the first rather than narrowing to nothing. */
            onClick={() => setQuery(withStatus(query, on ? null : status))}
          >
            <Icon size={ICON.control} strokeWidth={ICON.stroke} />
            <span className={styles.scopeLabel}>{label}</span>
            <span className={styles.scopeCount}>{counts[status]}</span>
          </button>
        )
      })}

      {tags.length > 0 && (
        <>
          <div className={styles.groupTitle}>Tags</div>
          {tags.map(({ tag, count, mine }) => {
            const on = activeTags.has(tagKey(tag))
            return (
              <TagRow
                key={tagKey(tag)}
                tag={tag}
                count={count}
                /* The number a remove would actually touch — NOT `count`,
                   which is scoped to the status and includes publisher
                   subjects. See `ownTagCount`. */
                removes={ownTagCount(tag)}
                mine={mine}
                on={on}
                /* Tags ACCUMULATE — every tag, not any — because adding a
                   second one is narrowing, and that is what `tag:` has always
                   meant in the field. */
                onToggle={() =>
                  setQuery(on ? withoutTag(query, tag, tagKey) : withTag(query, tag, tagKey))
                }
                /* A renamed tag that was scoping the shelf keeps scoping it
                   under its new name, or the shelf would silently un-narrow
                   the moment the reader corrected a spelling. */
                onRename={(to) => {
                  /* Normalised HERE, by the same function the store uses, so
                     the tag the query names is the tag that was written. Raw,
                     a 70-character rename scoped the shelf to a tag that never
                     existed and the view emptied. */
                  const stored = normalizeTag(to)
                  if (!stored) return
                  onRenameTag(tag, stored)
                  if (on) setQuery(withTag(withoutTag(query, tag, tagKey), stored, tagKey))
                }}
                /* A removed tag comes out of the query too — a scope on a tag
                   that no book carries would empty the shelf with nothing to
                   say why. */
                onRemove={() => {
                  onRemoveTag(tag)
                  if (on) setQuery(withoutTag(query, tag, tagKey))
                }}
                menuFor={menuFor}
                setMenuFor={setMenuFor}
              />
            )
          })}
        </>
      )}

      {books.length === 0 && (
        /* Not prose — the shelf's own empty state says what to do. Just the
           quiet fact, in the panel's own idiom, so the pane is not blank. */
        <div className={styles.scopeHint}>
          <BookOpen size={ICON.control} strokeWidth={ICON.stroke} />
          Nothing on the shelf yet
        </div>
      )}

      {/* The background parse, while there is one. A book imported from a
          folder arrives as its filename with no jacket — parsing three hundred
          at import would make importing as slow as reading — and this is the
          pass that comes back for them. It says what it is doing and how much
          is left, then disappears; a reader whose fans have spun up is owed the
          sentence. No control: it pauses itself while a book is open, and it
          resumes on the next launch, so there is nothing to decide. */}
    </div>
  )
}
