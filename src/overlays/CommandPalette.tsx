import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Search } from 'lucide-react'
import { filterCommands, type Command } from '../lib/commands'
import { ICON } from '../lib/metrics'
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
  onDismiss: () => void
  /** Hand an unmatched query to the companion panel. */
  onAsk: (question: string) => void
}

export function CommandPalette({ commands, onDismiss, onAsk }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const matches = useMemo(() => filterCommands(commands, query), [commands, query])

  /* Typing changes the list under the cursor, so the cursor goes back to the
   * top. Leaving it where it was meant Enter ran whichever command happened to
   * land at that index after the filter — a different one from the highlighted
   * row a moment earlier. */
  useEffect(() => setActiveIdx(0), [query])

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
      setActiveIdx((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
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
                  onPointerEnter={() => setActiveIdx(index)}
                  onClick={() => run(command)}
                >
                  <span className={styles.rowLabel}>{command.label}</span>
                  {command.on && (
                    <span className={styles.rowOn}>
                      <Check size={ICON.inline} strokeWidth={ICON.stroke} />
                    </span>
                  )}
                  {command.combo && <span className={styles.combo}>{command.combo}</span>}
                </button>
              </div>
            )
          })
        )}
      </div>
    </OverlaySheet>
  )
}
