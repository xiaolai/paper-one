// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { IndexedBook } from '../../core/bookIndex'
import type { PassageHit } from '../../core/ports'
import type { VaultFs } from '../../core/bookVault'
import { renderHook, act } from '@testing-library/react'
import { openPassage, useOpenPassage } from './useOpenPassage'

/**
 * Turning a library hit into a jump, and every way it can decline to.
 *
 * ⚠️ **FIVE REFUSALS, FIVE SENTENCES.** Reported as one, a reader who evicted a
 * book is sent to look for a corrupt file, and a reader whose index is stale is
 * told their book changed edition — which `bookId` makes almost always false.
 */

const CHAPTER = '<html><body><p>Call me Ishmael. The whale was large.</p></body></html>'

function book(over: Partial<IndexedBook> = {}): IndexedBook {
  return { bookId: 'book:a', title: 'A Book', addedAt: 1, ext: 'epub', ...over } as IndexedBook
}

function hit(over: Partial<PassageHit> = {}): PassageHit {
  return {
    bookId: 'book:a',
    sectionIndex: 0,
    offset: 17,
    quote: 'The whale',
    prefix: 'Call me Ishmael. ',
    suffix: ' was large.',
    score: 1,
    ...over,
  }
}

/** A vault that answers with `CHAPTER`, or refuses in a named way. */
function vault(over: Partial<VaultFs> = {}): VaultFs {
  return {
    readFile: vi.fn(async () => new TextEncoder().encode('pretend epub bytes')),
    ...over,
  } as unknown as VaultFs
}

/**
 * foliate's parser, faked.
 *
 * ⚠️ **MOCKED AT THE MODULE, because the real one needs a real EPUB.** What is
 * under test is the RESOLUTION — which section is parsed, what is done with the
 * landing, and what is reported when it fails — and none of that is about zip
 * decoding. The section documents are real `Document`s, so `indexText` and
 * `reanchorIn` run for real over them, which is the part that must not be
 * faked.
 */
const foliate = vi.hoisted(() => ({
  makeBook: vi.fn(),
  destroyed: { count: 0 },
}))

vi.mock('foliate-js/view.js', () => ({ makeBook: foliate.makeBook }))

function parsedBook(sections: readonly (string | null)[]) {
  return {
    sections: sections.map((html) => ({
      createDocument: async () =>
        html === null
          ? null
          : new DOMParser().parseFromString(html, 'text/html'),
    })),
    destroy: () => {
      foliate.destroyed.count += 1
    },
  }
}

function deps(over: Partial<Parameters<typeof openPassage>[1]> = {}) {
  return {
    fs: vault(),
    books: [book()],
    jumpTo: vi.fn(),
    onProblem: vi.fn(),
    ...over,
  }
}

describe('opening a hit', () => {
  it('lands on the words and answers a place in that book', async () => {
    foliate.makeBook.mockResolvedValueOnce(parsedBook([CHAPTER]))
    const found = await openPassage(hit(), deps())
    expect(found.kind).toBe('jumped')
    if (found.kind !== 'jumped') return
    expect(found.place.bookId).toBe('book:a')
    expect(found.place.cfi).toMatch(/^epubcfi\(\/6\/2!/u)
  })

  it('parses ONE section, not the spine', async () => {
    /* ⚠️ A CFI is a PATH, so a hit in a later chapter resolves without opening
     * or laying out anything — and `view.search()`, which is stateful and
     * destructive, is never involved. */
    const asked: number[] = []
    foliate.makeBook.mockResolvedValueOnce({
      sections: [null, null, CHAPTER].map((html, index) => ({
        createDocument: async () => {
          asked.push(index)
          return html === null ? null : new DOMParser().parseFromString(html, 'text/html')
        },
      })),
      destroy: () => {},
    })
    await openPassage(hit({ sectionIndex: 2 }), deps())
    expect(asked).toEqual([2])
  })

  it('releases the parsed book whatever happened', async () => {
    /* ⚠️ **ALWAYS.** FB2 creates an object URL PER SECTION; a reader who clicks
     * twenty results leaks twenty books without this. */
    const before = foliate.destroyed.count
    foliate.makeBook.mockResolvedValueOnce(parsedBook([CHAPTER]))
    await openPassage(hit(), deps())
    foliate.makeBook.mockResolvedValueOnce(parsedBook(['<html><body><p>other</p></body></html>']))
    await openPassage(hit(), deps())
    expect(foliate.destroyed.count).toBe(before + 2)
  })
})

describe('refusing, by cause', () => {
  it('says the book left the shelf', async () => {
    const found = await openPassage(hit(), deps({ books: [] }))
    expect(found).toEqual({ kind: 'refused', why: expect.stringContaining('no longer on your shelf') })
  })

  it('says there is no vault at all', async () => {
    const found = await openPassage(hit(), deps({ fs: null }))
    expect(found.kind).toBe('refused')
    if (found.kind !== 'refused') return
    expect(found.why).toMatch(/cannot open books/u)
  })

  it('tells an evicted book from a damaged one', async () => {
    /* ⚠️ **ABSENT AND UNREADABLE ARE TWO ANSWERS**, and telling a reader their
     * book was evicted when it is sitting there unreadable sends them to
     * download something they already have. */
    const evicted = await openPassage(
      hit(),
      deps({
        fs: vault({
          readFile: async () => {
            throw new Error('No such file or directory')
          },
        }),
      }),
    )
    expect(evicted.kind).toBe('refused')
    if (evicted.kind !== 'refused') return
    expect(evicted.why).toMatch(/not on this device/u)

    const damaged = await openPassage(
      hit(),
      deps({
        fs: vault({
          readFile: async () => {
            throw new Error('permission denied')
          },
        }),
      }),
    )
    expect(damaged.kind).toBe('refused')
    if (damaged.kind !== 'refused') return
    expect(damaged.why).toMatch(/could not be opened/u)
    expect(damaged.why).not.toBe(evicted.why)
  })

  it('says a book that will not parse could not be opened', async () => {
    foliate.makeBook.mockRejectedValueOnce(new Error('not a zip'))
    const found = await openPassage(hit(), deps())
    expect(found).toEqual({ kind: 'refused', why: expect.stringContaining('could not be opened') })
  })

  it('says the quote is not there when the index is behind the book', async () => {
    foliate.makeBook.mockResolvedValueOnce(parsedBook(['<html><body><p>nothing like it</p></body></html>']))
    const found = await openPassage(hit(), deps())
    expect(found.kind).toBe('refused')
    if (found.kind !== 'refused') return
    expect(found.why).toMatch(/not in the book any more/u)
    /* ⚠️ **NOT AN EDITION CHANGE.** `bookId` identifies the exact bytes, so
     * another edition is normally another book. */
    expect(found.why.toLowerCase()).not.toContain('edition')
  })

  it('says how many places an ambiguous passage was found in', async () => {
    foliate.makeBook.mockResolvedValueOnce(
      parsedBook(['<html><body><p>the whale. the whale. the whale.</p></body></html>']),
    )
    const found = await openPassage(
      hit({ quote: 'the whale', prefix: '', suffix: '' }),
      deps(),
    )
    expect(found.kind).toBe('refused')
    if (found.kind !== 'refused') return
    expect(found.why).toContain('3')
  })

  it('says a chapter is not in this copy', async () => {
    foliate.makeBook.mockResolvedValueOnce(parsedBook([CHAPTER]))
    const found = await openPassage(hit({ sectionIndex: 9 }), deps())
    expect(found.kind).toBe('refused')
    if (found.kind !== 'refused') return
    expect(found.why).toMatch(/not in this copy/u)
  })

  it('says a book with no spine could not be opened', async () => {
    foliate.makeBook.mockResolvedValueOnce({ sections: undefined, destroy: () => {} })
    const found = await openPassage(hit(), deps())
    expect(found).toEqual({ kind: 'refused', why: expect.stringContaining('could not be opened') })
  })
})

describe('the hook, over a shell that keeps moving', () => {
  /* ⚠️ **A LANDING TOOK TWO SECONDS AND `jumpTo` WAS REBUILT ON EVERY PAGE
   * TURN.** `App`'s `jumpTo` closes over `book.position.chapterLabel`, so
   * turning a page replaces it — and the callback captured the one that existed
   * when the row was CLICKED. The reader was then moved by a closure over the
   * chapter they had already left, with the shelf as it was rather than as it
   * is. `App` never unmounts while a book is closed, so the teardown could not
   * reach any of it. Found by an independent audit. */
  function shell(jumpTo: (place: { bookId: string; cfi: string }) => void) {
    return {
      fs: null as VaultFs | null,
      books: [book()],
      jumpTo,
      onProblem: vi.fn(),
    }
  }

  it('reports through the shell that is current when it resolves, not the one that was clicked', async () => {
    const stale = vi.fn()
    const staleProblem = vi.fn()
    const first = { ...shell(stale), onProblem: staleProblem }
    const { result, rerender } = renderHook((deps: typeof first) => useOpenPassage(deps), {
      initialProps: first,
    })
    const open = result.current
    act(() => {
      open(hit())
    })
    /* The page turn: a new `jumpTo` and a new `onProblem`, while the read is in
     * flight. Nothing unmounts. */
    const freshProblem = vi.fn()
    rerender({ ...shell(vi.fn()), onProblem: freshProblem })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    /* No vault, so this refuses — which is the cheapest outcome to drive and
     * says exactly what is being asserted: WHOSE callback was used. */
    expect(freshProblem).toHaveBeenCalledWith('This device cannot open books from the library index.')
    expect(staleProblem).not.toHaveBeenCalled()
  })

  it('keeps one identity across renders, so a page turn is not a new callback', () => {
    /* The call site's own comment asks for this and the dependency list did not
     * give it: `books` alone is a fresh array on every library publish. A
     * caller listing it in an effect would have restarted its work each time. */
    const props = shell(vi.fn())
    const { result, rerender } = renderHook((deps: typeof props) => useOpenPassage(deps), {
      initialProps: props,
    })
    const first = result.current
    rerender(shell(vi.fn()))
    rerender(shell(vi.fn()))
    expect(result.current).toBe(first)
  })
})
