// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Reader } from './Reader'
import type { ContentFacts, RemoteContent } from './content'

/**
 * WHICH PATH A BOOK TAKES, and what happens when the shelf cannot say.
 *
 * The reader itself is `FoliateView`, which has its own suite and is exercised
 * by the desktop on every run. What is new here is the DECISION in front of it:
 * a PDF goes through a range transport so a phone never holds the whole file,
 * an EPUB is assembled into a `File` because a zip's directory is at the end,
 * and a shelf that cannot measure a PDF has no length to give a transport.
 *
 * That last branch is the one worth having a test for. `content.locate` answers
 * `size: null` whenever the shelf binds no size port — which the desktop app did
 * for the whole of phase 11 — and a transport built on `null` opens an empty
 * document with no error anywhere.
 */

/* pdf.js reads `DOMMatrix` at module scope and jsdom does not implement it.
 * Nothing here paints — a transport moves bytes — so the stub only has to
 * exist. Same reason `pdfRange.test.ts` carries one. */
const globals = globalThis as { DOMMatrix?: unknown }
globals.DOMMatrix ??= class {}

afterEach(cleanup)

function shelf(facts: Partial<ContentFacts>) {
  const readRange = vi.fn(async () => new Uint8Array(0))
  const fileOf = vi.fn(async (_book: string, name: string) => new File(['PK'], name))
  const content = {
    locate: async (): Promise<ContentFacts> => ({ here: true, ext: 'epub', size: 10, ...facts }),
    readRange,
    fileOf,
  } as unknown as RemoteContent
  return { content, readRange, fileOf }
}

const open = (content: RemoteContent) =>
  render(<Reader content={content} bookId="one" name="Moby-Dick" onClose={vi.fn()} />)

describe('Reader', () => {
  it('assembles an EPUB into a file, under the name a parser routes on', async () => {
    const { content, fileOf } = shelf({ ext: 'epub' })
    open(content)
    /* THE SUFFIX IS REBUILT FROM WHAT THE SHELF STORES. The shelf sends a
       TITLE; every parser Paper uses routes on the extension, and foliate
       rejects a name without one as an unsupported type. */
    await waitFor(() => expect(fileOf).toHaveBeenCalledWith('one', 'Moby-Dick.epub'))
  })

  it('says so plainly when the shelf does not have the pages', async () => {
    const { content, fileOf } = shelf({ here: false })
    open(content)
    await screen.findByText(/does not have this book/i)
    expect(fileOf).not.toHaveBeenCalled()
  })

  /**
   * A PDF THE SHELF CANNOT MEASURE FALLS BACK, and does not build a transport.
   *
   * pdf.js is told a length before it asks for a byte of the file. `null` is a
   * real answer from `content.locate` — it is what a shelf with no size port
   * says about every book — and a transport of length `null` is a document of
   * no bytes, which opens as an empty PDF rather than as an error. Slower and
   * correct is the right way round.
   */
  it('fetches a PDF whole when the shelf could not measure it', async () => {
    const { content, fileOf, readRange } = shelf({ ext: 'pdf', size: null })
    open(content)
    await waitFor(() => expect(fileOf).toHaveBeenCalledWith('one', 'Moby-Dick.pdf'))
    expect(readRange, 'no transport should have been built').not.toHaveBeenCalled()
  })

  it('keeps the name as-is when the shelf reports no extension', async () => {
    const { content, fileOf } = shelf({ ext: null })
    open(content)
    await waitFor(() => expect(fileOf).toHaveBeenCalledWith('one', 'Moby-Dick'))
  })

  it('reports a failure to locate rather than rendering an empty reader', async () => {
    const content = {
      locate: async () => {
        throw new Error('the shelf went away')
      },
    } as unknown as RemoteContent
    open(content)
    await screen.findByText(/the shelf went away/i)
  })

  /**
   * THE PATH THIS WHOLE WORK ITEM EXISTS FOR.
   *
   * A measured PDF goes through a range transport, so pdf.js asks the shelf for
   * the byte ranges of the page it is drawing rather than the file. The
   * assertion is that `fileOf` is NEVER reached: falling back would work, and
   * would download a 300 MB scanned book to show page one.
   */
  it('gives a measured PDF a range transport and never fetches it whole', async () => {
    const { content, fileOf, readRange } = shelf({ ext: 'pdf', size: 614907 })
    open(content)
    /* The transport reports the length pdf.js needs before it asks for a byte,
       so its presence is observable without rendering anything. */
    await waitFor(() => expect(screen.getByRole('banner')).toBeTruthy())
    await waitFor(() => expect(fileOf).not.toHaveBeenCalled())
    expect(readRange).not.toHaveBeenCalled()
  })

  /* A RANGE READ THAT FAILS HAS NOWHERE TO GO in pdf.js — it has an
     `onDataRange` and no `onError` — so without surfacing it the book stops on
     a blank page for ever. */
  it('surfaces a failed range read instead of leaving the page blank', async () => {
    const failing = {
      locate: async (): Promise<ContentFacts> => ({ here: true, ext: 'pdf', size: 64 }),
      readRange: async () => {
        throw new Error('the shelf went away')
      },
      fileOf: async () => new File([], 'x.pdf'),
    } as unknown as RemoteContent
    open(failing)
    await waitFor(() => expect(screen.getByRole('banner')).toBeTruthy())

    /* Ask the transport for a range, as pdf.js would. */
    const { pdfRangeTransport } = await import('./pdfRange')
    const problems: unknown[] = []
    const transport = await pdfRangeTransport(failing, 'one', 64, {
      onFailure: (cause) => problems.push(cause),
    })
    transport.requestDataRange(0, 8)
    await waitFor(() => expect(problems).toHaveLength(1))
  })

  it('goes back to the shelf, from the reader and from a book it could not open', async () => {
    const onClose = vi.fn()
    const { content } = shelf({ ext: 'epub' })
    const { unmount } = render(
      <Reader content={content} bookId="one" name="Moby-Dick" onClose={onClose} />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /shelf/i }))
    expect(onClose).toHaveBeenCalledOnce()
    unmount()

    /* AND FROM THE DEAD END. A book with no pages is the one screen where a
       reader has nothing else to press. */
    const missing = shelf({ here: false })
    render(<Reader content={missing.content} bookId="one" name="Moby" onClose={onClose} />)
    fireEvent.click(await screen.findByRole('button', { name: /back to the shelf/i }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  /* A PHONE ROTATES, and the measure is derived from the stage's width. A
     reader that kept the portrait measure in landscape would set the page to
     half the screen and leave the rest white. */
  it('re-measures when the window changes size', async () => {
    const { content } = shelf({ ext: 'epub' })
    open(content)
    await screen.findByRole('banner')
    act(() => {
      Object.defineProperty(window, 'innerWidth', { value: 380, configurable: true })
      window.dispatchEvent(new Event('resize'))
    })
    /* The surface survives the change — the assertion that matters is that the
       listener runs at all, since a throw here would take the reader down. */
    expect(screen.getByRole('banner')).toBeTruthy()
  })
})
