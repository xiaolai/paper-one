import {
  useCallback,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Highlighter,
  MessageSquareQuote,
  TextQuote,
  Trash2,
} from 'lucide-react'
import { CONTROL, ICON } from '../../core/metrics'
import { SURFACE_EDGE, UNBOUNDED, place } from '../../core/placement'
import {
  MARK_TINTS,
  READER_STYLES,
  type Annotation,
  type MarkAppearance,
  type MarkStyle,
  type MarkTint,
} from '../../core/marks'
import { MarkSpecimen } from './MarkSpecimen'
import type { HostRect } from './coordinates'
import { useSelectionGeometry } from './selectionGeometry'
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

/** Which face of the popup the READER turned to. */
type Face = 'bar' | 'marks' | 'copy'

/**
 * Whether two snapshots are the same passage — what the face reset asks, see
 * `SelectionTools`.
 *
 * The document, the section, the CFI and the text. A keyup republishes all four
 * unchanged; a shift+arrow that extends the selection changes the CFI and the
 * text; a new section or a new book changes the document. The text is compared
 * as well as the CFI because `view.getCFI` answers `''` for a range it cannot
 * address, and two such passages would otherwise be one.
 *
 * TWO PASSAGES, NEVER AN ABSENT ONE (2026-09-14). It took nulls and answered
 * `a === b` for them, and the one call that could compare two — the mount, with
 * no selection — resets a popup that has nothing to reset, so the answer could
 * not matter. The reset asks about absence itself, where it can be seen.
 */
function samePassage(a: SelectionSnapshot, b: SelectionSnapshot): boolean {
  return (
    a.range.startContainer.ownerDocument === b.range.startContainer.ownerDocument &&
    a.sectionIndex === b.sectionIndex &&
    a.cfi === b.cfi &&
    a.text === b.text
  )
}

/**
 * The union of the visible lines — what the popup stays clear of, see `lines`.
 *
 * One pass, no spread. `Math.min(...rects)` puts every rect on the call stack
 * as an argument, and a selection dragged across a whole chapter has enough line
 * rects to throw `RangeError: Maximum call stack size` — on the one gesture that
 * produces the most of them.
 */
function extentOf(lines: readonly HostRect[]): HostRect {
  let top = Infinity, left = Infinity, bottom = -Infinity, right = -Infinity
  for (const r of lines) {
    top = Math.min(top, r.top)
    left = Math.min(left, r.left)
    bottom = Math.max(bottom, r.top + r.height)
    right = Math.max(right, r.left + r.width)
  }
  return { top, left, width: right - left, height: bottom - top, bottom, right }
}

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
   *
   * ⚠️ **`Annotation`, AND IT WAS THE WIDER `Mark`** (2026-09-19 audit). `Mark`
   * admits a BOOKMARK, which this popup must never be handed — a bookmark is a
   * place, has no tint or style, and nothing here could draw one. No caller ever
   * passed one (`useMarking.selected` is `Placed<Annotation> | null`), so the
   * width bought nothing and cost a guard: `shown` tested `kind === 'highlight'`
   * to exclude the deleted companion's, and once that kind was gone the test was
   * a tautology over a type no caller could produce. The narrower prop makes the
   * guard unnecessary rather than merely unused.
   */
  marked: Annotation | null
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
  /**
   * Whether this passage can be marked — `Marking.canMark`, handed down.
   *
   * False hides Mark, its chevron and Note: a passage with no anchor cannot
   * hold a mark, and both buttons did nothing when pressed (#202). ASKED, NOT
   * WORKED OUT HERE: `cfi === ''` in this file would be a second copy of the
   * rule `useMarking` owns.
   */
  canMark: boolean
  onNote: () => void
  onCopy: () => void
  /** Copy the passage with its source — see `citation`. */
  onCite: () => void
  onRemove: () => void
}

/**
 * The air between the row's controls and the popup's own edge, per side.
 *
 * `--space-6`, and it is written out here because the space scale lives ONLY in
 * `tokens.css` — `applyMetrics` publishes no `--space-*`, and `metrics.ts` has
 * no scale for it — so there is nothing in TypeScript to derive it from. The
 * popup's height has to be computed in TypeScript (see `POPUP_H`), so this is
 * the one end of the arithmetic that cannot come from a shared name. If a space
 * scale ever reaches `metrics.ts`, this is its first caller.
 */
const POPUP_PAD = 6

/** Popup geometry. Kept here rather than in metrics: §03 defines the reading
 *  grid, and these are this component's own affordances.
 *
 *  The height is published to CSS as `--popup-h` rather than written out in
 *  both places: this module positions the popup ABOVE the selection by
 *  subtracting it, so a stylesheet that disagreed would put the popup its own
 *  height away from the line it belongs to.
 *
 *  DERIVED, NOT SUMMED BY HAND. It is `CONTROL.sm` plus `POPUP_PAD` on each
 *  side — and until now the arithmetic was in this comment while the answer,
 *  40, sat in the code, which is a derivation nothing performs: moving the
 *  control ramp would have left the popup the height of a ramp that no longer
 *  exists, with a comment still claiming it followed one.
 *
 *  THE ROW'S HEIGHT, AND EVERY FACE IS ONE ROW, so it is also the popup's —
 *  which is what `place` is handed. It was not always: a fourth face, the
 *  lookup, was as tall as the answer a language model returned, and a
 *  `surfaceHeight` here chose between the two. That face is gone with the rest
 *  of the AI features, so the choice is gone with it. */
export const POPUP_H = CONTROL.sm + 2 * POPUP_PAD

/**
 * How far the popup stays off the WORDS it hangs from.
 *
 * ITS OWN VALUE, and the two things it is NOT are worth stating, because it
 * agrees with one of them and looks derivable from the other.
 *
 * NOT `SURFACE_GAP`. That is the clearance a menu takes from a BUTTON — a
 * control with an edge of its own and nothing on it to read. This popup hangs
 * over a line of prose the reader has just chosen, and a surface's shadow
 * falling across the ascenders of the line above the selection is the one thing
 * a toolbar over text may not do. It wants more air than a control's, and
 * writing it as `2 * SURFACE_GAP` would claim the two must move together, which
 * is a coupling nobody decided: "twice" is what this happens to be, not why.
 *
 * NOT `SURFACE_EDGE`, though they agree at 8 today. That one is the distance
 * from the edge of the STAGE; this is the distance from the TEXT. Two questions
 * whose answers happen to match, kept apart for the reason `TRACK_W` and
 * `KIND_RULE_W` are kept apart in `metrics.ts`.
 */
const GAP = 8

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
  canMark,
  onNote,
  onCopy,
  onCite,
  onRemove,
}: SelectionToolsProps) {
  /* WHERE THE SELECTION IS AND HOW BIG THE STAGE IS, as ONE snapshot — see
   * `selectionGeometry.ts`, which says why the two cannot be measured apart.
   * Anchored to the first line alone, a toolbar over a three-line selection sat
   * on top of lines two and three: the very words the reader had just chosen,
   * which is why every line is here and not just the anchor. */
  const { lines, stageBox } = useSelectionGeometry(selection, stage, position)
  /** The popup's own width, for the edge clamp below. */
  const popupRef = useRef<HTMLDivElement | null>(null)
  /* RE-MEASURED WHEN IT RESIZES ON ITS OWN, not only when React renders it
     (2026-09-13). The layout effect below measures after every render, and a
     popup can change size with no render at all — a face whose font arrives
     late re-wraps — which left it placed at its old size until something
     unrelated re-rendered it. The popup is CENTRED on the selection, so its
     width decides its left edge and a width that moves under it leaves it
     off-centre. A callback ref, because the node comes and goes with the
     selection and the observer has to go with it.
     ⚠️ **THE CASE THIS WAS WRITTEN FOR WAS THE DELETED LOOKUP FACE**, whose
     answer grew by a line and hung down over the word it defined — a HEIGHT.
     Every face left is one row, so what a re-measure can still change is the
     width, and `SelectionTools.test.tsx` measures it that way.
     ⚠️ NEVER HANDED NULL, so the node is typed without it (2026-09-14). A ref
     callback that returns its cleanup is given the cleanup on detach and not a
     null — React 19's contract — and the `if (node === null) return` that stood
     here was a branch no render could take. */
  // Stryker disable next-line ArithmeticOperator: the count is never read — any new state re-renders, and n - 1 is as new as n + 1
  const [, remeasure] = useReducer((n: number) => n + 1, 0)
  const popupNode = useCallback(
    (node: HTMLDivElement) => {
      popupRef.current = node
      const observer = new ResizeObserver(() => remeasure())
      observer.observe(node)
      return () => {
        observer.disconnect()
        popupRef.current = null
      }
    },
    // Stryker disable next-line ArrayDeclaration: a constant dependency never changes, so the callback is exactly as stable as with none
    [],
  )
  const [width, setWidth] = useState(0)
  // Stryker disable next-line StringLiteral: the passage reset below sets the bar in the commit a selection first arrives in, and no face is drawn before one has
  const [current, setFace] = useState<Face>('bar')

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
   * ⚠️ WRITTEN ONLY FOR A RENDER THAT COMMITTED — and until 2026-09-13 it was
   * written during render, "deliberately: … re-rendering the same state writes
   * the same number". True, and beside the point: a render React throws away —
   * a transition that suspends, one that is interrupted — renders DIFFERENT
   * state, and its write stayed behind. The next face then hung from the edge
   * of a bar the reader never saw. `barPlacedAt` carries this render's edge to a
   * layout effect, and a layout effect runs only for a render that is on screen.
   */
  const barLeft = useRef<number | null>(null)

  /**
   * The face the reader turned the popup away from with focus INSIDE it, or
   * null — so the layout effect below can put focus in the face that arrived.
   *
   * ⚠️ TURNING A FACE DROPPED KEYBOARD FOCUS until 2026-09-13. Each face is its
   * own keyed element, so the control that was pressed is unmounted by its own
   * press and focus falls to `<body>`: a keyboard reader who opened the marks
   * face from its chevron was sent back to the top of the window, and coming
   * back lost the chevron too. Focus now goes to the new face's first control —
   * its Back — and, returning to the bar, to the control that opened the face
   * being left (`data-opens`).
   *
   * Only when focus WAS inside. A pointer never puts it there — the popup
   * cancels pointerdown to keep the book's selection alive — so a pointer
   * reader's focus is left exactly where it was.
   */
  const turning = useRef<Face | null>(null)

  /* A NEW PASSAGE GETS THE BAR. A face is about the passage in hand, so
   * carrying one across would open the popup mid-task on a passage the reader
   * has not chosen anything for yet — with the marks face lighting up the
   * PREVIOUS passage's tint.
   *
   * ⚠️ A PASSAGE, NOT A SNAPSHOT — and until 2026-09-13 it was the snapshot.
   * The session publishes a fresh one for the SAME passage on every keyup in
   * the book (`#watchSelection`'s `publishLive`), so a reader in the marks face
   * who pressed any key was put back on the bar. `useLookUp` met the same
   * republishing and keys its anchor on the CFI for the same reason; see
   * `samePassage`.
   *
   * A LAYOUT effect, so the old face is never painted over a new passage, and
   * declared before the one that keeps the bar's edge, so a new passage's first
   * bar is the edge that stays. */
  const passage = useRef<SelectionSnapshot | null>(null)
  useLayoutEffect(() => {
    const was = passage.current
    passage.current = selection
    /* A selection that went away and came back is a new passage, even the same
       one: the popup was gone, and what it had turned to went with it. */
    if (was !== null && selection !== null && samePassage(was, selection)) return
    setFace('bar')
    barLeft.current = null
    turning.current = null
  }, [selection])

  /* THIS RENDER'S BAR EDGE, or null for a render that draws another face or
     nothing. Assigned below, once `place` has run; the effect closes over the
     binding and runs after the render has finished assigning it — and only if
     the render committed, which is the point. See `barLeft`. */
  let barPlacedAt: number | null = null
  useLayoutEffect(() => {
    if (barPlacedAt !== null) barLeft.current = barPlacedAt
  })

  /* Focus into the face that arrived — see `turning`. */
  useLayoutEffect(() => {
    const from = turning.current
    if (from === null || from === current) return
    turning.current = null
    const popup = popupRef.current
    if (popup === null) return
    /* NOT OVER A READER WHO HAS MOVED ON. Focus somewhere real outside the
       popup went there on purpose. Unmounted with the face it was on, it is
       nowhere — which is the case this exists for. */
    const active = document.activeElement
    if (active !== null && active !== document.body && active.isConnected && !popup.contains(active)) return
    /* ONLY THE BAR CARRIES `data-opens`, so in any other face the first query
       finds nothing and focus goes to the face's first control, its Back. */
    const into =
      popup.querySelector<HTMLElement>(`[data-opens="${from}"]`) ??
      popup.querySelector<HTMLElement>('button')
    // Stryker disable next-line OptionalChaining: every face draws a button — its Back, or on the bar Copy — so there is always one to find
    into?.focus({ preventScroll: true })
  })

  /* Measured before paint, because the value feeds back into the position. An
   * ordinary effect would let the reader see the popup appear off-centre and
   * then jump. Its width does not depend on where it is put, so this settles in
   * one pass. */
  useLayoutEffect(() => {
    const measured = popupRef.current?.getBoundingClientRect().width ?? 0
    if (Math.abs(measured - width) > 0.5) setWidth(measured)
  })

  /* ⚠️ **AND THE STAGE, BECAUSE THE GEOMETRY IS ONE FRAME BEHIND IT**
   * (2026-09-19 audit). The measurement runs in a PASSIVE effect, so the render
   * in which `stage` becomes null still holds the rects measured against the
   * old one — and there is nowhere to draw a popup positioned inside a stage
   * that is not there. Asked here rather than trusted to the effect: this is
   * the honest guard rather than a race patch. */
  const box = lines[0]
  if (!selection || !stage || !box) return null

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
  /* ⚠️ **`stageBox` USED TO BE `stage.getBoundingClientRect()` READ RIGHT HERE,
     DURING RENDER**, while `lines` came from a past commit's effect — two
     layout snapshots from different moments, clamped against each other by
     arithmetic that cannot tell (2026-09-19 audit). It arrives measured in the
     same pass as the lines now; `selectionGeometry.ts` carries the argument.

     Before the stage has a box there is nothing to clamp against, and a very
     large bound is the honest "no constraint" rather than a guess. */
  const within = column ?? { left: 0, width: stageBox?.width ?? UNBOUNDED }
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
      height: stageBox?.height ?? UNBOUNDED,
      space: 'container',
    },
    // Clear of EVERY selected line, not just the one it hangs from.
    avoid: { ...extentOf(lines), space: 'container' },
    side: 'top',
    align: 'center',
    gap: GAP,
    edge: SURFACE_EDGE,
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

  /* The bar is placed afresh and its edge kept; any other face takes the kept
     edge, still CLAMPED: a face wider than the bar must not run off the stage
     merely because it inherited a position that suited a narrow one. One
     branch or the other, never both — the bar's own edge is already inside
     that clamp, so clamping it too could not change the answer. */
  let leftEdge = placed.left
  if (current === 'bar') barPlacedAt = placed.left
  else if (barLeft.current !== null) {
    leftEdge = Math.max(
      within.left + SURFACE_EDGE,
      Math.min(barLeft.current, within.left + within.width - SURFACE_EDGE - width),
    )
  }

  const top = placed.top
  const left = width > 0 ? leftEdge + width / 2 : box.left + box.width / 2

  /* EVERY FACE IS BOUNDED BY THE ROOM IT IS PLACED IN. `place` keeps a surface
     inside the stage by moving it, and moving is all it can do: an answer taller
     than the stage was pinned 8px from the top and ran on past the bottom, and a
     face wider than the column hung off its far side. So the popup is told the
     stage's height and the column's width, less the inset at each edge, scrolls
     inside that (see the stylesheet), and is measured — and so placed — at the
     size it is allowed to be.
     ⚠️ ONE RULE FOR EVERY FACE, AND IT WAS ONE FACE'S ALONE until 2026-09-14
     (2026-09-13 audit, #159) — the deleted lookup's, which is why the sentence
     above still talks about an answer taller than the stage. The rows were left
     out because "a bound could only clip a control" — true of a bound with
     nothing to scroll, and the popup scrolls now whichever face it shows. Unbounded, a bar or a palette in a
     column narrower than itself kept its leading edge in and ran the rest out
     over the margin notes the column exists to keep it off. */
  /* ⚠️ **CLAMPED AT ZERO, BECAUSE A NEGATIVE MAXIMUM IS NOT A BOUND — IT IS NO
     BOUND.** A stage or column narrower than twice the inset makes these
     negative, and CSS rejects a negative `max-width`/`max-height` outright: the
     declaration is dropped and the popup goes UNBOUNDED, which is the one
     outcome this object exists to prevent. Found by the 2026-09-19 audit. Zero
     is the honest answer — the surface has no room, and `place` has already
     reported `detached` for the cases where that means "do not draw". */
  const bound: CSSProperties = {
    maxWidth: Math.max(0, within.width - 2 * SURFACE_EDGE),
    maxHeight: Math.max(0, (stageBox?.height ?? UNBOUNDED) - 2 * SURFACE_EDGE),
  }

  /**
   * WHAT THE POPUP IS ACTING ON.
   *
   * A passage that is already marked shows ITS OWN appearance, not the last one
   * made — so every control in here edits the mark in front of the reader
   * rather than replacing it with the previous passage's scheme. On an unmarked
   * passage there is nothing to show but the last one, which is what pressing
   * the bar's control will lay down.
   */
  /* ⚠️ **IT USED TO ASK WHOSE MARK THIS WAS.** Only the reader's own was worth
   * adopting: the deleted companion's carried the reserved wave, and every
   * control here writes what it shows, so pressing the bar over one would have
   * laid down a reader-owned wave and dispatched `setMarkStyle('wave')` into the
   * app's own appearance — the reservation leaking through the one surface meant
   * to enforce it. There is one annotation kind now, so there is nobody to ask
   * about; `marked` is typed to say so. */
  const shown: MarkAppearance = marked ? { tint: marked.tint, style: marked.style } : appearance

  /* Where focus was as a face is turned — see `turning`. Every control that
     turns the popup calls this first. */
  const turnFrom = () => {
    turning.current =
      // Stryker disable next-line OptionalChaining: only a control inside the mounted popup calls this, so the ref always holds the popup here
      popupRef.current?.contains(document.activeElement) ? current : null
  }

  /* Back to the bar, from either of the two faces that have one.
     INLINE, and it used to be a `BackToBar` exported by the lookup face — the
     one component both that face and this file drew, which is why it took a
     `className`. The lookup is gone, so the second caller is gone, and a
     component with one caller is a layer between a reader and a button. */
  const back = (
    <button
      type="button"
      className={styles.tool}
      onClick={() => {
        turnFrom()
        setFace('bar')
      }}
      title="Back"
      aria-label="Back to the selection tools"
    >
      <ChevronLeft size={ICON.control} strokeWidth={ICON.stroke} />
    </button>
  )

  /* A chevron that turns the popup to one of its faces.
     ONE SPELLING FOR BOTH (2026-09-13), because each now carries a second fact
     beside its label: `data-opens`, which is where focus returns when the face
     it opened is left (see `turning`). Written out twice, the attribute and the
     face the click opens were two values that had to agree, on two buttons. The
     labels stay distinct — they are what the two chevrons are for. */
  const opener = (to: 'marks' | 'copy', title: string, label: string) => (
    <button
      type="button"
      className={styles.chevron}
      data-opens={to}
      onClick={() => {
        turnFrom()
        setFace(to)
      }}
      title={title}
      aria-label={label}
    >
      <ChevronRight size={ICON.inline} strokeWidth={ICON.stroke} />
    </button>
  )

  /* COPY IS DRAWN TWICE — on the bar and on the copy face — and it is ONE
     control both times (2026-09-19 audit). Same handler, same glyph, same
     tooltip; only what a screen reader is told differs, and it has to, because
     on the copy face it sits beside "Copy with citation" and "this passage"
     would no longer say which of the two it is. Written out twice, the two
     could drift into being different controls by accident: the second could
     lose the handler's meaning, or gain a glyph, and nothing would object. The
     same argument as `opener` above, whose labels also stay distinct. */
  const copyButton = (label: string) => (
    <button type="button" className={styles.tool} onClick={onCopy} title="Copy" aria-label={label}>
      <Copy size={ICON.control} strokeWidth={ICON.stroke} />
    </button>
  )

  return (
    <div
      ref={popupNode}
      className={styles.popup}
      data-face={current}
      style={{ top, left, '--popup-h': `${POPUP_H}px`, ...bound } as CSSProperties}
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
      <div key={current} className={styles.face}>
        {current === 'bar' && (
          <>
            {/* ONE CONTROL RATHER THAN A PALETTE: a reader picks a scheme and
                stays in it, so the bar shows the answer and keeps the question
                one chevron away.
                A GLYPH, like every other control on this row — a specimen here
                was a drawing among icons, and the bar is where the popup has to
                read as one row of tools. It carries the tint it will lay down
                as its colour, so the bar still says what pressing it does.
                Inline, because the value is one of three custom properties
                chosen at runtime; the hover fill behind it still changes.
                ONLY WHERE A MARK CAN BE MADE — see `canMark`. The divider goes
                with the pair, or the row would open on a rule. */}
            {canMark && (
              <>
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
                {opener('marks', 'Mark styles', 'Choose a colour and a style')}

                <span className={styles.divider} aria-hidden="true" />

                {/* NOTE IS A MARK TOO: it marks the passage first, to give the
                    note its anchor, so it cannot be offered where Mark is not. */}
                <button
                  type="button"
                  className={styles.tool}
                  onClick={onNote}
                  title="Note"
                  aria-label="Write a note on this passage"
                >
                  <MessageSquareQuote size={ICON.control} strokeWidth={ICON.stroke} />
                </button>
              </>
            )}

            {/* Copy stays one click; the other way to copy is one chevron
                away, exactly as another mark style is. */}
            {copyButton('Copy this passage')}
            {opener('copy', 'Copy options', 'More ways to copy this passage')}

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

        {current === 'marks' && (
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

        {current === 'copy' && (
          <>
            {back}
            <span className={styles.divider} aria-hidden="true" />
            {copyButton('Copy the passage on its own')}
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
