import { useMemo, useState } from 'react'
import { PaneGroup } from './PaneGroup'

import {
  X,
  BookmarkPlus,
  Bookmark,
  Eye,
  ArrowDownAZ,
  ArrowDownWideNarrow,
  BookOpen,
  CircleDashed,
  LibraryBig,
  Undo2,
} from 'lucide-react'
import type { IndexedBook } from '../../core/bookIndex'
import {
  TAG_MAX,
  inTagOrder,
  normalizeTag,
  shelfView,
  statusCounts,
  tagCounts,
  tagKey,
  tagLeaf,
  tagTree,
  untaggedCount,
  type TagCount,
  type TagOrder,
} from '../../core/library'
import { FILTER_ABOVE, STATUS_ROWS, tagStateIn } from '../libraryFilters'
import { ICON } from '../../core/metrics'
import {
  parseQuery,
  withExcludedTag,
  withStatus,
  withTag,
  withUntagged,
  withoutTag,
} from '../../core/searchQuery'
import {
  colourOf,
  isHidden,
  isPinned,
  pinnedFirst,
  shownSubjects,
} from '../../core/tagPrefs'
import type { TagPrefsStore } from '../hooks/useTagPrefs'
import type { AppDispatch } from '../state'
import styles from './SidePane.module.css'
import { TagRow, type TagRowState } from './TagRow'

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
 * TWO GROUPS OF TAGS, THE READER'S FIRST. Anything the reader has written on
 * any book is a Tag; what only publishers say is a Subject. In a library of
 * imported EPUBs the subjects outnumber the tags ten to one and half of them
 * are catalogue strings; merged and sorted by count, the reader's own scheme
 * drowned. A subject can be adopted from its menu — written as the reader's
 * own onto every book that declares it — and it moves up.
 *
 * THE TAG LIST IS SCOPED TO THE SHELF AS SHOWN — status, text, tags and
 * exclusions all — so a row's number answers "of these, how many carry this",
 * which is what a reader narrowing further is asking, and a tag no shown book
 * carries is not offered, because clicking it would empty the shelf. Zotero's
 * tag selector works this way and it is the one idea that makes a library of
 * two thousand tags navigable without hierarchy or paging. What is ACTIVE —
 * required or excluded — is always listed, at zero if it comes to that, so
 * what is narrowing the shelf can always be lifted where the narrowing is
 * done. Status counts stay unscoped: they describe the collection, not the
 * view.
 *
 * What is deliberately NOT here: adding books (the toolbar's `+` is the one
 * place); sorting the shelf (that is ORDER, not scope, and it stays in the
 * toolbar); search (it sits above the grid, where the eye is when the grid is
 * what is being searched); and any prose for an empty shelf (the shelf's own
 * empty state does the talking).
 */


export interface LibraryPanelProps {
  readonly books: readonly IndexedBook[]
  /** The search field's contents — the one place scope lives. */
  readonly query: string
  readonly dispatch: AppDispatch
  /** Rename one of the reader's tags on every book carrying it — see `Library`. */
  readonly onRenameTag: (from: string, to: string) => void
  /** Take one of the reader's tags off every book carrying it. */
  readonly onRemoveTag: (tag: string) => void
  /**
   * The last shelf-wide removal, and the way back from it — both owned by the
   * library store rather than by this panel.
   *
   * It was `useState` here, and this panel is mounted only while its own panel
   * is showing: switching to Notes, or closing the pane, unmounted the one
   * control that could reverse a tag just taken off four hundred books. The
   * author had already stopped the line disappearing when its SECTION collapsed
   * — see the note where it renders — which is the same defect one level in.
   */
  /** The reader's decisions about their tags — pins, colours, hidden subjects
   *  and saved views. See `tagPrefs`. */
  readonly tagPrefs: TagPrefsStore
  readonly lastRemoval: { readonly tag: string; readonly bookIds: readonly string[] } | null
  readonly onUndoRemoveTag: () => void
  /** Make a publisher's subject the reader's own, on every book declaring it. */
  readonly onAdoptTag: (tag: string) => void
  /** Put tags on books — a drop on a row, and the undo after a remove. */
  readonly onTagBooks: (bookIds: readonly string[], tags: readonly string[]) => void
}

/** What the last collection-wide remove took off, so it can be put back. */
export function LibraryPanel({
  books,
  query,
  dispatch,
  onRenameTag,
  onRemoveTag,
  tagPrefs,
  lastRemoval,
  onUndoRemoveTag,
  onAdoptTag,
  onTagBooks,
}: LibraryPanelProps) {
  /* Which tag's menu is open — one across the panel, held here for the same
   * reason the shelf holds `menuFor` for its cards. */
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [order, setOrder] = useState<TagOrder>('count')
  const [filter, setFilter] = useState('')
  const [subjectsOpen, setSubjectsOpen] = useState(true)
  /* OPEN AT REST, both of them: Views and Tags are what this panel is FOR, and
     a reader who opened it to reach a tag should not have to open it twice.
     They can be put away now, which is the part that was missing — a shelf
     with sixty tags made the scopes above them unreachable without scrolling
     past all sixty. */
  const [viewsOpen, setViewsOpen] = useState(true)
  const [tagsOpen, setTagsOpen] = useState(true)
  /** Naming a view, in place — the same shape the tag rename uses. */
  const [naming, setNaming] = useState(false)
  const [viewName, setViewName] = useState('')

  /* PARSED ONCE. This ran twice — once bare for the scope sets, once inside
   * the shelf memo — two derivations of one string, diverging the day one
   * gains an argument the other lacks. */
  const parsed = useMemo(() => parseQuery(query, tagKey), [query])
  const counts = statusCounts(books)
  /* The shelf as the reader sees it — see the header. */
  const shown = useMemo(
    () =>
      shelfView(books, {
        scope: {
          tags: parsed.tags,
          excluded: parsed.excluded,
          status: parsed.status,
          untagged: parsed.untagged,
        },
        query: parsed.text,
      }),
    [books, parsed],
  )
  /* Unscoped, once, for three things the scoped count cannot say: whose a tag
   * is (a pinned zero row still needs its group), whether there are any
   * subjects at all, and — in one pass — how many books a remove of each of
   * the reader's tags would touch. The removes number used to be asked per
   * row through `ownTagBooks`, a full shelf walk each, on every render. */
  const all = useMemo(() => tagCounts(books), [books])
  const whose = useMemo(() => new Map(all.map((row) => [tagKey(row.tag), row])), [all])
  const removesByKey = useMemo(() => {
    const map = new Map<string, number>()
    for (const book of books) {
      const seen = new Set<string>()
      for (const tag of book.tags ?? []) {
        const key = tagKey(tag)
        if (!key || seen.has(key)) continue
        seen.add(key)
        map.set(key, (map.get(key) ?? 0) + 1)
      }
    }
    return map
  }, [books])
  const counted = useMemo(() => tagCounts(shown), [shown])
  const untagged = untaggedCount(shown)

  const activeTags = new Set(parsed.tags.map(tagKey))
  const excludedTags = new Set(parsed.excluded.map(tagKey))
  /* AN ACTIVE TAG IS ALWAYS LISTED, even at zero — required or excluded. An
   * excluded tag is at zero by construction (nothing shown carries it), and a
   * required one falls to zero under a status it has no books in. Either
   * way, a panel that hides the very scope it is applying is lying by
   * omission. Merged in at count 0, in the group its provenance puts it in. */
  const rows: TagCount[] = [
    ...counted,
    ...[...parsed.tags, ...parsed.excluded]
      .filter((tag) => !counted.some((one) => tagKey(one.tag) === tagKey(tag)))
      .map((tag) => ({ tag, count: 0, mine: whose.get(tagKey(tag))?.mine ?? false })),
  ]
  const q = tagKey(filter)
  /* The name filter never hides an ACTIVE row — what is narrowing the shelf
   * must stay clearable where the narrowing is done, which is the same rule
   * that pins active rows into `rows` above. A filtered-out active tag was
   * un-clearable from the panel that applied it. */
  const narrowed = q
    ? rows.filter(
        (row) =>
          tagKey(row.tag).includes(q) ||
          activeTags.has(tagKey(row.tag)) ||
          excludedTags.has(tagKey(row.tag)),
      )
    : rows
  /* PINNED FIRST, and after the reader's chosen order rather than instead of
     it: `pinnedFirst` is a stable partition, so what is not pinned keeps the
     order the control above put it in. */
  const mine = pinnedFirst(
    inTagOrder(
      narrowed.filter((row) => row.mine),
      order,
    ),
    tagPrefs.prefs,
  )
  /* A hidden subject is gone from here and nowhere else: it stays on the book,
     it still scopes if typed, and the editor still offers to adopt it. What the
     reader asked for is not to be shown BISAC codes in this list. */
  const subjects = shownSubjects(
    inTagOrder(
      narrowed.filter((row) => !row.mine),
      order,
    ),
    tagPrefs.prefs,
  )
  const hiddenCount = tagPrefs.prefs.hiddenSubjects.length
  const views = tagPrefs.prefs.views
  /* Offered only when there IS a scope, and only when it is not already kept.
     A "Save this view" row over an unscoped shelf saves the word "everything",
     and one offered over a view the reader just chose invites them to make a
     second copy of it. */
  const savable = query.trim() !== '' && !views.some((one) => one.query === query.trim())
  const nothingScoped =
    parsed.status === null &&
    parsed.tags.length === 0 &&
    parsed.excluded.length === 0 &&
    !parsed.untagged
  /* The tag SECTION shows when there is anything for it to say — including a
   * shelf with no tags at all but books not yet filed (the Untagged row is
   * this section's), and an `is:untagged` scope in force with nothing behind
   * it, which still needs its lit row to be cleared by. */
  const anyTags =
    all.length > 0 ||
    parsed.tags.length > 0 ||
    parsed.excluded.length > 0 ||
    untagged > 0 ||
    parsed.untagged

  const setQuery = (next: string) => dispatch({ type: 'setLibraryQuery', query: next })

  /* THE SHARED RULE — see `tagStateIn`. This was the original of it and the
     narrow menu had a second, poorer copy that knew only two of the three
     states; one function is what stops them disagreeing again. */
  const stateOf = (tag: string): TagRowState => tagStateIn(parsed, tag, tagKey)

  /**
   * One tag row.
   *
   * `label` overrides what the row SAYS without changing what it is: a child of
   * a group shows `Sea` rather than `Fiction/Sea`, so the shared word is not
   * repeated down the column — but every action on it still names the whole
   * tag, because the whole tag is what scopes, renames and removes.
   */
  const row = (entry: TagCount, label?: string) => {
    const { tag, count } = entry
    const state = stateOf(tag)
    return (
      <TagRow
        key={tagKey(tag)}
        tag={tag}
        label={label}
        count={count}
        /* The number a remove would actually touch — NOT `count`, which is
           scoped to the view and includes publisher subjects. From the
           one-pass map rather than a per-row shelf walk on every keystroke.
           The ids the remove and its undo use come from the same rule inside
           the store (`ownTagBooks`, read before the tag is taken off), so the
           number here and the books touched there cannot disagree. */
        removes={removesByKey.get(tagKey(tag)) ?? 0}
        mine={entry.mine}
        state={state}
        pinned={isPinned(tagPrefs.prefs, tag)}
        onTogglePin={() => tagPrefs.togglePinned(tag)}
        colour={colourOf(tagPrefs.prefs, tag)}
        onSetColour={(next) => tagPrefs.setColour(tag, next)}
        hidden={isHidden(tagPrefs.prefs, tag)}
        onToggleHidden={() => tagPrefs.toggleHidden(tag)}
        /* Tags ACCUMULATE — every tag, not any — because adding a second one
           is narrowing, and that is what `tag:` has always meant. Clicking a
           row that is ON clears it; clicking one that is EXCLUDED lifts the
           exclusion and requires it instead, which is what a click on a row
           has always meant here. */
        onToggle={() =>
          setQuery(state === 'on' ? withoutTag(query, tag, tagKey) : withTag(query, tag, tagKey))
        }
        onToggleExclude={() =>
          setQuery(
            state === 'excluded' ? withoutTag(query, tag, tagKey) : withExcludedTag(query, tag, tagKey),
          )
        }
        /* A renamed tag that was scoping the shelf keeps scoping it under its
           new name, or the shelf would silently un-narrow the moment the reader
           corrected a spelling. Normalised HERE, by the same function the store
           uses, so the tag the query names is the tag that was written. */
        onRename={(to) => {
          const stored = normalizeTag(to)
          if (!stored) return
          onRenameTag(tag, stored)
          if (state === 'on') setQuery(withTag(withoutTag(query, tag, tagKey), stored, tagKey))
          if (state === 'excluded') {
            setQuery(withExcludedTag(withoutTag(query, tag, tagKey), stored, tagKey))
          }
        }}
        /* A removed tag comes out of the query too — a scope on a tag that no
           book carries would empty the shelf with nothing to say why. What it
           came off is kept, so the line below can put it back. */
        onRemove={() => {
          /* The store takes the ids it will need for the undo, before the tag
             is gone — see `removeTag`. Read here they would already be stale. */
          onRemoveTag(tag)
          if (state !== 'off') setQuery(withoutTag(query, tag, tagKey))
        }}
        onAdopt={() => onAdoptTag(tag)}
        onDropBooks={(bookIds) => onTagBooks(bookIds, [tag])}
        menuFor={menuFor}
        setMenuFor={setMenuFor}
      />
    )
  }

  return (
    <div className={styles.libraryPanel}>
      {/* §11: say what happened. A pin, a colour, a hidden subject or a saved
          view the storage refused stayed on screen as though kept and was gone
          at the next launch, with nothing having said so (WI-20.36). Said
          here, where the decisions are made. */}
      {!tagPrefs.persistent && (
        <div className={styles.panelMeta}>
          <span>
            Your tag pins, colours, hidden subjects and saved views are not being saved — this
            device's storage is unavailable.
          </span>
        </div>
      )}
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
        onClick={() => setQuery(parsed.text)}
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

      {/* SAVED VIEWS, with the status rows rather than with the tags.
          Phase 4 deleted collections because a tag already scoped, and that was
          right — but a saved QUERY is a different thing from a tag: `is:reading
          -tag:Abandoned` names no single tag and cannot be a row in the tag
          list. It belongs where the other whole-shelf scopes are.
          A row, not a screen: choosing one sets the query, which is the only
          state a view has. Nothing is hidden behind it. */}
      {(views.length > 0 || savable) && (
        <>
          <PaneGroup
            title="Views"
            count={views.length}
            open={viewsOpen}
            onToggle={() => setViewsOpen((open) => !open)}
          >
          {views.map((view) => {
            const on = query.trim() === view.query
            return (
              <div key={view.id} className={styles.viewRow} data-on={on}>
                <button
                  type="button"
                  className={styles.viewButton}
                  data-on={on}
                  aria-pressed={on}
                  title={view.query}
                  onClick={() => setQuery(on ? '' : view.query)}
                >
                  <Bookmark size={ICON.control} strokeWidth={ICON.stroke} />
                  <span className={styles.scopeLabel}>{view.name}</span>
                </button>
                <button
                  type="button"
                  className={styles.viewRemove}
                  aria-label={`Forget the view ${view.name}`}
                  title="Forget this view"
                  onClick={() => tagPrefs.removeView(view.id)}
                >
                  <X size={ICON.inline} strokeWidth={ICON.stroke} />
                </button>
              </div>
            )
          })}
          {savable &&
            (naming ? (
              <form
                className={styles.tagRename}
                onSubmit={(event) => {
                  event.preventDefault()
                  const name = viewName.trim()
                  if (name) tagPrefs.saveView(name, query)
                  setNaming(false)
                  setViewName('')
                }}
              >
                <Bookmark size={ICON.control} strokeWidth={ICON.stroke} />
                <input
                  className={styles.tagRenameInput}
                  value={viewName}
                  autoFocus
                  maxLength={TAG_MAX}
                  placeholder="Name this view"
                  aria-label="Name for this view"
                  onChange={(event) => setViewName(event.target.value)}
                  onBlur={() => {
                    setNaming(false)
                    setViewName('')
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation()
                      setNaming(false)
                      setViewName('')
                    }
                  }}
                />
              </form>
            ) : (
              <button
                type="button"
                className={styles.scopeRow}
                title={query}
                onClick={() => setNaming(true)}
              >
                <BookmarkPlus size={ICON.control} strokeWidth={ICON.stroke} />
                <span className={styles.scopeLabel}>Save this view</span>
              </button>
            ))}
          </PaneGroup>
        </>
      )}

      {anyTags && (
        <>
          <PaneGroup
            title="Tags"
            open={tagsOpen}
            onToggle={() => setTagsOpen((open) => !open)}
            /* The other order — the icon is what pressing it GIVES you, as
               the shelf's view toggle does. Most-used-first is for seeing a
               scheme; A–Z is for finding a name in a long list. Beside the
               heading rather than in it, because the heading is a button. */
            tool={
              <button
                type="button"
                className={styles.groupTool}
                aria-label={order === 'count' ? 'Sort tags by name' : 'Sort tags by how many books'}
                title={order === 'count' ? 'Sort by name' : 'Sort by count'}
                onClick={() => setOrder(order === 'count' ? 'name' : 'count')}
              >
                {order === 'count' ? (
                  <ArrowDownAZ size={ICON.control} strokeWidth={ICON.stroke} />
                ) : (
                  <ArrowDownWideNarrow size={ICON.control} strokeWidth={ICON.stroke} />
                )}
              </button>
            }
          >

          {/* A field to narrow the list by name, once the list is long enough
              to need one. Below that it would be a control for a problem the
              reader does not have — but WHILE IT HOLDS TEXT it stays, whatever
              the count: scoping the shelf can shrink the list under the
              threshold, and unmounting the field then left its filter applied
              with nothing on screen to clear it by. */}
          {(rows.length > FILTER_ABOVE || filter !== '') && (
            <input
              type="search"
              className={styles.tagFilter}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter tags"
              aria-label="Filter the tag list"
            />
          )}

          {/* GROUPED ON THE SLASH, which `Fiction/Sea` has stored and scoped
              since tags existed — this is the rendering that was missing, not a
              new capability. A group whose prefix is not itself a tag draws a
              heading rather than a row: there is nothing to scope to, and a
              dead control wearing a live one's clothes is worse than a label.
              Shipped as the default view, not behind a preference — a reader
              who never types a slash sees exactly the flat list they had. */}
          {tagTree(mine).map((group) =>
            group.children.length === 0 ? (
              group.self && row(group.self)
            ) : (
              <div key={`g:${tagKey(group.prefix)}`} className={styles.tagGroup}>
                {group.self ? (
                  row(group.self)
                ) : (
                  <div className={styles.tagGroupHead}>{group.prefix}</div>
                )}
                <div className={styles.tagGroupChildren}>
                  {group.children.map((child) => row(child, tagLeaf(child.tag)))}
                </div>
              </div>
            ),
          )}

          {/* UNTAGGED — books with none of the reader's own tags, within the
              view. Where every cleanup starts. Listed under the reader's tags
              rather than among the statuses, because "not yet filed" is a
              fact about the reader's scheme, not about where they are in the
              book. Hidden at zero like any other row, unless it is ON. */}
          {(untagged > 0 || parsed.untagged) && !q && (
            <button
              type="button"
              className={styles.scopeRow}
              data-on={parsed.untagged}
              aria-pressed={parsed.untagged}
              title="Books with no tag of yours"
              onClick={() => setQuery(withUntagged(query, !parsed.untagged))}
            >
              <CircleDashed size={ICON.control} strokeWidth={ICON.stroke} />
              <span className={styles.scopeLabel}>Untagged</span>
              <span className={styles.scopeCount}>{untagged}</span>
            </button>
          )}

          {/* THE WAY BACK FROM HIDING. A hidden subject's row is gone from this
              list, and its menu with it — so without this the reader can hide a
              subject and has no way at all to unhide it. Shown whenever
              anything is hidden, including when every subject is, which is the
              case where the section itself disappears. */}
          {hiddenCount > 0 && (
            <div className={styles.hiddenLine} role="status">
              <span className={styles.hiddenText}>
                {hiddenCount} {hiddenCount === 1 ? 'subject' : 'subjects'} hidden
              </span>
              <button
                type="button"
                className={styles.undoButton}
                onClick={() => {
                  for (const key of [...tagPrefs.prefs.hiddenSubjects]) tagPrefs.toggleHidden(key)
                }}
              >
                <Eye size={ICON.control} strokeWidth={ICON.stroke} />
                Show all
              </button>
            </div>
          )}

          {subjects.length > 0 && (
            <>
              <PaneGroup
                title="Subjects"
                count={subjects.length}
                open={subjectsOpen}
                onToggle={() => setSubjectsOpen((open) => !open)}
                hint="What the publishers say the books are about"
              >
                {subjects.map((one) => row(one))}
              </PaneGroup>
            </>
          )}
          </PaneGroup>
        </>
      )}

      {/* OUTSIDE the tags section's gate, deliberately: removing the last tag
          on the shelf collapses that section, and an undo that unmounted with
          it vanished at the exact moment it was the only way back. */}
      {lastRemoval && (
        <div className={styles.undoLine} role="status">
          <span className={styles.undoText}>
            Removed {lastRemoval.tag} from {lastRemoval.bookIds.length}{' '}
            {lastRemoval.bookIds.length === 1 ? 'book' : 'books'}
          </span>
          <button
            type="button"
            className={styles.undoButton}
            onClick={onUndoRemoveTag}
          >
            <Undo2 size={ICON.control} strokeWidth={ICON.stroke} />
            Undo
          </button>
        </div>
      )}

      {books.length === 0 && (
        /* Not prose — the shelf's own empty state says what to do. Just the
           quiet fact, in the panel's own idiom, so the pane is not blank. */
        <div className={styles.scopeHint}>
          <BookOpen size={ICON.control} strokeWidth={ICON.stroke} />
          Nothing on the shelf yet
        </div>
      )}
    </div>
  )
}
