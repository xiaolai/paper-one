import {
  ChartNoAxesColumn,
  Highlighter,
  Layers,
  LibraryBig,
  List,
  Search,
  Settings as SettingsIcon,
  Sparkles,
} from 'lucide-react'
import type { IndexedBook } from '../lib/bookIndex'
import type { CompanionProvider } from '../lib/companion'
import { ICON } from '../lib/metrics'
import { PANE_TITLES } from '../lib/panes'
import { paneFits, type AppDispatch, type AppState, type PaneId } from '../lib/state'
import type { Book } from '../lib/useBook'
import type { Mark } from '../lib/marks'
import type { MarkFocus } from '../lib/useMarking'
import type { CardStore } from '../lib/useCards'
import type { MarkStore } from '../lib/useMarks'
import { Companion } from './Companion'
import { Contents } from './Contents'
import type { Face } from '../lib/typefaces'
import { LibraryPanel } from './LibraryPanel'
import { Cards } from './Cards'
import { Notes } from './Notes'
import { SearchPanel } from './SearchPanel'
import { Settings } from './Settings'
import styles from './SidePane.module.css'

/**
 * The pane's tools, in rail order.
 *
 * Counted from `PANES` rather than written out, because the number in the prose
 * was wrong: three separate comments said "seven" over a rail of eight, and a
 * count in a sentence has no way to notice a panel being added.
 *
 * Contents and Companion used to live in a separate 340px card beside the
 * reader. One pane holds them all, so there is a single place to look for a
 * tool and a single surface competing with the text.
 *
 * This component now only selects a panel. Each panel owns its own state and
 * markup — previously every one of them was inline here, coupling navigation,
 * filtering, settings and content rendering in one 300-line file.
 */
/**
 * The rail's icons, by panel.
 *
 * Only the icons. Ids and labels come from `lib/panes`, which the palette and
 * the titlebar read too — this file used to carry its own copy of all three,
 * under a comment about registries that drift. Typed as a total Record, so
 * adding a panel without an icon fails to compile rather than rendering a rail
 * button with nothing in it.
 */
const PANE_ICONS: Record<PaneId, typeof Search> = {
  toc: List,
  companion: Sparkles,
  notes: Highlighter,
  cards: Layers,
  search: Search,
  stats: ChartNoAxesColumn,
  library: LibraryBig,
  settings: SettingsIcon,
}

/* The rail's own order, which is not the palette's: Companion sits second here,
 * beside Contents, because §03 groups the two surfaces that read the book.
 *
 * The ORDER is this file's; the membership is not. A hand-written list of ids
 * can silently omit one — the panel then exists, has a command and a shortcut,
 * and has no way into it from the pane — so the array is checked against the
 * registry below rather than trusted. */
const RAIL_ORDER = [
  'toc',
  'companion',
  'notes',
  'cards',
  'search',
  'stats',
  'library',
  'settings',
] as const satisfies readonly PaneId[]

/** Fails to compile if the rail and the registry stop agreeing on membership. */
type RailCoversEveryPane = Exclude<PaneId, (typeof RAIL_ORDER)[number]> extends never
  ? true
  : ['a panel is missing from RAIL_ORDER', Exclude<PaneId, (typeof RAIL_ORDER)[number]>]
const _railIsExhaustive: RailCoversEveryPane = true
void _railIsExhaustive

const RAIL = RAIL_ORDER.map((id) => ({
  id,
  label: PANE_TITLES[id],
  Icon: PANE_ICONS[id],
}))

/**
 * The rail for one screen, in the rail's own order.
 *
 * ONE SIDE PANE, FITTED. The library gets the same rail with the three
 * book-only panels left out — see `paneFits` — rather than a second pane of its
 * own, and rather than eight icons of which three do nothing. A control that is
 * present and inert is a worse answer than one that is absent: the reader
 * clicks it, gets an apology, and learns nothing about when it will work.
 */
const railFor = (screen: AppState['screen']) => RAIL.filter((tab) => paneFits(screen, tab.id))

export interface SidePaneProps {
  state: AppState
  dispatch: AppDispatch
  book: Book
  marks: MarkStore
  cards: CardStore
  onGoTo?: (target: string) => void
  /** Removes a mark from the store AND from the page — see `Notes`. */
  onDeleteMark: (mark: Mark) => void
  /** The mark Notes should reveal, if one has been asked for. */
  markFocus: MarkFocus | null
  /**
   * The companion's provider.
   *
   * A prop, not a constant reached for inside this file. `NOT_CONFIGURED` was
   * imported and passed straight down, which made the configured branch
   * unreachable by construction — the seam existed in the types and nowhere in
   * the wiring, so nothing could be substituted for it, including in a test.
   * App supplies it; App is where a real one would arrive.
   */
  companion: CompanionProvider
  /** The shelf, for the Library panel's counts and scopes. */
  books: readonly IndexedBook[]
  /** Collection-wide tag edits, for the Library panel — see `Library`. */
  onRenameTag: (from: string, to: string) => void
  onRemoveTag: (tag: string) => void
  ownTagCount: (tag: string) => number
  /** The faces this machine can offer — passed straight to Settings. */
  offered: readonly Face[]
}

export function SidePane({
  state,
  dispatch,
  book,
  marks,
  cards,
  onGoTo,
  onDeleteMark,
  markFocus,
  companion,
  books,
  onRenameTag,
  onRemoveTag,
  ownTagCount,
  offered,
}: SidePaneProps) {
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
            provider={companion}
          />
        )}

        {pane === 'notes' && (
          <Notes
            marks={marks}
            cards={cards}
            bookId={book.bookId}
            onDelete={onDeleteMark}
            focus={markFocus}
            {...(onGoTo ? { onGoTo } : {})}
          />
        )}

        {pane === 'cards' && (
          <Cards cards={cards} bookId={book.bookId} {...(onGoTo ? { onGoTo } : {})} />
        )}

        {pane === 'search' && <SearchPanel book={book} />}

        {pane === 'settings' && (
          <Settings
            offered={offered}
            theme={state.theme}
            themeFollowsOs={state.themeFollowsOs}
            pageLayout={state.pageLayout}
            rulerOn={state.rulerOn}
            scrollbarOn={state.scrollbarOn}
            progressLineOn={state.progressLineOn}
            side={state.side}
            stepIdx={state.stepIdx}
            typeface={state.typeface}
            onTheme={(theme) => dispatch({ type: 'setTheme', theme })}
            onFollowOs={(follows) => dispatch({ type: 'setThemeFollowsOs', follows })}
            onPageLayout={(layout) => dispatch({ type: 'setPageLayout', layout })}
            onToggleRuler={() => dispatch({ type: 'toggleRuler' })}
            onToggleScrollbar={() => dispatch({ type: 'toggleScrollbar' })}
            onToggleProgressLine={() => dispatch({ type: 'toggleProgressLine' })}
            onSide={(side) => dispatch({ type: 'setSide', side })}
            onStepIdx={(idx) => dispatch({ type: 'setStepIdx', idx })}
            spacing={state.spacing}
            onSpacing={(key, idx) => dispatch({ type: 'setSpacing', key, idx })}
            align={state.align}
            onAlign={(align) => dispatch({ type: 'setAlign', align })}
            brightness={state.brightness}
            onBrightness={(idx) => dispatch({ type: 'setBrightness', idx })}
            contrast={state.contrast}
            onContrast={(idx) => dispatch({ type: 'setContrast', idx })}
            onTypeface={(typeface) => dispatch({ type: 'setTypeface', typeface })}
          />
        )}

        {pane === 'stats' && (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>Reading statistics are not recorded yet</div>
            {/* Says what is true. It used to promise that time, pages and
                streaks would appear "once you have spent a session with a
                book" — and nothing measures any of them, so the reader waits
                for a panel that will never fill in. */}
            <div className={styles.emptyBody}>
              Nothing here measures your reading yet. Your marks are in Notes
              and your cards are in Cards.
            </div>
          </div>
        )}

        {pane === 'library' && (
          <LibraryPanel
            books={books}
            query={state.libraryQuery}
            dispatch={dispatch}
            onRenameTag={onRenameTag}
            onRemoveTag={onRemoveTag}
            ownTagCount={ownTagCount}
          />
        )}
      </div>

      {/* The rail sits at the foot of the pane. It is the pane's own
          navigation, not the window's, so it reads better anchored to the
          surface it switches than stacked under the titlebar with it. */}
      <div className={styles.rail}>
        {railFor(state.screen).map(({ id, label, Icon }) => (
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
