/**
 * Real EPUBs, built in memory, for tests that need the REAL fork to open one.
 *
 * Everything else in this directory fakes the view, and rightly: the session's
 * lifecycle is about awaits and disposal, not about zips. But WI-20.13's
 * question — "does the fork open a book with an obfuscated font, and does
 * Paper refuse one with an encrypted chapter" — is a question about what
 * `epub.js` does with `META-INF/encryption.xml`, and a fake that answered it
 * would be answering for the fork. So this writes a minimal, valid EPUB 3 as
 * bytes and hands it to `makeBook`.
 *
 * STORE-ONLY, no compression, for two reasons: the spec requires `mimetype`
 * stored first anyway, and a stored entry needs no inflater — the fork's zip
 * reader decodes it with nothing but a slice. CRC-32 is written by hand rather
 * than imported from `node:zlib` so this file, like every other testkit in the
 * kernel, carries no Node types.
 */

interface Entry {
  readonly name: string
  readonly data: Uint8Array | string
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const encoder = new TextEncoder()
const bytesOf = (data: Uint8Array | string): Uint8Array =>
  typeof data === 'string' ? encoder.encode(data) : data

/** A zip archive with every entry stored, in the order given. */
export function storeZip(entries: readonly Entry[]): Uint8Array<ArrayBuffer> {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const data = bytesOf(entry.data)
    const crc = crc32(data)

    const local = new DataView(new ArrayBuffer(30 + name.length))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true) // version needed
    local.setUint16(6, 0, true) // flags
    local.setUint16(8, 0, true) // method: stored
    local.setUint16(10, 0, true) // time
    local.setUint16(12, 0x21, true) // date: 1980-01-01
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, name.length, true)
    local.setUint16(28, 0, true)
    new Uint8Array(local.buffer).set(name, 30)
    locals.push(new Uint8Array(local.buffer), data)

    const central = new DataView(new ArrayBuffer(46 + name.length))
    central.setUint32(0, 0x02014b50, true)
    central.setUint16(4, 20, true) // made by
    central.setUint16(6, 20, true) // needed
    central.setUint16(8, 0, true)
    central.setUint16(10, 0, true)
    central.setUint16(12, 0, true)
    central.setUint16(14, 0x21, true)
    central.setUint32(16, crc, true)
    central.setUint32(20, data.length, true)
    central.setUint32(24, data.length, true)
    central.setUint16(28, name.length, true)
    central.setUint16(30, 0, true) // extra
    central.setUint16(32, 0, true) // comment
    central.setUint16(34, 0, true) // disk
    central.setUint16(36, 0, true) // internal attrs
    central.setUint32(38, 0, true) // external attrs
    central.setUint32(42, offset, true)
    new Uint8Array(central.buffer).set(name, 46)
    centrals.push(new Uint8Array(central.buffer))

    offset += 30 + name.length + data.length
  }
  const directory = centrals.reduce((n, part) => n + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(4, 0, true)
  end.setUint16(6, 0, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, directory, true)
  end.setUint32(16, offset, true)
  end.setUint16(20, 0, true)

  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)]
  /* Over its own `ArrayBuffer`, so the result is a `BlobPart` — a view over
     an `ArrayBufferLike` is not one, and `File` refuses it at the type. */
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, part) => n + part.length, 0)))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** The paragraph the one chapter carries, for a test to find after loading. */
export const CHAPTER_TEXT = 'Call me Ishmael.'
export const CHAPTER_HREF = 'OEBPS/ch1.xhtml'
export const FONT_HREF = 'OEBPS/fonts/plain.otf'
const UID = 'urn:uuid:2b5f8a0e-2c4d-4f6a-9d3b-7e1c5a9f0d11'

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

/** A manifest item beyond the fixture's own three — a script, an image. */
export interface ExtraItem {
  /** Zip path, under `OEBPS/`. */
  readonly href: string
  readonly mediaType: string
  readonly data: Uint8Array | string
}

const opfFor = (extra: readonly ExtraItem[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${UID}</dc:identifier>
    <dc:title>A Fixture</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="font" href="fonts/plain.otf" media-type="font/otf"/>
${extra.map((one, i) => `    <item id="extra${i}" href="${one.href.replace(/^OEBPS\//, '')}" media-type="${one.mediaType}"/>`).join('\n')}
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`

const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body><nav epub:type="toc"><ol><li><a href="ch1.xhtml">One</a></li></ol></nav></body>
</html>`

const CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head>
<body><p>${CHAPTER_TEXT}</p></body></html>`

/** `encryption.xml` naming the font under the IDPF obfuscation the fork decodes. */
export const IDPF_FONT_ENCRYPTION = `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
    <enc:CipherData><enc:CipherReference URI="${FONT_HREF}"/></enc:CipherData>
  </enc:EncryptedData>
</encryption>`

/** `encryption.xml` as Adobe Content Server writes it: the chapter under
 *  AES, keyed by an ADEPT resource. */
export const ADEPT_CHAPTER_ENCRYPTION = `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
    <EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
    <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
      <resource xmlns="http://ns.adobe.com/adept">urn:uuid:5a2c1f0e-0000-4000-8000-000000000001</resource>
    </KeyInfo>
    <CipherData><CipherReference URI="${CHAPTER_HREF}"/></CipherData>
  </EncryptedData>
</encryption>`

/** `encryption.xml` as Readium LCP writes it. */
export const LCP_CHAPTER_ENCRYPTION = `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
    <EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/>
    <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
      <RetrievalMethod URI="license.lcpl#/encryption/content_key" Type="http://readium.org/2014/01/lcp#EncryptedContentKey"/>
    </KeyInfo>
    <CipherData><CipherReference URI="${CHAPTER_HREF}"/></CipherData>
  </EncryptedData>
</encryption>`

/**
 * A valid one-chapter EPUB 3 carrying one font, with the given
 * `META-INF/encryption.xml` (or none). `chapter` overrides the chapter's
 * bytes — an encrypted one is ciphertext, and a test that wants the fork to
 * see what a real DRM'd file looks like passes noise.
 */
export function epubFixture(
  options: { encryption?: string; chapter?: Uint8Array | string; extra?: readonly ExtraItem[] } = {},
): File {
  const font = new Uint8Array(2048)
  for (let i = 0; i < font.length; i += 1) font[i] = (i * 7) & 0xff
  const extra = options.extra ?? []
  const entries: Entry[] = [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opfFor(extra) },
    { name: 'OEBPS/nav.xhtml', data: NAV },
    { name: CHAPTER_HREF, data: options.chapter ?? CHAPTER },
    { name: FONT_HREF, data: font },
    ...extra.map((one) => ({ name: one.href, data: one.data })),
  ]
  if (options.encryption) entries.splice(2, 0, { name: 'META-INF/encryption.xml', data: options.encryption })
  const bytes = storeZip(entries)
  return new File([bytes], 'fixture.epub', { type: 'application/epub+zip' })
}

/** Bytes no parser will read as XHTML — what an encrypted chapter looks like. */
export function ciphertext(length = 512): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) out[i] = (i * 131 + 17) & 0xff
  return out
}
