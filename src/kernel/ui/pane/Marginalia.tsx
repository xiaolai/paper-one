import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Asterisk,
  /* Aliased: `Bookmark` is also the record type this file is largely about,
     and the icon is the lesser of the two claims on the name. */
  Bookmark as BookmarkIcon,
  BookOpen,
  Highlighter,
  Layers,
  LibraryBig,
  PenLine,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { cardFromMark } from '../../core/cards'
import {
  compareMarks,
  isAnnotation,
  isBookmark,
  type Annotation,
  type Bookmark,
  type Mark,
} from '../../core/marks'
import type { MarkFocus } from '../hooks/useMarking'
import type { JumpTarget } from '../hooks/useJumps'
import { ICON, type Platform } from '../../core/metrics'
import { onBeforeClose } from '../../core/beforeClose'
import { relativeTime } from '../../core/relativeTime'
import type { CardsView } from '../hooks/useCards'
import type { MarksView } from '../hooks/useMarks'
import { comboFor } from '../panes'
import { FilterChips } from './FilterChips'
import styles from './SidePane.module.css'

/**
 * Marginalia — everything the reader put in a book, across every book.
 *
 * Distinct from a margin note: this is the whole collection, browsable and
 * filterable, where a margin note is one annotation anchored to one line.
 *
 * IT WAS CALLED NOTES, and the name stopped being true when bookmarks joined
 * it. §15's lexicon is precise about the two words it owns — a **mark** is the
 * highlight, a **note** is what you wrote on it — and a panel holding marks,
 * notes, the companion's claims AND places named itself after one of the four.
 * "Annotations" was the obvious replacement and is the one word §15 rules out
 * for this panel. Marginalia is what a reader leaves in a book, which is
 * exactly the union; a bookmark is not written, which is the one place the word
 * stretches, and it stretches less than the alternatives.
 *
 * TWO AXES, TWO ROWS OF CHIPS, because they are independent questions. What
 * KIND of thing, and WHOSE BOOK. Folding the second into the first would make
 * "This book" mutually exclusive with "Marks", which is not what either means.
 */

type KindFilter = 'All' | 'Marks' | 'Notes' | 'Bookmarks' | 'Companion'
const KINDS: readonly KindFilter[] = ['All', 'Marks', 'Notes', 'Bookmarks', 'Companion']

/** The scope chips. Only offered with a book open — see the render. */
type ScopeFilter = 'All books' | 'This book'
const SCOPES: readonly ScopeFilter[] = ['All books', 'This book']

/**
 * The chips are icons, and each one BORROWS AN ASSOCIATION THE APP HAS ALREADY
 * TAUGHT rather than inventing a glyph.
 *
 * Sparkles is the Companion's own rail icon and LibraryBig is the Library's, so
 * a reader who has used either panel already knows what those two mean here.
 * Bookmark is the ribbon the toggle draws on the page. Highlighter is this
 * panel's own rail icon, which is right for the kind of thing this panel is
 * mostly made of. PenLine is the note — §15's word for what you wrote on a
 * mark — and BookOpen is the one you have open. Asterisk is the wildcard, which
 * is the only one of the seven that is a convention rather than a recall.
 *
 * Typed as a total Record, so adding a filter without an icon fails to compile
 * instead of drawing an empty button — see `FilterChipsProps.icons`.
 */
const KIND_ICONS: Readonly<Record<KindFilter, typeof Asterisk>> = {
  All: Asterisk,
  Marks: Highlighter,
  Notes: PenLine,
  Bookmarks: BookmarkIcon,
  Companion: Sparkles,
}

const SCOPE_ICONS: Readonly<Record<ScopeFilter, typeof Asterisk>> = {
  'All books': LibraryBig,
  'This book': BookOpen,
}

function matches(mark: Mark, filter: KindFilter): boolean {
  switch (filter) {
    case 'All':
      return true
    case 'Companion':
      return mark.kind === 'companion'
    /* A BOOKMARK HAS NO NOTE and never will — `bookmarkFrom` writes an empty
     * one and says why — so it cannot appear under Notes by accident. Stated
     * rather than relied on: the filters are read by someone deciding what a
     * chip means, and "notes" meaning "anything with writing on it" is the
     * whole rule. */
    case 'Notes':
      return isAnnotation(mark) && mark.note !== ''
    case 'Marks':
      return mark.kind === 'highlight'
    case 'Bookmarks':
      return isBookmark(mark)
  }
}

/**
 * The note editor, which saves whatever it is holding when it goes away.
 *
 * Blur alone was not enough, and the gap was silent: closing the pane, changing
 * the filter, opening another book or quitting the window all remove a focused
 * textarea WITHOUT a blur event, so the note the reader had just typed was
 * discarded with no indication that it had not been kept. It saves on blur, on
 * unmount, and when the window is hidden or put away.
 */
interface NoteEditorProps {
  initial: string
  onCommit: (value: string) => void
  onDone: () => void
}

function NoteEditor({ initial, onCommit, onDone }: NoteEditorProps) {
  /**
   * The latest text, tracked as it is typed.
   *
   * Read from here rather than from the element, because by the time the
   * unmount cleanup runs React has already detached the ref — `field.current`
   * is null and the save silently keeps nothing, which is the exact failure
   * this editor exists to prevent, moved one step later. The element is still
   * needed for the initial value and for blur; it is just not the source of
   * truth at teardown.
   */
  const draft = useRef(initial)
  /**
   * What is already stored, so an unchanged note is not written again.
   *
   * TRIMMED, because what it is compared against is. `save` trims the draft and
   * then tested it against the untrimmed stored value, so a note that happens
   * to be stored with a leading space differed from itself: opening it and
   * closing it again rewrote it — a new HLC stamp, a write, and a row that
   * looks edited to every replica, for a note nobody touched.
   */
  const stored = useRef(initial.trim())
  const commit = useRef(onCommit)
  commit.current = onCommit

  const save = useCallback(() => {
    const value = draft.current.trim()
    if (value === stored.current) return
    stored.current = value
    commit.current(value)
  }, [])

  /**
   * Hand the draft over before the window closes.
   *
   * THIS is what makes a note survive quitting, and it is a handover rather than
   * a save: `save` puts the text into the marks store, whose queue the close
   * handler then drains. Two halves of one thing — see `beforeClose`.
   *
   * `pagehide` cannot do this job and never could. It fires as the webview is
   * torn down, so it starts work nothing will finish; and Tauri's close-request
   * arrives BEFORE it, so by the time it ran the queue had already been declared
   * empty. It stays below as the browser's path, where there is no close-request
   * to intercept.
   */
  useEffect(() => onBeforeClose(save), [save])

  /**
   * And save while they type, which covers what no shutdown hook can.
   *
   * A close is orderly. A crash, a force-quit or a power cut is not, and neither
   * runs anything. A pause of a second is the difference between losing a
   * paragraph and losing a sentence.
   */
  useEffect(() => {
    const idle = window.setInterval(save, 1000)
    return () => window.clearInterval(idle)
  }, [save])

  useEffect(() => {
    // `pagehide` rather than `beforeunload`: it fires on the path a webview
    // actually takes when the window goes away, and it is not blocked by the
    // conditions that make `beforeunload` unreliable. In Tauri the close is
    // intercepted before this; in a browser this is all there is.
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', save)
    return () => {
      window.removeEventListener('pagehide', save)
      document.removeEventListener('visibilitychange', save)
      save()
    }
  }, [save])

  return (
    <textarea
      className={styles.noteInput}
      defaultValue={initial}
      autoFocus
      placeholder="Write a note"
      onChange={(event) => {
        draft.current = event.target.value
      }}
      onBlur={() => {
        save()
        onDone()
      }}
    />
  )
}

/**
 * The clock the ages are measured against.
 *
 * A plain `Date.now()` in the render only advances when something unrelated
 * re-renders the panel, so a reader who leaves the pane open watches three
 * bookmarks stay "Just now" for an hour. A minute matches the resolution
 * `relativeTime` reports in; anything faster re-renders for a value that cannot
 * have changed. Injectable so a test asserts an age without waiting for one.
 */
function useNow(injected: number | undefined): number {
  const [now, setNow] = useState(() => injected ?? Date.now())
  useEffect(() => {
    if (injected !== undefined) return
    const tick = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(tick)
  }, [injected])
  return injected ?? now
}

/**
 * One kept PLACE.
 *
 * Its own row rather than a variant of the annotation row, because the two say
 * different things: a mark row leads with the passage and carries a note and a
 * card; a place row leads with the chapter and carries a line only to confirm
 * which of several places in that chapter it is. Sharing the row's parts
 * (`.note`, `.noteJump`, `.noteSource`) and not its content is what keeps them
 * looking like one list without pretending they are one thing.
 */
function PlaceRow({
  bookmark,
  now,
  reachable,
  onGoTo,
  onDelete,
}: {
  bookmark: Bookmark
  now: number
  reachable: boolean
  onGoTo?: (target: JumpTarget) => void
  onDelete: (bookmark: Bookmark) => void
}) {
  /* `bookmarkFrom` collapses the whitespace before storing, so this is already
     done for anything written since that landed. It stays for the rows written
     BEFORE it, which carry the newlines and indentation of the markup they were
     walked out of. Idempotent, so it settles both. */
  const line = bookmark.text.replace(/\s+/gu, ' ').trim()
  const chapter = bookmark.chapter || 'Somewhere in this book'
  return (
    <>
      {/* NO BOOK LINE HERE. The row wrapper above draws it for every mark that
          is not from the open one, place rows included — drawing a second here
          printed the title twice on every cross-book bookmark. */}
      <button
        type="button"
        className={styles.noteJump}
        /* THE SAME RULE THE MARK ROW FOLLOWS, computed once by the panel and
           handed down — see `reachable` there. It used to be "only the open
           book"; it is now "a book still on the shelf", and a place in a book
           Paper no longer holds is the case that stays disabled. */
        disabled={!reachable || !onGoTo}
        onClick={() => onGoTo?.({ bookId: bookmark.bookId, cfi: bookmark.cfi })}
      >
        <span className={styles.placeChapter}>{chapter}</span>
        {line && <span className={`${styles.noteBody} ${styles.placeLine}`}>{line}</span>}
      </button>
      <div className={styles.noteSource}>
        <span>{relativeTime(bookmark.createdAt, now)}</span>
        <button
          type="button"
          className={styles.noteDelete}
          title="Remove this bookmark"
          /* NAMES THE PLACE. Several bookmarks in one chapter are explicitly
             supported, so the chapter alone does not tell two of them apart;
             the remembered line is what does. */
          aria-label={`Remove this bookmark — ${line || chapter}`}
          onClick={() => onDelete(bookmark)}
        >
          <Trash2 size={ICON.inline} strokeWidth={ICON.stroke} />
        </button>
      </div>
    </>
  )
}

export interface MarginaliaProps {
  marks: MarksView
  /** Where a mark becomes a made thing — §15's line between note and card. */
  cards: CardsView
  /** The open book, so its marks can be shown first. Null when none is open. */
  bookId: string | null
  /**
   * Removes a mark from the STORE and from the page.
   *
   * Deleting used to call `marks.remove` straight, which leaves the drawn
   * annotation and its cached Range exactly where they were: the note vanished
   * from this list while its highlight stayed on the text, and the margin went
   * on showing it, until something else happened to force a redraw.
   */
  onDelete: (mark: Annotation) => void
  /** Takes a bookmark off, from any book — routed by id through the store. */
  onDeleteBookmark: (bookmark: Bookmark) => void
  /** Which keyboard this reader has, so the empty state names a real key. */
  platform: Platform
  /** Injected so a test can assert an age without waiting for one to pass. */
  now?: number
  /**
   * The title of a book, by id.
   *
   * A CROSS-BOOK LIST HAS TO SAY WHICH BOOK. A row carries a chapter and a
   * line, and neither identifies the work: two books with a chapter called
   * "Introduction" produce two rows that look the same, and a row from a book
   * that is not open cannot be jumped to either — so the reader is shown
   * something they can neither place nor reach. Shown only on rows OUTSIDE the
   * open book; inside it, the book is the one they are reading.
   */
  titleOf?: ((bookId: string) => string | undefined) | undefined
  /**
   * The mark to reveal, from a click on the page or on a margin note.
   *
   * Opening the panel is not showing the mark: the list holds every mark in
   * every book, so "open Notes" for a reader with any history means landing at
   * the top of a long list with no indication of which row was being asked
   * for. This scrolls to it, and opens its editor when the request was to
   * write rather than to read.
   */
  focus?: MarkFocus | null
  /**
   * Whether a book is on the shelf, and so can be opened at all.
   *
   * WHAT DECIDES A CROSS-BOOK ROW'S REACHABILITY. Asked separately from
   * `titleOf` on purpose: a shelved book with an empty title also has no title
   * to return, so treating "no title" as "not here" would disable rows that
   * work perfectly. Absent, every row outside the open book stays disabled —
   * which is what this panel did before there was anywhere to come back to.
   */
  onShelf?: ((bookId: string) => boolean) | undefined
  onGoTo?: (target: JumpTarget) => void
}

export function Marginalia({
  marks,
  cards,
  bookId,
  onDelete,
  onDeleteBookmark,
  platform,
  focus,
  onGoTo,
  onShelf,
  now: injectedNow,
  titleOf,
}: MarginaliaProps) {
  const [filter, setFilter] = useState<KindFilter>('All')
  /* ALL BOOKS BY DEFAULT, which is what this panel has always shown. Narrowing
     is the reader's move, and defaulting to it would silently change what a
     panel they already know shows them. */
  const [scope, setScope] = useState<ScopeFilter>('All books')
  const now = useNow(injectedNow)
  /**
   * Whether a row can be jumped into.
   *
   * ONE RULE, THREE ROWS — the mark row, the place row, and anything added
   * beside them. It used to be `mark.bookId === bookId` spelled twice, and the
   * two were right only because nothing had changed yet.
   *
   * The open book is always reachable. Any other book is reachable when it is
   * on the shelf, because opening it at a CFI is a path that already exists:
   * reading-position restore hands `view.init` a location on every reopen.
   * A book that has LEFT the shelf is not reachable, and its row stays
   * disabled — `Marginalia` still refuses to draw a control that does nothing,
   * which is the same rule as before with a narrower subject.
   */
  const reachable = useCallback(
    (mark: Mark) => mark.bookId === bookId || (onShelf?.(mark.bookId) ?? false),
    [bookId, onShelf],
  )
  /** The mark whose note is being written. One at a time, like a text field. */
  /* Cross-book marks are read HERE, on mount, because this is the only view
   * that wants them — marks live in each book's folder, so answering "every
   * book's marks" costs one read per book. This pane mounts only when it is
   * open, so a reader who never opens Notes never pays for the scan. */
  const { loadAll } = marks
  useEffect(() => {
    loadAll()
  }, [loadAll])

  const [editing, setEditing] = useState<string | null>(null)
  const rows = useRef(new Map<string, HTMLDivElement>())

  /** Everything this panel browses: both classes, from every book. */
  const everything = useMemo(
    () => [...marks.all, ...marks.allBookmarks],
    [marks.all, marks.allBookmarks],
  )

  /**
   * The open book's rows first, then the rest, each book in BOOK ORDER.
   *
   * The open book leads because `marks.all` is every book's in store order, so
   * a reader with any history opened this panel onto somebody else's chapter.
   *
   * SORTED WITHIN EACH BOOK, which the annotation-only version did not have to
   * do: it kept the store's order, and the store's order already was book
   * order. Two lists concatenated are not, so a bookmark would have landed
   * after every mark instead of among them at the place it names. `compareMarks`
   * is section-then-CFI and works across both classes; it is only meaningful
   * WITHIN one book, which is why the grouping happens first.
   */
  /**
   * Everything the CHOSEN SCOPE covers, before the kind filter.
   *
   * One collection, because the rows and the counts both need it and both were
   * computing it: two spellings of "is this in scope" that can drift, and when
   * they do the total under the title disagrees with the list under the total.
   */
  const inScope = useMemo(
    () =>
      everything.filter((mark) => scope === 'All books' || !bookId || mark.bookId === bookId),
    [everything, scope, bookId],
  )

  const shown = useMemo(() => {
    const kept = inScope.filter((mark) => matches(mark, filter))
    const byBook = new Map<string, Mark[]>()
    for (const mark of kept) {
      const group = byBook.get(mark.bookId)
      if (group) group.push(mark)
      else byBook.set(mark.bookId, [mark])
    }
    const books = [...byBook.keys()].sort((a, b) =>
      a === bookId ? -1 : b === bookId ? 1 : 0,
    )
    // Each group is an array built here, so sorting it mutates nothing shared.
    return books.flatMap((id) => (byBook.get(id) ?? []).sort(compareMarks))
  }, [inScope, filter, bookId])

  /* Reveal whatever was asked for.
   *
   * The filter is cleared first when it would hide the mark: asking to see a
   * highlight while the list is filtered to Notes would otherwise scroll to a
   * row that is not rendered, which looks exactly like the click doing
   * nothing. Keyed on the whole focus object, nonce included, so asking twice
   * for the same mark works twice. */
  useEffect(() => {
    if (!focus) return
    const target = everything.find((mark) => mark.id === focus.id)
    if (!target) return
    if (!matches(target, filter)) setFilter('All')
    if (focus.edit) setEditing(focus.id)
    // After paint, so the row exists to scroll to when the filter just changed.
    const frame = requestAnimationFrame(() => {
      rows.current.get(focus.id)?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
    // `filter` is deliberately absent: this reacts to a focus request, not to
    // the reader changing the filter themselves afterwards.
  }, [focus, everything])

  /* Counted from what exists rather than written as prose: the fixture said
   * "1,204 highlights · 318 notes" under a list of three. Counted over the
   * SCOPE the reader chose, so the number and the list below it agree. */
  const counted = useMemo(
    () => ({
      marks: inScope.filter(isAnnotation).length,
      /* ASKS THE CLASS FIRST. A bookmark's note is empty by construction and is
         canonicalised to empty on the way out of storage — but this counted
         anything with a note, so a row that arrived with one before that
         canonicalisation existed would have been counted as a piece of
         writing. Two guards for one invariant, deliberately: the store's is
         the fix and this is the surface refusing to depend on it. */
      notes: inScope.filter((mark) => isAnnotation(mark) && mark.note !== '').length,
      places: inScope.filter(isBookmark).length,
    }),
    [inScope],
  )

  if (everything.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>Nothing kept yet</div>
        <div className={styles.emptyBody}>
          Select a passage and choose Mark — notes you write on a mark appear
          beside the line they belong to. Press {comboFor('⌘B', platform)} to
          keep the place you are reading.
        </div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelMeta}>
        <span className={styles.countRow}>
          {counted.marks} {counted.marks === 1 ? 'mark' : 'marks'} · {counted.notes}{' '}
          {counted.notes === 1 ? 'note' : 'notes'} · {counted.places}{' '}
          {counted.places === 1 ? 'bookmark' : 'bookmarks'}
        </span>
      </div>

      {/* §11: say what happened and what to do. A store that has quietly
          stopped saving looks exactly like one that works. */}
      {!marks.persistent && (
        <div className={styles.panelMeta}>
          <span>Marginalia is not being saved — this device's storage is unavailable.</span>
        </div>
      )}

      {/* BOTH AXES ON ONE LINE, with a rule between them.
          As words the seven wrapped to three lines of chrome above the list at
          the pane's 400px. As icons they are one, and the rule is what keeps
          them legible as two questions rather than one row of seven — a reader
          has to be able to see that picking "Notes" does not un-pick "This
          book". */}
      <div className={styles.filterBar}>
        <FilterChips
          options={KINDS}
          active={filter}
          onSelect={setFilter}
          label="Filter by kind"
          icons={KIND_ICONS}
        />
        {/* ONLY WITH A BOOK OPEN. With none, "This book" names nothing and
            would empty the list for a reason the reader cannot see — a control
            that is present and inert is a worse answer than one that is
            absent. The rule goes with them, or it divides nothing. */}
        {bookId && (
          <>
            <span className={styles.filterDivider} aria-hidden="true" />
            <FilterChips
              options={SCOPES}
              active={scope}
              onSelect={setScope}
              label="Filter by book"
              icons={SCOPE_ICONS}
            />
          </>
        )}
      </div>

      {shown.length === 0 && everything.length > 0 && (
        <div className={styles.empty}>
          <div className={styles.emptyBody}>
            {/* Says which filter is empty, and which scope. A blank panel under
                two selected chips reads as the marks having been lost. */}
            No {filter === 'All' ? 'marginalia' : filter.toLowerCase()}
            {scope === 'This book' ? ' in this book' : ''} yet.
          </div>
        </div>
      )}

      {shown.map((mark) => (
        <div
          key={mark.id}
          ref={(node) => {
            if (node) rows.current.set(mark.id, node)
            else rows.current.delete(mark.id)
          }}
          className={styles.note}
          data-kind={mark.kind}
          /* A bookmark carries no tint, and `.note::before` falls back to
             yellow for a row without one — so a place row would have grown a
             gold rule meaning nothing. `data-place` suppresses it. */
          data-place={isBookmark(mark) ? 'true' : undefined}
          data-tint={isBookmark(mark) ? undefined : mark.tint}
          data-focused={mark.id === focus?.id}
        >
          {/* THE WORK, on rows that are not from the open book. Above whatever
              the row goes on to say about the place inside it.

              ALWAYS SOMETHING, never nothing. Showing it only when a title
              could be found meant the rows that need it most — a book removed
              from the shelf, or one whose record has not loaded — were the ones
              that silently went back to looking like the open book's. Those
              rows cannot be jumped to either, so the reader would be left with
              a note they can neither place nor reach and no sign anything was
              missing. A book with no title still says it is another book. */}
          {mark.bookId !== bookId && (
            <div className={styles.placeBook}>{titleOf?.(mark.bookId) || 'Another book'}</div>
          )}

          {/* THE ANNOTATION IS TESTED FIRST, and that order is load-bearing
              rather than stylistic. `Bookmark` is `Mark & { kind: 'bookmark' }`
              — an intersection, not a member of a union — so the ELSE branch of
              `isBookmark` narrows nothing and `mark` stays the wide type.
              Asking `isAnnotation` first narrows the branch that needs it. */}
          {isAnnotation(mark) ? (
          <>
          {mark.kind === 'companion' && (
            // The kind is stated as data as well as text: the amber that means
            // "the companion wrote this" is keyed on it — see `.noteKind`.
            <div className={styles.noteKind} data-kind="Companion">
              Companion
            </div>
          )}

          <button
            type="button"
            className={styles.noteJump}
            /* A control that silently does nothing is worse than none — the
               rule stands; its subject narrowed. It used to be "only the open
               book", because a mark from another book had nowhere to jump to.
               There is somewhere now: the host opens that book AT the mark and
               ⌘[ brings the reader home. What is still unreachable is a book
               that has left the shelf, and those rows are still disabled. */
            disabled={!reachable(mark) || !onGoTo}
            onClick={() => onGoTo?.({ bookId: mark.bookId, cfi: mark.cfi })}
          >
            <span className={styles.noteBody}>{mark.text}</span>
          </button>

          {editing === mark.id ? (
            <NoteEditor
              initial={mark.note}
              /* THE MARK, not its id — this list is cross-book, and a note
                 edited on another book's row was written to the open one. */
              onCommit={(value) => marks.setNote(mark, value)}
              onDone={() => setEditing(null)}
            />
          ) : (
            <button
              type="button"
              className={styles.noteComment}
              onClick={() => setEditing(mark.id)}
            >
              {mark.note || 'Add a note'}
            </button>
          )}

          <div className={styles.noteSource}>
            <span>{mark.chapter || 'Unknown chapter'}</span>
            <span className={styles.rowActions}>
              {/* Notes stay raw; cards are made. This is the only place the
                  one becomes the other, which is what keeps the distinction
                  §15 draws visible rather than nominal. */}
              <button
                type="button"
                className={styles.noteDelete}
                aria-label="Make a card"
                title="Make a card"
                onClick={() => cards.make(cardFromMark(mark))}
              >
                <Layers size={ICON.inline} strokeWidth={ICON.stroke} />
              </button>
              <button
                type="button"
                className={styles.noteDelete}
                aria-label="Delete mark"
                title="Delete mark"
                onClick={() => onDelete(mark)}
              >
                <Trash2 size={ICON.inline} strokeWidth={ICON.stroke} />
              </button>
            </span>
          </div>
          </>
          ) : isBookmark(mark) ? (
            <PlaceRow
              bookmark={mark}
              now={now}
              reachable={reachable(mark)}
              onDelete={onDeleteBookmark}
              {...(onGoTo ? { onGoTo } : {})}
            />
          ) : null}
        </div>
      ))}
    </div>
  )
}
