import { fromRange } from 'foliate-js/epubcfi.js'
import type { ResolvedCfi } from '../../core/resolvedCfi'

/* Re-exported so the reader's own consumers need not learn where the brand
   lives; `core/resolvedCfi.ts` is the declaration and this is a convenience. */
export type { ResolvedCfi }

/**
 * WI-21.S — the spike. **Route B: anchor a foreign passage in the RENDERED DOM.**
 *
 * ⚠️ **NOTHING IMPORTS THIS.** It is a spike, kept because the plan asks the
 * spike to deliver *"one passage from the corpus, anchored correctly in a
 * different build, in the rendered DOM, with a measured cost — or a written
 * statement of which route failed and why"*. The verdict and the measurement are
 * in `dev-docs/plans/phase-21-implementation.md`; what is here is the code that
 * produced them, so the next reader can re-run it rather than re-argue it.
 *
 * ## Why route B and not the other two
 *
 * **A — fix the fork** is dead twice over. WI-21.P1 already made search and
 * render agree (in Paper, not the fork), which was A's motivation; and A fixes
 * neither of the two things that actually block the search route —
 * `view.search()` is stateful and destructive (it calls `clearSearch()`,
 * replaces one shared draw function and `addAnnotation()`s every candidate), and
 * it is synchronous per section with no signal to cancel.
 *
 * **C — hybrid** inherits both of those, because it still starts from
 * `view.search()`.
 *
 * **B is the only one whose anchor is right by CONSTRUCTION rather than by
 * repair**: the Range is built in the document the reader is looking at, so the
 * CFI derived from it addresses the words it was derived from. That is the whole
 * argument, and it is why the spike only implements B.
 *
 * ## The two things `flatten` could not do, and why they are redone here
 *
 * `flatten` is the existing DOM→text walk, and route B cannot use it:
 *
 *  1. **It is BOUNDED at 20 000 characters** (`DEFAULT_MAX_CHARS`) and *"can be
 *     incomplete while reporting `truncatedEnd === false`"*. A resolver that
 *     gives up two thirds of the way through a chapter silently fails to find
 *     passages that are there — the worst shape, since it is indistinguishable
 *     from "this passage is not in this build".
 *  2. **It normalises for word snapping, not for cross-build matching.** Two
 *     builds of one work differ in typography — curly quotes against straight,
 *     a spaced em-dash against an unspaced one — and those differences are
 *     LENGTH-CHANGING, so a fold that repairs them cannot be a character map.
 *
 * So this walk is unbounded and carries a per-character origin map: for every
 * character of the canonical string, which text node it came from and which
 * source offsets it spans. That map is what makes a length-changing fold
 * survivable, and it is the piece the plan called *"the offset mapping `flatten`
 * cannot do"*.
 *
 * ## The limit route B was supposed to have, and does not
 *
 * ⚠️ **"IT ONLY REACHES RENDERED SECTIONS" IS FALSE, and this header said it
 * until somebody pushed on it.** The reasoning was
 * `renderer.getContents()`-shaped: that is the only way past foliate's closed
 * shadow roots, so a mark in chapter 40 of a book opened at chapter 1 has no
 * document to be anchored in.
 *
 * **Anchoring does not need the live document.** A CFI is a PATH, not a node
 * reference — it is valid in any document with the same structure — and
 * `book.sections[i].createDocument()` parses any section, opened or not.
 * `refuseBookScripts` wraps every one of them, so the script strip is applied
 * there too: that is exactly what WI-21.P1 fixed, and `bookScripts.test.ts`'s
 * *"address the same passage by the same path"* is the assertion. Nothing else
 * mutates the rendered body — `setStyles` writes to the head, the loader sets a
 * `lang` attribute — and neither shifts a child index.
 *
 * Measured: a cold section costs **3.46 ms** end to end (1.70 parse, 1.76
 * index and search) on the corpus's 22 904-character chapter. Forty unopened
 * sections is ~139 ms — a one-off when an archive is imported, not a cost on
 * the reading path.
 *
 * ⚠️ The claim was copied from the plan into this header without being checked,
 * which is the second time in this phase a stated impossibility turned out to
 * be an untested premise. Both times the premise was true of ONE thing and had
 * been generalised: `getContents()` really is the only way to the LIVE document,
 * and `marks.ts` really is unloadable from a `.mjs`.
 */

/** `Node.TEXT_NODE` and `Node.ELEMENT_NODE`, spelled as the numbers they are —
 *  this module is unit-tested in a lane that may have no `Node` global, the
 *  same reason `flatten` spells them out. */
const TEXT_NODE = 3
const ELEMENT_NODE = 1

/** Never rendered, whatever their style says — `flatten`'s own list, and it
 *  must stay identical or the map addresses text the reader cannot see. */
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE'])

/**
 * Elements whose edges are a BREAK IN THE TEXT, not a join.
 *
 * ⚠️ **WITHOUT THIS, `<p>done</p><p>Start</p>` INDEXED AS `doneStart`** — two
 * paragraphs run together into a word that is in neither of them. That is bad
 * twice over: it invents matches that cross a paragraph break, and it loses
 * every real one, because the OTHER side of the comparison has the boundary.
 *
 * The other side is `flatten`, which `markContext` uses to capture a mark's
 * prefix and suffix: it emits `SENTINEL` (`'\n'`) at exactly these edges. So a
 * stored prefix reaching back across a paragraph break carried a separator that
 * this index did not have, and the two could never agree — a silent, total loss
 * of context for any mark near the start of a paragraph. The bug was in the
 * asymmetry, not in either walk alone.
 *
 * ⚠️ **BY TAG NAME, where `flatten` uses computed `display` — and that is a real
 * difference, stated rather than glossed.** `flatten` runs on the RENDERED
 * document and its own note says why tag names alone are not enough: a
 * `<span style="display:block">` is a block and most EPUBs style their own
 * elements. This walk runs on `section.createDocument()`, a parsed document in
 * no browsing context, where `getComputedStyle` has nothing to answer from. Tag
 * names are the only signal that exists here, and they cover every element an
 * ordinary book uses. A book that makes a paragraph out of a styled `<span>`
 * gets the old behaviour for that span, which is what it got everywhere before.
 *
 * `BR` is in the list for the reason `flatten` names it separately: it breaks
 * the line and has no display to read.
 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'CAPTION', 'DD', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD',
  'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
])

/** A passage as an archive carries it — the quote and `markContext`'s 32 either side. */
export interface ForeignPassage {
  readonly quote: string
  readonly prefix: string
  readonly suffix: string
}

export interface Reanchored {
  /** A live range over the rendered document. */
  readonly range: Range
  /**
   * How well the context agreed, 0..1 — NOT a probability, and deliberately
   * not called one. It is the fraction of the surrounding characters that
   * matched, which is a measure of evidence and not of truth.
   */
  readonly confidence: number
  /** How many places in this document the quote occurs at all. */
  readonly occurrences: number
  /**
   * How much of the stored context agreed, 0..1 — INDEPENDENT of how many
   * times the quote occurs, which is the difference from `confidence`.
   *
   * ⚠️ **A WHOLE-BOOK SWEEP NEEDS THIS AND `confidence` CANNOT SERVE.**
   * `confidence` answers 1 for a lone occurrence, deliberately: within ONE
   * document there is nothing to choose between, and refusing for want of
   * context would lose every passage whose surroundings the other build reset.
   * A sweep is choosing between SECTIONS, where a lone occurrence in section 1
   * and a lone occurrence in section 20 are two candidates — and reading both
   * as certainty picks whichever came first.
   *
   * `docs/design/circle/review.md` §"The overlay seam" states the failure:
   * *"wrong context around 'the whale' in section 1, matching context in
   * section 20; a first-hit sweep picks section 1 and reports confidence."*
   *
   * 0 when the passage carries no context at all — which is honest rather than
   * a floor. A mark made at the edge of a section, or before `prefix`/`suffix`
   * existed, has NO evidence to offer, and a sweep that finds it in two places
   * must refuse rather than guess.
   */
  readonly agreement: number
}

/* ------------------------------------------------------- the canonical form */

const QUOTE_FOLD: Readonly<Record<string, string>> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"',
  '–': '—', '‒': '—', '―': '—',
}

/** Dropped outright — a hyphenation point is a fact about the line break. */
const SOFT_HYPHEN = '­'

/**
 * The canonical form of one source character, or `''` to drop it.
 *
 * ONE CHARACTER IN, ZERO OR MORE OUT — the signature is what lets the fold
 * change length while the origin map stays exact. Nothing in the fold set is
 * length-changing at the character level today, and the signature is kept
 * anyway: it is what makes adding one a local change rather than a rewrite of
 * the origin map.
 *
 * ⚠️ **CASE IS NOT FOLDED, AND THIS USED TO FOLD IT (WI-22.A0).** The decision
 * is `phase-21-the-circle.md`'s — *"NFC plus a small explicit fold set — quote
 * variants, dash variants, whitespace, soft hyphen — and no case folding,
 * because case is meaningful in a quote"* — and `.toLowerCase()` on the end of
 * this expression contradicted it in shipped code. `docs/design/circle/review.md`
 * is where that was found, and it is one of the two findings that review
 * verified by running the check rather than by agreeing.
 *
 * The argument FOR folding was a publisher setting a line in small caps. That
 * is a real crossing and it is not this fold's job: small caps are a STYLE, so
 * a build that sets them keeps the source letters and the reader's archive
 * carries the source letters too. What folding actually bought was `'US'`
 * matching `'us'` — a passage about a country anchoring on a pronoun, which is
 * the wrong-sentence failure the whole hard-quote-equality gate exists to
 * refuse. `reanchor`'s gate is exact canonical equality, so every character
 * this drops is evidence the gate no longer has.
 *
 * ⚠️ **NFC IS APPLIED AND WAS NOT, which is the other half of the same decision
 * A0 restored.** `phase-21-the-circle.md` says *"**NFC** plus a small explicit
 * fold set"*; the fold set was here and the normalisation was not. `é` composed
 * (U+00E9) and decomposed (U+0065 U+0301) are the same letter to a reader and
 * two different strings to `indexOf` — and which one a build carries is a
 * decision of whatever tool produced it, so the two spellings genuinely do
 * occur across builds of one work. That is precisely the class this resolver
 * exists to bridge.
 *
 * Per CHARACTER rather than over the whole string, which is what keeps the
 * origin map exact: `String.prototype.normalize` on the joined text could
 * combine a base and a following mark into one unit and silently shift every
 * offset after it. Composing one code point at a time can only ever answer
 * itself or a canonical singleton, and the `for…of` walk that calls this is
 * already per code point.
 *
 * ⚠️ This does NOT compose a base character with a SEPARATE combining mark that
 * follows it — the two arrive as two iterations and stay two. Full NFC would
 * need a look-ahead and a length-changing emit, which the origin map supports
 * (`emit` takes a span) but which no measured corpus case needs. Stated rather
 * than left as an implied guarantee.
 */
const canonicalChar = (ch: string): string =>
  ch === SOFT_HYPHEN ? '' : (QUOTE_FOLD[ch] ?? ch).normalize('NFC')

/**
 * The document as one canonical string, with every character's origin.
 *
 * Three parallel arrays rather than an array of objects: a 500 000-character
 * section is 500 000 allocations the other way, on the main thread, for a
 * structure that is read once and thrown away.
 */
export interface TextIndex {
  readonly text: string
  readonly nodes: readonly Text[]
  /** Which node each canonical character came from. */
  readonly node: Int32Array
  /** The source offsets that character spans, `[from, to)`. */
  readonly from: Int32Array
  readonly to: Int32Array
}

export function indexText(root: Node): TextIndex {
  const nodes: Text[] = []
  const out: string[] = []
  const node: number[] = []
  const from: number[] = []
  const to: number[] = []

  /* Whether the last emitted character was a space, so a run of whitespace
     collapses to one — and so a space touching an em-dash can be dropped,
     which is the whole point of the dash rule below. */
  let pendingSpace = false
  /* Where a pending space came from, so it can be emitted with a true origin
     if it turns out to be kept.
     
     THE SPAN IS CARRIED, not derived as `off..off+1`, because a break between
     two elements has no source character to span: its honest origin is the
     zero-width position just past the last real one. Deriving the end made that
     position `lastOff + 1`, which is one past the node's length — a real
     out-of-range offset that `map to a real source offset` caught. */
  let spaceAt: { readonly at: number; readonly from: number; readonly to: number } | null = null

  /* Where the last real character came from, so a break BETWEEN elements —
     which belongs to no text node — can still be given an honest origin. */
  let lastAt = 0
  let lastOff = 0

  const emit = (chars: string, at: number, start: number, end: number) => {
    for (const ch of chars) {
      out.push(ch)
      node.push(at)
      from.push(start)
      to.push(end)
    }
    lastAt = at
    lastOff = end
  }

  /* A block edge is a break in the text. Held exactly like a whitespace run —
     so it collapses into an adjacent one, is dropped beside an em-dash, and
     never leads the string — which is what keeps it consistent with everything
     else the canonical form does to spacing. */
  const breakHere = () => {
    if (out.length === 0 || pendingSpace) return
    pendingSpace = true
    /* Zero-width: there is no character here, only a boundary. */
    spaceAt = { at: lastAt, from: lastOff, to: lastOff }
  }

  const walk = (current: Node) => {
    if (current.nodeType === ELEMENT_NODE) {
      const tag = (current as Element).tagName.toUpperCase()
      if (SKIPPED_TAGS.has(tag)) return
      const block = BLOCK_TAGS.has(tag)
      if (block) breakHere()
      for (let child = current.firstChild; child; child = child.nextSibling) walk(child)
      /* BOTH EDGES. A closing `</p>` separates it from what follows just as its
         opening separated it from what came before, and only one of the two is
         supplied by the next element's opening tag when that element is inline. */
      if (block) breakHere()
      return
    }
    if (current.nodeType !== TEXT_NODE) return
    const text = current as Text
    const raw = text.data
    if (raw === '') return
    const at = nodes.length
    nodes.push(text)
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!
      if (/\s/u.test(ch)) {
        /* HELD, NOT EMITTED. Whether this space survives depends on what comes
           next: beside an em-dash it is dropped, so that `A — B` and `A—B`
           canonicalise to the same string. This is the length-changing fold
           the origin map exists for. */
        if (!pendingSpace) {
          pendingSpace = true
          spaceAt = { at, from: i, to: i + 1 }
        }
        continue
      }
      const folded = canonicalChar(ch)
      if (folded === '') continue
      if (pendingSpace) {
        const held = spaceAt!
        pendingSpace = false
        spaceAt = null
        /* Dropped beside a dash, and beside the start of the text. */
        const lastEmitted = out[out.length - 1]
        if (out.length > 0 && folded !== '—' && lastEmitted !== '—') {
          emit(' ', held.at, held.from, held.to)
        }
      }
      emit(folded, at, i, i + ch.length)
    }
  }
  walk(root)

  return {
    text: out.join(''),
    nodes,
    node: Int32Array.from(node),
    from: Int32Array.from(from),
    to: Int32Array.from(to),
  }
}

/** A passage's own fields in the same canonical form the index is in. */
export const canonicalise = (text: string): string => indexOfString(text)

/** The canonical form of a bare string — the same rules, with no DOM. */
function indexOfString(text: string): string {
  const out: string[] = []
  let pendingSpace = false
  for (const ch of text) {
    if (/\s/u.test(ch)) {
      pendingSpace = true
      continue
    }
    const folded = canonicalChar(ch)
    if (folded === '') continue
    if (pendingSpace) {
      pendingSpace = false
      const lastEmitted = out[out.length - 1]
      if (out.length > 0 && folded !== '—' && lastEmitted !== '—') out.push(' ')
    }
    out.push(folded)
  }
  return out.join('')
}

/* ------------------------------------------------------------- the resolver */

/** How many characters of context are compared. `markContext` stores 32. */
const CONTEXT = 32

/** How much of the context must agree when the quote occurs more than once. */
const MIN_CONFIDENCE = 0.25

/**
 * How much better the winning occurrence must agree than the runner-up.
 *
 * The twin of `reanchorPass`'s `AMBIGUITY_MARGIN`, and the same number for the
 * same reason: the question — *is there enough evidence to prefer one place
 * over another* — does not change because the two places are in one document
 * rather than two. Kept as separate constants because the modules are separate
 * and neither should reach into the other for a policy; if they ever need to
 * differ, they can.
 */
const MIN_MARGIN = 0.2

/**
 * Where a foreign passage sits in this rendered document, or null.
 *
 * ⚠️ **A HARD CANONICAL QUOTE-EQUALITY GATE COMES FIRST**, which the plan asks
 * Stage 2 to specify: candidates are only ever exact matches of the canonical
 * quote. Context then chooses BETWEEN them; it never rescues a near-miss. A
 * scorer allowed to accept an approximate quote will eventually accept the
 * wrong sentence with high confidence, and a highlight on the wrong sentence is
 * the exact failure this whole phase exists to remove.
 */
export function reanchor(root: Node, passage: ForeignPassage): Reanchored | null {
  const found = reanchorIn(indexText(root), passage)
  return found.kind === 'found' ? found : null
}

/**
 * What one document had to say about a passage.
 *
 * ⚠️ **`'ambiguous'` IS NOT `'absent'`, AND COLLAPSING THEM PLACES MARKS ON THE
 * WRONG WORDS.** This used to answer `Reanchored | null`, with `null` covering
 * both *"the quote is not in this section"* and *"the quote is here several
 * times and the context cannot say which"*. That is fine for a caller looking
 * at ONE document — it may not draw either way — and it is wrong for a sweep.
 *
 * `reanchorPass` gathers a candidate per section and picks between them. Given
 * `null` for an ambiguous section, it sees one candidate from somewhere else,
 * concludes there is nowhere else the passage could be, and places it — on the
 * strength of a section that actually said *"it might well be here."* The
 * evidence pointing AWAY from the answer was thrown away at this boundary.
 */
export type Resolution =
  | ({ readonly kind: 'found' } & Reanchored)
  /** The quote occurs here more than once and the context cannot choose. */
  | { readonly kind: 'ambiguous'; readonly occurrences: number }
  /** The quote does not occur in this document at all. */
  | { readonly kind: 'absent' }

const ABSENT: Resolution = { kind: 'absent' }

/**
 * The same resolution against an index that is ALREADY BUILT — WI-22.A2.
 *
 * ⚠️ **THE WHOLE COST OF A PASS IS IN `indexText`, so a pass must not call it
 * once per mark.** A cold section is 3.46 ms end to end and 1.76 ms of that is
 * the index; `reanchor` rebuilds it every call, which is right for one passage
 * and quadratic-in-spirit for the re-anchoring pass, where every unplaced mark
 * of a book is tried against every section. Five marks over forty sections is
 * 200 index builds for 40 documents.
 *
 * The split is what makes the plan's *"0.24 ms per additional mark"* the real
 * per-mark cost rather than a figure that only holds for one mark. `reanchor`
 * keeps its signature and is now the one-shot wrapper, so nothing that had a
 * document and a passage has to learn about indices.
 */
export function reanchorIn(index: TextIndex, passage: ForeignPassage): Resolution {
  const quote = indexOfString(passage.quote)
  if (quote === '') return ABSENT

  const at: number[] = []
  for (let found = index.text.indexOf(quote); found !== -1; found = index.text.indexOf(quote, found + 1)) {
    at.push(found)
  }
  if (at.length === 0) return ABSENT

  const prefix = indexOfString(passage.prefix)
  const suffix = indexOfString(passage.suffix)
  let best = at[0]!
  let bestScore = -1
  let runnerUp = -1
  for (const start of at) {
    const score = agreement(index.text, start, start + quote.length, prefix, suffix)
    if (score > bestScore) {
      runnerUp = bestScore
      bestScore = score
      best = start
    } else if (score > runnerUp) {
      runnerUp = score
    }
  }
  /* ONE CANDIDATE NEEDS NO CONTEXT. With a single exact occurrence there is
     nothing to choose between, and refusing it for want of context would lose
     every passage whose surroundings the other build happens to have reset. */
  if (at.length > 1) {
    if (bestScore < MIN_CONFIDENCE) return { kind: 'ambiguous', occurrences: at.length }
    /* ⚠️ **A THRESHOLD DOES NOT SAY THE WINNER IS DISTINGUISHABLE, and this
     * used to stop at the threshold.** Two occurrences scoring 0.90 and 0.88
     * both clear `MIN_CONFIDENCE`, and the one that won did so by DOCUMENT
     * ORDER — `>` keeps the earlier on a tie, and a hundredth of a point is a
     * tie in everything but arithmetic. That is a highlight placed on the
     * likelier of two sentences, which is the failure the hard quote-equality
     * gate above exists to refuse.
     *
     * The same rule `reanchorPass.decide` applies BETWEEN sections, applied
     * here between occurrences within one. Both are the same question — is
     * there enough evidence to prefer one place over another — and it was
     * answered in two different ways, one of them by accident. */
    if (bestScore - runnerUp < MIN_MARGIN) return { kind: 'ambiguous', occurrences: at.length }
  }

  const last = best + quote.length - 1
  /* THE DOCUMENT COMES FROM THE MATCHED NODE, not from a root this function no
   * longer has. Same document either way — every node in the index was walked
   * out of one root — and reading it here is what let the index be built by
   * somebody else. A text node always has an `ownerDocument`. */
  const head = index.nodes[index.node[best]!]!
  const doc = head.ownerDocument
  if (!doc) return ABSENT
  const range = doc.createRange()
  range.setStart(head, index.from[best]!)
  range.setEnd(index.nodes[index.node[last]!]!, index.to[last]!)
  return {
    kind: 'found',
    range,
    confidence: at.length > 1 ? bestScore : 1,
    occurrences: at.length,
    /* The raw evidence, kept whatever the occurrence count. `bestScore` is
     * computed over every candidate including a lone one, so this needs no
     * second pass — it was being thrown away. */
    agreement: bestScore < 0 ? 0 : bestScore,
  }
}

/**
 * How much of the context either side agrees, 0..1.
 *
 * Compared OUTWARD from the quote's own edges, because that is where agreement
 * matters: two occurrences of "the whale" are told apart by the words next to
 * them, and a build that reset the paragraph three sentences earlier should not
 * be penalised for it.
 */
function agreement(text: string, start: number, end: number, prefix: string, suffix: string): number {
  /* ⚠️ **THE SPACE AT THE JOINT IS NOT INFORMATION, AND IT COST THE WHOLE
   * SCORE.** The canonicaliser drops whitespace at a string's edges — it holds
   * a pending space and only emits one when a non-space follows — so a stored
   * prefix of `"…said so. Yet "` canonicalises WITHOUT its trailing space,
   * while the haystack keeps that space because a character follows it there.
   * `matchingTail` then compared `' '` against `'t'`, scored ZERO, and the
   * resolver refused a passage whose context agreed perfectly.
   *
   * Measured on the corpus: "the whale" occurrence 2, standard-ebooks →
   * gutenberg. The scorer looked plausible and was returning null for the one
   * case the context exists to decide. Trim the joint on both sides. */
  const before = text.slice(Math.max(0, start - CONTEXT), start).replace(/\s+$/u, '')
  const after = text.slice(end, end + CONTEXT).replace(/^\s+/u, '')
  /* ⚠️ **BOTH SIDES CAPPED AT `CONTEXT`, and only the haystack used to be.**
   * The score is `matched / wanted`, so a passage carrying MORE than 32
   * characters either side had the extra counted in the denominator against a
   * haystack that could never supply it: 40 characters of stored prefix
   * matching perfectly scored 32/40 = 0.8, not 1. `markContext` stores 32
   * today, so nothing in this repository trips it — but an archive from
   * another reader, or a later decision to store more, would silently lose
   * agreement, and `agreement` is now what decides BETWEEN sections. A scorer
   * whose denominator is not reachable is a scorer that cannot answer 1. */
  const wantBefore = prefix.slice(-CONTEXT).replace(/\s+$/u, '')
  const wantAfter = suffix.slice(0, CONTEXT).replace(/^\s+/u, '')
  const wanted = wantBefore.length + wantAfter.length
  if (wanted === 0) return 0
  return (matchingTail(before, wantBefore) + matchingHead(after, wantAfter)) / wanted
}

/** How many characters two strings share, counting back from their ends. */
function matchingTail(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1
  return n
}

/** How many characters two strings share, counting on from their starts. */
function matchingHead(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1
  return n
}

/* ------------------------------------------- the type the painter's door has */

/**
 * ⚠️ **THE BRAND IS DECLARED IN `core/resolvedCfi.ts`, NOT HERE, and it used to
 * be here.** `core/marks.ts` needs to name it — `isPlaced` narrows to it — and
 * naming it from this module made core depend on ui, backwards. That module's
 * header carries the whole argument for the type; this one keeps the MINT,
 * which is the resolver's alone.
 */

/**
 * ⚠️ **THE ONE MINTING SITE IN THE TREE, and the falsifier for A1 is that it
 * stays that way**: `rg 'as ResolvedCfi' src/` must return this line and
 * nothing else. A second cast makes the type decoration.
 *
 * The cast is sound because of the ARGUMENT, not because of the string: a
 * `Range` is a pair of live node references, so holding one IS the evidence
 * that the document it belongs to is here and has the structure the path is
 * about to be derived from. That is precisely the evidence a foreign passage
 * does not have — it arrives as three strings — and it is why the signature
 * takes the range rather than the composed cfi.
 *
 * `fromRange` answers the DOCUMENT-LOCAL half; the spine step is `/6/(2n+2)`
 * for section `n`, and `!` is the indirection between them. Written out here
 * rather than reached for through `view` because the resolver has no `View` —
 * which is also the honest limit of what it proves: the composition is right,
 * and only a real reader can say the section index is.
 */
export const cfiFor = (sectionIndex: number, range: Range): ResolvedCfi =>
  `epubcfi(/6/${2 * (sectionIndex + 1)}!${fromRange(range)})` as ResolvedCfi
