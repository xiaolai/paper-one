// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBook, type Book } from './useBook'

/**
 * The book's identity lifecycle, which had no test of its own.
 *
 * `useBook` is exercised whole through `App`, and that is why these two defects
 * lived: from the outside, a phantom book id and a download nobody stopped both
 * look like a reader that works. Each case here names one of them.
 */

afterEach(cleanup)

const realFetch = globalThis.fetch

/** A fetch whose calls are recorded and whose answers the test releases. */
function holdFetch() {
  const calls: { url: string; signal: AbortSignal | undefined }[] = []
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init?.signal ?? undefined })
    return new Promise<Response>(() => {})
  }) as typeof fetch
  return calls
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  globalThis.fetch = realFetch
})

function mount() {
  const api: { current: Book | null } = { current: null }
  function Probe() {
    api.current = useBook()
    return null
  }
  render(<Probe />)
  return () => api.current!
}

describe('a source that names nothing', () => {
  /**
   * ⚠️ **`?book=` WAS A BOOK.** `URLSearchParams.get` answers `''` for a
   * present-but-empty parameter, and only `null` was refused — so the identity
   * effect fetched `''`, which resolves to the APPLICATION'S OWN DOCUMENT, and
   * recorded a phantom book id for it, while `Reader` treated the falsy source as
   * no book at all.
   */
  it('treats an empty ?book= as no book, and fetches nothing for it', () => {
    const calls = holdFetch()
    window.history.replaceState(null, '', '/?book=')
    const book = mount()
    expect(book().source).toBeNull()
    expect(calls, 'the app did not hash its own page').toEqual([])
  })

  it('treats open("") as closing, not as a book', () => {
    const calls = holdFetch()
    const book = mount()
    act(() => book().open(''))
    expect(book().source).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('a book the reader has already left', () => {
  /**
   * ⚠️ **ITS IDENTITY WAS COMPUTED TO THE END.** The generation check stopped a
   * stale id being APPLIED, and nothing stopped the download: three books opened
   * in quick succession paid for three downloads and three hashes, and Strict
   * Mode issued the same one twice.
   */
  it('aborts the superseded identity download when another book opens', () => {
    const calls = holdFetch()
    const book = mount()
    act(() => book().open('https://example.test/first.epub'))
    act(() => book().open('https://example.test/second.epub'))

    expect(calls.map((c) => c.url)).toEqual([
      'https://example.test/first.epub',
      'https://example.test/second.epub',
    ])
    expect(calls[0]?.signal?.aborted, 'the first was stopped').toBe(true)
    expect(calls[1]?.signal?.aborted, 'the current one was not').toBe(false)
  })

  it('aborts it when the book is closed', () => {
    const calls = holdFetch()
    const book = mount()
    act(() => book().open('https://example.test/first.epub'))
    act(() => book().close())
    expect(calls[0]?.signal?.aborted).toBe(true)
  })
})

describe('the book a consumer depends on', () => {
  /**
   * ⚠️ **ITS DEPENDENCY LIST WAS A HAND COPY, AND THE COPY LOST A FIELD.**
   * `fixedLayout` was in the object and not in the list, so the memo went on
   * handing out a stale `false` and every PDF gesture dropped. Derived from the
   * object now; these hold the two properties that make it safe to depend on.
   */
  it('keeps its identity across a render that changed nothing', () => {
    holdFetch()
    const seen: Book[] = []
    function Probe() {
      seen.push(useBook())
      return null
    }
    const view = render(<Probe />)
    act(() => view.rerender(<Probe />))
    act(() => view.rerender(<Probe />))
    expect(seen.length).toBeGreaterThan(2)
    expect(seen[seen.length - 1]).toBe(seen[0])
  })

  it('takes a new identity the moment a renderer-published field changes', () => {
    /* `fixedLayout` specifically — the field the hand-written list once lost. */
    holdFetch()
    const book = mount()
    act(() => book().open('https://example.test/scan.pdf'))
    const before = book()
    act(() => before.setFixedLayout(before.generation, true))
    expect(book(), 'a new value, not the stale one').not.toBe(before)
    expect(book().fixedLayout).toBe(true)
  })
})

describe('the section walk the export asks for', () => {
  /**
   * ⚠️ **THIS HOP DROPPED THE READER'S FOOTNOTE CHOICE.** It was
   * `(toc, shouldStop) => navigator.sectionTexts(toc, shouldStop)`, so the third
   * argument — added so the export reads the same book the voice does — stopped
   * here and the export always used the default. The navigator behind it dropped
   * `shouldStop` too; see `session.test.ts`. Both forward everything now.
   */
  it('hands the navigator every argument it was given', () => {
    holdFetch()
    const book = mount()
    act(() => book().open('https://example.test/a.epub'))
    const received: unknown[][] = []
    const navigator = {
      sectionTexts: (...args: unknown[]) => {
        received.push(args)
        return Promise.resolve({ sections: [], complete: true })
      },
    } as unknown as Parameters<Book['setNavigator']>[1]
    act(() => book().setNavigator(book().generation, navigator))

    const toc = [{ label: 'One', href: 'a.xhtml' }] as never
    const stop = () => false
    void book().sectionTexts(toc, stop, { notes: true })
    expect(received).toEqual([[toc, stop, { notes: true }]])
  })
})
