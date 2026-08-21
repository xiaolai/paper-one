/**
 * THE FIXTURE CORPUS — one small book per shape the phase measured.
 *
 * WHY IT EXISTS. Every rule in Phase 14 was decided against 1,957 real books,
 * which is the right way to decide one and the wrong way to TEST one: the shelf
 * changes whenever a book is imported, so an assertion like "618 books use rem"
 * fails on a purchase. `scan-corpus.test.mjs` already answers that by testing
 * the analysis against fixtures rather than against the shelf. This is that
 * idea named and made complete — a book for each shape the plan turned on, so a
 * detector that stops seeing one fails here rather than quietly reporting a
 * smaller number from the real library.
 *
 * SOURCE, NOT ARCHIVES. Each book is a map of member name to contents, and the
 * `zip` binary makes an EPUB of it at test time. Committing seven `.epub` files
 * would put seven opaque blobs in the tree — no diff, no review, no grep — and
 * `no-binary-source.test.mjs` exists because that class of thing has already
 * cost this repository half an hour of debugging a file that "had no `seq` in
 * it". A reader can see exactly what is in each of these.
 *
 * THE SHAPES ARE THE PLAN'S OWN LIST: inline colour, a `<font>` tag, `align=`,
 * `width=`, rem sizing, a CJK run, and a book with no CSS at all.
 */

/** Escapes, never literal glyphs — see the note in `scan-corpus.mjs`. */
const CJK_RUN = '中文内容'.repeat(30)

const page = (body) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`

/**
 * Every fixture, by the shape it carries.
 *
 * The KEY is the shape, so a failure names what stopped being seen rather than
 * a book number. Each carries one shape prominently and nothing else that would
 * confuse a count.
 */
export const FIXTURE_BOOKS = {
  /** F1's first half: a colour on the element, where no stylesheet is involved. */
  'inline-colour': {
    'ch1.xhtml': page('<p style="color:#000000">black by inline style</p><p><span style="color:#111111">and nested</span></p>'),
    'book.css': 'p { margin: 0 }',
  },
  /** F3: furniture from 1997 — a presentational hint, not a declaration. */
  'font-tag': {
    'ch1.xhtml': page('<p><font color="black" size="3" face="Arial">a font tag</font></p>'),
    'book.css': 'p { margin: 0 }',
  },
  /** A presentational ATTRIBUTE, which is the same class of thing as the tag. */
  'align-attribute': {
    'ch1.xhtml': page('<p align="center">centred by attribute</p><div align="right">and right</div>'),
    'book.css': 'p { margin: 0 }',
  },
  /** 606 books size media this way, and it does NOT compete with max-width. */
  'width-attribute': {
    'ch1.xhtml': page('<p><img src="x.png" width="400" height="300" alt="" /></p><table width="500"><tr><td width="250">x</td></tr></table>'),
    'book.css': 'img { max-width: 300px }',
  },
  /** A third of the library sizes text in rem, against a root nobody had set. */
  'rem-sizing': {
    'ch1.xhtml': page('<h1>heading</h1><p>prose</p>'),
    'book.css': 'html { font-size: 100% } h1 { font-size: 2rem } p { font-size: 1.1rem } blockquote { font-size: 0.5rem }',
  },
  /** 7 books of 1,957, and the reason `text-autospace` is the CJK answer. */
  'cjk-run': {
    'ch1.xhtml': page(`<p>${CJK_RUN}</p>`),
    'book.css': 'p { margin: 0 }',
  },
  /**
   * THE BOOK PAPER'S SHEET IS THE WHOLE TYPOGRAPHY OF.
   *
   * 129 of these were called "unreadable" and dropped on the first full corpus
   * run, because `unzip -p` exits non-zero when a pattern matches nothing. A
   * book with no CSS is a finding, not an error — and it is the one book where
   * every house default in the `before` tier actually reaches the page.
   */
  'no-stylesheet': {
    'ch1.xhtml': page('<h1>heading</h1><p>prose with no stylesheet at all</p><blockquote>a quotation</blockquote>'),
  },
}

/** The shapes, named, so a test can assert the corpus still covers all of them. */
export const FIXTURE_SHAPES = Object.keys(FIXTURE_BOOKS)
