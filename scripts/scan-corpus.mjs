#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
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
 *  2. `unzip -p` EXITS NON-ZERO WHEN A PATTERN MATCHES NOTHING. The first full
 *     run reported "129 unreadable"; every one of them was a book with no
 *     stylesheet, dropped before it could be counted. A book with no CSS is a
 *     finding — Paper's sheet is its whole typography — not an error.
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

const declaration = (body, property) =>
  new RegExp(`(^|[;{\\s])${property}\\s*:([^;}]*)`, 'i').exec(body)?.[2]?.trim()

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
  }
  for (const [, selectorRaw, body = ''] of source.matchAll(RULE)) {
    const selector = selectorRaw.split('\n').pop()?.trim() ?? ''
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
 * Read the members of an archive, or null when it holds none of them.
 *
 * THE EXIT CODE DOES NOT MEAN WHAT IT LOOKS LIKE. `unzip` returns 11 when ANY
 * pattern matched nothing — not when all of them did. Asked for
 * `*.xhtml *.html *.htm`, a book holding only `.xhtml` files exits 11 while
 * writing every one of them to stdout. So the status is unusable as a test for
 * "did this book have any", and the OUTPUT is the only honest signal.
 *
 * `spawnSync`, therefore, and not `execFileSync`: the latter throws on a
 * non-zero status and takes the stdout with it. Written that way first, and it
 * silently under-reported — the CSS path survived only because it passes a
 * single pattern, where 11 really does mean "none". The test beside this one
 * fails if it goes back.
 */
function readMembers(epub, patterns, encoding) {
  const run = spawnSync('unzip', ['-p', epub, ...patterns], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const out = run.stdout
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
    withCjk: 0,
    books: {},
    declarations: { rem: 0, absolute: 0 },
    headingSizes: new Map(),
    proseRemSizes: [],
  }
  const count = (key) => {
    totals.books[key] = (totals.books[key] ?? 0) + 1
  }
  for (const dir of dirs) {
    const epub = join(lib, dir, 'content.epub')
    if (!existsSync(epub)) continue
    totals.scanned += 1

    const text = readMembers(epub, ['*.xhtml', '*.html', '*.htm'], 'utf8')
    if (text && cjkDensity(text.slice(0, cjkSampleBytes)) > 50) totals.withCjk += 1

    /* latin1: a CSS file that will not decode is still a CSS file. */
    const css = readMembers(epub, ['*.css'], 'latin1')
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
    for (const v of seen.headingSizes) {
      totals.headingSizes.set(v, (totals.headingSizes.get(v) ?? 0) + 1)
    }
    totals.proseRemSizes.push(...seen.proseRemSizes)
  }
  return totals
}

/** The report, as text a person reads or JSON a person diffs. */
export function report(totals, { json = false, at } = {}) {
  const withCss = totals.scanned - totals.withoutCss
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
  ]
  const overGrid = totals.proseRemSizes.filter((v) => v >= 1.4)
  lines.push(``, `prose sized in rem at >= 1.4rem: ${overGrid.length} declarations`)
  return lines.join('\n')
}

/* The CLI. Nothing above this line reads a flag or prints. */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const argv = process.argv.slice(2)
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : fallback
  }
  const lib = flag('lib', process.env.PAPER_LIBRARY ?? DEFAULT_LIB)
  if (!existsSync(lib)) {
    console.error(`scan-corpus: no library at ${lib} — pass --lib <path> or set PAPER_LIBRARY`)
    process.exit(2)
  }
  verifyDetectors()
  const totals = scanLibrary(lib, { limit: Number(flag('limit', Infinity)) })
  console.log(
    report(totals, {
      json: argv.includes('--json'),
      /* Stamped by the caller, never by the report: a dated reading has to
         carry its date or it will be quoted years later as a current fact. */
      at: flag('at', new Date().toISOString().slice(0, 10)),
    }),
  )
}
