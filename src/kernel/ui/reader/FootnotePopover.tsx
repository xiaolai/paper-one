import { useEffect, useRef } from 'react'
import { FOOTNOTE } from '../../core/metrics'
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
  /** Hand the session the box to render into. Called on mount and unmount. */
  onMount: (mount: HTMLElement | null) => void
  onDismiss: () => void
}

/** Clear of the reference, so the marker itself stays readable. */
const GAP = 10

/**
 * THE BOX IS A FIXED HEIGHT, and a short note sits in more white than it needs.
 *
 * Fitting it to the note was built twice and withdrawn twice, and both attempts
 * are worth recording because the second looked like it had worked.
 *
 * **Paginated.** The measurement was right — `body.scrollHeight` reports 43px
 * for a one-line footnote and the box became 420×115 — and the note vanished,
 * because a paginator reflows its text into a new column when its box shrinks.
 *
 * **Scrolled.** `session.ts` now asks the note's view for `flow="scrolled"`,
 * which removes that reflow and is a real improvement in its own right: a long
 * endnote scrolls inside the box instead of hiding in column two. The box then
 * sized correctly to 420×116 and the DOM agreed — content at y=0, 328×15, in a
 * 386×44 box — and it still did not PAINT. Laid out, measurable, invisible.
 *
 * So the remaining obstacle is not layout and not the flow: it is that
 * resizing the box after the view has rendered leaves the iframe composited
 * against its old size. Sizing it BEFORE the note renders would need the
 * height before the content exists, which is the thing that cannot be known.
 * A tall box showing the note beats a tight one showing nothing.
 */

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

export function FootnotePopover({ note, stage, onMount, onDismiss }: FootnotePopoverProps) {
  const body = useRef<HTMLDivElement | null>(null)
  /* Registered once. Every note is appended into this element, and it has to
     be the SAME element every time — see the note on re-parenting above. */
  useEffect(() => {
    onMount(body.current)
    return () => onMount(null)
  }, [onMount])

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

  /* Placed against the REFERENCE, which is what the reader is looking at — the
     note itself is somewhere else in the book entirely. Below it where there is
     room, above it where there is not; `at` is null when the anchor's document
     has gone, and then the note sits in the middle rather than at 0,0. */
  const at = note?.at ?? null
  const stageHeight = stage?.clientHeight ?? 0
  const stageWidth = stage?.clientWidth ?? 0
  const below = at ? at.top + at.height + GAP : 0
  const fitsBelow = at ? below + FOOTNOTE.maxHeight <= stageHeight : false

  /* PARKED, NOT HIDDEN, when there is no note. `display: none` would give the
     paginator a zero-sized document to columnize at the moment a note renders
     into it, which is the one thing this container exists to prevent. */
  const parked: React.CSSProperties = { left: -99999, top: 0, visibility: 'hidden' }
  const placed: React.CSSProperties = at
    ? {
        left: Math.max(GAP, Math.min(at.left, Math.max(GAP, stageWidth - FOOTNOTE.maxWidth - GAP))),
        ...(fitsBelow ? { top: below } : { bottom: Math.max(GAP, stageHeight - (at.top - GAP)) }),
      }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }

  const label = heading(note?.type ?? null)

  return (
    <div
      className={styles.popover}
      style={note ? placed : parked}
      {...(note ? { role: 'dialog', 'aria-label': label ?? 'Note' } : { 'aria-hidden': true })}
    >
      {note && label && <div className={styles.label}>{label}</div>}
      <div className={styles.body} ref={body} />
      {note && (
        <button type="button" className={styles.dismiss} onClick={onDismiss}>
          Close
        </button>
      )}
    </div>
  )
}
