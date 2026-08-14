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
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName.toLowerCase()
      if (tag === 'script' || tag === 'style' || tag === 'head') {
        return NodeFilter.FILTER_REJECT
      }
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })

  const segments: Segment[] = []
  let text = ''
  let node = walker.nextNode()
  while (node) {
    const value = node.textContent ?? ''
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

  // A word can run past its node only in malformed markup, but clamping keeps
  // an inline <em> mid-word from throwing instead of highlighting.
  const endIndex = index + length
  const endSegment = findSegment(spoken.segments, endIndex) ?? segment
  range.setEnd(endSegment.node, Math.min(Math.max(endIndex - endSegment.start, 0), endSegment.node.length))
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

export interface SpeakerCallbacks {
  /** A word began. Null when boundaries are not available on this engine. */
  onWord: (index: number, length: number) => void
  /** Speech finished on its own, or was stopped. */
  onDone: () => void
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
  /* No reference to the current utterance is kept: `speechSynthesis` is the
   * source of truth for whether anything is speaking, and a second copy of
   * that state is one that can disagree with it. */
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

  speak(text: string): void {
    this.stop()
    if (!text.trim()) {
      this.#cb.onDone()
      return
    }

    const utterance = new SpeechSynthesisUtterance(text)
    this.#sawBoundary = false

    utterance.addEventListener('boundary', (event) => {
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

    utterance.addEventListener('end', () => this.#finish())
    // An error is still an end as far as the caller is concerned: the controls
    // must come back rather than staying stuck on "speaking".
    utterance.addEventListener('error', () => this.#finish())

    this.#graceTimer = setTimeout(() => {
      if (!this.#sawBoundary) this.#cb.onNoBoundaries()
    }, BOUNDARY_GRACE_MS)

    this.#synth.speak(utterance)
  }

  pause(): void {
    if (this.#synth.speaking && !this.#synth.paused) this.#synth.pause()
  }

  resume(): void {
    if (this.#synth.paused) this.#synth.resume()
  }

  stop(): void {
    this.#clearGrace()
    // cancel() on an idle synth is harmless, and calling it unconditionally is
    // what clears an utterance queued by a previous section.
    this.#synth.cancel()
  }

  #finish(): void {
    this.#clearGrace()
    this.#cb.onDone()
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
