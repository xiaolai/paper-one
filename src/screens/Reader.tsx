import { useCallback, useMemo, useState, type CSSProperties } from 'react'
import { Library, Plus } from 'lucide-react'
import type { Platform } from '../lib/metrics'
import {
  ICON,
  PANE_TRACK,
  STAGE_PADDING_X,
  measureForStep,
  paneTakesTrack,
  proseBleed,
  proseGrid,
} from '../lib/metrics'
import { bookAccent } from '../lib/bookAccent'
import { marginMarks } from '../lib/marks'
import type { MarkStore } from '../lib/useMarks'
import type { Marking } from '../lib/useMarking'
import { hasOpenLayer } from '../lib/state'
import type { AppDispatch, AppState } from '../lib/state'
import type { Book } from '../lib/useBook'
import { useAvailableWidth, useElementWidth } from '../lib/useAvailableWidth'
import { FoliateView } from '../reader/FoliateView'
import type { PageIntent } from '../reader/wheelPaging'
import { MarginMarks } from '../reader/MarginMarks'
import { ReadingRuler } from '../reader/ReadingRuler'
import { SelectionTools } from '../reader/SelectionTools'
import styles from './Reader.module.css'


export interface ReaderProps {
  state: AppState
  dispatch: AppDispatch
  platform: Platform
  book: Book
  marks: MarkStore
  marking: Marking
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
  marks,
  marking,
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

  const { selection, setSelection, ranges, onMarkDrawn, selected, mark, unmark } = marking

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
    [state, book, selection, paneVisible, setSelection],
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
      dispatch({ type: 'openPane', pane: 'notes' })
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
                    <div className={styles.progressTrack} aria-hidden="true">
                      <div
                        className={styles.progressFill}
                        style={{
                          height: `${Math.min(1, Math.max(0, book.position.fraction)) * 100}%`,
                          background: accent,
                        }}
                      />
                    </div>
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
                      theme={state.theme}
                      typeface={state.typeface}
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
                      onFileDropped={book.open}
                      onPageIntent={onPageIntent}
                      onFixedLayout={book.setFixedLayout}
                      onMarkActivated={(cfi) => {
                        /* The mark is already in hand, so Notes is told WHICH
                           one. Opening the panel is not showing the mark: the
                           list holds every mark in every book, and landing at
                           the top of it leaves the reader to find the one they
                           just clicked. */
                        const hit = marks.current.find((m) => m.cfi === cfi)
                        if (!hit) return
                        showInNotes(hit.id)
                      }}
                    />
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

                  <SelectionTools
                    selection={selection}
                    stage={stage}
                    marked={selected !== null}
                    position={book.position}
                    onHighlight={() => mark(selected?.note ?? '')}
                    onNote={() => {
                      /* The note itself is written in the Notes panel, where
                         there is room for it. Marking first is what gives it an
                         anchor — and the editor for THAT mark opens with the
                         panel, rather than leaving the reader to find the row
                         and click "Add a note" a second time. */
                      const created = mark(selected?.note ?? '')
                      const target = created ?? selected
                      showInNotes(target?.id ?? null, true)
                    }}
                    onCopy={() => {
                      /* Reported when it fails. Clipboard access can be absent
                         or refused, and the popup dismissed itself either way —
                         so a copy that did not happen looked exactly like one
                         that did, until the reader pasted nothing. */
                      const text = selection?.text
                      const clipboard = navigator.clipboard
                      if (text && clipboard) {
                        void clipboard.writeText(text).catch((cause: unknown) => {
                          console.error('Paper: could not copy the selection', cause)
                          setNotice('That could not be copied to the clipboard.')
                        })
                      } else if (text) {
                        setNotice('This device has no clipboard available.')
                      }
                      clearSelection()
                    }}
                    onRemove={() => {
                      if (selected) unmark(selected)
                      clearSelection()
                    }}
                  />
                </div>

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
                  style={{ opacity: state.chromeOn || state.pane ? 1 : 0 }}
                >
                  <span>{book.position.chapterLabel}</span>
                  {book.position.chapterLabel && <span>·</span>}
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {/* CLAMPED, like the track beside it. A relocation event
                        with a malformed fraction drew "-3%" or "NaN%" under a
                        bar that had already pinned itself to the end. */}
                    {Math.round(Math.min(1, Math.max(0, book.position.fraction || 0)) * 100)}%
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
