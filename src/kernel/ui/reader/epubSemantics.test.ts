import { describe, expect, it } from 'vitest'
import { ariaRoles, declaredLang, epubTypes } from './epubSemantics'

/**
 * The two parse modes, told apart — which is the whole reason this module
 * exists, and which nothing else in the tree can check.
 *
 * **`backlink.test.ts` cannot, and an audit proved it.** Its fixture parses as
 * `application/xhtml+xml`, and in an XHTML document `getAttribute('epub:type')`
 * returns the value too — so an implementation that read ONLY the literal name
 * passes every backlink case in both the XHTML and the `text/html` fixture.
 * Measured by reverting this module to a literal-only read: the whole backlink
 * suite stayed green.
 *
 * A fake element is what makes the direction checkable, because it can carry a
 * namespaced attribute with NO literal counterpart — a shape a real parser
 * never produces, and exactly the shape that fails a one-sided read. The same
 * argument `domFake.testkit.ts` makes for keeping its two attribute tables
 * apart.
 */

const OPS = 'http://www.idpf.org/2007/ops'
const XML = 'http://www.w3.org/XML/1998/namespace'

/** An element that answers only what it was told, in the table it was told. */
function fake(options: {
  literal?: Record<string, string>
  namespaced?: Record<string, string>
  noNS?: boolean
}): Element {
  const el = {
    getAttribute: (name: string) => options.literal?.[name] ?? null,
    getAttributeNS: (namespace: string, local: string) =>
      options.namespaced?.[`${namespace}|${local}`] ?? null,
  }
  if (options.noNS) delete (el as Partial<typeof el>).getAttributeNS
  return el as unknown as Element
}

describe('epubTypes', () => {
  it('reads the namespaced attribute when only that spelling exists', () => {
    const el = fake({ namespaced: { [`${OPS}|type`]: 'noteref' } })

    expect(epubTypes(el).has('noteref')).toBe(true)
  })

  it('reads the literal attribute when only that spelling exists', () => {
    const el = fake({ literal: { 'epub:type': 'noteref' } })

    expect(epubTypes(el).has('noteref')).toBe(true)
  })

  /* The namespaced one WINS when both are present, which is what makes the
   * order in `attribute` load-bearing rather than incidental. */
  it('prefers the namespaced spelling when a document carries both', () => {
    const el = fake({
      literal: { 'epub:type': 'backlink' },
      namespaced: { [`${OPS}|type`]: 'noteref' },
    })

    expect([...epubTypes(el)]).toEqual(['noteref'])
  })

  /* `epub:type` is a SPACE-SEPARATED token list in EPUB 3, and books use it as
   * one: `epub:type="noteref footnote"`. A reader that compared the whole
   * attribute would see neither token. */
  it('splits a multi-token value into its tokens', () => {
    const el = fake({ literal: { 'epub:type': '  noteref   footnote ' } })

    expect([...epubTypes(el)].sort()).toEqual(['footnote', 'noteref'])
  })

  it('is empty when the element declares nothing', () => {
    expect(epubTypes(fake({})).size).toBe(0)
  })

  /* An element with no `getAttributeNS` at all — a hand-built fake, an older
   * host object — must not throw the selection path over. */
  it('survives an element that has no getAttributeNS', () => {
    const el = fake({ literal: { 'epub:type': 'noteref' }, noNS: true })

    expect(() => epubTypes(el)).not.toThrow()
    expect(epubTypes(el).has('noteref')).toBe(true)
  })
})

describe('ariaRoles', () => {
  it('splits the role list, which is space-separated too', () => {
    const el = fake({ literal: { role: 'doc-noteref link' } })

    expect([...ariaRoles(el)].sort()).toEqual(['doc-noteref', 'link'])
  })

  it('is empty when there is no role', () => {
    expect(ariaRoles(fake({})).size).toBe(0)
  })
})

describe('declaredLang', () => {
  it('prefers the HTML attribute, which is what HTML itself resolves first', () => {
    const el = fake({
      literal: { lang: 'en', 'xml:lang': 'zh' },
      namespaced: { [`${XML}|lang`]: 'ja' },
    })

    expect(declaredLang(el)).toBe('en')
  })

  it('falls back to the namespaced xml:lang an XHTML book carries', () => {
    const el = fake({ namespaced: { [`${XML}|lang`]: 'zh' } })

    expect(declaredLang(el)).toBe('zh')
  })

  it('falls back to the literal xml:lang an HTML-parsed book carries', () => {
    const el = fake({ literal: { 'xml:lang': 'zh' } })

    expect(declaredLang(el)).toBe('zh')
  })

  it('is null when the element declares no language', () => {
    expect(declaredLang(fake({}))).toBeNull()
  })
})
