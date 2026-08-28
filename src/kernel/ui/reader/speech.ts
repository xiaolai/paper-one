/**
 * Reading aloud.
 *
 * Web Speech, which is what a WebView gives us: no network, no credentials, and
 * the voices the reader already has installed. The work that is not free is
 * getting back from the utterance to the words on screen — `onboundary` reports
 * a character offset into the string that was spoken, and the highlight needs a
 * Range in the document. So the text is collected with an index that maps any
 * offset back to the text node it came from.
 *
 * The handoff warns that boundary events are unreliable on WebKitGTK, which is
 * Linux. That is handled by feature detection rather than by a platform check
 * — see `Speaker`: if no boundary arrives shortly after speech starts, the
 * follow-along highlight is abandoned and the reading continues. Guessing from
 * the user agent would be wrong on the engines that do support it.
 */

import {
  blockAncestor,
  frameBoxInHost,
  hostFromBookRect,
  overlaps,
  type HostRect,
} from './coordinates'
import type { SpokenBox } from './rulerBand'

/** One text node's span within the collected string. */
interface Segment {
  readonly node: Text
  readonly start: number
  readonly end: number
}

export interface SpokenText {
  readonly text: string
  readonly segments: readonly Segment[]
}

/**
 * The document's readable text, with an index back into its nodes.
 *
 * Script, style and hidden elements are skipped — reading a stylesheet aloud is
 * the obvious failure, and an EPUB's hidden notes are the less obvious one.
 */
export function collectText(doc: Document): SpokenText {
  const view = doc.defaultView
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName.toLowerCase()
      if (tag === 'script' || tag === 'style' || tag === 'head') {
        return NodeFilter.FILTER_REJECT
      }
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT

      /* Actually hidden, not just hidden-looking by tag name.
       *
       * An EPUB's endnotes are routinely present in the spine item and hidden
       * with CSS or `hidden`, and a popup footnote's body is hidden by
       * definition. Read aloud they arrive as a block of citations in the
       * middle of a sentence, and there is no way for the listener to tell it
       * happened. `aria-hidden` is honoured for the same reason a screen
       * reader honours it: the author has said this text is not part of the
       * reading. */
      if (parent.closest('[hidden], [aria-hidden="true"]')) return NodeFilter.FILTER_REJECT

      /* The two properties need different treatment, and treating them alike is
       * wrong in both directions.
       *
       * `display` does NOT inherit: `display: none` on a container hides
       * everything inside it while each descendant's own computed display stays
       * whatever it was declared as. So a check on the immediate parent reads
       * `block` and accepts text that is not on the page — it has to be walked
       * up the ancestors.
       *
       * `visibility` DOES inherit, and a descendant can set `visibility:
       * visible` to come back into view inside a hidden container — a device
       * EPUBs use for pop-up footnotes. Walking it up would reject text that is
       * on screen, so the parent's computed value is both sufficient and
       * correct: inheritance has already been resolved into it. */
      if (view) {
        if (view.getComputedStyle(parent).visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT
        }
        for (let el: Element | null = parent; el; el = el.parentElement) {
          if (view.getComputedStyle(el).display === 'none') return NodeFilter.FILTER_REJECT
        }
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })

  const segments: Segment[] = []
  let text = ''
  let previousBlock: Element | null = null
  let node = walker.nextNode()
  while (node) {
    const value = node.textContent ?? ''

    /* A separator between BLOCKS, and only between blocks.
     *
     * Two failures, one on each side of this line, and the second was
     * introduced fixing the first:
     *
     *   Concatenated bare, the last word of one paragraph and the first of the
     *   next become one token — the voice says "endBegin", and every boundary
     *   index after it is off by the missing space, so the follow-along
     *   highlight drifts for the rest of the chapter.
     *
     *   Inserted between EVERY text node, it splits a word that an inline
     *   element divides: `co<em>operate</em>` is two text nodes in one line of
     *   prose, and the voice then says "co operate".
     *
     * The distinction is the containing block, which is exactly what decides
     * whether the two nodes are on the same line of prose. The gap is left
     * OUTSIDE the segment ranges on purpose, so an offset landing in it maps to
     * no node rather than to the wrong one. */
    const block = blockAncestor(node, view)
    if (text.length > 0 && block !== previousBlock) text += ' '
    previousBlock = block

    const start = text.length
    text += value
    segments.push({ node: node as Text, start, end: start + value.length })
    node = walker.nextNode()
  }
  return { text, segments }
}

/**
 * The Range covering `length` characters from `index` in the collected text.
 *
 * Binary search rather than a scan: `onboundary` fires per word, and a linear
 * walk of every text node per word turns a chapter into quadratic work.
 */
export function rangeAt(
  spoken: SpokenText,
  doc: Document,
  index: number,
  length: number,
): Range | null {
  const segment = findSegment(spoken.segments, index)
  if (!segment) return null

  const range = doc.createRange()
  range.setStart(segment.node, Math.min(index - segment.start, segment.node.length))

  /* The END index is EXCLUSIVE, so the segment to look up is the one holding
   * the last character — `endIndex - 1`. Looking up `endIndex` itself asks for
   * the position one past the word, which belongs to the NEXT segment, or to no
   * segment at all when the word ends the section: the lookup then fails, falls
   * back to the start segment, and the range collapses to that node's tail —
   * highlighting the first fragment of a word split across an inline element
   * instead of the whole of it. */
  const endIndex = index + length
  // A word can run past its node only in malformed markup, but clamping keeps
  // an inline <em> mid-word from throwing instead of highlighting.
  const endSegment = findSegment(spoken.segments, Math.max(endIndex - 1, index)) ?? segment
  range.setEnd(
    endSegment.node,
    Math.min(Math.max(endIndex - endSegment.start, 0), endSegment.node.length),
  )
  return range
}

function findSegment(segments: readonly Segment[], index: number): Segment | null {
  let low = 0
  let high = segments.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const segment = segments[mid]
    if (!segment) return null
    if (index < segment.start) high = mid - 1
    else if (index >= segment.end) low = mid + 1
    else return segment
  }
  return null
}

/**
 * The language a section's text is in, as the voice should be told it.
 *
 * `ensureLang` (session.ts) puts the book's `dc:language` on the root of every
 * section that does not declare its own, for hyphenation — so by the time a
 * document is spoken, the root's `lang` is the best answer there is. `xml:lang`
 * is read too because `ensureLang` treats it as already declared and leaves
 * `lang` alone, and an XHTML section written by hand often carries only that.
 *
 * Null rather than `''` when nothing is declared: an empty `lang` is not "no
 * preference" to every engine — WebKit reads it as a language it has no voice
 * for — and the only safe default is to leave the utterance's own alone.
 */
export function documentLang(doc: Document): string | null {
  const html = doc.documentElement as HTMLElement | null
  if (!html) return null
  const declared = html.getAttribute('lang') || html.getAttribute('xml:lang') || ''
  const trimmed = declared.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Which way this section's columns run — the same question `directionOf` in
 * `session.ts` answers, asked here without importing the session: this module
 * is loaded by a suite that runs without a DOM, and the session's import graph
 * is the reader's. Computed first, so an author's stylesheet counts.
 */
function readingDirection(doc: Document): 'ltr' | 'rtl' {
  const html = doc.documentElement as HTMLElement | null
  if (!html) return 'ltr'
  const computed = doc.defaultView?.getComputedStyle(html).direction
  const declared = computed || html.getAttribute('dir') || doc.body?.getAttribute('dir')
  return declared === 'rtl' ? 'rtl' : 'ltr'
}

/**
 * Where a spoken word is relative to the page the reader can see.
 *
 * `ahead` and `behind` are in READING order, not screen order, and the
 * difference is what stops the follow-along fighting the reader: a word ahead
 * is turned to, because the voice has walked off the page and the page should
 * follow it; a word behind means the reader flipped forward to look at
 * something, and turning "to" the word would either mean going back — taking
 * the page out from under them — or going forward, which is further from the
 * word and, repeated per word, runs away through the chapter.
 */
export type WordPlace = 'visible' | 'ahead' | 'behind'

/**
 * The page decision, over two rects in one coordinate space.
 *
 * The vertical axis is asked first. In scrolled flow it is the only axis that
 * moves, and in paginated flow every column shares the page's vertical band, so
 * a word off the page vertically is never a column question — while a word off
 * it horizontally is a column question that direction decides.
 */
export function placeOf(word: HostRect, page: HostRect, dir: 'ltr' | 'rtl'): WordPlace {
  if (overlaps(word, page)) return 'visible'
  if (word.top >= page.bottom) return 'ahead'
  if (word.bottom <= page.top) return 'behind'
  const forward = dir === 'rtl' ? word.right <= page.left : word.left >= page.right
  return forward ? 'ahead' : 'behind'
}

/**
 * The element the book's frame is clipped by — the view's host.
 *
 * `frameBoxInHost` needs the stage the frame is shown through, and the
 * reader's other overlays are handed it as a prop. Speech has only the
 * document, so it finds the stage from the frame: foliate mounts the iframe in
 * the view element's shadow tree, and a shadow root's host is that element.
 * Outside a shadow tree — a test's plain iframe — the frame's parent is the
 * nearest thing to a stage there is.
 */
function stageOf(frame: Element): HTMLElement | null {
  const root = frame.getRootNode() as Node & { host?: Element }
  if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && root.host instanceof HTMLElement) {
    return root.host
  }
  return frame.parentElement
}

/**
 * Measure a word against the page on screen.
 *
 * Null when the word has no box at all. When the PAGE cannot be measured — no
 * frame, no stage, a frame not yet laid out — the word is reported `visible`:
 * the highlight is still worth drawing, and "unmeasured" must never read as
 * "turn". Every early frame of a section being attached is a zero-sized page,
 * and a zero-sized page overlaps nothing: read as `ahead` it would turn a page
 * the voice had not left.
 */
export function placeOfRange(
  range: Range,
  doc: Document,
): { readonly box: SpokenBox; readonly place: WordPlace } | null {
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  const box: SpokenBox = { top: rect.top, left: rect.left, width: rect.width, height: rect.height }

  const frame = doc.defaultView?.frameElement
  const stage = frame ? stageOf(frame) : null
  if (!stage) return { box, place: 'visible' }
  const page = frameBoxInHost(doc, stage)
  const word = hostFromBookRect(rect, doc, stage)
  if (!page || !word || page.width === 0 || page.height === 0) return { box, place: 'visible' }
  return { box, place: placeOf(word, page, readingDirection(doc)) }
}

/** Why an utterance is over. `ended` is the only one worth continuing from. */
export type DoneReason = 'ended' | 'empty' | 'error'

export interface SpeakerCallbacks {
  /** A word began. Null when boundaries are not available on this engine. */
  onWord: (index: number, length: number) => void
  /**
   * Speech finished, and why. `ended` is the text running out — a section
   * read to its last word; `empty` is a section with nothing to read, reported
   * synchronously from inside `speak`; `error` is the engine giving up. Not
   * called for `stop()`, whose caller already knows.
   */
  onDone: (reason: DoneReason) => void
  /**
   * Called once if the engine turns out not to report word boundaries, so the
   * caller can drop the follow-along highlight rather than leaving a stale one
   * parked on the first word for the rest of the chapter.
   */
  onNoBoundaries: () => void
}

/**
 * How long to wait for the first boundary event before concluding the engine
 * does not send them. Generous: the first word can be slow to start on a cold
 * voice, and a false negative costs the highlight for the whole chapter.
 */
const BOUNDARY_GRACE_MS = 2500

export class Speaker {
  /**
   * Which utterance is current.
   *
   * `speechSynthesis.cancel()` does not silence the utterance it cancels: its
   * `end` — or `error` — still arrives, just late. Without a way to tell whose
   * event it is, that stale end clears the NEW utterance's boundary timer and
   * reports `onDone` while the new one is still speaking, so the Listen control
   * snaps back to idle a moment after it was pressed.
   *
   * A counter rather than the utterance object, so nothing is retained: every
   * handler closes over the generation it was registered under and does nothing
   * unless it is still the current one.
   */
  #generation = 0
  #sawBoundary = false
  #graceTimer: ReturnType<typeof setTimeout> | null = null
  readonly #synth: SpeechSynthesis
  readonly #cb: SpeakerCallbacks

  constructor(callbacks: SpeakerCallbacks, synth: SpeechSynthesis = window.speechSynthesis) {
    this.#cb = callbacks
    this.#synth = synth
  }

  get speaking(): boolean {
    return this.#synth.speaking
  }

  get paused(): boolean {
    return this.#synth.paused
  }

  /**
   * Speak, and report whether anything was actually queued.
   *
   * The boolean matters: a section with no readable text calls `onDone`
   * SYNCHRONOUSLY, before this returns. A caller that sets its own "speaking"
   * flag afterwards would overwrite the done it has already been told about,
   * leaving the Listen control stuck on with nothing playing.
   */
  speak(text: string, lang: string | null): boolean {
    this.stop()
    const generation = ++this.#generation
    if (!text.trim()) {
      this.#cb.onDone('empty')
      return false
    }

    const utterance = new SpeechSynthesisUtterance(text)
    /* Only when there is one. Assigning `''` is not a no-op on every engine —
     * see `documentLang` — and the platform's own default is the one the
     * reader chose in their system settings. */
    if (lang) utterance.lang = lang
    this.#sawBoundary = false

    utterance.addEventListener('boundary', (event) => {
      if (generation !== this.#generation) return
      const { charIndex, charLength, name } = event as SpeechSynthesisEvent & {
        charLength?: number
        name?: string
      }
      // Sentence boundaries arrive on the same event in some engines; the
      // highlight is per word, so the rest are ignored rather than flashing a
      // whole sentence.
      if (name && name !== 'word') return
      this.#sawBoundary = true
      this.#cb.onWord(charIndex, charLength && charLength > 0 ? charLength : wordLengthAt(text, charIndex))
    })

    /* Both guarded by generation. `cancel()` does not suppress the cancelled
     * utterance's end — it merely makes it late — so an unguarded handler
     * reports the OLD utterance finishing while the new one is speaking. */
    utterance.addEventListener('end', () => this.#finish(generation, 'ended'))
    // An error is still an end as far as the caller is concerned: the controls
    // must come back rather than staying stuck on "speaking". It is named as
    // one, though, so the caller does not read it as a section finished and
    // go on to the next.
    utterance.addEventListener('error', () => this.#finish(generation, 'error'))

    /* The grace period starts when the voice does, not when the utterance is
     * queued. A cold voice can take seconds to begin — a downloadable macOS
     * voice is fetched on first use — and a timer started at queue time spends
     * that wait counting down, then concludes from the silence that this engine
     * does not report boundaries and drops the follow-along for the whole
     * chapter. `start` is also the safety net for an engine that never begins:
     * no start, no timer, and the highlight simply never appears rather than
     * being actively disabled. */
    utterance.addEventListener('start', () => {
      if (generation !== this.#generation) return
      this.#clearGrace()
      this.#graceTimer = setTimeout(() => {
        if (generation !== this.#generation) return
        if (!this.#sawBoundary) this.#cb.onNoBoundaries()
      }, BOUNDARY_GRACE_MS)
    })

    this.#synth.speak(utterance)
    return true
  }

  pause(): void {
    if (this.#synth.speaking && !this.#synth.paused) this.#synth.pause()
  }

  resume(): void {
    if (this.#synth.paused) this.#synth.resume()
  }

  stop(): void {
    this.#clearGrace()
    // Retires the current generation, so the cancelled utterance's late end
    // cannot report itself as the current one finishing.
    this.#generation += 1
    // cancel() on an idle synth is harmless, and calling it unconditionally is
    // what clears an utterance queued by a previous section.
    this.#synth.cancel()
  }

  #finish(generation: number, reason: DoneReason): void {
    if (generation !== this.#generation) return
    this.#clearGrace()
    this.#cb.onDone(reason)
  }

  #clearGrace(): void {
    if (this.#graceTimer !== null) {
      clearTimeout(this.#graceTimer)
      this.#graceTimer = null
    }
  }
}

/**
 * The length of the word starting at `index`.
 *
 * WebKit reports `charLength` as 0 on some voices, and a zero-length highlight
 * is invisible — which looks exactly like boundaries not working at all.
 */
export function wordLengthAt(text: string, index: number): number {
  const match = /^\S+/.exec(text.slice(index))
  return match ? match[0].length : 1
}

/** Whether this build can read aloud at all. */
export function speechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}
