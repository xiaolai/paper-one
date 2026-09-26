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

describe('a book with no renderer behind it yet', () => {
  /**
   * ⚠️ **EVERY VERB READS THROUGH `navigatorRef`, AND THE REF IS NULL FOR REAL
   * STRETCHES OF A SESSION** — before the first session publishes, and again
   * from the moment `load` drops it until the next one does. A palette row, an
   * accelerator or a command fired in that window must do nothing; without the
   * optional call each is a TypeError in the middle of a reader that otherwise
   * works. Held as a table so a verb added later is one line, not a case
   * somebody has to remember to write.
   */
  const verbs: readonly [string, (book: Book) => unknown][] = [
    ['goTo', (book) => book.goTo('a.xhtml')],
    ['next', (book) => book.next()],
    ['prev', (book) => book.prev()],
    ['goLeft', (book) => book.goLeft()],
    ['goRight', (book) => book.goRight()],
    ['drawMark', (book) => book.drawMark({ cfi: 'epubcfi(/6/2!/4)', style: 'highlight' } as never)],
    ['eraseMark', (book) => book.eraseMark({ cfi: 'epubcfi(/6/2!/4)', style: 'highlight' } as never)],
    ['deselect', (book) => book.deselect()],
    ['closeFootnote', (book) => book.closeFootnote()],
    ['placeHere', (book) => book.placeHere()],
  ]

  it.each(verbs)('does nothing when %s is asked with no navigator installed', (_name, ask) => {
    holdFetch()
    const book = mount()
    act(() => book().open('https://example.test/a.epub'))
    expect(() => ask(book())).not.toThrow()
  })

  it('answers no place at all, rather than a made-up one', () => {
    holdFetch()
    const book = mount()
    expect(book().placeHere()).toBeNull()
  })

  it('finds nothing when asked to search', async () => {
    holdFetch()
    const book = mount()
    const hits = []
    for await (const hit of book().search('anything', new AbortController().signal)) hits.push(hit)
    expect(hits).toEqual([])
  })

  it('answers an INCOMPLETE empty walk for the export, not an empty book', async () => {
    /* ⚠️ `complete: true` here would let the export write a nought-chapter
       audiobook and report success — the distinction `reanchorUnplaced` draws
       between "nothing is there" and "nothing has been established". */
    holdFetch()
    const book = mount()
    await expect(book().sectionTexts()).resolves.toEqual({ sections: [], complete: false })
  })
})

describe('a value arriving from a session already replaced', () => {
  /**
   * ⚠️ **EIGHT SETTERS SHARE ONE GUARD, AND THE GUARD IS THE WHOLE POINT.** A
   * session being torn down still answers its outstanding work, so a table of
   * contents, a position or a cover can arrive for the book the reader has
   * already left. Applied, it would draw the previous book's chapters over the
   * new one.
   */
  it('is dropped, and the book keeps what its own session said', () => {
    holdFetch()
    const book = mount()
    act(() => book().open('https://example.test/first.epub'))
    const stale = book().generation
    act(() => book().setToc(stale, [{ label: 'First book', href: 'a.xhtml' }] as never))
    expect(book().toc.map((entry) => entry.label), 'its own session was heard').toEqual(['First book'])

    act(() => book().open('https://example.test/second.epub'))
    act(() => book().setToc(stale, [{ label: 'Left behind', href: 'z.xhtml' }] as never))
    expect(book().toc, 'the book the reader left spoke, and was not heard').toEqual([])
  })
})

describe('a book that cannot be identified', () => {
  /**
   * The identity fetch is the only thing here that can fail in practice, and a
   * failure has to be told apart from a book the reader simply left: one is
   * something the app could not do, the other is something nobody asked for any
   * more.
   */
  it('says so once, naming the cause', async () => {
    const failure = new Error('the network refused')
    globalThis.fetch = vi.fn(() => Promise.reject(failure)) as typeof fetch
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const book = mount()
    await act(async () => {
      book().open('https://example.test/gone.epub')
    })
    expect(said).toHaveBeenCalledWith('Paper: could not identify this book', failure)
    expect(book().bookId, 'and no identity was recorded for it').toBeNull()
    said.mockRestore()
  })

  it('says nothing about a book the reader left before the answer came', async () => {
    /* A real `fetch` rejects with an abort error when its signal is aborted, so
       the rejection for the abandoned book arrives AFTER the reader has moved
       on. That is not a failure to identify a book; it is a question nobody is
       asking any more. */
    globalThis.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        }),
    ) as typeof fetch
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const book = mount()
    await act(async () => {
      book().open('https://example.test/left.epub')
    })
    await act(async () => {
      book().open('https://example.test/arrived.epub')
    })
    expect(said, 'the abandoned book was reported as a failure').not.toHaveBeenCalled()
    said.mockRestore()
  })
})

describe('where a book is before it has been anywhere', () => {
  /**
   * ⚠️ **`NOWHERE` IS NOT THE FIRST SECTION, and each of its fields says so.**
   * `sectionIndex` is null rather than 0 — the constant's own name is the
   * argument — and `sectionExact` is false: nothing has been rendered, so no
   * section has been resolved exactly. A reader of this position that took
   * either as a real place would resume a book at a page nobody had reached.
   */
  it('is nowhere, exactly, and says the section is not settled', () => {
    holdFetch()
    const book = mount()
    expect(book().position).toEqual({
      fraction: 0,
      chapterLabel: '',
      /* Empty before any relocation, like the chapter beside it: a book that
         has been nowhere has no page to report, and 93 % of books never get
         one at all. */
      printPage: '',
      chapterHref: '',
      cfi: null,
      sectionIndex: null,
      sectionExact: false,
    })
  })

  /**
   * ⚠️ **THESE TWO ARE READ DURING RENDER, SO A THROW HERE UNMOUNTS THE READER.**
   * `useAutoAdvance.offered` calls `pace()` on every render of `App`. When these
   * helpers used a bare `navigatorRef.current?.pace()`, a navigator that was
   * present but missing the member threw `pace is not a function` as an uncaught
   * exception — 52 cases in one file, every one of them timing out at 15 s
   * because App never mounted at all. The `?.` guarded the wrong thing.
   *
   * ⚠️ **AND THE FAKES ARE WHY `tsc` DID NOT SEE IT**: every navigator in these
   * suites is a partial object cast through `as unknown as`, so the type held
   * everywhere while the runtime object did not. The cases below supply the
   * members for real, which is the only way the production path is exercised.
   */
  describe('hands-free stepping', () => {
    const withNavigator = (over: Record<string, unknown>) => {
      holdFetch()
      const book = mount()
      act(() => book().open('https://example.test/a.epub'))
      const navigator = over as unknown as Parameters<Book['setNavigator']>[1]
      act(() => book().setNavigator(book().generation, navigator))
      return book
    }

    it('steps when there is somewhere to go', () => {
      const moved: number[] = []
      const book = withNavigator({ atEnd: () => false, next: () => moved.push(1) })
      expect(book().step()).toBe(true)
      expect(moved).toHaveLength(1)
    })

    it('refuses at the end of the book, and does not call next', () => {
      const moved: number[] = []
      const book = withNavigator({ atEnd: () => true, next: () => moved.push(1) })
      expect(book().step()).toBe(false)
      expect(moved).toHaveLength(0)
    })

    it('reads the pace the navigator answers', () => {
      const pace = { bookWords: 90_000, sectionBytes: 100, spineBytes: 1_000, steps: 12 }
      const book = withNavigator({ pace: () => pace })
      expect(book().pace()).toEqual(pace)
    })

    it('answers no pace and no step for a navigator missing the members', () => {
      /* The shape every existing fake in these suites has. It must not throw. */
      const book = withNavigator({})
      expect(book().step()).toBe(false)
      expect(book().pace()).toEqual({ bookWords: null, sectionBytes: 0, spineBytes: 0, steps: 0 })
    })

    it('survives a navigator whose pace throws, rather than taking the reader down', () => {
      /* ⚠️ **THE SHAPE NO FAKE HAD, AND THE ONE THAT ACTUALLY HAPPENED.**
         `renderer.pages` is a GETTER that throws before the paginator has a
         view — measured in the running app: reading it during App's first
         render died at `viewSize` → `this.#view.element`, and the uncaught
         exception unmounted the whole reader over a blank window. 12 464 tests
         passed over it, because a plain-object fake cannot have a throwing
         getter unless somebody writes one. So here is one. */
      const book = withNavigator({
        get pace() {
          throw new TypeError('undefined is not an object (evaluating \'this.#view.element\')')
        },
        atEnd: () => {
          throw new TypeError('the same, before layout')
        },
        next: () => {},
      })
      expect(() => book().pace()).not.toThrow()
      expect(book().pace().bookWords).toBeNull()
      expect(() => book().step()).not.toThrow()
      expect(book().step()).toBe(false)
    })

    it('answers no pace and no step before a navigator arrives at all', () => {
      holdFetch()
      const book = mount()
      expect(book().step()).toBe(false)
      expect(book().pace().bookWords).toBeNull()
    })
  })
})
