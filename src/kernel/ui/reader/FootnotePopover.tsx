import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { FOOTNOTE, ICON } from '../../core/metrics'
import { place } from '../../core/placement'
import { noteText } from './backlink'
import type { FootnoteRender } from './session'
import styles from './FootnotePopover.module.css'

/**
 * A note, where the reader is looking.
 *
 * `bookCss.ts` has dressed `a[epub|type~="noteref"]` as a superscript since the
 * reader existed, and nothing in `src/` handled the click — a footnote was
 * styled and dead. For the reading Paper is for, that is not a nicety: in
 * serious nonfiction the notes are part of the text.
 *
 * WHAT ARRIVES IS AN ELEMENT, NOT A STRING. `FootnoteHandler` renders the note
 * into a real `foliate-view`, so it comes with the book's own markup and styles
 * — emphasis, a nested citation, a small table all survive, where `textContent`
 * would flatten them into one line.
 *
 * THIS COMPONENT IS ALWAYS MOUNTED, and that is not an oversight. Two things
 * force it, and both were found by running it rather than by reasoning:
 *
 *  1. **The mount point may never move.** A `foliate-view` holds an iframe, and
 *     re-parenting an iframe RELOADS it — which threw the extracted note away
 *     and silently restored the entire chapter in its place. So the session
 *     appends into a container that exists before the click and never moves
 *     afterwards; this component owns that container and only repositions it.
 *  2. **The container must have layout while the note renders.** `display:
 *     none` would hand the paginator a zero-sized document to columnize. It is
 *     parked off-screen instead, which lays out and does not show.
 */

export interface FootnotePopoverProps {
  note: FootnoteRender | null
  /** The element the note is positioned within — the reader's stage. */
  stage: HTMLElement | null
  /**
   * The column the words are in, in the stage's own coordinates.
   *
   * NOT THE STAGE, for the reason `SelectionTools` gives at the same prop: the
   * stage is the whole prose grid — gutter, measure, margin and padding — and a
   * note anchored near the end of a line was free to hang across the margin
   * where the margin notes are drawn. Null for a fixed-layout book, which fills
   * the grid and has no measure to be bounded by.
   */
  column: { readonly left: number; readonly width: number } | null
  /** Hand the session the box to render into. Called on mount and unmount. */
  onMount: (mount: HTMLElement | null) => void
  /** Put the note on the clipboard. The host owns the failure path — see `Reader`. */
  onCopy: (text: string) => void
  onDismiss: () => void
}

/** Clear of the reference, so the marker itself stays readable. */
const GAP = 10

/**
 * How long to keep asking the note how tall it is, and how often.
 *
 * BY TIMER, NOT BY FRAME. The note lays out after `render` fires, and a whole
 * second of `requestAnimationFrame` measured an empty document — the popover's
 * renderer competes with the main view's, and how long that takes is a
 * property of the machine. Three seconds at 100ms is thirty cheap checks, and
 * a note that never lays out is shown at the full box, which is the behaviour
 * without any of this.
 */
const MEASURE_EVERY_MS = 100
const MEASURE_FOR_MS = 3000

/** How long the copy button says it worked before going back to offering it. */
const COPIED_FOR_MS = 1400

/**
 * What the box knows about its own height.
 *
 * THE POPOVER IS NOT SHOWN WHILE THIS IS `measuring`, and that is the whole
 * point of naming the state. The stylesheet's height is the full 320px box, the
 * measurement lands 100ms later at the note's real height, and painting both in
 * turn is a panel that appears at full size and then snaps shut — which reads
 * as a glitch rather than as a note. Held invisible until it is settled, it
 * appears once, at the size it will keep.
 *
 * `unmeasured` is the honest third case rather than a silent fallback to
 * `fitted`: a note whose document never laid out is SHOWN, at the full box,
 * because a note the reader cannot see is worse than one in too much white.
 */
type Fit =
  | { readonly state: 'measuring' }
  | { readonly state: 'fitted'; readonly height: number }
  | { readonly state: 'unmeasured' }

const MEASURING: Fit = { state: 'measuring' }

/** A label a reader would recognise, or nothing. */
function heading(type: FootnoteRender['type']): string | null {
  switch (type) {
    case 'biblioentry':
      return 'Reference'
    case 'definition':
      return 'Definition'
    case 'endnote':
      return 'Endnote'
    case 'footnote':
      return 'Footnote'
    case 'note':
      return 'Note'
    default:
      /* NOTHING RATHER THAN "NOTE". The type is null when the book declared
         none, which is most books — and a heading invented for them would be
         the app asserting something it was not told. */
      return null
  }
}

export function FootnotePopover({
  note,
  stage,
  column,
  onMount,
  onCopy,
  onDismiss,
}: FootnotePopoverProps) {
  const body = useRef<HTMLDivElement | null>(null)
  const surface = useRef<HTMLDivElement | null>(null)
  /**
   * How tall the note is once it has laid out — the height to CLIP to.
   *
   * THE BOX CLIPS; IT DOES NOT RESIZE THE NOTE. Three earlier attempts made
   * the view follow the container and all three failed the same way: the note
   * laid out correctly at the new size, reported the right geometry — content
   * at y=0, 328x15, inside 386x44 — and did not paint. Paginated, it also
   * reflowed into a column nobody could reach.
   *
   * The view is a fixed `--footnote-max-h` and stays so; this only says how
   * much of it to show. Nothing the iframe owns changes size, so there is
   * nothing to repaint. Capped at the box, because a longer note scrolls
   * inside the view rather than growing the popover.
   */
  const [fit, setFit] = useState<Fit>(MEASURING)
  const [copied, setCopied] = useState(false)
  /* Registered once. Every note is appended into this element, and it has to
     be the SAME element every time — see the note on re-parenting above. */
  useEffect(() => {
    onMount(body.current)
    return () => onMount(null)
  }, [onMount])

  useEffect(() => {
    if (!note) {
      setFit(MEASURING)
      return
    }
    setFit(MEASURING)
    let live = true
    let waited = 0
    let timer = 0
    const tick = () => {
      if (!live) return
      const doc = note.view.renderer?.getContents?.()[0]?.doc
      const height = doc?.body?.scrollHeight ?? 0
      if (height > 0) {
        setFit({ state: 'fitted', height: Math.min(height, FOOTNOTE.maxHeight) })
        return
      }
      waited += MEASURE_EVERY_MS
      if (waited < MEASURE_FOR_MS) timer = window.setTimeout(tick, MEASURE_EVERY_MS)
      /* GIVING UP IS A STATE, NOT A TIMEOUT THAT LEAVES NOTHING BEHIND. The
         box is invisible until this settles, so a run that simply stopped
         would hide the note for good. */
      else setFit({ state: 'unmeasured' })
    }
    /* The first check costs nothing and a note that is already laid out is
       shown in this frame rather than in the next tenth of a second. */
    tick()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [note])

  /* The confirmation goes away on its own, and with the note when it closes —
     a tick still showing over the next note would be claiming that one was
     copied too. */
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), COPIED_FOR_MS)
    return () => clearTimeout(timer)
  }, [copied])
  useEffect(() => setCopied(false), [note])

  /**
   * Copy the note.
   *
   * READ FROM THE RENDERED DOCUMENT, not from anything held alongside it. The
   * note in the box is what `FootnoteHandler` extracted, and it is the only
   * copy of it there is — `FootnoteRender` carries the view, not the text.
   */
  const copy = useCallback(() => {
    const doc = note?.view.renderer?.getContents?.()[0]?.doc
    const text = doc?.body ? noteText(doc.body) : ''
    if (!text) return
    onCopy(text)
    setCopied(true)
  }, [note, onCopy])

  /**
   * Esc closes it, and the key is taken before anything else can have it.
   *
   * CAPTURE, because the book's own document handles keys too — see
   * `#watchKeys`. Without it, Esc inside a note that has focus would reach the
   * reader's handler first and do whatever Esc does there while the note
   * stayed up.
   */
  useEffect(() => {
    if (!note) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onDismiss()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [note, onDismiss])

  /** A click anywhere but the note closes it — including on the page under it. */
  useEffect(() => {
    if (!note) return
    const onDown = (event: PointerEvent) => {
      if (body.current?.parentElement?.contains(event.target as Node)) return
      onDismiss()
    }
    /* The next frame, so the click that OPENED the note does not also close
       it. The `link` event and this listener would otherwise land in one
       gesture, and the note would flash and vanish. */
    const armed = requestAnimationFrame(() => {
      window.addEventListener('pointerdown', onDown, true)
    })
    return () => {
      cancelAnimationFrame(armed)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [note, onDismiss])

  /**
   * How big the box actually is, once the note inside it has settled.
   *
   * MEASURED, NOT DERIVED. `place` needs the surface's size, and this one is
   * `--footnote-max-w` by a height that is the note's plus chrome — the label
   * row, two paddings and a gap. Adding those up here would put four numbers
   * from the stylesheet into the component, and the box would drift the first
   * time one of them changed. It has a box already; read it.
   *
   * THE TWO PASSES ARE THE POINT, and they are the same two `usePlacement`
   * makes: the box is laid out before it is shown, this reads it, and the
   * placement follows in the same commit. Both happen before paint.
   */
  const [box, setBox] = useState<{ width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    if (!note || fit.state === 'measuring') {
      setBox(null)
      return
    }
    const el = surface.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setBox((was) =>
      was && was.width === rect.width && was.height === rect.height
        ? was
        : { width: rect.width, height: rect.height },
    )
  }, [note, fit])

  /* Placed against the REFERENCE, which is what the reader is looking at — the
     note itself is somewhere else in the book entirely. `at` is null when the
     anchor's document has gone. */
  const at = note?.at ?? null
  const stageBox = stage?.getBoundingClientRect()
  /* Before the stage has a box there is nothing to clamp against, and a very
     large bound is the honest "no constraint" rather than a guess — the same
     reading `SelectionTools` takes at the same seam. */
  const within = column ?? { left: 0, width: stageBox?.width ?? 1e6 }

  /* WHERE IT GOES IS `place`'S DECISION. What used to be here was a `Math.max`
     of a `Math.min` for the left edge and a `bottom` fallback for the top, and
     it had two faults the shared routine does not: it clamped to the STAGE, so
     a note anchored at the end of a line hung across the margin column where
     margin notes are drawn; and it chose above-or-below against
     `FOOTNOTE.maxHeight` rather than the box's real height, so a two-line note
     was thrown above its reference to make room for 320px it did not occupy.

     `container` space: `at` is stage-relative, from `anchorRectInHost`, and the
     bounds are the column at the stage's origin. The brand is what stops a
     viewport rect wandering in — it would be numerically valid and wrong by the
     stage's offset, and nothing else could tell. */
  const placed =
    at && box
      ? place({
          anchor: { top: at.top, left: at.left, width: at.width, height: at.height, space: 'container' },
          surface: box,
          bounds: {
            top: 0,
            left: within.left,
            width: within.width,
            height: stageBox?.height ?? 1e6,
            space: 'container',
          },
          side: 'bottom',
          align: 'start',
          gap: GAP,
          edge: GAP,
        })
      : null

  /* NO ANCHOR, BUT STILL A NOTE. `at` is null when the reference's document has
     gone out from under it, and the reader asked for this note either way —
     centred in the column beats not showing it at all, which is what deferring
     to `place` alone would do. Kept from the arithmetic this replaced, because
     it was the one thing that arithmetic got right that `place` cannot know. */
  const centred =
    !at && box
      ? {
          left: within.left + Math.max(0, (within.width - box.width) / 2),
          top: Math.max(GAP, ((stageBox?.height ?? box.height) - box.height) / 2),
        }
      : null

  /* `place` REPORTS how well it did. `detached` means the reference is wholly
     outside the column — it has been paged past, or it is on a page that is not
     the one being shown — and placement's contract is to hide the surface then.
     What would be drawn is a note hanging from nothing, at whatever spot inside
     the column happened to be closest. */
  const spot = placed && placed.fit !== 'detached' ? placed : centred
  const shown = note !== null && spot !== null

  /* PARKED, NOT HIDDEN, whenever it is not shown — with no note, while the note
     is still measuring, and when there is nowhere to put it. `display: none`
     would give the paginator a zero-sized document to columnize at the moment a
     note renders into it, which is the one thing this container exists to
     prevent; off-screen lays out and does not show. */
  const parked: React.CSSProperties = { left: -99999, top: 0, visibility: 'hidden' }
  const label = heading(note?.type ?? null)

  return (
    <div
      className={styles.popover}
      ref={surface}
      style={shown && spot ? { left: spot.left, top: spot.top } : parked}
      {...(shown ? { role: 'dialog', 'aria-label': label ?? 'Note' } : { 'aria-hidden': true })}
    >
      {/* THE LABEL AND THE CONTROLS SHARE A ROW, and the row exists even when
          the book declared no type — the controls belong at the top right of
          the box whether or not there is anything to their left. */}
      {note && (
        <div className={styles.head}>
          {label && <span className={styles.label}>{label}</span>}
          <div className={styles.tools}>
            <button
              type="button"
              className={styles.tool}
              onClick={copy}
              title={copied ? 'Copied' : 'Copy'}
              aria-label="Copy this note"
            >
              {copied ? (
                <Check size={ICON.control} strokeWidth={ICON.stroke} />
              ) : (
                <Copy size={ICON.control} strokeWidth={ICON.stroke} />
              )}
            </button>
            <button
              type="button"
              className={styles.tool}
              onClick={onDismiss}
              title="Close"
              aria-label="Close this note"
            >
              <X size={ICON.control} strokeWidth={ICON.stroke} />
            </button>
          </div>
        </div>
      )}
      <div
        className={styles.body}
        ref={body}
        /* The full box until measured, and the note's own height after — as a
           WINDOW onto a view that never changes size. See `Fit`. */
        style={fit.state === 'fitted' ? { height: fit.height } : undefined}
      />
    </div>
  )
}
