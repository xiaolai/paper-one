import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import {
  BookA,
  ChevronLeft,
  ChevronRight,
  Copy,
  Highlighter,
  MessageSquareQuote,
  TextQuote,
  Trash2,
} from 'lucide-react'
import { ICON } from '../../core/metrics'
import { place } from '../../core/placement'
import {
  MARK_TINTS,
  READER_STYLES,
  type Mark,
  type MarkAppearance,
  type MarkStyle,
  type MarkTint,
} from '../../core/marks'
import { MarkSpecimen } from './MarkSpecimen'
import {
  frameBoxInHost,
  overlaps,
  rangeRectsInHost,
  watchGeometry,
  type HostRect,
} from './coordinates'
import type { SelectionSnapshot } from './session'
import styles from './SelectionTools.module.css'

/**
 * §10's selection tools — the popup over a live selection.
 *
 * It lives in the HOST document, not the book's, which is the whole reason
 * `coordinates.ts` exists: the selection is inside an iframe, so its rect has
 * to be translated before anything can be positioned against it. Drawing it
 * inside the book instead would put it under the book's own stacking context
 * and inside the scroller, where it would scroll away from the text it belongs
 * to and could not overlap the margin.
 *
 * ONE SURFACE WITH THREE FACES, and that is the load-bearing decision here.
 * The bar shows the last mark you made and the few things you can do; the two
 * chevrons replace its contents in place rather than opening anything. A
 * dropdown would be a SECOND floating surface, and a second floating surface
 * inside this one has to solve four problems that a replaced face does not have
 * at all: it is placed in viewport coordinates while its parent carries a
 * `transform`, so its containing block is the parent and every number is off by
 * the parent's offset; portalled out to escape that, it lands outside the
 * themed shell and outside `useAppPalette`'s inline brightness, and paints
 * Paper-white in the middle of Night; it inherits a shared `min-width` sized
 * for a book's `⋯` menu; and it clears the BUTTON it hangs from while lapping
 * over the bar the button sits in. All four were real, all four were fixed, and
 * all four stopped existing when the menu stopped being a surface.
 *
 * It is also the pattern the design already specifies: the prototype's popup
 * replaces its own contents for Look up and Translate, with a back control. The
 * marks and copy faces are the same mechanism, so the popup has one behaviour
 * rather than three.
 *
 * ICONS AND SPECIMENS, NO WORDS. A toolbar that hangs on a line of prose is
 * read at the same moment as the prose, and labelled buttons are a second
 * sentence arriving over the first. Every control carries `aria-label` as well
 * as `title`: a tooltip is discoverable by pointer only, and a bar of
 * unlabelled glyphs is unusable without one for anybody not using a pointer.
 */

/** Which face of the popup is showing. */
type Face = 'bar' | 'marks' | 'copy'

export interface SelectionToolsProps {
  selection: SelectionSnapshot | null
  /** The positioned ancestor the popup is placed within. */
  stage: HTMLElement | null
  /**
   * The column the words are in, in the stage's own coordinates.
   *
   * NOT THE STAGE, which is the whole prose grid — gutter, measure, margin and
   * the stage's padding. Bounded by that, a bar on a line near the end of its
   * measure was free to hang 144px past the last word and straight across the
   * margin column, which is where margin notes are drawn: select a line that
   * has a note beside it and the toolbar covered the note.
   *
   * Null for a book that genuinely fills the grid — a fixed-layout page has no
   * measure to speak of, and clamping it to one would push the bar inward for
   * no reason. The stage is the honest bound there.
   */
  column: { readonly left: number; readonly width: number } | null
  /**
   * The mark already on this passage, or null.
   *
   * The MARK rather than a boolean, because its tint is what the marks face
   * lights up: a passage marked in green shows green as the chosen disc, so the
   * popup says what this passage already is as well as what it can become.
   */
  marked: Mark | null
  /**
   * The reader's position, as a re-measure trigger — see `MarginMarks`. A page
   * turn with a selection still live moves the text out from under the popup
   * without firing anything the host can observe.
   */
  position: unknown
  /**
   * What a mark takes when the passage does not already have one.
   *
   * The LAST one made, so the bar's own control repeats it. A passage that is
   * already marked shows its own appearance instead — see `shown`.
   */
  appearance: MarkAppearance
  /**
   * Mark the passage like this, and remember it as the appearance to repeat.
   *
   * ONE CALLBACK FOR BOTH AXES. Choosing a colour and choosing a style are the
   * same act — "make the mark look like this" — and splitting them into two
   * handlers meant each one had to guess what the other would have wanted:
   * a colour applied at the pending STYLE rather than at the style of the mark
   * it was recolouring, which silently restyled a mark the reader only meant to
   * recolour.
   *
   * `keep` leaves the selection standing. The palette is a live editor — the
   * mark under it redraws as each choice lands, and a reader comparing a wave
   * against a rule cannot compare anything if the first press takes the popup
   * away. §07's "acting on a selection consumes it" still governs the BAR,
   * where a press is a decision rather than a trial.
   */
  onApply: (appearance: MarkAppearance, keep: boolean) => void
  onNote: () => void
  onCopy: () => void
  /** Copy the passage with its source — see `citation`. */
  onCite: () => void
  /**
   * Look the passage up, or null where there is nothing to look it up in.
   *
   * Null rather than a disabled button: a control that cannot act is the app
   * describing a feature it does not have on this platform, and the reader
   * cannot tell a permanently dead button from a broken one.
   */
  onLookUp: (() => void) | null
  onRemove: () => void
}

/** Popup geometry. Kept here rather than in metrics: §03 defines the reading
 *  grid, and these are this component's own affordances.
 *
 *  The height is published to CSS as `--popup-h` rather than written out in
 *  both places: this module positions the popup ABOVE the selection by
 *  subtracting it, so a stylesheet that disagreed would put the popup its own
 *  height away from the line it belongs to.
 *
 *  40 is `--control-sm` plus 6px of padding on each side — derived from the
 *  controls in the bar rather than chosen and then divided up. Change the
 *  control size and this must change with it, which is why the arithmetic is
 *  written down here next to the number. */
const POPUP_H = 40
const GAP = 8
/** How close the popup may come to the edge of the stage before it is pushed
 *  back in. Enough that it reads as inset rather than as clipped. */
const EDGE = 8

/** What each tint is called, for the tooltip and the screen reader. */
const TINT_NAMES: Record<MarkTint, string> = {
  yellow: 'Yellow',
  green: 'Green',
  purple: 'Purple',
}

/** What each style is called. §15's words: a band, and two kinds of rule. */
const STYLE_NAMES: Record<MarkStyle, string> = {
  fill: 'Highlight',
  underline: 'Underline',
  wave: 'Wave',
}

export function SelectionTools({
  selection,
  stage,
  column,
  marked,
  position,
  appearance,
  onApply,
  onNote,
  onCopy,
  onCite,
  onLookUp,
  onRemove,
}: SelectionToolsProps) {
  const [box, setBox] = useState<HostRect | null>(null)
  /* The visible EXTENT of the selection — every on-page line, unioned — so
   * the popup can be told to stay clear of all of it, not just the line it
   * hangs from. Anchored to the first line alone, a toolbar over a three-line
   * selection sat on top of lines two and three: the very words the reader
   * had just chosen. */
  const [extent, setExtent] = useState<HostRect | null>(null)
  /** The popup's own width, for the edge clamp below. */
  const popupRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [face, setFace] = useState<Face>('bar')

  /**
   * The left edge the bar was placed at, held while another face is showing.
   *
   * THE POPUP IS CENTRED ON THE SELECTION, so its left edge is a function of
   * its width — and every face is a different width. Re-centring on each switch
   * slides the whole popup sideways, which moves the chevron out from under the
   * pointer that just pressed it, so the reader's next click lands on whatever
   * took its place. Holding the edge makes the popup grow and shrink from one
   * side, which is what "slides open" ought to mean.
   *
   * Written during render, deliberately: it is derived from the same inputs as
   * the placement itself, so re-rendering the same state writes the same
   * number. It is a cache of the last placement, not state — nothing reads it
   * to decide whether to render.
   */
  const barLeft = useRef<number | null>(null)

  /* Measured in an effect rather than during render: the rect depends on laid
   * out DOM in another document, and reading it while rendering would both tear
   * and force a synchronous layout on every keystroke elsewhere in the app. */
  const measure = useCallback(() => {
    if (!selection || !stage) {
      setBox(null)
      setExtent(null)
      return
    }
    const doc = selection.range.startContainer.ownerDocument
    const page = doc ? frameBoxInHost(doc, stage) : null
    /* The first VISIBLE line rect, not the range's bounding box.
     *
     * A bounding box over a selection that crosses a column break spans both
     * columns, and its centre — which is what the popup is placed on — lands in
     * the gutter between them, or on a page that is not being shown. One line's
     * rect is always somewhere real. The same clip keeps a selection that has
     * scrolled off the page from putting the popup over whatever text now
     * occupies that spot, offering to mark a passage nowhere on screen. */
    const visible = rangeRectsInHost(selection.range, stage).filter(
      (candidate) =>
        (candidate.width > 0 || candidate.height > 0) &&
        (!page || overlaps(candidate, page)),
    )
    setBox(visible[0] ?? null)
    /* Union of the visible lines. Still clipped to the page, for the same
     * reason as the anchor: a line on a page that is not being shown must not
     * push the popup around. */
    if (visible.length === 0) {
      setExtent(null)
    } else {
      /* One pass, no spread. `Math.min(...rects)` puts every rect on the call
       * stack as an argument, and a selection dragged across a whole chapter
       * has enough line rects to throw `RangeError: Maximum call stack size`
       * — on the one gesture that produces the most of them. */
      let top = Infinity, left = Infinity, bottom = -Infinity, right = -Infinity
      for (const r of visible) {
        if (r.top < top) top = r.top
        if (r.left < left) left = r.left
        if (r.top + r.height > bottom) bottom = r.top + r.height
        if (r.left + r.width > right) right = r.left + r.width
      }
      setExtent({ top, left, width: right - left, height: bottom - top, bottom, right })
    }
  }, [selection, stage])

  useEffect(() => {
    measure()
  }, [measure, position])

  /* A selection outlives the gesture that made it, so the popup has to follow
   * the text through every later reflow: the pane opening, a font-size step, a
   * window resize. Measuring once at selection time pins it where the text used
   * to be. */
  useEffect(() => {
    const doc = selection?.range.startContainer.ownerDocument
    if (!stage || !doc) return
    return watchGeometry(stage, doc, measure)
  }, [selection, stage, measure])

  /* Measured before paint, because the value feeds back into the position. An
   * ordinary effect would let the reader see the popup appear off-centre and
   * then jump. Its width does not depend on where it is put, so this settles in
   * one pass. */
  useLayoutEffect(() => {
    const measured = popupRef.current?.getBoundingClientRect().width ?? 0
    if (Math.abs(measured - width) > 0.5) setWidth(measured)
  })

  /* A NEW SELECTION GETS THE BAR. A face is about the passage in hand, so
   * carrying one across would open the popup mid-task on a passage the reader
   * has not chosen anything for yet — with the marks face lighting up the
   * PREVIOUS passage's tint. */
  useEffect(() => {
    setFace('bar')
    barLeft.current = null
  }, [selection])

  if (!selection || !box) return null

  /* WHERE IT GOES IS `place`'S DECISION, and the reasoning that used to live
   * here as thirty lines of arithmetic lives there now, once, for every
   * popover in the app: above the selection by preference and below when there
   * is no room, centred on the line and slid back inside the stage when a
   * selection at the very edge would push half the controls off it, and — when
   * the stage is narrower than the popup — the leading edge pinned so the first
   * controls stay reachable rather than centring it and losing both ends.
   *
   * The stage is the BOUNDS, not the viewport: this popup is positioned inside
   * the stage, in the stage's own coordinates, which is exactly what `bounds`
   * is for. `place` returns a left EDGE; the stylesheet centres the popup with
   * `translateX(-50%)` for its enter animation, so the edge is turned back
   * into a centre at this one seam. */
  const stageBox = stage?.getBoundingClientRect()
  /* Before the stage has a box there is nothing to clamp against, and a very
     large bound is the honest "no constraint" rather than a guess. */
  const within = column ?? { left: 0, width: stageBox?.width ?? 1e6 }
  const placed = place({
    /* `container` space: these rects are stage-relative, from
       `rangeRectsInHost`, and the bounds are the stage's own box at origin.
       The brand is what stops a viewport rect wandering in here — it would be
       numerically valid and wrong by the stage's offset, and nothing else
       could tell. */
    anchor: { top: box.top, left: box.left, width: box.width, height: box.height, space: 'container' },
    surface: { width, height: POPUP_H },
    bounds: {
      top: 0,
      left: within.left,
      width: within.width,
      height: stageBox?.height ?? 1e6,
      space: 'container',
    },
    // Clear of EVERY selected line, not just the one it hangs from.
    ...(extent ? { avoid: { ...extent, space: 'container' as const } } : {}),
    side: 'top',
    align: 'center',
    gap: GAP,
    edge: EDGE,
  })

  /* `place` REPORTS how well it did, and this is the one caller that has to
   * act on it. `detached` means the anchor is wholly outside the stage — the
   * selection has scrolled off, or sits on a page that is not being shown — and
   * placement's own contract says to hide the surface then: what would be drawn
   * is a toolbar hanging from nothing, offering to mark a passage the reader
   * cannot see, at whatever spot inside the stage happened to be closest. The
   * rect filter above catches most of that; this catches the rest, and it is
   * the difference between relying on a filter and asking the routine that
   * knows. */
  if (placed.fit === 'detached') return null

  if (face === 'bar') barLeft.current = placed.left
  /* The held edge, still CLAMPED: a face wider than the bar must not run off
     the stage merely because it inherited a position that suited a narrow one. */
  const held = barLeft.current
  const leftEdge =
    face === 'bar' || held === null
      ? placed.left
      : Math.max(
          within.left + EDGE,
          Math.min(held, within.left + within.width - EDGE - width),
        )

  const top = placed.top
  const left = width > 0 ? leftEdge + width / 2 : box.left + box.width / 2

  /**
   * WHAT THE POPUP IS ACTING ON.
   *
   * A passage that is already marked shows ITS OWN appearance, not the last one
   * made — so every control in here edits the mark in front of the reader
   * rather than replacing it with the previous passage's scheme. On an unmarked
   * passage there is nothing to show but the last one, which is what pressing
   * the bar's control will lay down.
   */
  const shown: MarkAppearance =
    /* ONLY THE READER'S OWN MARK is worth adopting. A companion's carries the
     * reserved wave, and every control here writes what it shows: pressing the
     * bar over one would have laid down a reader-owned wave and dispatched
     * `setMarkStyle('wave')` into the app's own appearance, so the reservation
     * would have leaked through the one surface that is meant to enforce it. */
    marked && marked.kind === 'highlight'
      ? { tint: marked.tint, style: marked.style }
      : appearance

  const back = (
    <button
      type="button"
      className={styles.tool}
      onClick={() => setFace('bar')}
      title="Back"
      aria-label="Back to the selection tools"
    >
      <ChevronLeft size={ICON.control} strokeWidth={ICON.stroke} />
    </button>
  )

  return (
    <div
      ref={popupRef}
      className={styles.popup}
      style={{ top, left, '--popup-h': `${POPUP_H}px` } as CSSProperties}
      /* The selection lives in the book document, and clicking the host clears
       * it in some engines before the click handler runs. Suppressing the
       * default on pointerdown is what keeps the range alive long enough to
       * act on. */
      onPointerDown={(event) => event.preventDefault()}
      role="toolbar"
      aria-label="Selection tools"
    >
      {/* KEYED ON THE FACE so the slide replays on every switch. One element
          per face rather than one that mutates: a shared node would animate
          from its own previous contents, which reads as a cross-fade of two
          states rather than as one arriving. */}
      <div key={face} className={styles.face}>
        {face === 'bar' && (
          <>
            {/* ONE CONTROL RATHER THAN A PALETTE: a reader picks a scheme and
                stays in it, so the bar shows the answer and keeps the question
                one chevron away.
                A GLYPH, like every other control on this row — a specimen here
                was a drawing among icons, and the bar is where the popup has to
                read as one row of tools. It carries the tint it will lay down
                as its colour, so the bar still says what pressing it does.
                Inline, because the value is one of three custom properties
                chosen at runtime; the hover fill behind it still changes. */}
            <button
              type="button"
              className={styles.tool}
              onClick={() => onApply(shown, false)}
              style={{ color: `var(--mark-${shown.tint}-rule)` }}
              title={`${STYLE_NAMES[shown.style]} · ${TINT_NAMES[shown.tint]}`}
              aria-label={`Mark this passage — ${STYLE_NAMES[shown.style].toLowerCase()}, ${TINT_NAMES[shown.tint].toLowerCase()}`}
            >
              <Highlighter size={ICON.control} strokeWidth={ICON.stroke} />
            </button>
            <button
              type="button"
              className={styles.chevron}
              onClick={() => setFace('marks')}
              title="Mark styles"
              aria-label="Choose a colour and a style"
            >
              <ChevronRight size={ICON.inline} strokeWidth={ICON.stroke} />
            </button>

            <span className={styles.divider} aria-hidden="true" />

            <button
              type="button"
              className={styles.tool}
              onClick={onNote}
              title="Note"
              aria-label="Write a note on this passage"
            >
              <MessageSquareQuote size={ICON.control} strokeWidth={ICON.stroke} />
            </button>

            {/* Copy stays one click; the other way to copy is one chevron
                away, exactly as another mark style is. */}
            <button
              type="button"
              className={styles.tool}
              onClick={onCopy}
              title="Copy"
              aria-label="Copy this passage"
            >
              <Copy size={ICON.control} strokeWidth={ICON.stroke} />
            </button>
            <button
              type="button"
              className={styles.chevron}
              onClick={() => setFace('copy')}
              title="Copy options"
              aria-label="More ways to copy this passage"
            >
              <ChevronRight size={ICON.inline} strokeWidth={ICON.stroke} />
            </button>

            {onLookUp && (
              <button
                type="button"
                className={styles.tool}
                onClick={onLookUp}
                title="Look up"
                aria-label="Look this up in the dictionary"
              >
                <BookA size={ICON.control} strokeWidth={ICON.stroke} />
              </button>
            )}

            {marked && (
              <button
                type="button"
                className={styles.tool}
                onClick={onRemove}
                title="Remove"
                aria-label="Remove this mark"
              >
                <Trash2 size={ICON.control} strokeWidth={ICON.stroke} />
              </button>
            )}
          </>
        )}

        {face === 'marks' && (
          <>
            {back}
            <span className={styles.divider} aria-hidden="true" />

            {/* SHAPE BEFORE COLOUR, because that is the order the thing is
                named in: a mark is a highlight, a rule or a wave, and it is
                yellow, green or purple. Reading the row left to right assembles
                the same phrase the reader would say out loud. */}
            {READER_STYLES.map((style) => (
              <button
                key={style}
                type="button"
                className={styles.tool}
                /* APPLIED AT ONCE, keeping the selection. The mark under the
                   popup redraws as the press lands, which is the only way to
                   choose between a rule and a wave — deciding by imagining them
                   is what a palette exists to save the reader from. */
                onClick={() => onApply({ tint: shown.tint, style }, true)}
                title={STYLE_NAMES[style]}
                aria-label={`${STYLE_NAMES[style]} marks`}
                aria-pressed={shown.style === style}
                data-lit={shown.style === style}
              >
                <MarkSpecimen tint={shown.tint} style={style} />
              </button>
            ))}

            <span className={styles.divider} aria-hidden="true" />

            {MARK_TINTS.map((tint) => {
              const name = TINT_NAMES[tint]
              const lit = shown.tint === tint
              return (
                <button
                  key={tint}
                  type="button"
                  className={styles.tool}
                  onClick={() => onApply({ tint, style: shown.style }, true)}
                  title={name}
                  aria-label={`Mark this passage in ${name.toLowerCase()}`}
                  aria-pressed={lit}
                >
                  <span
                    className={styles.disc}
                    data-lit={lit}
                    /* THE SATURATED VALUE, not the pale fill. A disc carries no
                       border — a ring in the ink was the loudest thing in the
                       popup and read as a fourth colour — so the disc itself
                       has to hold enough colour to be seen. The pale fill is
                       1.24:1 against Paper; its rule is 1.8:1 and reads as a
                       colour rather than as a smudge. */
                    style={{ '--disc': `var(--mark-${tint}-rule)` } as CSSProperties}
                  />
                </button>
              )
            })}
          </>
        )}

        {face === 'copy' && (
          <>
            {back}
            <span className={styles.divider} aria-hidden="true" />
            <button
              type="button"
              className={styles.tool}
              onClick={onCopy}
              title="Copy"
              aria-label="Copy the passage on its own"
            >
              <Copy size={ICON.control} strokeWidth={ICON.stroke} />
            </button>
            <button
              type="button"
              className={styles.tool}
              onClick={onCite}
              title="Copy with citation"
              aria-label="Copy the passage with its book, author and place"
            >
              <TextQuote size={ICON.control} strokeWidth={ICON.stroke} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
