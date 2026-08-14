import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from 'react'
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
import { useAvailableWidth } from '../lib/useAvailableWidth'
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
  inert = false,
}: ReaderProps) {
  const [dragging, setDragging] = useState(false)
  /* The stage element as STATE, not just a ref: the popup and the margin marks
   * both position against it, and a ref's `.current` landing after the first
   * render does not re-render them. They would measure against null once and
   * never again. */
  const [stage, setStage] = useState<HTMLDivElement | null>(null)

  const { selection, setSelection, ranges, onMarkDrawn, selected, mark, unmark } = marking
  /* dragenter/dragleave fire for every child crossed, so a plain boolean
   * flickers the highlight while the pointer is still inside the zone. Depth
   * counting is what makes leave mean "left the zone". */
  const dragDepth = useRef(0)

  const windowWidth = useAvailableWidth()
  /* Must use the SAME predicate as WindowShell. Reserving PANE_TRACK whenever
   * `state.pane` is set meant that below the §06 collapse threshold — where
   * the pane is hidden — the reader still gave away 412px to nothing. */
  const paneVisible = state.pane !== null && windowWidth >= PANE_COLLAPSE_W
  const available = windowWidth - (paneVisible ? PANE_TRACK : 0)

  /* What actually goes in the margin: notes and companion marks, not every
   * highlight. Counting highlights too would open a 250px column to show a
   * column of dots that repeat what the gold fill on the words already says. */
  const inMargin = useMemo(() => marginMarks(marks.current), [marks.current])

  // The stage is what is left after the pane, less its own padding. The margin
  // column is only reserved once the book has marks to put in it.
  const grid = proseGrid(
    available - STAGE_PADDING_X * 2,
    inMargin.length > 0,
    measureForStep(state.stepIdx),
  )
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


  const { open, deselect } = book
  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const dropped = event.dataTransfer.files.item(0)
      if (dropped) open(dropped)
    },
    [open],
  )

  return (
    <div className={styles.reader} inert={inert}>
      <div className={styles.column} data-platform={platform}>
        {book.source ? (
          <>
            {/* A book that will not open has to say so. Rendering the stage
                anyway leaves an empty column, which reads as "this book has no
                text" rather than "this book failed to load". */}
            {book.error && (
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
            )}

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
                  onMarkActivated={(cfi) => {
                    const hit = marks.current.find((m) => m.cfi === cfi)
                    if (hit) dispatch({ type: 'openPane', pane: 'notes' })
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
                    onSelect={() => dispatch({ type: 'openPane', pane: 'notes' })}
                  />
                </div>
              )}

              <SelectionTools
                selection={selection}
                stage={stage}
                marked={selected !== null}
                onHighlight={() => mark(selected?.note ?? '')}
                onNote={() => {
                  // The note itself is written in the Notes panel, where there
                  // is room for it. Marking first is what gives it an anchor.
                  mark(selected?.note ?? '')
                  dispatch({ type: 'openPane', pane: 'notes' })
                }}
                onCopy={() => {
                  if (selection) void navigator.clipboard?.writeText(selection.text)
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
        ) : (
          <div
            className={styles.empty}
            data-dragging={dragging}
            onDragEnter={() => {
              dragDepth.current += 1
              setDragging(true)
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => {
              dragDepth.current = Math.max(0, dragDepth.current - 1)
              if (dragDepth.current === 0) setDragging(false)
            }}
            onDrop={onDrop}
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
