import { describe, expect, it } from 'vitest'
import { formatOf, isFormat, isPdf, sniffFormat, titleFromSource } from './formats'

/**
 * The routing decision, which lives in `core/formats.ts` rather than in
 * `ui/reader/makePdf.ts` — importing the latter pulls in pdf.js, which touches
 * browser globals (DOMMatrix) the moment it loads and cannot be imported in
 * this environment at all. The rest of `makePdf.ts` needs a real PDF and a
 * worker, so it is verified against the running app instead, per the project's
 * e2e note.
 *
 * This much is worth pinning because getting it wrong is silent in the worst
 * way: a PDF sent to foliate is rejected as an unsupported type, and an EPUB
 * sent to pdf.js fails to parse. Neither says which reader made the mistake.
 */

describe('isPdf', () => {
  it('routes a .pdf file by name', () => {
    expect(isPdf(new File([], 'paper.pdf'))).toBe(true)
  })

  it('routes by MIME type even when the name does not say so', () => {
    // Downloads and drag-and-drop both produce these.
    expect(isPdf(new File([], 'download', { type: 'application/pdf' }))).toBe(true)
  })

  it('leaves every other format to foliate', () => {
    expect(isPdf(new File([], 'moby.epub'))).toBe(false)
    expect(isPdf(new File([], 'book.mobi'))).toBe(false)
    expect(isPdf('/books/moby.epub')).toBe(false)
  })

  it('is not fooled by a name that merely contains pdf', () => {
    expect(isPdf(new File([], 'pdf-notes.epub'))).toBe(false)
    expect(isPdf('/library/pdfs/moby.epub')).toBe(false)
  })

  it('routes a URL, including one carrying a query or fragment', () => {
    expect(isPdf('/papers/attention.pdf')).toBe(true)
    expect(isPdf('https://example.com/a.pdf?download=1')).toBe(true)
    expect(isPdf('https://example.com/a.pdf#page=4')).toBe(true)
  })

  it('is case-insensitive, as file systems are not', () => {
    expect(isPdf(new File([], 'SCAN.PDF'))).toBe(true)
    expect(isPdf('/x/SCAN.Pdf')).toBe(true)
  })
})

describe('titleFromSource', () => {
  it('falls back to the file name without its extension', () => {
    expect(titleFromSource(new File([], 'attention-is-all-you-need.pdf'))).toBe(
      'attention-is-all-you-need',
    )
  })

  it('takes the last path segment of a URL', () => {
    expect(titleFromSource('/papers/1706.03762.pdf')).toBe('1706.03762')
  })

  it('drops a query string, which isPdf accepts', () => {
    // The extension pattern is anchored at the end of the string, so anything
    // after it left the `.pdf` in the title the reader sees.
    expect(titleFromSource('https://arxiv.org/papers/1706.03762.pdf?download=1')).toBe(
      '1706.03762',
    )
  })

  it('drops a fragment too', () => {
    expect(titleFromSource('/papers/1706.03762.pdf#page=3')).toBe('1706.03762')
  })
})

/* ------------------------------------------------------------------------ */
/* Byte sniffing                                                            */
/* ------------------------------------------------------------------------ */

const utf8 = (text: string) => new TextEncoder().encode(text)

/**
 * A minimal, STORED (uncompressed) ZIP: local file headers only, which is
 * exactly the part `sniffFormat` walks. Real enough that the offsets and
 * lengths mean what a real archive's would.
 */
function zipOf(entries: readonly { name: string; data?: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const entry of entries) {
    const name = utf8(entry.name)
    const data = entry.data ?? new Uint8Array(0)
    const header = new Uint8Array(30 + name.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true) // version needed
    view.setUint16(8, 0, true) // stored
    view.setUint32(18, data.length, true) // compressed size
    view.setUint32(22, data.length, true) // uncompressed size
    view.setUint16(26, name.length, true)
    header.set(name, 30)
    parts.push(header, data)
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** A PalmDB/MOBI head: `BOOKMOBI` at 60, record 0 at `record0` holding a MOBI
 *  header with the given file version. */
function mobiOf(version: number): Uint8Array {
  const record0 = 100
  const bytes = new Uint8Array(record0 + 16 + 40 + 8)
  bytes.set(utf8('BOOKMOBI'), 60)
  const view = new DataView(bytes.buffer)
  view.setUint32(78, record0, false)
  bytes.set(utf8('MOBI'), record0 + 16)
  view.setUint32(record0 + 16 + 36, version, false)
  return bytes
}

describe('sniffFormat', () => {
  it('knows a PDF by its header', () => {
    expect(sniffFormat(utf8('%PDF-1.7\n…'))).toBe('pdf')
  })

  it('knows an EPUB by the mimetype entry leading its ZIP', () => {
    const epub = zipOf([
      { name: 'mimetype', data: utf8('application/epub+zip') },
      { name: 'META-INF/container.xml', data: utf8('<container/>') },
    ])
    expect(sniffFormat(epub)).toBe('epub')
  })

  it('calls a ZIP without the leading mimetype a CBZ', () => {
    expect(sniffFormat(zipOf([{ name: 'page-001.png' }, { name: 'page-002.png' }]))).toBe('cbz')
    // Even one that CONTAINS a mimetype entry later — the EPUB spec requires
    // it first, so anywhere else it does not make the archive an EPUB.
    expect(sniffFormat(zipOf([{ name: 'page-001.png' }, { name: 'mimetype' }]))).toBe('cbz')
  })

  it('calls a ZIP holding a .fb2 an FBZ', () => {
    expect(sniffFormat(zipOf([{ name: 'book.fb2', data: utf8('<FictionBook/>') }]))).toBe('fbz')
  })

  it('tells MOBI and AZW3 apart by the KF8 version', () => {
    expect(sniffFormat(mobiOf(6))).toBe('mobi')
    expect(sniffFormat(mobiOf(8))).toBe('azw3')
  })

  it('falls back to mobi when the record is out of reach', () => {
    const short = new Uint8Array(70)
    short.set(utf8('BOOKMOBI'), 60)
    expect(sniffFormat(short)).toBe('mobi')
  })

  it('knows a bare FB2 by its XML prologue and root element', () => {
    expect(sniffFormat(utf8('<?xml version="1.0"?>\n<FictionBook xmlns="…">'))).toBe('fb2')
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('<?xml version="1.0"?><FictionBook>')])
    expect(sniffFormat(bom)).toBe('fb2')
  })

  it('answers null for bytes it does not recognise', () => {
    expect(sniffFormat(utf8('just some text'))).toBeNull()
    expect(sniffFormat(new Uint8Array(0))).toBeNull()
    expect(sniffFormat(utf8('<?xml version="1.0"?><html/>'))).toBeNull()
  })

  it('does not throw on a truncated or lying archive', () => {
    const epub = zipOf([{ name: 'mimetype', data: utf8('application/epub+zip') }])
    expect(sniffFormat(epub.subarray(0, 8))).toBe('cbz') // a ZIP of some kind, unreadably short
    const lying = zipOf([{ name: 'mimetype' }])
    // Compressed size pointing past the end just stops the walk.
    new DataView(lying.buffer).setUint32(18, 99999, true)
    expect(sniffFormat(lying)).toBe('epub')
  })
})

describe('formatOf', () => {
  it('prefers the bytes over the name', () => {
    expect(formatOf(utf8('%PDF-1.4'), 'book.epub')).toBe('pdf')
  })

  it('falls back to the extension when the bytes say nothing', () => {
    expect(formatOf(utf8('mystery'), 'book.EPUB')).toBe('epub')
    expect(formatOf(utf8('mystery'), 'book.fb2')).toBe('fb2')
  })

  it('answers bin for no name, an unknown extension, or a literal .bin', () => {
    expect(formatOf(utf8('mystery'), null)).toBe('bin')
    expect(formatOf(utf8('mystery'), 'book.txt')).toBe('bin')
    expect(formatOf(utf8('mystery'), 'book.bin')).toBe('bin')
    expect(formatOf(utf8('mystery'), 'no-extension')).toBe('bin')
  })
})

describe('isFormat', () => {
  it('accepts exactly the closed list', () => {
    for (const one of ['epub', 'pdf', 'mobi', 'azw3', 'cbz', 'fb2', 'fbz', 'bin']) expect(isFormat(one)).toBe(true)
    expect(isFormat('txt')).toBe(false)
    expect(isFormat('EPUB')).toBe(false)
    expect(isFormat(7)).toBe(false)
  })
})
