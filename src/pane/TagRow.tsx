import { useRef, useState } from 'react'
import { Hash, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { TAG_MAX } from '../lib/library'
import { ICON } from '../lib/metrics'
import { useRowMenu } from '../lib/useRowMenu'
import controls from '../styles/controls.module.css'
import styles from './SidePane.module.css'

/**
 * One tag in the Library panel: a scope, and — for the reader's own tags —
 * the two things that can be done to it.
 *
 * THE RULE THAT SHAPES THIS: a reader's tag can be renamed or removed; a
 * publisher's subject cannot — it is a fact about the book and comes back on
 * re-parse. So the difference is VISIBLE BEFORE YOU TRY, not discovered by a
 * failed click: a reader's tag gets the row menu, a subject does not. A tag
 * that is both (`Fiction` written by the reader on a book whose publisher says
 * `fiction`) gets the menu, because the reader's copy is real.
 *
 * The menu is the shelf's — the same `⋯` and the same two-click remove a book
 * card has — so a reader who learned it there recognises it here. Rename is
 * inline: the label becomes a field, prefilled, and it commits on Enter or
 * blur and cancels on Escape. Blur COMMITS, per the rule the Notes editor
 * established: a typed thing must not vanish because focus moved.
 *
 * Remove says how many books it will touch, in the row, and asks for a second
 * click. The number is the consent — the reader is told the blast radius
 * before they mean it.
 */
export interface TagRowProps {
  readonly tag: string
  /** Shown beside the row: books carrying the tag within the current scope. */
  readonly count: number
  /** How many books a remove will actually touch — the confirm's number. */
  readonly removes: number
  /** Whether any book carries this as the reader's own tag — see `tagCounts`. */
  readonly mine: boolean
  readonly on: boolean
  readonly onToggle: () => void
  readonly onRename: (to: string) => void
  readonly onRemove: () => void
  /** Which tag has its menu open, so only one is open across the panel. */
  readonly menuFor: string | null
  readonly setMenuFor: (tag: string | null) => void
}

export function TagRow({
  tag,
  count,
  removes,
  mine,
  on,
  onToggle,
  onRename,
  onRemove,
  menuFor,
  setMenuFor,
}: TagRowProps) {
  const menuOpen = menuFor === tag
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(tag)
  const [confirming, setConfirming] = useState(false)
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
    { side: 'bottom', align: 'end' },
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

  return (
    <div className={styles.tagRow} ref={rowRef}>
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
          data-on={on}
          aria-pressed={on}
          onClick={onToggle}
        >
          <Hash size={ICON.control} strokeWidth={ICON.stroke} />
          <span className={styles.scopeLabel}>{tag}</span>
          <span className={styles.scopeCount}>{count}</span>
        </button>
      )}

      {/* The menu, only for a tag the reader can actually change. A subject
          shows no control at all — a control that would refuse is worse than
          none, because the reader clicks it and learns nothing. */}
      {mine && !renaming && (
        <>
          <button
            ref={moreRef}
            type="button"
            className={controls.more}
            aria-label={`More for the tag ${tag}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-open={menuOpen}
            title="Rename or remove"
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
                    action's number. See `ownTagCount`. */}
                {confirming
                  ? `Remove from ${removes} ${removes === 1 ? 'book' : 'books'}? — click again`
                  : `Remove from ${removes} ${removes === 1 ? 'book' : 'books'}`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
