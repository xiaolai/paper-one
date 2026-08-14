import { useState } from 'react'
import {
  ChartNoAxesColumn,
  Highlighter,
  List,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sparkles,
} from 'lucide-react'
import { ICON } from '../lib/metrics'
import type { AppDispatch, AppState, PaneId, Theme } from '../lib/state'
import type { Book } from '../lib/useBook'
import { NOTES, SEARCH_RESULTS } from '../data/fixtures'
import { Companion } from './Companion'
import { Contents } from './Contents'
import styles from './SidePane.module.css'

/**
 * The seven tools, in rail order.
 *
 * Contents and Companion used to live in a separate 340px card beside the
 * reader. One pane holds all seven, so there is a single place to look for a
 * tool and a single surface competing with the text.
 */
const RAIL: readonly { id: PaneId; label: string; Icon: typeof Search }[] = [
  { id: 'toc', label: 'Contents', Icon: List },
  { id: 'companion', label: 'Companion', Icon: Sparkles },
  { id: 'notes', label: 'Notes', Icon: Highlighter },
  { id: 'search', label: 'Search', Icon: Search },
  { id: 'stats', label: 'Reading', Icon: ChartNoAxesColumn },
  { id: 'import', label: 'Add books', Icon: Plus },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon },
]

const PANE_TITLES: Record<PaneId, string> = {
  toc: 'Contents',
  companion: 'Companion',
  notes: 'Notes',
  search: 'Search',
  stats: 'Reading',
  import: 'Add books',
  settings: 'Settings',
}

/** §05 theme chips — the page colour of each theme, as a literal, because a
 *  swatch has to show the theme it offers rather than the one in use. */
const THEME_CHIPS: readonly { id: Theme; label: string; fill: string }[] = [
  { id: 'paper', label: 'Paper', fill: '#FFFFFF' },
  { id: 'slate', label: 'Slate', fill: '#DFE1DE' },
  { id: 'sepia', label: 'Sepia', fill: '#F8F0E1' },
  { id: 'sage', label: 'Sage', fill: '#DDE6D8' },
  { id: 'night', label: 'Night', fill: '#16191C' },
]

export interface SidePaneProps {
  state: AppState
  dispatch: AppDispatch
  book: Book
  onGoTo?: (href: string) => void
}

export function SidePane({ state, dispatch, book, onGoTo }: SidePaneProps) {
  const [noteFilter, setNoteFilter] = useState<'All' | 'Highlights' | 'Companion'>('All')
  const [query, setQuery] = useState('')

  const pane = state.pane
  if (!pane) return null

  const notes = NOTES.filter((note) =>
    noteFilter === 'All'
      ? true
      : noteFilter === 'Companion'
        ? note.kind === 'AI'
        : note.kind === 'Highlight',
  )

  return (
    <>
      <div className={styles.rail}>
        {RAIL.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className={styles.railButton}
            title={label}
            aria-label={label}
            data-on={pane === id}
            onClick={() => dispatch({ type: 'openPane', pane: id })}
          >
            <Icon size={ICON.tab} strokeWidth={ICON.stroke} />
          </button>
        ))}
      </div>

      <div className={styles.paneTitle}>{PANE_TITLES[pane]}</div>

      <div className={styles.body}>
        {pane === 'toc' && (
          <Contents
            toc={book.toc}
            currentChapter={book.position.chapterLabel}
            {...(onGoTo ? { onGoTo } : {})}
          />
        )}

        {pane === 'companion' && <Companion currentChapter={book.position.chapterLabel} />}

        {pane === 'notes' && (
          <div className={styles.panel}>
            <div className={styles.panelMeta}>
              <span style={{ flex: 1 }}>1,204 highlights · 318 notes</span>
            </div>
            <div className={styles.filters}>
              {(['All', 'Highlights', 'Companion'] as const).map((label) => (
                <button
                  key={label}
                  type="button"
                  className={styles.filter}
                  data-on={noteFilter === label}
                  onClick={() => setNoteFilter(label)}
                >
                  {label}
                </button>
              ))}
            </div>
            {notes.map((note, index) => (
              <button key={index} type="button" className={styles.note} data-kind={note.kind}>
                {note.kind === 'AI' && <div className={styles.noteKind}>Companion</div>}
                <div className={styles.noteBody}>{note.body}</div>
                {note.comment && <div className={styles.noteComment}>{note.comment}</div>}
                <div className={styles.noteSource}>
                  {note.book} · {note.at}
                </div>
              </button>
            ))}
          </div>
        )}

        {pane === 'search' && (
          <div className={styles.panel}>
            <div className={styles.searchField}>
              <Search size={14} strokeWidth={ICON.stroke} style={{ color: 'var(--muted)' }} />
              <input
                className={styles.searchInput}
                placeholder="Search this book…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search this book"
              />
            </div>
            {SEARCH_RESULTS.map((result, index) => (
              <button key={index} type="button" className={styles.result}>
                <span className={styles.resultBook}>{result.book}</span>
                <span className={styles.resultAt}>{result.at}</span>
                <div className={styles.resultSnippet}>
                  {result.before}
                  {result.hit && <span className={styles.hit}>{result.hit}</span>}
                  {result.after}
                </div>
              </button>
            ))}
          </div>
        )}

        {pane === 'settings' && (
          <div className={styles.panel}>
            <div className={styles.groupTitle}>Appearance</div>
            <div className={styles.themeGrid}>
              {THEME_CHIPS.map(({ id, label, fill }) => (
                <button
                  key={id}
                  type="button"
                  className={styles.themeSwatch}
                  data-on={state.theme === id}
                  onClick={() => dispatch({ type: 'setTheme', theme: id })}
                >
                  <span className={styles.themeChip} style={{ background: fill }} />
                  {label}
                </button>
              ))}
            </div>

            <button
              type="button"
              className={styles.settingRow}
              onClick={() =>
                dispatch({ type: 'setThemeFollowsOs', follows: !state.themeFollowsOs })
              }
            >
              <span style={{ flex: 1 }}>Follow system appearance</span>
              <span className={styles.settingValue}>
                {state.themeFollowsOs ? 'On' : 'Off'}
              </span>
            </button>

            <div className={styles.groupTitle}>Page layout</div>
            <button
              type="button"
              className={styles.settingRow}
              onClick={() =>
                dispatch({
                  type: 'setPageLayout',
                  layout: state.pageLayout === 'scrolled' ? 'paginated' : 'scrolled',
                })
              }
            >
              <span style={{ flex: 1 }}>Flow</span>
              <span className={styles.settingValue}>
                {state.pageLayout === 'scrolled' ? 'Scrolled' : 'Paged'}
              </span>
            </button>

            {/* §06: the ruler row appears only in scrolled flow — hidden, not
                disabled, because paged has no lines to advance. */}
            {state.pageLayout === 'scrolled' && (
              <button
                type="button"
                className={styles.settingRow}
                onClick={() => dispatch({ type: 'toggleRuler' })}
              >
                <span style={{ flex: 1 }}>Reading ruler</span>
                <span className={styles.settingValue}>{state.rulerOn ? 'On' : 'Off'}</span>
              </button>
            )}

            <div className={styles.groupTitle}>Side pane</div>
            <button
              type="button"
              className={styles.settingRow}
              onClick={() =>
                dispatch({ type: 'setSide', side: state.side === 'left' ? 'right' : 'left' })
              }
            >
              <span style={{ flex: 1 }}>Position</span>
              <span className={styles.settingValue}>
                {state.side === 'left' ? 'Left' : 'Right'}
              </span>
            </button>
          </div>
        )}

        {pane === 'stats' && (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>No reading recorded yet</div>
            <div className={styles.emptyBody}>
              Reading time, pages and streaks appear here once you have spent a
              session with a book.
            </div>
          </div>
        )}

        {pane === 'import' && (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>Add books</div>
            <div className={styles.emptyBody}>
              Drop an EPUB, PDF, MOBI or CBZ onto the reader, or connect a folder
              to watch.
            </div>
          </div>
        )}
      </div>
    </>
  )
}
