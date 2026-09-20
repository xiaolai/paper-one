/**
 * Reading aloud.
 *
 * Web Speech, which is what a WebView gives us: no credentials, and the voices
 * the reader already has installed.
 *
 * ⚠️ **THIS SAID "NO NETWORK" AND THAT WAS NOT TRUE OF THE API.** It is true of
 * every voice macOS installs, and the specification allows a voice — INCLUDING
 * THE DEFAULT — to be synthesised on a server; Chrome's default voices are.
 * Paper reads whole sections aloud, so on such an engine that is a book's text
 * leaving the machine. `voiceChoice.ts` never CHOOSES a voice that reports
 * `localService: false`, which is as far as this layer can go: leaving
 * `utterance.voice` unset uses the platform's default, and on a machine whose
 * only voices are remote that default is remote. Refusing to read aloud at all
 * there is a product decision and is recorded as one, not taken quietly here. The work that is not free is
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

import { speechSkip } from './speechSkip'
import {
  blockAncestor,
  frameBoxInHost,
  hostFromBookRect,
  overlaps,
  type HostRect,
} from './coordinates'
import { directionOf } from './direction'
import type { SpokenBox } from './rulerBand'
import { voiceFor } from './voiceChoice'

/** One text node's span within the collected string. */
interface Segment {
  readonly node: Text
  readonly start: number
  readonly end: number
}

export interface SpokenText {
  readonly text: string
  readonly segments: readonly Segment[]
  /**
   * Where each block of prose begins in `text` — a paragraph, a heading, a
   * verse line.
   *
   * ⚠️ **PARAGRAPH NAVIGATION CANNOT BE DERIVED FROM `text`, AND THAT IS WHY
   * THIS EXISTS.** The gap this walk puts between two blocks is a single SPACE,
   * chosen so that the voice does not weld `endBegin` and so that an inline
   * element cannot split a word — see the separator comment below. The
   * consequence is that a paragraph break and a word space are the same
   * character, so "read the next paragraph" has nothing to look for. The block
   * boundaries are known here, at the only moment they are known at all, so
   * they are recorded rather than guessed at later.
   *
   * Ascending, and the first entry is 0 whenever there is any text: a reader
   * stepping back from the first paragraph lands at the start of the section
   * rather than nowhere.
   */
  readonly blocks: readonly number[]
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
      if (tag === 'script' || tag === 'style') {
        return NodeFilter.FILTER_REJECT
      }
      /* WHITESPACE-ONLY NODES ARE ACCEPTED, and the loop below turns them into
       * a separator rather than a segment. They used to be rejected here, and
       * the words on either side fused: `<span>Hello</span> <span>world</span>`
       * is three text nodes in ONE block, so the block separator below never
       * fired and the voice said "Helloworld" — with every boundary offset
       * after it off by the missing space (audit round 1, #500). Accepted
       * before the style checks, because a separator needs no visibility
       * answer and the style walk is the expensive half of this filter. */
      if (!node.textContent?.trim()) return NodeFilter.FILTER_ACCEPT

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
        /* `collapse` is `hidden` for anything that is not a table row, and a
         * collapsed row's text is off the page either way. */
        const visibility = view.getComputedStyle(parent).visibility
        if (visibility === 'hidden' || visibility === 'collapse') {
          return NodeFilter.FILTER_REJECT
        }
        for (let el: Element | null = parent; el; el = el.parentElement) {
          const style = view.getComputedStyle(el)
          /* `content-visibility: hidden` hides like `display: none` but is not
           * inherited into the computed style of descendants, so it is read on
           * the same ancestor walk display needs anyway. */
          if (style.display === 'none' || style.contentVisibility === 'hidden') {
            return NodeFilter.FILTER_REJECT
          }
        }
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })

  const segments: Segment[] = []
  const blocks: number[] = []
  let text = ''
  let previousBlock: Element | null = null
  let node = walker.nextNode()
  while (node) {
    const value = node.textContent ?? ''

    /* A whitespace-only node is a SEPARATOR, not a segment: one space, outside
     * every segment range so an offset landing in it maps to no node, and only
     * when the text does not already end in one — runs of indentation nodes in
     * a pretty-printed chapter must not become runs of pauses. It does not
     * move `previousBlock`, because it separates nothing by itself. */
    if (!value.trim()) {
      if (text.length > 0 && !text.endsWith(' ')) text += ' '
      node = walker.nextNode()
      continue
    }

    /* ⚠️ **HERE AND NOT IN THE FILTER, BECAUSE A FILTER CANNOT SAY WHAT IT LEFT
     * BEHIND.** `speechSkip` answers with three values, and the difference
     * between two of them is audible: a note reference removed with no gap
     * closes `He left.` up against `Then she stayed.`, and a ruby annotation
     * removed WITH a gap splits `漢字` into two words. A `NodeFilter` can only
     * reject, so the node has to reach this loop to be told apart.
     *
     * The separator is the whitespace branch's, character for character, so a
     * skipped marker and a space between blocks leave exactly the same trace and
     * no offset arithmetic changes. */
    const skip = speechSkip(node.parentElement)
    if (skip !== 'read') {
      if (skip === 'gap' && text.length > 0 && !text.endsWith(' ')) text += ' '
      node = walker.nextNode()
      continue
    }

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
    /* READ BEFORE `previousBlock` MOVES, because both the separator below and
       the block index need the same answer and there is only one moment it is
       available. */
    const opensBlock = block !== previousBlock
    /* Not when the text already ends in one: a whitespace node between two
       blocks has already put the separator there, and stacking a second
       shifts every offset after it. */
    if (text.length > 0 && opensBlock && !text.endsWith(' ')) text += ' '
    previousBlock = block

    const start = text.length
    /* AFTER the separator, so a block begins at its own first character rather
       than at the space in front of it — a paragraph step must not land the
       voice on a gap that belongs to no segment.
       `blocks.length === 0` is the guard for a first node whose `blockAncestor`
       is null: `null !== null` is false, so nothing would be recorded and the
       section would have text in no paragraph at all. */
    if (opensBlock || blocks.length === 0) blocks.push(start)
    text += value
    segments.push({ node: node as Text, start, end: start + value.length })
    node = walker.nextNode()
  }
  return { text, segments, blocks }
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
  return { box, place: placeOf(word, page, directionOf(doc)) }
}

/**
 * Why an utterance is over. `ended` is the only one worth continuing from.
 *
 * `taken` is the one that is about ANOTHER utterance: the single engine was
 * handed something else to say, which cancels this one — see `engineHeldBy`.
 * It is neither an ending nor a failure, and it has to be its own word because
 * the two callers want opposite things from it. A reading treats it as an end
 * and stops, visibly, rather than walking on into the next section; the
 * lookup's pronunciation treats it as `idle` rather than drawing "Paper
 * couldn't say that aloud" over a reader who has just pressed Listen.
 */
export type DoneReason = 'ended' | 'empty' | 'error' | 'taken'

/**
 * What the reader has decided about how the book should sound.
 *
 * PASSED PER UTTERANCE, not held on the `Speaker`. A reading walks many
 * sections and a section is one utterance, so a preference read at `speak` time
 * reaches the next section — a reader who changes the voice mid-chapter hears it
 * at the next one rather than after a restart. Holding it on the speaker would
 * mean either a stale copy or a second way to push updates into an object whose
 * whole job is one utterance at a time.
 *
 * Both optional, and absent means *leave the platform's own*: an engine's
 * default voice and rate are what the reader chose in their system settings, and
 * overwriting them with a guess is how an app ends up sounding worse than the
 * thing it replaced.
 */
export interface SpeakPrefs {
  /** Chosen voice per primary language subtag — `{ en: '…Ava', zh: '…Tingting' }`. */
  readonly voices?: Readonly<Record<string, string>>
  /** A multiplier on the engine's own default; 1 is that default. */
  readonly rate?: number
  /**
   * Silence after a sentence and after a paragraph, in milliseconds.
   *
   * ⚠️ **NOT THE ENGINE'S TO HONOUR — `useSpeech` WAITS.** Web Speech has no
   * break, no SSML and no `preUtteranceDelay`, so there is nothing to hand an
   * utterance. They live on `SpeakPrefs` anyway because that is what the reading
   * reads its preferences from, and the native engine WILL take them directly:
   * `AVSpeechUtterance.preUtteranceDelay` and `postUtteranceDelay` exist and
   * default to 0 (measured on macOS 27, 2026-09-20).
   */
  readonly sentenceGapMs?: number
  readonly paragraphGapMs?: number
}

export interface SpeakerCallbacks {
  /**
   * A word began. Called only for boundaries the engine reports — an engine
   * that reports none says so ONCE through `onNoBoundaries` instead.
   */
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
 * The rate range Web Speech defines. Outside it the engine's behaviour is its
 * own business, so a stored value beyond either end is left unset rather than
 * passed on or clamped.
 */
const MIN_ENGINE_RATE = 0.1
const MAX_ENGINE_RATE = 10

/**
 * How long to wait for the first boundary event before concluding the engine
 * does not send them. Generous: the first word can be slow to start on a cold
 * voice, and a false negative costs the highlight for the whole chapter.
 */
const BOUNDARY_GRACE_MS = 2500

/**
 * Which `Speaker` last handed each engine an utterance.
 *
 * ⚠️ **`window.speechSynthesis` IS ONE ENGINE SERVING ONE UTTERANCE, AND THIS
 * MACHINERY IS WHAT MAKES A SECOND SPEAKER SAFE.** There is exactly ONE today —
 * the reading (`useSpeech`). There were two: the lookup popup's pronunciation
 * spoke through the same engine from `systemVoice.ts`, WHICH NO LONGER EXISTS,
 * having gone with the AI features. The comment here described that arrangement
 * in the present tense for long enough to mislead an audit, so what follows is
 * the DEFECT it was built for rather than a roster of callers.
 *
 * `speak` begins with `stop()`, so a second speaker CANCELS the first — and a
 * cancelled utterance still delivers its `end`, late, with the first speaker's
 * own generation still current. Its `#finish` therefore read that end as "the
 * section finished". For a reading that means `continueReading()`: pages walking
 * forward hunting the next section while the reader listens to one word.
 *
 * So whoever speaks last HOLDS the engine, and a speaker that no longer holds it
 * reports `taken` rather than whatever its stale event said. No amount of
 * per-utterance guarding can answer that: the event is indistinguishable from a
 * real ending.
 *
 * PER ENGINE, and a `WeakMap` rather than one module-level holder, for a reason
 * that is about the tests as much as the app: every suite here drives a
 * `FakeSynth` of its own, and one shared holder would have a speaker over one
 * fake stealing the engine from a speaker over another — reporting `taken` for
 * utterances nothing had cancelled. Keyed on the engine, two speakers coordinate
 * exactly when they share one.
 */
const engineHeldBy = new WeakMap<SpeechSynthesis, object>()

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
  /** This speaker's claim on the one engine — see `engineHeldBy`. */
  readonly #token = {}
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
  speak(text: string, lang: string | null, prefs: SpeakPrefs = {}): boolean {
    /* CLAIMED BEFORE THE CANCEL, not after it. `stop()` on the next line is
       what cancels the other speaker's utterance, and an engine free to deliver
       that utterance's `end` SYNCHRONOUSLY from inside `cancel()` would find the
       previous holder still recorded and be told its section had finished. The
       claim is honest either way: an empty text still cancels, so it has still
       taken the engine. */
    engineHeldBy.set(this.#synth, this.#token)
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

    /* THE VOICE, CHOSEN RATHER THAN INHERITED — and this is the whole of the
     * audible change. Left unset, WebKit hands an English book
     * `com.apple.voice.super-compact.en-US.Samantha`, the most compressed voice
     * Apple ships, and a Chinese book whichever voice the system happens to
     * default to. `voiceFor` reads the tier out of `voiceURI` and takes the best
     * one that speaks the document's language — see `voiceChoice.ts` for the
     * measured families and why a novelty voice is excluded rather than ranked
     * last.
     *
     * ⚠️ **NULL IS A REAL ANSWER AND MUST NOT BE ASSIGNED.** `getVoices()` is
     * empty until the engine has loaded its list, and a section that declares no
     * language has no voice to ask for — in both cases the right outcome is the
     * platform's own default, which is what leaving the property alone gives.
     * Assigning `null` is not the same thing on every engine, exactly as
     * `documentLang` records for an empty `lang`. */
    const chosen = voiceFor(this.#synth.getVoices(), lang, prefs.voices ?? {})
    if (chosen) utterance.voice = chosen

    /* The rate is a multiplier on the engine's default, so 1 IS the default and
     * assigning it changes nothing — which is why an absent preference and a
     * preference of 1 may safely take the same branch.
     *
     * ⚠️ **THE BOUNDS ARE THE SPEC'S, AND THIS ONLY CHECKED FOR POSITIVE.** Web
     * Speech defines the range as 0.1 to 10 and leaves anything outside it to
     * the engine — so a hand-edited `0.01` or `100` passed a guard whose comment
     * claimed it stopped unsafe values. Out of range is REFUSED rather than
     * clamped: a reader who typed 100 into a settings file gets the engine's own
     * speed, not a number Paper invented for them. */
    if (
      prefs.rate !== undefined &&
      Number.isFinite(prefs.rate) &&
      prefs.rate >= MIN_ENGINE_RATE &&
      prefs.rate <= MAX_ENGINE_RATE
    ) {
      utterance.rate = prefs.rate
    }

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
    if (this.#synth.speaking && !this.#synth.paused) {
      /* The grace timer measures SPEECH, not wall-clock. Left running, a pause
       * inside the first 2.5 s ran it out over silence and `onNoBoundaries`
       * dropped the follow-along for the whole reading on an engine that
       * reports boundaries perfectly well (audit round 1, #502). Cleared here
       * and re-armed whole on resume — generous twice is still cheap, and a
       * false negative costs the highlight for the chapter. */
      this.#clearGrace()
      this.#synth.pause()
    }
  }

  resume(): void {
    if (!this.#synth.paused) return
    this.#synth.resume()
    if (!this.#sawBoundary) {
      const generation = this.#generation
      this.#graceTimer = setTimeout(() => {
        if (generation !== this.#generation) return
        if (!this.#sawBoundary) this.#cb.onNoBoundaries()
      }, BOUNDARY_GRACE_MS)
    }
  }

  stop(): void {
    this.#clearGrace()
    // Retires the current generation, so the cancelled utterance's late end
    // cannot report itself as the current one finishing.
    this.#generation += 1
    /* ⚠️ **ONLY WHILE THIS SPEAKER HOLDS THE ENGINE, AND IT USED TO BE
     * UNCONDITIONAL** — "cancel() on an idle synth is harmless", which is true
     * of an idle one and false of an engine somebody else is using. With two
     * speakers over one engine (see `engineHeldBy`) an unconditional cancel is a
     * speaker silencing an utterance that is not its own: the lookup popup calls
     * `Voice.stop` on EVERY selection change, so a reader listening to the book
     * who merely opened and dismissed a lookup had the reading cancelled — and
     * the engine still held by the READING, so its `end` came back as `ended`
     * and the pages walked on into the next section.
     *
     * Not holding it means this speaker's own utterance is already gone, so
     * there is nothing of its own left to cancel. `speak` claims the engine
     * BEFORE calling this, which is what keeps a new utterance replacing the old
     * one — including one this speaker queued for a previous section. */
    if (engineHeldBy.get(this.#synth) === this.#token) this.#synth.cancel()
  }

  #finish(generation: number, reason: DoneReason): void {
    if (generation !== this.#generation) return
    /* RETIRED BEFORE THE CALLBACK. An utterance is one ending, but an engine
     * is free to send `error` AND `end` for it — WebKit does on some voices —
     * and both handlers held the same live generation, so `onDone` fired
     * twice and the second one cancelled the continuation the first had
     * started (audit round 1, #503). */
    this.#generation += 1
    this.#clearGrace()
    /* AND WHOSE ENGINE IT IS DECIDES WHAT THIS EVENT MEANT. Another speaker
       having taken it since is exactly what cancelled this utterance, so the
       `end` (or `error`) the engine delivered is not this utterance ending —
       see `engineHeldBy`, and `DoneReason.taken` for what each caller does
       with it. */
    this.#cb.onDone(engineHeldBy.get(this.#synth) === this.#token ? reason : 'taken')
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

/**
 * Whether this build has a speech engine at all — the READING's question.
 *
 * ⚠️ **THE API'S PRESENCE, AND IT IS WEAKER THAN IT LOOKS.** An engine can be
 * present with nothing behind it: WebKitGTK answers this with no
 * speech-dispatcher installed, which is the DEFAULT state on Linux, and then
 * accepts an utterance, raises no error and makes no sound. So a true here is
 * "there is an engine to ask", not "the reader will hear something".
 *
 * ⚠️ **AND THE LOOKUP'S PRONUNCIATION MUST NOT SHARE THIS ANSWER** — this
 * paragraph used to argue that it should, on the ground that one answer cannot
 * be right by accident. That is true and beside the point: the two callers are
 * asking different questions. Reading a chapter in whatever voice the machine
 * has is still reading the chapter; saying one WORD in a voice for the wrong
 * language is a wrong answer the reader cannot check. `Voice.canSay` is the
 * stricter question, and it reads the voice list — which this deliberately does
 * not, because `getVoices()` is empty until the engine has loaded it and an
 * emptiness test here would drop the Listen control for the first moments of
 * every session.
 */
export function speechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}
