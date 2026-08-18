import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Search } from 'lucide-react'
import { filterCommands, type Command } from '../commands'
import { comboFor } from '../panes'
import { ICON, type Platform } from '../../core/metrics'
import { OverlaySheet } from './OverlaySheet'
import styles from './Overlay.module.css'

/**
 * §11's ⌘K — "Search or ask".
 *
 * It runs commands. It does NOT answer questions: the companion has no model
 * configured, and a palette that accepted a question and produced something
 * would be inventing content about the reader's book, which §13's voice rules
 * forbid outright. A query matching no command therefore offers to take it to
 * the companion, where the not-configured state says so plainly, rather than
 * silently doing nothing or silently making something up.
 */

export interface CommandPaletteProps {
  commands: readonly Command[]
  /** Which accelerator glyph the combos are printed with. */
  platform: Platform
  onDismiss: () => void
  /** Hand an unmatched query to the companion panel. */
  onAsk: (question: string) => void
}

export function CommandPalette({ commands, platform, onDismiss, onAsk }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  /**
   * The highlighted command by IDENTITY, not by index.
   *
   * An index is only meaningful against the list it was taken from, and this
   * list is rebuilt whenever the app's state changes — a relocation, a mark, a
   * pane opening — all of which can happen while the palette is up. The
   * highlight then belonged to whatever had moved into that row, and Enter ran
   * it: a stale index cannot address the wrong command if there is no stale
   * index. Null means the first match, which is what an empty query wants.
   */
  const [activeId, setActiveId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const matches = useMemo(() => filterCommands(commands, query), [commands, query])

  /* Resolved every render against the CURRENT matches, so it is always a valid
   * index or 0 — never out of range, and never pointing at a row the reader is
   * not looking at. */
  const activeIdx = Math.max(
    matches.findIndex((command) => command.id === activeId),
    0,
  )

  /* Typing changes the list under the cursor, so the cursor goes back to the
   * top. Leaving it where it was meant Enter ran whichever command happened to
   * land at that index after the filter — a different one from the highlighted
   * row a moment earlier. */
  useEffect(() => setActiveId(null), [query])

  /* Keep the active row in view when the arrows walk past the fold. */
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, matches])

  const run = (command: Command | undefined) => {
    if (!command) return
    // Dismiss FIRST: several commands open a pane or another layer, and
    // dismissing afterwards would tear down the layer they just raised.
    onDismiss()
    command.run()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const next = Math.min(activeIdx + 1, Math.max(matches.length - 1, 0))
      setActiveId(matches[next]?.id ?? null)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      const next = Math.max(activeIdx - 1, 0)
      setActiveId(matches[next]?.id ?? null)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (matches.length > 0) run(matches[activeIdx])
      else if (query.trim()) {
        onDismiss()
        onAsk(query.trim())
      }
    }
  }

  /* Group headings are emitted as the list is walked rather than by grouping
   * first, so the ranking survives: sorting into groups would reorder matches
   * and put a worse one above a better one. */
  let lastGroup = ''

  return (
    <OverlaySheet label="Search or ask" onDismiss={onDismiss}>
      <div className={styles.field}>
        <Search size={ICON.control} strokeWidth={ICON.stroke} />
        <input
          className={styles.input}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search or ask"
          aria-label="Search or ask"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className={styles.list} ref={listRef}>
        {matches.length === 0 ? (
          <div className={styles.empty}>
            {query.trim() ? (
              <>
                No command matches “{query.trim()}”.
                <br />
                Press Enter to take it to the companion.
              </>
            ) : (
              'Type to search commands.'
            )}
          </div>
        ) : (
          matches.map((command, index) => {
            const heading = command.group !== lastGroup ? command.group : null
            lastGroup = command.group
            return (
              <div key={command.id}>
                {heading && <div className={styles.group}>{heading}</div>}
                <button
                  type="button"
                  className={styles.row}
                  data-active={index === activeIdx}
                  onPointerEnter={() => setActiveId(command.id)}
                  onClick={() => run(command)}
                >
                  <span className={styles.rowLabel}>{command.label}</span>
                  {command.on && (
                    <span className={styles.rowOn}>
                      <Check size={ICON.inline} strokeWidth={ICON.stroke} />
                    </span>
                  )}
                  {command.combo && (
                    <span className={styles.combo}>{comboFor(command.combo, platform)}</span>
                  )}
                </button>
              </div>
            )
          })
        )}
      </div>
    </OverlaySheet>
  )
}
