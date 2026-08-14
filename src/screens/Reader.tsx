import { useMemo, useState, type CSSProperties } from 'react'
import { Plus } from 'lucide-react'
import type { Platform } from '../lib/metrics'
import {
  ICON,
  PANE_COLLAPSE_W,
  PANE_TRACK,
  STAGE_PADDING_X,
  measureForStep,
  proseBleed,
  proseGrid,
} from '../lib/metrics'
import { marginMarks } from '../lib/marks'
import type { MarkStore } from '../lib/useMarks'
import type { Marking } from '../lib/useMarking'
import type { AppDispatch, AppState } from '../lib/state'
import type { Book } from '../lib/useBook'
import { useAvailableWidth, useElementWidth } from '../lib/useAvailableWidth'
import { FoliateView } from '../reader/FoliateView'
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
  /** Opens the file picker, which the window owns — see App. */
  onAddBooks: () => void
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
  onAddBooks,
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
  const paneVisible = state.pane !== null && windowWidth >= PANE_COLLAPSE_W
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

  const gridVars = {
    '--stage-pad-x': `${STAGE_PADDING_X}px`,
    '--text-bleed-start': `${bleed.start}px`,
    '--text-bleed-end': `${bleed.end}px`,
    '--track-gutter': `${grid.gutter}px`,
    '--track-measure': `${grid.measure}px`,
    '--track-margin': `${grid.marginCol}px`,
    '--track-gap': `${grid.gap}px`,
  } as CSSProperties


  const { deselect } = book

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
                  <div className={styles.gutter}>
                    <ReadingRuler
                      state={state}
                      dispatch={dispatch}
                      doc={book.doc}
                      stage={stage}
                    />
                  </div>

                  <div className={styles.text}>
                    <FoliateView
                      file={book.source}
                      generation={book.generation}
                      stepIdx={state.stepIdx}
                      theme={state.theme}
                      paginated={state.pageLayout === 'paginated'}
                      onToc={book.setToc}
                      onRelocate={book.setPosition}
                      onDocument={book.setDoc}
                      onMeta={book.setMeta}
                      onError={book.fail}
                      onNavigator={book.setNavigator}
                      marks={marks.current}
                      onSelection={setSelection}
                      onMarkDrawn={onMarkDrawn}
                      onFileDropped={book.open}
                      onMarkActivated={(cfi) => {
                        /* The mark is already in hand, so Notes is told WHICH
                           one. Opening the panel is not showing the mark: the
                           list holds every mark in every book, and landing at
                           the top of it leaves the reader to find the one they
                           just clicked. */
                        const hit = marks.current.find((m) => m.cfi === cfi)
                        if (!hit) return
                        marking.focusMark(hit.id)
                        dispatch({ type: 'openPane', pane: 'notes' })
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
                        onSelect={(picked) => {
                          marking.focusMark(picked.id)
                          dispatch({ type: 'openPane', pane: 'notes' })
                        }}
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
                      if (target) marking.focusMark(target.id, true)
                      dispatch({ type: 'openPane', pane: 'notes' })
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
                      deselect()
                      setSelection(null)
                    }}
                    onRemove={() => {
                      if (selected) unmark(selected)
                      deselect()
                      setSelection(null)
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
                    {Math.round(book.position.fraction * 100)}%
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
            <h1 className={styles.emptyTitle}>Your library is empty</h1>
            <p className={styles.emptyBody}>
              Drop an EPUB, PDF, MOBI or CBZ here, or connect a folder to watch.
            </p>
            {book.error && <p className={styles.error}>{book.error}</p>}
            <button
              type="button"
              className={styles.primaryButton}
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
