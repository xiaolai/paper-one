import { useCallback, useLayoutEffect, useMemo, useState, type CSSProperties } from 'react'
import { Bookmark, ChevronLeft, ChevronRight, Library, Plus } from 'lucide-react'
import type { ExternalLinkDetail, LinkDetail } from 'foliate-js/view.js'
import { comboFor } from '../panes'
import { FootnotePopover } from '../reader/FootnotePopover'
import type { FootnoteRender } from '../reader/session'
import type { Platform } from '../../core/metrics'
import {
  ICON,
  PANE_TRACK,
  STAGE_PADDING_X,
  measureForStep,
  pageMargins,
  paneTakesTrack,
  proseBleed,
  proseColumn,
  proseGrid,
  BRIGHTNESS,
  CONTRAST,
  stepAt,
} from '../../core/metrics'
import { bookAccent } from '../../core/bookAccent'
import { citation, type Source } from '../../core/citation'
import { decideLookUp, lookUpPress } from '../lookUp'
import { NO_GLOSS, type GlossProvider } from '../../core/gloss'
import { NOOP_DIAGNOSTICS, type Diagnostics } from '../../core/ports'
import { askGloss, useGloss } from '../hooks/useGloss'
import { marginMarks, type MarkAppearance } from '../../core/marks'
import type { MarksView } from '../hooks/useMarks'
import type { SaveFailureView } from '../hooks/useLibrary'
import type { Marking } from '../hooks/useMarking'
import type { Bookmarking } from '../hooks/useBookmarking'
import { hasOpenLayer } from '../state'
import type { AppDispatch, AppState } from '../state'
import type { Book } from '../hooks/useBook'
import { useAvailableWidth, useElementWidth } from '../hooks/useAvailableWidth'
import { useFadingHint } from '../hooks/useFadingHint'
import { FoliateView } from '../reader/FoliateView'
import type { PageIntent } from '../reader/wheelPaging'
import { MarginMarks } from '../reader/MarginMarks'
import { ReadingRuler } from '../reader/ReadingRuler'
import { SelectionTools } from '../reader/SelectionTools'
import { GlossStrip } from '../reader/GlossStrip'
import styles from './Reader.module.css'
import { pageFilter } from '../reader/fixedLayout'


/**
 * How long the return line stays.
 *
 * Long enough to read a chapter name and decide, short enough that it is gone
 * before it becomes furniture. It is an offer, not a status: the stack keeps
 * the place whether or not the reader takes it, and ⌘[ works long after this
 * has faded.
 */
const RETURN_HINT_MS = 6000

/**
 * A jump the reader can undo — the chapter they left, and which leaving it
 * this is.
 *
 * THE NONCE IS NOT DECORATION. The label is a chapter name, so two jumps out
 * of one chapter carry the same string: React bails out of a `setState` to an
 * identical value, so the prop never changes, so the fade timer never
 * restarts and the second hint inherits the first one's deadline. Following
 * two footnote links in one chapter is enough to see it — the second line can
 * vanish the moment it appears. A counter the host bumps per jump makes every
 * showing its own occasion, which is what the timer is about; the label is
 * what the reader reads. See `useFadingHint`.
 */
export interface ReturnHint {
  /** The chapter the reader just left, as they would name it themselves. */
  readonly label: string
  /** Which jump this is. Bumped by the host per hint, never reused. */
  readonly nonce: number
}

export interface ReaderProps {
  state: AppState
  dispatch: AppDispatch
  platform: Platform
  book: Book
  /**
   * The gloss provider — `NO_GLOSS` until `inference` binds one (WI-15.13).
   *
   * A prop rather than a constant reached for inside this file, for the same
   * reason `SidePane` takes the companion as one: a seam that exists in the
   * types and nowhere in the wiring cannot be substituted for, including in a
   * test.
   */
  gloss?: GlossProvider
  /**
   * Take the reader to where a model is installed.
   *
   * Called only when the gloss is `installable` and not `available` — a
   * desktop with `inference` composed and nothing downloaded yet. A host with
   * nowhere to send them passes nothing, and `decideLookUp` answers `none` so
   * the control is never drawn in the first place.
   *
   * ⚠️ IT REPLACES `onSystemLookUp`, which handed a term to Dictionary.app,
   * and the two are opposites worth noting: that prop existed so this screen
   * could stay bundlable for a browser while reaching a native command, and
   * this one exists so the screen can reach a PANE it must not know the owner
   * of. The models pane is `inference`'s, and the kernel imports nothing from
   * a capability — so what crosses is a callback, not an id.
   */
  onInstallGloss?: (() => void) | undefined
  /**
   * A save that did not land — a position, a tag, a mark's record — with
   * the way to try it again. Drawn in the notice slot over the footer, where
   * the clipboard's failures already are: the reader is here, not on the
   * shelf, when a page turn's write is refused. See `LibraryView.saveFailure`.
   */
  saveFailure?: SaveFailureView | null
  onDismissSaveFailure?: () => void
  /**
   * Where a lookup says whether it found a real sentence (WI-16.4, §F4).
   *
   * OBSERVABILITY, NOT UI. After §16 some lookups use the sentence the term
   * sits in and some fall back to the 32-character window, and the reader
   * cannot act on the difference — showing it would be noise, and this app does
   * not narrate its internals to readers. But a build where some common markup
   * sends EVERY lookup down the fallback is indistinguishable from a working
   * one without a count, which is the failure the whole phase is arranged to
   * prevent, one level up.
   *
   * The default writes nothing, so nothing here depends on the composition
   * root having bound one.
   */
  diagnostics?: Diagnostics
  marks: MarksView
  marking: Marking
  /** Keeping a place, and telling whether this one is kept — see the hook. */
  bookmarking: Bookmarking
  /**
   * A link inside the book, before foliate navigates it.
   *
   * Passed straight through to `FoliateView` rather than handled here: the
   * decision is the App's, because it needs the jump stack and (WI-12.3) the
   * footnote surface, and neither belongs to a screen. Cancelable — see
   * `LinkDetail`.
   */
  onLink: (detail: LinkDetail, event: Event) => void
  /** A link whose scheme leaves the book. See `ExternalLinkDetail`. */
  onExternalLink: (detail: ExternalLinkDetail, event: Event) => void
  /** The note to show in place, or null. See `FootnotePopover`. */
  footnote?: FootnoteRender | null
  /** The session's own close — it holds the view the note was rendered in. */
  onFootnote: (note: FootnoteRender | null) => void
  onDismissFootnote?: () => void
  /**
   * Where a jump just left from, or null — the "← Back to Loomings" line.
   *
   * A jump is the only movement in this app that can be invisible: everything
   * else is something the reader did to the page in front of them, and a jump
   * replaces it. Without a word, nothing suggests the move is undoable.
   *
   * A `ReturnHint` rather than the bare label, so a second jump out of the
   * same chapter is a second hint — see that type.
   */
  returnTo?: ReturnHint | null
  /** Go back there. The same thing ⌘[ does. */
  onReturn?: () => void
  /** The line has faded on its own; forget it. */
  onReturnDone?: () => void
  /**
   * Where the open book was last left, or null to start at the beginning.
   *
   * Passed as the value rather than as the library it comes from: the reader
   * needs one string, and taking the store would couple this screen to every
   * other thing the shelf knows.
   */
  lastLocation: string | null
  /** Opens the file picker, which the window owns — see App. */
  onAddBooks: () => void
  /**
   * How many books are on the shelf.
   *
   * The reader needs this for ONE thing and it is not decoration: with no book
   * open, this screen used to announce "Your library is empty" — from a screen
   * that is not the library, without ever asking. The app boots to the reader,
   * so a reader with ten books relaunched Paper and was told they had none.
   */
  libraryCount: number
  /**
   * The shelf could not be READ, which is not the same as having no books.
   *
   * Without it this screen says "Your library is empty" from a count of zero —
   * and a count of zero is what a failed read produces. Saying the alarming
   * thing on the strength of a transient error is the failure this whole
   * message was rewritten to avoid, arriving by another route.
   */
  shelfUnread?: boolean
  /** Show the shelf. */
  onOpenLibrary: () => void
  /**
   * True while a book is being dragged over the WINDOW.
   *
   * Owned by App, not by this component. A drop that misses an element which
   * calls `preventDefault` navigates the webview to the file and replaces the
   * whole interface, so the handling cannot be scoped to one div here — see
   * `useFileDrop`. This is only the visual state.
   */
  dragging: boolean
  /**
   * The reader's system asks for less movement, so the page turn does not slide.
   *
   * Passed down rather than read here because it is an OS preference and App
   * already owns those — the same place `prefersDark` is read.
   */
  reducedMotion: boolean
  /**
   * True when another screen is layered over the reader.
   *
   * The reader stays mounted underneath so foliate is not torn down and the
   * reading position survives — but a surface nobody can see must not still be
   * in the focus order, or Tab walks into a book that is not on screen.
   */
  inert?: boolean
}

export function Reader({
  state,
  dispatch,
  platform,
  book,
  gloss: glossProvider = NO_GLOSS,
  onInstallGloss,
  saveFailure = null,
  onDismissSaveFailure,
  diagnostics = NOOP_DIAGNOSTICS,
  marks,
  marking,
  bookmarking,
  returnTo = null,
  onReturn,
  onReturnDone,
  footnote = null,
  onFootnote,
  onDismissFootnote,
  onLink,
  onExternalLink,
  lastLocation,
  reducedMotion,
  onAddBooks,
  libraryCount,
  shelfUnread = false,
  onOpenLibrary,
  dragging,
  inert = false,
}: ReaderProps) {
  /* The stage element as STATE, not just a ref: the popup and the margin marks
   * both position against it, and a ref's `.current` landing after the first
   * render does not re-render them. They would measure against null once and
   * never again. */
  const [stage, setStage] = useState<HTMLDivElement | null>(null)

  /**
   * A passing message about an action that did not work.
   *
   * Separate from `book.error` on purpose, and the separation is load-bearing:
   * a book error means the book is not readable, and the branch below replaces
   * the whole reader with it. Routing a failed CLIPBOARD WRITE through that
   * channel therefore threw the reader off the screen — book intact, nothing
   * wrong with it — over a copy that did not land. A failed action says so and
   * gets out of the way.
   */
  const [notice, setNotice] = useState<string | null>(null)

  /**
   * The return line fades on its own after a few seconds.
   *
   * NOT `notice`, which is amber and waits to be dismissed. That channel is
   * for an action that did not work, and this is the opposite — a thing that
   * worked, offering to be undone. Sharing it would have made every successful
   * jump look like a failure and demanded a click to clear.
   *
   * Restarts on each new jump — INCLUDING A SECOND JUMP OUT OF THE SAME
   * CHAPTER, which is what the nonce is for — so jumping twice quickly leaves
   * one line showing the most recent departure rather than two racing timers
   * where the first clears the second's message. Both traps under the timing
   * here are written up in `useFadingHint`, which owns them so they can be
   * tested without mounting this screen.
   */
  useFadingHint({ nonce: returnTo?.nonce ?? null, after: RETURN_HINT_MS, done: onReturnDone })

  const { selection, setSelection, ranges, onMarkDrawn, selected, mark, unmark } = marking

  /* WHAT `Look up` DOES, decided once per render. There used to be three
     inputs — the platform's dictionary, the gloss, and a stored preference
     between them — and there are now two, because there is one behaviour and
     nothing to choose between. `decideLookUp` is the rule; this is the wiring.

     `onInstallGloss !== undefined` IS PART OF THE QUESTION, not a guard bolted
     on. `installable` asks whether this BUILD has somewhere to install a model;
     whether this screen was handed the means to go there is a different fact,
     and the two can differ — the same distinction `onSystemLookUp` used to
     carry against `hasDictionary`. Drawing a control that cannot act is what
     both halves exist to prevent, so they are answered together. */
  /* WHERE THE GLOSS IS ANCHORED — see `GlossAnchor`, which owns the rule and
     the measurement behind the two fields it is built from. `null` while the
     reader is not looking at this book, which is what takes the strip down on
     the way to the library: `inert` already clears the selection for the
     identical reason, and the gloss was the one surface it did not reach.

     THE SPINE ITEM, THE CHAPTER AND THE TURN COUNT — and deliberately not the
     fraction or the CFI: the strip is a flex child above `.stage` (`flex: 1`),
     so its own appearance shrinks the stage and makes foliate relocate. An
     anchor either of those could move would dismiss the gloss that caused the
     reflow and loop. None of these three can be moved by a re-pagination.

     ⚠️ `book.navigation` IS THE ONE THAT COVERS THE KEYBOARD, and it is here
     because the first version of this claimed `onPageIntent` covered "every
     route" of a page turn. It does not: `App`'s key handler calls
     `book[verb]()` directly for the arrows, the paging keys and Space, and
     never reaches this screen's intent handler at all. So a keyboard turn left
     an amber definition on the new page — the exact defect the anchor was added
     to fix, surviving through the one route nobody checked. Found by audit.
     `useBook` counts the turns instead, which is the only place BOTH routes
     pass through. */
  const gloss = useGloss(
    glossProvider,
    inert
      ? null
      : `${book.generation}|${book.position.sectionIndex ?? ''}|${book.position.chapterHref}|${book.navigation}`,
  )
  const lookUpAction = decideLookUp(
    glossProvider.available,
    glossProvider.installable && onInstallGloss !== undefined,
  )
  /* THE SENTENCE, or today's answer (WI-16.4). `askGloss` walks the document
     for the sentence the term really sits in and falls back to the
     32-character window when it cannot vouch for one — so the worst outcome is
     exactly what shipped before it existed. The handler lives THERE rather
     than here so it can be driven by a test; this is the wiring and nothing
     else.

     ONLY FROM THE LOOK UP GESTURE. `publish()` never reaches here: a walk per
     `selectionchange` would be a walk per pointer move.

     The term comes back from the request rather than being passed through,
     because the sentence may not spell it the way the selection did — ruby
     readings are filtered out of both, and `漢かん字` is what `flatten` gives
     for what the book prints as `漢字`. */
  const lookUpGloss = (): void =>
    askGloss(gloss, selection, {
      fixedLayout: book.fixedLayout,
      diagnostics,
      bookTitle: book.meta?.title ?? '',
    })

  /** What the next mark takes, as one value, so nothing has to pair them up. */
  const appearance = useMemo<MarkAppearance>(
    () => ({ tint: state.markTint, style: state.markStyle }),
    [state.markTint, state.markStyle],
  )

  const windowWidth = useAvailableWidth()
  /* Must use the SAME predicate as WindowShell. Reserving PANE_TRACK whenever
   * `state.pane` is set meant that below the §06 collapse threshold — where
   * the pane is hidden — the reader still gave away 412px to nothing.
   *
   * This is only the FIRST render's estimate, because the stage has no box to
   * measure until it is attached. Everything after that is measured from the
   * stage itself: the pane's width is ANIMATED over 220ms, so arithmetic from
   * the binary open/closed state describes a layout that does not exist yet —
   * closing the pane widened the tracks immediately, while the pane was still
   * occupying its space, and the measure was clipped until the animation
   * caught up with the numbers. */
  const paneVisible = state.pane !== null && paneTakesTrack(windowWidth, state.stepIdx)
  const estimated = windowWidth - (paneVisible ? PANE_TRACK : 0) - STAGE_PADDING_X * 2
  const measured = useElementWidth(stage)
  const available = measured ?? estimated

  /* What actually goes in the margin: notes and companion marks, not every
   * highlight. Counting highlights too would open a 250px column to show a
   * column of dots that repeat what the gold fill on the words already says. */
  const inMargin = useMemo(() => marginMarks(marks.current), [marks.current])

  // The margin column is only reserved once the book has marks to put in it.
  const grid = proseGrid(available, inMargin.length > 0, measureForStep(state.stepIdx))
  /* foliate centres the book inside its own container, and the container spans
   * the whole grid — so the text only lands on the measure track while the
   * outer tracks are equal. Once marks widen the margin, the difference is
   * padded onto the WIDER side, shrinking the content box from that edge and
   * pulling its centre back onto the measure. Padding the narrower side moves
   * the centre the same way the imbalance already did, doubling the error. */
  const bleed = proseBleed(grid)

  /* Derived from the book, not drawn at random — see `bookAccent`. Null with no
   * book open, which is also what stops the rule rendering. */
  const accent = bookAccent(book.bookId, state.theme === 'night')
  /* ONE clamp for the progress track and the percentage under it. Each had
   * its own, and they had diverged: `Math.min(1, Math.max(0, NaN))` is `NaN`,
   * so a relocation with a malformed fraction drew the track at `NaN%` while
   * the footer, with its `|| 0`, said 0%. Non-finite is 0 — the footer's
   * reading, now both. */
  const progress = Number.isFinite(book.position.fraction)
    ? Math.min(1, Math.max(0, book.position.fraction))
    : 0

  /* WHERE THE WORDS ARE. The selection bar has always needed it so the popup
   * cannot hang across the margin and cover the notes drawn there; the ribbon
   * needs the same answer to sit at the page's corner rather than the window's.
   * Two callers, one locator — see `proseColumn`.
   *
   * NOT MEMOISED, and that is the honest form. It was `useMemo(…, [available,
   * grid])`, and `grid` is built fresh by `proseGrid` on every render — so the
   * dependency never matched and the memo recomputed every time while looking
   * as though it did not. `proseColumn` is four additions; the memo bought
   * nothing and hid that it bought nothing. */
  const column = proseColumn(available, grid)

  /* Whether the chrome is showing, as one value — it decides the footer's
     opacity AND whether the control in it can be pressed or focused, and those
     must never be able to disagree. */
  const chromeShown = state.chromeOn || state.pane !== null
  /* Says which of the two things pressing it does, exactly as the palette row
     does. A toggle labelled with its subject rather than its action leaves the
     reader to guess which state they are looking at. */
  /* ONE ANSWER TO "IS THIS PAGE KEPT". The ribbon, the label, the lit state,
     `aria-pressed` and the icon's fill all asked separately, two of them by
     truthiness and two by an explicit null check — five spellings of one
     question that can drift apart one at a time. */
  const bookmarked = bookmarking.here !== null
  const bookmarkLabel = bookmarked ? 'Remove this bookmark' : 'Bookmark this place'

  const gridVars = {
    '--stage-pad-x': `${STAGE_PADDING_X}px`,
    '--text-bleed-start': `${bleed.start}px`,
    '--text-bleed-end': `${bleed.end}px`,
    /* The same two numbers again, for the same job, reaching a different
     * element. In scrolled flow the book element is the scroll port and spans
     * the stage, so the bleed cannot narrow it — it is applied INSIDE the port
     * instead, as padding on foliate's `#container`. These names are the fork's
     * hooks; the shadow root is closed and a custom property is the only thing
     * that crosses it. Inert in paginated flow, where the fork reads them only
     * under `:host([flow="scrolled"])`. */
    /* HALF the page's margins — the lane between the book element's edge and
       the page's own, which is where the turn controls sit. Published rather
       than restated in CSS because it is the same number `applyLayout` adds to
       the measure to size the page, and the two must not drift. */
    '--page-margin': `${pageMargins(grid) / 2}px`,
    '--paper-scroll-pad-start': `${bleed.start}px`,
    '--paper-scroll-pad-end': `${bleed.end}px`,
    /* §06: the bar is off by default. `none` hides it without disabling the
     * scrolling itself — wheel, trackpad, Space and the arrow keys all still
     * work, which is what makes hiding it a reasonable default rather than a
     * removed capability. */
    '--paper-scrollbar-width': state.scrollbarOn ? 'auto' : 'none',
    '--track-gutter': `${grid.gutter}px`,
    '--track-measure': `${grid.measure}px`,
    '--track-margin': `${grid.marginCol}px`,
    '--track-gap': `${grid.gap}px`,
    /* WI-14.5 — THE ONLY THING A FIXED-LAYOUT PAGE CAN TAKE FROM THE READER'S
       LIGHT. A PDF page is pixels pdf.js painted onto a canvas, so there is no
       colour to declare and no `setStyles` to declare it with; what there IS,
       on both renderers, is `part="filter"` on the page's iframe, exported
       through the view's closed shadow root. See `fixedLayout.ts` for the
       contract and for what the inversion costs.

       `none` FOR A REFLOWABLE BOOK, and not because it would be redundant: the
       book's own sheet already carries the theme, the brightness and the
       contrast, so a filter on top would apply every one of them TWICE. */
    '--paper-page-filter': book.fixedLayout
      ? pageFilter({ theme: state.theme, brightness: state.brightness, contrast: state.contrast })
      : 'none',
  } as CSSProperties

  /**
   * Take down a selection — the BOOK's and React's, which are two things.
   *
   * `deselect` clears the book's own selection inside its document; React's
   * copy follows asynchronously, on the `selectionchange` that results. Clearing
   * only the first leaves the toolbar drawn over the page for a frame, which is
   * why every call site does both.
   *
   * One callback because there were three spellings of this pair across the
   * file, and the drift between them is what let the page-turn path guard the
   * teardown on a value that is not always populated yet.
   */
  const clearSelection = useCallback(() => {
    book.deselect()
    setSelection(null)
  }, [book])

  /**
   * Put something on the clipboard.
   *
   * ONE PATH FOR EVERY WAY OF COPYING, because the failure handling is the
   * whole of it and it is easy to get wrong three times over: clipboard access
   * can be absent or refused, and the control that asked for the copy carries
   * on either way — so a copy that did not happen looks exactly like one that
   * did, until the reader pastes nothing. Three callers now — the selection
   * popup's two, and the note popover's copy.
   */
  const copyText = useCallback((text: string) => {
    const clipboard = navigator.clipboard
    if (text && clipboard) {
      void clipboard.writeText(text).catch((cause: unknown) => {
        console.error('Paper: could not copy', cause)
        setNotice('That could not be copied to the clipboard.')
      })
    } else if (text) {
      setNotice('This device has no clipboard available.')
    }
  }, [])

  /** Copy a passage, and take the selection down with it — the popup's way. */
  const copyToClipboard = useCallback(
    (text: string) => {
      copyText(text)
      clearSelection()
    },
    [copyText, clearSelection],
  )

  /**
   * Where the passage came from, for a citation.
   *
   * THE PAGE IS THE SECTION INDEX PLUS ONE, and only for a book that has pages:
   * `makePdf` builds one section per PDF page, so for a PDF the two are the
   * same number counted from different places. Reflowable text has no page at
   * all — `pageCount` is 0 there and `citation` falls back to the chapter,
   * which is the locator that survives being read at somebody else's font size.
   */
  const sourceFor = useCallback(
    (sectionIndex: number): Source => ({
      title: book.meta?.title ?? '',
      author: book.meta?.author ?? '',
      chapter: book.position.chapterLabel,
      page: (book.meta?.pageCount ?? 0) > 0 ? sectionIndex + 1 : 0,
      fraction: book.position.fraction,
    }),
    [book.meta, book.position],
  )

  /* Leaving the reader takes the selection with it.
   *
   * This screen stays MOUNTED under the library so foliate is not torn down,
   * and the popup sits on §12's popover layer — far above the shelf's own, so
   * nothing about being covered hides it. A passage selected and then left
   * behind therefore put a toolbar over the covers: controls belonging to a
   * book nobody can see, offering to mark text that is not on screen. The
   * palette's "Mark this passage" outlived the reader by the same route, since
   * it is offered whenever a selection exists.
   *
   * Exactly the reasoning of the page turn below — the popup is anchored to a
   * passage that has stopped being shown — so it is taken down the same way,
   * the book's own selection with it.
   *
   * A LAYOUT effect, because an ordinary one runs after the paint that put the
   * shelf up: the popup would be drawn over the covers for a frame and then
   * disappear, which is the flicker rather than the fix.
   */
  useLayoutEffect(() => {
    if (inert) clearSelection()
  }, [inert, clearSelection])

  /* A wheel gesture turns one page — the policy half of `wheelPaging`.
   *
   * The same guards §11's reading keys use, and for the same reasons: the
   * reader stays MOUNTED under the library and under every overlay, so a
   * gesture over the shelf or the palette would turn pages in a book nobody can
   * see. Paged flow only — in scrolled flow a slightly diagonal two-finger
   * scroll would turn pages while someone is reading downward.
   *
   * `goLeft`/`goRight` rather than `prev`/`next`, because the gesture knows
   * only which way the reader pushed and foliate knows which page that is: in a
   * right-to-left book the next page is the one on the left.
   */
  const onPageIntent = useCallback(
    (intent: PageIntent) => {
      /* A fixed-layout book takes page intents in BOTH modes, which is why the
       * setting alone is not the question.
       *
       * `foliate-fxl` never reads `flow`; the same setting reaches it as `zoom`,
       * where `fit-page` shows a whole page and `fit-width` overflows it so the
       * renderer scrolls. So a PDF is paged in one mode and scrolled in the
       * other, exactly like an EPUB — but in the scrolled one the session only
       * raises an intent at a scroll EDGE or from a sideways gesture, which is
       * what carries the reader from the foot of one page to the next.
       *
       * Asking `state.pageLayout` alone dropped every PDF gesture, because
       * scrolled is the default and it describes a PDF's renderer under a name
       * that renderer does not answer to. */
      if (state.pageLayout !== 'paginated' && !book.fixedLayout) return
      if (state.screen === 'library' || hasOpenLayer(state)) return
      /* The side pane counts too, below §06's threshold, where it stops being a
       * track beside the reader and becomes a SHEET over it. `hasOpenLayer`
       * knows only about the palette and the switcher, so without this a
       * gesture over the sheet paged the book behind it. */
      if (state.pane !== null && !paneVisible) return

      /* Unconditionally, and NOT gated on `selection` being set.
       *
       * Turning the page under a live selection leaves the toolbar floating over
       * text that is no longer there — the popup is positioned against a range
       * on the page being left. Guarding on React's committed `selection` looked
       * equivalent and was not: a pointer selection is published after deferred
       * SNAPPING, so there is a window where the document holds a real selection
       * and this value is still null. A gesture landing in that window skipped
       * the teardown entirely, and the toolbar then arrived over the new page.
       *
       * Clearing when there is nothing to clear costs a no-op call, which is the
       * cheaper side of the trade by a wide margin. */
      clearSelection()

      /* ⚠️ NO `gloss.dismiss()` HERE, AND THERE WAS ONE. It covered this route
       * and only this route, while `App`'s key handler turns pages without ever
       * calling it — so the teardown fired for a wheel gesture and not for the
       * arrow key beside it. `book.navigation` counts turns where both routes
       * meet and feeds the gloss anchor; a second copy here would be the same
       * decision in two places, and the copy that was missing a route is
       * exactly how this was wrong the first time. */

      /* Four intents, two pairs, because the axes mean different things. A
       * horizontal gesture named a SIDE and foliate resolves which page that is
       * from the book's own direction; a vertical one named a DIRECTION OF
       * TRAVEL through the book, which needs no resolving and must not be given
       * any — routing it through goLeft/goRight would reverse the mouse wheel
       * in a right-to-left book. */
      if (intent === 'left') book.goLeft()
      else if (intent === 'right') book.goRight()
      else if (intent === 'next') book.next()
      else book.prev()
    },
    /* `clearSelection` is what the body calls; `selection` and `setSelection`
       were what an earlier body read, and had outlived it in this list.
       The gloss is no longer named at all — its teardown moved to the anchor,
       which sees the keyboard route this callback cannot. */
    [state, book, paneVisible, clearSelection],
  )

  /**
   * Show a mark in Notes — focus it, then open the pane.
   *
   * Three routes reach this: clicking a drawn highlight, clicking one in the
   * margin, and making a note from the selection. Opening the panel is NOT
   * showing the mark, which is why both halves are always needed: the list holds
   * every mark in every book, so landing at the top of it leaves the reader to
   * find the one they just clicked. Written out three times, one of them was
   * always going to drift.
   *
   * `null` OPENS THE PANE WITHOUT FOCUSING ANYTHING, which is what the note
   * route did when a mark could not be made — kept deliberately, because a
   * refactor that quietly stops opening a panel is a refactor that changed
   * behaviour while claiming to move code.
   */
  const showInNotes = useCallback(
    (id: string | null, editing = false) => {
      if (id) marking.focusMark(id, editing)
      dispatch({ type: 'openPane', pane: 'marginalia' })
    },
    [marking, dispatch],
  )

  return (
    <div className={styles.reader} inert={inert}>
      <div className={styles.column} data-platform={platform}>
        {book.source ? (
          <>
            {/* A book that will not open has to say so, and INSTEAD of the
                reader rather than above it. Rendering the stage anyway left a
                failed view, an empty margin, a live selection popup and a
                progress footer under the message — an interface that looks
                like a book is open, reporting that one is not. */}
            {book.error ? (
              <div className={styles.errorBar}>
                <p className={styles.error}>{book.error}</p>
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => book.close()}
                >
                  Choose another book
                </button>
              </div>
            ) : (
              <>
                <div
                  className={styles.stage}
                  ref={setStage}
                  style={gridVars}
                >
                  {/* The book's own edge. Rendered before everything else so it
                      sits at the back of the stage; it is at x=0, where nothing
                      else in the reading area reaches, so it needs no layer of
                      its own under §12. */}
                  {state.progressLineOn && accent && (
                    <div
                      className={styles.progressTrack}
                      /* THE EDGE THE PANE IS NOT ON. The rule is a property of
                         the page, and the page's free edge is whichever one the
                         pane has not taken — put them on the same side and the
                         rule ends up in the seam between the book and the pane,
                         reading as a divider between two panels rather than as
                         how far through the book the reader is.
                         The pane's SETTING, not whether it happens to be open,
                         so the rule does not jump across the window every time
                         the pane is shown or hidden. */
                      data-edge={state.side === 'left' ? 'end' : 'start'}
                      aria-hidden="true"
                    >
                      <div
                        className={styles.progressFill}
                        style={{
                          height: `${progress * 100}%`,
                          background: accent,
                        }}
                      />
                    </div>
                  )}

                  {/* The page is kept.
                      A SIBLING OF THE PROGRESS RULE, on the stage — see
                      `ribbonInset` for why neither the stage's own edge nor the
                      text column's names the page's corner, and what each got
                      wrong.

                      NOT A CONTROL. The toggle is in the footer and ⌘B is
                      bound; a ribbon that could also be clicked would be a
                      third way to do one thing, sitting over the text, where a
                      mis-click removes something the reader meant to keep. It
                      reports. */}
                  {bookmarked && !book.fixedLayout && (
                    <div
                      className={styles.ribbon}
                      /* THE BOOK'S DIRECTION, NOT THE APP'S. `ribbonInset` is
                         written with `inset-inline-end`, which resolves against
                         whatever direction the element inherits — the shell's,
                         which is always LTR. In a right-to-left book the page's
                         trailing edge is on the LEFT, so the ribbon sat at the
                         wrong corner of the page it marks, and the arithmetic
                         that finds the page's edge was mirrored with it. Set
                         here rather than on the stage: this is the only thing
                         on the stage that positions itself against the PAGE
                         rather than the window. */
                      dir={book.direction}
                      aria-hidden="true"
                    />
                  )}

                  <div className={styles.gutter}>
                    <ReadingRuler
                      state={state}
                      dispatch={dispatch}
                      doc={book.doc}
                      stage={stage}
                    />
                  </div>

                  <div className={styles.text} data-flow={state.pageLayout}>
                    <FoliateView
                      file={book.source}
                      generation={book.generation}
                      stepIdx={state.stepIdx}
                      /* The COMPUTED measure, not `measureForStep`. See
                         `applyLayout` — the renderer drew over the gutter for
                         as long as it derived this for itself. */
                      measure={grid.measure}
                      /* The page's own margins — see `pageMargins`. Off the
                         same grid as the measure, because the renderer adds
                         the two to size the page it turns. */
                      pageMargins={pageMargins(grid)}
                      theme={state.theme}
                      typeface={state.typeface}
                    spacing={state.spacing}
                    /* WI-14.4's fifteen, handed down whole — see `ReadingStyle`.
                       The reducer returns the SAME object when a setting has not
                       moved, so this cannot re-run the settings effect on an
                       unrelated dispatch. */
                    style={state.readingStyle}
                    align={state.align}
                    /* RESOLVED here, not passed as indices: the book is an
                       iframe and cannot read the app's custom properties, so it
                       is told the numbers. */
                    brightness={stepAt(BRIGHTNESS, state.brightness)}
                    contrast={stepAt(CONTRAST, state.contrast)}
                      animated={!reducedMotion}
                      paginated={state.pageLayout === 'paginated'}
                      lastLocation={lastLocation}
                      onToc={book.setToc}
                      onRelocate={book.setPosition}
                      onDocument={book.setDoc}
                      onMeta={book.setMeta}
                      onCover={book.setCover}
                      onError={book.fail}
                      onNavigator={book.setNavigator}
                      marks={marks.current}
                      onSelection={setSelection}
                      onMarkDrawn={onMarkDrawn}
                      onLink={onLink}
                      onExternalLink={onExternalLink}
                      onFootnote={onFootnote}
                      onFileDropped={book.open}
                      onPageIntent={onPageIntent}
                      onFixedLayout={book.setFixedLayout}
                      onDirection={book.setDirection}
                      /* NO `onMarkActivated`. Clicking a mark used to open
                         Notes on it; it SELECTS the passage now — see
                         `show-annotation` in `session` — so the selection tools
                         come up over the highlight and every one of them
                         applies to it: its colour, its style, a note, a copy,
                         or taking it off. The panel is still one press away on
                         the bar and one click away from the margin, which is
                         where a reader goes to READ a note rather than to act
                         on the passage it belongs to. */
                    />

                    {/* §11: the page to either side, on the pointer.
                        PAGED FLOW ONLY, which is the same line the reading
                        ruler is drawn on from the other side — the ruler is
                        scrolled-only because there are no lines to advance in
                        paged flow, and these are paged-only because there are
                        no pages to turn in scrolled flow. The two can never be
                        on screen together, so they can share the gutter.

                        SIDES, NOT NEXT AND PREVIOUS. `onPageIntent` resolves
                        which page a side is through foliate's `goLeft`/
                        `goRight`, so in a right-to-left book the left chevron
                        advances — and it carries the guards this must not
                        skip: it clears the selection, refuses while the palette
                        or switcher is open, and refuses when the pane is a
                        sheet over the reader rather than a track beside it.

                        NOT IN THE TAB ORDER. The arrow keys already turn the
                        page and are published in the palette, and a focused
                        button here would swallow them: `App`'s key handler
                        stands down when focus is on a control, so clicking a
                        chevron would stop ← and → working until the reader
                        clicked somewhere else. */}
                    {/* REFLOWABLE ONLY, and not merely paged. `--page-margin`
                        comes off the prose grid, and `foliate-fxl` reads none
                        of it — not `max-inline-size`, not `gap` — it scales and
                        centres its own page. So on a PDF these lanes describe a
                        page that is not there, and the chevrons can land over
                        the page instead of beside it. The arrow keys and the
                        wheel already turn a PDF; this is the one route that
                        needs geometry the renderer will not give.

                        The `book.source` and `book.error` guards that were here
                        are redundant — this subtree is already inside both. */}
                    {state.pageLayout === 'paginated' && !book.fixedLayout && (
                      <>
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label="Page to the left"
                          className={styles.turn}
                          data-side="left"
                          onClick={() => onPageIntent('left')}
                        >
                          <span className={styles.turnGlyph}>
                            <ChevronLeft strokeWidth={ICON.stroke} />
                          </span>
                        </button>
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label="Page to the right"
                          className={styles.turn}
                          data-side="right"
                          onClick={() => onPageIntent('right')}
                        >
                          <span className={styles.turnGlyph}>
                            <ChevronRight strokeWidth={ICON.stroke} />
                          </span>
                        </button>
                      </>
                    )}
                  </div>

                  {/* Rendered only when there is something to put in it; the
                      track collapses to the gutter's width otherwise. */}
                  {inMargin.length > 0 && (
                    <div className={styles.margin}>
                      <MarginMarks
                        marks={inMargin}
                        ranges={ranges}
                        stage={stage}
                        doc={book.doc}
                        position={book.position}
                        onSelect={(picked) => showInNotes(picked.id)}
                      />
                    </div>
                  )}

                  {/* The note, over the page it came from. Placed against the
                      reference rather than the pointer — see `FootnotePopover`.

                      INSIDE THE STAGE, beside the selection popup, and that is
                      load-bearing rather than tidy. Three things have to agree
                      about which origin they are measured from: where the
                      reference is, where the column is, and what `left`/`top`
                      resolve against. As a SIBLING of the stage the last of
                      those was the reading column instead — so the note sat off
                      by the stage's padding and the titlebar's inset, which is
                      the failure `placement.ts` names in its header:
                      numerically valid, wrong by exactly a container's offset,
                      and nothing able to tell. In here the stage is the
                      popover's offset parent, which is the space the session
                      measures the reference in and the space `proseColumn`
                      reports. */}
                  <FootnotePopover
                    note={footnote}
                    stage={stage}
                    /* Bounded by the WORDS, not by the grid — the same bound the
                       selection popup takes, and for the same reason: past the
                       measure is the margin, where the margin notes are drawn. */
                    column={book.fixedLayout ? null : column}
                    onMount={book.setFootnoteMount}
                    onCopy={copyText}
                    onDismiss={() => onDismissFootnote?.()}
                  />

                  <SelectionTools
                    selection={selection}
                    stage={stage}
                    /* The words' own column, so the bar cannot hang across the
                       margin and cover the notes drawn there. A fixed-layout
                       page fills the grid and has no measure, so it keeps the
                       stage — see `column`. */
                    column={book.fixedLayout ? null : column}
                    marked={selected}
                    position={book.position}
                    appearance={appearance}
                    /* ONE WAY TO APPLY AN APPEARANCE, whichever control asked
                       for it. The popup decides WHAT — the last one made, or the
                       mark already on the passage, with one axis changed — and
                       this only carries it out and remembers it.
                       Acted on with the value the popup passed, never with the
                       one in state: these dispatches have not been applied yet,
                       so reading state here would lay down the PREVIOUS
                       appearance on the very press that chose a new one. */
                    onApply={(next, keep) => {
                      dispatch({ type: 'setMarkTint', tint: next.tint })
                      dispatch({ type: 'setMarkStyle', style: next.style })
                      mark(selected?.note ?? '', next, keep)
                    }}
                    onNote={() => {
                      /* The note itself is written in the Marginalia panel, where
                         there is room for it. Marking first is what gives it an
                         anchor — and the editor for THAT mark opens with the
                         panel, rather than leaving the reader to find the row
                         and click "Add a note" a second time.
                         ONLY when there is nothing to write on yet. A passage
                         that is already marked has its anchor, and re-marking it
                         here would lay the LAST-USED appearance over the one it
                         is already wearing — recolouring a mark on the way to
                         writing a note about it. */
                      if (selected) {
                        showInNotes(selected.id, true)
                        clearSelection()
                        return
                      }
                      const created = mark('', appearance)
                      showInNotes(created?.id ?? null, true)
                    }}
                    onCopy={() => copyToClipboard(selection?.text ?? '')}
                    onCite={() => {
                      if (!selection) return
                      copyToClipboard(citation(selection.text, sourceFor(selection.sectionIndex)))
                    }}
                    onLookUp={
                      /* ONE GESTURE, ONE THING, and the whole decision lives in
                         `lookUp.ts` where it can be RUN by a test — `Reader`
                         cannot be mounted cheaply, so anything left here could
                         only ever be checked by reading this file back.

                         ⚠️ `install` CALLS THE SAME FUNCTION AS `gloss`, and
                         that is deliberate. `useGloss.ask` already decides what
                         an unavailable provider does — it sets `unavailable`
                         rather than returning silently — so branching here
                         would be a second copy of a decision the hook has to
                         make anyway, and the two would eventually disagree
                         about which states are reachable.

                         ⚠️ THE TERM THUNK IS GONE for that same rule, one case
                         later: `lookUpPress` used to take the selection's text
                         and drop the press when it was too long, silently. The
                         bound is `useGloss.ask`'s now, where a refusal can be
                         a state the reader reads rather than nothing at all. */
                      lookUpPress(lookUpAction, lookUpGloss)
                    }
                    onRemove={() => {
                      if (selected) unmark(selected)
                      clearSelection()
                    }}
                  />
                </div>

                {/* THE GLOSS, the lookup that did not arrive, and the lookup
                    that had nothing to answer it. Its own component (WI-16.3)
                    so the three can be RENDERED in a test rather than read back
                    out of this file's source — see `GlossStrip`, where the
                    whole argument lives.

                    `onInstall` is passed unconditionally, and it is no longer
                    the only thing gating the offer. This used to argue that the
                    strip "reads it only in the `unavailable` state, which
                    `useGloss` can only reach when the provider is unavailable,
                    which is the same condition that made `decideLookUp` answer
                    `install`" — untrue in the window between the draw and the
                    press, where a model uninstalled in between reaches
                    `unavailable` from a button drawn as `gloss`, with nothing
                    to install into. `GlossState.unavailable` now carries
                    `installable` read at the press, and the strip needs both.
                    What this prop still answers is the other half: whether this
                    SCREEN was given anywhere to send the reader. */}
                <GlossStrip
                  state={gloss.state}
                  onDismiss={() => gloss.dismiss()}
                  onInstall={onInstallGloss}
                />

                {/* The way back from a jump. Above the failure notice and
                    styled apart from it: one is an offer and the other is an
                    apology, and a reader should not have to read them to tell
                    which. */}
                {returnTo && onReturn && (
                  <div className={styles.returnHint} role="status">
                    <button type="button" className={styles.returnHintGo} onClick={onReturn}>
                      ← Back to {returnTo.label}
                    </button>
                    <span className={styles.returnHintKey}>{comboFor('⌘[', platform)}</span>
                  </div>
                )}

                {/* A save that did not land (WI-20.36): the position this page
                    turn wrote, or the mark's record. Amber, like the clipboard's
                    failure below, and beside its retry — the reader is here
                    when the disk refuses a write, not on the shelf. */}
                {saveFailure && (
                  <div className={styles.notice} role="status">
                    <span>{saveFailure.message}</span>
                    {saveFailure.retry !== null && (
                      <button type="button" className={styles.noticeDismiss} onClick={saveFailure.retry}>
                        Retry
                      </button>
                    )}
                    {onDismissSaveFailure && (
                      <button type="button" className={styles.noticeDismiss} onClick={onDismissSaveFailure}>
                        Dismiss
                      </button>
                    )}
                  </div>
                )}

                {/* §11: say what happened. It sits over the footer rather than
                    displacing the text, and it dismisses itself — the reader
                    has already moved on to whatever they meant to paste. */}
                {notice && (
                  <div className={styles.notice} role="status">
                    <span>{notice}</span>
                    <button
                      type="button"
                      className={styles.noticeDismiss}
                      onClick={() => setNotice(null)}
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                <div
                  className={styles.footer}
                  style={{ opacity: chromeShown ? 1 : 0 }}
                  /* The fade has to take the button's clicks with it — see the
                     rule this selects. A readout could fade on opacity alone;
                     a control cannot. */
                  data-visible={chromeShown}
                  /* AND ITS FOCUS. `pointer-events: none` stops the mouse and
                     nothing else: a button at `opacity: 0` stays in the tab
                     order, so Tab walked into an invisible control that
                     reported a state nobody could see and acted when pressed.
                     `inert` is what removes a subtree from focus as well as
                     from hit-testing. */
                  inert={!chromeShown}
                >
                  {/* §11's ⌘B, as something to press. The palette carries the
                      same action and the same label rule; this is the one a
                      reader finds without knowing the app. */}
                  <button
                    type="button"
                    className={styles.bookmarkToggle}
                    data-on={bookmarked}
                    /* Disabled rather than absent, unlike the chevrons beside
                       the page: those are missing where they would describe a
                       page that is not there, and this is a control that WILL
                       work in a moment — the renderer has simply not reported
                       a position yet. A control that disappears for a second
                       on every book open is worse than one that is briefly
                       unavailable. */
                    disabled={!bookmarking.canBookmark}
                    title={bookmarkLabel}
                    aria-label={bookmarkLabel}
                    aria-pressed={bookmarked}
                    onClick={() => bookmarking.toggle()}
                  >
                    <Bookmark
                      size={ICON.control}
                      strokeWidth={ICON.stroke}
                      /* Filled when it is on. A bookmark outline and a bookmark
                         fill are the same glyph saying two different things,
                         which is what a toggle needs — and `aria-pressed` says
                         it again for anyone not looking at the colour. */
                      fill={bookmarked ? 'currentColor' : 'none'}
                    />
                  </button>
                  <span>{book.position.chapterLabel}</span>
                  {book.position.chapterLabel && <span>·</span>}
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {/* CLAMPED, like the track beside it — by the SAME clamp.
                        A relocation event with a malformed fraction drew "-3%"
                        or "NaN%" under a bar that had already pinned itself to
                        the end; and the two copies had diverged, the track
                        letting `NaN` through where this one caught it. */}
                    {Math.round(progress * 100)}%
                  </span>
                </div>
              </>
            )}
          </>
        ) : (
          <div
            className={styles.empty}
            data-dragging={dragging}
          >
            {/* SAYS WHICH IS TRUE, having asked. This screen used to announce
                "Your library is empty" whenever no book was open — and the app
                boots to the reader, so relaunching Paper told a reader with ten
                books on the shelf that they had none. The library was intact on
                disk the whole time; the reader was simply describing a screen it
                is not. */}
            <h1 className={styles.emptyTitle}>
              {libraryCount > 0
                ? 'No book open'
                : shelfUnread
                  ? 'Your library could not be read'
                  : 'Your library is empty'}
            </h1>
            <p className={styles.emptyBody}>
              {libraryCount > 0
                ? `Pick up where you left off, or drop a new book here.`
                : shelfUnread
                  ? 'Nothing has been changed. Your books are still on disk — try reopening Paper.'
                  : 'Drop an EPUB, PDF, MOBI or CBZ here, or add a folder of them.'}
            </p>
            {book.error && <p className={styles.error}>{book.error}</p>}
            {libraryCount > 0 && (
              <button
                type="button"
                className={styles.primaryButton}
                onClick={onOpenLibrary}
              >
                <Library size={ICON.control} strokeWidth={ICON.stroke} />
                {`Open the library · ${libraryCount} ${libraryCount === 1 ? 'book' : 'books'}`}
              </button>
            )}
            <button
              type="button"
              className={libraryCount > 0 ? styles.secondaryButton : styles.primaryButton}
              onClick={onAddBooks}
            >
              <Plus size={ICON.control} strokeWidth={ICON.stroke} />
              Add books
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
