import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
/* THE TOOLS SHEET'S FIVE TABS — the mockup's "desktop side pane, as a sheet":
 * highlighter, search, list, chart, settings. Stats is absent on this client
 * (nothing measures reading time here), so four. */
import { Highlighter, List, Search as SearchIcon, Type } from 'lucide-react'
import { BottomSheet } from './shell/BottomSheet'
import { ProgressFooter } from './shell/ProgressFooter'
import { SelectionBar } from './shell/SelectionBar'
import {
  Contents,
  FoliateView,
  FootnotePopover,
  Marginalia,
  SearchPanel,
  useAppPalette,
  usePrefersDark,
} from '../../kernel/ui/browser'
import { WEB_SETTINGS, browserSettings } from './settings'
import { useBookSource } from './useBookSource'
import { useTapToTurn } from './useTapToTurn'
import { useMarking } from './useMarking'
import { ReadingSettings } from './shell/ReadingSettings'
import type { BookMeta, FootnoteRender, SearchHit } from '../../kernel/ui/browser'
import { externalTarget } from '../../kernel'
import type { TocItem } from 'foliate-js/view.js'

import {
  BRIGHTNESS,
  CONTRAST,
  measureForStep,
  pageMargins,
  ICON,
  proseGrid,
  stepAt,
  stepIndexForSize,
} from '../../kernel/core/metrics'
import type { RemoteContent } from './content'
import { browserPositions, type ReadingPositions } from './positions'
import { startingPlace, type RemotePositions } from './remotePositions'
import type { MarkRef, MarksStore } from './marks'
import styles from './Reader.module.css'

/**
 * A book, read in a browser (phase 18).
 *
 * ## The same reader, not a second one
 *
 * This mounts `FoliateView` — the component the desktop mounts. That was
 * impossible until `bookVault.ts`'s Tauri binding moved out: the reader reaches
 * `bookFolder`, which imports `extensionFor` from the vault, which imported the
 * filesystem plugin. A browser has no such plugin, so the whole subtree was out
 * of reach through one value import nothing on that path ever called.
 *
 * Writing a second reader instead would have been the expensive answer to a
 * four-line problem, and every feature after it would have been built twice.
 *
 * ## Where the bytes come from
 *
 * An EPUB is assembled into a `File` and handed over whole, because a zip's
 * central directory is at the end and foliate walks the archive freely. A PDF
 * is handed a RANGE TRANSPORT instead, so pdf.js asks the shelf for the byte
 * ranges of the page it is drawing — the difference between opening a 300 MB
 * scanned book and downloading one. `content.locate` says which, and gives the
 * length the transport cannot work without.
 *
 * ## What this surface has, and what it has not
 *
 * ⚠️ THIS SECTION SAID "there are no settings here" AND "marks, search … are
 * likewise absent", and by the time anyone read it all three were mounted
 * below. A description of a surface that has grown past it is worse than none:
 * it is the thing a reader of this file trusts instead of scrolling.
 *
 * There ARE settings, kept in this browser's own storage rather than the
 * desktop's reducer — `browserSettings` over `WEB_SETTINGS`, a subset of
 * `KERNEL_SETTINGS`, so the two cannot disagree about what a theme may be. The
 * tools sheet carries four tabs: highlights, search, contents and settings.
 * Marks are read through the shelf's `mark.list`.
 *
 * What is genuinely absent: the RULER, reading aloud, and every mark MUTATION
 * — a browser session holds a read grant, so `canWrite` is false and the
 * highlight, note and delete controls are not drawn. Stats too: nothing here
 * measures reading time.
 */

export interface ReaderProps {
  readonly content: RemoteContent
  readonly bookId: string
  /** What the shelf called it — the parser routes on this suffix. */
  readonly name: string
  readonly onClose: () => void
  /** Injected so a test needs no browser storage. */
  readonly positions?: ReadingPositions
  /**
   * The shelf's copy of the position (WI-20.30, D7). Absent, the book opens
   * where this device left it and nothing travels — a host with no write
   * grant. Present, the book opens at whichever of the two places is newer,
   * and every settled turn is written back through `book.position`.
   */
  readonly remote?: RemotePositions
  /**
   * The shelf's marks, or null when this host has none.
   *
   * Absent means the Notes control is not drawn — the same convention as
   * `onAddBooks` on the shelf. It is created beside the channel in
   * `main.web.tsx`, not here, because one store per channel is what keeps a
   * re-render from re-reading every mark on the shelf.
   */
  readonly marks?: MarksStore | null
  /**
   * A book's title by id, for marks that belong to another book.
   *
   * Without it every cross-book row reads "Another book", which is honest and
   * useless — the shelf knows all 1 961 titles and this surface does not, so
   * the answer is passed in rather than looked up.
   */
  readonly titleOf?: (bookId: string) => string | undefined
  /**
   * Whether this session may write marks. A browser's grant is READ by
   * design — see `SelectionBar` — so this is false until the shelf decides
   * otherwise, and the selection bar draws Copy alone.
   */
  readonly canWrite?: boolean
}



export function Reader({ content, bookId, name, onClose, positions, remote, marks = null, titleOf, canWrite = false }: ReaderProps) {
  /* ONE STORE FOR THE LIFE OF THE COMPONENT. Built in a ref rather than on
   * every render, because `browserPositions` touches `localStorage`, which is a
   * getter that THROWS in some configurations. */
  const store = useRef<ReadingPositions | null>(null)
  store.current ??= positions ?? browserPositions()

  /**
   * WHERE THIS BOOK WAS LEFT, READ ONCE.
   *
   * `FoliateView`'s own note is emphatic: `lastLocation` is read when the book
   * finishes parsing and must never be depended on, because the value CHANGES
   * as the reader reads — "a book that reopened every time it did would be a
   * book that could not be read at all". Captured at mount, in state, so the
   * prop is stable for as long as the book is open.
   */
  const [start, setStart] = useState<{ readonly decided: boolean; readonly cfi: string | null }>(() =>
    remote === undefined ? { decided: true, cfi: store.current?.get(bookId) ?? null } : { decided: false, cfi: null },
  )
  const lastLocation = start.cfi

  /**
   * WHICH PLACE, when there is a shelf to ask (WI-20.30). The shelf's stamp
   * against this device's clock — newer wins — decided BEFORE the book is
   * handed to the renderer, because `lastLocation` is read once when the
   * book finishes parsing and a position that arrives after that is a
   * position nobody has. The read costs one `book.get` over the same link the
   * bytes take, so it cannot make the book slower to open than the shelf
   * already is; a shelf that cannot be asked at all leaves this device's
   * place standing, which is what it would have opened at before.
   *
   * When the shelf's is newer this device's copy follows it, so the next
   * open with the shelf asleep starts from the same place. When THIS
   * device's is newer — read here, closed before the write could land — the
   * shelf is told now rather than at the next turn.
   */
  useEffect(() => {
    if (remote === undefined) return
    let live = true
    const local = store.current?.held(bookId) ?? null
    void remote.read(bookId).then(
      (shelf) => {
        if (!live) return
        const place = startingPlace(local, shelf)
        if (place.from === 'shelf' && place.cfi !== null) store.current?.set(bookId, place.cfi)
        if (place.from === 'device' && place.cfi !== null && (shelf === null || shelf.cfi !== place.cfi)) {
          remote.write(bookId, place.cfi, undefined)
        }
        setStart({ decided: true, cfi: place.cfi })
      },
      () => {
        if (live) setStart({ decided: true, cfi: local?.cfi ?? null })
      },
    )
    return () => {
      live = false
    }
  }, [remote, bookId])

  /* WHAT IS PENDING GOES WHEN THE BOOK CLOSES — the desktop flushes its tick
     on close for the same reason. Caught, because this is a cleanup: a final
     write that fails must be SAID somewhere, and an unhandled rejection on
     unmount is said nowhere. */
  useEffect(
    () => () =>
      void remote?.flush().catch((error: unknown) => {
        console.error('paper: the final position write did not land', error)
      }),
    [remote],
  )

  /* OPENING A BOOK IS READING IT, and the eviction order has to hear about it.
   *
   * `set` writes `at` only when the cfi CHANGES, so a reader who reopens a
   * favourite at the same line never refreshed its timestamp: the book they had
   * open kept the stamp of their last page turn, aged past the 500-entry cap,
   * and was evicted while they were reading it. `touch` says "read now" without
   * claiming to have moved. Once per book, on open. */
  useEffect(() => {
    store.current?.touch(bookId)
  }, [bookId])
  /**
   * WHAT WENT WRONG, WHERE THE READER IS LOOKING.
   *
   * ⚠️ This was consumed by `SearchPanel` alone — a pane behind a centre tap
   * and a tab. So a dropped channel, a range read that failed, or a renderer
   * that could not open the book left a BLANK PAGE with the explanation folded
   * inside a panel nobody had reason to open. The one failure this surface
   * cannot afford to be quiet about is the one where there is nothing to look
   * at.
   *
   * It is drawn on the reading surface now, and still handed to the search
   * panel, which uses it for its own "this book never finished parsing" case.
   */
  const [problem, setProblem] = useState<string | null>(null)

  /* WHICH PATH THIS BOOK TAKES — `useBookSource`, which is where the range
     transport, the whole-file fallback and the unmeasurable-PDF case live. It
     was two hundred lines of this function and has nothing to do with the rest
     of it. */
  const opening = useBookSource(content, bookId, name, setProblem)
  /**
   * ⚠️ **A FOOTNOTE LINK DID NOTHING AT ALL HERE.**
   *
   * `ReaderSession` intercepts a note's link — `preventDefault`, so foliate does
   * not navigate — renders the note into a view of its own, and parks that view
   * off screen until a host says where to put it. This surface passed `ignore`
   * and never said, so a reader tapping a superscript got: no navigation, no
   * note, nothing. The extraction had worked and it was rendered a hundred
   * thousand pixels to the left.
   *
   * The desktop's own popover is mounted below rather than a second one written
   * for this screen: its header spends a page on four measurements — which box
   * an anchor is measured in, which box the note renders into, why they are not
   * the same box — and every one of them was got wrong once already.
   */
  const [footnote, setFootnote] = useState<FootnoteRender | null>(null)
  /**
   * ⚠️ **THE STAGE HAS TO BE STATE, NOT A REF READ DURING RENDER.**
   *
   * `stageEl.current` is null on the first render — the ref is attached after
   * it — and a ref changing does not re-render, so a popover handed
   * `stage={stageEl.current}` gets null for ever. `FootnotePopover` needs a box
   * to place against and treats "no stage" as `detached`, which parks the note
   * off screen: the same invisible note, arrived at a different way. The
   * desktop's reader holds its stage in state for exactly this reason.
   */
  const [stageBox, setStageBox] = useState<HTMLDivElement | null>(null)
  /**
   * THE BOOK'S OWN TABLE OF CONTENTS (WI-19.9).
   *
   * `FoliateView` has always raised `onToc`; this client passed `ignore`, so a
   * reader on a phone could turn pages one at a time and had no other way to
   * move through a book. `pane/Contents.tsx` is 61 lines, browser-safe, and
   * takes exactly what arrives here — the cheapest of the six panes precisely
   * because it needs no service at all.
   */
  const [toc, setToc] = useState<readonly TocItem[]>([])
  /* THE BOOK'S METADATA, which this client also threw away. `SearchPanel` uses
   * it as the signal that a book finished parsing — searching before that
   * answers "no matches" about a book that was never searched, which is a
   * definite answer and a false one. */
  const [meta, setMeta] = useState<BookMeta | null>(null)
  const takeMeta = useCallback((_generation: number, next: BookMeta) => setMeta(next), [])

  /**
   * THE READER'S PREFERENCES, kept in this browser.
   *
   * One store for the life of the component, like `positions` above and for the
   * same reason: `localStorage` is a getter that throws in some configurations,
   * so it is reached once rather than on every render.
   */
  const prefs = useRef<ReturnType<typeof browserSettings> | null>(null)
  prefs.current ??= browserSettings()
  const prefsStore = prefs.current
  const settings = useSyncExternalStore(prefsStore.subscribe, prefsStore.getSnapshot)
  /* THE PERSISTENCE FLAG AND THE FACES MOVED with the panel that reads them —
     see `ReadingSettings`, which the You tab mounts too. This subscription
     stays: the reading surface itself renders from these values. */
  /* READ THROUGH `get`, not out of the snapshot. The snapshot is a bag of
   * unknowns by key; `get` is what applies each setting's own validator, so a
   * value hand-edited into `localStorage` cannot reach the renderer. The
   * snapshot is subscribed to only so a change re-renders. */
  void settings
  const stored = prefsStore.get(WEB_SETTINGS.theme)
  const themeFollowsOs = prefsStore.get(WEB_SETTINGS.themeFollowsOs)
  /**
   * THE THEME THAT IS ACTUALLY APPLIED, which was not the same as the one
   * stored.
   *
   * `themeFollowsOs` was read out of the store and handed to `Settings` so the
   * row could draw its state — and consulted nowhere else. Nothing on this
   * client subscribed to `prefers-color-scheme`, so "Follow system appearance"
   * was a switch that stored a boolean and changed nothing on the page. It is
   * on by DEFAULT (design system §05), which means a reader whose system is
   * dark opened a white book and had no way to understand why the setting they
   * were already using was not working.
   *
   * `usePrefersDark` is the kernel's own hook, the one `App.tsx` has used since
   * §05 landed — a second `matchMedia` here could disagree with it, and the two
   * would then differ on exactly one machine each.
   */
  const prefersDark = usePrefersDark()
  const theme = themeFollowsOs ? (prefersDark ? 'night' : 'paper') : stored
  const typeface = prefsStore.get(WEB_SETTINGS.typeface)
  const textSize = prefsStore.get(WEB_SETTINGS.textSize)
  const spacing = prefsStore.get(WEB_SETTINGS.spacing)
  const align = prefsStore.get(WEB_SETTINGS.align)
  const readingStyle = prefsStore.get(WEB_SETTINGS.readingStyle)
  /**
   * THE CLIENT'S OWN CHROME FOLLOWS THE THEME TOO.
   *
   * `FoliateView` gets `theme` and colours the BOOK; the bar, the sheets and
   * the shelf read the design system's tokens, which this publishes onto the
   * root. Without it Night gives a dark page inside a white bar — a setting
   * half-applied, which reads as a bug rather than as a choice.
   *
   * Brightness and contrast are the kernel's defaults: this host offers neither
   * control (see the `Settings` mount below), so it must not pretend to apply
   * a value nobody chose.
   */
  useAppPalette(document.documentElement, theme, BRIGHTNESS.def, CONTRAST.def)

  /* THIS BOOK'S HIGHLIGHTS, drawn when the store has them. The store holds
   * every book's marks; the page wants this one's, as anchors. */
  useEffect(() => {
    if (marks === null) {
      /* A STORE THAT WENT AWAY TAKES ITS HIGHLIGHTS WITH IT. Between
       * channels the stores are null; leaving `drawn` standing painted the
       * OLD store's anchors over a session the new store has not answered
       * yet. */
      setDrawn([])
      return
    }
    const mine = () =>
      /* `marks.all` is annotations only — bookmarks are split off at the
       * store's door — so every one here can be drawn. The anchor carries
       * tint and style because the painter runs with the annotation and
       * nothing else in hand. */
      setDrawn(
        marks.all
          .filter((m) => m.bookId === bookId)
          .map((m) => ({ cfi: m.cfi, sectionIndex: m.sectionIndex, kind: m.kind, tint: m.tint, style: m.style })),
      )
    mine()
    return marks.subscribe(mine)
  }, [marks, bookId])

  /* WHICH ENTRY THE READER IS IN. `ReaderPosition` has carried `chapterHref`
   * all along — "labels repeat across a book, hrefs do not" — and this client
   * kept only the CFI. Without it every duplicate label would read as current,
   * or none would. */
  const [here, setHere] = useState('')
  /**
   * ONE SHEET, with tabs — not four sheets with four buttons.
   *
   * The mockup's "Tools sheet" is the desktop side pane as a single bottom
   * sheet with icon tabs at its foot; the reader's chrome carries NO controls
   * at all. So the bar of four icons is gone, and so is the rule about "one
   * sheet at a time" — there is only one.
   */
  const [tool, setTool] = useState<'contents' | 'search' | 'notes' | 'settings' | null>(null)
  /**
   * CHROME HIDES, §06: "Hides on scroll, tap centre to show." The title bar
   * and the progress footer share this. It starts shown so a reader who just
   * opened a book can see where the way back is, and hides on the first turn.
   */
  const [chrome, setChrome] = useState(true)
  const [fraction, setFraction] = useState(0)
  const takeToc = useCallback((_generation: number, next: readonly TocItem[]) => setToc(next), [])
  /* The stage's width decides the measure, and a phone rotates. */
  const [stage, setStage] = useState(() => Math.min(window.innerWidth, 1200))
  /** The reading area, which is wider than the book — see `watchTaps`. */
  const stageEl = useRef<HTMLDivElement | null>(null)
  /* ONE REF CALLBACK, not a new one per render: React detaches and
   * reattaches a callback ref whose identity changed, calling it with `null`
   * and then the node on EVERY commit — two `setStageBox` calls and an extra
   * pass each time, for a stage that had not moved. */
  const takeStage = useCallback((node: HTMLDivElement | null) => {
    stageEl.current = node
    setStageBox(node)
  }, [])

  useEffect(() => {
    const onResize = () => setStage(Math.min(window.innerWidth, 1200))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])


  /* THE SAME ARITHMETIC THE DESKTOP DOES, from the same module — the measure
   * the grid settled on rather than the one the step asked for, because the
   * renderer draws over the gutter otherwise. */
  /* THE SIZE IS STORED IN PIXELS, and the renderer wants a step. `stepAt` is
   * the kernel's own mapping — see `KERNEL_SETTINGS.textSize`, which explains
   * why an index was the wrong thing to persist. */
  const stepIdx = useMemo(() => stepIndexForSize(textSize), [textSize])
  const grid = useMemo(() => proseGrid(stage, false, measureForStep(stepIdx)), [stage, stepIdx])

  const ignore = useCallback(() => {}, [])

  /**
   * A LINK THAT LEAVES THE BOOK, and why `ignore` was the wrong handler.
   *
   * This prop was `ignore` — a function that returns without touching the
   * event. foliate treats an uncancelled `external-link` as permission and does
   * `globalThis.open(href, '_blank')`; `epub.js` calls a link external when its
   * scheme is anything but `blob:`, so `javascript:` and `data:` arrive on this
   * path too. An EPUB is a zip a stranger wrote, and the browser client handed
   * its hrefs straight to the platform.
   *
   * The desktop reader has cancelled this event and consulted `externalTarget`
   * since `open_external` was written; the same pure rule is used here rather
   * than a second one. What differs is only the last step: the desktop asks
   * Rust to launch a browser, and this IS one.
   *
   * `noopener,noreferrer` is not decoration. Without `noopener` the opened tab
   * gets `window.opener` and can navigate this one — a signed-in shelf replaced
   * by a page of the book's choosing, which is the whole of tabnabbing.
   */
  const followExternalLink = useCallback((detail: { href_: string }, event: Event) => {
    /* CANCELLED FIRST, unconditionally. Every early return below leaves
       foliate's fallback armed if this has not already run. */
    event.preventDefault()
    /* `href_`, the RAW attribute — foliate's own name, and unresolved because
       an external target is relative to nothing inside the package. Same field
       the desktop reads in `App.tsx`. */
    const target = externalTarget(detail.href_)
    if (target.kind === 'refuse') {
      setProblem(target.why)
      return
    }
    globalThis.open(target.url, '_blank', 'noopener,noreferrer')
  }, [])

  /**
   * THE PAGE TURN, which this surface shipped without.
   *
   * `onPageIntent` was a no-op, so a book opened and could not be advanced: a
   * tap did nothing, a swipe did nothing, the arrow keys did nothing. The
   * reader looked complete and was a single page — found by trying to turn one,
   * which no test here could have done.
   *
   * The navigator arrives from the session once the book is open, so it lives
   * in a ref rather than in state: it is not rendered, and setting state on it
   * would re-render the whole surface the moment a book finished parsing.
   */
  const navigator = useRef<{
    next: () => void
    prev: () => void
    goLeft: () => void
    goRight: () => void
    goTo: (target: string) => void
    search: (query: string, signal: AbortSignal) => AsyncGenerator<SearchHit>
    deselect?: () => void
    /* THE NOTE'S OWN VIEW, which the session builds and parks until a host says
       where to put it. Optional like `deselect`: this ref is declared as the
       members this surface READS, so a member added here without a use would be
       a claim about the navigator that nothing checks. */
    setFootnoteMount?: (mount: HTMLElement | null, within: HTMLElement | null) => void
    closeFootnote?: () => void
  } | null>(null)

  /**
   * The box notes render into, HELD AND RE-APPLIED rather than forwarded.
   *
   * ⚠️ **THE POPOVER REGISTERS ON MOUNT, WHICH IS BEFORE ANY BOOK IS OPEN** —
   * so there is no navigator yet and a straight `navigator.current?.…` is a
   * no-op that silently never happens. The note then renders into the session's
   * own fallback, off screen, and the popover shows an empty box: the
   * extraction worked and nobody can see it. `useBook.ts` carries the same two
   * refs for the same reason, and says so in the same words.
   */
  const footnoteMount = useRef<HTMLElement | null>(null)
  const footnoteSpace = useRef<HTMLElement | null>(null)
  const takeFootnoteMount = useCallback((mount: HTMLElement | null, within: HTMLElement | null) => {
    footnoteMount.current = mount
    footnoteSpace.current = within
    navigator.current?.setFootnoteMount?.(mount, within)
  }, [])

  const takeNavigator = useCallback((_generation: number, next: unknown) => {
    navigator.current = next as typeof navigator.current
    /* RE-APPLIED HERE, which is the half a straight forward cannot do: this is
       the first moment there is anything to tell. */
    navigator.current?.setFootnoteMount?.(footnoteMount.current, footnoteSpace.current)
  }, [])

  /* MARKING A PASSAGE, and copying one — `useMarking`, which owns the
     selection, the tint, the marks drawn on the page and the two things a
     reader can do with a selection. Nothing else in this component touches any
     of them, which is what made it the one boundary here anybody could draw. */
  const { selection, setSelection, tint, setTint, drawn, setDrawn, highlight, copySelection } =
    useMarking({
      marks,
      bookId,
      toc,
      here,
      onProblem: setProblem,
      deselect: useCallback(() => navigator.current?.deselect?.(), []),
    })

  /* FOUR INTENTS, TWO PAIRS, and they are not interchangeable. A horizontal
   * gesture names a SIDE and foliate resolves which page that is from the
   * book's own direction; a vertical one names a DIRECTION OF TRAVEL, which
   * needs no resolving — routing it through goLeft/goRight would reverse the
   * wheel in a right-to-left book. The desktop's reader makes the same
   * distinction, in the same words. */
  const turn = useCallback((intent: 'left' | 'right' | 'next' | 'prev') => {
    const nav = navigator.current
    if (nav === null) return
    if (intent === 'left') nav.goLeft()
    else if (intent === 'right') nav.goRight()
    else if (intent === 'next') nav.next()
    else nav.prev()
  }, [])

  /* TURNING A PAGE BY TAPPING — `useTapToTurn`, which holds the wiring: which
     targets get a listener, which coordinate space each measures in, and how a
     listener is taken off a document that has gone. A hundred and seventy lines
     of this function, and nothing else in it reads a pointer event. */
  const { watchDocument } = useTapToTurn({
    stage: stageEl,
    turn,
    hideChrome: useCallback(() => setChrome(false), []),
    toggleChrome: useCallback(() => setChrome((was) => !was), []),
  })


  /* SAVED ON EVERY RELOCATE, which is every page turn and every resize. The
   * store refuses a write when the position has not moved, so a turn that lands
   * on the same CFI costs nothing — and a null cfi never overwrites a good
   * position, which the fixed-layout renderer would otherwise do. */
  const remember = useCallback(
    (_generation: number, position: { cfi: string | null; chapterHref?: string; fraction?: number }) => {
      store.current?.set(bookId, position.cfi)
      /* AND THE SHELF, debounced there: a run of turns is one write, after
         the reader has settled — the desktop's own tick. */
      if (position.cfi !== null && position.cfi !== '') remote?.write(bookId, position.cfi, position.fraction)
      if (typeof position.chapterHref === 'string') setHere(position.chapterHref)
      if (typeof position.fraction === 'number') setFraction(position.fraction)
    },
    [bookId, remote],
  )

  /**
   * THE FIVE FIELDS `SearchPanel` NEEDS, over what this client already has.
   *
   * `navigator` holds `search` and `goTo`; `opening` says what was opened and
   * `meta` says when it finished parsing. Wrapped in callbacks that read the
   * ref at call time rather than closing over it — the navigator arrives after
   * the first render, and a captured null would search nothing forever.
   */

  const searchable = useMemo(
    () => ({
      /* A CAST, CONFINED AND SAID: a ranged PDF's source is not a `File`,
       * but `SearchPanel` provably reads `source` for PRESENCE only (its
       * `searchable` gate) — the honest fix is widening `Book['source']` in
       * the kernel's types, which is not this file's to change. */
      source: opening.kind === 'reading' ? (opening.source as File) : null,
      meta,
      error: problem,
      /* THE NAVIGATOR CAN ARRIVE AFTER THE SHEET DOES. It comes from the
       * session once the book has parsed, and the tools sheet is reachable
       * before that — an empty generator here answered "0 in this book" to a
       * search of a book that had not finished opening, which is a definite
       * answer and a false one. So a search made early WAITS for the
       * navigator rather than answering nothing, and aborts with the signal
       * like any other. */
      search: async function* (query: string, signal: AbortSignal) {
        let nav = navigator.current
        while ((nav === undefined || nav === null) && !signal.aborted) {
          await new Promise((r) => setTimeout(r, 100))
          nav = navigator.current
        }
        if (nav === undefined || nav === null) return
        yield* nav.search(query, signal)
      },
      goTo: (target: string) => navigator.current?.goTo(target),
    }),
    [opening, meta, problem],
  )

  if (opening.kind === 'failed') {
    return (
      <main className={styles.screen}>
        <p className="paper-cap-hint">{opening.why}</p>
        <button className="paper-cap-button" type="button" onClick={onClose}>
          Back to the shelf
        </button>
      </main>
    )
  }

  /* NO `ref` ON THE MAIN ELEMENT. One was held here and its value never read —
   * a handle kept for a use that never arrived, which reads to the next person
   * as something depending on it. */
  return (
    <main className={styles.screen}>
      {/* THE CHROME, and only the way back and the title — no controls. The
          mockup's Reader has a hidden tab bar, a progress foot and nothing
          else: every pixel of chrome is a pixel of page lost at 393px. Tools
          come from a centre tap. */}
      {/* ⚠️ `inert`, NOT ONLY TRANSPARENT.
          `data-visible='false'` sets `opacity: 0` and `pointer-events: none`,
          which stops a finger and stops nothing else: the Shelf and Tools
          buttons stayed in the tab order and stayed in the accessibility tree,
          so a keyboard reader tabbed into invisible controls and a screen
          reader announced a bar that is not there. `inert` removes both, and
          the browser restores them when it goes. */}
      <header className={styles.bar} data-visible={chrome} inert={!chrome}>
        <button className="paper-cap-button" type="button" onClick={onClose}>
          ‹ Shelf
        </button>
        {/* THE TITLE AS THE SHELF SENT IT.
             This was `name.replace(/\.[^.]+$/, '')` — strip everything after
             the last dot — which was written when the header showed a FILENAME.
             It shows a title: `book.list` sends the work's name, and the shelf
             derives a filename from it rather than the other way round. So
             "Mrs. Dalloway" rendered as "Mrs", and every title with a dot in it
             lost its tail. Nothing here has an extension to remove. */}
        <span className={styles.title}>{name}</span>
        <button
          className="paper-cap-button"
          type="button"
          aria-label="Tools"
          title="Tools"
          aria-expanded={tool !== null}
          /* CONTENTS ONLY WHEN THERE ARE CONTENTS. The tab itself is hidden
             for a book with no TOC, so landing the sheet on `contents` there
             opened a pane no tab names — a blank sheet during loading and
             for TOC-less books. Search is the tab every book has. */
          onClick={() => setTool((was) => (was === null ? (toc.length > 0 ? 'contents' : 'search') : null))}
        >
          <List size={ICON.control} strokeWidth={ICON.stroke} />
        </button>
      </header>

      {/* WHAT WENT WRONG, ON THE PAGE. See the note on `problem`: this used to
          reach `SearchPanel` alone, so a dropped channel or a failed range read
          left a blank page with its explanation folded inside a pane nobody had
          reason to open. `role="alert"` because it arrives after the reader has
          already started looking at nothing. */}
      {problem !== null && (
        <div className={styles.problem} role="alert">
          <span>{problem}</span>
          <button className="paper-cap-button" type="button" onClick={() => setProblem(null)}>
            Dismiss
          </button>
        </div>
      )}

      <ProgressFooter fraction={fraction} visible={chrome && selection === null} />

      {/* THE BAR NEEDS A SELECTION, NOT A MARKS STORE. Gated on both, a
          reconnect gap (stores are null between channels) took COPY away —
          the one selection verb this read-only client actually owns. The
          write verbs still require the store they write to. */}
      {selection !== null && (
        <SelectionBar
          text={selection.text}
          tint={tint}
          onTint={setTint}
          onHighlight={canWrite && marks !== null ? () => highlight('') : undefined}
          /* A NOTE is a highlight with words. There is no note editor on this
             surface yet; the mark is made and the note is written in Notes,
             which is where the desktop writes them too. */
          onNote={
            canWrite && marks !== null
              ? () => {
                  highlight('')
                  setTool('notes')
                }
              : undefined
          }
          onCopy={copySelection}
        />
      )}

      {tool !== null && (
        <BottomSheet
          label="Tools"
          height={0.82}
          onDismiss={() => setTool(null)}
          foot={
            <>
          {/* THE TABS AT THE FOOT, as the mockup draws them: 40px, the active one
              on `--wash`. Notes only when this host has marks. */}
          <nav className={styles.toolTabs} aria-label="Tools">
            {toc.length > 0 && (
              <button type="button" className={styles.toolTab} aria-pressed={tool === 'contents'} aria-label="Contents" onClick={() => setTool('contents')}>
                <List size={ICON.tab} strokeWidth={ICON.stroke} />
              </button>
            )}
            <button type="button" className={styles.toolTab} aria-pressed={tool === 'search'} aria-label="Search" onClick={() => setTool('search')}>
              <SearchIcon size={ICON.tab} strokeWidth={ICON.stroke} />
            </button>
            {marks !== null && (
              <button type="button" className={styles.toolTab} aria-pressed={tool === 'notes'} aria-label="Notes" onClick={() => setTool('notes')}>
                <Highlighter size={ICON.tab} strokeWidth={ICON.stroke} />
              </button>
            )}
            <button type="button" className={styles.toolTab} aria-pressed={tool === 'settings'} aria-label="Reading" onClick={() => setTool('settings')}>
              <Type size={ICON.tab} strokeWidth={ICON.stroke} />
            </button>
          </nav>
            </>
          }
        >
          <div className={styles.toolBody}>
            {tool === 'contents' && (
              <Contents
                toc={toc}
                currentHref={here}
                onGoTo={(href) => {
                  navigator.current?.goTo(href)
                  setTool(null)
                }}
              />
            )}
            {tool === 'search' && <SearchPanel book={searchable} />}
            {tool === 'notes' && marks !== null && (
              /* THE MUTATIONS RIDE ON `canWrite`, the switch this surface
                 already has — the same one `SelectionBar` uses to draw Copy
                 alone. They used to be passed unconditionally, and `canWrite`
                 is false on every browser session there is: `mark.remove` and
                 `mark.set` are `mark:write`, the webhost pump grants only
                 `readingGrant`, so a delete removed the row optimistically, was
                 refused, and put it back, and a note was typed, committed, and
                 thrown away. Marginalia draws neither control without them.

                 Conditional rather than deleted, because `canWrite` is the ONE
                 place the decision belongs. The day the shelf widens that
                 predicate deliberately, these come back with it and nothing
                 here needs editing. */
              <Marginalia
                marks={canWrite ? marks : { ...marks, setNote: undefined }}
                bookId={bookId}
                platform="web"
                {...(canWrite
                  ? {
                      onDelete: (mark: MarkRef) => marks.remove(mark),
                      onDeleteBookmark: (mark: MarkRef) => marks.remove(mark),
                    }
                  : {})}
                titleOf={(id) => (id === bookId ? name : titleOf?.(id))}
                onShelf={(id) => id === bookId}
                onGoTo={(target) => {
                  navigator.current?.goTo(typeof target === 'string' ? target : target.cfi)
                  setTool(null)
                }}
              />
            )}
            {tool === 'settings' && <ReadingSettings settings={prefsStore} />}
          </div>
        </BottomSheet>
      )}

      <div className={styles.stage} ref={takeStage}>
        <FoliateView
          /* NOT UNTIL THE PLACE IS DECIDED — see `start`. */
          file={opening.kind === 'reading' && start.decided ? opening.source : null}
          generation={0}
          style={readingStyle}
          stepIdx={stepIdx}
          measure={grid.measure}
          pageMargins={pageMargins(grid)}
          theme={theme}
          typeface={typeface}
          spacing={spacing}
          align={align}
          brightness={stepAt(BRIGHTNESS, BRIGHTNESS.def)}
          contrast={stepAt(CONTRAST, CONTRAST.def)}
          animated
          paginated
          lastLocation={lastLocation}
          onToc={takeToc}
          onRelocate={remember}
          onDocument={watchDocument}
          onMeta={takeMeta}
          onCover={ignore}
          onError={(_generation, message) => setProblem(message)}
          onNavigator={takeNavigator}
          marks={drawn}
          onSelection={setSelection}
          onMarkDrawn={ignore}
          onLink={ignore}
          onExternalLink={followExternalLink}
          onFootnote={setFootnote}
          onFileDropped={ignore}
          onPageIntent={turn}
          onFixedLayout={ignore}
          onDirection={ignore}
        />

        {/* IN THE STAGE, which is the box the session measures a note's anchor
            against — see `FootnotePopover.onMount`, which is emphatic that the
            two boxes are different and that deriving one from the other is what
            broke it. `column` is null here: this client draws no margin notes,
            so there is nothing beside the measure for a note to hang over. */}
        <FootnotePopover
          note={footnote}
          stage={stageBox}
          column={null}
          onMount={takeFootnoteMount}
          onCopy={copySelection}
          onDismiss={() => {
            /* THE SESSION OWNS THE VIEW. Clearing the state alone would leave
               the note's iframe and renderer alive behind an empty box. */
            navigator.current?.closeFootnote?.()
            setFootnote(null)
          }}
        />
      </div>
    </main>
  )
}
