import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FIXTURE_BOOKS, FIXTURE_SHAPES } from './fixtures/books.mjs'
import { analyseCss, cjkDensity, report, scanLibrary } from './scan-corpus.mjs'

/**
 * THE FIXTURE CORPUS, and what it is for.
 *
 * Every rule in Phase 14 was decided against 1,957 real books. That is the
 * right way to decide a rule and the wrong way to keep one honest: the shelf
 * changes whenever a book is imported, and a detector that silently stops
 * seeing a shape reports a SMALLER NUMBER rather than an error. Every
 * measurement in the plan would go on looking like a measurement.
 *
 * So the shapes the plan turned on get a book each, and the detectors are held
 * to finding them. A zero here is a broken instrument; a zero on the real shelf
 * is a fact about the shelf, and only this file can tell the two apart.
 */

const roots = []
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** The whole fixture corpus as a library `scanLibrary` can read. */
function fixtureLibrary() {
  const root = mkdtempSync(join(tmpdir(), 'paper-fixtures-'))
  roots.push(root)
  for (const [shape, members] of Object.entries(FIXTURE_BOOKS)) {
    const staging = join(root, `book_${shape}`, 'staging')
    mkdirSync(staging, { recursive: true })
    for (const [name, contents] of Object.entries(members)) {
      writeFileSync(join(staging, name), contents)
    }
    execFileSync('zip', ['-q', '-r', join(root, `book_${shape}`, 'content.epub'), '.'], {
      cwd: staging,
    })
  }
  return root
}

describe('the fixture corpus', () => {
  it('covers every shape the plan measured', () => {
    /* Named rather than counted: a failure says WHICH shape stopped being
       covered, and a corpus that quietly lost one is the thing this guards. */
    expect(new Set(FIXTURE_SHAPES)).toEqual(
      new Set([
        'inline-colour',
        'font-tag',
        'align-attribute',
        'width-attribute',
        'rem-sizing',
        'cjk-run',
        'no-stylesheet',
      ]),
    )
  })

  it('is built from readable source, never committed as archives', () => {
    /* Seven `.epub` blobs in the tree would be seven files git cannot diff,
       review or grep — the class `no-binary-source.test.mjs` exists for. Each
       book is a map of member name to contents; `zip` makes the archive here. */
    for (const [shape, members] of Object.entries(FIXTURE_BOOKS)) {
      for (const [name, contents] of Object.entries(members)) {
        expect(typeof contents, `${shape}/${name}`).toBe('string')
        expect(contents.includes('\u0000'), `${shape}/${name} carries a NUL`).toBe(false)
      }
    }
  })
})

describe('the detectors find every shape they were built for', () => {
  it('scans the whole corpus without dropping a book', () => {
    const totals = scanLibrary(fixtureLibrary())
    expect(totals.scanned).toBe(FIXTURE_SHAPES.length)
    /* THE BOOK WITH NO CSS IS A FINDING, NOT A FAILURE. `unzip -p` exits
       non-zero when a pattern matches nothing, and the first full corpus run
       called 129 such books "unreadable" and dropped them. */
    expect(totals.withoutCss).toBe(1)
  })

  it('counts an archive it cannot read as its own outcome, not as no CSS', () => {
    /**
     * THE THIRD OUTCOME, and it is a real book on a real shelf.
     *
     * A corrupt EPUB was folded into "ships no CSS" — indistinguishable from a
     * book whose whole typography is Paper's sheet, which is one of this
     * scanner's headline findings. The guard that separated them found one such
     * book among 1,960 on the first run. It does not stop the scan either: one
     * damaged archive must not cost the other 1,959 their measurement.
     */
    const root = mkdtempSync(join(tmpdir(), 'paper-broken-'))
    roots.push(root)
    const dir = join(root, 'book_broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'content.epub'), 'this is not a zip archive at all')
    const good = join(root, 'book_fine', 'staging')
    mkdirSync(good, { recursive: true })
    writeFileSync(join(good, 'a.css'), 'p { font-size: 1rem }')
    execFileSync('zip', ['-q', '-r', join(root, 'book_fine', 'content.epub'), '.'], { cwd: good })

    const totals = scanLibrary(root)
    expect(totals.scanned).toBe(2)
    expect(totals.unreadable, 'the corrupt book was not counted as unreadable').toBe(1)
    expect(totals.withoutCss, 'a corrupt book was counted as one with no CSS').toBe(0)
    /* And the good book still measured, which is the other half. */
    expect(totals.books.rem).toBe(1)
    expect(report(totals, { at: '2026-08-22' })).toContain('could not be read at all')
  })

  it('sees rem sizing, which a third of the library uses', () => {
    const seen = analyseCss(FIXTURE_BOOKS['rem-sizing']['book.css'])
    expect(seen.usesRem).toBe(true)
    expect(seen.setsRootSize).toBe(true)
    expect(seen.setsHeadingSize).toBe(true)
    /* The prose sizes are what the line-box decision turned on. */
    expect(seen.proseRemSizes.sort()).toEqual([0.5, 1.1])
  })

  it('sees the competing declaration, and not the one that does not compete', () => {
    /* THE ROW WI-14.0 CORRECTED, held by a fixture. A book's `img { max-width }`
       contests Paper's; the `width=` attribute in the same book does not
       contest anything, because `width` and `max-width` are different
       properties and both apply. */
    const seen = analyseCss(FIXTURE_BOOKS['width-attribute']['book.css'])
    expect(seen.competing.mediaMaxWidth).toBe(true)
    expect(seen.competingAbove.mediaMaxWidth).toBeUndefined()
  })

  it('sees a CJK run by its text, never by its metadata', () => {
    /* Answered "none" three times by three broken detectors before
       `verifyDetectors` existed — twice into a suppressed stderr, once because
       macOS grep has no `-P`. Every one looked like "there are no such books". */
    expect(cjkDensity(FIXTURE_BOOKS['cjk-run']['ch1.xhtml'])).toBeGreaterThan(50)
    expect(scanLibrary(fixtureLibrary()).withCjk).toBe(1)
  })

  it('carries the presentational shapes the sheet answers in the before tier', () => {
    /* These are not CSS, so `analyseCss` has nothing to say about them — which
       is the point. They are hints on the ELEMENT, and the whole of F3 is that
       a hint and an inline style look alike in a book and are opposites in the
       cascade. The fixtures exist so the sheet's answer can be driven against a
       real document; what is asserted here is that the shapes are present. */
    expect(FIXTURE_BOOKS['font-tag']['ch1.xhtml']).toContain('<font color="black" size="3"')
    expect(FIXTURE_BOOKS['align-attribute']['ch1.xhtml']).toContain('align="center"')
    expect(FIXTURE_BOOKS['inline-colour']['ch1.xhtml']).toContain('style="color:#000000"')
    expect(FIXTURE_BOOKS['width-attribute']['ch1.xhtml']).toContain('width="400"')
  })

  it('gives the no-CSS book every element the before tier has a default for', () => {
    /* The one book where Paper's house defaults actually reach the page, since
       there is no author stylesheet to beat them. A heading, prose and a
       quotation are the three the `before` tier styles. */
    const html = FIXTURE_BOOKS['no-stylesheet']['ch1.xhtml']
    for (const tag of ['<h1>', '<p>', '<blockquote>']) expect(html).toContain(tag)
    expect(FIXTURE_BOOKS['no-stylesheet']['book.css']).toBeUndefined()
  })
})
