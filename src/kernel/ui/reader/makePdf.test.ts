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
    /**
     * When not null, the fake document is PASSWORD-PROTECTED: the loading task
     * calls `onPassword` with this reason code before it can settle, exactly
     * as pdf.js does — 1 for "needs one", 2 for "that one was wrong".
     */
    askPassword: null as number | null,
    /** Every password the task was handed back. */
    passwords: [] as string[],
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
  type Update = (answer: string | Error) => void
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    PDFDataRangeTransport: pdfjs.FakeTransport,
    PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
    getDocument: (src: Record<string, unknown>) => {
      pdfjs.lastSrc = src
      const task = {
        /* Settable AFTER `getDocument` returns, which is when a caller can
           set it and when the real task reads it: the worker's request comes
           back asynchronously. */
        onPassword: null as ((update: Update, reason: number) => void) | null,
        promise: new Promise<unknown>((resolve, reject) => {
          queueMicrotask(() => {
            const ask = pdfjs.askPassword
            if (ask !== null) {
              if (!task.onPassword) {
                /* pdf.js's own words when nobody is there to ask. */
                reject(new Error('No password given'))
                return
              }
              task.onPassword((answer) => {
                if (answer instanceof Error) {
                  reject(answer)
                  return
                }
                pdfjs.passwords.push(answer)
                resolve(document_)
              }, ask)
              return
            }
            if (pdfjs.outcome === 'resolve') resolve(document_)
            else reject(new Error('this book is truncated'))
          })
        }),
        destroy: async () => {
          pdfjs.destroys += 1
        },
      }
      return task
    },
  }
})

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'worker.js' }))
/* REALISTICALLY LARGE, because size is the assertion. The real sheet is 163 KB
   and the defect was every page Blob carrying a copy; a token-sized fake would
   make "the page is smaller than the sheet" true either way. */
vi.mock('pdfjs-dist/web/pdf_viewer.css?raw', () => ({ default: '.textLayer{}'.repeat(14_000) }))

const { makePdf, PDF_LOCKED } = await import('./makePdf')

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
  pdfjs.askPassword = null
  pdfjs.passwords.length = 0
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

/**
 * WI-20.13 — a password-protected PDF used to show pdf.js's own "No password
 * given": `getDocument` was called with no `onPassword`, so the library's
 * answer to "this needs a password" was to reject with the sentence it uses
 * for exactly that, and nothing under `src/` had ever named
 * `PasswordException`. The reader was told, in effect, that it had failed to
 * do something it was never asked to do.
 */
describe('a password-protected document', () => {
  it('asks the caller, and opens with the answer', async () => {
    pdfjs.askPassword = 1
    const password = vi.fn(async () => 'secret')
    const book = await makePdf(ranged() as never, { password })
    expect(password).toHaveBeenCalledWith('needed')
    expect(pdfjs.passwords).toEqual(['secret'])
    await book.destroy()
  })

  it('says the last answer was wrong when pdf.js asks again', async () => {
    pdfjs.askPassword = 2
    const password = vi.fn(async () => 'second try')
    const book = await makePdf(ranged() as never, { password })
    expect(password).toHaveBeenCalledWith('wrong')
    await book.destroy()
  })

  it('a cancelled prompt refuses by name and releases the task — it does not hang', async () => {
    pdfjs.askPassword = 1
    const password = vi.fn(async () => null)
    await expect(makePdf(ranged() as never, { password })).rejects.toThrow(PDF_LOCKED)
    expect(pdfjs.passwords).toEqual([])
    expect(pdfjs.destroys, 'the pdf.js worker was left running after a cancel').toBe(1)
    expect(minted.every((one) => one.revoked), 'an object URL outlived a cancelled open').toBe(true)
  })

  it('with nobody to ask, refuses by name rather than in pdf.js’s words', async () => {
    /* The enrichment pass parses without a reader present. It must see the
       same named refusal, not "No password given". */
    pdfjs.askPassword = 1
    await expect(makePdf(ranged() as never)).rejects.toThrow(PDF_LOCKED)
    expect(pdfjs.destroys).toBe(1)
  })

  it('a prompt that throws is a refusal too, not a hang', async () => {
    pdfjs.askPassword = 1
    const password = vi.fn(async () => {
      throw new Error('the sheet went away')
    })
    await expect(makePdf(ranged() as never, { password })).rejects.toThrow(PDF_LOCKED)
    expect(pdfjs.destroys).toBe(1)
  })
})
