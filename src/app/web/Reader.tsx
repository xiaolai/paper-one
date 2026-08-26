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
  Marginalia,
  SearchPanel,
  Settings,
  useAppPalette,
  usePrefersDark,
  offeredFaces,
  presentFaces,
} from '../../kernel/ui/browser'
import { WEB_SETTINGS, browserSettings } from './settings'
import type { BookMeta, SearchHit, SelectionSnapshot, MarkAnchor } from '../../kernel/ui/browser'
import { externalTarget } from '../../kernel'
import type { MarkTint } from '../../kernel'
import type { TocItem } from 'foliate-js/view.js'

import {
  BRIGHTNESS,
  CONTRAST,
  measureForStep,
  pageMargins,
  ICON,
  proseGrid,
  readingStep,
  stepAt,
  stepIndexForSize,
} from '../../kernel/core/metrics'
import type { RemoteContent } from './content'
import { browserPositions, type ReadingPositions } from './positions'
import type { MarkRef, MarksStore } from './marks'
import { stagePoint, tapIntent } from './tapToTurn'
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

/**
 * Whether a tap landed on something the page already handles.
 *
 * ⚠️ **THE LIST WAS `a, button, input, [role="button"]`**, and a book is a
 * document a stranger wrote. `<select>`, `<textarea>`, `<summary>`, a media
 * element with controls, anything `contenteditable` and every other ARIA
 * widget role were all absent — so interacting with one of those inside a book
 * turned the page at the same time. Choosing from a dropdown in an embedded
 * form advanced the reader out of it.
 *
 * `closest` walks up, so a tap on a `<span>` inside a `<button>` is caught by
 * the button. `[role]` covers the widget roles as a class rather than by
 * enumeration; a role is only ever put on something meant to be interacted
 * with, and treating one as inert is the direction that turns pages by
 * accident.
 */
const INTERACTIVE =
  'a[href], button, input, select, textarea, summary, label, [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls], [role]'

function onInteractive(target: EventTarget | null): boolean {
  return (target as Element | null)?.closest?.(INTERACTIVE) != null
}

/** What is known about the book while it is being fetched. */
type Opening =
  | { readonly kind: 'locating' }
  /* A `File` for an EPUB, or a ranged source for a PDF. Spelled structurally
   * rather than imported: `RangedSource` lives in `formats.ts`, which is not on
   * the browser client's short list of kernel modules, and the shape is two
   * fields. `FoliateView` accepts either. */
  | { readonly kind: 'reading'; readonly source: File | { readonly range: object; readonly name: string } }
  | { readonly kind: 'failed'; readonly why: string }

export function Reader({ content, bookId, name, onClose, positions, marks = null, titleOf, canWrite = false }: ReaderProps) {
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
  const [lastLocation] = useState(() => store.current?.get(bookId) ?? null)

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
  const [opening, setOpening] = useState<Opening>({ kind: 'locating' })
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
  /* The persistence flag needs its OWN subscription — the snapshot above is
     unchanged by a refused write, so subscribing to it alone would show the
     notice one change late. See `App.tsx`. */
  const prefsPersistent = useSyncExternalStore(
    prefsStore.subscribe,
    () => prefsStore.persistent,
    () => prefsStore.persistent,
  )
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
    if (marks === null) return
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

  /* The faces this browser actually has. Probed once — it measures text. */
  const faces = useMemo(() => offeredFaces(presentFaces()), [])
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
  /** What the reader has selected, or null. Drives the selection bar. */
  const [selection, setSelection] = useState<SelectionSnapshot | null>(null)
  const [tint, setTint] = useState<MarkTint>('yellow')
  /**
   * THE MARKS DRAWN ON THE PAGE. Filled from the store for this book, then
   * grown as the reader highlights — from the shelf's ANSWER to `mark.add`,
   * which carries the real id, rather than from a guess made before the
   * write landed.
   */
  const [drawn, setDrawn] = useState<readonly MarkAnchor[]>([])
  const [fraction, setFraction] = useState(0)
  const takeToc = useCallback((_generation: number, next: readonly TocItem[]) => setToc(next), [])
  /* The stage's width decides the measure, and a phone rotates. */
  const [stage, setStage] = useState(() => Math.min(window.innerWidth, 1200))
  /** The reading area, which is wider than the book — see `watchTaps`. */
  const stageEl = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onResize = () => setStage(Math.min(window.innerWidth, 1200))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    let live = true
    setOpening({ kind: 'locating' })
    void (async () => {
      try {
        const facts = await content.locate(bookId)
        if (!live) return
        if (!facts.here) {
          setOpening({ kind: 'failed', why: 'Your library does not have this book’s pages.' })
          return
        }
        /* A PDF GOES THROUGH THE TRANSPORT — but only when the shelf could
         * measure it. pdf.js is told a length before it asks for a byte, and a
         * shelf that answers `null` has no length to give; falling back to the
         * whole file is slower and correct, which is the right way round. */
        /* THE NAME A PARSER ROUTES ON, rebuilt from what the shelf stores.
         * The shelf sends a TITLE — "Moby-Dick" — and every parser Paper uses
         * routes on the suffix; foliate rejects a name without one as an
         * unsupported type. `content.locate` knows the stored extension, which
         * is exactly what `storedBookName` does on the desktop side. */
        const filename = facts.ext === null ? name : `${name}.${facts.ext}`

        if (facts.ext === 'pdf' && facts.size !== null) {
          const { pdfRangeTransport } = await import('./pdfRange')
          const range = await pdfRangeTransport(content, bookId, facts.size, {
            onFailure: (cause) =>
              setProblem(cause instanceof Error ? cause.message : String(cause)),
          })
          if (!live) return
          setOpening({ kind: 'reading', source: { range, name: filename } })
          return
        }
        const file = await content.fileOf(bookId, filename)
        if (!live) return
        setOpening({ kind: 'reading', source: file })
      } catch (thrown) {
        if (!live) return
        setOpening({ kind: 'failed', why: thrown instanceof Error ? thrown.message : String(thrown) })
      }
    })()
    return () => {
      live = false
    }
  }, [content, bookId, name])

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
  /** Removes the last document's tap listeners — see `watchDocument`. */
  const tapCleanup = useRef<(() => void) | null>(null)

  const navigator = useRef<{
    next: () => void
    prev: () => void
    goLeft: () => void
    goRight: () => void
    goTo: (target: string) => void
    search: (query: string, signal: AbortSignal) => AsyncGenerator<SearchHit>
    deselect?: () => void
  } | null>(null)

  const takeNavigator = useCallback((_generation: number, next: unknown) => {
    navigator.current = next as typeof navigator.current
  }, [])

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

  /**
   * TAP TO TURN, attached to each book document as it loads.
   *
   * A page intent reaches `FoliateView` from ONE gesture — the wheel — and a
   * phone has none. The book is in an iframe, so a tap on it never reaches this
   * page; `onDocument` hands over the book's own `Document`, which is where the
   * listener has to go.
   *
   * Registered per document and removed when the document goes, because
   * foliate loads a new one per section and keeps neighbours alive: without the
   * teardown a book would accumulate a listener per section read.
   */
  /**
   * Attach tap-to-turn to one event target, and hand back the way to remove it.
   *
   * TWO TARGETS NEED THIS, which is why it is a function. A book's iframe is
   * narrower than the stage it sits in — 748px inside 1280px, measured — so a
   * tap near the screen edge lands on the paginator's margin and never reaches
   * the book's document at all. Attaching only there meant the most natural
   * gesture on a phone, a thumb at the very edge, did nothing.
   *
   * Events do not cross an iframe boundary, so the two listeners never both
   * fire for one tap. Each measures against ITS OWN width, and because the book
   * is centred in the stage the two agree about which side a tap was on.
   */
  const watchTaps = useCallback(
    (
      target: Document | HTMLElement,
      /** Where the release landed and how wide the page is, both in the
       *  stage's coordinates — see `stagePoint` for why not the document's. */
      placeOf: (clientX: number) => { x: number; width: number },
      selectionOf: () => string,
    ): (() => void) => {
      /**
       * THE ONE POINTER THIS GESTURE BELONGS TO.
       *
       * ⚠️ **THREE THINGS WERE WRONG WITH TRACKING A BARE COORDINATE.**
       *
       *   - `pointerId` was ignored, so a second finger's `pointerdown`
       *     overwrote the first's origin. A two-finger pinch to zoom therefore
       *     measured its travel from the wrong finger and could read as a tap.
       *   - `pointercancel` was not handled at all. The browser fires it when
       *     it takes the gesture over — a scroll, a system edge swipe — and no
       *     `pointerup` follows, so the stale origin sat there waiting to be
       *     paired with an unrelated release.
       *   - A `pointerup` with NO matching `pointerdown` was given
       *     `moved = 0` — a perfect tap. A release that entered the stage from
       *     outside, or arrived after the listener was attached mid-gesture,
       *     turned the page.
       *
       * Requiring a matching down, keyed on the id, settles all three: an
       * unmatched release is ignored rather than believed.
       */
      let downAt: { id: number; x: number; y: number } | null = null
      const onDown = (event: Event) => {
        const pointer = event as PointerEvent
        /* THE FIRST POINTER WINS, until it is released or cancelled. A second
           finger is a gesture the browser or foliate owns — a pinch, a
           two-finger scroll — and letting its press OVERWRITE the first is how
           the release of the first came to be measured from the second's
           origin, which reads as a tap wherever the fingers happened to be.
           `isPrimary` would say the same thing, and is `false` on every
           synthesized event, so this asks the question the tracking can
           actually answer. */
        if (downAt !== null) return
        downAt = { id: pointer.pointerId, x: pointer.clientX, y: pointer.clientY }
      }
      const onCancel = (event: Event) => {
        const pointer = event as PointerEvent
        if (downAt?.id === pointer.pointerId) downAt = null
      }
      const onUp = (event: Event) => {
        const pointer = event as PointerEvent
        const from = downAt
        downAt = null
        /* NO MATCHING PRESS, NO TAP. See the note on `downAt`: this used to
           fall through with `moved = 0`, which is a page turn. */
        if (from === null || from.id !== pointer.pointerId) return
        const place = placeOf(pointer.clientX)
        const intent = tapIntent({
          x: place.x,
          /* HOW FAR IT TRAVELLED, not where it ended. A drag that begins in the
           * middle and ends at the edge is a selection, not a page turn. */
          moved: Math.hypot(pointer.clientX - from.x, pointer.clientY - from.y),
          width: place.width,
          selected: selectionOf() !== '',
          /* A LINK WINS. foliate is already handling it, and turning the page
           * as well would leave the reader somewhere they did not choose. */
          onControl: onInteractive(pointer.target),
        })
        if (intent !== null) {
          /* A TURN HIDES THE CHROME — "hides on scroll", and a tap-turn is
           * this client's scroll. The bar and footer come back on the next
           * centre tap. */
          setChrome(false)
          turn(intent)
          return
        }
        /* THE MIDDLE THIRD, which `tapIntent` refuses on purpose, is where the
         * chrome is summoned — §06: "tap centre to show". Only a clean tap:
         * a drag, a selection or a tap on a link all still do nothing here. */
        if (
          place.width > 0 &&
          !onInteractive(pointer.target) &&
          selectionOf() === '' &&
          Math.hypot(pointer.clientX - from.x, pointer.clientY - from.y) <= 10
        ) {
          setChrome((was) => !was)
        }
      }
      target.addEventListener('pointerdown', onDown, { passive: true })
      target.addEventListener('pointerup', onUp, { passive: true })
      /* THE BROWSER TAKING THE GESTURE OVER. Without this the origin outlives
         the gesture and waits to be paired with an unrelated release. */
      target.addEventListener('pointercancel', onCancel, { passive: true })
      return () => {
        target.removeEventListener('pointerdown', onDown)
        target.removeEventListener('pointerup', onUp)
        target.removeEventListener('pointercancel', onCancel)
      }
    },
    [turn],
  )

  /* THE MARGINS. A tap that misses the book still asked to turn a page. */
  useEffect(() => {
    const element = stageEl.current
    if (element === null) return
    return watchTaps(
      element,
      /* Already in the stage's coordinates: this listener IS on the stage. */
      (clientX) => ({ x: clientX - element.getBoundingClientRect().left, width: element.clientWidth }),
      () => window.getSelection()?.toString() ?? '',
    )
  }, [watchTaps])

  /**
   * THE BOOK ITSELF. `onDocument` hands over each section's document as it
   * loads; foliate keeps neighbours alive, so the previous one is released
   * first or a book accumulates a listener per section read.
   */
  const watchDocument = useCallback(
    (_generation: number, doc: Document | null) => {
      tapCleanup.current?.()
      tapCleanup.current = null
      if (doc === null) return
      tapCleanup.current = watchTaps(
        doc,
        /* NOT `doc.documentElement.clientWidth` — that is every column of the
         * section laid side by side, not the page in front of the reader, and
         * dividing it into thirds turned the page backwards on every second
         * tap. `stagePoint` carries the measurement and the numbers. */
        (clientX) => {
          const stage = stageEl.current
          const frame = doc.defaultView?.frameElement
          if (stage === null || frame == null) {
            /* No stage or a document that is not framed: fall back to the
             * document's own box. Wrong for a multi-column section, but this
             * is the case that should not arise, and a tap that does nothing
             * is better than one that goes the wrong way. */
            return { x: clientX, width: doc.documentElement.clientWidth }
          }
          const stageBox = stage.getBoundingClientRect()
          return {
            x: stagePoint(clientX, frame.getBoundingClientRect().left, stageBox.left),
            width: stageBox.width,
          }
        },
        () => doc.getSelection()?.toString() ?? '',
      )
    },
    [watchTaps],
  )


  /* SAVED ON EVERY RELOCATE, which is every page turn and every resize. The
   * store refuses a write when the position has not moved, so a turn that lands
   * on the same CFI costs nothing — and a null cfi never overwrites a good
   * position, which the fixed-layout renderer would otherwise do. */
  const remember = useCallback(
    (_generation: number, position: { cfi: string | null; chapterHref?: string; fraction?: number }) => {
      store.current?.set(bookId, position.cfi)
      if (typeof position.chapterHref === 'string') setHere(position.chapterHref)
      if (typeof position.fraction === 'number') setFraction(position.fraction)
    },
    [bookId],
  )

  /**
   * THE FIVE FIELDS `SearchPanel` NEEDS, over what this client already has.
   *
   * `navigator` holds `search` and `goTo`; `opening` says what was opened and
   * `meta` says when it finished parsing. Wrapped in callbacks that read the
   * ref at call time rather than closing over it — the navigator arrives after
   * the first render, and a captured null would search nothing forever.
   */
  /**
   * HIGHLIGHT, from the selection bar.
   *
   * Sent to `mark.add` WITH its recovery context — `prefix` and `suffix` from
   * the snapshot, `chapter` from the contents — which the wire carries since
   * phase 19. The highlight is drawn from the shelf's ANSWER, which has the
   * real id, so nothing on the page claims a mark the shelf never got.
   */
  const highlight = useCallback(
    (note: string) => {
      const sel = selection
      if (sel === null || marks === null) return
      setSelection(null)
      navigator.current?.deselect?.()
      void marks
        .add({
          bookId,
          cfi: sel.cfi,
          sectionIndex: sel.sectionIndex,
          text: sel.text,
          prefix: sel.prefix,
          suffix: sel.suffix,
          note,
          tint,
          chapter: toc.find((entry) => entry.href === here)?.label ?? '',
        })
        .catch((cause: unknown) => {
          /* ⚠️ THE DRAWING USED TO HAPPEN HERE TOO, AND IT WAS THE SECOND TIME.
           *
           * `marks.add` puts the new mark in the store and notifies
           * synchronously, and the effect above rebuilds `drawn` from
           * `marks.all` on every notification — so by the time this promise
           * settled the highlight was already on the page. Appending it again
           * painted every new highlight twice, which on a `fill` tint is
           * visibly darker than the ones around it.
           *
           * The subscription is the single source now. It also handles what
           * this could not: a mark the shelf CHANGED on the way in, and one
           * that arrives from anywhere other than this button. */
          console.error('Paper: the shelf would not keep that highlight', cause)
        })
    },
    [selection, marks, bookId, tint, toc, here],
  )

  /**
   * COPY, and what happens when it does not.
   *
   * ⚠️ **THIS SWALLOWED THE FAILURE AND CLEARED THE SELECTION ANYWAY.** The
   * clipboard is absent in a non-secure context and its write can be refused
   * outright, and both were `catch(() => {})` — so Copy presented as having
   * worked while the text went nowhere AND the selection, the one thing the
   * reader could have retried from, was destroyed. Two losses from one
   * unhandled rejection.
   *
   * The selection is cleared only after a write that resolved. A failure says
   * so and leaves the text highlighted, so the reader can try again or copy it
   * by hand.
   */
  const copySelection = useCallback(() => {
    const text = selection?.text ?? ''
    if (text === '') return
    /* `window.navigator`, spelled out: this file's own `navigator` is the
     * book navigator ref, and shadowed the global. */
    const clipboard = window.navigator.clipboard
    if (clipboard === undefined) {
      setProblem('This browser will not let a page copy text. Select it and copy it yourself.')
      return
    }
    void clipboard
      .writeText(text)
      .then(() => {
        setProblem(null)
        setSelection(null)
      })
      .catch(() => {
        setProblem('That could not be copied. The selection is still there — try again.')
      })
  }, [selection])

  const searchable = useMemo(
    () => ({
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
          onClick={() => setTool((was) => (was === null ? 'contents' : null))}
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

      {selection !== null && marks !== null && (
        <SelectionBar
          text={selection.text}
          tint={tint}
          onTint={setTint}
          onHighlight={canWrite ? () => highlight('') : undefined}
          /* A NOTE is a highlight with words. There is no note editor on this
             surface yet; the mark is made and the note is written in Notes,
             which is where the desktop writes them too. */
          onNote={
            canWrite
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
            {tool === 'settings' && (
              <Settings
                theme={theme}
                themeFollowsOs={themeFollowsOs}
                typeface={typeface}
                stepIdx={stepIdx}
                spacing={spacing}
                align={align}
                style={readingStyle}
                offered={faces}
                sections={[]}
                persistent={prefsPersistent}
                onTheme={(next) => {
                  prefsStore.set(WEB_SETTINGS.theme, next)
                  prefsStore.set(WEB_SETTINGS.themeFollowsOs, false)
                }}
                onFollowOs={() => prefsStore.set(WEB_SETTINGS.themeFollowsOs, !themeFollowsOs)}
                onTypeface={(next) => prefsStore.set(WEB_SETTINGS.typeface, next)}
                onStepIdx={(next) => prefsStore.set(WEB_SETTINGS.textSize, readingStep(next).size)}
                onSpacing={(key, idx) => prefsStore.set(WEB_SETTINGS.spacing, { ...spacing, [key]: idx })}
                onAlign={(next) => prefsStore.set(WEB_SETTINGS.align, next)}
                onStyle={(key, value) => prefsStore.set(WEB_SETTINGS.readingStyle, { ...readingStyle, [key]: value })}
              />
            )}
          </div>
        </BottomSheet>
      )}

      <div className={styles.stage} ref={stageEl}>
        <FoliateView
          file={opening.kind === 'reading' ? opening.source : null}
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
          onFootnote={ignore}
          onFileDropped={ignore}
          onPageIntent={turn}
          onFixedLayout={ignore}
          onDirection={ignore}
        />
      </div>
    </main>
  )
}
