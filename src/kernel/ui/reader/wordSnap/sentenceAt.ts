/**
 * The sentence a live selection actually sits in.
 *
 * The DOM half of §16; `sentenceOf.ts` is the pure half and holds the
 * segmentation policy. Here beside `flatten` and `markContext` because all
 * three walk the same tree and must agree about where its blocks are — the
 * argument `walkRoot`'s header already makes, and the reason `markContext`
 * lives in a directory named for word snapping too.
 *
 * ## What it replaces, and why the old answer was wrong
 *
 * `useGloss.sentenceAround` reads `SelectionSnapshot.prefix`/`.suffix`, which
 * are `markContext`'s 32 characters a side. That field is not buggy: its job is
 * re-anchoring — the W3C Web Annotation prefix/suffix pair, stored on every
 * mark and carried in the sync feed, where 32 is *"enough to disambiguate,
 * short enough to store"*. **The defect is the reuse: a budget sized for
 * storage was spent as a budget for meaning.** Measured on one ordinary
 * sentence, the model was handed 70 characters out of 183, beginning
 * `"en the bait"` — cut out of the middle of `taken`.
 *
 * So the stored field does not move (§E2) and the fix goes at the reuse site.
 *
 * ## Why `flatten`, not `passages.ts`
 *
 * `passages.ts` walks `querySelectorAll('p, li, blockquote, h1…')`, and this
 * codebase already knows why a tag list is wrong: most EPUBs style their own
 * elements, so `<span style="display:block">` is missed, `<br>` welds verse
 * together, `td`/`th` are absent, and pdf.js spans match nothing at all.
 * `flatten` answers by computed `display` instead, and had to.
 *
 * What `flatten` gives is a CSS run, not a paragraph, and two of its properties
 * are not what a sentence needs:
 *
 * - **`truncatedStart`/`truncatedEnd` are word-safety flags, not
 *   block-completeness.** `flatten.test.ts` reports `truncatedEnd === false`
 *   while returning a budget-truncated window, because the cut happened to land
 *   on a space. Nothing here reads them; §C1's rule in `sentenceOf` depends on
 *   no `flatten` flag at all.
 * - **Out-of-flow content merges in reflowable books too**, not only in PDFs:
 *   `isBlockLevel` returns false for `position: absolute|fixed`
 *   unconditionally, so a positioned sidenote, running head or drop-folio joins
 *   the prose with no sentinel between them. Handled below rather than assumed
 *   away.
 *
 * ## What is in the run but not in the sentence
 *
 * One filter, one pass: an entry is kept iff it shares the term's text context.
 * Three ways to fail it, and the SEPARATOR differs by which, because the two
 * shapes are genuinely different:
 *
 * - **Ruby.** `isBlockLevel` is false for `display: ruby*`, so `<rt>` text is
 *   interleaved: `<ruby>漢字<rt>かんじ</rt></ruby>` flattens to `漢字かんじ`.
 *   Per-character ruby — `<ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby>` — puts the
 *   annotation INSIDE the term, so "never filter the entry the term is in" is
 *   unsound and the term itself has to be normalised. That is why this returns
 *   `{ sentence, term }` rather than a string: the caller must send the term the
 *   sentence actually contains. A ruby annotation is spliced *within* a word, so
 *   removing it leaves NOTHING behind — `漢 字` would be a term the book does not
 *   contain.
 * - **Footnote reference markers.** `<sup><a epub:type="noteref">3</a></sup>` is
 *   inline, so the sentence reads `…the whale.3 Then he…`. Filtered by
 *   `epub:type~="noteref"` and `role="doc-noteref"` — **never `<sup>` by tag**,
 *   which would corrupt `x²`, ordinals and maths. Removing one leaves a SPACE:
 *   `He left.<a epub:type="noteref"> 1 </a>Then she stayed.` closed up to
 *   `He left.Then she stayed.` is ONE segment to ICU, measured.
 * - **Out-of-flow content.** Kept only when its nearest positioned ancestor is
 *   the term's. Spliced *between* words, so a space, for the same reason.
 *
 * ## It never throws, and it declines rather than guesses
 *
 * `null` means "could not, or could not establish that it did", and every
 * caller falls back to what shipped before this existed. That is the
 * no-regression rule: the worst outcome of this module is exactly today's
 * behaviour. `Diagnostics` counts which reason, because a build where every
 * lookup silently falls back looks identical to a working one (§F4) — the
 * reason is a closed enum word and never the sentence, the term, or any book
 * text.
 */

import { flatten, walkRoot, type DomPosition, type FlatNode } from './flatten'
import { connectedRange } from './rangeText'
import { resolveSegmenterLocale } from './classify'
import { sentenceOf, type SentenceGap, type SentenceResult } from './sentenceOf'
import { ariaRoles, declaredLang, epubTypes } from '../epubSemantics'
import type { Diagnostics } from '../../../core/ports'

/* `Node.TEXT_NODE` / `Node.ELEMENT_NODE`, spelled as the numbers they are:
 * there is no `Node` global in the unit lane, and naming one would throw on
 * import — the same reason `flatten` spells them out. */
const TEXT_NODE = 3
const ELEMENT_NODE = 1

/**
 * How much text one sentence may be found in.
 *
 * A BUDGET, not a bound, and not guaranteed coverage. `flatten` never splits a
 * single text node, so a 5 000-character anchor node comes back whole and the
 * window exceeds this. Conversely its per-node test is all-or-nothing, so a
 * 1 001-character node immediately before the term contributes NOTHING to the
 * quarter-budget behind it and the sentence loses its head. Both shapes have a
 * row in `flatten.test.ts`; §C1's rule is what keeps the second one safe rather
 * than silent.
 */
export const DEFAULT_SENTENCE_WINDOW = 4_000

/** The sentence, and the term as that sentence actually spells it. */
export interface Sentence {
  readonly sentence: string
  readonly term: string
}

export interface SentenceAtOptions {
  /** The flattener's budget. See `DEFAULT_SENTENCE_WINDOW`. */
  readonly maxChars?: number | undefined
  /** Overrides discovery. For a test and for the corpus, not for the app. */
  readonly locale?: string | undefined
  readonly maxSentenceChars?: number | undefined
  /** Counts whether this path fires at all — see §F4. */
  readonly diagnostics?: Diagnostics | undefined
}

/** Why an entry is not part of the term's sentence. */
type Drop = 'ruby' | 'noteref' | 'out-of-flow'

/** What the walk needs to know about one element, computed once. */
interface ElementFacts {
  /** A ruby annotation: its text is a reading, not the words being read. */
  readonly rubyAnnotation: boolean
  readonly noteref: boolean
  readonly outOfFlow: boolean
}

interface Context {
  readonly ruby: boolean
  readonly noteref: boolean
  /** The nearest `position: absolute|fixed` ancestor, or null for in-flow. */
  readonly positioned: Element | null
}

interface View {
  getComputedStyle(target: Element): CSSStyleDeclaration
}

/**
 * The sentence around `range`, or `null` when none can be vouched for.
 *
 * Total: every failure — an unreadable document, a stale range, a selection
 * across two blocks, a run with no interior sentence boundary — arrives as the
 * same one answer, because the caller's response to all of them is identical.
 */
export function sentenceAt(range: Range, options: SentenceAtOptions = {}): Sentence | null {
  let result: SentenceResult
  let cause: string | null = null
  try {
    result = extract(range, options)
  } catch (thrown) {
    /* §E6. This runs on the selection path, and a throw there would lose the
     * reader's lookup over a metadata typo or a document torn down mid-walk. */
    result = { ok: false, gap: 'threw' }
    cause = causeOf(thrown)
  }
  /* THE OBSERVER MUST NOT BE ABLE TO STOP THE THING IT OBSERVES. `Diagnostics`
   * carries no no-throw contract — the default writes nothing, but a sink the
   * composition root chose is ordinary code — and this call sits OUTSIDE the
   * try above, so a throwing sink took the reader's lookup down with it. §E6
   * is about the selection path, and a counter is part of that path. */
  try {
    record(options.diagnostics, result, cause)
  } catch {
    /* Nothing to report it to: the thing that would report it is what threw. */
  }
  return result.ok ? { sentence: result.sentence, term: result.term } : null
}

/**
 * What threw, as a TYPE and never as a value.
 *
 * ⚠️ **The thrown value is not forwarded, and the first version of this did.**
 * `redact` reduces an `Error` to its class name — but `throw 'a line of the
 * book'` is a string, and a string under a key the redactor does not know
 * passes through it unchanged. So the reduction happens HERE, where the value
 * is, rather than being delegated to a sink that may not be the redacting one.
 * §F4's rule is never the sentence, the term, or any book text, and a rule that
 * holds only for the values somebody remembered is not the rule.
 *
 * `typeof` for anything that is not an Error: one word, from a closed set the
 * language defines. Nothing a caller can influence rides out on it.
 */
function causeOf(thrown: unknown): string {
  if (!(thrown instanceof Error)) return typeof thrown
  /* The same shape `redact` insists on: `name` is an ordinary mutable
   * property, so a caller-set sentence could ride out on it otherwise. */
  return /^[A-Za-z][A-Za-z0-9]{0,40}(Error|Exception)$/.test(thrown.name) ? thrown.name : 'Error'
}

/**
 * Whether the sentence path fires at all.
 *
 * ONE event with an outcome rather than two events, so the ratio is readable
 * without joining two counts — a build where every lookup falls back and one
 * where the feature works are otherwise indistinguishable from the outside,
 * which is the failure §C exists to prevent, one level up.
 */
function record(
  diagnostics: Diagnostics | undefined,
  result: SentenceResult,
  cause: string | null,
): void {
  if (!diagnostics) return
  if (result.ok) {
    diagnostics.info('gloss.sentence', { outcome: 'used' })
    return
  }
  if (cause !== null) {
    /* A THROW IS NOT ONE FACT. Every programming error, every document torn
     * down mid-walk and every future regression arrives as the same `threw`
     * count, and a build where the extractor is simply broken then looks
     * exactly like one where books are merely awkward — which is the failure
     * this whole section exists to prevent, one level in.
     *
     * `error`, not `info`, because nothing here should ever throw.
     *
     * The flag is `cause !== null` and NOT `cause !== undefined`: `throw
     * undefined` is legal JavaScript, and reading absence off the value itself
     * filed that throw as an ordinary fallback with nothing to say about it. */
    diagnostics.error('gloss.sentence', { outcome: 'fallback', gap: result.gap, cause })
    return
  }
  diagnostics.info('gloss.sentence', { outcome: 'fallback', gap: result.gap })
}

function gap(reason: SentenceGap): SentenceResult {
  return { ok: false, gap: reason }
}

function extract(range: Range, options: SentenceAtOptions): SentenceResult {
  const startNode = range.startContainer
  const endNode = range.endContainer
  if (startNode.nodeType !== TEXT_NODE || endNode.nodeType !== TEXT_NODE) return gap('not-text')
  /* §E5. A snapshot's range may have been re-rendered since the reader made
   * it — on a PDF that is what a zoom does — and walking detached nodes would
   * describe a page that no longer exists. */
  if (!connectedRange(range)) return gap('detached')

  const root = walkRoot(startNode)
  if (!root) return gap('no-tree')
  const view = root.ownerDocument?.defaultView
  /* No view means no computed styles, so out-of-flow content cannot be told
   * from prose. `flatten` fails closed on the same condition; this does too
   * rather than guessing from tag names. */
  if (!view) return gap('no-window')

  const from: DomPosition = { node: startNode as Text, offset: range.startOffset }
  const to: DomPosition = { node: endNode as Text, offset: range.endOffset }
  const flat = flatten(root, {
    maxChars: options.maxChars ?? DEFAULT_SENTENCE_WINDOW,
    anchors: [from, to],
  })

  const first = flat.toFlat(from.node, from.offset)
  if (!first) return gap('no-window')
  const last = flat.toFlat(to.node, to.offset)
  /* The end anchor is outside the window entirely, so nothing here can say
   * where the selection stops (§A3). Must not throw. */
  if (!last) return gap('span-blocks')

  /* §A1. A sentinel is an entry with NO node row behind it — never a string
   * match on its character. `<div><p>first</p>\n<p>second</p></div>` puts a
   * REAL text node holding exactly `'\n'` between the two paragraphs, and the
   * two tests disagree about it: by value that node is a boundary, by absence
   * it is the ordinary text it is. `rangeText` already uses the structural
   * test; splitting a paragraph at its own indentation would be silent,
   * because the fragment is still well-formed. */
  const rows = new Map<number, FlatNode>()
  for (const row of flat.nodes) rows.set(row.index, row)

  let runStart = first.index
  let runEnd = first.index
  while (rows.has(runStart - 1)) runStart -= 1
  while (rows.has(runEnd + 1)) runEnd += 1
  if (last.index < runStart || last.index > runEnd) return gap('span-blocks')

  const facts = new Map<Element, ElementFacts>()
  const startRow = rows.get(first.index)
  if (!startRow) return gap('no-window')
  const term = contextOf(startRow.node, root, view, facts)

  let raw = ''
  let termStart = -1
  let termEnd = -1
  /* The node the locale is read from. NOT `startRow.node` unconditionally: an
   * entry this pass filters out is text the run no longer contains, and taking
   * a language from it would segment the sentence under metadata belonging to
   * something that is not in it. The first KEPT entry at or after the term's
   * start is the nearest node that survived. */
  let localeNode: Text | null = null
  for (let index = runStart; index <= runEnd; index += 1) {
    const row = rows.get(index)
    if (!row) continue
    const drop = dropReason(contextOf(row.node, root, view, facts), term)
    /* §A3 AGAIN, in the shape §B3 makes possible. A term whose two ends sit in
     * different positioned boxes is a term spanning two visual contexts, and
     * one of its ends is about to be filtered away — so what would come back
     * is part of what the reader selected, silently. Ruby and noteref drops are
     * NOT this: those are annotation spliced inside one context, and dropping
     * them is the whole point of §B1. */
    if ((index === first.index || index === last.index) && drop === 'out-of-flow') {
      return gap('span-blocks')
    }
    /* Recorded BEFORE the entry is appended, and against the separator's own
     * position when the entry is dropped — a term whose first character is a
     * ruby base sitting after a filtered reading starts where that reading
     * used to be, which is where the next kept character lands. */
    if (index === first.index) termStart = raw.length + (drop ? 0 : first.offset)
    if (index === last.index) termEnd = raw.length + (drop ? 0 : last.offset)
    if (!drop && localeNode === null && index >= first.index) localeNode = row.node
    raw += drop ? separatorFor(drop) : (flat.strs[index] ?? '')
  }
  if (termStart < 0 || termEnd < 0) return gap('span-blocks')

  return sentenceOf(raw, termStart, termEnd, {
    locale: options.locale ?? localeFor(localeNode ?? startRow.node, root),
    maxSentenceChars: options.maxSentenceChars,
  })
}

/**
 * What a filtered entry leaves behind.
 *
 * NOT one answer for all three. A ruby annotation is spliced *inside* a word,
 * so a space there invents one the book does not have and the term stops
 * occurring in its own sentence. A noteref or an out-of-flow box is spliced
 * *between* words, and closing the gap welds two sentences into one that ICU
 * then reports — measured — as a single segment.
 */
function separatorFor(drop: Drop): string {
  return drop === 'ruby' ? '' : ' '
}

function dropReason(entry: Context, term: Context): Drop | null {
  if (entry.ruby) return 'ruby'
  if (entry.noteref) return 'noteref'
  if (entry.positioned !== term.positioned) return 'out-of-flow'
  return null
}

/** The text context an entry sits in, read once per element on the way up. */
function contextOf(
  node: Text,
  root: Element,
  view: View,
  facts: Map<Element, ElementFacts>,
): Context {
  let ruby = false
  let noteref = false
  let positioned: Element | null = null
  let cur: Node | null = node.parentNode
  while (cur && cur.nodeType === ELEMENT_NODE) {
    const el = cur as Element
    const known = factsOf(el, view, facts)
    if (known.rubyAnnotation) ruby = true
    if (known.noteref) noteref = true
    if (known.outOfFlow && positioned === null) positioned = el
    if (el === root) break
    cur = el.parentNode
  }
  return { ruby, noteref, positioned }
}

function factsOf(el: Element, view: View, facts: Map<Element, ElementFacts>): ElementFacts {
  const cached = facts.get(el)
  if (cached) return cached
  const tag = el.tagName.toUpperCase()
  const style = view.getComputedStyle(el)
  const position = style.position
  const known: ElementFacts = {
    /* BY SHAPE AND BY NAME, which is the same pair `flatten` uses for a block
     * — and for the same reason, met from the other side. `<rp>` is the
     * parenthesis a browser without ruby support shows around the reading, so
     * both tags are the annotation and neither is the text; but CSS lets any
     * element be a ruby annotation box, and `isBlockLevel` already reads
     * `display.startsWith('ruby')` rather than trusting the tag. A tag list
     * alone here would be the near-miss this directory argues against
     * everywhere else, in the file that argues it. */
    rubyAnnotation:
      tag === 'RT' || tag === 'RP' || (style.display ?? '').startsWith('ruby-text'),
    noteref: epubTypes(el).has('noteref') || ariaRoles(el).has('doc-noteref'),
    outOfFlow: position === 'absolute' || position === 'fixed',
  }
  facts.set(el, known)
  return known
}

/**
 * The locale for a live range, for a caller that is not doing the walk.
 *
 * `sentenceAround` — the fallback — needs the same locale this module resolves,
 * and needs it without flattening anything: it is answering from
 * `markContext`'s stored window, not from the document. This is the ancestor
 * climb alone, which is cheap and is on the GESTURE like everything else here.
 *
 * TOTAL, and `undefined` is a real answer meaning "use the host's". A locale is
 * a nicety on this path — ICU segments `。` the same under every locale
 * tag, measured, so a Chinese PDF stamped `lang="en"` by `makePdf` still splits
 * correctly — and losing the reader's lookup to a torn-down document while
 * fetching a nicety would be the §E6 mistake in a new place.
 */
export function localeAt(range: Range): string | undefined {
  try {
    const node = range.startContainer
    if (node.nodeType !== TEXT_NODE) return undefined
    const root = walkRoot(node)
    return root ? localeFor(node as Text, root) : undefined
  } catch {
    return undefined
  }
}

/**
 * The locale to segment in: the nearest ancestor `lang`, else the host's.
 *
 * What `:lang()` does, and the only rule that survives a mixed-language book —
 * an English reader with `<span lang="fr">` around the passage, or a Chinese
 * book carrying English quotations. `walkRoot` climbs to the topmost element of
 * the tree, which in a book's document is `<html>`, so the document's own
 * declaration is the last rung of this climb rather than a separate branch.
 *
 * A tag that cannot drive a `Segmenter` is TRANSPARENT rather than final:
 * `resolveSegmenterLocale` is total by design — EPUBs ship `lang="en_US"`, and
 * a throw on the selection path would lose the reader's lookup over a metadata
 * typo — and a malformed tag on one span should not discard the book's own.
 */
function localeFor(node: Text, root: Element): string | undefined {
  let cur: Node | null = node.parentNode
  while (cur && cur.nodeType === ELEMENT_NODE) {
    const el = cur as Element
    const resolved = resolveSegmenterLocale(declaredLang(el))
    if (resolved !== undefined) return resolved
    if (el === root) break
    cur = el.parentNode
  }
  return undefined
}
