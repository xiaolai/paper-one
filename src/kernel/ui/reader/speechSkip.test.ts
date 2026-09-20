// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { collectText } from './speech'
import { speechSkip } from './speechSkip'

/** The element holding `id`, in a document parsed the way foliate parses one. */
function markup(html: string, type: DOMParserSupportedType = 'text/html'): Document {
  const source =
    type === 'text/html'
      ? `<body>${html}</body>`
      : `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>${html}</body></html>`
  return new DOMParser().parseFromString(source, type)
}

const at = (doc: Document, id: string) => doc.getElementById(id)

describe('what is never spoken', () => {
  it('reads ordinary prose', () => {
    const doc = markup('<p id="a">Ordinary words.</p>')
    expect(speechSkip(at(doc, 'a'))).toBe('read')
  })

  it('leaves a ruby annotation out with NO gap, because it sits inside a word', () => {
    /* ⚠️ **A GAP HERE WOULD SPLIT THE WORD IT ANNOTATES.** `漢 字` is two words
       to a segmenter and to a voice; the annotation is the pronunciation of the
       characters around it, not something between them. */
    const doc = markup('<ruby>漢<rt id="a">かん</rt>字<rt id="b">じ</rt></ruby>')
    expect(speechSkip(at(doc, 'a'))).toBe('silent')
    expect(speechSkip(at(doc, 'b'))).toBe('silent')
  })

  it('leaves the ruby fallback parenthesis out too', () => {
    /* `<rp>` is what a browser with no ruby support shows instead. A browser
       with support hides it — but that depends on the reader's stylesheet, and
       this does not. */
    const doc = markup('<ruby>漢<rp id="a">(</rp><rt>かん</rt><rp>)</rp></ruby>')
    expect(speechSkip(at(doc, 'a'))).toBe('silent')
  })

  it('leaves a print page number out WITH a gap', () => {
    const doc = markup('<span id="a" epub:type="pagebreak">247</span>')
    expect(speechSkip(at(doc, 'a'))).toBe('gap')
  })

  it('accepts the DPUB-ARIA role as well as epub:type', () => {
    /* Books ship one, the other, or both. `epubSemantics` reads both spellings
       of `epub:type`; this reads the role beside it. */
    const doc = markup('<span id="a" role="doc-pagebreak">247</span>')
    expect(speechSkip(at(doc, 'a'))).toBe('gap')
  })

  it('leaves a note reference out WITH a gap, which is what stops two sentences fusing', () => {
    const doc = markup('<a id="a" epub:type="noteref" href="#n1">1</a>')
    expect(speechSkip(at(doc, 'a'))).toBe('gap')
  })

  it('walks up to the structure, because the semantics sit on the container', () => {
    /* The note is an `<aside>`; the text is in a `<p>` inside it. */
    const doc = markup('<aside epub:type="footnote"><p id="a">A. D. is over 2,000 years.</p></aside>')
    expect(speechSkip(at(doc, 'a'))).toBe('gap')
  })

  it('reads epub:type as a TOKEN LIST, not as one string', () => {
    const doc = markup('<aside id="a" epub:type="note footnote">Body.</aside>')
    expect(speechSkip(at(doc, 'a'))).toBe('gap')
  })

  it("leaves the book's own table of contents out", () => {
    const doc = markup('<nav epub:type="toc"><ol><li id="a">Chapter One</li></ol></nav>')
    expect(speechSkip(at(doc, 'a'))).toBe('gap')
  })

  it('works on a document parsed as XHTML, where epub:type is namespaced', () => {
    /* ⚠️ **THE TWO PARSE PATHS ANSWER DIFFERENTLY AND `epubSemantics` EXISTS FOR
       IT.** foliate reparses a section as `text/html` when it is not valid XML,
       and an HTML parser has no namespace to put `epub:type` in. Both are real. */
    const doc = markup('<span id="a" epub:type="pagebreak">247</span>', 'application/xhtml+xml')
    expect(speechSkip(at(doc, 'a'))).toBe('gap')
  })

  it('answers read for no element at all', () => {
    expect(speechSkip(null)).toBe('read')
  })
})

describe('what is deliberately still spoken', () => {
  /**
   * ⚠️ **EPUB CALLS THESE SKIPPABLE AND THEY ARE NOT SKIPPED HERE.** Media
   * Overlays lists `table`, `list`, `sidebar`, `marginalia` and more — but
   * skippability is a PREFERENCE a reading system offers, not a fact about the
   * text. A listener may want sidebars and not footnotes. Dropping them by
   * default would silently lose content the book meant to be read, and the
   * preference belongs with the Settings surface that would govern it.
   */
  for (const [what, html] of [
    ['a list', '<ul epub:type="list"><li id="a">A step.</li></ul>'],
    ['a table cell', '<table><tr><td id="a" epub:type="table-cell">12</td></tr></table>'],
    ['a sidebar', '<aside id="a" epub:type="sidebar">An aside worth hearing.</aside>'],
    ['marginalia', '<aside id="a" epub:type="marginalia">A note in the margin.</aside>'],
    ['a figure caption', '<figcaption id="a">Figure 1. The apparatus.</figcaption>'],
    ['a heading', '<h1 id="a">Chapter One</h1>'],
    ['a superscript that is not a noteref', '<p>x<sup id="a">2</sup></p>'],
  ] as const) {
    it(`reads ${what}`, () => {
      expect(speechSkip(at(markup(html), 'a'))).toBe('read')
    })
  }
})

describe('what collectText does with them', () => {
  /** The text a reading would speak, from a live document. */
  function spoken(html: string): string {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const doc = frame.contentDocument
    if (!doc) throw new Error('jsdom gave the frame no document')
    doc.body.innerHTML = html
    const text = collectText(doc).text
    frame.remove()
    return text
  }

  it('says an annotated word once, not once and then spelled', () => {
    /* Read as written this is `漢字かんじ` — every annotated word said twice,
       which makes a book with furigana or pinyin throughout unlistenable. */
    expect(spoken('<p><ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby></p>')).toBe('漢字')
  })

  it('keeps two sentences apart when the marker between them goes', () => {
    /* ⚠️ **THE CASE `sentenceAt.ts` RECORDS.** Removed silently, this reads
       `He left.Then she stayed.` — one token to a segmenter, one word to a
       voice. The gap is what keeps them two sentences. */
    const text = spoken('<p>He left.<a epub:type="noteref" href="#n">1</a>Then she stayed.</p>')
    expect(text).toBe('He left. Then she stayed.')
  })

  it('keeps them apart when the surrounding prose already had its own spaces', () => {
    /* ⚠️ **THE CONTRACT IS "NOT FUSED", NOT AN EXACT NUMBER OF SPACES.** The
       space either side of the marker belongs to the surrounding text nodes, so
       removing the marker can leave two — which `sentenceSpansOf`'s squeeze
       collapses and no voice can pronounce. Asserting the exact string here
       would pin a detail nothing downstream depends on. */
    const text = spoken('<p>He left. <a epub:type="noteref" href="#n">1</a> Then she stayed.</p>')
    expect(text).toMatch(/^He left\.\s+Then she stayed\.$/u)
    expect(text).not.toContain('1')
  })

  it('drops a page number from the middle of a sentence', () => {
    const text = spoken('<p>the long <span epub:type="pagebreak">247</span>afternoon</p>')
    expect(text).toBe('the long afternoon')
  })

  it('still reads a visible footnote body out of the reading', () => {
    /* Visible, so no CSS rule catches it — this is the case the attribute rules
       exist for, and the one the audiobook export meets with no styles at all. */
    const text = spoken('<p>The claim.</p><aside epub:type="footnote"><p>See Smith 1994.</p></aside>')
    /* Trimmed for the reason above: dropping the note leaves the separator it
       would have been preceded by, at the very end where nothing follows it. */
    expect(text.trim()).toBe('The claim.')
    expect(text).not.toContain('Smith')
  })

  it('leaves the offsets consistent, so the highlight still lands', () => {
    /* Whatever is dropped, `segments` must still describe `text` exactly — an
       offset that maps to the wrong node is how the follow-along drifts. */
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const doc = frame.contentDocument
    if (!doc) throw new Error('jsdom gave the frame no document')
    doc.body.innerHTML = '<p>Before <span epub:type="pagebreak">247</span>after <ruby>漢<rt>かん</rt></ruby> end.</p>'
    const { text, segments } = collectText(doc)
    for (const segment of segments) {
      expect(text.slice(segment.start, segment.end)).toBe(segment.node.textContent)
    }
    frame.remove()
  })
})
