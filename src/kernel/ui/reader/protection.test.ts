// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DECODABLE_ALGORITHMS, protectedScheme, protectionMessage, protectionOf } from './protection'
import {
  ADEPT_CHAPTER_ENCRYPTION,
  CHAPTER_HREF,
  CHAPTER_TEXT,
  FONT_HREF,
  IDPF_FONT_ENCRYPTION,
  LCP_CHAPTER_ENCRYPTION,
  ciphertext,
  epubFixture,
} from './epubFixture.testkit'

/**
 * WI-20.13's DRM half, proved on the REAL fork.
 *
 * The plan's warning is the reason this suite opens real files: a second
 * `encryption.xml` parser in Paper "would duplicate the fork and, without a
 * valid-font fixture, risk refusing ordinary books". So the two fixtures are
 * the acceptance — an EPUB with one IDPF-obfuscated font OPENS, an EPUB with
 * one ADEPT-encrypted chapter is REFUSED BY NAME — and both go through
 * `makeBook` from the pinned fork, not through a fake of it.
 */

const ADEPT = protectionMessage('ADEPT')

describe('protectedScheme — the element list, read the way the fork reads it', () => {
  it('names ADEPT for a chapter keyed by an Adobe resource', () => {
    expect(protectedScheme(ADEPT_CHAPTER_ENCRYPTION, [CHAPTER_HREF])).toBe('ADEPT')
  })

  it('names LCP for a chapter keyed by a Readium licence', () => {
    expect(protectedScheme(LCP_CHAPTER_ENCRYPTION, [CHAPTER_HREF])).toBe('LCP')
  })

  it('quotes the algorithm when the scheme is nobody it knows', () => {
    const xml = ADEPT_CHAPTER_ENCRYPTION.replace(/<KeyInfo[\s\S]*?<\/KeyInfo>/, '').replace(
      'aes128-cbc',
      'kw-aes128',
    )
    expect(protectedScheme(xml, [CHAPTER_HREF])).toBe('http://www.w3.org/2001/04/xmlenc#kw-aes128')
  })

  it('lets an obfuscated font through — the fork decodes it', () => {
    expect(protectedScheme(IDPF_FONT_ENCRYPTION, [CHAPTER_HREF])).toBeNull()
    const adobe = IDPF_FONT_ENCRYPTION.replace(
      'http://www.idpf.org/2008/embedding',
      'http://ns.adobe.com/pdf/enc#RC',
    )
    expect(protectedScheme(adobe, [CHAPTER_HREF])).toBeNull()
  })

  it('lets a font, or an image, under an unknown algorithm through — only a chapter refuses', () => {
    /* The reader loses a face or a picture and keeps the book. Refusing here
       would refuse a book that reads fine, which is the plan's named risk. */
    const font = ADEPT_CHAPTER_ENCRYPTION.replace(CHAPTER_HREF, FONT_HREF)
    expect(protectedScheme(font, [CHAPTER_HREF])).toBeNull()
  })

  it('matches a percent-encoded reference against the resolved href', () => {
    const xml = ADEPT_CHAPTER_ENCRYPTION.replace(CHAPTER_HREF, 'OEBPS/ch%201.xhtml')
    expect(protectedScheme(xml, ['OEBPS/ch 1.xhtml'])).toBe('ADEPT')
  })

  it('reads a file that is not XML as no protection at all', () => {
    expect(protectedScheme('not xml', [CHAPTER_HREF])).toBeNull()
  })
})

describe('protectionOf — the opened book', () => {
  it('answers null for a book that is not a zip and has no encryption.xml to read', async () => {
    await expect(protectionOf({})).resolves.toBeNull()
    await expect(
      protectionOf({ loadText: async () => null, getSize: () => 0, sections: [{ id: CHAPTER_HREF }] }),
    ).resolves.toBeNull()
  })

  it('never asks a book whose loadText is not the zip loader’s — a MOBI takes a section, not a path', async () => {
    /* The fork's MOBI6 and KF8 books BOTH expose `loadText(section)`, and
       KF8's destructures its argument — handed the archive path this check
       reads, it threw `Cannot read properties of undefined`, and every AZW3
       failed to open with "This file could not be opened" (audit round 1,
       #105). Only the zip-backed EPUB carries `getSize` beside `loadText`;
       a book without the pair is never asked at all. */
    const kf8Shaped = vi.fn(async (section: { skel: { offset: number } }) => {
      const { skel } = section
      return String(skel.offset)
    })
    await expect(
      protectionOf({ loadText: kf8Shaped as unknown as (name: string) => Promise<string | null> }),
    ).resolves.toBeNull()
    expect(kf8Shaped).not.toHaveBeenCalled()
  })

  it('treats a loadText that throws as no protection — the belt behind the discriminator', async () => {
    await expect(
      protectionOf({
        loadText: async () => {
          throw new Error('not an archive after all')
        },
        getSize: () => 0,
      }),
    ).resolves.toBeNull()
  })

  it('names exactly the algorithms the shipped fork decodes', () => {
    /* `DECODABLE_ALGORITHMS` copies the fork's `deobfuscators` keys, and a
       rebase that teaches the fork a third would make this reader refuse a
       book the fork reads. A pin against the shipped source, on the
       `pageTurn.test.ts` precedent — not a fake, so it cannot drift. */
    /* From the vitest root, not `import.meta.url`: under jsdom that URL is
       http-schemed and `fileURLToPath` refuses it. The suites run with the
       repository as their working directory. */
    const source = readFileSync(join(process.cwd(), 'node_modules/foliate-js/epub.js'), 'utf8')
    const at = source.indexOf('const deobfuscators')
    expect(at).toBeGreaterThan(-1)
    const block = source.slice(at, source.indexOf('\n})', at))
    const keys = [...block.matchAll(/'(https?:[^']+)':/g)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(0)
    expect(new Set(keys)).toEqual(DECODABLE_ALGORITHMS)
  })
})

describe('the fixture pair, through the real fork', () => {
  const open = async (file: File) => {
    const { makeBook } = await import('foliate-js/view.js')
    return makeBook(file)
  }

  it('OPENS an EPUB whose only encrypted resource is an IDPF-obfuscated font', async () => {
    const book = await open(epubFixture({ encryption: IDPF_FONT_ENCRYPTION }))
    try {
      await expect(protectionOf(book)).resolves.toBeNull()
      expect(book.sections).toHaveLength(1)
      /* And the chapter is readable — the whole point of letting it through. */
      /* The fork types a section as `unknown`; this is its `createDocument`. */
      const section = book.sections[0] as { createDocument: () => Promise<Document> }
      const doc = await section.createDocument()
      expect(doc.body?.textContent).toContain(CHAPTER_TEXT)
    } finally {
      book.destroy?.()
    }
  })

  it('REFUSES an EPUB with one ADEPT-encrypted chapter, by name', async () => {
    const book = await open(epubFixture({ encryption: ADEPT_CHAPTER_ENCRYPTION, chapter: ciphertext() }))
    try {
      /* `makeBook` itself succeeds — the container, the OPF and the nav are
         in the clear under ADEPT — which is exactly why nothing said anything
         before: the book "opened", and the page was noise. */
      expect(book.sections).toHaveLength(1)
      await expect(protectionOf(book)).resolves.toBe(ADEPT)
    } finally {
      book.destroy?.()
    }
  })

  it('opens a plain EPUB with no encryption.xml at all', async () => {
    const book = await open(epubFixture())
    try {
      await expect(protectionOf(book)).resolves.toBeNull()
    } finally {
      book.destroy?.()
    }
  })
})
