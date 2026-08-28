#!/usr/bin/env node
import { UNREADABLE, readMatching } from './lib/zip.mjs'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * `pnpm corpus` — what the library actually contains, so a typography rule can
 * be decided against a number rather than against taste.
 *
 * NOT A GATE. Every other script in here answers a question with an exit code;
 * this one answers a question with a report and always exits 0 when it ran.
 * It is research tooling, and its output is a DATED READING of a library that
 * changes — never an acceptance criterion. A test that asserted "618 books use
 * rem" would fail the next time a book was imported, which is why the suite
 * beside it tests the analysis against fixtures and never the real shelf.
 *
 * WHY IT EXISTS. `spacing.test.ts` says "measured over 400 EPUBs, 32% set
 * paragraph alignment only from a class" — a real measurement, in a comment,
 * that can never be re-run. Several more were made this way and thrown away:
 * that `rem` reaches a third of the shelf, that absolute font sizes reach 1%,
 * that 44 prose declarations sit above the reading grid. Each one turned a
 * design argument into a decision. Making them repeatable is the whole point;
 * the alternative is rediscovering them one book at a time.
 *
 * THREE TRAPS, ALL PAID FOR ONCE ALREADY:
 *
 *  1. `latin1`, never `utf8`, for CSS. Some books are mis-declared or
 *     truncated and a utf8 decode aborts on them. The first version of this
 *     printed `illegal byte sequence` and silently dropped books.
 *  2. THE ARCHIVE READER IS THIS REPOSITORY'S OWN, `lib/zip.mjs`, over
 *     `node:zlib`. It used to be `unzip -p`, whose exit code does not mean what
 *     it looks like — 11 is returned when ANY pattern matched nothing, not when
 *     all of them did, so a book holding only `.xhtml` exits 11 while writing
 *     every one of them to stdout. That cost a silent under-report once. The
 *     reader answers with members instead of a status, so nothing has to be
 *     inferred from an exit code; and it runs on Windows, which `unzip` does
 *     not.
 *  3. A DETECTOR THAT FINDS NOTHING MUST PROVE IT CAN FIND SOMETHING. Asking
 *     the shelf for CJK returned zero three times: twice because the tool
 *     errored into a suppressed stderr, once because macOS `grep` has no `-P`
 *     and matched nothing in text that was visibly Chinese. The answer looked
 *     identical to "no such books" every time. `verifyDetectors` runs first and
 *     throws, so a zero here is a measurement rather than a silence.
 */

/** Where the app keeps books. Overridable, because a corpus is an argument. */
const DEFAULT_LIB = join(homedir(), 'Library/Application Support/one.paper.reader/books')

/** A rule block, roughly: everything up to `{`, then its declarations. */
const RULE = /([^{}]*)\{([^{}]*)\}/g

const declaration = (body, property) => declarations(body, property)[0]

/**
 * EVERY declaration of a property in a rule block, in source order.
 *
 * A block may declare one property more than once — the fallback idiom
 * `font-size: 12px; font-size: 1rem` is exactly that, and so is a stylesheet
 * that appends an override to a rule it already wrote. Reading only the first
 * misses the one that actually applies, and misses an `!important` written on
 * the second: `h1 { font-weight: 300; font-weight: 400 !important }` was read
 * as unmarked and counted as a rule Paper takes.
 */
const declarations = (body, property) =>
  [...body.matchAll(new RegExp(`(?:^|[;{\\s])${property}\\s*:([^;}]*)`, 'gi'))]
    .map((m) => m[1]?.trim())
    .filter((v) => v !== undefined && v !== '')

/**
 * The rightmost compound of a selector — the element the rule actually styles.
 *
 * `.chapter > h1` styles an `h1`; `h1 .small` does not. Paper's house rules are
 * bare element selectors, so "does this book contest Paper's `h1` rule" is a
 * question about the SUBJECT of the book's selector and about nothing to its
 * left. Reading the whole string instead counts `h1 .small { font-weight }` as
 * a heading rule, which it is not.
 */
export function subject(selector) {
  const parts = selector.trim().split(/[\s>+~]+/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/**
 * A selector list, split on the commas that actually separate selectors.
 *
 * NOT `String.split(',')`. A comma inside `:is(h1, h2)`, `:not(a, button)` or
 * an attribute value like `[title="a,b"]` separates nothing, and splitting on
 * it produces two fragments that are each nonsense — one of which can still
 * match a pattern here and be counted. Depth-aware, which is all that is needed
 * for CSS: brackets and parentheses nest, quotes do not.
 */
export function selectorList(text) {
  const out = []
  let depth = 0
  let quote = ''
  let at = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote !== '') {
      if (c === quote && text[i - 1] !== '\\') quote = ''
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '(' || c === '[') depth += 1
    else if (c === ')' || c === ']') depth -= 1
    else if (c === ',' && depth === 0) {
      out.push(text.slice(at, i))
      at = i + 1
    }
  }
  out.push(text.slice(at))
  return out
}

/**
 * The type selector leading a compound, or `''` when it has none.
 *
 * `h1.title` styles an `h1`; `.title` may style anything and this scanner will
 * not guess. That makes every count below a LOWER bound in one direction as
 * well as an upper bound in the other — a book whose whole typography is
 * written against classes contests Paper's rules invisibly here. Both bounds
 * are printed with the table rather than left for a later reader to discover.
 */
export function elementOf(compound) {
  return /^[a-zA-Z][-\w]*/.exec(compound)?.[0] ?? ''
}

/**
 * A selector's specificity as `[ids, classes, types]`, near enough to decide
 * one question: is it above a bare element selector?
 *
 * THE WHOLE POINT OF COMPUTING IT. Paper's house rules are `(0,0,1)` — `h1`,
 * `a`, `blockquote` — and they sit in the appended slot, so they beat any book
 * declaration at `(0,0,1)` or below on source order alone and lose to anything
 * above it. A count of books that declare `font-weight` on a heading is
 * therefore an UPPER BOUND on the books Paper silently overrides, and the plan
 * that first drew that table said so without being able to narrow it. This
 * narrows it: `.chapter h1 { font-weight: 300 }` is `(0,1,1)` and the book
 * still wins.
 *
 * APPROXIMATE IN TWO KNOWN WAYS, both stated rather than hidden. `:not(.x)`
 * is counted as one class, which is what it is, but `:not(#x)` is counted as
 * one class too. And a selector written across several lines inside one
 * comma-separated list is read whole here, unlike the older detectors above,
 * which read the last line only.
 */
export function specificity(selector) {
  /* `:where()` CONTRIBUTES ZERO, by definition, and Paper's own sheet leans on
     that — every gate in `bookCss.ts` is written `:where(:root[style*=…])`
     precisely so it adds nothing. A scan that counted it would rank Paper's own
     rules above the books they are careful not to outrank. */
  const flat = stripWhere(selector)
    .replace(/\s*[>+~]\s*/g, ' ')
    .trim()
  const ids = (flat.match(/#[-\w]+/g) ?? []).length
  const classes = (flat.match(/\.[-\w]+|\[[^\]]*\]|(?<!:):[-\w]+(?:\([^)]*\))?/g) ?? []).length
  const elements = (flat.match(/(?:^|[\s(])[a-zA-Z][-\w]*/g) ?? []).length
  const pseudoElements = (flat.match(/::[-\w]+/g) ?? []).length
  return [ids, classes, elements + pseudoElements]
}

/**
 * `:where(…)` removed, arguments and all, however deeply they nest.
 *
 * NOT `/:where\([^)]*\)/`. That stops at the FIRST `)`, so
 * `:where(:is(.a), #x) h1` loses only `:where(:is(.a)` and leaves `, #x)` —
 * which then counts as an id and ranks the selector above a bare element rule.
 * Paper's own sheet is written entirely in `:where()` gates, so getting this
 * wrong ranks Paper's rules above the books they are careful not to outrank.
 */
export function stripWhere(selector) {
  let out = ''
  for (let i = 0; i < selector.length; i++) {
    if (!/^:where\(/i.test(selector.slice(i))) {
      out += selector[i]
      continue
    }
    let depth = 0
    let j = i + ':where'.length
    for (; j < selector.length; j++) {
      if (selector[j] === '(') depth += 1
      else if (selector[j] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    out += ' '
    i = j
  }
  return out
}

/** True when `selector` outranks a bare element selector such as `h1`. */
export function outranksElement(selector) {
  const [ids, classes, types] = specificity(selector)
  return ids > 0 || classes > 0 || types > 1
}

/**
 * The house rules `bookCss.ts` injects that a book's own stylesheet contests,
 * and the declaration that contests each.
 *
 * PAPER IS ALREADY A UNIFICATION SYSTEM BY ACCIDENT, and this table is how
 * that claim is re-measured rather than retold. Its one sheet is injected into
 * the slot foliate appends AFTER the book's own, so every unmarked house rule
 * in it outranks the book's equal-specificity declaration on source order
 * alone. Nobody chose that; it is a consequence of having one slot.
 *
 * `img { width }` IS NOT IN THIS TABLE, and its absence is the correction that
 * bought the table its name. It was listed as competing with Paper's
 * `max-width: 100%` — but `width` and `max-width` are DIFFERENT PROPERTIES and
 * do not contest each other at all: a book's `width: 400px` and Paper's
 * `max-width: 100%` both apply, and the image comes out at 400px unless the
 * column is narrower. The declaration that genuinely contests Paper's rule is
 * the book's own `max-width`, which is what is counted here.
 */
export const COMPETING = [
  { key: 'aDecoration', label: 'a { text-decoration }', element: /^a$/i, properties: ['text-decoration', 'text-decoration-line'] },
  { key: 'headingMargin', label: 'h1-h6 { margin }', element: /^h[1-6]$/i, properties: ['margin', 'margin-block', 'margin-block-start', 'margin-block-end', 'margin-top', 'margin-bottom'] },
  { key: 'headingWeight', label: 'h1-h6 { font-weight }', element: /^h[1-6]$/i, properties: ['font-weight'] },
  { key: 'quoteMargin', label: 'blockquote { margin }', element: /^blockquote$/i, properties: ['margin', 'margin-inline', 'margin-inline-start', 'margin-inline-end', 'margin-left', 'margin-right'] },
  { key: 'aColour', label: 'a { color }', element: /^a$/i, properties: ['color'] },
  { key: 'mediaMaxWidth', label: 'img/svg/video { max-width }', element: /^(img|svg|video)$/i, properties: ['max-width'] },
  { key: 'bodyAlign', label: 'body { text-align }', element: /^body$/i, properties: ['text-align'] },
  { key: 'headingLineHeight', label: 'h1-h6 { line-height }', element: /^h[1-6]$/i, properties: ['line-height'] },
  { key: 'bodyFamily', label: 'body { font-family }', element: /^body$/i, properties: ['font-family'] },
  { key: 'quoteStyle', label: 'blockquote { font-style }', element: /^blockquote$/i, properties: ['font-style'] },
]

/**
 * Han, kana and hangul.
 *
 * ESCAPES, NOT LITERAL CHARACTERS. Written with the glyphs themselves this
 * file stops parsing — Vite's import analysis rejects it outright — and the
 * failure names an unrelated line. Escapes also mean the pattern cannot be
 * damaged by any tool in the chain that is careless with encodings, which for
 * a detector whose whole job is to be trusted about a zero is the point.
 */
const CJK = /[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g

/**
 * Prove the instruments before trusting a zero from them.
 *
 * THIS IS THE MOST IMPORTANT FUNCTION IN THE FILE, and it is here because the
 * CJK question was answered "none" three times by three broken detectors. A
 * scanner's null result is indistinguishable from a scanner that never ran,
 * and the only defence is a known sample it must find and a known sample it
 * must not.
 */
export function verifyDetectors() {
  const cjk = (text) => text.match(CJK)?.length ?? 0
  /* Two Han, three kana, two hangul. Counted wrong the first time — asserted
     as six — and this function threw on its own sample, which is the cheapest
     possible demonstration that it does what it claims. */
  const sample = '\u4E2D\u6587\u30C6\u30B9\u30C8\uD55C\uAE00'
  if (cjk(sample) !== 7) throw new Error('CJK detector does not detect CJK')
  if (cjk('plain english') !== 0) throw new Error('CJK detector fires on English')
  const probe = analyseCss('p { font-size: 1.5rem } h1 { font-size: 1em }')
  if (!probe.usesRem) throw new Error('CSS analysis does not see rem')
  if (probe.headingSizes.length !== 1) throw new Error('CSS analysis does not see headings')
  /* The competing table gets the same treatment as the CJK detector, and for
     the same reason: a row reading 0 books is indistinguishable from a row
     whose selector pattern never matched anything. One sample it must find,
     one it must rank above a bare element rule, one it must leave alone. */
  const contest = analyseCss('h1 { font-weight: 300 } .chapter h2 { line-height: 2 } h3 em { color: red }')
  if (!contest.competing.headingWeight) throw new Error('competing scan misses a bare heading rule')
  if (contest.competingAbove.headingWeight) throw new Error('competing scan ranks a bare element rule above one')
  if (!contest.competingAbove.headingLineHeight) throw new Error('competing scan misses a class-qualified rule')
  if (contest.competing.aColour) throw new Error('competing scan reads a descendant of a heading as a link rule')
  return true
}

/**
 * Everything one stylesheet has to say about size, as data.
 *
 * PURE, and that is what makes it testable. The IO half below unzips and
 * counts; every judgement lives here and is exercised against fixtures rather
 * than against a shelf that changes between runs.
 */
export function analyseCss(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = {
    usesRem: false,
    usesAbsolute: false,
    usesImportant: false,
    setsBodySize: false,
    setsRootSize: false,
    setsHeadingSize: false,
    setsHeadingLine: false,
    sizesMediaByFont: false,
    remDeclarations: 0,
    absoluteDeclarations: 0,
    headingSizes: [],
    proseRemSizes: [],
    /** Per `COMPETING` key: does this book contest the house rule at all, and
     *  does it do so from a selector Paper's bare element rule cannot beat. */
    competing: {},
    competingAbove: {},
  }
  for (const [, selectorRaw, body = ''] of source.matchAll(RULE)) {
    const selector = selectorRaw.split('\n').pop()?.trim() ?? ''
    /* THE WHOLE SELECTOR, not its last line — see `specificity`. The older
       detectors below read `selector`, and changing them would silently move
       measurements this plan already recorded against the numbers they gave. */
    for (const part of selectorList(selectorRaw)) {
      const compound = subject(part)
      const element = elementOf(compound)
      if (!element) continue
      for (const rule of COMPETING) {
        if (!rule.element.test(element)) continue
        const declared = rule.properties.flatMap((property) => declarations(body, property))
        if (declared.length === 0) continue
        out.competing[rule.key] = true
        /* `!important` BEATS EVERYTHING PAPER HAS, whatever the specificity and
           whatever the source order — so a book that marks its own declaration
           wins outright, and counting it as one Paper takes was simply wrong.
           Paper's house rules are unmarked by construction: that is what the
           `before` tier means, and `bookTiers.test.ts` holds it. */
        const important = declared.some((value) => /!important/i.test(value))
        if (important || outranksElement(part)) out.competingAbove[rule.key] = true
      }
    }
    const size = declaration(body, 'font-size')
    if (size) {
      const value = size.replace(/\s*!important/i, '').trim()
      if (/[0-9](px|pt|pc|in|cm|mm)\b/.test(value)) {
        out.usesAbsolute = true
        out.absoluteDeclarations += 1
      }
      if (/[0-9.]+rem\b/.test(value)) {
        out.usesRem = true
        out.remDeclarations += 1
      }
      if (/!important/i.test(size)) out.usesImportant = true
      if (/^body\b/.test(selector)) out.setsBodySize = true
      if (/^(html|:root)\b/.test(selector)) out.setsRootSize = true
      if (/(^|[\s,>+~])h[1-6]\b/i.test(selector)) {
        out.setsHeadingSize = true
        out.headingSizes.push(value)
      }
      if (/(^|[\s,>+~])(p|li|blockquote|dd)\b/i.test(selector)) {
        const rem = /^([0-9.]+)rem$/.exec(value)
        if (rem) out.proseRemSizes.push(Number(rem[1]))
      }
    }
    if (/(^|[\s,>+~])h[1-6]\b/i.test(selector) && declaration(body, 'line-height')) {
      out.setsHeadingLine = true
    }
    if (/(^|[\s,>+~])(img|image|svg|figure|video)\b/i.test(selector)) {
      for (const property of ['width', 'height', 'max-width', 'max-height']) {
        const v = declaration(body, property)
        if (v && /[0-9.]+(em|rem)\b/.test(v)) out.sizesMediaByFont = true
      }
    }
  }
  return out
}

/** How much CJK a book's text carries. Metadata is not content — see below. */
export function cjkDensity(text) {
  return text.match(CJK)?.length ?? 0
}

/**
 * What `readMembers` returns for an archive it could not read at all.
 *
 * A SENTINEL, not `null`, because `null` already means something precise here —
 * "this archive holds no member matching the pattern", which for CSS is a book
 * whose whole typography is Paper's sheet and is one of this file's headline
 * findings. A corrupt EPUB is a different thing and must not be counted as it.
 *
 * Re-exported rather than redeclared: the distinction is enforced by the reader
 * in `lib/zip.mjs`, and two symbols of the same name would compare unequal.
 */
export { UNREADABLE }

/**
 * ⚠️ **THIS NO LONGER SHELLS OUT TO `unzip`, and the trap it recorded is gone
 * with it.** The note here used to explain that `unzip` returns 11 when ANY
 * pattern matched nothing rather than when all of them did — so a book holding
 * only `.xhtml` files exited 11 while writing every one of them to stdout, and
 * the status was unusable as a test for "did this book have any". That was
 * true, and it cost a silent under-report before it was understood.
 *
 * `readMatching` answers with the members themselves, so there is no status to
 * misread: an empty list means nothing matched, and `UNREADABLE` means the
 * archive would not parse. The three outcomes this scan distinguishes are now
 * three values rather than a value and two exit codes.
 *
 * WHY IT CHANGED. `unzip` does not ship with Windows, so every case here died
 * with `spawnSync ENOENT` the first time that leg ran a test suite, and
 * `pnpm corpus` could not run there at all. `node:zlib` is built in and speaks
 * the only compression an EPUB uses. The replacement was checked against the
 * tool it replaces, byte for byte, on a real book — including the exit-11 case
 * above, where `unzip` wrote 4 433 bytes across four members and reported
 * failure.
 */
function readMembers(epub, patterns, encoding) {
  const members = readMatching(epub, patterns)
  if (members === UNREADABLE) return UNREADABLE
  if (members.length === 0) return null
  const out = Buffer.concat(members).toString(encoding)
  return out ? out : null
}

/** Every book in a library directory, scanned once. */
export function scanLibrary(lib, { limit = Infinity, cjkSampleBytes = 300_000 } = {}) {
  const dirs = readdirSync(lib)
    .filter((d) => d.startsWith('book_'))
    .slice(0, limit)
  const totals = {
    found: dirs.length,
    scanned: 0,
    withoutCss: 0,
    /** Archives `unzip` could not read — see `UNREADABLE`. */
    unreadable: 0,
    withCjk: 0,
    books: {},
    declarations: { rem: 0, absolute: 0 },
    headingSizes: new Map(),
    proseRemSizes: [],
    /** Per `COMPETING` key: books contesting the house rule, and the subset
     *  contesting it from above a bare element selector. */
    competing: {},
    competingAbove: {},
  }
  const count = (key) => {
    totals.books[key] = (totals.books[key] ?? 0) + 1
  }
  for (const dir of dirs) {
    const epub = join(lib, dir, 'content.epub')
    if (!existsSync(epub)) continue
    totals.scanned += 1

    const text = readMembers(epub, ['*.xhtml', '*.html', '*.htm'], 'utf8')
    if (text === UNREADABLE) {
      totals.unreadable += 1
      continue
    }
    if (text && cjkDensity(text.slice(0, cjkSampleBytes)) > 50) totals.withCjk += 1

    /* latin1: a CSS file that will not decode is still a CSS file. */
    const css = readMembers(epub, ['*.css'], 'latin1')
    if (css === UNREADABLE) {
      totals.unreadable += 1
      continue
    }
    if (css === null) {
      totals.withoutCss += 1
      continue
    }
    const seen = analyseCss(css)
    if (seen.usesRem) count('rem')
    if (seen.usesAbsolute) count('absolute')
    if (seen.usesImportant) count('important')
    if (seen.setsBodySize) count('bodySize')
    if (seen.setsRootSize) count('rootSize')
    if (seen.setsHeadingSize) count('headingSize')
    if (seen.setsHeadingLine) count('headingLine')
    if (seen.sizesMediaByFont) count('mediaFontUnit')
    totals.declarations.rem += seen.remDeclarations
    totals.declarations.absolute += seen.absoluteDeclarations
    for (const rule of COMPETING) {
      if (seen.competing[rule.key]) {
        totals.competing[rule.key] = (totals.competing[rule.key] ?? 0) + 1
      }
      if (seen.competingAbove[rule.key]) {
        totals.competingAbove[rule.key] = (totals.competingAbove[rule.key] ?? 0) + 1
      }
    }
    for (const v of seen.headingSizes) {
      totals.headingSizes.set(v, (totals.headingSizes.get(v) ?? 0) + 1)
    }
    totals.proseRemSizes.push(...seen.proseRemSizes)
  }
  return totals
}

/** The report, as text a person reads or JSON a person diffs. */
export function report(totals, { json = false, at } = {}) {
  const withCss = totals.scanned - totals.withoutCss - totals.unreadable
  const top = [...totals.headingSizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
  if (json) {
    return JSON.stringify(
      { at, ...totals, headingSizes: Object.fromEntries(top), withCss },
      null,
      2,
    )
  }
  const pct = (n) => (withCss ? `${((n / withCss) * 100).toFixed(1)}%` : '—')
  const row = (label, key, decl) =>
    `${label.padEnd(28)} ${String(totals.books[key] ?? 0).padStart(5)}  ${pct(totals.books[key] ?? 0).padStart(7)}  ${decl ?? ''}`
  const lines = [
    ``,
    `Read ${at} — a dated reading, not an acceptance criterion.`,
    ``,
    `${totals.scanned} books scanned of ${totals.found} found.`,
    `${withCss} ship CSS; ${totals.withoutCss} ship none and render on Paper's sheet alone.`,
    /* PRINTED EVEN AT ZERO, because the number's job is to be looked at. Folded
       into "no CSS" — which is where these used to go — a shelf of damaged
       archives reads as a shelf Paper styles entirely. */
    `${totals.unreadable} could not be read at all, and are counted in neither.`,
    `${totals.withCjk} carry substantial CJK text.`,
    ``,
    `                              books        %  declarations`,
    row('rem font-size', 'rem', totals.declarations.rem),
    row('absolute px/pt font-size', 'absolute', totals.declarations.absolute),
    row('!important on font-size', 'important'),
    row('body font-size rule', 'bodySize'),
    row('html/:root font-size rule', 'rootSize'),
    row('heading font-size rule', 'headingSize'),
    row('heading line-height rule', 'headingLine'),
    row('media sized in em/rem', 'mediaFontUnit'),
    ``,
    `heading font-size, most declared values:`,
    ...top.map(([value, n]) => `  ${String(n).padStart(6)}  ${value}`),
    ``,
    /* THE TABLE'S NAME IS ITS MOST IMPORTANT COLUMN. An earlier version of it
       was headed "Paper silently wins", which is a claim about what RENDERS —
       and this instrument reads declarations, which is a different thing.
       Phase 13 was deleted for exactly that substitution. What is certain is
       the MECHANISM and its scale; the `above` column is how much of the
       upper bound the scan can honestly take back. */
    `books containing potentially competing declarations:`,
    ``,
    `  Paper's house rule is contested by      books        %   book wins >=1     %`,
    ...COMPETING.map((rule) => {
      const all = totals.competing[rule.key] ?? 0
      const above = totals.competingAbove[rule.key] ?? 0
      return `  ${rule.label.padEnd(36)} ${String(all).padStart(5)}  ${pct(all).padStart(7)}  ${String(above).padStart(11)}  ${pct(above).padStart(6)}`
    }),
    ``,
    `  "book wins >=1" counts books declaring the property at least once in a`,
    `  way Paper cannot beat: from a selector that outranks its bare element`,
    `  rule — a class, an id, a second element — or with !important, which beats`,
    `  everything Paper has, since its house rules are unmarked by construction.`,
    ``,
    `  READ THE TWO COLUMNS AS BOUNDS, NEVER SUBTRACT THEM FOR A COUNT. The`,
    `  first is the upper bound on books Paper silently overrides. The`,
    `  difference is a NARROWER bound, not a count: books whose every competing`,
    `  declaration is bare and unmarked, so Paper takes each one it MATCHES on`,
    `  source order. A book in the second column may still lose its others, and`,
    `  a bare rule that matches no element in its own book is overridden in the`,
    `  cascade and changes nothing on the page.`,
    ``,
    `  BOUNDED IN BOTH DIRECTIONS, and neither bound is tight. It over-counts`,
    `  because a declaration is not a rendered pixel: a rule may match nothing`,
    `  in the book that ships it. It under-counts because a book whose whole`,
    `  typography is written against classes — .chapter-title rather than h1 —`,
    `  contests the same house rules invisibly here.`,
  ]
  const overGrid = totals.proseRemSizes.filter((v) => v >= 1.4)
  lines.push(``, `prose sized in rem at >= 1.4rem: ${overGrid.length} declarations`)
  return lines.join('\n')
}

/* The CLI. Nothing above this line reads a flag or prints. */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const argv = process.argv.slice(2)
  /**
   * A flag's value, and a flag written without one is an ERROR.
   *
   * `--limit` with nothing after it read as `undefined`, became `NaN` through
   * `Number`, and `slice(0, NaN)` is the empty array — so the run scanned zero
   * books, printed a clean report of zero, and exited 0. A silent zero is the
   * exact failure `verifyDetectors` exists to prevent, arriving through the
   * argument parser instead of through a detector.
   */
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    if (i < 0) return fallback
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      console.error(`scan-corpus: --${name} needs a value`)
      process.exit(2)
    }
    return value
  }
  /** A non-negative integer, or the whole shelf. See `flag` for the zero. */
  const limitFlag = () => {
    const raw = flag('limit', null)
    if (raw === null) return Infinity
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0) {
      console.error(`scan-corpus: --limit must be a non-negative integer, not ${JSON.stringify(raw)}`)
      process.exit(2)
    }
    return n
  }
  const lib = flag('lib', process.env.PAPER_LIBRARY ?? DEFAULT_LIB)
  if (!existsSync(lib)) {
    console.error(`scan-corpus: no library at ${lib} — pass --lib <path> or set PAPER_LIBRARY`)
    process.exit(2)
  }
  verifyDetectors()
  const totals = scanLibrary(lib, { limit: limitFlag() })
  console.log(
    report(totals, {
      json: argv.includes('--json'),
      /* Stamped by the caller, never by the report: a dated reading has to
         carry its date or it will be quoted years later as a current fact. */
      at: flag('at', new Date().toISOString().slice(0, 10)),
    }),
  )
}
