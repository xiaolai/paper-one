import { fromRange } from 'foliate-js/epubcfi.js'

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
 * change length while the origin map stays exact. Case is folded because a
 * publisher may set a line in small caps and a reader's archive will carry it
 * as they saw it; `toLowerCase` can answer more than one character, which is
 * why the caller maps per EMITTED character rather than per source one.
 */
const canonicalChar = (ch: string): string => (ch === SOFT_HYPHEN ? '' : (QUOTE_FOLD[ch] ?? ch).toLowerCase())

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
     if it turns out to be kept. */
  let spaceAt: { readonly at: number; readonly off: number } | null = null

  const emit = (chars: string, at: number, start: number, end: number) => {
    for (const ch of chars) {
      out.push(ch)
      node.push(at)
      from.push(start)
      to.push(end)
    }
  }

  const walk = (current: Node) => {
    if (current.nodeType === ELEMENT_NODE) {
      if (SKIPPED_TAGS.has((current as Element).tagName.toUpperCase())) return
      for (let child = current.firstChild; child; child = child.nextSibling) walk(child)
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
          spaceAt = { at, off: i }
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
          emit(' ', held.at, held.off, held.off + 1)
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
  const quote = indexOfString(passage.quote)
  if (quote === '') return null
  const index = indexText(root)

  const at: number[] = []
  for (let found = index.text.indexOf(quote); found !== -1; found = index.text.indexOf(quote, found + 1)) {
    at.push(found)
  }
  if (at.length === 0) return null

  const prefix = indexOfString(passage.prefix)
  const suffix = indexOfString(passage.suffix)
  let best = at[0]!
  let bestScore = -1
  for (const start of at) {
    const score = agreement(index.text, start, start + quote.length, prefix, suffix)
    if (score > bestScore) {
      bestScore = score
      best = start
    }
  }
  /* ONE CANDIDATE NEEDS NO CONTEXT. With a single exact occurrence there is
     nothing to choose between, and refusing it for want of context would lose
     every passage whose surroundings the other build happens to have reset. */
  if (at.length > 1 && bestScore < MIN_CONFIDENCE) return null

  const last = best + quote.length - 1
  const doc = root.ownerDocument ?? (root as Document)
  const range = doc.createRange()
  range.setStart(index.nodes[index.node[best]!]!, index.from[best]!)
  range.setEnd(index.nodes[index.node[last]!]!, index.to[last]!)
  return { range, confidence: at.length > 1 ? bestScore : 1, occurrences: at.length }
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
  const wantBefore = prefix.replace(/\s+$/u, '')
  const wantAfter = suffix.replace(/^\s+/u, '')
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

/**
 * The CFI for a re-anchored range, as `view.getCFI` would compose it.
 *
 * `fromRange` answers the DOCUMENT-LOCAL half; the spine step is
 * `/6/(2n+2)` for section `n`, and `!` is the indirection between them. Written
 * out here rather than reached for through `view` because the spike has no
 * `View` — which is also the honest limit of what it proves: the composition is
 * right, and only a real reader can say the section index is.
 */
export const cfiFor = (sectionIndex: number, range: Range): string =>
  `epubcfi(/6/${2 * (sectionIndex + 1)}!${fromRange(range)})`
