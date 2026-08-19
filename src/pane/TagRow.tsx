import { useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { Ban, CopyPlus, Hash, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { hasBookDrag, readBookDrag } from '../lib/bookDrag'
import { TAG_MAX } from '../lib/library'
import { ICON } from '../lib/metrics'
import { useRowMenu } from '../lib/useRowMenu'
import controls from '../styles/controls.module.css'
import styles from './SidePane.module.css'

/**
 * One tag in the Library panel: a scope, a drop target, and — behind the row's
 * menu — the things that can be done to it.
 *
 * THE ROW IS BOTH THE FILTER AND THE MANAGER. Zotero, Calibre, Finder and Bear
 * all converge on this: the sidebar item you click to narrow is the item you
 * right-click to rename, and there is no separate management screen to find.
 * So the row's menu carries the management, and what is in the menu depends on
 * whose tag it is — VISIBLE BEFORE YOU TRY, not discovered by a failed click.
 * A reader's tag can be renamed and removed; a publisher's subject cannot — it
 * is a fact about the book and comes back on re-parse — but it can be ADOPTED,
 * which writes it as the reader's own on every book that declares it and makes
 * it theirs from then on. Either can be excluded.
 *
 * Three states, on one control: off, ON (`tag:X`), and EXCLUDED (`-tag:X`).
 * A click toggles ON; ⌥-click toggles EXCLUDED; the menu says the same in
 * words for a reader who does not know the key. Excluded is drawn struck
 * through, because that is what it means.
 *
 * A DROP TARGET. Books dragged from the shelf and let go on this row are
 * tagged with it — the gesture Finder, Bear and Calibre readers reach for
 * first. The row lights as the drag crosses it. Onto a subject row the same
 * thing happens, and those books then carry the reader's own copy of the name.
 *
 * The menu is the shelf's — the same `⋯` and the same two-click remove a book
 * card has — so a reader who learned it there recognises it here. Rename is
 * inline: the label becomes a field, prefilled, and it commits on Enter or
 * blur and cancels on Escape. Blur COMMITS, per the rule the Notes editor
 * established: a typed thing must not vanish because focus moved. Renaming
 * onto a name that exists MERGES — one verb, guessable outcome, and the
 * survivor's count says it happened.
 *
 * Remove says how many books it will touch, in the row, and asks for a second
 * click. The number is the consent — the reader is told the blast radius
 * before they mean it.
 */
export type TagRowState = 'off' | 'on' | 'excluded'

export interface TagRowProps {
  readonly tag: string
  /** Shown beside the row: books carrying the tag within the current view. */
  readonly count: number
  /** How many books a remove will actually touch — the confirm's number. */
  readonly removes: number
  /** Whether any book carries this as the reader's own tag — see `tagCounts`. */
  readonly mine: boolean
  readonly state: TagRowState
  readonly onToggle: () => void
  readonly onToggleExclude: () => void
  readonly onRename: (to: string) => void
  readonly onRemove: () => void
  readonly onAdopt: () => void
  /** Books dropped on the row, by id — the shelf's selection or one card. */
  readonly onDropBooks: (bookIds: readonly string[]) => void
  /** Which tag has its menu open, so only one is open across the panel. */
  readonly menuFor: string | null
  readonly setMenuFor: (tag: string | null) => void
}

export function TagRow({
  tag,
  count,
  removes,
  mine,
  state,
  onToggle,
  onToggleExclude,
  onRename,
  onRemove,
  onAdopt,
  onDropBooks,
  menuFor,
  setMenuFor,
}: TagRowProps) {
  const menuOpen = menuFor === tag
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(tag)
  const [confirming, setConfirming] = useState(false)
  const [over, setOver] = useState(false)
  const rowRef = useRef<HTMLDivElement | null>(null)
  /* One close path — see `useRowMenu`, which `BookCell` uses for the same
   * reasons: every way out clears both the menu and the armed remove, the
   * hook clears them if the row unmounts while open, and a detached menu
   * closes rather than parking off screen. */
  const { moreRef, menuRef, menuStyle, close: closeMenu } = useRowMenu(
    menuOpen,
    rowRef,
    () => {
      setMenuFor(null)
      setConfirming(false)
    },
    // A real menu: focus and arrow keys — see `useRowMenu`.
    { side: 'bottom', align: 'end', menu: true },
  )

  /* A blank commit is a cancel, not a rename to nothing — the field goes back
   * to the tag's name and closes, and nothing is written. Anything else is
   * handed up, and the caller normalises it by the same rule the store uses. */
  const commitRename = () => {
    setRenaming(false)
    const next = draft.trim()
    if (!next) {
      setDraft(tag)
      return
    }
    if (next !== tag) onRename(next)
  }

  const onClick = (event: MouseEvent) => {
    if (event.altKey) onToggleExclude()
    else onToggle()
  }

  /* The drop. `dragover` has to be prevented for `drop` to fire at all; the
   * window's handler does that for the whole app, but the row does it too so
   * it does not depend on a listener elsewhere for its own gesture. Only a
   * drag carrying BOOKS lights the row — a file from the Finder crossing the
   * pane is an import, and it has its own response. */
  const onDragOver = (event: DragEvent) => {
    if (!hasBookDrag(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    if (!over) setOver(true)
  }
  /* Leaving for a DESCENDANT is not leaving. `dragleave` fires on every move
   * between the row's own children, and clearing the highlight each time made
   * it flicker while the drag was still squarely over the target.
   * `relatedTarget` is where the pointer went; inside the row, nothing
   * changed. */
  const onDragLeave = (event: DragEvent) => {
    if (event.relatedTarget instanceof Node && rowRef.current?.contains(event.relatedTarget)) return
    setOver(false)
  }
  const onDrop = (event: DragEvent) => {
    const ids = readBookDrag(event.dataTransfer)
    setOver(false)
    if (!ids) return
    event.preventDefault()
    onDropBooks(ids)
  }

  const excluded = state === 'excluded'

  return (
    <div
      className={styles.tagRow}
      ref={rowRef}
      data-over={over}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {renaming ? (
        <form
          className={styles.tagRename}
          onSubmit={(event) => {
            event.preventDefault()
            commitRename()
          }}
        >
          <Hash size={ICON.control} strokeWidth={ICON.stroke} />
          <input
            className={styles.tagRenameInput}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={`Rename the tag ${tag}`}
            /* The store cuts a tag at `TAG_MAX`; the field says so up front
               rather than letting the reader type past what will be kept. */
            maxLength={TAG_MAX}
            autoFocus
            onFocus={(event) => event.target.select()}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setDraft(tag)
                setRenaming(false)
              }
            }}
          />
        </form>
      ) : (
        <button
          type="button"
          className={styles.scopeRow}
          data-on={state === 'on'}
          data-excluded={excluded}
          aria-pressed={state === 'on'}
          /* THE THIRD STATE, said in words. `aria-pressed` is a two-state
             vocabulary and reads false for both `off` and `excluded` — the
             strike-through says which, and a screen reader cannot see a
             strike-through. The label carries it instead. */
          aria-label={excluded ? `${tag}, excluded from the shelf` : undefined}
          /* The titles say what each click ACTUALLY does. The excluded one
             claimed a click "stops excluding" — it re-requires the tag, which
             is a different destination — and the modifier is named for both
             platforms, since `altKey` is Alt on the keyboards that have no ⌥. */
          title={
            excluded
              ? `Kept out of the shelf — click to require it instead, ⌥/Alt-click to clear`
              : mine
                ? `${tag} — ⌥/Alt-click to exclude`
                : `${tag}, from the publisher — ⌥/Alt-click to exclude`
          }
          onClick={onClick}
        >
          {excluded ? (
            <Ban size={ICON.control} strokeWidth={ICON.stroke} />
          ) : (
            <Hash size={ICON.control} strokeWidth={ICON.stroke} />
          )}
          <span className={styles.scopeLabel}>{tag}</span>
          <span className={styles.scopeCount}>{count}</span>
        </button>
      )}

      {/* The menu. What is in it depends on whose tag this is — a reader's
          gets rename and remove; a publisher's gets adopt. Both get exclude.
          Nothing in it will refuse when clicked. */}
      {!renaming && (
        <>
          <button
            ref={moreRef}
            type="button"
            className={controls.more}
            aria-label={`More for the tag ${tag}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-open={menuOpen}
            title={mine ? 'Rename, exclude or remove' : 'Adopt or exclude'}
            onClick={() => {
              setConfirming(false)
              setMenuFor(menuOpen ? null : tag)
            }}
          >
            <MoreHorizontal size={ICON.control} strokeWidth={ICON.stroke} />
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              className={controls.menu}
              role="menu"
              aria-label={`Actions for the tag ${tag}`}
              style={menuStyle}
            >
              {mine ? (
                <button
                  type="button"
                  role="menuitem"
                  className={controls.menuItem}
                  onClick={() => {
                    closeMenu()
                    setDraft(tag)
                    setRenaming(true)
                  }}
                >
                  <Pencil size={ICON.control} strokeWidth={ICON.stroke} />
                  Rename…
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className={controls.menuItem}
                  title="Write it as your own tag on every book the publisher gave it to — then it can be renamed and removed"
                  onClick={() => {
                    closeMenu()
                    onAdopt()
                  }}
                >
                  <CopyPlus size={ICON.control} strokeWidth={ICON.stroke} />
                  Keep as my tag
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className={controls.menuItem}
                onClick={() => {
                  closeMenu()
                  onToggleExclude()
                }}
              >
                <Ban size={ICON.control} strokeWidth={ICON.stroke} />
                {excluded ? 'Stop excluding' : 'Exclude from the shelf'}
              </button>
              {mine && (
                <button
                  type="button"
                  role="menuitem"
                  className={controls.menuItem}
                  data-danger="true"
                  data-confirming={confirming}
                  onClick={() => {
                    if (confirming) {
                      closeMenu()
                      onRemove()
                    } else {
                      setConfirming(true)
                    }
                  }}
                >
                  <Trash2 size={ICON.control} strokeWidth={ICON.stroke} />
                  {/* `removes`, not `count`: the consent number has to be the
                      action's number. See `ownTagBooks`. */}
                  {confirming
                    ? `Remove from ${removes} ${removes === 1 ? 'book' : 'books'}? — click again`
                    : `Remove from ${removes} ${removes === 1 ? 'book' : 'books'}`}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
