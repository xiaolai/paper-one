import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { writeZip } from './lib/zip.mjs'
import {
  COMPETING,
  analyseCss,
  cjkDensity,
  elementOf,
  outranksElement,
  report,
  scanLibrary,
  selectorList,
  specificity,
  stripWhere,
  subject,
  verifyDetectors,
} from './scan-corpus.mjs'

/**
 * `scan-corpus`: what it reads, and what it must never be believed about.
 *
 * NOTHING HERE TOUCHES THE REAL LIBRARY, deliberately. This is research tooling
 * over a shelf that changes whenever a book is imported, so an assertion like
 * "618 books use rem" would be a test that fails on a purchase. What is stable
 * — and what actually decided several typography arguments — is the ANALYSIS:
 * given this stylesheet, what does the scanner see? That is what is fixed here,
 * against fixtures, in both directions.
 *
 * The archives below are built with the `zip` binary rather than committed as
 * binaries, so a reader can see exactly what is in each one.
 */

const roots = []
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** A library of `book_<id>` directories holding `content.epub`, from a map. */
function library(books) {
  const root = mkdtempSync(join(tmpdir(), 'paper-corpus-'))
  roots.push(root)
    /* BUILT IN PROCESS, not by shelling out to `zip`. The tool does not ship
       with Windows, so every case here died with `spawnSync zip ENOENT` the
       first time that leg ran a suite. `lib/zip.mjs` writes the archive from
       the member map directly — which also means no staging directory, since
       the only reason one existed was to give `zip -r` a tree to walk. */
    for (const [name, members] of Object.entries(books)) {
    const dir = join(root, `book_${name}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'content.epub'), writeZip(Object.entries(members)))
  }
  return root
}

describe('verifyDetectors', () => {
  it('passes when the instruments work', () => {
    expect(verifyDetectors()).toBe(true)
  })

  /**
   * THE REASON THIS FUNCTION EXISTS. The library was reported as holding zero
   * CJK books three times running: twice because the tool errored into a
   * suppressed stderr, once because macOS grep has no `-P` and quietly matched
   * nothing in text that was visibly Chinese. Every one of those looked exactly
   * like "there are no such books".
   */
  it('detects CJK in text that has it, and not in text that does not', () => {
    /* Escaped rather than literal: with the glyphs in the source, Vite's
       import analysis refuses to parse this file and blames an unrelated line.
       Two Han, three kana, two hangul — seven, which the scanner's own
       self-check got wrong as six and threw on. */
    expect(cjkDensity('\u4E2D\u6587\u30C6\u30B9\u30C8\uD55C\uAE00')).toBe(7)
    expect(cjkDensity('plain english, no CJK at all')).toBe(0)
    /* Accented Latin is not CJK, and a range that swept it up would report
       most of the shelf as Chinese. */
    expect(cjkDensity('caf\u00E9 \u2014 na\u00EFve \u2014 \u00A320')).toBe(0)
  })
})

describe('analyseCss', () => {
  it('sees a rem font-size, which is the finding the whole tool was built for', () => {
    const seen = analyseCss('p { font-size: 1.2rem }')
    expect(seen.usesRem).toBe(true)
    expect(seen.remDeclarations).toBe(1)
  })

  it('does not call em a rem', () => {
    /* `1.2em` and `1.2rem` differ by one character and by which element they
       resolve against — the entire base-size decision turned on that. */
    const seen = analyseCss('p { font-size: 1.2em }')
    expect(seen.usesRem).toBe(false)
    expect(seen.usesAbsolute).toBe(false)
  })

  it('separates the root from the body, which are not the same claim', () => {
    expect(analyseCss('body { font-size: 16px }').setsBodySize).toBe(true)
    expect(analyseCss('body { font-size: 16px }').setsRootSize).toBe(false)
    expect(analyseCss('html { font-size: 16px }').setsRootSize).toBe(true)
    expect(analyseCss(':root { font-size: 16px }').setsRootSize).toBe(true)
  })

  it('counts absolute units of every kind', () => {
    const seen = analyseCss('p{font-size:12pt} li{font-size:14px} dd{font-size:1cm}')
    expect(seen.usesAbsolute).toBe(true)
    expect(seen.absoluteDeclarations).toBe(3)
  })

  it('reads a heading size as the value, with any !important stripped', () => {
    expect(analyseCss('h1 { font-size: 1em !important }').headingSizes).toEqual(['1em'])
    expect(analyseCss('h1 { font-size: 1em !important }').usesImportant).toBe(true)
  })

  it('collects prose rem sizes, which is what the line-box change turned on', () => {
    const seen = analyseCss('p{font-size:2rem} blockquote{font-size:1.2rem} h1{font-size:3rem}')
    /* Headings excluded: the forced line box only lands on prose elements. */
    expect(seen.proseRemSizes.sort()).toEqual([1.2, 2])
  })

  it('sees media sized by font, and not media sized in pixels', () => {
    expect(analyseCss('img { max-height: 20em }').sizesMediaByFont).toBe(true)
    expect(analyseCss('img { max-height: 200px }').sizesMediaByFont).toBe(false)
  })

  it('ignores declarations that are only mentioned in a comment', () => {
    /* The sheets being read explain themselves in prose, and that prose names
       the properties it explains. */
    const seen = analyseCss('/* font-size: 1rem is what a book might say */ p { color: red }')
    expect(seen.usesRem).toBe(false)
    expect(seen.remDeclarations).toBe(0)
  })
})

/**
 * The competing-declarations table (WI-14.0).
 *
 * WHAT IT IS FOR. Paper injects one sheet into the slot foliate appends AFTER
 * the book's own, so every unmarked house rule in it beats the book's
 * equal-specificity declaration on source order alone. The plan drew a table of
 * how far that reaches and could not re-run it; this is the instrument that
 * can, and the two things it had to get right are both asserted below — the
 * property that genuinely competes, and the selector rank that decides who
 * wins.
 */
describe('the competing-declarations scan', () => {
  it('reads the rightmost compound, which is the element a rule styles', () => {
    expect(subject('.chapter > h1')).toBe('h1')
    expect(subject('h1 .small')).toBe('.small')
    expect(elementOf('h1.title')).toBe('h1')
    /* A rule written entirely against classes names no element, and this
       scanner will not guess which one it lands on. */
    expect(elementOf('.chapter-title')).toBe('')
  })

  it('ranks a selector against Paper’s bare element rule', () => {
    expect(specificity('h1')).toEqual([0, 0, 1])
    expect(outranksElement('h1')).toBe(false)
    expect(outranksElement('.chapter h1')).toBe(true)
    expect(outranksElement('#toc h1')).toBe(true)
    /* Two element names is (0,0,2), which also outranks (0,0,1) — a rank test
       that only looked for a dot would call this a book Paper beats. */
    expect(outranksElement('section h1')).toBe(true)
  })

  it('counts a bare heading rule as one Paper takes, and a qualified one as the book’s', () => {
    const bare = analyseCss('h1 { font-weight: 300 }')
    expect(bare.competing.headingWeight).toBe(true)
    expect(bare.competingAbove.headingWeight).toBeUndefined()

    const qualified = analyseCss('.chapter h1 { font-weight: 300 }')
    expect(qualified.competing.headingWeight).toBe(true)
    expect(qualified.competingAbove.headingWeight).toBe(true)
  })

  /**
   * THE ROW THAT WAS WRONG, and the reason the table was renamed.
   *
   * It was listed as `img { width }` competing with Paper's `max-width: 100%`.
   * They are DIFFERENT PROPERTIES and do not contest each other: a book's
   * `width: 400px` and Paper's `max-width: 100%` both apply and the image comes
   * out at 400px. Measured over the whole library the corrected row is 7 books,
   * not the 474 the wrong one reported.
   */
  it('does not read a book’s `width` as competing with Paper’s `max-width`', () => {
    expect(analyseCss('img { width: 400px }').competing.mediaMaxWidth).toBeUndefined()
    expect(analyseCss('img { max-width: 300px }').competing.mediaMaxWidth).toBe(true)
  })

  it('does not read a descendant of the element as a rule about it', () => {
    /* `h1 em { color }` styles an em, not a heading — and Paper has no rule
       about it at all. Reading the whole selector string instead of its
       subject counts this as a heading rule and as a link rule at once. */
    const seen = analyseCss('h1 em { color: red }')
    expect(seen.competing.headingWeight).toBeUndefined()
    expect(seen.competing.aColour).toBeUndefined()
  })

  it('reads every selector in a list, not only its last line', () => {
    /* The older detectors in this file read `selector.split("\\n").pop()`, so a
       list written one per line loses everything above the last. This one does
       not, and a book that writes `h1,\\nh2 { margin: 0 }` is a book that
       contests the heading margin. */
    const seen = analyseCss('h1,\nh2 {\n  margin: 0\n}')
    expect(seen.competing.headingMargin).toBe(true)
  })

  it('counts an important declaration as one the book wins', () => {
    /* `!important` BEATS EVERYTHING PAPER HAS, whatever the specificity and
       whatever the source order, because Paper's house rules are unmarked by
       construction — that is what the `before` tier means. Counting a marked
       bare declaration as one Paper takes was simply wrong, and it is the kind
       of wrong that makes a published percentage too high. */
    const marked = analyseCss('h1 { font-weight: 300 !important }')
    expect(marked.competing.headingWeight).toBe(true)
    expect(marked.competingAbove.headingWeight).toBe(true)
  })

  it('strips a nested :where() whole, not to its first bracket', () => {
    /* `/:where\([^)]*\)/` stops at the FIRST `)`, so `:where(:is(.a), #x) h1`
       loses only `:where(:is(.a)` and leaves `, #x)` — which then counts as an
       id and ranks the selector above a bare element rule. Paper's own sheet is
       written entirely in `:where()` gates. */
    expect(stripWhere(':where(:is(.a), #x) h1').trim()).toBe('h1')
    expect(specificity(':where(:is(.a), #x) h1')).toEqual([0, 0, 1])
    expect(outranksElement(':where(:is(.a), #x) h1')).toBe(false)
  })

  it('reads every declaration of a property, not only the first', () => {
    /* A block may declare one property twice — the fallback idiom, or an
       override appended to a rule already written. Reading only the first misses
       an `!important` on the second, and counts a rule the book wins outright
       as one Paper takes. */
    const late = analyseCss('h1 { font-weight: 300; font-weight: 400 !important }')
    expect(late.competingAbove.headingWeight).toBe(true)
  })

  it('splits a selector list on the commas that separate selectors', () => {
    /* A comma inside `:is()`, `:not()` or an attribute value separates nothing.
       Split on it, `:is(h1, h2)` becomes `:is(h1` and ` h2)` — two fragments
       that are each nonsense and one of which still matches a pattern here. */
    expect(selectorList(':is(h1, h2), p')).toEqual([':is(h1, h2)', ' p'])
    expect(selectorList('[title="a,b"], p')).toEqual(['[title="a,b"]', ' p'])
    expect(selectorList('h1, h2')).toEqual(['h1', ' h2'])
  })

  it('gives :where() the zero specificity it actually has', () => {
    /* Paper's own sheet leans on this: every gate in `bookCss.ts` is written
       `:where(:root[style*=…])` precisely so it adds nothing. A scan that
       counted it would rank Paper's rules above the books they are careful not
       to outrank. */
    expect(specificity(':where(.chapter) h1')).toEqual([0, 0, 1])
    expect(outranksElement(':where(.chapter) h1')).toBe(false)
    expect(outranksElement('.chapter h1')).toBe(true)
  })

  it('counts a book once per rule however many times it says it', () => {
    const lib = library({
      loud: { 'a.css': 'h1{font-weight:300} h2{font-weight:300} h3{font-weight:300}' },
    })
    const totals = scanLibrary(lib)
    expect(totals.competing.headingWeight).toBe(1)
  })

  it('reports a row for every rule in the table, with both bounds named', () => {
    const lib = library({ one: { 'a.css': '.chapter h1 { font-weight: 300 }' } })
    const text = report(scanLibrary(lib), { at: '2026-08-22' })
    for (const rule of COMPETING) expect(text, rule.key).toContain(rule.label)
    expect(text).toContain('books containing potentially competing declarations')
    /* The name is the finding. "Paper silently wins" is a claim about what
       RENDERS, and this instrument reads declarations. */
    expect(text).not.toContain('Paper silently wins')
    expect(text).toContain('NEVER SUBTRACT THEM FOR A COUNT')
  })
})

describe('scanLibrary', () => {
  it('counts a book with no stylesheet as a finding, not as a failure', () => {
    /* `unzip -p` exits non-zero when a pattern matches nothing. The first full
       run called 129 of these "unreadable" and dropped them — when in fact
       Paper's own sheet is the whole of their typography. */
    const lib = library({
      styled: { 'a.css': 'p { font-size: 1.5rem }', 'a.xhtml': '<p>hi</p>' },
      bare: { 'a.xhtml': '<p>no stylesheet here</p>' },
    })
    const totals = scanLibrary(lib)
    expect(totals.scanned).toBe(2)
    expect(totals.withoutCss).toBe(1)
    expect(totals.books.rem).toBe(1)
  })

  it('counts a book once however many times it says the same thing', () => {
    const lib = library({
      loud: { 'a.css': 'p{font-size:1rem} li{font-size:2rem} dd{font-size:3rem}' },
    })
    const totals = scanLibrary(lib)
    expect(totals.books.rem).toBe(1)
    expect(totals.declarations.rem).toBe(3)
  })

  it('finds CJK by its text, never by its metadata', () => {
    /* The claim "not one book declares zh/ja/ko, so the library is entirely
       English" was wrong: 7 books carry substantial CJK and declare none. */
    const lib = library({
      chinese: {
        'a.opf': '<dc:language>en</dc:language>',
        'a.xhtml': `<p>${'\u4E2D\u6587\u5185\u5BB9'.repeat(20)}</p>`,
      },
      english: { 'a.opf': '<dc:language>en</dc:language>', 'a.xhtml': '<p>English only</p>' },
    })
    expect(scanLibrary(lib).withCjk).toBe(1)
  })

  it('survives a stylesheet that is not valid utf8', () => {
    /* Some books are mis-declared or truncated; a utf8 decode aborts on them
       and the first version of this dropped them silently. */
    const lib = library({
      broken: { 'a.css': Buffer.from([0x70, 0x7b, 0xff, 0xfe, 0x7d]) },
      fine: { 'a.css': 'p { font-size: 1rem }' },
    })
    const totals = scanLibrary(lib)
    expect(totals.scanned).toBe(2)
    expect(totals.withoutCss).toBe(0)
    expect(totals.books.rem).toBe(1)
  })
})

describe('report', () => {
  it('carries its date, so it cannot be quoted later as a current fact', () => {
    const lib = library({ one: { 'a.css': 'p { font-size: 1rem }' } })
    const text = report(scanLibrary(lib), { at: '2026-08-21' })
    expect(text).toContain('2026-08-21')
    expect(text).toContain('not an acceptance criterion')
  })

  it('emits JSON that can be diffed between runs', () => {
    const lib = library({ one: { 'a.css': 'p { font-size: 1rem }' } })
    const parsed = JSON.parse(report(scanLibrary(lib), { json: true, at: '2026-08-21' }))
    expect(parsed.at).toBe('2026-08-21')
    expect(parsed.books.rem).toBe(1)
  })
})
