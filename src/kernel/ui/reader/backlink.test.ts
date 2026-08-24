// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isBacklink, noteText } from './backlink'

const OPS = 'http://www.idpf.org/2007/ops'

/**
 * A document from XHTML, so `epub:type` lands in its own namespace.
 *
 * `innerHTML` on an HTML document DROPS the prefix — the attribute comes back
 * as the literal name `epub:type` with a null namespace, and
 * `getAttributeNS(OPS, 'type')` then reads null for markup that plainly has it.
 * The whole predicate would pass its tests by never seeing an `epub:type` at
 * all. Parsed as XML, the prefix binds and the attribute is where a real book
 * puts it.
 */
function xhtml(body: string): Document {
  return new DOMParser().parseFromString(
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="${OPS}"><body>${body}</body></html>`,
    'application/xhtml+xml',
  )
}

const anchor = (doc: Document, selector: string): Element => {
  const el = doc.querySelector(selector)
  if (!el) throw new Error(`no ${selector}`)
  return el
}

describe('isBacklink', () => {
  it('reads the namespace the fixture actually carries', () => {
    /* The fixture's own assumption, asserted rather than assumed — see
       `xhtml`. Every case below is worthless if this is null. */
    const doc = xhtml('<a id="x" epub:type="noteref" href="#y">*</a>')
    expect(anchor(doc, '#x').getAttributeNS(OPS, 'type')).toBe('noteref')
  })

  it('takes a reference in running prose as a way IN', () => {
    const doc = xhtml(
      '<p>…years<a id="ref" epub:type="noteref" href="#note" >*</a></p>' +
        '<aside id="note" epub:type="footnote"><p>A.D. is over 2,000 years long.</p></aside>',
    )
    expect(isBacklink(anchor(doc, '#ref'))).toBe(false)
  })

  it('takes the mark inside the note as a way OUT, though the book calls it a noteref', () => {
    /* The shape *What's Our Problem?* ships on every footnote it has: both
       anchors say `noteref`, and foliate's `yes` branch does not look for a
       backlink. Left alone this opened a popover holding one asterisk. */
    const doc = xhtml(
      '<p>…years<a id="ref" epub:type="noteref" href="#note">*</a></p>' +
        '<aside id="note" epub:type="footnote">' +
        '<p><a id="back" epub:type="noteref" href="#ref">*</a> A.D. is over 2,000 years long.</p>' +
        '</aside>',
    )
    expect(isBacklink(anchor(doc, '#back'))).toBe(true)
  })

  it('honours an explicit epub:type', () => {
    const doc = xhtml('<p><a id="back" epub:type="backlink" href="#ref">1</a></p>')
    expect(isBacklink(anchor(doc, '#back'))).toBe(true)
  })

  it('honours an explicit ARIA role', () => {
    const doc = xhtml('<p><a id="back" role="doc-backlink" href="#ref">1</a></p>')
    expect(isBacklink(anchor(doc, '#back'))).toBe(true)
  })

  it('catches a backlink in an endnote section, where the target is another file', () => {
    /* No fragment to resolve and no `backlink` type — the container is the
       only signal there is, and it is enough. */
    const doc = xhtml(
      '<section epub:type="endnotes">' +
        '<li role="doc-endnote"><a id="back" href="../Text/ch01.xhtml#endnote-ref-1">1</a> Ibid.</li>' +
        '</section>',
    )
    expect(isBacklink(anchor(doc, '#back'))).toBe(true)
  })

  it('catches an unlabelled backlink by where it points', () => {
    /* Neither anchor nor container says anything. A link that lands on another
       link is the second half of a pair. */
    const doc = xhtml(
      '<p><a id="ref" href="#back">1</a></p><div><a id="back" href="#ref">1</a> Ibid.</div>',
    )
    expect(isBacklink(anchor(doc, '#back'))).toBe(true)
  })

  it('leaves an ordinary cross-reference alone', () => {
    const doc = xhtml('<p><a id="x" href="#chapter-3">see Chapter 3</a></p><h2 id="chapter-3">3</h2>')
    expect(isBacklink(anchor(doc, '#x'))).toBe(false)
  })

  it('leaves an external link alone', () => {
    const doc = xhtml('<p><a id="x" href="https://example.com/">example</a></p>')
    expect(isBacklink(anchor(doc, '#x'))).toBe(false)
  })

  it('does not call a self-referencing anchor a backlink', () => {
    const doc = xhtml('<p><a id="x" href="#x">x</a></p>')
    expect(isBacklink(anchor(doc, '#x'))).toBe(false)
  })

  it('survives a malformed percent-escape rather than throwing', () => {
    /* `decodeURIComponent('%zz')` throws, and this runs inside foliate's own
       click dispatch — a throw here would reach the app's error boundary. */
    const doc = xhtml('<p><a id="x" href="#%zz">x</a></p>')
    expect(() => isBacklink(anchor(doc, '#x'))).not.toThrow()
    expect(isBacklink(anchor(doc, '#x'))).toBe(false)
  })

  it('resolves a percent-escaped fragment', () => {
    const doc = xhtml('<p><a id="a b" href="#ref">1</a><a id="ref" href="#a%20b">1</a></p>')
    expect(isBacklink(anchor(doc, '#ref'))).toBe(true)
  })
})

/**
 * THE OTHER PARSE MODE, which had no case here at all until §16 found it.
 *
 * foliate reparses a section as `text/html` when it will not parse as XML
 * (`node_modules/foliate-js/epub.js`), and an HTML parser has no namespaces to
 * put `epub:type` in — the attribute arrives under its literal name in the null
 * namespace. `backlink.ts` read only `getAttributeNS(OPS, 'type')`, so for
 * every book on that path both semantic tests answered "no attribute" and only
 * the structural fallback was left.
 *
 * **The suite above cannot see this and is not at fault for it**: its `xhtml`
 * helper exists because `innerHTML` on an HTML document drops the prefix, which
 * would have made every case vacuous. The fix was to read both spellings; the
 * cases below are what makes the fix checkable, and each one is chosen so the
 * attribute is the ONLY thing that can decide it — no note ancestor, and an
 * `href` that resolves to nothing.
 */
function html(body: string): Document {
  return new DOMParser().parseFromString(
    `<html><body>${body}</body></html>`,
    'text/html',
  )
}

describe('isBacklink — a section parsed as text/html', () => {
  it('is a document where the namespaced read really does answer null', () => {
    /* The fixture's own assumption, asserted rather than assumed — the mirror
       of the XHTML case above. If this ever returns "backlink", the two
       fixtures have stopped differing and the cases below prove nothing. */
    const doc = html('<a id="x" epub:type="backlink" href="#nowhere">*</a>')
    const el = anchor(doc, '#x')

    expect(el.getAttributeNS(OPS, 'type')).toBeNull()
    expect(el.getAttribute('epub:type')).toBe('backlink')
  })

  it('reads a labelled backlink whose attribute is in no namespace', () => {
    const doc = html('<p>Some prose <a id="b" epub:type="backlink" href="#nowhere">*</a></p>')

    expect(isBacklink(anchor(doc, '#b'))).toBe(true)
  })

  it('reads a note container whose attribute is in no namespace', () => {
    const doc = html(
      '<aside epub:type="footnote" id="n"><p><a id="back" href="#nowhere">*</a> the note</p></aside>',
    )

    expect(isBacklink(anchor(doc, '#back'))).toBe(true)
  })

  /* Non-vacuity for the pair: the same shape with no semantic on it must still
   * be a way IN, or the two cases above would pass for a predicate that had
   * simply started answering true. */
  it('still takes an unlabelled reference in prose as a way in', () => {
    const doc = html('<p>Some prose <a id="ref" href="#nowhere">*</a></p>')

    expect(isBacklink(anchor(doc, '#ref'))).toBe(false)
  })
})


describe('noteText', () => {
  const bodyOf = (markup: string) => {
    const doc = xhtml(markup)
    if (!doc.body) throw new Error('no body')
    return doc.body
  }

  it('gives one line per block, so a second paragraph is not run on', () => {
    const body = bodyOf('<p>First line.</p><p>Second line.</p>')
    expect(noteText(body)).toBe('First line.\nSecond line.')
  })

  it("collapses the file's indentation, which is not the author's", () => {
    const body = bodyOf('<p>\n      A.D. is over\n      2,000 years long.\n    </p>')
    expect(noteText(body)).toBe('A.D. is over 2,000 years long.')
  })

  it('keeps the text of inline markup', () => {
    const body = bodyOf('<p>over 2,000 <em>centuries</em>.</p>')
    expect(noteText(body)).toBe('over 2,000 centuries.')
  })

  it('drops a block that holds nothing but whitespace', () => {
    const body = bodyOf('<p>Only this.</p><p>  </p>')
    expect(noteText(body)).toBe('Only this.')
  })

  it('falls back to the whole body when the note has no blocks', () => {
    const body = bodyOf('A bare run of text.')
    expect(noteText(body)).toBe('A bare run of text.')
  })
})
