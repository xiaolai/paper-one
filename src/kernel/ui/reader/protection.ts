/**
 * Whether an opened book is PROTECTED — encrypted under a scheme this reader
 * cannot decode — and what to tell the reader about it.
 *
 * WHY THIS EXISTS. The fork already reads `META-INF/encryption.xml`
 * (`epub.js`, `Encryption.init`): it knows the two font-obfuscation
 * algorithms EPUB permits — IDPF's and Adobe's — and decodes them, and for
 * any other algorithm it warns "Unknown encryption algorithm" and hands the
 * resource through AS CIPHERTEXT. Paper never acted on that. So a DRM'd EPUB
 * — ADEPT from Adobe Content Server, LCP from Readium — opened as a normal
 * book, with its title and its contents, and rendered its chapters as noise:
 * a page of garbage with nothing anywhere saying why, and the reader left to
 * wonder whether the file or the app was broken.
 *
 * THE RULE IS NARROW ON PURPOSE. Refuse only when a CONTENT DOCUMENT — a
 * spine item — is encrypted under an algorithm the fork cannot decode. A font
 * under an algorithm it CAN decode is the ordinary case (every EPUB with an
 * obfuscated font, which is most of the ones with embedded fonts at all); a
 * font or an image under one it cannot is a book that reads fine with the
 * publisher's face or a picture missing. Refusing those would refuse ordinary
 * books, which is the risk the plan names and the reason this is not "any
 * unknown algorithm anywhere".
 *
 * SAME ELEMENT LIST AS THE FORK, read after the fork has parsed the archive,
 * through the `loadText` the fork's own EPUB object exposes — so this is not
 * a second zip parse and not a second grammar for `encryption.xml`. It reads
 * the same elements `Encryption.init` reads and decides the one thing the
 * fork does not.
 *
 * THE ROW STAYS. A refused book is not removed from the shelf: the reader can
 * see what they have, and take it to a reader that holds the licence.
 */

/** The algorithms `epub.js` decodes — its `deobfuscators` table, by URI. */
export const DECODABLE_ALGORITHMS: ReadonlySet<string> = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
])

/**
 * The schemes worth naming, by the namespace their `KeyInfo` carries.
 *
 * The ALGORITHM does not identify a scheme — ADEPT and LCP are both AES-CBC —
 * and the reader is not helped by "aes128-cbc". What tells them apart is who
 * holds the key: ADEPT keys a chapter by an Adobe `resource`, LCP by a
 * Readium licence. Anything else is named by its algorithm, which is at least
 * a term to search for.
 */
const SCHEMES: readonly { readonly ns: string; readonly name: string }[] = [
  { ns: 'http://ns.adobe.com/adept', name: 'ADEPT' },
  { ns: 'http://readium.org/2014/01/lcp', name: 'LCP' },
]

const NS_ENC = 'http://www.w3.org/2001/04/xmlenc#'
const ENCRYPTION_XML = 'META-INF/encryption.xml'

/** What the reader is told. One sentence, and the scheme by name. */
export function protectionMessage(scheme: string): string {
  return `This book is protected by ${scheme} and cannot be opened here.`
}

/**
 * The opened book, as much of it as the check needs: the fork's EPUB object
 * exposes `loadText` for the archive and `sections` whose `id` is the spine
 * item's resolved href — the same string `encryption.xml` names. A book that
 * is not a zip (a PDF, a MOBI, a bare FB2) has no `loadText`, and no
 * `encryption.xml` to read.
 */
export interface OpenedBook {
  readonly loadText?: (name: string) => Promise<string | null>
  /* `unknown`, because that is how the fork's types spell a section; the
     `id` is read off each one that has a string there. */
  readonly sections?: readonly unknown[]
}

/** Why this book must not be shown, or null. */
export async function protectionOf(book: OpenedBook): Promise<string | null> {
  if (typeof book.loadText !== 'function') return null
  const xml = await book.loadText(ENCRYPTION_XML)
  if (!xml) return null
  const hrefs = (book.sections ?? []).flatMap((section) => {
    const id = typeof section === 'object' && section !== null ? (section as { id?: unknown }).id : undefined
    return typeof id === 'string' ? [id] : []
  })
  const scheme = protectedScheme(xml, hrefs)
  return scheme === null ? null : protectionMessage(scheme)
}

/**
 * The scheme protecting a content document, or null when every encrypted
 * resource is either decodable or not a content document.
 *
 * A file that is not XML answers null: a malformed `encryption.xml` is not
 * evidence of DRM, and the fork opens such a book as it always did.
 */
export function protectedScheme(encryptionXml: string, contentHrefs: readonly string[]): string | null {
  const doc = new DOMParser().parseFromString(encryptionXml, 'application/xml')
  /* Both spellings of every href, because a `CipherReference` may be
     percent-encoded where the OPF's manifest was not, and the fork resolves
     the manifest's form. */
  const content = new Set(contentHrefs.flatMap((href) => [href, decoded(href)]))
  for (const data of Array.from(doc.getElementsByTagNameNS(NS_ENC, 'EncryptedData'))) {
    const algorithm =
      data.getElementsByTagNameNS(NS_ENC, 'EncryptionMethod')[0]?.getAttribute('Algorithm') ?? ''
    if (DECODABLE_ALGORITHMS.has(algorithm)) continue
    const uri = data.getElementsByTagNameNS(NS_ENC, 'CipherReference')[0]?.getAttribute('URI') ?? ''
    if (!content.has(uri) && !content.has(decoded(uri))) continue
    return schemeOf(data, algorithm)
  }
  return null
}

function decoded(href: string): string {
  try {
    return decodeURIComponent(href)
  } catch {
    return href
  }
}

/** The scheme's name from what the element carries, else the algorithm. */
function schemeOf(data: Element, algorithm: string): string {
  const carried: string[] = []
  const walk = (element: Element): void => {
    carried.push(element.namespaceURI ?? '')
    for (const attribute of Array.from(element.attributes)) carried.push(attribute.value)
    for (const child of Array.from(element.children)) walk(child)
  }
  walk(data)
  for (const { ns, name } of SCHEMES) {
    if (carried.some((value) => value.startsWith(ns))) return name
  }
  return algorithm || 'an unknown scheme'
}
