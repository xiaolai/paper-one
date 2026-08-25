/**
 * What the reader accepts.
 *
 * `.pdf` is here again. It was withdrawn once because foliate-js has no PDF
 * loader and rejected every PDF as an unsupported type — a picker offering a
 * format the app then refused. It comes back in the same change that gives PDFs
 * a reader of their own, which is the condition it was withdrawn under.
 *
 * It lives here rather than beside the file input because the input belongs to
 * the window — the palette, the switcher and the reader's empty state can all
 * ask for books, so there is one picker rather than one per surface.
 */
export const ACCEPT_FORMATS = '.epub,.pdf,.mobi,.azw3,.cbz,.fb2,.fbz'

/**
 * Anything a reader can be pointed at that is not a URL.
 *
 * A `File` normally, and since phase 18 also a RANGED source — a book whose
 * bytes are on the shelf rather than in this browser, opened through a pdf.js
 * range transport. Both carry a `name`, which is all the routing below needs;
 * spelling the shape structurally rather than naming pdf.js keeps half a
 * megabyte of PDF code out of every module that merely asks what a file is.
 */
export interface NamedSource {
  readonly name: string
}

/**
 * A source whose BYTES ARE NOT HERE — the browser client's PDF.
 *
 * `range` is a `PDFDataRangeTransport`, typed as `object` so this module stays
 * free of pdf.js (see `NamedSource` above for why that matters). `makePdf`
 * narrows it to the real type at the one place that has already paid for the
 * import.
 */
export interface RangedSource extends NamedSource {
  readonly range: object
}

/**
 * Whether this source carries a transport instead of bytes.
 *
 * ONE PREDICATE, shared, because two consumers must agree: `makePdf` uses it to
 * choose what to hand `getDocument`, and the reader uses it to REFUSE a ranged
 * source that is not a PDF. Only pdf.js can read one — foliate opens a `File`
 * or a URL and nothing else — so a ranged EPUB would reach `view.open` as a
 * plain object and be reported as a book that could not be opened, which sends
 * the reader looking at the book.
 */
export type BookSource = File | string | RangedSource

export const isRanged = (source: BookSource): source is RangedSource =>
  typeof source !== 'string' && 'range' in source

/**
 * Which of the two readers a source belongs to.
 *
 * Here rather than in `reader/pdf.ts` because that module imports pdf.js, which
 * touches browser globals the moment it loads — so anything importing it needs
 * a DOM, including a test that only wants to know whether a filename ends in
 * `.pdf`. Routing is a question about the source, not about the renderer.
 *
 * Getting it wrong is silent in the worst way: a PDF handed to foliate is
 * rejected as an unsupported type, an EPUB handed to pdf.js fails to parse, and
 * neither says which reader made the mistake.
 */
export function isPdf(source: BookSource): boolean {
  if (typeof source === 'string') return /\.pdf(\?|#|$)/i.test(source)
  /* `type` IS THE STRONGER SIGNAL and only a `File` has one — a picked file
   * may be named without an extension and still declare itself a PDF. A ranged
   * source has a name and no type, so it falls to the suffix, which is what
   * the shelf stored the book under. */
  const declared = 'type' in source && source.type === 'application/pdf'
  return declared || /\.pdf$/i.test(source.name)
}

/**
 * A file name without its extension, for a PDF that carries no title.
 *
 * The query and the fragment come off first. `isPdf` accepts them — a URL
 * ending `.pdf?download=1` is a PDF — so a title taken straight from the last
 * path segment kept them, and the library showed the book as
 * `attention-is-all-you-need.pdf?download=1`: the extension still on it,
 * because the pattern that strips it anchors at the end of the string.
 */
export function titleFromSource(source: BookSource): string {
  const name =
    typeof source === 'string'
      ? (source.split(/[?#]/)[0] ?? source).split('/').pop() || source
      : source.name
  return name.replace(/\.pdf$/i, '')
}

/* ------------------------------------------------------------------------ */
/* Content formats — what the bytes ARE, as distinct from what the file is  */
/* called                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * The formats a book's content can be, as a closed list.
 *
 * This is the value that TRAVELS between devices (`BookRecord.format`): a
 * phone that imported `book.bin` from a picker that gave it no filename and
 * a Mac that imported the same bytes as `moby.epub` hold one book, and both
 * have to know which reader opens it. The storage extension (`ext`) says how
 * THIS device named its copy and stays at home. `bin` is the honest answer
 * for bytes nothing here recognises — the same fallback `bookVault` uses for
 * a name it does not know.
 */
export const FORMATS = ['epub', 'pdf', 'mobi', 'azw3', 'cbz', 'fb2', 'fbz', 'bin'] as const
export type Format = (typeof FORMATS)[number]

export function isFormat(value: unknown): value is Format {
  return typeof value === 'string' && (FORMATS as readonly string[]).includes(value)
}

const ascii = (bytes: Uint8Array, at: number, text: string): boolean => {
  if (at + text.length > bytes.length) return false
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false
  return true
}

/** The first `n` bytes as Latin-1 text, for the signatures that are text. */
const head = (bytes: Uint8Array, n: number): string => {
  let out = ''
  const stop = Math.min(n, bytes.length)
  for (let i = 0; i < stop; i++) out += String.fromCharCode(bytes[i]!)
  return out
}

/**
 * The names inside a ZIP, from its local file headers, up to `limit` entries.
 *
 * Local headers rather than the central directory: the central directory sits
 * at the END of the archive and would mean reading the whole book to learn
 * its kind, whereas the local headers are at the front and the entry that
 * decides between EPUB and CBZ (`mimetype`) is, by the EPUB specification,
 * the FIRST one. A malformed archive stops the walk rather than throwing:
 * whatever was found decides, and nothing found means "a ZIP of some kind".
 */
function zipNames(bytes: Uint8Array, limit = 64): string[] {
  const names: string[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  while (names.length < limit && at + 30 <= bytes.length) {
    // Local file header: PK\x03\x04
    if (view.getUint32(at, true) !== 0x04034b50) break
    const compressed = view.getUint32(at + 18, true)
    const nameLength = view.getUint16(at + 26, true)
    const extraLength = view.getUint16(at + 28, true)
    const nameStart = at + 30
    if (nameStart + nameLength > bytes.length) break
    names.push(head(bytes.subarray(nameStart, nameStart + nameLength), nameLength))
    /* A data descriptor (bit 3) means the sizes are written AFTER the data,
     * and the header's compressed size is zero — the walk cannot step over
     * an entry it cannot measure, so it stops with what it has. */
    const flags = view.getUint16(at + 6, true)
    if (flags & 0x0008) break
    at = nameStart + nameLength + extraLength + compressed
  }
  return names
}

/**
 * What the bytes are, from the bytes — the primary router.
 *
 * Signatures, in the order they are cheapest to refuse:
 *
 *   `%PDF`                        PDF
 *   `PK\x03\x04` + `mimetype`      EPUB when the archive's first entry is the
 *                                  EPUB mimetype; otherwise a ZIP holding a
 *                                  `.fb2` is FBZ, and any other ZIP is CBZ
 *   `BOOKMOBI` at offset 60       MOBI or AZW3, told apart by the KF8 flag —
 *                                  and when the record cannot be read that far,
 *                                  MOBI, which both readers accept
 *   `<?xml` … `<FictionBook`      FB2
 *
 * `null` when nothing matches: the caller falls back to the name it was given
 * (`formatOf`). The head of the file is enough for every signature here, so a
 * caller with a large book need only hand over its first few kilobytes — but
 * a ZIP whose first entries are large will yield fewer names, and an EPUB
 * whose `mimetype` is not first is refused as EPUB by its own specification.
 */
export function sniffFormat(bytes: Uint8Array): Format | null {
  if (ascii(bytes, 0, '%PDF')) return 'pdf'
  if (ascii(bytes, 0, 'PK\x03\x04')) {
    const names = zipNames(bytes)
    if (names[0] === 'mimetype') return 'epub'
    if (names.some((name) => /\.fb2$/i.test(name))) return 'fbz'
    return 'cbz'
  }
  if (ascii(bytes, 60, 'BOOKMOBI')) {
    /* The MOBI header follows the 78-byte PalmDOC header at the first record's
     * offset (a big-endian u32 at byte 78). Its file version is a u32 at
     * header+36; version 8 is KF8, which is what an `.azw3` holds. Older
     * files, and any whose first record is out of reach, are MOBI. */
    if (bytes.length >= 82) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const record0 = view.getUint32(78, false)
      if (record0 + 16 + 40 <= bytes.length && ascii(bytes, record0 + 16, 'MOBI')) {
        const version = view.getUint32(record0 + 16 + 36, false)
        return version >= 8 ? 'azw3' : 'mobi'
      }
    }
    return 'mobi'
  }
  // A UTF-8 byte order mark is not part of the document; step over one.
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  const text = head(bytes.subarray(bom), 1024)
  if (/^\s*<\?xml/i.test(text) && /<FictionBook[\s>]/i.test(text)) return 'fb2'
  return null
}

/**
 * The format of a book: sniffed from its bytes first, and only when the
 * bytes say nothing, taken from its name — the fallback for an import that
 * carries a name and no recognisable signature.
 */
export function formatOf(bytes: Uint8Array, name: string | null | undefined): Format {
  const sniffed = sniffFormat(bytes)
  if (sniffed) return sniffed
  const last = name ? name.lastIndexOf('.') : -1
  const ext = last < 0 ? '' : name!.slice(last + 1).toLowerCase()
  return isFormat(ext) && ext !== 'bin' ? ext : 'bin'
}
