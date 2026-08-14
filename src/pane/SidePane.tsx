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
import type { AppDispatch, AppState, PaneId } from '../lib/state'
import type { Book } from '../lib/useBook'
import type { MarkStore } from '../lib/useMarks'
import { Companion } from './Companion'
import { Contents } from './Contents'
import { Notes } from './Notes'
import { SearchPanel } from './SearchPanel'
import { Settings } from './Settings'
import styles from './SidePane.module.css'

/**
 * The seven tools, in rail order.
 *
 * Contents and Companion used to live in a separate 340px card beside the
 * reader. One pane holds all seven, so there is a single place to look for a
 * tool and a single surface competing with the text.
 *
 * This component now only selects a panel. Each panel owns its own state and
 * markup — previously all seven were inline here, coupling navigation,
 * filtering, settings and content rendering in one 300-line file.
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

/* Derived from RAIL rather than restated. Two registries of the same labels
 * drift the moment one is edited alone. */
const PANE_TITLES = Object.fromEntries(
  RAIL.map(({ id, label }) => [id, label]),
) as Record<PaneId, string>

export interface SidePaneProps {
  state: AppState
  dispatch: AppDispatch
  book: Book
  marks: MarkStore
  onGoTo?: (target: string) => void
}

export function SidePane({ state, dispatch, book, marks, onGoTo }: SidePaneProps) {
  /* Falls back to the last pane rather than unmounting. The slot stays mounted
   * at zero width and inert while closed, so keeping the panel rendered is what
   * preserves its scroll position, note filter and search query across a
   * close/open — returning null threw all of that away. */
  const pane = state.pane ?? state.lastPane

  return (
    <>
      <div className={styles.paneTitle}>{PANE_TITLES[pane]}</div>

      <div className={styles.body}>
        {pane === 'toc' && (
          <Contents
            toc={book.toc}
            currentHref={book.position.chapterHref}
            {...(onGoTo ? { onGoTo } : {})}
          />
        )}

        {pane === 'companion' && (
          <Companion
            currentChapter={book.position.chapterLabel}
            hasBook={book.source !== null}
          />
        )}

        {pane === 'notes' && (
          <Notes
            marks={marks}
            bookId={book.bookId}
            {...(onGoTo ? { onGoTo } : {})}
          />
        )}

        {pane === 'search' && <SearchPanel book={book} />}

        {pane === 'settings' && (
          <Settings
            theme={state.theme}
            themeFollowsOs={state.themeFollowsOs}
            pageLayout={state.pageLayout}
            rulerOn={state.rulerOn}
            side={state.side}
            onTheme={(theme) => dispatch({ type: 'setTheme', theme })}
            onFollowOs={(follows) => dispatch({ type: 'setThemeFollowsOs', follows })}
            onPageLayout={(layout) => dispatch({ type: 'setPageLayout', layout })}
            onToggleRuler={() => dispatch({ type: 'toggleRuler' })}
            onSide={(side) => dispatch({ type: 'setSide', side })}
          />
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
              Drop an EPUB, MOBI or CBZ onto the reader, or connect a folder to
              watch.
            </div>
          </div>
        )}
      </div>

      {/* The rail sits at the foot of the pane. It is the pane's own
          navigation, not the window's, so it reads better anchored to the
          surface it switches than stacked under the titlebar with it. */}
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
    </>
  )
}
