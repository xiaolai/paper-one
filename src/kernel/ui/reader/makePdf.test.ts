// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `makePdf` — the ranged-source dispatch, and what it releases when it fails.
 *
 * ## Why this file did not exist
 *
 * Nothing called `makePdf` from a test. The ranged-source branch, the
 * transport identity check, the loading flags, the failure cleanup and
 * `destroy` were all uncovered, which is how two leaks came to live in it: a
 * rejected load left the pdf.js worker and the range transport running, and
 * every page Blob carried its own copy of a 163 KB stylesheet that was then
 * retained for the life of the book.
 *
 * pdf.js is mocked because the subject is what THIS module does around it — it
 * cannot render in jsdom, and a test that needed it to would be testing pdf.js.
 */

const pdfjs = vi.hoisted(() => {
  class FakeTransport {}
  return {
    /** What `getDocument` was handed, so the dispatch can be asserted. */
    lastSrc: null as Record<string, unknown> | null,
    /** Set by the test: the loading task's outcome. */
    outcome: 'resolve' as 'resolve' | 'reject',
    destroys: 0,
    FakeTransport,
  }
})

vi.mock('pdfjs-dist', () => {
  const page = {
    getViewport: () => ({ width: 100, height: 200 }),
    render: () => ({ promise: Promise.resolve() }),
    getTextContent: async () => ({ items: [] }),
    cleanup: () => {},
  }
  const document_ = {
    numPages: 2,
    getPage: async () => page,
    getMetadata: async () => ({ info: {} }),
    getOutline: async () => null,
    getDestination: async () => null,
    getPageIndex: async () => 0,
  }
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    PDFDataRangeTransport: pdfjs.FakeTransport,
    getDocument: (src: Record<string, unknown>) => {
      pdfjs.lastSrc = src
      return {
        promise:
          pdfjs.outcome === 'resolve'
            ? Promise.resolve(document_)
            : Promise.reject(new Error('this book is truncated')),
        destroy: async () => {
          pdfjs.destroys += 1
        },
      }
    },
  }
})

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'worker.js' }))
/* REALISTICALLY LARGE, because size is the assertion. The real sheet is 163 KB
   and the defect was every page Blob carrying a copy; a token-sized fake would
   make "the page is smaller than the sheet" true either way. */
vi.mock('pdfjs-dist/web/pdf_viewer.css?raw', () => ({ default: '.textLayer{}'.repeat(14_000) }))

const { makePdf } = await import('./makePdf')

/** Every object URL minted, and whether it has been revoked. */
const minted: { url: string; revoked: boolean; type: string; size: number }[] = []
let next = 0
const globals = globalThis as unknown as { URL: typeof URL }
globals.URL.createObjectURL = ((blob: Blob) => {
  const url = `blob:made-${next++}`
  /* SIZE MATTERS HERE. The defect was every page Blob carrying its own copy of
     the stylesheet, and only the size distinguishes that from a page that
     links to it. */
  minted.push({ url, revoked: false, type: blob.type, size: blob.size })
  return url
}) as typeof URL.createObjectURL
globals.URL.revokeObjectURL = ((url: string) => {
  const held = minted.find((one) => one.url === url)
  if (held) held.revoked = true
}) as typeof URL.revokeObjectURL

afterEach(() => {
  minted.length = 0
  next = 0
  pdfjs.lastSrc = null
  pdfjs.destroys = 0
  pdfjs.outcome = 'resolve'
})

const ranged = () => ({ range: new pdfjs.FakeTransport(), name: 'scanned.pdf' })

describe('the source it dispatches on', () => {
  it('hands a ranged source its transport, and no length beside it', async () => {
    const book = await makePdf(ranged() as never)
    expect(pdfjs.lastSrc?.['range']).toBeInstanceOf(pdfjs.FakeTransport)
    /* `getDocument` reads `src.range.length` and never looks at a `length`
       beside it, so one here would be a field nothing reads. */
    expect(pdfjs.lastSrc).not.toHaveProperty('length')
    await book.destroy()
  })

  /**
   * `getDocument` SILENTLY IGNORES a `range` that fails its own `instanceof`
   * and then throws "Invalid parameter object" — true, and about the wrong
   * thing. Two copies of pdf.js in the module graph do exactly this.
   */
  it('refuses a range that is not a pdf.js transport, and says why', async () => {
    await expect(makePdf({ range: {}, name: 'wrong.pdf' } as never)).rejects.toThrow(
      /not a PDFDataRangeTransport/,
    )
  })
})

describe('what it releases', () => {
  /**
   * ⚠️ **A REJECTED LOAD USED TO LEAVE THE WORKER RUNNING.**
   *
   * `getDocument` starts a worker and holds the transport, and pdf.js tears
   * down neither when the loading task rejects. A corrupt or truncated PDF, or
   * a shelf that dropped mid-read, threw out of `makePdf` with the worker alive
   * and the transport still asking for byte ranges nobody would read — one per
   * failed open, for the life of the window.
   */
  it('destroys the loading task when the document fails to open', async () => {
    pdfjs.outcome = 'reject'
    await expect(makePdf(ranged() as never)).rejects.toThrow(/truncated/)
    expect(pdfjs.destroys, 'the pdf.js worker was left running').toBe(1)
  })

  it('revokes what it minted when the document fails to open', async () => {
    pdfjs.outcome = 'reject'
    await expect(makePdf(ranged() as never)).rejects.toThrow()
    expect(minted.every((one) => one.revoked), 'an object URL outlived a failed open').toBe(true)
  })

  it('destroys the task and revokes every URL on an ordinary close', async () => {
    const book = await makePdf(ranged() as never)
    /* Visit a page, so there is a page source to release as well. */
    await book.sections[0]?.load()
    expect(minted.length).toBeGreaterThan(1)

    await book.destroy()
    expect(pdfjs.destroys).toBe(1)
    expect(minted.every((one) => one.revoked)).toBe(true)
  })
})

describe('the page documents', () => {
  /**
   * ⚠️ **EVERY PAGE USED TO CARRY ITS OWN COPY OF THE STYLESHEET.**
   *
   * `pdf_viewer.css` is 163 KB and was inlined into each page's Blob — while
   * the page sources are cached and held until the book closes. A thousand
   * pages read is over 160 MB of the same stylesheet, retained, on the device
   * this reader exists to avoid downloading a large file to.
   */
  it('serves the viewer stylesheet once and links it from each page', async () => {
    const book = await makePdf(ranged() as never)
    const styles = minted.filter((one) => one.type === 'text/css')
    expect(styles, 'the stylesheet should be minted once for the whole book').toHaveLength(1)

    const first = await book.sections[0]?.load()
    const second = await book.sections[1]?.load()
    expect(first?.src).not.toBe(second?.src)
    /* And still exactly one stylesheet, however many pages were visited. */
    expect(minted.filter((one) => one.type === 'text/css')).toHaveLength(1)

    /* THE PAGE DOCUMENTS ARE SMALL, which is the whole point: each one carried
       a full copy of the stylesheet, and the cache holds one per page visited
       for the life of the book. A page that LINKS the sheet is a few hundred
       bytes; a page that inlines it is bigger than the sheet. */
    const sheet = minted.find((one) => one.type === 'text/css')
    const pages = minted.filter((one) => one.type === 'text/html')
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) {
      expect(page.size, 'a page document is carrying its own copy of the stylesheet').toBeLessThan(
        sheet?.size ?? 0,
      )
    }
    await book.destroy()
  })

  /* A page revisited must not mint a second URL: foliate re-loads a section
     every time it comes back into view. */
  it('caches a page source rather than minting one per visit', async () => {
    const book = await makePdf(ranged() as never)
    const first = await book.sections[0]?.load()
    const again = await book.sections[0]?.load()
    expect(again?.src).toBe(first?.src)
    await book.destroy()
  })
})
