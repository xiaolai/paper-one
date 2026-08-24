/**
 * `epub:type` and `role`, read the way books actually ship them.
 *
 * ## Why `getAttributeNS` alone is not enough
 *
 * `epub:type` is an attribute in the EPUB Structural Semantics namespace, and
 * in an XHTML document that is where it lands. **foliate does not always get an
 * XHTML document.** When a section fails to parse as XML it is reparsed as
 * `text/html` (`node_modules/foliate-js/epub.js`), and an HTML parser has no
 * namespaces to put it in: the attribute arrives with the literal name
 * `epub:type` in the null namespace. Measured on the same markup:
 *
 * | Parsed as | `getAttributeNS(OPS,'type')` | `getAttribute('epub:type')` |
 * |---|---|---|
 * | `text/html` | `null` | `"noteref"` |
 * | `application/xhtml+xml` | `"noteref"` | `"noteref"` |
 *
 * Invalid XHTML is exactly the condition that sends a book down the HTML path,
 * so the books most likely to need the semantics are the ones where the
 * namespaced read returns nothing. Both spellings are read here, in one place,
 * because the alternative is every caller remembering — and the first two
 * callers did not: `backlink.ts` read only the namespaced form for a phase, and
 * its tests passed because the test helper parsed as XHTML.
 */

/** The EPUB Structural Semantics namespace, where `epub:type` lives. */
const OPS = 'http://www.idpf.org/2007/ops'

function tokens(value: string | null | undefined): Set<string> {
  return new Set(value?.split(/\s+/).filter(Boolean) ?? [])
}

/** An attribute, in its namespace or under its literal name — see above. */
function attribute(el: Element, namespace: string, local: string, literal: string): string | null {
  const namespaced =
    typeof el.getAttributeNS === 'function' ? el.getAttributeNS(namespace, local) : null
  return namespaced ?? el.getAttribute(literal)
}

/** The `epub:type` tokens on an element, however the document was parsed. */
export function epubTypes(el: Element): Set<string> {
  return tokens(attribute(el, OPS, 'type', 'epub:type'))
}

/** The ARIA `role` tokens on an element. */
export function ariaRoles(el: Element): Set<string> {
  return tokens(el.getAttribute('role'))
}

/** The XML namespace, where `xml:lang` lives in an XHTML document. */
const XML = 'http://www.w3.org/XML/1998/namespace'

/**
 * The language declared ON this element, or null when it declares none.
 *
 * `lang` first, then `xml:lang`, which is the order HTML itself resolves them
 * in — and the second is read both ways for the same reason `epub:type` is.
 */
export function declaredLang(el: Element): string | null {
  return el.getAttribute('lang') ?? attribute(el, XML, 'lang', 'xml:lang')
}
