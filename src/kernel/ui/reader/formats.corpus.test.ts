// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { recordFromMeta } from '../../core/bookFolder'
import { readMeta } from './session'

/**
 * WI-24.A2 — **every format the picker offers, opened.**
 *
 * `ACCEPT_FORMATS` offers `.epub,.pdf,.mobi,.azw3,.cbz,.fb2,.fbz`. EPUB and PDF
 * are exercised all over this tree. The other five were exercised **nowhere** —
 * no test, no manual pass — which is the whole of why the feature ledger's
 * `MOBI / AZW3 / CBZ / FB2` row was Partial. This is the test half; the paint
 * half is WI-24.A3, in the running app, because no jsdom can answer it.
 *
 * ⚠️ **THE LEDGER ROW NAMES FOUR AND THE PICKER OFFERS FIVE.** `.fbz` — a
 * zipped FB2 — has been on the accept list the whole time and was in no row, no
 * test and no plan.
 *
 * ## The fixtures are files, and the expectations are written out here
 *
 * `tests/fixtures/` is committed and `scripts/make-format-fixtures.mjs` makes
 * it. This file **does not import that script**: an edge from `src/kernel/` to a
 * build script points the wrong way, `tsc` cannot type an untyped `.mjs` across
 * it, and — the reason that matters most — a test that imports its expectations
 * from the thing that produced them asserts only that one module is
 * self-consistent. The titles and watchwords below are spelled out so that a
 * regenerated fixture which changed them FAILS rather than agreeing with itself.
 *
 * ## What this asserts, and at what level
 *
 * ⚠️ **THROUGH `readMeta`, NOT AGAINST foliate's RAW METADATA.** What matters is
 * what PAPER ends up with, and the two are not the same shape — measured here,
 * not assumed:
 *
 * | Format | `metadata.author` as foliate hands it over |
 * |---|---|
 * | EPUB | `"Fixture Wright"` — a bare string |
 * | FB2, FBZ | `[{ name, sortAs }]` — an array of objects |
 * | MOBI, AZW3 | `["Fixture Wright"]` — an array of strings |
 * | CBZ | absent entirely |
 *
 * Three shapes for one field. `readMeta`'s `text()` folds all of them and its
 * docstring says so — but "the code says it handles this" and "a book in this
 * format has been through it" are different claims, and only the second is
 * evidence. That is the whole point of this file.
 *
 * ## CBZ is asserted differently, and that is not an oversight
 *
 * A comic is a zip of images: no title, no author, no text. `comic-book.js`
 * names it after the file and makes one section per image. So it is asserted on
 * SHAPE — the page count — and on the title `recordFromMeta` gives it, which is
 * the one place a format-specific defect has already been found and fixed
 * (`titleAsParsed`: "Batman.cbz" → "Batman.cbz.cbz" → "Batman.cbz.cbz.cbz", one
 * extension per open).
 */

const FIXTURES = join(process.cwd(), 'tests', 'fixtures')

/** The author every fixture declares — one name, so a wrong-file failure surfaces in the title or the watchword instead. */
const AUTHOR = 'Fixture Wright'

/**
 * Every fixture's own nonce. **No two are the same**, so a loader that fell
 * through to another format, or a case pointed at a stale path, fails rather
 * than passes — which is why MOBI and AZW3 are converted from SEPARATE source
 * EPUBs rather than sharing one.
 */
const WATCHWORDS = {
  epub: 'quernstone',
  mobi: 'marlinspike',
  azw3: 'sarsaparilla',
  fb2: 'fenugreek',
  fbz: 'halyard',
} as const

type TextFormat = keyof typeof WATCHWORDS

const titleOf = (format: string) => `Paper Format Fixture ${format.toUpperCase()}`
const sentenceOf = (format: TextFormat) =>
  `This fixture is ${format.toUpperCase()} and its watchword is ${WATCHWORDS[format]}.`

/** Pages in the CBZ fixture — `make-format-fixtures.mjs` writes exactly this many. */
const CBZ_PAGES = 3

/**
 * jsdom has no object URLs, and `fb2.js` calls `URL.createObjectURL`.
 *
 * ⚠️ **A HARNESS GAP, NOT A PAPER DEFECT** — every real webview has this, and
 * WebKit is what the app runs in. Recorded rather than worked around silently,
 * because the next reader of a red FB2 case needs to know which of the two they
 * are looking at.
 */
beforeAll(() => {
  const held = new Map<string, Blob>()
  let issued = 0
  const url = URL as unknown as {
    createObjectURL: (blob: Blob) => string
    revokeObjectURL: (href: string) => void
  }
  url.createObjectURL = (blob) => {
    const href = `blob:paper-test/${(issued += 1)}`
    held.set(href, blob)
    return href
  }
  url.revokeObjectURL = (href) => {
    held.delete(href)
  }
})

interface OpenedBook {
  readonly metadata?: unknown
  readonly sections?: readonly { createDocument?: () => Promise<Document> }[]
  readonly toc?: readonly unknown[]
}

/** A fixture's bytes as an `ArrayBuffer` — `File` takes one, and a `Buffer`'s view is not assignable to `BlobPart`. */
function bytesOf(name: string): ArrayBuffer {
  const buffer = readFileSync(join(FIXTURES, name))
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

/** Through `makeBook`, which is the ROUTING under test — the app hands `view.open` a File, and this is what it does with one. */
async function open(name: string, bytes: ArrayBuffer = bytesOf(name)): Promise<OpenedBook> {
  const { makeBook } = (await import('foliate-js/view.js')) as {
    makeBook: (file: File) => Promise<OpenedBook>
  }
  return await makeBook(new File([bytes], name))
}

/** The text of a book's first section, as the reader would see it. */
async function firstSectionText(book: OpenedBook): Promise<string> {
  const doc = await book.sections?.[0]?.createDocument?.()
  return doc?.body?.textContent?.trim() ?? ''
}

const TEXT_FORMATS: readonly { readonly format: TextFormat; readonly file: string }[] = [
  { format: 'epub', file: 'fixture.epub' },
  { format: 'fb2', file: 'fixture.fb2' },
  { format: 'fbz', file: 'fixture.fbz' },
  { format: 'mobi', file: 'fixture.mobi' },
  { format: 'azw3', file: 'fixture.azw3' },
]

describe('every format the picker offers', () => {
  describe.each(TEXT_FORMATS)('$format', ({ format, file }) => {
    it('reaches Paper with its title and its author', async () => {
      const meta = readMeta(await open(file))
      expect(meta.title).toBe(titleOf(format))
      /* THE ONE ASSERTION THAT PROVES THE THREE SHAPES FOLD. A raw
         `metadata.author` here would be `[{name}]` for FB2 and `[string]` for
         MOBI, and neither equals the name. */
      expect(meta.author).toBe(AUTHOR)
    })

    it('carries its OWN watchword into the first section', async () => {
      const text = await firstSectionText(await open(file))
      expect(text).toContain(sentenceOf(format))
      /* AND NOBODY ELSE'S. A loader that fell through to a different fixture
         would satisfy the line above only if it also renamed the book, so this
         is the cheap half of the same guard — and it is the half that catches a
         cache serving the previous case's document. */
      for (const [other, word] of Object.entries(WATCHWORDS)) {
        if (other !== format) expect(text).not.toContain(word)
      }
    })

    it('has more than one section, so a stub loader cannot pass', async () => {
      /* Not an exact count: `ebook-convert` adds a cover and a generated TOC, so
         MOBI arrives with four sections and AZW3 with three where the source
         EPUB had two. The claim worth holding is that the spine was READ, and
         "more than one" is that claim without pinning Calibre's layout. */
      const book = await open(file)
      expect(book.sections?.length ?? 0).toBeGreaterThan(1)
      expect(book.toc?.length ?? 0).toBeGreaterThan(0)
    })
  })

  describe('cbz', () => {
    it('is one section per image', async () => {
      expect((await open('fixture.cbz')).sections?.length).toBe(CBZ_PAGES)
    })

    it('loses the extension its parser put in the title', async () => {
      /* `comic-book.js` titles a comic after the file it was handed, extension
         and all, and the vault hands back `${title}.${ext}` — so without
         `titleAsParsed` the title grows one `.cbz` per open, for ever. */
      const meta = readMeta(await open('fixture.cbz'))
      expect(meta.title).toBe('fixture.cbz')
      expect(recordFromMeta(meta, { name: 'fixture.cbz' }).title).toBe('fixture')
    })

    it('has no author to find, and says so rather than inventing one', async () => {
      expect(readMeta(await open('fixture.cbz')).author).toBe('')
    })
  })

  /**
   * ⚠️ **THE KNOWN NEGATIVE, and it is why the cases above may be believed.**
   *
   * `check-browser-safe.mjs` shipped two confident wrong answers because nobody
   * pointed it at something it should have rejected: a detector that finds
   * nothing looks exactly like a clean result. A format suite has the same
   * failure mode — a loader that silently returned an empty book would satisfy
   * every "contains" assertion above by containing nothing to contradict them.
   */
  describe('a file that is not the book it claims to be', () => {
    it('is refused rather than opened empty', async () => {
      const whole = bytesOf('fixture.mobi')
      await expect(open('fixture.mobi', whole.slice(0, 200))).rejects.toThrow()
    })

    it('is refused when it is empty, by name', async () => {
      /* foliate's own words for a zero-length file are "File not found", which
         reached the reader verbatim once — see `isEmptySource` in `formats.ts`.
         Asserted here so a change to that message is a decision rather than a
         surprise. */
      await expect(open('fixture.epub', new ArrayBuffer(0))).rejects.toThrow(/File not found/)
    })
  })
})
