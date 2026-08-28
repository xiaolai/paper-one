import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { stagePoint, TAP_SLOP, tapIntent } from './tapToTurn'

/**
 * TURNING A PAGE BY TAPPING — the wiring, in one place.
 *
 * ## Why this is its own module
 *
 * `tapToTurn.ts` holds the DECISION: where the thirds are, what disqualifies a
 * tap, why the intent names a side rather than a direction. This holds the
 * WIRING: which targets get a listener, which coordinate space each measures
 * in, and how a listener is taken off a document that has gone.
 *
 * They were separated already; the wiring was still a hundred and seventy
 * lines inside `Reader`, next to preferences, marks, search and four tool
 * panes. Nothing else in that component reads a pointer event, and nothing
 * here reads a preference.
 *
 * ## What it costs to get wrong
 *
 * The browser client shipped a reader that opened a book and could not advance
 * it: `onPageIntent` was a no-op, so a tap, a swipe and the arrow keys all did
 * nothing. Found by trying to turn a page, which no test in this tree could
 * have done. Everything below is a case discovered after that.
 */

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
 * the button.
 *
 * ⚠️ **AND THEN THE LIST HELD A BARE `[role]`**, on the reasoning that a role
 * is only ever put on something meant to be interacted with. It is not. EPUB 3
 * puts one on every chapter — `<section role="doc-chapter">` is the structural
 * semantics inflection the spec recommends, and every current authoring tool
 * maps `epub:type="chapter"` to it — so `closest` walked up from any paragraph
 * to the section that held it, found a role, and refused. A book that followed
 * the spec could be opened and never advanced by tapping, and the gesture
 * this whole module exists for was dead on exactly the well-formed books.
 *
 * So the roles are enumerated after all: the WAI-ARIA widget roles a press
 * already belongs to. `menuitemcheckbox`, `menuitemradio`, `searchbox` and
 * `spinbutton` are the subclasses of roles on that list and take a press the
 * same way. A document role (`doc-*`), a landmark, a live region name what
 * the text IS; a tap on the prose inside one is a tap on prose.
 */
const WIDGET_ROLES = [
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'textbox',
  'searchbox',
  'combobox',
  'slider',
  'spinbutton',
  'option',
  /* The remaining widget roles of ARIA 1.2 that take a press: a tree's items,
   * and an interactive grid's cells and headers. The first cut stopped at the
   * form-control shapes and left a tap on these turning the page. */
  'treeitem',
  'gridcell',
  'rowheader',
  'columnheader',
]

const INTERACTIVE = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'label',
  '[contenteditable]:not([contenteditable="false"])',
  'audio[controls]',
  'video[controls]',
  ...WIDGET_ROLES.map((role) => `[role="${role}"]`),
].join(', ')

function onInteractive(target: EventTarget | null): boolean {
  return (target as Element | null)?.closest?.(INTERACTIVE) != null
}

/** Where a release landed and how wide its page is, both in stage coordinates. */
export interface TapPlace {
  readonly x: number
  readonly width: number
}

/** What `useTapToTurn` needs in order to attach anything. */
export interface TapToTurnDeps {
  /** The reading area. Taps that miss the book land here. */
  readonly stage: RefObject<HTMLElement | null>
  /** Ask for a page turn. `FoliateView`'s `onPageIntent` contract. */
  readonly turn: (intent: 'left' | 'right') => void
  /** Hide the chrome — a page turn is reading, and reading is not browsing. */
  readonly hideChrome: () => void
  /** Show it or hide it — a tap in the middle third, which turns nothing. */
  readonly toggleChrome: () => void
}

/**
 * Attach tap-to-turn to the stage, and hand back the `onDocument` callback that
 * attaches it to each section as foliate loads one.
 */
export function useTapToTurn({ stage: stageEl, turn, hideChrome, toggleChrome }: TapToTurnDeps): {
  readonly watchDocument: (generation: number, doc: Document | null) => void
} {
  /** Removes the last document's tap listeners — see `watchDocument`. */
  const tapCleanup = useRef<(() => void) | null>(null)

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
    placeOf: (clientX: number) => TapPlace,
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
      /* NO MATCHING PRESS, NO TAP. See the note on `downAt`: this used to
         fall through with `moved = 0`, which is a page turn. And ONLY the
         matching pointer's release ends the tracking — an unrelated
         pointer's `pointerup` used to clear it first, discarding the first
         pointer the note above says wins. */
      const from = downAt
      if (from === null || from.id !== pointer.pointerId) return
      downAt = null
      const place = placeOf(pointer.clientX)
      /* MEASURED ONCE, so the turn and the centre-toggle below judge the
       * same release by the same facts. */
      /* HOW FAR IT TRAVELLED, not where it ended. A drag that begins in the
       * middle and ends at the edge is a selection, not a page turn. */
      const moved = Math.hypot(pointer.clientX - from.x, pointer.clientY - from.y)
      /* A LINK WINS. foliate is already handling it, and turning the page
       * as well would leave the reader somewhere they did not choose. */
      const onControl = onInteractive(pointer.target)
      const selected = selectionOf() !== ''
      const intent = tapIntent({ x: place.x, moved, width: place.width, selected, onControl })
      if (intent !== null) {
        /* A TURN HIDES THE CHROME — "hides on scroll", and a tap-turn is
         * this client's scroll. The bar and footer come back on the next
         * centre tap. */
        hideChrome()
        turn(intent)
        return
      }
      /* THE MIDDLE THIRD, which `tapIntent` refuses on purpose, is where the
       * chrome is summoned — §06: "tap centre to show". Only a clean tap:
       * a drag, a selection or a tap on a link all still do nothing here.
       * `TAP_SLOP` is the one definition of "clean" — a second literal here
       * let the turn and the toggle disagree about what a tap was. */
      if (place.width > 0 && !onControl && !selected && moved <= TAP_SLOP) {
        toggleChrome()
      }
    }
    /* A POINTER THAT LEAVES IS DONE. A press that is dragged out of the
       target and released elsewhere sends this target no `pointerup`, so the
       tracked origin outlived the gesture — and `onDown` refuses a new press
       while one is tracked, which left tap-to-turn DEAD until something sent
       a `pointercancel`. A release outside cannot be a tap here anyway. */
    const onLeave = (event: Event) => {
      const pointer = event as PointerEvent
      if (downAt?.id === pointer.pointerId) downAt = null
    }
    target.addEventListener('pointerdown', onDown, { passive: true })
    target.addEventListener('pointerup', onUp, { passive: true })
    /* THE BROWSER TAKING THE GESTURE OVER. Without this the origin outlives
       the gesture and waits to be paired with an unrelated release. */
    target.addEventListener('pointercancel', onCancel, { passive: true })
    target.addEventListener('pointerleave', onLeave, { passive: true })
    return () => {
      target.removeEventListener('pointerdown', onDown)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onCancel)
      target.removeEventListener('pointerleave', onLeave)
    }
  },
  /* EVERYTHING THE CLOSURE CALLS. `[turn]` alone let a re-supplied
     `hideChrome` or `toggleChrome` go on being the OLD one for as long as
     `turn` stayed stable. */
  [turn, hideChrome, toggleChrome],
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
          /* No stage, or a document that is NOT framed. An unframed document
           * has no paginator and therefore no side-by-side columns: its own
           * box IS the page in front of the reader, so measuring against it is
           * right, not a fallback that "does nothing" — the earlier wording
           * here said the latter and described a tap this branch never
           * produced. The multi-column trap `stagePoint` exists for belongs
           * to a FRAMED document only. */
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

  /* THE LISTENERS GO WITH THE COMPONENT. `watchDocument` removes the previous
     document's on every call, and this removes the last one — without it a
     reader who closes a book leaves a listener on a document foliate is still
     holding. */
  useEffect(() => {
    return () => {
      tapCleanup.current?.()
      tapCleanup.current = null
    }
  }, [])

  return { watchDocument }
}
