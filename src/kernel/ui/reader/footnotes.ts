/**
 * A book's notes, shown in place — the popover's half of the reader session.
 *
 * ⚠️ **OUT OF `session.ts`, AND IT OWNS ITS STATE RATHER THAN SHARING THE
 * SESSION'S.** Four fields — the note's view, which click it answers, where it
 * is mounted and the box it is measured from — are read by nothing else, so
 * they live here. What a note needs FROM the session is small and named, in
 * `NoteSession`: the element foliate renders into, whether the book is still
 * open, the host's callbacks, and a way to move the reader.
 *
 * ⚠️ **THE DISPOSAL LATCH STAYS THE SESSION'S, AND IS ASKED, NEVER COPIED.**
 * `session.ts` exists to make disposal ONE latch — a `disposed` flag scattered
 * across steps is the defect its header records. So this holds no flag of its
 * own: `NoteSession.disposed` is read at every moment a note could arrive after
 * the book has gone, which is the same set of moments the session checked when
 * this code lived inside it.
 */

import type { ExternalLinkDetail, LinkDetail, LoadDetail, View } from 'foliate-js/view.js'
import {
  FootnoteHandler,
  type FootnoteRenderDetail,
  type FootnoteType,
} from 'foliate-js/footnotes.js'
import { rangeBoxInHost, type HostRect } from './coordinates'
import { isBacklink } from './backlink'
import { stripScripts } from './bookScripts'
import { markSmallText } from './markSmallText'
import { suppressEmptyGeneratedContent } from './generatedContent'
import { FOOTNOTE } from '../../core/metrics'
import { PARK_OFFSET } from '../../core/placement'

/**
 * Where a reference sits, in the host's coordinates.
 *
 * A RANGE AROUND THE ELEMENT, because `coordinates` speaks ranges and a
 * superscript marker is usually one character — `getBoundingClientRect` on the
 * `<a>` would work and would be a second way of crossing the same iframe
 * boundary, which is how two answers to one question begin. Null when the
 * anchor's document has gone, which is what a section re-render does.
 */
function anchorRectInHost(a: Element, host: HTMLElement): HostRect | null {
  try {
    /* An anchor whose document has gone throws on this line, which is the same
       answer as a document that will not give a range: no rect. A guard above
       for the null said it twice. */
    const range = (a.ownerDocument as Document).createRange()
    range.selectNode(a)
    return rangeBoxInHost(range, host)
  } catch {
    return null
  }
}

/**
 * Let go of a note's view — CLOSE IT BEFORE DETACHING IT.
 *
 * `remove()` alone throws, and the throw reaches the app's error boundary: the
 * paginator keeps a `ResizeObserver` on its container and the inner view keeps
 * one on `doc.body`, so detaching fires them with a size of zero, `render`
 * runs against a document that is no longer there, and `columnize` reads
 * `doc.documentElement` off null. **Closing a footnote took the book down.**
 *
 * `close()` is what unobserves — it calls `renderer.destroy()`, which does
 * `#observer.unobserve` on both. It does NOT destroy the book, which matters
 * because a note's view shares one with the reader: `Loader.destroy`, the call
 * that would revoke every shared object URL, is reachable only through
 * `Book.destroy`, and nothing here calls that.
 *
 * EXPORTED FOR THE ORDER. The order is the whole of the fix and it cannot be
 * checked from outside the class — these suites run without a DOM, so no real
 * view can be built. A stand-in through this seam can prove `close` precedes
 * `remove`, which is the thing that was wrong.
 *
 * Guarded, because a teardown that throws must not stop the popover closing:
 * the reader asked for it to go away, and that has to happen either way.
 */
export function releaseNoteView(view: Pick<View, 'close' | 'remove'>): void {
  try {
    view.close()
  } catch (cause) {
    console.warn('Paper: a note view would not close cleanly', cause)
  }
  view.remove()
}

/**
 * The origin a note's anchor rect is measured from.
 *
 * THE BOX THE POPOVER SAYS IT IS POSITIONED IN — its own offset parent, which
 * is by definition the element its `left` and `top` resolve against, reported
 * through `setMount`. So the number this produces and the number the
 * stylesheet consumes are in one space.
 *
 * REPORTED, NOT DERIVED. Working it out here as `mount.offsetParent` looks
 * equivalent and is not: the mount is a CHILD of the popover and the popover is
 * `position: absolute`, so that expression returns the popover — parked at
 * `left: -99999` while a note measures. Every anchor came out a hundred
 * thousand pixels away, `place` called every one of them `detached`, and the
 * popover stopped appearing at all.
 *
 * It was `#host`, the element foliate renders into, and that is a DIFFERENT
 * box: inside the stage's padding, inside the reading column's titlebar inset.
 * Every rect was correct and every note was drawn off by the sum of those —
 * the exact failure `placement.ts` names in its header, numerically valid and
 * wrong by a container's offset, with nothing able to tell. It is also the
 * space `proseColumn` reports the measure in, which is what lets the popover be
 * bounded by the words rather than by the whole grid.
 *
 * BY CAPABILITY, NOT BY `instanceof HTMLElement`. These suites run without a
 * DOM on purpose, so naming a DOM constructor at run time throws `HTMLElement
 * is not defined` in a session that is otherwise perfectly testable — it did,
 * in two tests, the moment this was written that way. What the caller needs is
 * a box, so a box is what is asked for.
 *
 * Falls back to the host when nothing was reported — before the popover has
 * mounted, and for a popover with no offset parent, which is what `display:
 * none` produces. The fallback is the behaviour this replaced, so a wiring
 * failure puts the note back where it used to be rather than nowhere.
 */
export function noteSpace(within: HTMLElement | null, host: HTMLElement): HTMLElement {
  return typeof within?.getBoundingClientRect === 'function' ? within : host
}

/** What a link inside a note needs, to move the reader instead of the note. */
export interface NoteLinkHost {
  /** Tell the host where the reader is leaving from, so `⌘[` can come back. */
  readonly onLink: (detail: LinkDetail, event: Event) => void
  /** A scheme that leaves the book. The host cancels and routes it. */
  readonly onExternalLink: (detail: ExternalLinkDetail, event: Event) => void
  /** Take the note down. */
  readonly close: () => void
  /** Move the READER — the main view, not the note's. */
  readonly goTo: (href: string) => void
}

/**
 * A link CLICKED INSIDE A NOTE moves the reader, not the note.
 *
 * A note is a whole `foliate-view`, so foliate wires its document up the same
 * way it wires the book's: unhandled, the note's own `link` event ends in
 * `noteView.goTo(href)` — and the note view navigates ITSELF. Clicking the `↩`
 * at the end of an endnote LOADED THE WHOLE CHAPTER INTO THE NOTE BOX,
 * measured at 90px tall, with the reader still on the page they started from.
 * That is the other half of "no back to reference anchor": the control is right
 * there in the note, and it did the opposite of what it says.
 *
 * So: cancel, take the note down, and send the reader there.
 *
 * EXPORTED FOR THE ORDER, as `releaseNoteView` is, and for the same reason —
 * the order is the whole of it and cannot be checked from outside the class.
 * `onLink` comes BEFORE `goTo` so the origin is recorded from where the reader
 * still is; `close` comes before both so the note is not sitting over the page
 * it is sending them to. These suites run without a DOM, so a stand-in through
 * this seam is the only way to prove any of that.
 *
 * PER NOTE VIEW, NOT ONCE. Unlike the footnote handler's own events, each note
 * is a new element and there is nowhere else to put this. The view is closed
 * and dropped when the note goes, so the listeners go with it.
 */
export function watchNoteLinks(
  noteView: Pick<View, 'addEventListener'>,
  host: NoteLinkHost,
): void {
  noteView.addEventListener('link', (event) => {
    /* The note view must not navigate itself. This is the fix; the rest is
       where the reader goes instead. */
    event.preventDefault()
    const detail = (event as CustomEvent<LinkDetail>).detail
    host.close()
    host.onLink(detail, event)
    host.goTo(detail.href)
  })
  noteView.addEventListener('external-link', (event) => {
    /* THE HOST DECIDES, as it does for the book — it cancels and hands the href
       to the platform's browser through a route Paper chose. Left alone,
       foliate calls `globalThis.open` with the book's own string, and a note is
       no more trustworthy than a page. */
    host.onExternalLink((event as CustomEvent<ExternalLinkDetail>).detail, event)
  })
}

/**
 * A note, extracted and ready to show.
 *
 * THE ELEMENT, NOT ITS TEXT. `FootnoteHandler` renders the note into a real
 * `foliate-view`, so it arrives with the book's own markup, its own styles and
 * its links intact — a note carrying emphasis, a nested citation or a table
 * survives, where `textContent` would flatten all three. The host mounts it.
 *
 * `at` is where the REFERENCE was, in host coordinates, because that is what a
 * popover is placed against — not the note, which is somewhere else entirely.
 */
export interface FootnoteRender {
  readonly view: View
  readonly href: string
  readonly type: FootnoteType
  readonly at: HostRect | null
}

/**
 * One click on a note reference: where its marker was, and which click it is.
 *
 * ⚠️ **A SHARED `FootnoteHandler` CANNOT SAY WHICH NOTE A VIEW BELONGS TO.**
 * It emits `before-render` carrying `{ view }` and nothing else, so a session
 * holding one handler had to pair views to clicks by ARRIVAL ORDER — a FIFO
 * queue — and neither `resolveHref` nor the note's own render settles in click
 * order. Two notes in flight could cross: the older one was shown, at the
 * newer one's anchor, and the note the reader actually clicked was released.
 *
 * The same queue could also come up EMPTY, when the reader closed the note
 * before it rendered, and the fallback then handed the arriving view the
 * current sequence — which passed the supersession check and reopened the note
 * they had just dismissed.
 *
 * So a request owns its own handler and its own two listeners (see
 * `Footnotes.open`), and the pairing is an identity rather than a guess. A
 * handler holds only the `detectFootnotes` switch, left at its default, so a
 * fresh one per click is equivalent — and it becomes unreachable with its
 * listeners once its note is done, which is why "one per session, or a
 * listener leaks per note followed" no longer applies.
 */
interface NoteRequest {
  readonly at: HostRect | null
  readonly seq: number
}

/** What a note needs from the session that owns it — see this file's header. */
export interface NoteSession {
  /** The element foliate renders the book into; a note parks here with no mount. */
  readonly host: HTMLElement
  /** The session's own latch. Read at every moment, never captured. */
  readonly disposed: () => boolean
  /** See `SessionCallbacks.onFootnote`. */
  readonly onFootnote: (note: FootnoteRender | null) => void
  /** See `SessionCallbacks.onLink` — told before the reader is moved. */
  readonly onLink: (detail: LinkDetail, event: Event) => void
  /** See `SessionCallbacks.onExternalLink`. */
  readonly onExternalLink: (detail: ExternalLinkDetail, event: Event) => void
  /** Move the READER — the main view, not a note's — reporting a failure. */
  readonly goTo: (href: string) => void
  /** See `SessionDeps.applyVars` — every note document needs the contract. */
  readonly applyVars: (doc: Document) => void
  /** See `SessionDeps.styleNote`. */
  readonly styleNote: (view: View) => void
}

/**
 * The note popover's flow: open one per click, supersede the stale, and let
 * go of every view a note was rendered in.
 */
export class Footnotes {
  /**
   * The rendered note's view, so it can be released on dismiss.
   *
   * Typed as `View`, not `HTMLElement`: releasing it means calling `close()`
   * to unobserve the paginator before detaching, and a bare element type hides
   * that method — which is how it came to be detached without being closed.
   */
  #footnoteView: View | null = null
  /**
   * Which note the reader is waiting for.
   *
   * Every click takes the next number and carries it in its own `NoteRequest`;
   * anything arriving under an older one is released rather than shown. That
   * retires a note superseded by a newer click, and a note still rendering when
   * the reader closed the flow — `close`, `#noteFailed` and `release`
   * all advance it, which is how "nothing is pending" is expressed.
   *
   * ⚠️ **THIS USED TO BE HALF OF A PAIRING SCHEME, and the other half was a
   * FIFO queue.** The anchor was queued at the click and shifted off at
   * `before-render`, which pairs by arrival rather than by identity — see
   * `NoteRequest`. Two consequences, both real: two notes in flight could
   * cross, and a `before-render` arriving with the queue EMPTY (the reader had
   * closed the note) fell back to `{ at: null, seq: <current> }`, which then
   * passed this very check and reopened the note they had just dismissed. A
   * request that owns its own listeners has neither.
   */
  #noteSeq = 0
  /**
   * The box a note is rendered into, owned by the host.
   *
   * IT MAY NEVER MOVE. A `foliate-view` holds an iframe and re-parenting an
   * iframe reloads it — which discarded the extracted note and restored the
   * whole chapter, with nothing raised. So the host registers one container up
   * front and every note is appended into it in place.
   */
  #footnoteMount: HTMLElement | null = null

  /**
   * The box the popover is POSITIONED IN — the origin its anchor rects use.
   *
   * NOT DERIVED FROM THE MOUNT, and that distinction cost the feature entirely.
   * The mount is a child of the popover and the popover is `position:
   * absolute`, so `mount.offsetParent` is the POPOVER — parked off-screen at
   * `left: -99999` while a note measures, which made every anchor read as a
   * hundred thousand pixels away, which `place` correctly called `detached`,
   * which hid the note. The component knows which box its `left` and `top`
   * resolve against; nothing else can work it out. See `noteSpace`.
   */
  #footnoteSpace: HTMLElement | null = null

  readonly #session: NoteSession

  constructor(session: NoteSession) {
    this.#session = session
  }

  /**
   * Listen for what ONE request's handler renders.
   *
   * PER CLICK, WITH THE REQUEST IN THE CLOSURE — see `NoteRequest` for the
   * pairing defect this removes. The handler is built for one `handle` call
   * and nothing else refers to it, so these two listeners die with it.
   */
  #watchOneNote(handler: FootnoteHandler, request: NoteRequest): void {
    /* This request's view has been let go, so `render` has nothing left to do
       with it. A `render` for a view already closed would otherwise close it
       twice — tolerated by `releaseNoteView`, and still a teardown running
       over a torn-down renderer. */
    let released = false
    /**
     * ATTACH THE VIEW BEFORE IT RENDERS. This is what `before-render` is for,
     * and ignoring it is not a missing nicety — it is a crash.
     *
     * `#showFragment` builds a detached `<foliate-view>`, opens the book in it,
     * emits this, and only then calls `goTo`. A detached element has no layout,
     * so the paginator's `columnize` reads `doc.documentElement` off a document
     * that is not there and throws `null is not an object` — which escapes the
     * handler's own promise chain and reaches the app's error boundary. The
     * reader loses the book because a footnote was clicked.
     *
     * Off-screen rather than hidden: `visibility: hidden` still lays out, and
     * the paginator needs a real size to column into. It is moved into the
     * popover when `render` says the note is ready.
     */
    handler.addEventListener('before-render', (event) => {
      const { view } = (event as CustomEvent<{ view: View }>).detail
      /* A session disposed between the click and this event still owns the
       * detached view foliate just built — nothing else will ever see it, so
       * bailing bare leaked its renderer and every blob it held (audit round
       * 1, #106). Released the same way `release` lets go of a rendered one.
       *
       * AND A CANCELLED REQUEST IS THE SAME SITUATION. The reader closed the
       * note, or clicked another one, while this was resolving: nothing will
       * ever show this view, so it is released here rather than attached,
       * styled and mounted on the way to being discarded at `render`. This is
       * the case the FIFO queue could not tell from a fresh one — it handed
       * the arriving view the CURRENT sequence, which then passed `render`'s
       * supersession check and reopened the note the reader had dismissed. */
      if (this.#session.disposed() || request.seq !== this.#noteSeq) {
        released = true
        releaseNoteView(view)
        return
      }
      this.#watchNoteLinks(view)
      this.#cleanNoteDocument(view)
      /* BEFORE `goTo`, like everything else in here. `setStyles` writes into
         the style element foliate appends after the book's own sheet, and the
         note has to be laid out with the reader's size rather than re-laid out
         after it — the popover measures the note's height to size its box, and
         measuring a note that is about to change size is measuring the wrong
         note. */
      this.#session.styleNote(view)
      /**
       * SCROLLED FLOW, NOT PAGINATED, and this is what lets the box fit the
       * note.
       *
       * The popover's view is a paginator like the reader's, which COLUMNIZES
       * into whatever box it is given — so a box sized to the note's content
       * simply reflows the text into a second column that is off-view. Sizing
       * the box was built against a paginated note and withdrawn for exactly
       * that: the measurement was right (43px for a one-line footnote, box
       * 420×115) and the note disappeared.
       *
       * A note is not a page and should never have been paginated. In scrolled
       * flow the content is one continuous column, `body.scrollHeight` means
       * what it says, and a long endnote scrolls inside the box instead of
       * hiding in column two.
       *
       * SET BEFORE `goTo`, which is why `before-render` is the only place this
       * can happen: `flow` is what triggers the paginator to re-render, and
       * `applyLayout` records that anything set after it lands too late.
       */
      const noteRenderer = view.renderer
      /* NO PAGE MARGIN. The main view gets one from `applyLayout`; this one
         was given no layout at all, so it kept foliate's default — which put
         the note's iframe 48px below the top of its container and made every
         attempt to fit the box show that empty band instead of the note.
         Set BEFORE `flow`, which is what triggers the re-render: `applyLayout`
         records that anything after it lands too late. */
      noteRenderer?.setAttribute('margin', '0px')
      noteRenderer?.setAttribute('gap', '0px')
      noteRenderer?.setAttribute('max-column-count', '1')
      noteRenderer?.setAttribute('flow', 'scrolled')

      /* THE STYLESHEET OWNS THE SIZE when there is a mount, and this sets none.
         An inline `height: 100%` here beat `.body > *` and resolved to zero
         against an auto-height parent, so the note rendered correctly into a
         box nobody could see — extraction working, popover 72px tall.
         Only the FALLBACK is sized here, because there is no stylesheet rule
         for a view parked on the host and the paginator cannot columnize a box
         with no dimensions. */
      const mount = this.#footnoteMount
      if (!mount) {
        /* THE POPOVER'S OWN BOUNDS, not a second guess at them. This box stands
           in for the popover the note would have been rendered into, so the
           note has to columnize at the size the popover would have given it —
           and it was written out as 400×320 beside a `FOOTNOTE` of 420×320.
           The height agreed and the width was 20px adrift, which is the worst
           kind of near-miss: a note measured in a box narrower than the one it
           will be shown in comes out a line taller than it needs to be, and
           nothing reports a box that is merely the wrong width.

           There is no third number here for the same reason: `FOOTNOTE` is
           already published to CSS as `--footnote-max-w` / `--footnote-max-h`,
           which is what sizes the popover when there IS a mount. */
        view.style.cssText = [
          'position:absolute',
          `left:${PARK_OFFSET}px`,
          'top:0',
          `width:${FOOTNOTE.maxWidth}px`,
          `height:${FOOTNOTE.maxHeight}px`,
        ].join(';')
      }
      ;(mount ?? this.#session.host).appendChild(view)
      /* The one being replaced is CLOSED, not just detached — see
         `#releaseFootnoteView`. Opening a second note while the first is up
         would otherwise throw for exactly the reason dismissing one did.
         Held after, so a note that never finishes rendering is still released:
         `close` and the next `render` both look here. */
      this.#releaseFootnoteView()
      this.#footnoteView = view
    })

    handler.addEventListener('render', (event) => {
      if (this.#session.disposed() || released) return
      const detail = (event as CustomEvent<FootnoteRenderDetail>).detail
      /* Superseded — a newer note was asked for, or the reader closed the
       * flow, while this one rendered. Shown, it would replace the newer note
       * and sit at the wrong anchor; released, the click that mattered wins.
       * `before-render` will usually have released it already; this is the
       * request that was still current then and is not now. */
      if (request.seq !== this.#noteSeq) {
        /* Nothing sets `released` here: a handler renders once, so this is the
           last thing this request will ever do. */
        releaseNoteView(detail.view)
        return
      }
      /* `before-render` already attached this one and released the last. */
      this.#footnoteView = detail.view
      this.#session.onFootnote({
        view: detail.view,
        href: detail.href,
        type: detail.type,
        /* THIS REQUEST'S OWN ANCHOR, not whichever one came off a queue
           first — the popover is positioned against the reference that was
           clicked, and pairing by arrival could hand it another note's. */
        at: request.at,
      })
    })
  }

  /**
   * The note's own document gets the same treatment the page does.
   *
   * A note is rendered by `FootnoteHandler` into a view the session did not
   * build, so NONE of what the session's `load` handler does to a page has ever
   * reached it — the note has always been the book's raw CSS in a box. That is
   * mostly right and deliberately left alone: a note should read as the book
   * wrote it.
   *
   * This one is not a matter of taste. The book's dead tooltip drew its empty
   * box inside the popover as readily as over the page, and a rule that is
   * wrong on the page does not become right in a note.
   */
  #cleanNoteDocument(noteView: View): void {
    noteView.addEventListener('load', (event) => {
      if (this.#session.disposed()) return
      const { doc } = (event as CustomEvent<LoadDetail>).detail
      /* A note is a document of the same book, loaded by the same loader. */
      stripScripts(doc)
      /* The note's document gets the contract too, and for the same reason the
         page's does: the sheets it was handed at `before-render` are static and
         read `var(--paper-*)` from the root. Without this the popover is the
         11.2px note again, by a different route. */
      this.#session.applyVars(doc)
      /* AND THE SAME MEASUREMENT THE PAGE GETS. `applyVars` re-measures only
         when the base MOVES, which on a freshly built note document it has
         not — so without this call the accessibility floor was inert inside
         every footnote popover, which is precisely where a book's smallest
         text lives. */
      markSmallText(doc)
      suppressEmptyGeneratedContent(doc)
    })
  }

  /** See `watchNoteLinks` — the order is the fix, and it is asserted there. */
  #watchNoteLinks(noteView: View): void {
    watchNoteLinks(noteView, {
      onLink: (detail, event) => {
        if (!this.#session.disposed()) this.#session.onLink(detail, event)
      },
      onExternalLink: (detail, event) => {
        if (!this.#session.disposed()) this.#session.onExternalLink(detail, event)
      },
      close: () => this.close(),
      goTo: (href) => this.#session.goTo(href),
    })
  }

  /**
   * Offer a link to the footnote handler; true when it took it.
   *
   * SYNCHRONOUS ANSWER, ASYNCHRONOUS NOTE. `handle` returns a promise when it
   * took the link and `undefined` when it did not, and it has already called
   * `preventDefault()` by then — so the caller knows immediately whether
   * foliate will navigate, without waiting for the note to render.
   */
  open(book: View['book'] | undefined, detail: LinkDetail, event: Event): boolean {
    if (!book) return false
    /* A LINK OUT OF A NOTE IS NOT A LINK INTO ONE — see `isBacklink`, which
       carries the whole rationale. Left to foliate, the `*` at the head of a
       footnote opened a popover containing that same `*` and nothing else
       (measured: 22px tall), and took away the only thing a backlink is for.
       Declining hands it back to the ordinary link path, so it navigates to
       the reference and `⌘[` comes back — which is what it should always have
       done. */
    if (isBacklink(detail.a)) return false
    /* PDF IS NOT IN SCOPE and needs no branch to say so: `makePdf`'s adapter
       has no `epub:type`, no ARIA role and no superscript, so the detection
       declines it on its own rules. A format check here would be a second
       answer to a question already answered. */
    /* A SYNCHRONOUS THROW IS POSSIBLE, and it would land in foliate's own
       event dispatch. `handle` calls `book.resolveHref(href)` BEFORE wrapping
       it — `Promise.resolve(book.resolveHref(href))` evaluates the call first
       — so a backend without that method throws rather than rejecting, and the
       throw escapes into `#handleLinks`. Caught here and treated as a note
       that would not open, which is the same outcome by a different route. */
    /* THIS CLICK'S OWN HANDLER, AND ITS LISTENERS ARE ON BEFORE IT RUNS —
       see `NoteRequest`. Registered first rather than after `handle` returns
       because that ordering is then not something to reason about: a
       `before-render` emitted anywhere in `handle`'s chain is already covered.
       A handler that DECLINES the link emits nothing at all, so the listeners
       simply go with it. */
    const request: NoteRequest = {
      at: anchorRectInHost(detail.a, this.#noteSpace()),
      /* CLAIMED, NOT COMMITTED. A declined link must not supersede a note the
         reader has open — following an ordinary link is not dismissing one —
         so `#noteSeq` only advances once the handler has taken it. */
      seq: this.#noteSeq + 1,
    }
    const handler = new FootnoteHandler()
    this.#watchOneNote(handler, request)
    let pending: Promise<void> | undefined
    try {
      pending = handler.handle(book, event)
    } catch (cause) {
      this.#noteFailed('that note could not be resolved', detail, event, cause)
      return true
    }
    if (!pending) return false
    this.#noteSeq = request.seq
    void pending.catch((cause: unknown) => {
      if (this.#session.disposed()) return
      /* ⚠️ **A STALE REJECTION USED TO CLOSE THE NOTE THAT REPLACED IT.**
         `#noteFailed` dismisses the popover and navigates the reader to ITS
         href — so an older request failing after a newer note had opened tore
         down the newer note and sent the reader to the older note's target, a
         place they had already moved on from. The same supersession the render
         path applies, on the road that was missing it. */
      if (request.seq !== this.#noteSeq) {
        console.warn('Paper: a superseded note could not be shown in place', detail.href, cause)
        return
      }
      this.#noteFailed('that note could not be shown in place', detail, event, cause)
    })
    return true
  }

  /**
   * FALL BACK TO THE JUMP, DO NOT SWALLOW IT. A note that will not resolve or
   * render in place is still a place in the book, and the reader asked to go
   * there. `preventDefault` has already stopped foliate navigating, so this
   * navigates instead — and tells the host first, so the origin is recorded
   * from where the reader still is and `⌘[` brings them back. A control that
   * silently does nothing is what WI-16 deleted.
   *
   * ONE HANDLER FOR BOTH FAILURE ROADS (audit round 1, #835): the synchronous
   * throw and the rejected render had drifted — only one of them dismissed an
   * open popover. Both now do: the flow is over, anything still in flight is
   * superseded, and the popover a previous note left open closes before the
   * jump.
   */
  #noteFailed(what: string, detail: LinkDetail, event: Event, cause: unknown): void {
    console.warn(`Paper: ${what}`, detail.href, cause)
    this.#noteSeq += 1
    /* ⚠️ **THE MOUNTED VIEW WAS LEFT BEHIND ON THIS ROAD ALONE** (2026-09-19
     * audit). `onFootnote(null)` tells the HOST to stop drawing the popover; it
     * does not touch the view the SESSION mounted. A failure arriving after
     * `before-render` had already attached one therefore hid the note and left
     * its renderer — and every blob it held — live in the host, until the next
     * note or `release` happened to let go of it.
     *
     * Every other way out of a note goes through here: `close`,
     * supersession at `render`, and `release`. This one did not, which is what
     * made the ownership rule partial rather than total. Null-safe, so the
     * common case — a failure before anything mounted — costs nothing.
     *
     * `goTo` moves the READER's view, not the note's. The note's view is only
     * ever reachable through `#footnoteView`. */
    this.#releaseFootnoteView()
    this.#session.onFootnote(null)
    this.#session.onLink(detail, event)
    this.#session.goTo(detail.href)
  }

  /** See `noteSpace` — exported, because the choice is the whole of it. */
  #noteSpace(): HTMLElement {
    return noteSpace(this.#footnoteSpace, this.#session.host)
  }

  /** Where notes are rendered. Null puts them back on the host — see the field. */
  setMount(mount: HTMLElement | null, within: HTMLElement | null = null): void {
    this.#footnoteMount = mount
    this.#footnoteSpace = within
  }

  /** See `releaseNoteView` — the order is the fix. */
  #releaseFootnoteView(): void {
    const view = this.#footnoteView
    this.#footnoteView = null
    if (view) releaseNoteView(view)
  }

  /** Close whatever note is open, and let go of the view it was rendered in. */
  close(): void {
    this.#releaseFootnoteView()
    this.#noteSeq += 1
    if (!this.#session.disposed()) this.#session.onFootnote(null)
  }

  /**
   * Let go of the open note for good — the session is being disposed.
   *
   * NOT `close`: that tells the host only while the session is live, and by
   * now it is not. `ReaderSession.dispose` tells the host itself, in its own
   * isolated step, so a host callback that throws cannot stop this release.
   */
  release(): void {
    this.#releaseFootnoteView()
    this.#noteSeq += 1
  }
}
