import { useEffect, useRef, useState } from 'react'
import { Hash, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { ICON } from '../lib/metrics'
import { usePlacement } from '../lib/usePlacement'
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
  readonly count: number
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
  const menuRef = useRef<HTMLDivElement | null>(null)
  const moreRef = useRef<HTMLButtonElement | null>(null)
  const { style: menuStyle, placement } = usePlacement(menuOpen, rowRef, menuRef, {
    side: 'bottom',
    align: 'end',
  })

  /* Close on a click anywhere else, and on Escape. Bound only while THIS row's
   * menu is open. */
  useEffect(() => {
    if (!menuOpen) return
    const close = () => {
      setMenuFor(null)
      setConfirming(false)
    }
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || moreRef.current?.contains(target)) return
      close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen, setMenuFor])

  const commitRename = () => {
    setRenaming(false)
    const next = draft.trim()
    if (next && next !== tag) onRename(next)
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
              style={
                menuStyle && placement?.fit !== 'detached'
                  ? menuStyle
                  : { top: -9999, left: -9999 }
              }
            >
              <button
                type="button"
                role="menuitem"
                className={controls.menuItem}
                onClick={() => {
                  setMenuFor(null)
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
                    setConfirming(false)
                    setMenuFor(null)
                    onRemove()
                  } else {
                    setConfirming(true)
                  }
                }}
              >
                <Trash2 size={ICON.control} strokeWidth={ICON.stroke} />
                {confirming
                  ? `Remove from ${count} ${count === 1 ? 'book' : 'books'}? — click again`
                  : `Remove from ${count} ${count === 1 ? 'book' : 'books'}`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
