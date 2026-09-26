import type {
  Book,
  CreateOverlayDetail,
  DrawAnnotationDetail,
  ExternalLinkDetail,
  LinkDetail,
  LoadDetail,
  RelocateDetail,
  TocItem,
  View,
} from 'foliate-js/view.js'
import { reanchorPass, type PassOutcome, type PendingMark } from './reanchorPass'
import { directionOf } from './direction'
import { collectText } from './speech'
import { DEFAULT_SPEECH_SKIP, type SpeechSkipPrefs } from './speechSkip'
import type { SectionText } from './audiobook'
import { refuseBookScripts, stripScripts } from './bookScripts'
import { suppressEmptyGeneratedContent } from './generatedContent'
import { isEnlargeable, markFigures } from './markFigures'
import { type PlateDetail, plateOf, plateTargetOf } from './plate'
import { type BookLength, spineBytes, wordsInSpine } from '../../core/readingTime'
import { matteFigures } from './matteFigures'
import { markProse } from './markProse'
import { markSmallText } from './markSmallText'
import type { BookMeta, ReaderPosition } from '../../core/bookMeta'
import { isEmptySource, type BookSource } from '../../core/formats'
import type { OpenedBook } from './protection'
import { coverFrom } from '../../core/coverArt'
import { deferSnap } from './wordSnap/deferredSnap'
import { watchGestureProvenance } from './wordSnap/gestureProvenance'
import { createReflowGuard } from './wordSnap/invalidate'
import { wheelPager, type PageIntent } from './wheelPaging'
import { markContext } from './wordSnap/markContext'
import { connectedRange, rangeText } from './wordSnap/rangeText'
import { Footnotes, type FootnoteRender } from './footnotes'
import {
  attachForeign,
  attachMark,
  paintAnnotation,
  type ForeignAnchor,
  type MarkAnchor,
  type MarkPainters,
  type MarkPalette,
} from './markPaint'
import { runSearch, type SearchHit } from './bookSearch'
import { readMeta } from './readMeta'
import { flattenToc } from '../tocOrder'

/**
 * The reader's lifecycle, as a plain object.
 *
 * Startup is a chain of awaits — import the module, create the element, open
 * the book, configure the renderer, display the first section — and React can
 * unmount at any point in that chain. A bare `disposed` flag checked at each
 * step is easy to get subtly wrong and impossible to test, which is exactly
 * what the audit found: teardown could clear the view reference while an open
 * was still in flight, so the view that arrived afterwards had nothing left to
 * close it and kept its iframes, observers and listeners forever.
 *
 * Here disposal is a single latch. `dispose()` is idempotent and can be called
 * before, during, or after startup; `settle()` hands every completed step back
 * to the latch, so whichever side finishes last performs the close. None of it
 * touches React, so all of it can be asserted directly.
 *
 * ⚠️ **WHAT READS NONE OF THE SESSION'S STATE LIVES BESIDE IT, NOT IN IT.**
 * Painting a mark (`markPaint.ts`), a book's notes (`footnotes.ts`), search
 * (`bookSearch.ts`) and metadata (`readMeta.ts`) were all in this file, which
 * reached 3 710 lines. Each is handed what it needs rather than reaching into
 * the class. What stays here shares the view, the latch, the callbacks and the
 * per-document teardown — the parts that cannot be pulled apart without every
 * piece holding a copy of the latch, which is the defect above.
 */

/**
 * Is the pointer over a box the BOOK's own author made scrollable?
 *
 * A code listing or a wide table in an `overflow: auto` div is ordinary book
 * markup, and its content has to stay reachable — so an event over one belongs
 * to it, not to page turning.
 *
 * Deliberately stops at `body`. The document scroller above it is the
 * renderer's, and handing events back to that is what the flow question below
 * decides; answering it here as well would consume nothing and page nothing.
 *
 * `overflow: auto` and `scroll` only — `hidden` is scrollable via script but
 * not by a wheel, and treating it as scrollable would swallow gestures over any
 * clipped box, which is a very common thing for a book to contain.
 */
function scrollableUnder(event: WheelEvent): boolean {
  const vertical = Math.abs(event.deltaY) > Math.abs(event.deltaX)
  const delta = vertical ? event.deltaY : event.deltaX
  if (delta === 0) return false

  let node = event.target as Element | null
  for (; node && node.nodeName !== 'BODY' && node.nodeName !== 'HTML'; node = node.parentElement) {
    const style = node.ownerDocument?.defaultView?.getComputedStyle(node)
    if (!style) continue
    const overflow = vertical ? style.overflowY : style.overflowX
    if (overflow !== 'auto' && overflow !== 'scroll') continue

    const size = vertical ? node.clientHeight : node.clientWidth
    const content = vertical ? node.scrollHeight : node.scrollWidth
    const position = vertical ? node.scrollTop : node.scrollLeft
    const remaining = content - size
    if (remaining <= 1) continue
    /* Only while it can still MOVE the way the gesture asks. A box scrolled to
     * its end must hand the gesture on, or the reader is stuck at the foot of a
     * code listing with a page that will not turn. */
    if (delta > 0 ? position < remaining - 1 : position > 1) return true
  }
  return false
}

/**
 * How long after scrolling backwards a page may still arrive and open at its foot.
 *
 * A page load that a gesture caused follows it within a frame or two; anything
 * slower than this came from somewhere else. Generous rather than tight because
 * failing the check is a real cost — the reader lands at the head of the page
 * and has to scroll down through it — while passing it late costs one surprising
 * scroll position.
 */
const ENTER_AT_FOOT_MS = 1500

/**
 * Hand the main thread back — what `reanchorPass` awaits between sections.
 *
 * ⚠️ **NOT `requestAnimationFrame`, and the reason is written down elsewhere in
 * this repository already.** An occluded window stops servicing rAF —
 * `#openAtFootIfArrivedBackwards` defends against exactly that, and AGENTS.md
 * records the day it cost an investigation, because WebKit parks pdf.js's page
 * render there and the book loads, reports its page count and shows a blank
 * canvas with no error anywhere. A re-anchoring pass parked the same way would
 * simply never finish: the reader switches away mid-open and comes back to
 * marks that are still unplaced, with nothing to say why.
 *
 * `scheduler.yield()` where the engine has it — it resumes at the FRONT of the
 * task queue, so a walk that yields forty times is not forty trips behind every
 * pending timer. `setTimeout(0)` otherwise, which is throttled in a hidden tab
 * but does keep running, which is the property that matters here.
 *
 * ⚠️ **EMPTY THE EXECUTOR AND THIS PROMISE NEVER SETTLES, WHICH IS A HANG AND
 * NOT A FAILURE.** `new Promise(() => undefined)` is specified to stay pending
 * for ever, so the walk awaiting it stops there: no instructions run, Stryker's
 * hit limit — the thing that makes an infinite LOOP a deterministic detection —
 * is never reached, and the only possible answer is a wall-clock timeout that
 * repeats however long the deadline is. The covering tests DO detect it; they
 * hang with it, which is the one outcome a test cannot report.
 *
 * AGENTS.md records this whole class and the remedy it prescribes: verify by
 * hand that it genuinely cannot settle, then disable it beside the code naming
 * the column. Here that verification is the specification itself.
 */
const BREATHE = (): Promise<void> => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()
  /* Stryker disable next-line ArrowFunction: column 22 — an executor that resolves nothing leaves this promise pending for ever, so the walk hangs rather than failing */
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A live selection in the book, with its anchor already resolved. */
export interface SelectionSnapshot {
  readonly cfi: string
  readonly sectionIndex: number
  readonly text: string
  /**
   * The text on either side of the selection — see `markContext`.
   *
   * Read HERE, from the live range, because this is the only place it exists.
   * By the time a mark is stored the range is gone, and recovering the context
   * from a stored mark means re-opening the book and resolving its CFI.
   */
  readonly prefix: string
  readonly suffix: string
  /** In the BOOK document's coordinate space — translate before use. */
  readonly range: Range
}

export interface SessionCallbacks {
  /**
   * A link inside the book was followed, BEFORE foliate acts on it.
   *
   * The host is handed the detail and the event, and what it does with the
   * event decides what happens: `preventDefault()` takes the link over, and
   * leaving it alone lets foliate navigate as it always has. See `LinkDetail`.
   *
   * The session does not decide. Whether a link is a footnote to show in
   * place, or a destination to jump to with the origin recorded, is a question
   * about panels and a jump stack — neither of which a renderer session has
   * any business knowing about. This is the same boundary that keeps it from
   * touching the mark store.
   */
  onLink: (detail: LinkDetail, event: Event) => void
  /**
   * A footnote was followed, and here is the note.
   *
   * Null means the popover should close — a page turn, a new section, or the
   * session going away. The host decides where to put it and how it is
   * dismissed; the session decides only what it contains, which is the same
   * line `onLink` draws.
   */
  onFootnote: (note: FootnoteRender | null) => void
  /**
   * A plate the reader touched, for the host to show large — or null to close.
   *
   * THE SAME CONTRACT AS `onFootnote`, and for the same reason: the session
   * decides only WHAT it is and hands over a source the host document can load;
   * where it goes and how it is dismissed belong to the host.
   */
  onPlate: (plate: PlateDetail | null) => void
  /**
   * A link whose scheme leaves the book. Same contract, and the same reason
   * for existing at all: unhandled, foliate hands the raw href to
   * `globalThis.open`, and an EPUB is a zip a stranger wrote.
   */
  onExternalLink: (detail: ExternalLinkDetail, event: Event) => void
  onToc: (toc: readonly TocItem[]) => void
  onRelocate: (position: ReaderPosition) => void
  onDocument: (doc: Document | null) => void
  onMeta: (meta: BookMeta) => void
  /**
   * The book's own jacket, or null when it declares none.
   *
   * Published as a BLOB rather than written anywhere, because the session has
   * no business knowing where covers are kept — the same boundary that keeps it
   * from touching the mark store. It arrives once per open, beside the
   * metadata, which is the only moment the parsed book is in hand.
   *
   * Separate from `BookMeta` because that is plain data that gets STORED, and a
   * jacket must never enter the row: `library.json` is rewritten on every
   * position save.
   */
  onCover: (cover: Blob | null) => void
  onError: (message: string) => void
  onNavigator: (navigator: SessionNavigator | null) => void
  /**
   * The marks to draw, read afresh each time a section's overlay is built.
   *
   * A getter rather than a value because sections are created and destroyed as
   * the reader scrolls, long after the session started: a snapshot taken at
   * startup would draw the marks the book had when it opened and nothing made
   * since.
   */
  getMarks: () => readonly MarkAnchor[]
  /**
   * The passages other readers shared, already anchored HERE.
   *
   * OPTIONAL: a composition with no `circle` capability has none, and a host
   * that does not supply this draws exactly what it drew before.
   */
  getOverlays?: () => readonly ForeignAnchor[]
  /** Read at draw time, so marks follow a theme change. */
  getPalette: () => MarkPalette
  /**
   * A mark was resolved and drawn, reported with the live Range it landed on.
   *
   * This is the only place that Range is available: turning a CFI back into a
   * Range needs foliate's resolver, which is not public, and the margin marks
   * need one in order to sit beside the line they belong to. The Range stays
   * live — it tracks DOM mutations — so re-measuring it after a reflow gives
   * the new position without resolving anything again.
   */
  onMarkDrawn: (cfi: string, range: Range) => void
  /** The selection in the book changed. Null when it collapsed. */
  onSelection: (selection: SelectionSnapshot | null) => void
  /* The line above this one documented an `onMarkActivated` callback — "A drawn
     mark was clicked, identified by its CFI" — that was removed from
     `SessionCallbacks` without its comment. Left stranded, it read as the
     documentation for `onFileDropped` below, which is a different event
     entirely. Deleted rather than restored: the reader reaches a mark through
     the margin (`screens/Reader.tsx`), not by clicking the drawing. */
  /**
   * A book was dropped ON the book — see `#watchDrops`.
   *
   * The host cannot see this one: the reader is full of iframes once a book is
   * open, and a drop lands in whichever document is under the pointer.
   */
  onFileDropped: (file: File) => void
  /**
   * A wheel gesture asked for another page — see `wheelPaging`.
   *
   * A semantic event rather than the wheel events it came from. The keymap is
   * forwarded raw because keystrokes are occasional and the host owns the map;
   * wheel events arrive tens per second, and re-dispatching each one to be
   * accumulated somewhere else would be waste. The gesture is recognised where
   * the events land, and what it MEANS is still the host's to decide.
   */
  onPageIntent: (intent: PageIntent) => void
  /**
   * The book is fixed-layout, so it cannot REFLOW — but it can still scroll.
   *
   * The second half of that used to say it could not, and this work is what made
   * it false: the same Flow setting reaches `foliate-fxl` as `zoom`, where
   * `fit-width` overflows a page and the renderer scrolls it. What a fixed
   * layout cannot do is re-break text, which is what the reading ruler and the
   * measure depend on.
   *
   * Published because the app offers controls that only mean something for a
   * reflowable book, and a control wired to nothing is worse than an absent one.
   * Read from the view rather than guessed from the file extension: a PDF is
   * always fixed-layout, and an EPUB declaring `pre-paginated` is too.
   */
  onFixedLayout: (fixed: boolean) => void
  /**
   * How long the book is, in words, or null when that cannot be known.
   *
   * Published ONCE at open, beside `onFixedLayout`, from the spine the fork has
   * already parsed — see `wordsInSpine`, which carries the measurement and the
   * two routes not taken. Null for a fixed-layout book, whose section sizes are
   * progress weights rather than file sizes.
   */
  onLength: (words: BookLength) => void
  /**
   * Which way the book's text runs, once a section has rendered.
   *
   * READ OFF THE RENDERED DOCUMENT rather than off the book's metadata, and
   * that is the reliable half: what matters to anything positioning itself
   * against the page is the direction the page is ACTUALLY laid out in, which
   * is the author's stylesheet and `dir` attribute having had their say. A
   * declared `page-progression-direction` can disagree with both.
   */
  onDirection: (direction: 'ltr' | 'rtl') => void
}

/**
 * A place in the book, as everything a bookmark is made from — see
 * `ReaderSession.placeHere`.
 *
 * The same five fields a selection publishes (`SelectionSnapshot`) minus the
 * live Range, and for the same reasons: the CFI is the anchor, the section is
 * what orders and matches it, and the text with its neighbours is what lets
 * the place be recognised — and, one day, re-found in another build of the
 * same work where the CFI resolves to the wrong words. See `Mark.prefix`.
 */
export type BookmarkPlace = Omit<SelectionSnapshot, 'range'> & {
  /**
   * The TOC label for this place, from the SAME relocation as the anchor.
   *
   * Here rather than read off `ReaderPosition` by the caller, which is where it
   * came from and which left one field of the bookmark a React commit behind
   * the other four: a bookmark made while the reader was crossing a chapter
   * boundary carried this chapter's anchor under the previous chapter's name,
   * and the list is sorted and read by that name.
   */
  readonly chapter: string
}

export interface SessionNavigator {
  goTo: (target: string) => void
  /**
   * Go to a place, as a fraction of the whole book.
   *
   * ⚠️ **THE FORK HAS HAD THIS ALL ALONG AND NOTHING CALLED IT.** Every
   * navigation in Paper was by href or CFI — a link, a footnote, a Contents
   * row, a search hit — so a reader could reach a chapter and a phrase and not
   * *a place*. This is the surface a seek needs and the ONLY thing that
   * changed on the session's side.
   */
  goToFraction: (fraction: number) => void
  /** Streams hits as they are found; stops when `signal` aborts. */
  search: (query: string, signal: AbortSignal) => AsyncGenerator<SearchHit>
  /** Draw a mark immediately, without waiting for the section to re-render. */
  drawMark: (anchor: MarkAnchor) => void
  eraseMark: (anchor: MarkAnchor) => void
  /** Clear the book's selection — after acting on it, per §07. */
  deselect: () => void
  /**
   * Dismiss the note popover and release the view it was rendered in.
   *
   * ON THE NAVIGATOR because the SESSION owns that view — `FootnoteHandler`
   * builds a real `foliate-view` per note, and a host that merely stopped
   * rendering it would leave an iframe alive with nobody looking at it.
   */
  closeFootnote: () => void
  /**
   * Register the box notes render into. See `ReaderSession.setFootnoteMount` —
   * it must be one element that never moves.
   */
  setFootnoteMount: (mount: HTMLElement | null, within: HTMLElement | null) => void
  /**
   * §11's ← and →.
   *
   * Not optional chrome: a fixed-layout book — every PDF — does not scroll,
   * so these are the ONLY way through it. A scrolled EPUB hid that for a long
   * time, because scrolling worked and nobody missed the binding.
   */
  next: () => void
  prev: () => void
  /**
   * The page to the left, and to the right — in VISUAL terms.
   *
   * Distinct from `next`/`prev` and not a synonym for them: in a right-to-left
   * book the next page is the one on the LEFT. foliate resolves that through
   * the book's own `dir`, so a gesture that knows only which way the reader
   * pushed can hand the question over rather than answering it twice.
   */
  goLeft: () => void
  goRight: () => void
  /**
   * Where the reader is, as a bookmark's worth of detail — null when this
   * place cannot be pinned down. See `ReaderSession.placeHere`.
   *
   * Takes NOTHING. It took the current CFI, on the reasoning that the host
   * already holds one and reading a second copy would be a second answer to a
   * settled question. The host's copy is a React commit behind this session's,
   * so the two differ exactly while a relocation is in flight — which is when
   * a reader pressing ⌘B is most likely to be caught.
   */
  placeHere: () => BookmarkPlace | null
  /**
   * Walk this book for marks that have no anchor here yet — WI-22.A2.
   *
   * ON THE NAVIGATOR because the SESSION owns the book: the walk needs
   * `book.sections[i].createDocument()`, and that is the object
   * `refuseBookScripts` wrapped at open. A host that parsed the file a second
   * time to do this would be reading a document the script strip never
   * touched, which is the one thing that makes the path derived here address
   * the same words the reader sees.
   *
   * Answers what was FOUND. Writing it is the host's — `marks.place` — for the
   * reason `MarkAnchor` is not the stored `Mark`: the session has no business
   * knowing where marks live.
   *
   * ⚠️ **Not on the reading path.** The walk yields between sections and stops
   * the moment this session is disposed; see `reanchorPass`. A caller must
   * still not put it on a page turn — forty cold sections is ~139 ms.
   */
  reanchor: (pending: readonly PendingMark[]) => Promise<PassOutcome>
  /**
   * Every section's readable text, for an export. See
   * `ReaderSession.sectionTexts` — including what it filters LESS of than the
   * reading does, which is the one thing a caller has to know.
   *
   * ⚠️ **Not on the reading path either**, and further off it than the reanchor
   * walk: this parses every section AND collects its text, so a long book is
   * seconds of work. It yields between sections and stops when the book closes.
   */
  sectionTexts: (
    toc?: readonly TocItem[],
    shouldStop?: () => boolean,
    /* ⚠️ **THE READING'S OWN SKIP CHOICE, PASSED IN RATHER THAN DEFAULTED HERE.**
       `collectText` has a default, and taking it here would give the export a
       second opinion about whether a note body is spoken — so a reader who turned
       notes on would hear them and then not find them in the `.m4b`, or the
       reverse. One value, from `SpeakPrefs`, down both paths. */
    skip?: SpeechSkipPrefs,
  ) => Promise<SectionTextWalk>
}

/**
 * What a walk of the spine's text produced, and whether it finished.
 *
 * ⚠️ **`complete` EXISTS BECAUSE A PARTIAL WALK USED TO BE INDISTINGUISHABLE FROM
 * A WHOLE ONE.** `sectionTexts` stops when the book closes, is replaced, or the
 * caller asks — and it returned a bare array either way, so the audiobook export
 * shipped a truncated book as a finished one. That is the same failure
 * `narrate_render` records for an empty buffer mid-stream: a complete-looking file
 * with a fraction of the book in it, and no error anywhere.
 *
 * `reanchorUnplaced` in this same class already answers this way, and its comment
 * gives the rule: *"Nothing was looked at, so nothing has been established."* A
 * walk that did not finish has established nothing about the sections it never
 * reached.
 */
export interface SectionTextWalk {
  readonly sections: readonly SectionText[]
  readonly complete: boolean
}

export interface SessionDeps {
  /** Injected so tests can supply a fake instead of a real custom element. */
  createView: () => Promise<View>
  /** Loaded alongside the view so the painters exist before the first paint. */
  loadPainters: () => Promise<MarkPainters>
  /**
   * Turn the source into something `View.open` accepts.
   *
   * foliate opens a File or URL by sniffing its type, but it has no PDF loader
   * — so a PDF is converted into a Book first, one HTML page per PDF page. See
   * `makePdf`. Everything else passes through unchanged.
   *
   * It happens HERE rather than at the call site so that a conversion failure
   * is reported through the same path as a failed open, and so that a session
   * disposed mid-conversion still stops before touching a view.
   *
   * ⚠️ **REQUIRED, AND IT WAS OPTIONAL.** `start` takes a `BookSource`, which
   * has included `RangedSource` since the browser client learned to read a PDF
   * over the wire — and a `RangedSource` is a plain object carrying a pdf.js
   * transport. With no `prepare`, `#openBook` cast it `as File | string` and
   * handed it to `view.open`, which sniffs a type it does not have and answers
   * "this file could not be opened": a message that sends the reader to look at
   * the book when the mistake was at the call site.
   *
   * The pass-through is one line, so requiring it costs a caller nothing and
   * makes the cast below provably safe. Optional dependencies whose absence
   * recreates the failure they exist to prevent are not defaults — see
   * `applyVars` just below, which is required for the same reason.
   */
  prepare: (source: BookSource) => Promise<unknown>
  /**
   * Why the OPENED book must not be shown, or null.
   *
   * Asked after `view.open` and before `init` — the fork has parsed the
   * archive by then and loaded no section yet, so the answer costs one small
   * read and a refused book never puts a page of ciphertext on screen. See
   * `protection.ts` for what it decides and why the rule is narrow.
   *
   * Injected rather than imported so the session's lifecycle tests, which
   * run with no DOM, can hand it a verdict; REQUIRED, on the same reasoning as
   * `prepare` above — a caller that left it out would reopen exactly the
   * failure it exists to prevent, a DRM'd book rendered as noise.
   */
  protection: (book: OpenedBook) => Promise<string | null>
  applySettings: (view: View) => void
  /**
   * The reader's settings, as custom properties on ONE document's root.
   *
   * SEPARATE FROM `applySettings` BECAUSE IT IS PER DOCUMENT, NOT PER VIEW.
   * The two sheets are static and read `var(--paper-*)`; the values live inline
   * on each document's `:root`, which is what lets an attribute-presence
   * selector switch a whole tier and what stops a settings change re-parsing
   * the sheet. Every document that shows the book's text needs it: each section
   * as it loads, and the note popover's own document, which is rendered in a
   * view this session did not build.
   *
   * REQUIRED, unlike `styleNote`. A document that misses this has no
   * `--paper-line`, so every `calc(var(--paper-line) * 1.5)` in the sheets is
   * invalid at computed-value time and drops — an unstyled book, with nothing
   * logged. A required dep is the compiler saying so at the call site.
   */
  applyVars: (doc: Document) => void
  /**
   * The reader's typography, for a NOTE's view.
   *
   * Separate from `applySettings` because a note is not a page: it takes the
   * same stylesheet plus one rule a page must not have — see `styleNoteView`.
   * Optional, so a caller that only reads books needs no opinion about notes.
   */
  styleNote?: (view: View) => void
  /**
   * Where this book was last left, if anywhere.
   *
   * A getter, and read at the LAST possible moment — after the book has been
   * parsed — because the saved position is keyed by the book's content-derived
   * id, which resolves asynchronously alongside the open. Reading it when the
   * session is constructed would be reading it before it can be known.
   *
   * Returning null means the start of the book, which is also what a position
   * the book no longer contains falls back to. See `#display`.
   */
  lastLocation?: () => string | null
}

/**
 * `Node.DOCUMENT_NODE`, spelled as its value.
 *
 * This module's tests run in plain node with no DOM — see `session.test.ts` —
 * so the `Node` global is not there to read the constant off. The suite caught
 * it immediately, which is the argument for keeping those tests DOM-free.
 */
const DOCUMENT_NODE = 9

/**
 * A prepared book that owns resources of its own.
 *
 * `View.close()` closes the RENDERER; it knows nothing about a book object the
 * app synthesised, so a PDF's object URLs and its pdf.js loading task — worker
 * and transport included — survived every close and accumulated one set per
 * book opened. The session owns what it prepared, so it destroys it too.
 */
interface Destroyable {
  destroy: () => void
}

function destroyable(value: unknown): value is Destroyable {
  return typeof (value as Destroyable | null)?.destroy === 'function'
}

export class ReaderSession {
  #disposed = false
  #view: View | null = null
  /**
   * How to let go of the open plate's URL, when it has one.
   *
   * Session-wide rather than per document: the viewer outlives the section
   * whose image it shows — a page turn does not close it — so the release
   * cannot hang off that document's teardown.
   */
  #plateRelease: (() => void) | null = null

  /** One per session — a gesture can span a spine boundary. See `#watchWheel`. */
  readonly #pager = wheelPager()
  /**
   * The next page to load was reached by scrolling BACKWARDS, so open its foot.
   *
   * Only ever set for a fit-width fixed-layout book, where one page is one
   * section and scrolling is the reading motion. Without it, scrolling up at the
   * head of a page loads the previous one at ITS head — so the reader is at the
   * top again, scrolls up again, and skips backwards through the book without
   * seeing any of it. Reading forwards has no equivalent problem, because the
   * head of the next page is where it should start.
   *
   * A TIME rather than a boolean, because arming it is not proof that anything
   * will load. `prev()` at the very first page navigates nowhere, and a
   * fixed-layout renderer can move within a spread without emitting `load` — so
   * a plain flag could stay armed indefinitely and then send some unrelated
   * later page, reached by a tap in the contents, to its foot. Bounding it keeps
   * the worst case inside the moment the gesture happened.
   */
  #enterAtFootAt: number | null = null
  #painters: MarkPainters | null = null
  /**
   * Sections that currently have an overlay.
   *
   * Marks can only be drawn into a section that has one, so this is what
   * `redrawMarks` iterates after a theme change — re-offering marks for a
   * section that has been scrolled away would resolve CFIs for nothing.
   */
  readonly #sections = new Set<number>()
  /**
   * The foreign anchors currently painted in each live section.
   *
   * ⚠️ **A WITHDRAWAL HAS NO ERASE CALL, so a redraw is the only chance to
   * remove one.** The reader's own marks are erased by name — `eraseMark`,
   * called when the reader deletes one. A foreign passage disappears from the
   * OTHER side: somebody unshares, the capability's next answer omits it, and
   * `#drawSection` was purely additive — so the friend's underline stayed on
   * the page for the rest of the session, and came back on every redraw.
   * Un-sharing that leaves the mark up is worse than no un-sharing at all,
   * because the reader is told it is gone.
   *
   * Keyed by section, and by the overlay key within it — the key
   * `useOverlays` composes, so `n` readers on one passage are `n` entries and
   * one of them going away does not erase the others.
   */
  readonly #foreignDrawn = new Map<number, Map<string, ForeignAnchor>>()
  /**
   * Sections with a reconciliation in flight, and whether one is owed after it.
   *
   * Present means running; `true` means the answer changed while it ran, so
   * the pass goes round again from the CURRENT answer. See `#reconcileForeign`.
   */
  readonly #reconciling = new Map<number, boolean>()
  /**
   * Per-document listener teardown, keyed by the document itself.
   *
   * A Map rather than an array, because an array only grows: foliate loads a
   * new document for every section the reader passes through, so a long book
   * accumulated one closure per section — each retaining its document, and for
   * a PDF the page canvas with it — until the book was closed. Keying by
   * document means re-loading one replaces its entry, and a WeakRef is
   * unnecessary because the entry is dropped explicitly.
   */
  readonly #unwatch = new Map<Document, (() => void)[]>()
  /** Which spine item each live document is, so a per-document redraw can find
   *  the one section it needs to touch. */
  readonly #indexOf = new WeakMap<Document, number>()

  /**
   * The section most recently RENDERED, as the fallback for "where is the
   * reader" when a relocation reports no range of its own.
   *
   * A fallback and not the answer: see `ReaderPosition.sectionIndex` for the
   * boundary case that makes the range's own document the better source when
   * there is one. Every fixed-layout book takes this path, because `foliate-fxl`
   * reports no range at all.
   */
  #renderedIndex: number | null = null

  /**
   * Every section currently rendered — not just the last one.
   *
   * `#renderedIndex` says which loaded MOST RECENTLY, and that is the same
   * thing as "the one on screen" only when there is one. `#sections` cannot
   * answer this: it is filled on `create-overlay`, which is annotation
   * plumbing, and a book with nothing to draw never fills it at all. This is
   * filled on `load` and emptied by the same teardown, so its size is the
   * count of live documents — which is what tells a single page apart from a
   * spread, and a scrolled flow showing one section apart from one showing two.
   */
  readonly #rendered = new Set<number>()

  /**
   * The last relocation, as ONE value: where it was, which section, and the
   * range it covered.
   *
   * HELD RATHER THAN PUBLISHED, and that is the point of keeping it. The range
   * is what a bookmark's remembered text and context are read out of, and
   * reading them costs a walk of the page's text nodes. Doing that on every
   * relocation would put it on every page turn, for a value almost every turn
   * throws away; doing it in `placeHere` puts it on the press of ⌘B, which
   * happens when the reader asks for it.
   *
   * ONE FIELD RATHER THAN THREE, and that is not tidiness. `placeHere` used to
   * take the CFI from its caller — the host holds one, it arrives on
   * `ReaderPosition` — and pair it with whatever range this session had most
   * recently seen. Those two are updated on different schedules: the host's
   * copy lands when React commits, this one when the event fires. Between a
   * relocation and that commit they describe different pages, so a bookmark
   * made in that window carried the previous page's anchor with this page's
   * section and text. Stored together, they cannot disagree.
   *
   * The range stays live, so it may have been detached by the time it is read —
   * a section re-render replaces the nodes under it. `placeHere` checks before
   * trusting it, exactly as `publish` does for a selection.
   */
  #relocated: {
    cfi: string | null
    sectionIndex: number | null
    /** Whether the section came from a source that KNOWS — see `#sectionOf`. */
    sectionExact: boolean
    chapter: string
    range: Range | null
  } | null = null

  /**
   * The document whose selection is currently on screen, or null.
   *
   * Session-level because a fixed-layout spread has TWO live documents, each
   * running its own `#watchSelection`. This used to be a `published` boolean
   * inside each closure, so both could believe they owned the popup: selecting
   * in the left page then the right left the left one still flagged, and the
   * next repaint or collapse over there took down the right page's newer
   * selection. Ownership is single by construction now — publishing transfers
   * it, and only the holder may clear.
   */
  #selectionOwner: Document | null = null
  /**
   * How to select a range and publish it, per section.
   *
   * The publishers are built per section inside `#watchSelection`, where they
   * close over the section's document, its index and the view — and clicking a
   * MARK arrives on a view-level event that has none of them. Rather than
   * rebuild a second publisher out of the same parts, which is how two answers
   * to "what is selected" come to disagree, the one that already exists is
   * registered here.
   *
   * KEYED BY INDEX, because that is what `show-annotation` carries. Keying by
   * document would mean recovering one from the range's `ownerDocument`, which
   * is an inference where the event already holds the answer.
   */
  readonly #selectors = new Map<number, (range: Range) => void>()
  /** A book this session synthesised, which `View.close()` will not release. */
  #prepared: Destroyable | null = null
  /** See `SessionDeps.styleNote`. Held from `start`, used on every note. */
  #styleNote: ((view: View) => void) | null = null
  /** See `SessionDeps.applyVars`. Held from `start`, used on every document. */
  #applyVars: ((doc: Document) => void) | null = null
  readonly #host: HTMLElement
  readonly #cb: SessionCallbacks
  /** The note popover's flow — see `footnotes.ts`, and `NoteSession` for what it asks of this. */
  readonly #notes: Footnotes

  constructor(host: HTMLElement, callbacks: SessionCallbacks) {
    this.#host = host
    this.#cb = callbacks
    /* Every entry reads the session AT THE MOMENT IT IS ASKED — the latch, the
       view, and the two styling deps `start` fills in later — so nothing here
       is a copy that could go stale. */
    this.#notes = new Footnotes({
      host,
      disposed: () => this.#disposed,
      onFootnote: (note) => this.#cb.onFootnote(note),
      onLink: (detail, event) => this.#cb.onLink(detail, event),
      onExternalLink: (detail, event) => this.#cb.onExternalLink(detail, event),
      goTo: (href) => {
        const reader = this.#view
        /* Stryker disable next-line LogicalOperator: the two operands answer
           together everywhere this closure can be reached — `#view` is null only
           before `start`, and the note whose link calls this cannot exist then,
           so `&&` and `||` return for the same states. The whole-condition
           mutants are killable and are not covered here. */
        if (this.#disposed || !reader) return
        void reader.goTo(href).catch(reportNavigation('goTo', href))
      },
      /* Stryker disable next-line OptionalChaining: `SessionDeps.applyVars` is
         REQUIRED and `start` assigns it before any note can render, so this is
         null only before a session starts — a state no note document reaches.
         The `?.` is what the field's `| null` type needs. */
      applyVars: (doc) => this.#applyVars?.(doc),
      styleNote: (view) => this.#styleNote?.(view),
    })
  }

  get disposed(): boolean {
    return this.#disposed
  }

  /** The live view, or null before startup completes / after disposal. */
  get view(): View | null {
    return this.#view
  }

  /**
   * Hand a freshly-created view to the latch.
   *
   * Returns false when the session was disposed while the caller was awaiting,
   * having already closed the view it was given. Callers must stop on false —
   * that is the whole contract.
   */
  #settle(view: View): boolean {
    if (this.#disposed) {
      closeQuietly(view)
      return false
    }
    this.#view = view
    return true
  }

  /**
   * Bring a book up, from nothing on screen to a first page.
   *
   * Five steps, each its own method below. They were one 136-line function, and
   * the length was not the problem — the RESPONSIBILITIES were: acquiring
   * resources, mounting DOM, binding events, opening the book and publishing an
   * API each fail differently and each has its own rollback, and reading which
   * `return` left which of them half-done meant holding all five in your head
   * at once. The disposal latch is checked between every pair, because each
   * step contains an await the caller can unmount across.
   */
  async start(source: BookSource, deps: SessionDeps): Promise<void> {
    const view = await this.#acquire(deps)
    if (!view) return

    this.#mount(view)
    /* HELD, because notes are styled long after this returns. `Footnotes`
       wires its listeners at each click and they fire whenever a reader opens a
       note, by which time `deps` is three call frames gone. */
    this.#styleNote = deps.styleNote ?? null
    this.#applyVars = deps.applyVars
    this.#bind(view)

    if (!(await this.#openBook(view, source, deps))) return

    this.#publish(view, deps)
    await this.#display(view, deps)
  }

  /**
   * The view and the painters, or null if either failed.
   *
   * `allSettled`, not `all`: `all` rejects the moment either side fails while
   * the other keeps going, so a painters failure would strand a perfectly good
   * view with nothing holding a reference to close it — the same leak this
   * class exists to prevent, reintroduced one layer up.
   */
  async #acquire(deps: SessionDeps): Promise<View | null> {
    const [built, painted] = await Promise.allSettled([
      deps.createView(),
      deps.loadPainters(),
    ])

    if (built.status === 'rejected') {
      if (!this.#disposed) {
        this.#cb.onError(message(built.reason, 'The reader failed to start.'))
      }
      return null
    }
    const view = built.value
    if (!this.#settle(view)) return null

    if (painted.status === 'rejected') {
      // The view is settled, so dispose() will close it — the same contract as
      // a failed open, where the book stays closable.
      this.#cb.onError(message(painted.reason, 'The reader failed to start.'))
      return null
    }
    this.#painters = painted.value
    return view
  }

  /** Put the view in the host, filling it. */
  #mount(view: View): void {
    view.style.position = 'absolute'
    view.style.inset = '0'
    this.#host.replaceChildren(view)
  }

  /**
   * Subscribe to everything the view emits.
   *
   * Every listener consults the latch before touching shared state. A closing
   * view still emits these, and without the guard a dying book overwrites the
   * document and position of the one that replaced it.
   */
  #bind(view: View): void {
    view.addEventListener('load', (event) => {
      if (this.#disposed) return
      const { doc, index } = (event as CustomEvent<LoadDetail>).detail
      /* FIRST, before a watcher, a mark or a measurement reads it: the
         loader refuses a script RESOURCE, and leaves inline scripts and
         `on*` handlers to whoever receives the document — its own source
         says so. That is here. */
      stripScripts(doc)
      // A section re-loaded is the same document with fresh content, so its
      // previous listeners are dropped before new ones go on — otherwise every
      // return to a section doubles them.
      this.#resetWatchers(doc)
      this.#openAtFootIfArrivedBackwards()
      this.#watchSelection(doc, view, index)
      this.#watchPlates(doc)
      this.#watchKeys(doc)
      this.#watchWheel(doc)
      this.#watchDrops(doc)
      /* The overlay for this section dies with its document, so the section
       * leaves the live set at the same moment. Without this the set only ever
       * grew: a redraw after a theme change then re-resolved a CFI into every
       * section the reader had ever passed through, against overlays that no
       * longer exist — work that rises with the length of the reading session
       * and accomplishes nothing after the first few. */
      this.#indexOf.set(doc, index)
      this.#renderedIndex = index
      this.#rendered.add(index)
      this.#onTeardown(doc, () => {
        this.#sections.delete(index)
        this.#rendered.delete(index)
        /* The overlay died with the document, and so did everything painted
           into it. Remembering it would ask the section's NEXT overlay — a
           fresh one that never held any of it — to remove marks it does not
           have. */
        this.#foreignDrawn.delete(index)
        /* AND `#renderedIndex` STOPS NAMING A DOCUMENT THAT IS GONE.
         *
         * It was left pointing at the torn-down section, so after the most
         * recently loaded of two was dropped it named a document nothing could
         * resolve while the other was still on screen — a fallback section for
         * a page the reader is not on, reported as confidently as any other.
         * The remaining insertion order is the next best answer, and null when
         * there is nothing left is the honest one. */
        if (this.#renderedIndex === index) {
          const remaining = [...this.#rendered]
          this.#renderedIndex = remaining[remaining.length - 1] ?? null
        }
      })

      /* A NEW SECTION CLOSES THE NOTE. The popover is placed against a
         reference that has just been replaced, so leaving it up would leave it
         pointing at whatever now occupies those coordinates. */
      this.closeFootnote()

      /* BEFORE ANYTHING MEASURES THIS DOCUMENT. The sheets are already in —
         foliate writes them in the same `onLoad` that dispatches this event —
         but they read `var(--paper-*)`, and until the contract is on the root
         every length in them is invalid and drops. `markProse` below reads
         computed styles, and it would be reading an unstyled document. */
      this.#applyVars?.(doc)
      this.#redrawWhenFontsLand(doc)
      ensureLang(doc, view)
      this.#cb.onDirection(directionOf(doc))
      /* AFTER the book's own stylesheet has applied, which by this point it
         has: the mark records what the BOOK asked for, and reading it before
         the author's rules landed would mark centred paragraphs as prose. */
      markProse(doc)
      /* Beside `markProse`, and after the book's stylesheet for the same
         reason: which images are figures is a question about the DOCUMENT, and
         the answer is written as an attribute so the sheet can select on it.
         `matteFigures` follows because it only looks at what this marked. */
      markFigures(doc)
      matteFigures(doc)
      /* Beside the other two, and after the book's stylesheet for the same
         reason: how small a piece of text is relative to the base is a question
         about the DOCUMENT, and it can only be asked once the author's rules
         have landed. See markSmallText for why the accessibility floor cannot
         be a rule on its own. */
      markSmallText(doc)
      /* Beside `markProse`, and for the same reason it is here: this reads the
         BOOK'S OWN rules, so the author's stylesheet has to have landed. See
         `suppressEmptyGeneratedContent` — the box it deletes was appearing over
         the page, not only inside the note popover. */
      suppressEmptyGeneratedContent(doc)

      this.#cb.onDocument(doc)
    })

    /* Every link in the book, before foliate navigates — see `LinkDetail`.
     * Cancelable, so the host decides; the session only carries it across.
     *
     * A FOOTNOTE IS OFFERED TO THE HANDLER FIRST, and if it takes the link it
     * calls `preventDefault()` in this same turn, which is what stops foliate
     * navigating. Anything it declines falls through to the host unchanged and
     * goes on navigating exactly as it always has — the fallback is what
     * happens when nothing is written, not something written. */
    view.addEventListener('link', (event) => {
      if (this.#disposed) return
      const detail = (event as CustomEvent<LinkDetail>).detail
      const taken = this.#notes.open(view.book, detail, event)
      if (!taken) this.#cb.onLink(detail, event)
    })

    view.addEventListener('external-link', (event) => {
      if (this.#disposed) return
      this.#cb.onExternalLink((event as CustomEvent<ExternalLinkDetail>).detail, event)
    })

    /* foliate builds one overlay per spine item, and rebuilds it every time the
     * section is re-rendered. This is the only moment a mark can be attached,
     * which is why the store is read through a getter rather than captured. */
    view.addEventListener('create-overlay', (event) => {
      if (this.#disposed) return
      const { index } = (event as CustomEvent<CreateOverlayDetail>).detail
      this.#sections.add(index)
      this.#drawSection(view, index)
    })

    view.addEventListener('draw-annotation', (event) => {
      if (this.#disposed) return
      /* The shared declaration, not a copy. These shapes were written out
       * inline here and declared again in `vite-env.d.ts`, and the two had
       * already drifted — this one made `annotation.value` optional where the
       * declaration requires it, which is the difference between a guard that
       * is load-bearing and one that is noise. */
      const detail = (event as CustomEvent<DrawAnnotationDetail>).detail
      const painters = this.#painters
      if (!painters) return
      /* REPORTED AFTER THE PAINT, not before it. This fired as soon as the
       * event arrived, so a painter that threw — or a kind the whitelist
       * refuses — still registered a live Range in the margin's cache. The
       * margin then measured and drew a control beside a highlight that is not
       * on the page. `paintAnnotation` answers true only from the branch that
       * actually painted one of the READER'S marks. */
      if (!paintAnnotation(detail, painters, this.#cb.getPalette())) return
      /* Stryker disable next-line OptionalChaining: `paintAnnotation` answered
         true just above, which it can only do by reading a paintable `kind` off
         `detail.annotation` — so the annotation is present here. The `?.` holds
         because foliate round-trips this object untyped. */
      if (detail.annotation?.value && detail.range) {
        this.#cb.onMarkDrawn(detail.annotation.value, detail.range)
      }
    })

    /**
     * Clicking a mark SELECTS the passage it covers.
     *
     * Which is what puts the selection tools over it — the reader's way to
     * recolour a highlight, restyle it, note it, copy it or take it off is the
     * same bar they made it with, rather than a second set of controls
     * somewhere else that would have to be kept in step with the first.
     *
     * A REAL SELECTION, not a snapshot assembled from the mark's stored fields.
     * Both would put the bar in the right place; only this one comes down
     * again. A synthesised selection is not the document's, so nothing in the
     * document contradicts it: the next click lands somewhere else, the
     * `selectionchange` listener sees no live selection and publishes null —
     * which would be right if the bar were showing a real selection and is
     * merely a race against the fake one. Selecting for real puts the popup on
     * the same footing as every other selection there is, including the way it
     * goes away.
     *
     * `show-annotation` carries the live `range` and the section `index`
     * alongside the anchor, so nothing has to be resolved to do this.
     */
    view.addEventListener('show-annotation', (event) => {
      if (this.#disposed) return
      const { index, range } = (
        event as CustomEvent<{ value: string; index: number; range?: Range }>
      ).detail
      /* No range means the anchor did not resolve — `showAnnotation` emits that
       * way for a CFI it could not find. Selecting nothing would leave the bar
       * hanging off a passage that is not there. */
      if (!range) return
      /* SELECTED AND PUBLISHED NOW rather than left to the `pointerup` snap
       * that this same click already scheduled. That snap would publish the
       * range too, a macrotask later and widened to whole words — so the bar
       * would arrive late, against an anchor that is not the mark's own. */
      this.#selectors.get(index)?.(range)
    })

    view.addEventListener('relocate', (event) => {
      if (this.#disposed) return
      const detail = (event as CustomEvent<RelocateDetail>).detail
      const cfi = detail.cfi ?? null
      const section = this.#sectionOf(detail)
      const sectionIndex = section.index
      const chapterLabel = detail.tocItem?.label ?? ''
      /* Held as one value for `placeHere`, which is the only thing that reads
       * the page's text — and reads it on demand rather than here. Captured
       * together so a bookmark cannot pair one page's anchor with another
       * page's section. See the field. */
      this.#relocated = {
        cfi,
        sectionIndex,
        sectionExact: section.exact,
        chapter: chapterLabel,
        range: detail.range ?? null,
      }
      this.#cb.onRelocate({
        fraction: detail.fraction,
        chapterLabel,
        /* Carried through rather than dropped — which is what this handler did
           with it for as long as the fork has been reporting it. See
           `ReaderPosition.printPage`. */
        printPage: detail.pageItem?.label ?? '',
        chapterHref: detail.tocItem?.href ?? '',
        // Carried through rather than dropped, which is what this handler used
        // to do with it. It is what `lastLocation` below is given back.
        cfi,
        sectionIndex,
        sectionExact: section.exact,
      })
    })
  }

  /**
   * Parse the source and open it. False means stop — failed, refused or
   * disposed.
   *
   * THREE OUTCOMES USED TO BE SILENT, or worse than silent (WI-20.13). A
   * zero-length file reached the fork, whose words for it are "File not
   * found". A DRM'd EPUB opened and rendered its chapters as noise, because
   * the fork passes an algorithm it cannot decode through as ciphertext and
   * nothing here asked. And a password-protected PDF showed pdf.js's own "No
   * password given" — `makePdf` owns that one; its refusal arrives through
   * the catch below with a sentence of its own.
   */
  async #openBook(view: View, source: BookSource, deps: SessionDeps): Promise<boolean> {
    /* Before the fork sees it — see `isEmptySource`. */
    if (isEmptySource(source)) {
      this.#cb.onError(EMPTY_FILE)
      return false
    }
    try {
      /* REQUIRED — see `SessionDeps.prepare`. The cast at `view.open` below is
         only sound because something has converted whatever this was into
         something foliate accepts. */
      const target = await deps.prepare(source)
      // Held so disposal can release it — see `Destroyable`.
      if (target !== source && destroyable(target)) {
        /* Unless disposal already happened while the PDF was being parsed, in
         * which case nothing will ever read this field again and the book has
         * to be released here. It is the expensive case, too: parsing is the
         * slow step, so the race is likeliest exactly when the object being
         * dropped owns a worker and a set of object URLs. */
        if (this.#disposed) destroyQuietly(target)
        else this.#prepared = target
      }
      // `prepare` can be slow — a PDF is parsed here — so the latch is
      // consulted before the view is touched with the result.
      if (!this.#settle(view)) return false
      await view.open(target as File | string)
    } catch (cause) {
      if (!this.#settle(view)) return false
      this.#cb.onError(message(cause, 'This file could not be opened.'))
      return false
    }
    if (!this.#settle(view)) return false

    /* BEFORE ANY SECTION LOADS. The fork's loader asks its book, per
     * resource, whether it may load it; the answer for a script is no — the
     * CSP is the wall and this is what stands behind it (`bookScripts.ts`,
     * WI-20.30). Wired here, between `open` and the first `init`, because a
     * listener added later meets a chapter already loaded. */
    refuseBookScripts(view.book)

    /* OPENED IS NOT THE SAME AS READABLE. The container, the package and the
     * navigation of a DRM'd EPUB are in the clear — that is why `open`
     * succeeds and why nothing said anything — and the first section loaded
     * is where the ciphertext would appear. Asked here, after the parse and
     * before any section, so a refused book is never displayed at all: not a
     * first page, not its contents, not a navigator. `dispose` closes it like
     * any other open that stopped. */
    const refused = await deps.protection(view.book)
    if (!this.#settle(view)) return false
    if (refused !== null) {
      this.#cb.onError(refused)
      return false
    }
    return true
  }

  /** Hand the book's contents and its navigation to the host. */
  #publish(view: View, deps: SessionDeps): void {
    this.#cb.onToc(view.book.toc ?? [])
    this.#cb.onMeta(readMeta(view.book))
    /* Not awaited, and not allowed to fail the open. Pulling a cover out means
     * unzipping an image, which for a large book takes long enough to be worth
     * not blocking the first paint on — and a malformed manifest that throws
     * here is a book without a picture, not a book that failed to open. */
    void (async () => {
      /* A BACKEND THAT LACKS THE METHOD SAYS SO, because the optional call
       * below cannot tell that apart from a book that simply has no picture —
       * and that silence hid a real gap for as long as it existed. Paper's PDF
       * adapter never implemented `getCover`, so every PDF fell through this
       * line to the shelf's derived tint, which is a legitimate answer for a
       * jacketless book and therefore looked like one. The costume fit so well
       * that `BookCover`'s own comment explained the absence as inherent to the
       * format. One line here is what makes the next missing backend a question
       * somebody asks on the first run rather than months later. */
      if (typeof view.book?.getCover !== 'function') {
        console.warn('Paper: this book backend implements no getCover — no jacket will be filed')
      }
      /* `coverFrom`, not `.catch()` on the result: a backend may return the
       * jacket synchronously — see the function, and the FB2 case that makes
       * this not merely defensive. */
      const cover = view.book ? await coverFrom(view.book) : null
      if (!this.#disposed) this.#cb.onCover(cover ?? null)
    })()
    this.#cb.onNavigator({
      /* Every navigation reports its own failure. These are async and were
       * discarded, so a target that will not resolve — a dead link in a table
       * of contents, a PDF destination pointing at a page that is not there —
       * surfaced as an unhandled rejection at the window rather than as a line
       * saying which link it was. Nothing is shown to the reader: a link that
       * goes nowhere should do nothing, not raise a dialog. */
      goTo: (target) => void view.goTo(target).catch(reportNavigation('goTo', target)),
      /* Clamped HERE rather than trusted from the caller: the fork is handed a
         number that came from a pointer position, and a drag that leaves the
         track by a pixel must not ask for -0.01 of a book. */
      goToFraction: (fraction) => {
        const at = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
        void view.goToFraction(at).catch(reportNavigation('goToFraction', String(at)))
      },
      search: (query, signal) => runSearch(view, query, signal),
      // Reported, unlike the speculative offers made when an overlay is
      // created: this one is a direct response to the reader marking something,
      // so a failure is a mark that silently did not appear.
      drawMark: (anchor) => attachMark(view, anchor, { report: true }),
      eraseMark: (anchor) => attachMark(view, anchor, { remove: true, report: true }),
      deselect: () => view.deselect(),
      closeFootnote: () => this.closeFootnote(),
      setFootnoteMount: (mount, within) => this.setFootnoteMount(mount, within),
      next: () => void view.next()?.catch?.(reportNavigation('next')),
      prev: () => void view.prev()?.catch?.(reportNavigation('prev')),
      goLeft: () => void view.goLeft()?.catch?.(reportNavigation('goLeft')),
      goRight: () => void view.goRight()?.catch?.(reportNavigation('goRight')),
      placeHere: () => this.placeHere(),
      /* Bound to the SESSION, not to this closure's `view`: the method reads
         `#view` and `#disposed`, so a navigator held past a teardown answers
         with an empty walk rather than parsing sections of a book nobody is
         reading. */
      reanchor: (pending) => this.reanchorUnplaced(pending),
      /* ⚠️ **EVERY ARGUMENT, PASSED THROUGH WHOLE — AND THIS FORWARDED ONLY
         `toc`.** It was `(toc) => this.sectionTexts(toc)`, so the two arguments
         after it never arrived: `shouldStop`, which is how the audiobook's Stop
         reaches a walk of every section, and `skip`, which is how the reader's
         choice about footnotes reaches the text it exports. Both were silently
         their defaults. TypeScript said nothing, because a function taking fewer
         parameters is assignable to a type that declares more, and the extra
         arguments are simply dropped at run time. A forwarder that re-lists its
         parameters drops the next one that is added; one that spreads them
         cannot. */
      sectionTexts: (...args) => this.sectionTexts(...args),
    })

    this.#cb.onFixedLayout(view.isFixedLayout)
    /* ⚠️ **THE WHOLE SPINE, NEVER A SAMPLE.** Measured over 250 books: within
       one book the chars-per-byte ratio spans 18.6x between its 10th and 90th
       percentile sections, because front matter is markup over a handful of
       words and a chapter is the opposite. Only the aggregate is stable, which
       is why this is summed here rather than accumulated as sections load. */
    this.#cb.onLength(wordsInSpine(spineBytes(view.book.sections), view.isFixedLayout))

    // Settings go on BEFORE the first paint, so the reader never flashes
    // foliate's defaults on the way to the configured layout.
    deps.applySettings(view)
  }

  /**
   * Where notes are rendered. Null puts them back on the host — see
   * `Footnotes.setMount`, and `SessionNavigator.setFootnoteMount` for why it
   * must be one element that never moves.
   */
  setFootnoteMount(mount: HTMLElement | null, within: HTMLElement | null = null): void {
    this.#notes.setMount(mount, within)
  }

  /** Close whatever note is open, and let go of the view it was rendered in. */
  closeFootnote(): void {
    this.#notes.close()
  }

  /**
   * Show where the reader left off, or the first section.
   *
   * `open` parses the book and attaches a renderer but navigates NOWHERE.
   * Without this the view stays empty with a populated table of contents and no
   * iframe, reporting no error to explain it.
   *
   * A saved position is UNTRUSTED input, even though this app wrote it: books
   * are identified by hashing their ends, so a re-exported or re-encoded
   * edition can inherit a position from a file whose spine it no longer
   * matches. Losing the book over a stale bookmark is the worse of the two
   * failures, so a failed restore is retried from the start and only a failure
   * with no position to blame is reported to the reader.
   *
   * Be precise about what that retry is FOR, because foliate covers most of it
   * already: `resolveNavigation` catches its own errors and returns nothing, so
   * a CFI that cannot be resolved at all falls through to `showTextStart`
   * inside `init` and never reaches this catch. What does reach it is a
   * position that resolves to a section and then fails to RENDER — and that is
   * the case where retrying is the difference between a book and an error.
   */
  async #display(view: View, deps: SessionDeps): Promise<void> {
    const saved = deps.lastLocation?.() ?? null

    /* Wrapped rather than thrown, so a book that fails BOTH attempts reports
     * the second failure and not a stale first one. A bare `catch` variable
     * cannot say "nothing failed" — a thrown `undefined` is indistinguishable
     * from no throw at all. */
    const show = async (at: string | null): Promise<{ cause: unknown } | null> => {
      try {
        await view.init({ lastLocation: at, showTextStart: true })
        return null
      } catch (cause) {
        return { cause }
      }
    }

    let failed = await show(saved)

    if (failed && saved !== null && !this.#disposed) {
      /* Loud, but not at the reader: they asked to read a book and they get
       * one. Silence here would make a position that never restores look
       * exactly like a book nobody had opened before. */
      console.warn('Paper: the saved position could not be restored', failed.cause)
      failed = await show(null)
    }

    if (!this.#settle(view)) return
    if (failed) {
      this.#cb.onError(message(failed.cause, 'This book could not be displayed.'))
      return
    }

    /*
     * ⚠️ **RESOLVED IS NOT DISPLAYED.** The retry above catches a RENDER that
     * throws, and that is the rarer failure. The fork's `goTo` catches its own
     * errors and resolves; the paginator no-ops on an index it cannot go to;
     * a section that fails to load resolves `#display({})`. A stored CFI whose
     * idref no longer resolves, a fake-CFI index past the section count on
     * MOBI/FB2/CBZ, a landmark pointing at a missing file — each resolved
     * `init` having displayed nothing, and the reader got a blank stage with a
     * populated table of contents and no error anywhere.
     *
     * THE SIGNAL IS THE RELOCATION, AND IT NEEDS NO TIMER. Both renderers
     * report where they landed BEFORE the navigation's promise settles: the
     * paginator's `#afterScroll` runs synchronously inside `#scrollTo` on the
     * navigation path, and the fixed-layout renderer's `#reportLocation` is
     * the last line of `goToSpread`. So an `init` that resolves with no
     * `relocate` behind it displayed nothing, and `#relocated` — set by that
     * event and by nothing else — is the whole test.
     *
     * AND THE FALLBACK BYPASSES THE LANDMARKS. Retrying `init(null)` is not
     * enough: `goToTextStart` prefers the bodymatter landmark, so a landmark
     * whose href is missing fails the same silent way twice. The fallback goes
     * to the first spine item with `linear !== 'no'` BY INDEX, which the
     * paginator honours whatever the landmarks say. One navigation, one
     * notice on the channel a lost position already uses — findable, and not
     * an error bar over a book that is about to be readable. Only when that
     * too lands nowhere is the reader told.
     */
    if (this.#relocated) return
    const first = firstLinearSection(view.book)
    if (first !== -1) {
      console.warn(
        saved !== null
          ? 'Paper: the saved position displayed nothing; opening at the first section instead'
          : 'Paper: the book opened to nothing; opening at the first section instead',
      )
      try {
        await view.goTo(first)
      } catch (cause) {
        failed = { cause }
      }
      if (!this.#settle(view)) return
      if (this.#relocated) return
    }
    this.#cb.onError(message(failed?.cause, 'This book could not be displayed.'))
  }

  /**
   * Re-attach every mark in every live section.
   *
   * The Overlayer's own `redraw()` reuses the options each mark was added with,
   * so it re-paints the old colour after a theme change. Re-adding is what
   * actually re-reads the palette — `add()` drops an existing key first, so
   * this updates in place rather than stacking a second copy.
   */
  redrawMarks(): void {
    const view = this.#view
    if (!view || this.#disposed) return
    for (const index of this.#sections) this.#drawSection(view, index)
  }

  /** Offer every mark belonging to one section to that section's overlay. */
  #drawSection(view: View, index: number): void {
    for (const anchor of this.#cb.getMarks()) {
      if (anchor.sectionIndex !== index) continue
      attachMark(view, anchor)
    }
    /* ⚠️ **AFTER the reader's own, which decides what sits on top.** The
     * Overlayer paints in the order it was given, so a friend's rule drawn
     * second sits over the reader's band rather than under it — and a rule
     * under a band is a rule nobody can see. */
    void this.#reconcileForeign(view, index)
  }

  /**
   * Bring one section's foreign marks to what the overlay now says.
   *
   * ⚠️ **ONE AT A TIME PER SECTION, and it used to be free-for-all.** Every add
   * and every erase is asynchronous — `addAnnotation` resolves a CFI before it
   * paints — and they were launched with `void` while `#foreignDrawn` was
   * updated as though they had already happened. Two interleavings follow, and
   * both leave the page saying the opposite of the truth:
   *
   *  - an add is still in flight when the passage is withdrawn; the erase runs,
   *    finds nothing to remove, and is forgotten; the old add then lands and
   *    paints a withdrawn passage that nothing is tracking any more, so no
   *    later redraw will take it off;
   *  - a passage is dropped and restored within one turn; the new add lands
   *    first and the stale erase lands last, removing the mark that should be
   *    there.
   *
   * Serialising per section removes the whole class rather than the two
   * instances: while a pass is running, another request only marks the section
   * dirty, and the pass runs again from the CURRENT answer when it finishes.
   * The desired state is re-read at the top of every pass, so a request that
   * arrived mid-flight is never lost and never applied out of order.
   */
  async #reconcileForeign(view: View, index: number): Promise<void> {
    if (this.#reconciling.has(index)) {
      /* A pass is running; it will re-read the answer when it lands. */
      this.#reconciling.set(index, true)
      return
    }
    this.#reconciling.set(index, false)
    try {
      do {
        this.#reconciling.set(index, false)
        if (this.#disposed || !this.#sections.has(index)) return
        await this.#foreignPass(view, index)
      } while (this.#reconciling.get(index) === true)
    } finally {
      this.#reconciling.delete(index)
    }
  }

  /** One reconciliation, from the answer as it stands right now. */
  async #foreignPass(view: View, index: number): Promise<void> {
    const now = new Map<string, ForeignAnchor>()
    for (const anchor of this.#cb.getOverlays?.() ?? []) {
      if (anchor.sectionIndex !== index) continue
      now.set(anchor.key, anchor)
    }
    /* ⚠️ **ERASED BEFORE THE REST ARE DRAWN — see `#foreignDrawn`.** Anything
     * this section held and the current answer no longer names has been
     * withdrawn, and nothing else will ever ask for it to come off. */
    const held = new Map(now)
    for (const [key, anchor] of this.#foreignDrawn.get(index) ?? []) {
      if (now.has(key)) continue
      /* ⚠️ **KEPT UNTIL THE ERASE IS SEEN TO WORK, and it used to be dropped
       * on the attempt.** `attachForeign` swallows its failures by design —
       * the CFI of a PDF page that has not been painted does not resolve yet —
       * so "asked to remove it" and "removed it" are different facts, and only
       * one of them was recorded. Forgetting the anchor on the attempt meant a
       * withdrawal that failed once was never retried: the friend's underline
       * stayed on the page, and every later redraw agreed there was nothing to
       * take off. */
      if (await attachForeign(view, anchor, true)) continue
      held.set(key, anchor)
    }
    /* Together, not one after another: within a pass a key is either being
       erased or being drawn and never both, so two adds cannot conflict —
       and a section with several friends' marks should not pay for them
       one round trip at a time. */
    await Promise.all([...now.values()].map((anchor) => attachForeign(view, anchor)))
    /* Written AFTER both halves have settled, so the record is what is on the
       page rather than what was asked for.

       ⚠️ **AND ONLY WHILE THE SECTION IS STILL LIVE.** A section torn down
       while this ran has lost its overlay and everything painted into it —
       its teardown dropped the record for that reason. Writing one back here
       would ask the section's NEXT overlay, which never held any of it, to
       erase marks it does not have: the case that teardown exists to prevent,
       reached by the road it could not see. */
    if (this.#disposed || !this.#sections.has(index)) return
    if (held.size === 0) this.#foreignDrawn.delete(index)
    else this.#foreignDrawn.set(index, held)
  }


  /**
   * Which spine item this relocation is in.
   *
   * THREE SOURCES, BEST FIRST, and the order is the point.
   *
   * `detail.section.current` is the renderer's OWN index — the same number
   * `load` carries — and it is simply correct. It was not used at first
   * because `vite-env.d.ts` did not declare it; see that file for the
   * measurement, and for the fixed-layout spread this fixes.
   *
   * The range's own document is the fallback for a renderer that publishes no
   * section. `#indexOf` is keyed by document and populated on `load`, so it is
   * the same number the selection path stamps onto a mark, and it is exact at
   * a section boundary in scrolled flow where two documents are on screen.
   *
   * The last-rendered section is the last resort, and it is the one that can
   * be wrong: a fixed-layout spread loads its left page and then its right,
   * and can afterwards show either without loading again. Reached only when a
   * renderer gives neither of the other two.
   *
   * Null when none of the three can answer, which is before the first section
   * has loaded — and null rather than 0, because 0 is a real section.
   */
  #sectionOf(detail: Pick<RelocateDetail, 'section' | 'range'>): {
    index: number | null
    exact: boolean
  } {
    const published = detail.section?.current
    if (typeof published === 'number' && Number.isInteger(published) && published >= 0) {
      return { index: published, exact: true }
    }
    /*
     * THE LAST-RENDERED SECTION, AND WHETHER IT CAN BE TRUSTED.
     *
     * It is the last resort and the only one that can be wrong — but not always
     * wrong, and the difference decides whether a whole class of book can be
     * bookmarked at all. The case it gets wrong is a SPREAD: two pages shown
     * side by side, loaded one after the other, and afterwards either can be
     * the one the reader means without anything loading again. One page shown,
     * and "the section that rendered last" is the section on screen.
     *
     * ASKED OF WHAT IS DISPLAYED, not of what is loaded, and that distinction
     * is the whole of this. Counting live documents was the first attempt and
     * it is a proxy for the wrong thing: a renderer is free to hold a spread's
     * partner page in memory while showing one — prefetching, or keeping the
     * page just turned away from — and every such book would have been refused
     * a bookmark on the strength of a document nobody could see. That is a
     * working feature taken away to fix an edge case, which is the worse trade
     * by far. `spread` is the renderer's own answer to "am I showing two".
     *
     * AND AN UNKNOWN RENDERER IS TRUSTED, deliberately. A renderer that does
     * not publish the attribute leaves this exactly where it was before any of
     * this existed — no worse than today for anything already working, and the
     * defect is caught wherever the renderer will say. Refusing on silence
     * would be guessing in the direction that breaks things.
     *
     * Labelled rather than dropped, because the two callers want different
     * things from it. The position readout wants "roughly where", where the
     * neighbouring page beats nothing. `placeHere` records a durable, syncable
     * anchor, and a bookmark naming the wrong page of a spread is a row that
     * takes the reader somewhere they never were — indistinguishable,
     * afterwards, from a good one.
     */
    const guess = {
      index: this.#renderedIndex,
      /* Nothing rendered is nothing to be exact ABOUT — without this the
         position published before the first section loads carried a null
         index beside a confident `true`, which is two fields disagreeing. */
      exact: this.#renderedIndex !== null && !this.#showingTwoSections(),
    }
    const range = detail.range
    if (!range) return guess
    const node = range.startContainer
    /* A Document's own `ownerDocument` is null — it does not have an owner, it
     * IS one. A range anchored at the document node is not the ordinary case,
     * but it costs one comparison to not read null out of it and fall through
     * to a section the reader is not in. */
    const doc = node.nodeType === DOCUMENT_NODE ? (node as Document) : node.ownerDocument
    if (!doc) return guess
    const known = this.#indexOf.get(doc)
    /* Keyed by document and populated on `load`, so this is the same number the
       selection path stamps onto a mark — exact even at a section boundary in
       scrolled flow, where two documents are on screen at once. */
    return known === undefined ? guess : { index: known, exact: true }
  }

  /**
   * Where the reader is, as everything a bookmark needs to be made from — or
   * null when this place cannot be pinned down.
   *
   * ON DEMAND, which is the reason it is a method rather than more fields on
   * `ReaderPosition`. The cheap half of "where am I" — the CFI and the section
   * — is published on every relocation because the ribbon and the toggle read
   * it on every page turn. The expensive half is this: `rangeText` walks the
   * page's text nodes and `markContext` walks its neighbours, and both are
   * paid once, when the reader actually asks for a bookmark.
   *
   * Null rather than a degraded answer for a place with no CFI or no section:
   * a bookmark whose anchor cannot be resolved is a row in a list that goes
   * nowhere, and it would be indistinguishable from one whose book has simply
   * changed underneath it.
   *
   * TAKES NO ARGUMENT, and it used to take the CFI. The reasoning for passing
   * one in was that the host already holds the current CFI, so reading a
   * second copy here would be a second answer to a question that already has
   * one — and that was exactly backwards. The host's copy and this session's
   * range are updated on different schedules, so between a relocation and
   * React committing it they describe different pages; pairing them produced a
   * bookmark carrying the previous page's anchor with this page's section and
   * text. There is one answer, it is `#relocated`, and it is taken whole.
   *
   * The TEXT is allowed to be empty and the place still stands. A fixed-layout
   * book reports no range, so there is nothing to read a line out of — and a
   * PDF page is exactly the kind of place a reader wants to bookmark. The list
   * falls back to the chapter for those.
   */
  placeHere(): BookmarkPlace | null {
    const at = this.#relocated
    /* AND NOT ON A GUESSED SECTION — see `#sectionOf`. A bookmark is a durable
       record that syncs; one carrying the wrong page of a spread is a row that
       takes the reader somewhere they never were, and nothing downstream can
       tell it from a good one. Refusing is visible: the toggle goes quiet. */
    if (!at || !at.cfi || at.sectionIndex === null || !at.sectionExact) return null
    /* A range whose ends have left the document describes a page that has been
     * re-rendered since — the same check `publish` makes on a selection, for
     * the same reason. The place is still good; only its remembered text is
     * not, so the text is dropped rather than the bookmark. */
    const range = at.range && connectedRange(at.range) ? at.range : null
    const context = range ? markContext(range) : { prefix: '', suffix: '' }
    return {
      cfi: at.cfi,
      sectionIndex: at.sectionIndex,
      chapter: at.chapter,
      text: range ? rangeText(range) : '',
      prefix: context.prefix,
      suffix: context.suffix,
    }
  }

  /**
   * Every section's readable text, in spine order — what an export reads.
   *
   * ⚠️ **`section.createDocument()`, FOR THE REASON `reanchorUnplaced` GIVES.**
   * That object is the one `refuseBookScripts` wrapped at open, so the text is
   * the text the reader sees; opening the file again would get an unstripped
   * document and could disagree.
   *
   * ⚠️ **AND `collectText` FILTERS LESS HERE THAN IT DOES ON SCREEN.** A
   * document made this way has no browsing context, so `defaultView` is null and
   * the COMPUTED-STYLE half of the filter is skipped: `hidden` and
   * `aria-hidden` still hold, `display: none` does not. An EPUB that hides its
   * endnotes with CSS rather than with the attribute will have them read into
   * the export and not into the reading. Rendering every section off-screen to
   * get computed styles is the fix, and it is a great deal slower; this is the
   * trade, stated rather than discovered.
   *
   * YIELDS BETWEEN SECTIONS, like the reanchor walk, because a long book is
   * hundreds of parses and the window must stay alive through them.
   */
  async sectionTexts(
    toc: readonly TocItem[] = [],
    /* NO DEFAULT, because a default of `() => false` could not be told from one
       that answers `undefined`: both are falsy at the only place this is read.
       Absent is absent, and `shouldStop?.()` says so. */
    shouldStop?: () => boolean,
    skip: SpeechSkipPrefs = DEFAULT_SPEECH_SKIP,
  ): Promise<SectionTextWalk> {
    const view = this.#view
    const book = view?.book
    const sections = book?.sections
    /* NOT `complete: true` — `reanchorUnplaced`'s rule, below: a walk that never
       started has established nothing about a book it never opened. */
    if (this.#disposed || !Array.isArray(sections)) return { sections: [], complete: false }

    const titles = await tocTitles(book as Book, toc)

    const out: { index: number; title: string | null; text: string }[] = []
    /* BY `entries()`, so the walk has no index to fall off. A `for (let index =
       0; index < sections.length; …)` beside the `!section` check below gave the
       loop two conditions for one question: reading past the end lands on
       `undefined`, which that check already skips, so the bound could be
       changed and nothing would notice. */
    for (const [index, entry] of sections.entries()) {
      /* Liveness read at each step rather than captured — closing the book
       * mid-export must stop it, not finish against a dead view. */
      /* THE READER'S OWN STOP, asked at the same moment as liveness. A long
         book is seconds of parsing per section, so a stop that is only noticed
         after the walk is a stop the reader watched do nothing. */
      if (this.#disposed || this.#view !== view || shouldStop?.()) {
        return { sections: out, complete: false }
      }
      const section = entry as { createDocument?: () => Promise<Document> } | null
      if (!section || typeof section.createDocument !== 'function') continue
      const doc = await section.createDocument()
      out.push({ index, title: titles.get(index) ?? null, text: collectText(doc, skip).text })
      await BREATHE()
    }
    return { sections: out, complete: true }
  }

  /**
   * Walk this book for the marks that have no anchor here — WI-22.A2.
   *
   * The session's half of the pass: it supplies the SECTIONS and the liveness,
   * `reanchorPass` decides the walk, and the host does the writing.
   *
   * ⚠️ **`section.createDocument()`, NOT a second parse of the file.** That
   * object is the one `refuseBookScripts` wrapped at open, so the strip applies
   * to it too — which is what makes a path derived from it address the same
   * text the reader sees. A host that opened the file again to do this would
   * get an unstripped document and a path that can disagree by a child index.
   *
   * ⚠️ **`#disposed` IS THE LIVENESS, and it has to be read at the moment the
   * walk asks rather than captured.** A closure over `this.#view` would keep a
   * whole book alive for the length of a walk the reader ended by closing it.
   */
  async reanchorUnplaced(pending: readonly PendingMark[]): Promise<PassOutcome> {
    const view = this.#view
    const sections = view?.book?.sections
    if (this.#disposed || !Array.isArray(sections)) {
      /* NOT `complete: true`. Nothing was looked at, so nothing has been
       * established — and a caller that remembered these as misses would
       * answer "not in these bytes" for a book it never opened. */
      return { found: [], missed: [], complete: false, walked: 0 }
    }
    return reanchorPass(pending, {
      sections: sections.length,
      documentFor: async (index) => {
        const section = sections[index] as
          | { createDocument?: () => Promise<Document> }
          | null
          | undefined
        if (!section || typeof section.createDocument !== 'function') return null
        const doc = await section.createDocument()
        return doc.body ?? doc
      },
      live: () => !this.#disposed && this.#view === view,
      breathe: BREATHE,
    })
  }

  /**
   * Report the book's selection to the host.
   *
   * Split across three triggers on purpose. `selectionchange` fires
   * continuously while a drag is in progress, so publishing a snapshot from it
   * would make the popup chase the pointer; it is used only to CLEAR, which is
   * what makes a click-to-dismiss feel immediate and is why that path is never
   * deferred. The snapshot itself is published when the gesture ends — and the
   * two gestures end differently:
   *
   * - **pointerup** hands the selection to the deferred snap, and the snapshot
   *   is published when that settles. A drag is what word snapping is for, and
   *   the deferral is WI-8's: writing a wider selection while foliate's
   *   paginator still has its pointer flag up turns the page
   *   (`paginator.js:586`). It publishes whether or not the snap wrote
   *   anything: provenance decides whether the selection is WIDENED, never
   *   whether it is reported, and a pointer gesture that published nothing
   *   would leave the reader with no toolbar to mark or copy from. Only a
   *   CANCELLED snap publishes nothing — a section torn down or a PDF page
   *   repainted, where there is no longer a gesture to report.
   * - **keyup** publishes immediately and unsnapped. Shift+arrow is
   *   character-granular, and taking that away is the one thing the keyboard
   *   selection has over the mouse's.
   */
  #watchSelection(doc: Document, view: View, index: number): void {
    const selectionOf = (): Range | null => {
      const selection = doc.defaultView?.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
      return selection.getRangeAt(0)
    }

    /** Whether THIS document's snapshot is the one on screen, so a repaint
     *  knows whether it has a popup to take down. Asked of `#selectionOwner`
     *  rather than kept per document — see that field — and not asked of the
     *  host, because publishing `null` on every repaint would churn the popup
     *  state continuously through a pinch. */
    const owns = () => this.#selectionOwner === doc

    /**
     * Publish one range — always one the caller has just read, never one
     * captured before a mutation.
     *
     * That is the whole reason this takes an argument. `setBaseAndExtent`
     * DETACHES a previously issued `Range` (measured in WebKit): the captured
     * one keeps returning the old text while the live selection returns the
     * snapped text, so a `publish` that read its range once and used it either
     * side of the snap would store a cfi and a text describing a selection the
     * reader never made. `applySnap` returns the range it read AFTER the write
     * for exactly this call.
     *
     * The text is not `range.toString()` either — see `rangeText`, which spells
     * block boundaries and drops the invisible characters that must not reach
     * stored mark text.
     */
    const publish = (range: Range | null) => {
      if (this.#disposed) return
      /* A range whose ends have LEFT the document describes a page that no
       * longer exists. On a PDF that is what a zoom does — `makePdf`'s `paint`
       * calls `replaceChildren()` on the text layer — and WI-8's deferral means
       * a snap can settle just after it, holding a range over nodes nobody can
       * see. Publishing it would put the popup over a re-laid-out page pointing
       * at nothing, which is worse than publishing nothing. */
      const live = range && connectedRange(range) ? range : null
      const text = live ? rangeText(live) : ''
      if (!live || !text) {
        /* Ownership goes with the popup: once null is published there is
         * nothing on screen for anyone to own. The guard against one page of a
         * spread taking down the other page's newer selection belongs at the
         * REPAINT site, which asks `owns()` before calling here at all — not in
         * this function, which must keep emitting null for every caller that
         * reaches it or a collapsed selection stops dismissing the popup. */
        this.#selectionOwner = null
        this.#cb.onSelection(null)
        return
      }
      this.#selectionOwner = doc
      const context = markContext(live)
      this.#cb.onSelection({
        cfi: view.getCFI(index, live),
        sectionIndex: index,
        text,
        prefix: context.prefix,
        suffix: context.suffix,
        range: live,
      })
    }

    const publishLive = () => publish(selectionOf())

    const clearIfCollapsed = () => {
      if (this.#disposed) return
      // Through `publish`, so the "is a popup up?" flag comes down with it. A
      // clear that went straight to the callback would leave the flag saying
      // `true`, and the next repaint would clear an already-cleared popup.
      if (!selectionOf()) publish(null)
    }

    /**
     * Where the selection came from, kept per document alongside the
     * publishers.
     *
     * The snap reads it when it runs — never when it is scheduled — so a
     * selection replaced between the gesture and the macrotask is not snapped,
     * and a shift+arrow selection followed by a context-click is not either.
     * Both are bound here rather than beside the snap so that every listener in
     * this section lives and dies through the one teardown path — see
     * `#onTeardown`, which is also where the pending snap is cancelled.
     *
     * Its `pointerup` listener is a second one on this document, and on a PDF
     * page `bindSelectionFix` adds a third (`makePdf.ts:82`). None of the three
     * may depend on running first, and none does: this one only lowers a flag,
     * and scheduling a macrotask cannot be observed by either of the others.
     */
    const provenance = watchGestureProvenance(doc)
    const snap = deferSnap(doc, {
      isPointerProduced: provenance.isPointerProduced,
      onSettled: (application) => publish(application.range),
    })

    /**
     * A PDF page repainting underneath all of this.
     *
     * `makePdf`'s `paint` takes a render generation at the top of every zoom or
     * re-render and finishes by calling `replaceChildren()` on the `.textLayer`
     * — so both the pending snap and the published snapshot are about to be
     * describing nodes that have left the document. Neither is recoverable, and
     * a selection that is silently re-anchored to whatever now sits at those
     * offsets is the outcome this exists to prevent: the snap is dropped, and
     * the popup comes down.
     *
     * Not a `MutationObserver`: the generation already exists, is already what
     * `paint` consults, and — unlike an observer — is reachable from the only
     * test lane this repository has. The notification fires when the repaint
     * STARTS, which is a moment before the nodes go, so this may not decide
     * anything by asking whether they are still attached; at that moment they
     * always are.
     *
     * An EPUB section never repaints this way, so its guard is never bumped and
     * none of this ever runs for one.
     */
    const offReflow = createReflowGuard(doc).onReflow(() => {
      snap.cancel()
      if (owns()) publish(null)
    })

    doc.addEventListener('pointerup', snap.schedule)
    doc.addEventListener('keyup', publishLive)
    doc.addEventListener('selectionchange', clearIfCollapsed)

    /* Selecting a range in THIS section, for the one caller that has a range
     * but no document — see `show-annotation`. It goes through `publishLive`
     * rather than through `publish(range)` directly, so what is published is
     * whatever the selection actually became: `setBaseAndExtent` detaches the
     * range it is handed, and publishing the detached one is the exact defect
     * `publish`'s argument exists to prevent. */
    this.#selectors.set(index, (range: Range) => {
      /* Through `defaultView`, exactly as `selectionOf` above reaches it — a
         document's selection belongs to its window, and the two must ask the
         same object or one of them is reading a selection the other cannot
         see. */
      const selection = doc.defaultView?.getSelection()
      if (!selection) return
      selection.setBaseAndExtent(
        range.startContainer,
        range.startOffset,
        range.endContainer,
        range.endOffset,
      )
      publishLive()
    })

    this.#onTeardown(doc, () => {
      provenance.unbind()
      /* Not a DOM listener, so the listener-count assertions cannot see it: a
       * section returned to twice would otherwise leave two watchers reacting
       * to one repaint, each retaining this session and its document. */
      offReflow()
      /* Before the listeners come off, and covering both the section going away
       * and the whole session being disposed: `dispose()` runs every teardown
       * list it holds. A timer left armed here fires into a document nobody is
       * reading and writes to its selection — the publish would be caught by
       * the disposal latch, but the mutation would already have happened. */
      snap.cancel()
      doc.removeEventListener('pointerup', snap.schedule)
      doc.removeEventListener('keyup', publishLive)
      doc.removeEventListener('selectionchange', clearIfCollapsed)
      /* A Map, so it only ever grows unless something takes the row out — the
       * same reasoning as `#sections`, and the same failure if it is forgotten:
       * a selector retaining a document nobody is reading. */
      this.#selectors.delete(index)
    })
  }

  /**
   * Forward the book's keystrokes to the host.
   *
   * The book is an iframe with its own document, and clicking a page to read it
   * puts focus inside that document — where every subsequent keystroke stays.
   * A listener on the host window never sees them, so the ENTIRE keyboard map
   * stopped working the moment the reader touched the thing they were reading:
   * not just ← and →, but ⌘K, ⌘\, ⌘1…5 and Esc.
   *
   * It shows up worst on a fixed-layout book, where the arrows are the only way
   * to turn a page and scrolling cannot cover for them — a PDF simply stayed on
   * page one.
   *
   * Re-dispatching rather than handling here keeps one keymap in the app. The
   * session has no business knowing what any key means; it only makes sure the
   * event reaches the place that does.
   */
  /**
   * Opening a plate, from a click inside the book.
   *
   * ⚠️ **FOUR REFUSALS, AND EACH IS A DEFECT IF IT IS MISSED.** This listener
   * sits on the same document as the selection, the keys and the wheel, so it
   * has to be the one that gives way:
   *
   * - **A plate inside a link follows the link.** A cover that is an `<a>` to
   *   chapter one must navigate. `closest('a')` wins outright.
   * - **A live selection wins.** The reader is marking, not looking, and this
   *   is the surface the selection popup is bound to. A click that ends a drag
   *   arrives here too, so without this every marked plate opens underneath
   *   the popup that was about to appear.
   * - **Only an ENLARGEABLE image**, which is `isEnlargeable` and deliberately
   *   NOT `data-paper-figure` — see `markFigures`, where the two questions are
   *   written side by side and the 4 %-versus-77 % measurement is recorded.
   * - **A modified click is the platform's.** Command, Control, Shift and Alt
   *   all mean something to macOS and to the fork; only a plain primary click
   *   opens a plate.
   *
   * ⚠️ **AND NOTHING HERE TOUCHES THE DOCUMENT.** Every mark is a CFI — a path
   * counting element and text nodes — plus `markContext`'s characters either
   * side. Wrapping the plate to make it clickable, which is the obvious way to
   * do this, would silently move every mark after it in the section.
   */
  #watchPlates(doc: Document): void {
    const onClick = (event: MouseEvent) => {
      if (this.#disposed) return
      if (event.defaultPrevented) return
      if (event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const target = event.target as Element | null
      if (!target || typeof target.closest !== 'function') return
      const selection = doc.defaultView?.getSelection()
      if (selection && !selection.isCollapsed) return
      /* The link, the outermost image and the enlargeability test all live in
         `plateTargetOf`, which is pure and carries their reasons. */
      const img = plateTargetOf(target, isEnlargeable)
      if (!img) return
      const plate = plateOf(img)
      if (!plate) return
      this.#releasePlate()
      this.#plateRelease = plate.release
      this.#cb.onPlate(plate.detail)
    }
    doc.addEventListener('click', onClick)
    this.#onTeardown(doc, () => doc.removeEventListener('click', onClick))
  }

  /**
   * Let go of a serialised plate's object URL.
   *
   * Only an inline `<svg>` ever has one — a raster image is shown through the
   * fork's own blob, which belongs to the section and must NOT be revoked here:
   * revoking it would blank the image on the page behind the viewer.
   */
  #releasePlate(): void {
    const release = this.#plateRelease
    this.#plateRelease = null
    if (release) release()
  }

  #watchKeys(doc: Document): void {
    const onKey = (event: KeyboardEvent) => {
      if (this.#disposed) return

      /* Typing inside the book stays inside the book.
       *
       * The host's keymap guards on `event.target` being a field — and the
       * forwarded event's target is the WINDOW, so that guard cannot see a
       * field inside the iframe. An EPUB with a form in it, or any content the
       * book itself makes editable, would have every arrow key turn the page
       * out from under the cursor. The check has to happen here, where the real
       * target is still available. */
      const target = event.target as HTMLElement | null
      if (
        target?.isContentEditable ||
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA'
      ) {
        return
      }

      /* AND A KEY ON A CONTROL STAYS WITH THE CONTROL, for the same reason.
       *
       * The host guards its own reading keys against a focused control — Space
       * on a toolbar button reached by Tab presses the button — and that guard
       * could never fire for the book, because the forwarded copy's target is
       * the window. So Space on a `<button>` or an arrow on a `<select>` inside
       * an interactive EPUB was forwarded, the host turned the page, and the
       * cancellation carried back below cancelled the control's own default
       * too: the platform's meaning of the key, taken from under the reader's
       * focus. Same outcome as typing — not forwarded, hence not cancelled. */
      if (onBookControl(target)) return

      const forwarded = new KeyboardEvent('keydown', {
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        /* AND THE THREE THE HOST'S GUARDS READ. `repeat` was not copied, so a
         * key held inside the book arrived at the keymap as a fresh press
         * every auto-repeat: the toggle guard in `accel.ts` — whose own note
         * says a held ⌘B writes a row and a tombstone per cycle — could not
         * fire, because focus is in the book whenever the reader has clicked
         * the page, which is most of the time. `location` tells a keypad
         * Enter from the other one; `isComposing` is an IME mid-word. */
        repeat: event.repeat,
        location: event.location,
        isComposing: event.isComposing,
        bubbles: true,
        cancelable: true,
      })
      window.dispatchEvent(forwarded)

      /* Carry the cancellation back across the boundary.
       *
       * `preventDefault` on the copy does nothing to the original, so a key the
       * host handled ALSO kept its default inside the book: PageDown turned the
       * page and scrolled the document it had just left, and Space did both at
       * once. The two documents have to agree about whether the key was
       * consumed, and this is the only place that knows. */
      if (forwarded.defaultPrevented) event.preventDefault()
    }
    doc.addEventListener('keydown', onKey)
    this.#onTeardown(doc, () => doc.removeEventListener('keydown', onKey))
  }

  /**
   * Land on the foot of a page the reader reached by scrolling up into it.
   *
   * Deferred by a frame, and that is the whole difficulty. The `load` event
   * fires when the page's document is ready, which is BEFORE `foliate-fxl` has
   * scaled the frame — so `scrollHeight` at this instant is the pre-layout
   * value and scrolling to it lands somewhere arbitrarily short. A frame later
   * the layout is settled.
   *
   * A SUSPENDED FRAME RESUMES, which is the part that has to be defended
   * against and which an earlier comment here got wrong. An occluded window
   * stops servicing `requestAnimationFrame` — this project has been caught by
   * that before — but it does not cancel the callback: it runs when the window
   * comes back, which may be minutes and several pages later. So the deadline is
   * re-checked INSIDE the frame rather than only before scheduling it, and the
   * renderer is the one captured when the page loaded rather than whichever is
   * current when the frame finally arrives. Without both, coming back to an
   * occluded reader scrolled whatever page happened to be open.
   */
  #openAtFootIfArrivedBackwards(): void {
    const armed = this.#enterAtFootAt
    this.#enterAtFootAt = null
    if (armed === null || performance.now() - armed > ENTER_AT_FOOT_MS) return
    /* Captured here, at the load this belongs to. Reading it inside the callback
     * would resolve a renderer that may by then belong to a different book. */
    const renderer = this.#view?.renderer
    if (!renderer) return
    const toFoot = () => {
      if (this.#disposed) return
      if (performance.now() - armed > ENTER_AT_FOOT_MS) return
      if (this.#view?.renderer !== renderer || !this.#scrollsByPage()) return
      /* Assigning past the end is how the DOM is asked for "the bottom" — it
       * clamps to the maximum, so this needs no arithmetic and cannot overshoot
       * if the layout settled at a different height than expected. */
      renderer.scrollTop = renderer.scrollHeight
    }
    /* Read off `globalThis` rather than called bare, because a bare call throws
     * where the function does not exist — which would take down section loading
     * entirely, for a scroll-position nicety. The immediate path is a real
     * fallback rather than a test affordance: it lands correctly whenever the
     * layout is already settled, and simply lands short when it is not. */
    const raf = globalThis.requestAnimationFrame
    if (typeof raf === 'function') raf(toFoot)
    else toFoot()
  }

  /**
   * Whether more than one SECTION is on screen at once.
   *
   * The question `#sectionOf`'s last resort turns on, and there are exactly two
   * ways for the answer to be yes — one per renderer:
   *
   *   - **A fixed-layout spread.** Two pages side by side, and `spread` is the
   *     pre-paginated renderer's own word for it. Asked of the attribute rather
   *     than of how many documents are loaded, because a renderer is free to
   *     hold a spread's partner in memory while showing one page; counting
   *     loads would refuse a bookmark on the strength of a page nobody can see,
   *     which takes a working feature away to fix an edge case.
   *
   *   - **Scrolled flow at a section boundary**, where a reflowable book has
   *     the end of one section and the start of the next both visible. Here
   *     the count IS the signal: a paginated renderer shows one section at a
   *     time, and a scrolled one holds live only what it is showing.
   *
   * A renderer that answers neither leaves this exactly where it was before
   * any of it existed. Silence must not cost a working bookmark.
   */
  #showingTwoSections(): boolean {
    const view = this.#view
    if (!view) return false
    if (view.isFixedLayout) {
      // `'none'` is the attribute's own word for a single page.
      const spread = view.renderer?.getAttribute('spread')
      return spread !== null && spread !== undefined && spread !== 'none'
    }
    return view.renderer?.getAttribute('flow') === 'scrolled' && this.#rendered.size > 1
  }

  /**
   * A fixed-layout book scaled to the width — one page per section, scrolled.
   *
   * The shape a PDF takes in scroll mode. Named rather than inlined because two
   * separate decisions turn on it: whether a wheel event is the platform's, and
   * whether arriving at a new page backwards should open its foot.
   */
  #scrollsByPage(): boolean {
    const view = this.#view
    return view?.isFixedLayout === true && view.renderer?.getAttribute('zoom') === 'fit-width'
  }

  /**
   * Does the platform have a real scroll to perform with this event?
   *
   * Asked of the renderer, not of the app: what a gesture MEANS is the host's
   * question and is answered in `Reader`, but whether the event has a default
   * worth suppressing is a fact about the renderer. It has to be settled here,
   * because `preventDefault` counts only synchronously inside the listener.
   *
   * THE TWO RENDERERS ANSWER IT DIFFERENTLY, and asking only `flow` was the
   * regression that killed swiping on PDFs. A fixed-layout book is drawn by
   * `foliate-fxl`, whose `observedAttributes` is `['zoom']` — `flow` sits on it
   * unread, so reading it back meant a reader who had ever chosen scrolled mode
   * got a PDF that ignored every gesture, in a renderer that could not scroll
   * either way.
   *
   *   paginator, `flow="scrolled"`  — its scrollport is inside a CLOSED shadow
   *     root, so the host cannot even see it. Hands the event straight back.
   *
   *   fxl, `zoom="fit-width"`       — the scrollport IS the renderer element
   *     (`:host { overflow: auto }`), so its position is readable from here and
   *     the answer can be exact: hand the event back while the page has further
   *     to go, and take it at the edge so the gesture turns the page instead.
   *     That edge check is what makes a PDF read continuously — reaching the
   *     bottom of one page carries on to the next, rather than stranding the
   *     reader on page one with a dead trackpad.
   */
  #platformScrolls(event: WheelEvent): boolean {
    const view = this.#view
    const renderer = view?.renderer
    if (!view || !renderer) return false

    /* THE AUTHOR'S OWN SCROLLING BOXES COME FIRST, before anything about flow.
     *
     * A book is HTML, and a book designer may put a long code listing or a wide
     * table in an `overflow: auto` box. In paged flow the whole event was being
     * consumed, so a wheel over that box turned the page instead of scrolling
     * it, and its content below the fold was simply unreachable. Nothing about
     * the reader's flow setting makes that right.
     *
     * Walked from the event's target rather than asked of the renderer, because
     * this is a question about what is UNDER THE POINTER. It stops at the body:
     * beyond that is the document scroller, which in paged flow is the
     * paginator's business and is exactly what the suppression exists for. */
    if (scrollableUnder(event)) return true

    if (!view.isFixedLayout) return renderer.getAttribute('flow') === 'scrolled'
    if (!this.#scrollsByPage()) return false

    /* Only a dominantly VERTICAL gesture is a scroll. A horizontal swipe means
     * the page left or right whatever the reader has scrolled to, and letting
     * it fall in here would silently do nothing whenever the page happened to
     * be scrolled away from an edge. */
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return false

    /* The one-pixel slack absorbs fractional layout: a scrollport sized by a
     * scaled canvas lands on `scrollHeight` a hair over `clientHeight` with
     * nothing actually to scroll, and an exact comparison would then hand back
     * every event and wedge the book on that page. */
    const remaining = renderer.scrollHeight - renderer.clientHeight
    if (remaining <= 1) return false
    return event.deltaY > 0 ? renderer.scrollTop < remaining - 1 : renderer.scrollTop > 1
  }

  /**
   * Turn a trackpad swipe into one page.
   *
   * The detector is per SESSION, not per document: a gesture that begins on one
   * spine item and finishes after the next has loaded is one gesture, and a
   * fresh detector per document would lose its accumulated travel halfway
   * through. Nothing resets it explicitly — it is discarded WITH the session,
   * and a session is never reused for a second book.
   *
   * NOT passive, and the earlier comment here had it exactly backwards. It said
   * there was no default to suppress because paged flow has nothing to scroll.
   * There is: a wheel event that reaches a scroll container with nowhere to go
   * chains outwards until something bounces, and on macOS that is the viewport
   * — so every swipe dragged the whole application sideways and sprang back.
   * Reported as the window "shaking".
   *
   * So in PAGED flow the gesture is consumed. `global.css` also terminates the
   * chain at the document, which covers everything that never reaches here;
   * this covers the case properly, by saying the event was handled.
   *
   * In SCROLLED flow it is not touched. The book genuinely scrolls there, and
   * consuming the event would stop it dead.
   */
  #watchWheel(doc: Document): void {
    const onWheel = (event: WheelEvent) => {
      if (this.#disposed) return
      /* Only real input. A book is attacker-controlled HTML in a same-origin
       * frame, and `dispatchEvent(new WheelEvent('wheel', { deltaY: 40 }))`
       * would otherwise let its script drive the host's navigation and clear
       * the reader's selection at will. Phase 0's policy stops book script
       * running at all; this is the second lock on the same door, and it is the
       * same property the gesture checklist relies on to say the MCP bridge
       * cannot fake a gesture. */
      if (!event.isTrusted) return

      /* A PINCH, which arrives as a wheel event with `ctrlKey` set, and which
       * has to be let go BEFORE the suppression below rather than after.
       *
       * `wheelPager` already declines to page on one, so the gesture was
       * harmless — but declining happens after `preventDefault`, and by then the
       * platform's zoom and the paginator's own pinch handling have both been
       * cancelled. A reader pinching a PDF page got nothing at all, which looks
       * exactly like a missing feature rather than a suppressed one. */
      if (event.ctrlKey) return

      if (this.#platformScrolls(event)) return
      event.preventDefault()
      /* The HOST's clock, not `event.timeStamp`.
       *
       * A DOM event's timestamp is relative to its own global's time origin,
       * and every spine item is a separate iframe with a separate origin. The
       * pager is per-session on purpose — a gesture can span a section boundary
       * — so mixing the two scales compares numbers that are not on the same
       * axis. Turning a page at a boundary loads a new document, the momentum
       * tail lands in THAT document, and its timestamps start near zero while
       * the previous document's were large: the gap goes hugely negative, never
       * exceeds the quiet period, and the gesture never ends. */
      const intent = this.#pager.feed(event, performance.now())
      if (!intent) return
      /* Only a backwards VERTICAL intent, and only where scrolling is how the
       * book is read. A sideways swipe is a page turn, and a page turn lands at
       * the top like every other one. */
      this.#enterAtFootAt =
        intent === 'prev' && this.#scrollsByPage() ? performance.now() : null
      this.#cb.onPageIntent(intent)
    }
    doc.addEventListener('wheel', onWheel, { passive: false })
    this.#onTeardown(doc, () => doc.removeEventListener('wheel', onWheel))
  }

  /**
   * Intercept a book dropped onto the book.
   *
   * Without this the webview NAVIGATES to the dropped file and the whole
   * application is replaced by WebKit's PDF viewer — an <embed> at a file://
   * URL, no titlebar, no pane, no reader, no error, no way back. The host
   * already prevents that at the window, but a drop over an iframe is
   * delivered to THAT document and never reaches the window at all. So the
   * first drop onto an empty reader worked and the second, onto the open book,
   * did not.
   *
   * `dragover` is the load-bearing prevention: without it there is no drop
   * event and the navigation happens regardless of what the drop handler says.
   *
   * ⚠️ **AND IT WAS CANCELLED ONLY FOR `Files`, WHICH LEFT THE WHOLE POINT
   * UNGUARDED** (2026-09-19 audit). `drop` fires only where `dragover` was
   * cancelled, so a URL or text drag never reached `onDrop` — and `onDrop`'s
   * own comment, *"Unconditional: a dropped URL navigates away just as a file
   * does"*, described a handler that could not run for the payload it named.
   * Dragging a link onto the open book navigated the webview away, which is the
   * exact failure this whole method exists to prevent.
   *
   * So the cancel is unconditional and the CURSOR is what stays file-only:
   * `preventDefault` decides whether the drop happens at all, `dropEffect`
   * only decides what the pointer promises. Accepting everything and acting on
   * files alone is the shape that makes those two questions separate.
   *
   * The file is handed over directly rather than re-dispatched. A DragEvent
   * cannot carry its dataTransfer across a synthetic re-dispatch, and the
   * documents are same-origin, so passing the File itself is both simpler and
   * the only thing that actually works.
   */
  #watchDrops(doc: Document): void {
    const allow = (event: DragEvent) => {
      /* EVERY PAYLOAD, so `drop` always fires and `onDrop` can refuse it. */
      event.preventDefault()
      /* THE CURSOR, ONLY FOR WHAT WILL ACTUALLY BE TAKEN — a copy cursor over
         a link would promise an import that `onDrop` then ignores. */
      if (event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')) {
        event.dataTransfer.dropEffect = 'copy'
      }
    }
    const onDrop = (event: DragEvent) => {
      // Unconditional: a dropped URL navigates away just as a file does.
      event.preventDefault()
      if (this.#disposed) return
      const file = event.dataTransfer?.files?.item(0)
      if (file) this.#cb.onFileDropped(file)
    }

    doc.addEventListener('dragenter', allow)
    doc.addEventListener('dragover', allow)
    doc.addEventListener('drop', onDrop)
    this.#onTeardown(doc, () => {
      doc.removeEventListener('dragenter', allow)
      doc.removeEventListener('dragover', allow)
      doc.removeEventListener('drop', onDrop)
    })
  }

  /**
   * Register teardown for one document, replacing any it already had.
   *
   * foliate re-loads a section every time the reader returns to it, and each
   * load re-runs the watchers. Without replacing, the same document
   * accumulates duplicate listeners — every keystroke forwarded twice, every
   * page turn advancing two spreads — and every superseded closure keeps its
   * document alive.
   *
   * `pagehide` releases the entry as the document goes away, so a book read
   * end to end does not carry every section it passed through.
   *
   * That `pagehide` listener is itself torn down, and it is the FIRST entry in
   * the list so that every path which releases a document releases it too. It
   * used to be the one listener nothing removed: a section reload runs
   * `#resetWatchers`, which drops the map entry, and the next `#onTeardown`
   * then registered a second `pagehide` on the same window — one more per
   * return to a section, each retaining this session and its document, while
   * every other listener in the file was scrupulously balanced.
   */
  #onTeardown(doc: Document, off: () => void): void {
    const existing = this.#unwatch.get(doc)
    if (existing) {
      this.#unwatch.set(doc, [...existing, off])
      return
    }
    const view = doc.defaultView
    const onPageHide = () => {
      for (const fn of this.#unwatch.get(doc) ?? []) fn()
      this.#unwatch.delete(doc)
    }
    this.#unwatch.set(doc, [() => view?.removeEventListener('pagehide', onPageHide), off])
    view?.addEventListener('pagehide', onPageHide, { once: true })
  }

  /**
   * Redraw this document's marks once its webfont has actually arrived.
   *
   * A mark's band is positioned against the font's metrics — see
   * `balanceRects` — and a section renders before the face loads, so the first
   * paint measures the fallback. Without a redraw the band keeps the
   * fallback's geometry for as long as the section is on screen.
   *
   * BOTH signals, because neither alone is enough. `fonts.ready` can already
   * be fulfilled at the moment this runs: it is read inside foliate's `load`
   * callback, before the iframe has rendered anything, so the set may be idle
   * and the promise resolves immediately — before the face the render is about
   * to request has even been asked for. `loadingdone` fires when a later cycle
   * finishes, which is the one that matters. Redrawing twice is harmless;
   * `addAnnotation` replaces rather than stacks.
   */
  #redrawWhenFontsLand(doc: Document): void {
    const fonts = doc.fonts
    if (!fonts) return

    const redraw = () => {
      /* This document's own section, not every live one. The liveness check
       * alone was not enough: a font settling in any still-mounted section
       * redrew all of them, which for a book with marks in three rendered
       * sections is three times the CFI resolution for one font event. */
      if (this.#disposed || !this.#unwatch.has(doc)) return
      const view = this.#view
      const index = this.#indexOf.get(doc)
      if (!view || index === undefined || !this.#sections.has(index)) return
      this.#drawSection(view, index)
    }

    fonts.addEventListener('loadingdone', redraw)
    this.#onTeardown(doc, () => fonts.removeEventListener('loadingdone', redraw))

    /* `FontFaceSet.ready` does not reject — a document torn down mid-load
     * simply never settles it. But `.then(redraw)` is a NEW promise, and it
     * rejects if `redraw` throws, which this used to leave unhandled at the
     * window. Reported, not swallowed: the point of the original "no catch"
     * note was that a failure in `redrawMarks` must not disappear, and a catch
     * that logs keeps that while giving the rejection somewhere to go. */
    void fonts.ready
      .then(redraw)
      .catch((cause: unknown) => console.error('Paper: redraw after fonts loaded failed', cause))
  }

  /** Drop the listeners a document had, before re-registering them. */
  #resetWatchers(doc: Document): void {
    for (const off of this.#unwatch.get(doc) ?? []) off()
    this.#unwatch.delete(doc)
  }

  /**
   * Idempotent, and safe at any point in startup.
   *
   * Every step is isolated, and the resource-releasing half runs in a `finally`.
   * `#disposed` latches on entry, so a single throwing host callback or teardown
   * function used to abort the rest of this method permanently: the next call
   * returned at the guard, and the listeners, the prepared book, the view and
   * the host were never released. The one thing teardown must not do is stop
   * halfway, so nothing here is allowed to propagate.
   */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    try {
      quietly('onDocument', () => this.#cb.onDocument(null))
      quietly('onNavigator', () => this.#cb.onNavigator(null))
      quietly('onSelection', () => this.#cb.onSelection(null))
      for (const offs of this.#unwatch.values())
        for (const off of offs) quietly('teardown', off)
    } finally {
      this.#unwatch.clear()
      this.#sections.clear()
      this.#rendered.clear()
      this.#foreignDrawn.clear()
      this.#reconciling.clear()
      this.#painters = null
      /**
       * ⚠️ **THE OPEN NOTE USED TO SURVIVE THE BOOK.**
       *
       * A footnote is rendered into its own `View` — a second foliate view with
       * its own iframe, renderer and listeners — and it is mounted OUTSIDE
       * `#host` whenever `setFootnoteMount` has been given somewhere to put it,
       * which is how the reader draws notes in the gloss strip. So
       * `#host.replaceChildren()` below did not remove it: closing a book with
       * a note open left that note on screen, over the next book, with a live
       * iframe and a renderer behind it. One per book opened.
       *
       * BEFORE the host is cleared, and independently of it — the release must
       * not depend on where the note happened to be mounted, which is the
       * assumption that made this invisible.
       */
      quietly('footnote view', () => this.#notes.release())
      /* AND THE HOST IS TOLD. `#disposed` is already true, so `closeFootnote`
         would skip this — and a host left holding a `FootnoteRender` for a
         session that is gone draws a note nothing can close. */
      quietly('onFootnote', () => this.#cb.onFootnote(null))
      /* AND THE PLATE, for the reason directly above: a host left holding a
         `PlateDetail` for a session that is gone draws an image nothing can
         close, over the next book. The URL is released first — `onPlate(null)`
         takes the viewer down, and revoking under a live `<img>` would blank it
         for the frame between. */
      quietly('plate url', () => this.#releasePlate())
      quietly('onPlate', () => this.#cb.onPlate(null))
      const prepared = this.#prepared
      this.#prepared = null
      if (prepared) destroyQuietly(prepared)
      const built = this.#view
      this.#view = null
      if (built) {
        closeQuietly(built)
        /**
         * ⚠️ **`View.close()` CLOSES THE RENDERER AND NEVER THE BOOK.** The
         * fork's `close` destroys and removes the renderer and nulls its own
         * progress state; the `Book` — the backend's parse — is not its to
         * release, and until now nothing else released it either. A
         * fixed-layout EPUB keeps every visited section's blob URLs in
         * `Loader.#cache`; CBZ holds two object URLs per page; FB2 mints one
         * per section at parse; MOBI holds `#resourceCache`. The enrichment
         * pass found and fixed this for ITS parse (`parseBook.ts`); the
         * reader's own path was missed — one book's resources per book opened.
         *
         * AFTER the note view and after the close, because the note view
         * SHARES the book (which is why `releaseNoteView` correctly leaves it
         * alone) and a book destroyed under a renderer still tearing down is a
         * renderer reading revoked URLs. And NOT AGAIN for a PDF: there the
         * book IS `#prepared`, destroyed just above, and `makePdf`'s teardown
         * releases a worker that is not there to release twice.
         */
        const book: unknown = built.book
        if (book !== prepared && destroyable(book)) destroyQuietly(book)
      }
      quietly('host cleanup', () => this.#host.replaceChildren())
    }
  }
}

/**
 * The table of contents' own label for each spine section it names.
 *
 * ⚠️ **THE TITLES COME FROM `resolveHref`, NOT FROM COUNTING.** Matching the
 * table of contents to the spine positionally looks right on a tidy book and is
 * wrong on every one with a cover, a colophon or a part divider — the labels
 * then slide by one and every chapter in the export is named after the one
 * before it. The book resolves its own hrefs; ask it.
 *
 * ⚠️ **AND THE ANSWER IS AWAITED, BECAUSE A BACKEND'S MAY BE A PROMISE.** This
 * read `.index` straight off the call, and a promise has no `index`: every
 * chapter came out untitled and numbered with nothing logged, and a destination
 * the backend REFUSES rejected outside the `try` written for exactly that case,
 * as an unhandled rejection per broken contents entry. `makePdf`'s resolver is
 * the `async` one that found it — an outline destination is looked up through
 * pdf.js — while the EPUB backend answers at once, which is why nothing looked
 * wrong. Awaiting takes both shapes, and it is the only defence left for a
 * third backend that answers slowly: PDFs no longer reach this at all, because
 * a book of fixed pages is refused an audiobook (`useAudiobook`).
 *
 * ⚠️ **ONE TRAVERSAL, `flattenToc`'s.** This walked the tree with a recursion of
 * its own, which is how `tocOrder.ts` says the contents pane and the voice came
 * to disagree about what "next chapter" means — a third reader of the same tree
 * is the same risk for what an exported chapter is called.
 *
 * SHALLOWEST WINS, then the first in reading order: a nested entry resolving to
 * a section a part title already names would otherwise replace it with a
 * sub-heading. It was "first in reading order" alone, which is the same answer
 * for a part and its own children and the wrong one when a sub-entry of an
 * EARLIER part points into a chapter that has an entry of its own.
 *
 * NARROWED, not assumed: upstream's types do not declare `resolveHref` and its
 * API is explicitly unstable, so a backend without it names no section rather
 * than failing the export — and a malformed href in a stranger's book is a
 * chapter with no title, not a failed export.
 */
async function tocTitles(book: Book, toc: readonly TocItem[]): Promise<ReadonlyMap<unknown, string>> {
  const entries = flattenToc(toc)
  const resolveHref = (book as { resolveHref?: unknown }).resolveHref
  if (typeof resolveHref !== 'function') {
    /* A BACKEND THAT LACKS THE METHOD SAYS SO — `#publish`'s rule for
       `getCover`, and for the same reason: an untitled export is a legitimate
       answer for a book with no contents, so it would look like one. */
    if (entries.length > 0) {
      console.warn('Paper: this book backend implements no resolveHref — its chapters will be exported untitled')
    }
    return new Map()
  }
  const named = await Promise.all(
    entries.map(async ({ href, label, depth }) => {
      const title = typeof label === 'string' ? label.trim() : ''
      if (typeof href !== 'string' || href === '' || title === '') return null
      try {
        const at = (await resolveHref.call(book, href)) as { readonly index?: unknown }
        /* NO ANSWER AT ALL throws on this read and is caught below, as a
           rejection is: either way the entry names nothing. And the index is
           NOT CHECKED FOR A NUMBER, deliberately — only a spine index is ever
           looked up, so any other key is one nothing reads, and a check would
           be a line no outcome depends on. */
        return { index: at.index, title, depth }
      } catch {
        return null
      }
    }),
  )
  const chosen = new Map<unknown, { title: string; depth: number }>()
  for (const entry of named) {
    if (entry === null) continue
    const held = chosen.get(entry.index)
    if (held === undefined || entry.depth < held.depth) chosen.set(entry.index, entry)
  }
  return new Map([...chosen].map(([index, { title }]) => [index, title]))
}

/**
 * The first spine item a reader can turn to, or -1 for a spine with none.
 *
 * `linear === 'no'` marks an item the reading order skips — a cover page's
 * standalone image, an in-book popup — and the paginator's own `#adjacentIndex`
 * skips them by exactly this test. The by-index fallback in `#display` lands
 * where a page turn would.
 */
function firstLinearSection(book: { readonly sections?: readonly unknown[] }): number {
  return (book.sections ?? []).findIndex((section) => (section as { linear?: unknown } | null)?.linear !== 'no')
}

/**
 * The controls whose keys are their own — see `#watchKeys`.
 *
 * The host's guard (`App.tsx`) also lists `a[href]`, and this one deliberately
 * does not. Chromium focuses a clicked link and foliate's click handler cancels
 * the CLICK, not the focus — so on the browser client a footnote the reader had
 * just tapped would leave its `<a>` focused, and → to read on would be swallowed
 * until they clicked the prose. Space and the arrows are not a link's own keys
 * in any case: Enter is, and Enter turns no page.
 */
const IN_BOOK_CONTROL = 'button, select, summary, [role="menu"], [role="listbox"], [role="dialog"]'

function onBookControl(target: HTMLElement | null): boolean {
  return typeof target?.closest === 'function' && target.closest(IN_BOOK_CONTROL) !== null
}

/** A navigation that failed, logged with what was asked — see `#publish`. */
function reportNavigation(what: string, target?: string): (cause: unknown) => void {
  return (cause) => {
    console.warn(`Paper: ${what}${target ? ` ${target}` : ''} failed`, cause)
  }
}

/**
 * Release a prepared book, reporting a failure rather than hiding it.
 *
 * Best effort because a half-open document must not stop the rest of teardown —
 * but loud, because what is being released here is a worker and a set of object
 * URLs, and a silent failure to release them is a leak that grows one book at a
 * time with nothing on screen to suggest it.
 */
function destroyQuietly(prepared: Destroyable): void {
  try {
    /* Not awaited: disposal is synchronous by contract and the session is
       being torn down either way. The promise is there for the enrichment
       pass, which parses serially and does need the worker gone — and a
       REJECTING destroy is caught too, not only a throwing one: the `try`
       cannot see a rejection, and an unhandled one at teardown was the last
       thing a closing book said (audit round 1, #837). */
    Promise.resolve(prepared.destroy()).catch((cause: unknown) => {
      console.error('Paper: failed to destroy the prepared book', cause)
    })
  } catch (cause) {
    console.error('Paper: failed to destroy the prepared book', cause)
  }
}

/**
 * Run one step of teardown without letting it stop the rest.
 *
 * `dispose()` latches `#disposed` on entry, so a step that throws used to make
 * teardown unfinishable rather than merely incomplete — the next call returned
 * at the guard and the remaining listeners, the book, the view and the host
 * were never released. Reported rather than swallowed: a host callback that
 * throws during teardown is a real defect, and the leak it used to cause was
 * invisible precisely because nothing said anything.
 */
function quietly(what: string, step: () => void): void {
  try {
    step()
  } catch (cause) {
    console.error(`Paper: ${what} threw during teardown`, cause)
  }
}

/**
 * What was closed on a view, so it is never closed twice for the same state —
 * and IS closed again when startup built something new underneath.
 *
 * Both `dispose()` and the post-await `#settle()` can legitimately reach the
 * same view: dispose closes what it holds, then the in-flight startup resolves
 * and hands the very same view back. The old `try/catch` hid the second close
 * rather than preventing it — and a swallowed double-close is precisely the
 * kind of thing that looks fine until foliate starts throwing on it.
 *
 * Keying on the view ALONE was too coarse, and leaked. `dispose()` can close a
 * view while its `open()`/`init()` is still in flight; that startup then builds
 * a renderer AFTER the close, and the `#settle()` call that would have released
 * it was suppressed as a duplicate. The renderer and its iframes survived the
 * session. So the record is the renderer that was closed, and a later call with
 * a DIFFERENT renderer — including one where there was none before — is real
 * work rather than a repeat.
 */
const CLOSED = new WeakMap<object, unknown>()

/** `renderer` is a getter that throws before `open()` has built one. */
function rendererOf(view: View): unknown {
  try {
    return view.renderer ?? null
  } catch {
    return null
  }
}

function closeQuietly(view: View): void {
  const renderer = rendererOf(view)
  if (CLOSED.has(view) && CLOSED.get(view) === renderer) return
  CLOSED.set(view, renderer)
  try {
    view.close()
  } catch {
    // close() throws when open() never got far enough to build a renderer.
  }
  /* ⚠️ **AND DETACHING IS GUARDED, WHICH IT WAS NOT.** Both callers depend on
     this returning: `dispose` releases the book and clears the host AFTER it,
     and says of itself that nothing there may propagate; `#settle` is a step of
     startup, where a throw becomes a rejected `start` nobody awaits. Reported,
     not swallowed like `close()` above, because that failure is expected and
     this one is not. */
  try {
    /* `remove` is `Element`'s, so a view always has one. */
    view.remove()
  } catch (cause) {
    console.error('Paper: a closed view would not detach', cause)
  }
}

/**
 * What the reader is told when something failed: the error's own words, or the
 * sentence this step supplies.
 *
 * ⚠️ **AN ERROR WITH NO WORDS FALLS BACK TOO.** This took any `Error`'s
 * `message` as the answer, and `new Error()` has an empty one — so a backend
 * that threw it put a blank error bar over the reader: something failed, and
 * nothing said what or where.
 */
function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== '' ? cause.message : fallback
}

/** What a zero-length file is told it is — see `isEmptySource`. */
const EMPTY_FILE = 'This file is empty.'

/**
 * Give a section document a language when it has not declared one.
 *
 * HYPHENATION NEEDS IT AND FAILS SILENTLY WITHOUT IT. `hyphens: auto` asks the
 * engine to break words by the rules of a language, and with no `lang` there is
 * no language and therefore no rule — so the setting is applied, reports
 * nothing, and does nothing. A reader sees justified text with rivers in it and
 * no way to tell that the control they turned on is inert.
 *
 * The book almost always knows. `dc:language` is in the OPF and this app
 * already parses it into `BookMeta.languages`; a section that omits `xml:lang`
 * is common in older EPUBs and is exactly the case that goes quiet.
 *
 * Only when the document is silent. A section that declares its own language —
 * a quotation in another one, a bilingual edition — is the authority, and
 * overwriting it would hyphenate French by English rules.
 */
function ensureLang(doc: Document, view: { book?: { metadata?: unknown } }): void {
  /* A document need not have a root element — a section that failed to parse
     hands back an empty one, and this runs on every section that loads. */
  const html = doc.documentElement as HTMLElement | null
  if (!html) return
  if (html.getAttribute('lang') || html.getAttribute('xml:lang')) return
  const declared = readMeta(view.book ?? {}).languages[0]
  if (!declared) return
  html.setAttribute('lang', declared)
}
