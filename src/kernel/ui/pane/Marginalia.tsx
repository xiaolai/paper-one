import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  Trash2,
} from 'lucide-react'
import { cardFromMark } from '../../core/cards'
import {
  compareMarks,
  isPlaced,
  isAnnotation,
  isBookmark,
  type Annotation,
  type Bookmark,
  type Mark,
  MAX_MARK_NOTE,
} from '../../core/marks'
import type { MarkFocus } from '../hooks/useMarking'
import type { JumpTarget } from '../hooks/useJumps'
import { ICON, type Platform } from '../../core/metrics'

/**
 * What a row says when it cannot be jumped to because the mark has no anchor
 * HERE — imported from another build of the book (WI-21.7).
 *
 * One sentence, one place. The reason is not guessable from the row: the book
 * is on the shelf and may well be open, so a disabled control reads as a defect
 * unless it explains itself.
 */
const UNPLACED_TITLE = 'From another edition of this book — Paper has not found this passage here yet.'
import { onBeforeClose } from '../../core/beforeClose'
import { relativeTime } from '../../core/relativeTime'
import type { CardsView } from '../hooks/useCards'
import type { MarkControl } from '../../core/capability'

/* The context a mark control's contribution is drawn under: the open book, which the control's own render never reads — it is handed the mark. */
// Stryker disable next-line ObjectLiteral,ArrowFunction: no control reads the context, so what it holds — or that it is nothing — cannot be seen.
const controlContext = (bookId: string | null): { readonly bookId: string | null } => ({ bookId })

/**
 * Whether an annotation carries a note the reader can see.
 *
 * ONE predicate for the filter and the count — `note !== ''` in two places
 * counted an imported or legacy note that was nothing but whitespace as
 * writing, and drew it as one: a "Notes" chip with a number under it and a
 * row with nothing on it.
 */
const hasNote = (mark: { readonly note: string }): boolean => mark.note.trim() !== ''

/** §11: say what happened and what to do. A store that has quietly stopped saving looks exactly like one that works. */
const NOT_SAVING = "Marginalia is not being saved — this device's storage is unavailable."

/**
 * The same sentence for the cards this panel makes — their own store and their
 * own flag (`CardsView.persistent`), which the panel could not see (#132).
 */
const NOT_SAVING_CARDS = "Cards you make are not being saved — this device's storage is unavailable."

/** The one sentence for a marks file that would not read, wherever it stands. */
const UNREADABLE_MARKS =
  "This book's marks file could not be read. It is left as it is, and marks made now are not being saved over it."
/**
 * The cross-book scan failed — said instead of the empty state, never beside
 * it; and above a list that IS shown, which it used to be kept out of (#129).
 */
export const SCAN_FAILED_MARKS = 'Your marks could not be read'
/** What to do about a failed scan, wherever it is said. */
const SCAN_FAILED_NEXT = 'Nothing on disk has been changed. Close and reopen the panel to try again.'
/** The cross-book scan is still running — over an empty panel or above a partial list (#130). */
const SCANNING_MARKS = 'Reading your marks…'
import type { MarksView } from '../hooks/useMarks'
import { comboFor } from '../panes'
import { FilterChips } from './FilterChips'
import styles from './SidePane.module.css'
import { ContributionBoundary, ContributionBody } from '../ContributionBoundary'

/**
 * Marginalia — everything the reader put in a book, across every book.
 *
 * Distinct from a margin note: this is the whole collection, browsable and
 * filterable, where a margin note is one annotation anchored to one line.
 *
 * IT WAS CALLED NOTES, and the name stopped being true when bookmarks joined
 * it. §15's lexicon is precise about the two words it owns — a **mark** is the
 * highlight, a **note** is what you wrote on it — and a panel holding marks,
 * notes AND places named itself after one of the three.
 * "Annotations" was the obvious replacement and is the one word §15 rules out
 * for this panel. Marginalia is what a reader leaves in a book, which is
 * exactly the union; a bookmark is not written, which is the one place the word
 * stretches, and it stretches less than the alternatives.
 *
 * TWO AXES, TWO ROWS OF CHIPS, because they are independent questions. What
 * KIND of thing, and WHOSE BOOK. Folding the second into the first would make
 * "This book" mutually exclusive with "Marks", which is not what either means.
 */

/* ⚠️ **TWO CHIPS ARE GONE FROM HERE**: `Companion`, which filtered on a mark
   kind that no longer exists, and `Dictionary`, which was not a mark kind at
   all — it swapped the panel's whole BODY for the lookup history. Both went
   with the AI features. */
type KindFilter = 'All' | 'Marks' | 'Notes' | 'Bookmarks'
const KINDS: readonly KindFilter[] = ['All', 'Marks', 'Notes', 'Bookmarks']

/** The scope chips. Only offered with a book open — see the render. */
type ScopeFilter = 'All books' | 'This book'
const SCOPES: readonly ScopeFilter[] = ['All books', 'This book']

/**
 * The chips are icons, and each one BORROWS AN ASSOCIATION THE APP HAS ALREADY
 * TAUGHT rather than inventing a glyph.
 *
 * LibraryBig is the Library's own rail icon, so a reader who has used that
 * panel already knows what it means here.
 * Bookmark is the ribbon the toggle draws on the page. Highlighter is this
 * panel's own rail icon, which is right for the kind of thing this panel is
 * mostly made of. PenLine is the note — §15's word for what you wrote on a
 * mark — and BookOpen is the one you have open. Asterisk is the wildcard, which
 * is the only one of the five that is a convention rather than a recall.
 *
 * Typed as a total Record, so adding a filter without an icon fails to compile
 * instead of drawing an empty button — see `FilterChipsProps.icons`.
 */
const KIND_ICONS: Readonly<Record<KindFilter, typeof Asterisk>> = {
  All: Asterisk,
  Marks: Highlighter,
  Notes: PenLine,
  Bookmarks: BookmarkIcon,
}

const SCOPE_ICONS: Readonly<Record<ScopeFilter, typeof Asterisk>> = {
  'All books': LibraryBig,
  'This book': BookOpen,
}

function matches(mark: Mark, filter: KindFilter): boolean {
  /* EVERY CHIP WRITTEN OUT, never a default, so the day `KindFilter` grows
     again this switch fails to compile instead of quietly filing marks under
     the wrong chip. */
  switch (filter) {
    case 'All':
      return true
    /* A BOOKMARK HAS NO NOTE and never will — `bookmarkFrom` writes an empty
     * one and says why — so it cannot appear under Notes by accident. Stated
     * rather than relied on: the filters are read by someone deciding what a
     * chip means, and "notes" meaning "anything with writing on it" is the
     * whole rule. */
    case 'Notes':
      return isAnnotation(mark) && hasNote(mark)
    case 'Marks':
      return mark.kind === 'highlight'
    case 'Bookmarks':
      return isBookmark(mark)
  }
}

/** A row's words for a note whose newest write was refused — see `MarksView.unsaved`. */
function unsavedLabel(draft: string | undefined): string | null {
  if (draft === undefined) return null
  return draft.trim() === '' ? 'Not saved — the note was cleared' : `Not saved — ${draft.trim()}`
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
  /**
   * Hand the note over, and say whether it landed — see `MarksView.setNote`.
   *
   * A promise rather than a void call, because this editor is the one holder of
   * the text and a refused write is only recoverable while it still has it.
   * `void` is accepted for a host that cannot answer; nothing written that way
   * can be retried, which is the honest reading of an answer nobody gave.
   */
  onCommit: (value: string) => void | Promise<void>
  onDone: () => void
  /**
   * The text of a write the store REFUSED, to start from instead of the note —
   * see `MarksView.unsaved`. Absent for an ordinary open.
   */
  unsaved?: string | undefined
}

function NoteEditor({ initial, unsaved, onCommit, onDone }: NoteEditorProps) {
  /**
   * The latest text, tracked as it is typed.
   *
   * Read from here rather than from the element, because by the time the
   * unmount cleanup runs React has already detached the ref — `field.current`
   * is null and the save silently keeps nothing, which is the exact failure
   * this editor exists to prevent, moved one step later. The element is still
   * needed for the initial value, for blur, and for taking a newer note; it is
   * just not the source of truth at teardown.
   */
  const draft = useRef(unsaved ?? initial)
  /**
   * What is already stored, so an unchanged note is not written again.
   *
   * TRIMMED, because what it is compared against is. `save` trims the draft and
   * then tested it against the untrimmed stored value, so a note that happens
   * to be stored with a leading space differed from itself: opening it and
   * closing it again rewrote it — a new HLC stamp, a write, and a row that
   * looks edited to every replica, for a note nobody touched.
   *
   * WHAT THE STORE HOLDS, which is not always what the editor opened with — see
   * the effect below.
   *
   * ⚠️ **NULL — UNKNOWN — WHEN IT OPENS ON A REFUSED DRAFT** (2026-09-14, #131,
   * round 4). The row's note is not what the store holds then: for the open
   * book the store draws a note before its write lands and does not take it
   * back, so the row already reads as the refused text, and an editor that took
   * that for stored found the draft "unchanged" and never wrote it again.
   * Unknown equals nothing, so the first save writes whatever the field holds,
   * and that write landing is what makes it known.
   *
   * THE EFFECT BELOW IS WHAT MAKES IT NULL, at mount as well as after. It runs
   * before anything reads `stored`, so deciding it here too was a second copy
   * of one rule — and a condition whose two answers nothing could tell apart.
   */
  const stored = useRef<string | null>(initial.trim())
  /* ⚠️ **AND WHEN A WRITE IS REFUSED AFTER THE EDITOR OPENED** (2026-09-14
     verify). `stored` was decided only at mount, so an editor reopened while its
     write was still out took the note the store drew — before that write had
     landed — for what the store held, and the refusal that arrived afterwards
     never reset it: saves found the draft unchanged and a blur closed the editor
     over a note that was not saved. A refused draft makes the store's copy
     unknown again — on the editor's first render as on any later one. */
  useEffect(() => {
    if (unsaved !== undefined) stored.current = null
  }, [unsaved])
  /** The values handed over and not yet seen coming back, oldest first. */
  // Stryker disable next-line ArrayDeclaration: a seeded entry is found only by an arriving note that reads exactly the mutator's own sentinel.
  const submitted = useRef<string[]>([])
  /**
   * The value whose write is in flight, or null.
   *
   * ⚠️ **`stored` USED TO MOVE THE MOMENT THE NOTE WAS HANDED OVER**, so a
   * write that failed looked exactly like one that landed: every later save
   * found the draft "unchanged" and wrote nothing, and closing the editor took
   * the draft with it (#131). `stored` now means WHAT THE STORE HAS, and this
   * means what it has been asked for — which is the other half of the fix,
   * because without it the one-second timer would hand the same text over on
   * every tick until the write came back.
   */
  const writing = useRef<string | null>(null)
  const field = useRef<HTMLTextAreaElement | null>(null)
  const commit = useRef(onCommit)
  commit.current = onCommit
  const done = useRef(onDone)
  done.current = onDone

  /**
   * Blurred, and waiting for the store to have the draft before closing.
   *
   * ⚠️ **A BLUR CLOSED THE EDITOR AT ONCE, AND THE RETRY LIVES IN HERE**
   * (2026-09-14, #131). Keeping the draft until a write landed fixed a refusal
   * that arrived while the editor was open; one arriving a moment AFTER the
   * reader clicked away found the editor gone and nothing left to retry with,
   * so the text went with it. A blur now closes only a note the store already
   * has. Otherwise the field stays on screen, unfocused, holding the draft —
   * the timer and every other save go on retrying it — and closes when a write
   * lands. Focusing it again cancels the close.
   *
   * THE SMALLER OF TWO FIXES, AND NOT ENOUGH ALONE. The other kept the refused
   * text outside the editor and had the row offer it again. This said an
   * unmount that is not a blur "still takes the draft, exactly as before" — and
   * closing the pane while a write was out did exactly that, once the write was
   * refused (2026-09-14, #131, round 4). Both exist now: this keeps a blurred
   * editor on screen, and `MarksView.unsaved` keeps what a refused write carried
   * once no editor is left to — only the newest write's answer counts there, so
   * the two copies cannot disagree about which text is the reader's.
   */
  const leaving = useRef(false)
  const leaveIfLanded = useCallback(() => {
    if (!leaving.current || writing.current !== null || draft.current.trim() !== stored.current) return
    // Stryker disable next-line BooleanLiteral: `onDone` unmounts this editor, and the unmount resets `leaving` before its own save — nothing reads it in between.
    leaving.current = false
    done.current()
  },
  // Stryker disable next-line ArrayDeclaration: any constant list keeps this callback stable, which is all the list is for.
  [])

  const save = useCallback(() => {
    const value = draft.current.trim()
    /* ⚠️ **AGAINST WHAT THE STORE WILL HOLD, NOT WHAT IT LAST CONFIRMED.** This
       skipped a draft equal to `stored` even while a newer write was out, so A
       saved → B handed over → A typed back → closed → B landed, and the disk
       kept B (2026-09-14 verify). While a write is out, it is the one the store
       will end up holding. */
    if (value === (writing.current ?? stored.current)) return
    writing.current = value
    submitted.current.push(value)
    const landed = () => {
      /* ONLY WHAT THIS WRITE CARRIED. A newer save may have started while
         this one was in flight, and it owns the marker after this. */
      if (writing.current === value) writing.current = null
      stored.current = value
      leaveIfLanded()
    }
    const answer = commit.current(value)
    /* A HOST THAT ANSWERS NOTHING has landed it, and NOW — there is nothing to
       retry with an answer nobody gave, and nothing to hold a blurred editor
       open for. This was a `Promise.resolve` over both, which made even a
       silent host's close wait a turn. */
    if (answer === undefined) {
      landed()
      return
    }
    void Promise.resolve(answer).then(
      landed,
      () => {
        /* REFUSED, so the store does not have it and the draft is still the
           only copy. `stored` is left where it was, which is what makes the
           next tick, blur or unmount try again. The failure is reported by
           `useMarks` and shown by the panel's own not-saving line. */
        if (writing.current === value) writing.current = null
      },
    )
  },
  // Stryker disable next-line ArrayDeclaration: `leaveIfLanded` never changes, so listing it or not keeps `save` the same callback.
  [leaveIfLanded])

  /**
   * A newer note, arriving while the editor is open — from sync, or from
   * another window.
   *
   * ⚠️ **IT WAS IGNORED, AND THE NEXT KEYSTROKE WROTE OVER IT.** `initial` was
   * read once, as the field's default, so the old text stayed on screen and
   * whatever the reader typed onto it was saved over the newer note (2026-09-13
   * audit, #127).
   *
   * THE EDITOR'S OWN SAVES COME BACK THROUGH HERE TOO, and are not news. A mark
   * in another book is republished only once its file is written, so a save can
   * come back after a later one was made — taken for somebody else's note, it
   * would put the earlier text back under the reader's cursor. Writes land in
   * order, so seeing one come back means every save before it has landed too.
   *
   * UNTOUCHED, the field takes the newer note. MID-SENTENCE, the reader's words
   * stay — a keystroke is never thrown away for a note they have not seen — and
   * `stored` still learns what the store holds, so what the field shows is saved
   * over it rather than left on screen unsaved.
   */
  /** A newer note that arrived mid-sentence, offered beside the field — or null. */
  const [newer, setNewer] = useState<string | null>(null)
  useEffect(() => {
    const incoming = initial.trim()
    const own = submitted.current.indexOf(incoming)
    if (own !== -1) {
      submitted.current.splice(0, own + 1)
      return
    }
    if (incoming === stored.current) return
    /* UNKNOWN IS NOT UNTOUCHED — see `stored` — and it stays unknown: a refused
       draft is kept over an arriving note and written over it, as words typed
       mid-sentence are. On the mount this runs at, the note IS the row's, which
       is exactly what must not be learned as stored. */
    if (stored.current === null) return
    const untouched = draft.current.trim() === stored.current
    stored.current = incoming
    /* ⚠️ **AND IT IS SAID, NOT ONLY KEPT** (decided 2026-09-14, #127). The
       reader's words stayed and were saved over the newer note in silence, so a
       note written on another device was replaced without its reader ever
       learning it existed. Keeping the draft stays the default; the newer
       version is offered beside the field, one press away. */
    if (!untouched) {
      setNewer(initial)
      return
    }
    draft.current = initial
    /* ASSERTED, not tested: the field renders unconditionally beside this
       effect, so a guard here decided nothing any render could show. */
    field.current!.value = initial
  }, [initial])

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
  // Stryker disable next-line ArrayDeclaration: `save` never changes, so the registration is made once either way.
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
  },
  // Stryker disable next-line ArrayDeclaration: `save` never changes, so the timer is started once either way.
  [save])

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
      /* GONE, so a write landing later closes nothing — `onDone` would close
         whichever editor the panel has opened since. */
      leaving.current = false
      save()
    }
  },
  // Stryker disable next-line ArrayDeclaration: `save` never changes, so the listeners are added once either way.
  [save])

  return (
    <>
      <textarea
        ref={field}
        className={styles.noteInput}
        defaultValue={unsaved ?? initial}
        autoFocus
        /* The store cuts a note at this length on every read; the field stops
           the reader there so nothing typed is lost to the cut. */
        maxLength={MAX_MARK_NOTE}
        placeholder="Write a note"
        onChange={(event) => {
          draft.current = event.target.value
        }}
        onFocus={() => {
          leaving.current = false
        }}
        onBlur={() => {
          leaving.current = true
          save()
          leaveIfLanded()
        }}
      />
      {newer !== null && (
        <div className={styles.panelMeta}>
          <span>A newer version of this note arrived while you were typing.</span>{' '}
          <button
            type="button"
            className={styles.noteJump}
            /* KEEPS THE FOCUS IN THE FIELD. A press that took it would blur the
               editor first, and the blur saves the draft — over the very version
               this button is about to put back. */
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              draft.current = newer
              /* The field is drawn beside this button, always — see above. */
              field.current!.value = newer
              setNewer(null)
            }}
          >
            Use that version
          </button>
        </div>
      )}
    </>
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
 * The control that takes a row to its place — a mark row's and a place row's.
 *
 * ONE CONTROL, WHERE THERE WERE TWO COPIES (#133), and the copies had already
 * come apart once. ⚠️ A place row can be unplaced too — an imported bookmark is
 * an unplaced mark of the bookmark class — and that row was disabled with NO
 * explanation at all, so the reader saw the book open in front of them and a
 * control that silently did nothing. MEASURED: `title` and `aria-description`
 * both null on the bookmark row of a name-matched import, while the annotation
 * beside it explained itself.
 *
 * The rule and the reason are shared; what each row shows inside the control
 * is its own — the passage on a mark row, the chapter and its line on a place.
 */
function JumpButton({
  mark,
  reachable,
  onGoTo,
  children,
}: {
  readonly mark: Mark
  /** `Marginalia`'s `reachable`, computed once by the panel and handed down. */
  readonly reachable: boolean
  readonly onGoTo?: ((target: JumpTarget) => void) | undefined
  readonly children: ReactNode
}) {
  return (
    <button
      type="button"
      className={styles.noteJump}
      /* A control that silently does nothing is worse than none: disabled where
         there is nowhere to go, or no way of going. */
      disabled={!reachable || !onGoTo}
      /* SAYS WHY, when the reason is not the obvious one. A row for a book that
         has left the shelf explains itself — the book is gone. An unplaced
         mark's book is right there and open, so a control that does nothing
         looks like a defect unless it says otherwise. */
      {...(mark.unplaced ? { title: UNPLACED_TITLE, 'aria-description': UNPLACED_TITLE } : {})}
      /* Stryker disable next-line OptionalChaining: without `onGoTo` the button is disabled, and a disabled button is never clicked. */
      onClick={() => onGoTo?.({ bookId: mark.bookId, cfi: mark.cfi })}
    >
      {children}
    </button>
  )
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
  /* Optional for the panel's reason: a session with only `mark:read` draws no
     bin here either. See `MarginaliaProps.onDeleteBookmark`. */
  onDelete?: ((bookmark: Bookmark) => void) | undefined
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
      {/* THE SAME RULE THE MARK ROW FOLLOWS, computed once by the panel and
          handed down — see `reachable` there. It used to be "only the open
          book"; it is now "a book still on the shelf", and a place in a book
          Paper no longer holds is the case that stays disabled. */}
      <JumpButton mark={bookmark} reachable={reachable} onGoTo={onGoTo}>
        <span className={styles.placeChapter}>{chapter}</span>
        {line && <span className={`${styles.noteBody} ${styles.placeLine}`}>{line}</span>}
      </JumpButton>
      <div className={styles.noteSource}>
        <span>{relativeTime(bookmark.createdAt, now)}</span>
        {onDelete && (
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
        )}
      </div>
    </>
  )
}

export interface MarginaliaProps {
  /**
   * What browsing marks needs — six members, not all of `MarksView`.
   *
   * NARROWED for the same reason `SearchPanel`'s `book` was: this pane reads
   * `all`, `allBookmarks`, `allUnplaced`, `persistent`, `loadAll` and `setNote`, and declaring
   * the other nine made it mountable only by a host that owns a `MarkStorage`.
   * The browser client has a channel and `mark.list`, which is enough for these
   * and not for the fourteen.
   *
   * ⚠️ `remove` WAS IN THIS LIST AND IS NOT CALLED ANYWHERE IN THIS FILE. The
   * panel deletes through `onDelete`, deliberately — the note beside that prop
   * explains why calling `marks.remove` straight left the highlight drawn on
   * the page. So the member was a requirement on every host with no behaviour
   * behind it, which is exactly the coupling the narrowing was for.
   *
   * Indexed access into `MarksView` rather than restated, so the two cannot
   * drift, and every existing caller passes a whole `MarksView` and still
   * type-checks — a narrower prop accepts a wider argument.
   */
  marks: {
    readonly all: MarksView['all']
    readonly allBookmarks: MarksView['allBookmarks']
    /** The unplaced ones (WI-21.7) — this pane is the only surface that shows
     *  them, so leaving them off this list would make them invisible while
     *  still stored, exported and synced. */
    readonly allUnplaced: MarksView['allUnplaced']
    readonly persistent: MarksView['persistent']
    /**
     * Optional, because the browser client's store is fed over the wire and
     * has no file to fail to read — absent is "nothing to say", not "read
     * fine". The desktop's `MarksView` always answers.
     */
    readonly unreadable?: MarksView['unreadable']
    /** Whether the cross-book scan is still running — optional for the same
     *  reason `unreadable` is: the browser client's wire-fed store has no
     *  scan, and never reports one. */
    readonly scanning?: MarksView['scanning']
    /** Optional for the same reason as `scanning`. */
    readonly scanFailed?: MarksView['scanFailed']
    /**
     * ⚠️ OPTIONAL, AND ABSENT MEANS THE NOTE IS READ-ONLY.
     *
     * `setNote` reaches `mark.set`, which the table gates on `mark:write`. The
     * browser client holds one grant and it is a READ one, so the call is
     * refused every time — and the host that serves a browser explains at
     * length why widening that is a decision and not a line to delete.
     *
     * Requiring it here meant the browser had to pass one, so every row offered
     * "Add a note", accepted the typing, and threw it away on commit. The
     * reader loses the note they just wrote and is told nothing. Not drawing
     * the editor is the accurate rendering of a session that may read marks.
     *
     * THE PARAMETERS ARE `MarksView`'S AND THE ANSWER IS WIDER. The desktop
     * hands back whether the note landed, and the editor retries one that did
     * not (#131); the browser client's wire-fed store answers nothing, and
     * nothing is what the editor then has to retry with. A prop that demanded
     * the promise would have turned that host away for a capability it cannot
     * offer yet, rather than taking what it has.
     */
    readonly setNote?: ((...args: Parameters<MarksView['setNote']>) => void | Promise<void>) | undefined
    /** Notes whose newest write was refused — see `MarksView.unsaved`. Optional
     *  for the same reason `setNote` answers nothing there: the browser client's
     *  wire-fed store has no refusal to hold. */
    readonly unsaved?: MarksView['unsaved']
    /* Called on mount. On the desktop this is one read PER BOOK, which is why
     * the pane pays for it only when opened; over a channel `mark.list` with no
     * book is a single call, so a browser host's `loadAll` is cheap. */
    readonly loadAll: MarksView['loadAll']
  }
  /**
   * Where a mark becomes a made thing — §15's line between note and card.
   *
   * OPTIONAL, AND ABSENT MEANS THE CONTROL IS NOT DRAWN. `make` is synchronous
   * and hands a `Card` straight back; a host whose cards live behind a channel
   * cannot answer that shape, and a stub returning a fabricated card would put
   * a made thing on screen that the shelf never received.
   */
  /* `make`, and whether what it writes is kept — the whole `CardsView` coupled
   * it to card state and verbs it never reads.
   *
   * ⚠️ `persistent` WAS NARROWED AWAY WITH THEM, and it is not state this panel
   * never reads: `make` lets its write go and reports a refusal only through
   * that flag, and the Cards panel that draws it is not offered to a reader. So
   * a card made here that was never saved was said nowhere (#132). */
  cards?: Pick<CardsView, 'make' | 'persistent'> | undefined
  /** The open book, so its marks can be shown first. Null when none is open. */
  bookId: string | null
  /**
   * Removes a mark from the STORE and from the page.
   *
   * Deleting used to call `marks.remove` straight, which leaves the drawn
   * annotation and its cached Range exactly where they were: the note vanished
   * from this list while its highlight stayed on the text, and the margin went
   * on showing it, until something else happened to force a redraw.
   *
   * OPTIONAL for the reason `marks.setNote` is: deletion is `mark:write`, which
   * a browser session never holds. Absent, no delete control is drawn on either
   * a mark or a bookmark — the two travel together because a panel that can
   * delete one and not the other is a distinction no reader could explain.
   */
  onDelete?: ((mark: Annotation) => void) | undefined
  /** Takes a bookmark off, from any book — routed by id through the store. */
  onDeleteBookmark?: ((bookmark: Bookmark) => void) | undefined
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
   * Called ONCE per request, when `focus` has been acted on, with its nonce.
   *
   * The owner clears the request on hearing this — see `Marking.clearFocus`.
   * Without it the request outlives its answer: it stays in the owner's state
   * for the session, and a remount of this panel (Contents and back) finds it
   * again and honours it again. Optional because a host that never sends a
   * request — the browser client — has nothing to clear.
   */
  onFocusDone?: ((nonce: number) => void) | undefined
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
  /**
   * The controls the composed capabilities draw on a mark — the circle's
   * share control is the first (`MarkControl`).
   *
   * DRAWN ON ANNOTATION ROWS ONLY. A bookmark is a place, not a passage, and
   * there is nothing of one to hand to a capability. Optional, and absent
   * draws nothing: the browser client mounts this panel with no composition
   * at all.
   */
  markControls?: readonly MarkControl[] | undefined
}

export function Marginalia({
  marks,
  cards,
  bookId,
  onDelete,
  onDeleteBookmark,
  platform,
  focus,
  onFocusDone,
  onGoTo,
  onShelf,
  now: injectedNow,
  titleOf,
  markControls,
}: MarginaliaProps) {
  const [kind, setFilter] = useState<KindFilter>('All')
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
   *
   * ⚠️ **AND AN UNPLACED MARK IS NOT REACHABLE EITHER, WHATEVER BOOK IT IS ON**
   * (WI-21.7). It has no CFI: the book is right there and open, and there is
   * still nowhere to go. Folded into this one rule rather than checked at the
   * jump — the note above says "one rule, three rows" and this is the third
   * thing that can make a row unjumpable.
   */
  const reachable = useCallback(
    (mark: Mark) => isPlaced(mark) && (mark.bookId === bookId || (onShelf?.(mark.bookId) ?? false)),
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

  /**
   * Everything this panel browses: all THREE classes, from every book.
   *
   * ⚠️ **THE UNPLACED ONES BELONG HERE AND NOWHERE ELSE** (WI-21.7). A mark
   * imported from another build of a book has no anchor in this library, so
   * nothing paints it — but it is still the reader's own words and their own
   * note, and this panel is the one surface whose job is showing them. Left out
   * of this list, an imported mark would be stored, exported, synced and
   * invisible.
   */
  const everything = useMemo(
    () => [...marks.all, ...marks.allUnplaced, ...marks.allBookmarks],
    [marks.all, marks.allUnplaced, marks.allBookmarks],
  )

  /**
   * The note this panel last wrote on a mark, until the list catches up with it.
   *
   * ⚠️ **A CARD MADE STRAIGHT AFTER A NOTE CARRIED THE NOTE BEFORE IT** (#128).
   * The pointer going down on "Make a card" blurs the editor, which saves — but
   * a mark in another book is republished only once its file is written, so the
   * click that follows read the row's old note. A card takes what was written
   * here for as long as the row still shows a note `behind` it: the one it was
   * written over, or one of this panel's own earlier saves on its way back.
   * Once the row shows anything else — the note itself, or one written
   * elsewhere since — the row is the answer, and the entry goes.
   */
  const written = useRef(new Map<string, { readonly note: string; readonly behind: ReadonlySet<string> }>())
  /* THE WRITE IS HANDED BACK to the editor, which is holding the only copy of
     the text until it lands — see `NoteEditor.onCommit` and `MarksView.setNote`
     (#131). `void` for a session that cannot write, which is the same session
     that draws no editor at all. */
  const writeNote = (mark: Annotation, note: string): void | Promise<void> => {
    const shows = mark.note.trim()
    const was = written.current.get(mark.id)
    const behind = was !== undefined && was.behind.has(shows) ? [...was.behind, was.note] : [shows]
    written.current.set(mark.id, { note, behind: new Set(behind) })
    // Stryker disable next-line OptionalChaining: the only caller is the note editor, which is drawn only when `setNote` is present.
    return marks.setNote?.(mark, note)
  }
  const noteAsWritten = (mark: Annotation): Annotation => {
    const kept = written.current.get(mark.id)
    return kept !== undefined && kept.behind.has(mark.note.trim()) ? { ...mark, note: kept.note } : mark
  }
  useEffect(() => {
    for (const [id, kept] of written.current) {
      const mark = everything.find((one) => one.id === id)
      if (mark === undefined || !kept.behind.has(mark.note.trim())) written.current.delete(id)
    }
  }, [everything])

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
    const kept = inScope.filter((mark) => matches(mark, kind))
    const byBook = new Map<string, Mark[]>()
    for (const mark of kept) {
      const group = byBook.get(mark.bookId)
      if (group) group.push(mark)
      else byBook.set(mark.bookId, [mark])
    }
    /* A PARTITION, NOT A SORT: the open book's group, then the rest in the
       order they were met. This was a comparator, and its second half — "after"
       when the open book is on the right — was one the sort never needed: a
       sort asks only whether the left side goes first, so returning 1 or 0
       there ordered every list alike (measured over lists of 1 to 300 books). */
    const groups = [...byBook.entries()]
    const books = [...groups.filter(([id]) => id === bookId), ...groups.filter(([id]) => id !== bookId)]
    // Each group is an array built here, so sorting it mutates nothing shared.
    return books.flatMap(([, group]) => group.sort(compareMarks))
  }, [inScope, kind, bookId])

  /* Reveal whatever was asked for — ONCE per request.
   *
   * The filter is cleared first when it would hide the mark: asking to see a
   * highlight while the list is filtered to Notes would otherwise scroll to a
   * row that is not rendered, which looks exactly like the click doing
   * nothing. Keyed on the nonce, so asking twice for the same mark works
   * twice.
   *
   * ⚠️ HONOURED ONCE, AND THAT IS THE WHOLE DEFECT THIS USED TO HAVE. The
   * effect depends on `everything`, and `everything` republishes after every
   * write — the note's own save included — so a request that was merely
   * DELIVERED was acted on again on every one of them: the editor the reader
   * had just closed re-opened, and a mark made anywhere afterwards re-opened
   * it once more and pulled keyboard focus out of the book. "The first blur
   * doesn't stick" was how it read. `honoured` remembers the nonce this panel
   * has already answered; the owner is told so it can clear the request,
   * which is what stops a remount finding it again.
   *
   * `everything` STAYS A DEPENDENCY, deliberately: `marks.all` is empty until
   * `loadAll` has run, and the panel mounts on the very click that asks for
   * the mark — so on a first open the request arrives BEFORE the row it names
   * and has to wait for the list. Reading the list through a ref would drop
   * exactly that case. A request honoured once is not a request that may only
   * be looked at once. */
  const honoured = useRef(0)
  const frame = useRef(0)
  /** The row the last request revealed — tinted, so the reader can find it. */
  const [revealed, setRevealed] = useState<string | null>(null)
  useEffect(() => {
    if (!focus || focus.nonce === honoured.current) return
    const target = everything.find((mark) => mark.id === focus.id)
    if (!target) return
    honoured.current = focus.nonce
    setRevealed(focus.id)
    if (!matches(target, kind)) setFilter('All')
    /* AND THE SCOPE, on the same reasoning as the kind filter: a request for
       a mark in ANOTHER book, arriving while the panel was scoped to this
       one, was marked honoured with its row hidden — a click that did
       nothing, again. Not asked whether the scope IS narrowed: widening All
       books to All books changes nothing, so that question decided nothing. */
    if (bookId && target.bookId !== bookId) setScope('All books')
    if (focus.edit) setEditing(focus.id)
    /* After paint, so the row exists to scroll to when the filter just
       changed. Not cancelled when the deps change — a later republish would
       otherwise cancel the scroll the request was for — only on unmount,
       below; a frame whose row has gone finds nothing and does nothing. */
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      rows.current.get(focus.id)?.scrollIntoView({ block: 'nearest' })
    })
    onFocusDone?.(focus.nonce)
    // `kind` is deliberately absent: this reacts to a focus request, not to
    // the reader changing the filter themselves afterwards.
  }, [focus, everything, onFocusDone, bookId])
  // Stryker disable next-line ArrowFunction,ArrayDeclaration,CallExpression: a frame left running past unmount finds its row already let go of and scrolls nothing — the cancel, and the effect that holds it, only spare the frame.
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

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
      notes: inScope.filter((mark) => isAnnotation(mark) && hasNote(mark)).length,
      places: inScope.filter(isBookmark).length,
    }),
    [inScope],
  )

  /* AN EDITOR WHOSE ROW LEFT THE LIST CLOSES. Filtered out, scoped out, or its
     book switched away, the row unmounts without a blur, and an id kept
     here would reopen the editor by itself the moment the row came back. */
  useEffect(() => {
    if (editing !== null && !inScope.some((mark) => mark.id === editing && matches(mark, kind))) setEditing(null)
  }, [editing, inScope, kind])

  /* NOTHING AT ALL. */
  if (everything.length === 0) {
    /* NOT YET AN ANSWER. The cross-book scan costs a read per book and the
       panel mounts before it lands, so "Nothing kept yet" stood over a
       library that had not finished being read — a false empty state for as
       long as the scan took, which on a large shelf is long enough to believe. */
    if (marks.scanning) {
      return (
        <div className={styles.empty}>
          <div className={styles.emptyBody}>{SCANNING_MARKS}</div>
        </div>
      )
    }
    /* A FAILED SCAN IS NOT AN EMPTY SHELF. The store used to install `[]`
       on a failed read and this branch said "Nothing kept yet" over marks
       that were there and could not be read — the same false sentence the
       unreadable case below guards against, one level up (audit #101/#477). */
    if (marks.scanFailed) {
      return (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>{SCAN_FAILED_MARKS}</div>
          <div className={styles.emptyBody}>{SCAN_FAILED_NEXT}</div>
        </div>
      )
    }
    return (
      <div className={styles.empty}>
        {/* A STORE THAT STOPPED SAVING IS SAID HERE TOO: a failed write that
            left nothing visible would otherwise read as an empty shelf. */}
        {!marks.persistent && <div className={styles.emptyBody}>{NOT_SAVING}</div>}
        {/* THE CASE THIS MATTERS MOST IN: a reader whose marks file is damaged
            reaches exactly this branch, and "Nothing kept yet" is the one
            sentence that must not stand over it (WI-20.36) — the file's
            contents are unknown, not absent. */}
        {marks.unreadable ? (
          <div className={styles.emptyTitle}>{UNREADABLE_MARKS}</div>
        ) : (
          <>
            <div className={styles.emptyTitle}>Nothing kept yet</div>
            <div className={styles.emptyBody}>
              Select a passage and choose Mark — notes you write on a mark appear
              beside the line they belong to. Press {comboFor('⌘B', platform)} to
              keep the place you are reading.
            </div>
          </>
        )}
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

      {!marks.persistent && (
        <div className={styles.panelMeta}>
          <span>{NOT_SAVING}</span>
        </div>
      )}

      {/* A different fact from the one above, and it used to be no fact at
          all (WI-20.36): a marks file that is there and will not read was
          installed as an empty list, so the reader whose marks had vanished
          from this list was shown a book with none. The file is being left
          alone, and this says so. */}
      {marks.unreadable && (
        <div className={styles.panelMeta}>
          <span>{UNREADABLE_MARKS}</span>
        </div>
      )}

      {/* THE SCAN, SAID ABOVE WHAT IS LISTED AS WELL AS OVER NOTHING (#129,
          #130). Kept to the nothing-at-all branch, a running scan let a partial
          list pass for the whole of it. Running wins over failed, as it does in
          that branch: a scan under way is the newer answer. */}
      {marks.scanning && (
        <div className={styles.panelMeta}>
          <span>{SCANNING_MARKS}</span>
        </div>
      )}
      {marks.scanFailed && !marks.scanning && (
        <div className={styles.panelMeta}>
          <span>
            {SCAN_FAILED_MARKS}. {SCAN_FAILED_NEXT}
          </span>
        </div>
      )}

      {/* HERE, because this is where cards are made, above the rows that make
          them (#122, #132). */}
      {cards !== undefined && !cards.persistent && (
        <div className={styles.panelMeta}>
          <span>{NOT_SAVING_CARDS}</span>
        </div>
      )}

      {/* BOTH AXES ON ONE LINE, with a rule between them.
          As words the chips wrapped to three lines of chrome above the list at
          the pane's 400px. As icons they are one, and the rule is what keeps
          them legible as two questions rather than one long row — a reader has
          to be able to see that picking "Notes" does not un-pick "This
          book". */}
      <div className={styles.filterBar}>
        <FilterChips
          options={KINDS}
          active={kind}
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

      {/* NOT WHILE THE LIST IS UNFINISHED OR UNREAD — the line above says which,
          and "No notes yet." under it would claim an answer nobody has yet
          (#129, #130). */}
      {shown.length === 0 && !marks.scanning && !marks.scanFailed && (
        <div className={styles.empty}>
          <div className={styles.emptyBody}>
            {/* Says which filter is empty, and which scope. A blank panel under
                two selected chips reads as the marks having been lost. */}
            No {kind === 'All' ? 'marginalia' : kind.toLowerCase()}
            {scope === 'This book' ? ' in this book' : ''} yet.
          </div>
        </div>
      )}

      {shown.map((mark) => (
        <div
          key={mark.id}
          /* A CLEANUP, NOT A NULL: a ref that returns one is handed the element
             and never `null` — React calls the cleanup when the row goes. Under
             `if (node)`, storing the null handed in on the way out read exactly
             like forgetting the row, so that test decided nothing. */
          ref={(node: HTMLDivElement) => {
            rows.current.set(mark.id, node)
            return () => {
              rows.current.delete(mark.id)
            }
          }}
          className={styles.note}
          data-kind={mark.kind}
          /* A bookmark carries no tint, and `.note::before` falls back to
             yellow for a row without one — so a place row would have grown a
             gold rule meaning nothing. `data-place` suppresses it. */
          data-place={isBookmark(mark) ? 'true' : undefined}
          data-tint={isBookmark(mark) ? undefined : mark.tint}
          data-focused={mark.id === revealed}
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
          {/* A control that silently does nothing is worse than none — the
              rule stands; its subject narrowed. It used to be "only the open
              book", because a mark from another book had nowhere to jump to.
              There is somewhere now: the host opens that book AT the mark and
              ⌘[ brings the reader home. What is still unreachable is a book
              that has left the shelf, and those rows are still disabled. */}
          <JumpButton mark={mark} reachable={reachable(mark)} onGoTo={onGoTo}>
            <span className={styles.noteBody}>{mark.text}</span>
          </JumpButton>

          {/* WITHOUT `setNote` THE NOTE IS TEXT, not a control. Offering the
              editor to a session that cannot write means the reader types a
              note, commits it, and watches it disappear — the refusal arrives
              after the editor has closed. A row with no note simply shows
              nothing, which is true: there is no note, and this reader cannot
              add one here. */}
          {marks.setNote === undefined ? (
            hasNote(mark) ? <div className={styles.noteComment}>{mark.note.trim()}</div> : null
          ) : editing === mark.id ? (
            <NoteEditor
              initial={mark.note}
              /* A REFUSED DRAFT IS WHERE IT STARTS — see `MarksView.unsaved`. */
              unsaved={marks.unsaved?.get(mark.id)}
              /* THE MARK, not its id — this list is cross-book, and a note
                 edited on another book's row was written to the open one. */
              onCommit={(value) => writeNote(mark, value)}
              onDone={() => setEditing(null)}
            />
          ) : (
            <button
              type="button"
              className={styles.noteComment}
              onClick={() => setEditing(mark.id)}
            >
              {/* A REFUSED DRAFT IS OFFERED, AND SAID TO BE ONE, ahead of the
                  row's note — which for the open book may already read the
                  same, drawn by the store before the write that failed. */}
              {unsavedLabel(marks.unsaved?.get(mark.id)) ?? (hasNote(mark) ? mark.note.trim() : 'Add a note')}
            </button>
          )}

          {/* A capability's control on THIS mark, under the note and above
              the source line — the circle's Share is the first. The element
              is the capability's own, narrowed by `renderContribution` the
              way a contributed pane is; the kernel supplies the mark and
              never learns what the control does. */}
          {markControls?.map((control) => (
            <div key={control.id} data-mark-control={control.id}>
              <ContributionBoundary label="A mark control" id={control.id} resetKey={control.id}>
                <ContributionBody id={control.id} render={() => control.render(mark)} context={controlContext(bookId)} />
              </ContributionBoundary>
            </div>
          ))}

          <div className={styles.noteSource}>
            <span>{mark.chapter || 'Unknown chapter'}</span>
            <span className={styles.rowActions}>
              {/* Notes stay raw; cards are made. This is the only place the
                  one becomes the other, which is what keeps the distinction
                  §15 draws visible rather than nominal. */}
              {cards !== undefined && (
                <button
                  type="button"
                  className={styles.noteDelete}
                  aria-label="Make a card"
                  title="Make a card"
                  /* THE NOTE AS WRITTEN HERE, not as the row last heard it — see `written` (#128). */
                  onClick={() => cards.make(cardFromMark(noteAsWritten(mark)))}
                >
                  <Layers size={ICON.inline} strokeWidth={ICON.stroke} />
                </button>
              )}
              {/* Not drawn without `onDelete` — see the prop. A disabled bin
                  would claim the mark is deletable and merely not now. */}
              {onDelete && (
                <button
                  type="button"
                  className={styles.noteDelete}
                  aria-label="Delete mark"
                  title="Delete mark"
                  onClick={() => onDelete(mark)}
                >
                  <Trash2 size={ICON.inline} strokeWidth={ICON.stroke} />
                </button>
              )}
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
