/**
 * The text of a section, as a reading or anything else reads it.
 *
 * The work that is not free is getting back from an utterance to the words on
 * screen: the highlight needs a Range in the document, so the text is collected
 * with an index that maps any offset back to the text node it came from.
 *
 * The engine that speaks it is `speaker.ts`. They are two modules because the
 * session and the painters read this one and speak nothing: `collectText`,
 * `rangeAt`, `offsetIn` stay in the kernel when read-aloud is a capability.
 */

import type { SpeechSkipPrefs } from '../../core/ports'
import { DEFAULT_SPEECH_SKIP, speechSkip } from './speechSkip'
import {
  blockAncestor,
  frameBoxInHost,
  hostFromBookRect,
  overlaps,
  type HostRect,
} from './coordinates'
import { directionOf } from './direction'
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
export function collectText(doc: Document, skip: SpeechSkipPrefs = DEFAULT_SPEECH_SKIP): SpokenText {
  /* ⚠️ **A DOCUMENT WITH NO `<body>` THREW HERE, AND IT IS A REAL DOCUMENT.**
     `doc.body` is null for an XML document that is not XHTML, and for a
     malformed section whose parse produced no body element — and
     `createTreeWalker(null, …)` throws. The audiobook walks every section, so one
     such section ended an export as a crash rather than as a chapter with no
     text, which `planChapters` already knows how to drop by name. No body is no
     readable text, and that is the answer it gives now. */
  if (!doc.body) return { text: '', segments: [], blocks: [] }
  const view = doc.defaultView
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName.toLowerCase()
      if (tag === 'script' || tag === 'style') {
        return NodeFilter.FILTER_REJECT
      }
      /* Actually hidden, not just hidden-looking by tag name.
       *
       * An EPUB's endnotes are routinely present in the spine item and hidden
       * with CSS or `hidden`, and a popup footnote's body is hidden by
       * definition. Read aloud they arrive as a block of citations in the
       * middle of a sentence, and there is no way for the listener to tell it
       * happened. `aria-hidden` is honoured for the same reason a screen
       * reader honours it: the author has said this text is not part of the
       * reading.
       *
       * ⚠️ **THE TWO HALVES OF THIS SELECTOR BELONG ON OPPOSITE SIDES OF THE
       * WHITESPACE SHORTCUT, AND FOR ONE COMMIT THIS SAID OTHERWISE WHILE THE
       * CODE DID A THIRD THING.** `hidden` removes an element from the page;
       * `aria-hidden="true"` does NOT — it hides from assistive technology while
       * the element still renders. So an `aria-hidden` element's WHITESPACE is a
       * space the reader can see, and rejecting it fuses the words either side.
       *
       * `81f42c2` moved this whole check ahead of the shortcut and, in the same
       * commit, wrote a comment saying the reorder had been "made and then
       * reverted" and that "no test could tell it apart". Neither was true. It
       * shipped, and it is easily told apart — measured on 2026-09-21:
       *
       * | markup | spoken | the page shows |
       * |---|---|---|
       * | `Hello<span aria-hidden="true"> </span>World` | `HelloWorld` (was) | Hello World |
       * | `Hello<span hidden> </span>World` | `HelloWorld` | HelloWorld |
       *
       * So `hidden` is asked HERE, before the shortcut — its whitespace is not on
       * the page — and `aria-hidden` is asked below it, after a whitespace node
       * has already been accepted as the separator it visibly is. That is not a
       * compromise between the two orders; it is the only order in which both
       * rows come out right. `speechSkip.test.ts` holds both.
       */
      if (parent.closest('[hidden]')) return NodeFilter.FILTER_REJECT

      /* WHITESPACE-ONLY NODES ARE ACCEPTED, and the loop below turns them into
       * a separator rather than a segment. They used to be rejected here, and
       * the words on either side fused: `<span>Hello</span> <span>world</span>`
       * is three text nodes in ONE block, so the block separator below never
       * fired and the voice said "Helloworld" — with every boundary offset
       * after it off by the missing space (audit round 1, #500). Accepted
       * before the STYLE checks, because a separator needs no visibility answer
       * and the style walk is the expensive half of this filter.
       *
       * ⚠️ **WHICH LEAVES ONE CASE SPOKEN THAT THE PAGE DOES NOT DRAW, AND IT
       * IS LEFT ON PURPOSE.** A whitespace node inside CSS-hidden markup —
       * `Hello<span style="display:none"> </span>World` — is accepted here, so
       * the voice says "Hello World" over a page showing "HelloWorld" (measured
       * 2026-09-21). Deciding it needs the ancestor `getComputedStyle` walk for
       * every whitespace node, and a pretty-printed chapter has one between
       * nearly every pair of elements: the cost lands on the reading path for
       * every section, to correct a spacer-inside-a-hidden-span pattern that
       * fuses two words on the page in the first place. A hidden BLOCK is the
       * common case, and between blocks the block separator adds a space
       * regardless. `hidden` and `aria-hidden` are decided, cheaply, above and
       * below this line.
       *
       * ⚠️ **AND THIS FILTER IS ORDER-SENSITIVE IN A WAY SPLITTING IT WOULD NOT
       * FIX.** An audit named `collectText` too long and predicted exactly the
       * hidden-whitespace mistake above; the prediction was right, and the
       * mistake was mine. But the order is the substance — whitespace has to be
       * decided BETWEEN the `hidden` and `aria-hidden` checks — and extracting
       * each check into a helper would keep that order in the caller, where it
       * would be just as easy to get wrong. What stops it recurring is a test per
       * row, in `speechSkip.test.ts`, each of which fails if two checks swap. */
      if (!node.textContent?.trim()) return NodeFilter.FILTER_ACCEPT

      /* `aria-hidden` TEXT is not part of the reading — the author has said so,
         and a screen reader honours it for the same reason. Its WHITESPACE was
         accepted just above, because the element renders and the space is on the
         page. See the table above the `[hidden]` check. */
      if (parent.closest('[aria-hidden="true"]')) return NodeFilter.FILTER_REJECT

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
      /* ⚠️ **AND THE SKIP RULES ARE ASKED OF WHITESPACE TOO.** This branch used
       * to `continue` before `speechSkip` ran, so the space inside a ruby
       * annotation became a separator in the middle of the word it annotates —
       * `漢 字` — which is the one thing `silent` exists to prevent.
       *
       * ⚠️ **ONLY `silent` SUPPRESSES IT, AND THE FIRST VERSION OF THIS LINE
       * TESTED FOR `read`.** That fused the words either side of a whitespace-only
       * SKIPPED element: `a<span epub:type="pagebreak"> </span>b` became `ab`,
       * because the element left no gap of its own here and its own `gap` answer
       * is decided on the path below, which a whitespace node never reaches. The
       * three answers mean the same thing in both branches or they mean nothing.
       * Found because a mutation of the first version failed no test. */
      if (speechSkip(node.parentElement, skip) !== 'silent' && text.length > 0 && !text.endsWith(' ')) {
        text += ' '
      }
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
    const say = speechSkip(node.parentElement, skip)
    if (say !== 'read') {
      if (say === 'gap' && text.length > 0 && !text.endsWith(' ')) text += ' '
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

/**
 * Where a place in the DOCUMENT falls in the collected text — the reverse of
 * {@link rangeAt}.
 *
 * ⚠️ **THE DIRECTION THAT HAD NO CALLER UNTIL PHASE 34, AND COULD NOT HAVE
 * ONE.** An utterance used to be a SENTENCE, so an offset somewhere else in the
 * section named a position in no buffer that existed. One buffer for the whole
 * section makes a tap on a word a place the reading can go.
 *
 * `null` for a node this walk never collected — a `<script>`, a hidden note,
 * the text inside an element `collectText` skips. That is the honest answer: the
 * voice is not going to read it, so there is nowhere in the sound to go.
 *
 * ⚠️ **BY NODE IDENTITY AND NOT BY POSITION.** A document has many text nodes
 * with the same content, and `segments` is ordered by the walk rather than
 * searchable by anything the DOM gives a caret. The list is short — one entry
 * per text node the voice reads — and this runs once per tap, not per frame.
 */
export function offsetIn(spoken: SpokenText, node: Node, offset: number): number | null {
  for (const segment of spoken.segments) {
    if (segment.node !== node) continue
    /* CLAMPED to the segment, because a caret may sit one past the last
       character of a node and that position belongs to the next one. */
    const within = Math.min(Math.max(0, offset), segment.end - segment.start)
    return segment.start + within
  }
  return null
}

/**
 * The text node and offset under a point in the book's own document.
 *
 * ⚠️ **TWO SPELLINGS, AND WEBKIT HAS ONLY THE OLDER ONE.** `caretPositionFromPoint`
 * is the standard and `caretRangeFromPoint` is what Safari and this app's WebView
 * answer to; a reader that knew only the standard would find no caret on the one
 * platform the downloaded voices run on at all. Both are optional on the type,
 * so a document with neither answers null rather than throwing.
 */
export function textAtPoint(
  doc: Document,
  x: number,
  y: number,
): { readonly node: Node; readonly offset: number } | null {
  const legacy = (doc as Partial<Document>).caretRangeFromPoint?.bind(doc)
  if (legacy) {
    const range = legacy(x, y)
    return range ? { node: range.startContainer, offset: range.startOffset } : null
  }
  const standard = (
    doc as {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    }
  ).caretPositionFromPoint
  const at = standard?.call(doc, x, y)
  return at ? { node: at.offsetNode, offset: at.offset } : null
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
