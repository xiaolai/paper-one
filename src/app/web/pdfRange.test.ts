/**
 * @vitest-environment jsdom
 *
 * pdf.js reaches for browser globals the moment it loads — see below — so this
 * one file needs a DOM where the rest of `src/app` does not.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RemoteContent } from './content'
import { pdfRangeTransport } from './pdfRange'

/**
 * The range transport, against a fake shelf.
 *
 * Everything here is a failure that is SILENT in pdf.js. A transport has an
 * `onDataRange` and no `onError`: deliver the wrong bytes and a document fails
 * to parse for reasons that read as a corrupt book, deliver none and it waits
 * for ever on a blank page. None of it raises, so none of it would be noticed
 * without these.
 */

/* pdf.js's entry point EAGERLY loads its canvas display module, which reads
 * `DOMMatrix` at module scope — and jsdom does not implement it. Nothing under
 * test paints anything (a transport moves bytes; the canvas is the renderer's
 * business), so the stub only has to exist.
 *
 * Stubbed here rather than in a shared setup file because this is the only
 * suite in the tree that loads pdf.js at all, and a global stub that outlives
 * its one use is a global that hides a real missing implementation later. */
const globals = globalThis as { DOMMatrix?: unknown }
globals.DOMMatrix ??= class {}

/** A `RemoteContent` that answers slices of `text`, or refuses. */
function shelf(text: string, options: { readonly fail?: boolean; readonly hold?: boolean } = {}) {
  const asked: { offset: number; length: number }[] = []
  let release: (() => void) | null = null
  const content = {
    locate: async () => ({ here: true, ext: 'pdf', size: text.length }),
    fileOf: async () => new File([], 'x.pdf'),
    readRange: async (_book: string, offset: number, length: number) => {
      asked.push({ offset, length })
      if (options.hold) await new Promise<void>((resolve) => (release = resolve))
      if (options.fail) throw new Error('the shelf went away')
      return new TextEncoder().encode(text.slice(offset, offset + length))
    },
  } as unknown as RemoteContent
  return { content, asked, release: () => release?.() }
}

const decode = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes))

/** Wire a listener in, as `getDocument` does, and collect what arrives. */
function listen(transport: Awaited<ReturnType<typeof pdfRangeTransport>>) {
  const got: { begin: number; chunk: string | null }[] = []
  transport.transportReady((event: { type: string; begin: number; chunk: Uint8Array | null }) => {
    if (event.type === 'range') got.push({ begin: event.begin, chunk: decode(event.chunk) })
  })
  return got
}

/** Let the in-flight read and its `.then` settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * `onFailure` for a test that is not about failure.
 *
 * ⚠️ IT IS REQUIRED, and it used to be optional — which put the silent hang
 * this transport exists to prevent back into the DEFAULT shape of the API.
 * These tests wrote the shortest thing that compiled, which was the broken one.
 * Spelling it out is the point: a caller with nothing useful to say still has
 * to say so out loud.
 */
const noteFailure = () => vi.fn()

describe('pdfRangeTransport', () => {
  it('carries the length pdf.js needs before it reads a byte', async () => {
    const { content } = shelf('%PDF-1.7 and so on')
    expect((await pdfRangeTransport(content, 'one', 18, { onFailure: noteFailure() })).length).toBe(18)
  })

  /**
   * `end` IS EXCLUSIVE in pdf.js and `content.read`'s `length` is a count.
   *
   * Off by one here drops the last byte of every range — which does not raise:
   * it corrupts a cross-reference table, and the book presents as broken.
   */
  it('converts pdf.js’s exclusive end into a length', async () => {
    const { content, asked } = shelf('0123456789')
    const transport = await pdfRangeTransport(content, 'one', 10, { onFailure: noteFailure() })
    const got = listen(transport)
    transport.requestDataRange(2, 6)
    await settle()
    expect(asked).toEqual([{ offset: 2, length: 4 }])
    expect(got).toEqual([{ begin: 2, chunk: '2345' }])
  })

  it('serves several ranges at once, each labelled with its own start', async () => {
    const { content } = shelf('0123456789')
    const transport = await pdfRangeTransport(content, 'one', 10, { onFailure: noteFailure() })
    const got = listen(transport)
    transport.requestDataRange(0, 2)
    transport.requestDataRange(8, 10)
    await settle()
    expect(got.map((one) => one.begin).sort()).toEqual([0, 8])
    expect(got.find((one) => one.begin === 8)?.chunk).toBe('89')
  })

  /* A READ IN FLIGHT WHEN THE READER CLOSES THE BOOK. Delivering it pushes
     bytes into a document pdf.js has already torn down. */
  it('delivers nothing after abort, even for a read already in flight', async () => {
    const { content, release } = shelf('0123456789', { hold: true })
    const transport = await pdfRangeTransport(content, 'one', 10, { onFailure: noteFailure() })
    const got = listen(transport)
    transport.requestDataRange(0, 4)
    transport.abort()
    release()
    await settle()
    expect(got).toEqual([])
  })

  /**
   * THE FAILURE THAT HAS NOWHERE TO GO.
   *
   * pdf.js is given no way to hear about a rejected read, so without this the
   * book hangs on a blank page for ever with nothing logged anywhere.
   */
  it('reports a failed read rather than leaving pdf.js waiting', async () => {
    const { content } = shelf('0123456789', { fail: true })
    const onFailure = vi.fn()
    const transport = await pdfRangeTransport(content, 'one', 10, { onFailure })
    const got = listen(transport)
    transport.requestDataRange(0, 4)
    await settle()
    expect(onFailure).toHaveBeenCalledOnce()
    expect(got).toEqual([])
  })

  it('reports a failure once, not once per outstanding range', async () => {
    /* A DEAD SHELF FAILS EVERY RANGE. pdf.js has several in flight at any
       moment, so a reader would otherwise see the same error four times for
       one dropped socket. */
    const { content } = shelf('0123456789', { fail: true })
    const onFailure = vi.fn()
    const transport = await pdfRangeTransport(content, 'one', 10, { onFailure })
    listen(transport)
    transport.requestDataRange(0, 4)
    transport.requestDataRange(4, 8)
    await settle()
    expect(onFailure).toHaveBeenCalledOnce()
  })
})
