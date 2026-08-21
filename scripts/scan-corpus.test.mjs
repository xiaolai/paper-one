import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { analyseCss, cjkDensity, report, scanLibrary, verifyDetectors } from './scan-corpus.mjs'

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
  for (const [name, members] of Object.entries(books)) {
    const dir = join(root, `book_${name}`)
    const staging = join(dir, 'staging')
    mkdirSync(staging, { recursive: true })
    for (const [file, contents] of Object.entries(members)) {
      const path = join(staging, file)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, contents)
    }
    execFileSync('zip', ['-q', '-r', join(dir, 'content.epub'), '.'], { cwd: staging })
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
