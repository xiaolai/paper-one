import { useMemo } from 'react'
import {
  Highlighter,
  Layers,
  LibraryBig,
  List,
  Puzzle,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Wrench,
} from 'lucide-react'
import type { IndexedBook } from '../../core/bookIndex'
import type { JumpTarget } from '../hooks/useJumps'
import type { MarkControl, PaneContribution, SettingsSection } from '../../core/capability'
import type { AskPassage, CompanionProvider } from '../../core/companion'
import { ICON, type Platform } from '../../core/metrics'
import { PANE_TITLES, shownPane } from '../panes'
import { isContributedScreenId } from '../../core/uiTypes'
import { defaultPaneFor, paneFits, setReadingStyle, type AppDispatch, type AppState, type KernelPaneId, type PaneAudience } from '../state'
import type { Book } from '../hooks/useBook'
import type { Annotation } from '../../core/marks'
import type { MarkFocus } from '../hooks/useMarking'
import type { CardsView } from '../hooks/useCards'
import type { MarksView } from '../hooks/useMarks'
import type { Bookmarking } from '../hooks/useBookmarking'
import { Companion } from './Companion'
import { Contents } from './Contents'
import type { Face } from '../../core/typefaces'
import { LibraryPanel } from './LibraryPanel'
import type { TagPrefsStore } from '../hooks/useTagPrefs'
import { Cards } from './Cards'
import { Marginalia } from './Marginalia'
import { SearchPanel } from './SearchPanel'
import { DevPane } from './DevPane'
import type { DiagnosticLog } from '../../core/diagnosticsLog'
import type { CopyOutcome } from '../clipboard'
import { Settings } from './Settings'
import styles from './SidePane.module.css'
import { ContributionBoundary, ContributionBody } from '../ContributionBoundary'

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
 * Only the icons. Ids and labels come from `ui/panes`, which the palette and
 * the titlebar read too — this file used to carry its own copy of all three,
 * under a comment about registries that drift. Typed as a total Record, so
 * adding a panel without an icon fails to compile rather than rendering a rail
 * button with nothing in it.
 */
/* ONE LIST: the rail's order and each panel's icon, together. They were two —
 * a total Record for the icons and an ordered array of ids — which meant two
 * edits per panel and two structures to keep agreeing; the compile-time check
 * below covers the merged list exactly as it covered the array. The ORDER is
 * this file's; the membership is not: Companion sits second here, beside
 * Contents, because §03 groups the two surfaces that read the book. Labels
 * still come from `ui/panes`, which the palette and the titlebar read too. */
const RAIL_ENTRIES = [
  { id: 'toc', Icon: List },
  { id: 'companion', Icon: Sparkles },
  { id: 'marginalia', Icon: Highlighter },
  { id: 'cards', Icon: Layers },
  { id: 'search', Icon: Search },
  { id: 'library', Icon: LibraryBig },
  { id: 'settings', Icon: SettingsIcon },
  /* LAST, and below Settings deliberately: it is the only panel most readers
     will never see, and putting it anywhere else would push a rail everyone
     knows down by one for the few who turn it on. */
  { id: 'dev', Icon: Wrench },
] as const satisfies readonly { id: KernelPaneId; Icon: typeof Search }[]

/** Fails to compile if the rail and the registry stop agreeing on membership. */
type RailCoversEveryPane = Exclude<KernelPaneId, (typeof RAIL_ENTRIES)[number]['id']> extends never
  ? true
  : ['a panel is missing from RAIL_ENTRIES', Exclude<KernelPaneId, (typeof RAIL_ENTRIES)[number]['id']>]
const _railIsExhaustive: RailCoversEveryPane = true
void _railIsExhaustive

const RAIL = RAIL_ENTRIES.map(({ id, Icon }) => ({
  id,
  label: PANE_TITLES[id],
  Icon,
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
const railFor = (screen: AppState['screen'], audience: PaneAudience) =>
  RAIL.filter((tab) => paneFits(screen, tab.id, audience))

/** The companion's passages when the host supplies none — one function, not a
 *  fresh `() => []` per render that re-rendered the pane for nothing. */
const NO_PASSAGES = (): AskPassage[] => []

export interface SidePaneProps {
  state: AppState
  dispatch: AppDispatch
  book: Book
  marks: MarksView
  /** The open book's places, and the rule for putting one here — see the panel. */
  bookmarking: Bookmarking
  /** Which keyboard this reader has — the Marginalia panel teaches ⌘B/Ctrl+B. */
  platform: Platform
  cards: CardsView
  /**
   * What the developer surfaces need, when they are drawn.
   *
   * ⚠️ **IT DOES NOT SAY WHETHER THEY ARE DRAWN, AND IT USED TO.** This was
   * optional with "absent is off" written on it, while the RAIL read
   * `state.developer` — two sources for one fact, so a caller could pass the
   * object with the flag off and get a Developer panel the rail refuses to
   * show, or the reverse. The contract was asserted in a comment and enforced
   * nowhere, which is the shape of every invariant this file has lost before.
   *
   * `state.developer` is the one answer now. This is DATA — where the log is,
   * whether anything is recording, how to reach a clipboard — and it is passed
   * unconditionally, because a host that has it always has it.
   */
  developer?:
    | {
        readonly log?: DiagnosticLog | undefined
        readonly recording: boolean
        readonly onCopy?: ((jsonl: string) => Promise<CopyOutcome>) | undefined
        readonly onCleared?: (() => void) | undefined
      }
    | undefined
  /**
   * Navigate somewhere non-linear. A string is the OPEN book — a CFI or an
   * href, which foliate resolves either way — and a `Place` names the book as
   * well, which is what a cross-book row needs. See `useJumps`.
   */
  onGoTo?: (target: JumpTarget) => void
  /** Removes a mark from the store AND from the page — see `Marginalia`. */
  onDeleteMark: (mark: Annotation) => void
  /** The mark Notes should reveal, if one has been asked for. */
  markFocus: MarkFocus | null
  /** Notes has revealed it — the request is spent. See `Marking.clearFocus`. */
  onMarkFocusDone: (nonce: number) => void
  /**
   * The reader's live selection, as text, for the companion.
   *
   * REQUIRED, NOT OPTIONAL. `Companion` takes `selection` and defaults it to
   * null, and this pane mounted it without one — so every question ever asked
   * went out with no passage, while `core/companion.ts`, the ledger and
   * `numberPassages` all described one. An optional prop is a prop a host can
   * forget with nothing said; a required one is the compile-time half of
   * `SidePane.test.tsx`.
   */
  selection: string | null
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
  /**
   * The book text the companion may ground an answer in, in reading order.
   *
   * A prop for the same reason the provider is: the passages are assembled
   * from the rendered view, which is App's business, and a Companion that
   * reached for them itself would be reading the reader's page from inside a
   * side panel.
   */
  companionPassages?: () => readonly AskPassage[]
  /**
   * Everything the Library panel needs, as ONE prop.
   *
   * These were eight flat props on a component that does not read a single one
   * of them — it forwards them, whole, to one panel. Flat, every panel's
   * dependencies sat in one undifferentiated list of two dozen, so nothing said
   * which of them belonged together or which panel a new one was for, and
   * adding a Library prop widened the surface every OTHER caller of this
   * component has to satisfy. Grouped, the shape says who each one serves and
   * the Library panel's needs can grow without anything else noticing.
   *
   * `books` is the exception that stays outside: Marginalia reads it too, to
   * name the book a cross-book row came from.
   */
  library: {
    /** Collection-wide tag edits — see `LibraryPanel`. */
    readonly onRenameTag: (from: string, to: string) => void
    readonly onRemoveTag: (tag: string) => void
    /** The reader's decisions about their tags — see `tagPrefs`. */
    readonly tagPrefs: TagPrefsStore
    /** The last shelf-wide tag removal and its undo. */
    readonly lastRemoval: { readonly tag: string; readonly bookIds: readonly string[] } | null
    readonly onUndoRemoveTag: () => void
    readonly onAdoptTag: (tag: string) => void
    readonly onTagBooks: (bookIds: readonly string[], tags: readonly string[]) => void
  }
  /** The shelf: the Library panel's counts and scopes, and Marginalia's titles. */
  books: readonly IndexedBook[]
  /** Everything the Settings panel needs, as one prop — same reason as `library`. */
  settings: {
    /** The faces this machine can offer. */
    readonly offered: readonly Face[]
    /** The contributed settings sections (WI-C.5). */
    readonly sections: readonly SettingsSection[]
    /** Capabilities that did not compose — see `Settings.missing`. */
    readonly missing?: readonly { readonly id: string }[] | undefined
    /** Whether a choice made in the panel survives a launch — see `Settings.persistent`. */
    readonly persistent?: boolean | undefined
  }
  /**
   * The panes the composed capabilities contributed. They take the rail
   * AFTER the kernel's, in the composition's order, on the screens each one
   * says it fits; ⌘1…5 stay on the kernel's. One generic icon for all of
   * them — a contribution carries a label, not an icon.
   */
  contributed: readonly PaneContribution[]
  /**
   * The controls the composed capabilities draw on the reader's own marks —
   * handed straight to Marginalia, which is the one panel that lists them.
   * Optional so a host with no composition (the browser client) mounts the
   * same panel and draws none.
   */
  markControls?: readonly MarkControl[] | undefined
}

export function SidePane({
  state,
  dispatch,
  book,
  marks,
  bookmarking,
  platform,
  cards,
  onGoTo,
  onDeleteMark,
  markFocus,
  onMarkFocusDone,
  selection,
  companion,
  companionPassages,
  books,
  library,
  settings,
  contributed,
  markControls,
  developer,
}: SidePaneProps) {
  /* Falls back to the last pane rather than unmounting. The slot stays mounted
   * at zero width and inert while closed, so keeping the panel rendered is what
   * preserves its scroll position, note filter and search query across a
   * close/open — returning null threw all of that away.
   *
   * FITTED TO THE SCREEN, though. `lastPane` can name a panel this screen does
   * not have — close the pane in the reader on Contents, walk to the library —
   * and rendering it raw swapped the hidden slot from LibraryPanel to
   * Contents, unmounting the panel that would reopen here and its filter,
   * sort and undo state with it. The screen's default is what `openPane`
   * would land on, so it is what stays warm.
   *
   * RESOLVED against the composition after that, not trusted: a remembered
   * pane id that belongs to no composed capability shows the screen's default
   * rather than a title over nothing — see `shownPane`. */
  /* WHO IS LOOKING, as one value — the screen fit and the developer's own
     answer travel together through `paneFits`, and building it once here is
     what stops the rail, the fallback and the contributed list asking three
     slightly different questions. */
  const audience: PaneAudience = {
    contributed,
    developer: state.developer,
    hiddenPanes: state.hiddenPanes,
  }

  const fallback = defaultPaneFor(state.screen)
  const wanted =
    state.pane ?? (paneFits(state.screen, state.lastPane, audience) ? state.lastPane : fallback)
  const shown = shownPane(wanted, contributed, fallback)
  const pane = shown.id

  /* THE SHELF, INDEXED ONCE. Marginalia and Cards ask "what is this book
   * called" and "is it here" per row, and each answer was a linear `find` or
   * `some` over the whole shelf through a callback minted fresh every render
   * — so a panel of a few hundred rows rescanned a two-thousand-book shelf
   * on every keystroke in a note. One map, keyed on the list's identity, and
   * two stable lookups over it. */
  const byId = useMemo(() => new Map(books.map((row) => [row.bookId, row] as const)), [books])
  const titleOf = useMemo(() => (id: string) => byId.get(id)?.title, [byId])
  const onShelf = useMemo(() => (id: string) => byId.has(id), [byId])
  /* Once, not five times: the exact-optional-property workaround for a host
   * with no jump stack, spelled at every panel that takes one. */
  const goToProps = onGoTo ? { onGoTo } : {}
  /* THE RAIL, BUILT WHEN ITS INPUTS CHANGE and not per render — the
   * contributed half asked `paneFits` per entry, which rescans `contributed`,
   * so a rail of n contributed panes cost n² on every keystroke anywhere. */
  const rail = useMemo(
    () => [
      /* SPREAD, not mapped through an identity: `railFor` already returns
         `{ id, label, Icon }`, so the map only rebuilt equal objects. */
      ...railFor(state.screen, audience),
      ...contributed
        .filter((entry) => paneFits(state.screen, entry.id, audience))
        .map(({ id, label }) => ({ id, label, Icon: Puzzle })),
    ],
    [state.screen, contributed, state.developer, state.hiddenPanes],
  )

  /* ⚠️ **NOTHING IS DRAWN OVER A CONTRIBUTED SCREEN.** It owns the whole
     window by definition, so a rail of panels about a book or a shelf beside it
     is furniture from a room the reader has left. `paneFits` already refuses
     every kernel pane there; this is the other half — the slot itself goes. */
  /* AFTER every hook, so the hook count is the same on every render — a
     return between hooks is a React error the next time the screen changes. */
  if (isContributedScreenId(state.screen)) return null
  return (
    <>
      <div className={styles.paneTitle}>{shown.title}</div>

      <div className={styles.body}>
        {pane === 'toc' && (
          <Contents toc={book.toc} currentHref={book.position.chapterHref} {...goToProps} />
        )}

        {pane === 'companion' && (
          <Companion
            /* ⚠️ **THE THREAD BELONGS TO A BOOK, AND NOTHING SAID SO.** The
               pane stays mounted across an open, so switching books kept the
               previous book's exchange and the half-typed question in the
               composer — under the new book's heading, and grounded in the new
               book the moment the reader pressed send. "grounded in this book
               only" is the panel's own promise and this is where it was broken:
               amber marks provenance, and provenance carried over is worse than
               none. Keyed, so the session is rebuilt rather than reset by hand
               — and the unmount aborts a generation still streaming, which is a
               subscription turn spent on an answer nobody will read. */
            key={book.bookId ?? 'no-book'}
            currentChapter={book.position.chapterLabel}
            /* A book that is OPEN and READ, not merely chosen: `source` is set
               the instant a file is handed over, while it is still parsing and
               after it has failed to open — and a companion accepting
               questions about a book that did not open answers about nothing. */
            hasBook={book.source !== null && book.meta !== null && book.error === null}
            provider={companion}
            /* The open book's own metadata first — it is known the moment the
               parse lands, before the shelf row exists or when the book is not
               shelved at all — and the shelf's title as the fallback. */
            bookTitle={book.meta?.title ?? (book.bookId ? titleOf(book.bookId) : undefined) ?? ''}
            selection={selection}
            passages={companionPassages ?? NO_PASSAGES}
            /* A bare cfi IS a `JumpTarget` — the union's string arm — so a
               citation navigates through exactly the path a search hit does,
               jump stack included. */
            {...goToProps}
          />
        )}

        {pane === 'marginalia' && (
          <Marginalia
            marks={marks}
            cards={cards}
            bookId={book.bookId}
            onDelete={onDeleteMark}
            onDeleteBookmark={bookmarking.remove}
            platform={platform}
            /* The shelf is already here for the Library panel; Marginalia needs
               it only to name the book a cross-book row came from. */
            titleOf={titleOf}
            /* WHETHER THE BOOK CAN BE OPENED AT ALL, asked separately from
               what it is called. `titleOf` returning undefined nearly answers
               it, but a shelved book with an empty title answers the same way
               — and conflating "has no title" with "is not here" would
               silently disable rows that work. Same `books` list, two
               questions, both answered where the list already is. */
            onShelf={onShelf}
            focus={markFocus}
            onFocusDone={onMarkFocusDone}
            markControls={markControls}
            {...goToProps}
          />
        )}

        {pane === 'cards' && (
          <Cards
            cards={cards}
            bookId={book.bookId}
            /* THE SAME `books` LIST, THE SAME QUESTION as Marginalia asks two
               panels up. One source, so the two cannot answer differently. */
            onShelf={onShelf}
            {...goToProps}
          />
        )}

        {/* A hit is a jump like any other panel's — through `onGoTo`, so it
            enters the stack and raises "← Back to". Mounted without it, the
            panel navigated on its own and the ledger's promise was a row. */}
        {pane === 'search' && <SearchPanel book={book} {...goToProps} />}

        {/* NO `developer &&` GUARD. The pane can only be `dev` when `paneFits`
            said so, and that reads `state.developer` — the same one answer the
            rail reads. A second guard here would be the second source of truth
            this prop was just relieved of. */}
        {pane === 'dev' && (
          <DevPane
            log={developer?.log}
            recording={developer?.recording ?? false}
            {...(developer?.onCopy ? { onCopy: developer.onCopy } : {})}
            {...(developer?.onCleared ? { onCleared: developer.onCleared } : {})}
          />
        )}

        {pane === 'settings' && (
          <Settings
            /* GATED ON `state.developer`, the same fact the rail and the pane
               read — not on whether the host handed over the diagnostics
               wiring, which is a different question and used to be conflated
               with this one. */
            {...(state.developer
              ? {
                  developer: {
                    hidden: state.hiddenPanes,
                    onSetHidden: (target: string, hidden: boolean) =>
                      dispatch({ type: 'setPaneHidden', pane: target, hidden }),
                    recording: developer?.recording ?? false,
                  },
                }
              : {})}
            offered={settings.offered}
            sections={settings.sections}
            missing={settings.missing}
            persistent={settings.persistent}
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
            style={state.readingStyle}
            onStyle={(key, value) => dispatch(setReadingStyle(key, value))}
            brightness={state.brightness}
            onBrightness={(idx) => dispatch({ type: 'setBrightness', idx })}
            contrast={state.contrast}
            onContrast={(idx) => dispatch({ type: 'setContrast', idx })}
            onTypeface={(typeface) => dispatch({ type: 'setTypeface', typeface })}
          />
        )}

        {pane === 'library' && (
          <LibraryPanel books={books} query={state.libraryQuery} dispatch={dispatch} {...library} />
        )}

        {/* A contributed pane: the capability's own element, narrowed from
            the opaque handle it registered — see `renderContribution`. */}
        {/* THE BOOK THE SCREEN SHOWS, not the book the reader holds. The
            reader stays loaded behind the library, so `book.bookId` still
            names the last book opened while the library is on screen — and
            `PaneContext` promises `null` there. A pane fitted to the library
            was handed the previous book's id; the reset key read the same
            value, so it did not start over either. The label a reader sees is
            the pane's own; the id goes to the log. */}
        {shown.contribution && (
          <ContributionBoundary
            label={shown.contribution.label}
            id={shown.contribution.id}
            resetKey={`${shown.contribution.id}:${state.screen === 'reader' ? book.bookId : null}`}
          >
            <ContributionBody
              id={shown.contribution.id}
              render={shown.contribution.render}
              context={{ bookId: state.screen === 'reader' ? book.bookId : null }}
            />
          </ContributionBoundary>
        )}
      </div>

      {/* The rail sits at the foot of the pane. It is the pane's own
          navigation, not the window's, so it reads better anchored to the
          surface it switches than stacked under the titlebar with it. */}
      <div className={styles.rail}>
        {/* ONE ENTRY MODEL FOR BOTH KINDS OF TAB.
            The kernel's panes and a capability's were two nearly identical
            blocks, and they had already drifted: `aria-pressed` was added to
            the first and not the second, so a screen reader walking the rail
            was told which kernel tab was lit and heard every contributed one as
            an ordinary button. Adding the attribute to the second copy fixes
            today's difference and leaves tomorrow's; one list cannot drift.
            The ICON is all that genuinely differs — a capability's pane has no
            icon of its own to give, so every one of them wears the same mark. */}
        {rail.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className={styles.railButton}
            title={label}
            aria-label={label}
            data-on={pane === id}
            /* The lit tab, said out loud — `data-on` is only paint, and a
               screen reader walking the rail heard eight identical buttons. */
            aria-pressed={pane === id}
            onClick={() => dispatch({ type: 'openPane', pane: id })}
          >
            <Icon size={ICON.tab} strokeWidth={ICON.stroke} />
          </button>
        ))}
      </div>
    </>
  )
}
