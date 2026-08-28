// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMarking } from './useMarking'
import type { Book } from './useBook'
import type { MarksView } from './useMarks'

/**
 * The focus request's lifetime — the half of WI-20.15 that lives in the owner.
 *
 * `focusMark` asked and nothing ever answered: the request sat in state for
 * the life of the session, and every consumer that mounted or re-ran saw it
 * again. The Marginalia panel now says when it has honoured one, and the
 * owner clears it — but only THAT one, because a second request can land
 * while the first is still being scrolled to, and a clear that did not check
 * would throw the newer request away.
 */

afterEach(cleanup)

const book = () =>
  ({
    bookId: 'open-book',
    drawMark: vi.fn(),
    eraseMark: vi.fn(),
    deselect: vi.fn(),
    doc: null,
    position: { chapterLabel: 'Loomings' },
  }) as unknown as Book

const marks = () => ({ current: [], add: vi.fn(), remove: vi.fn() }) as unknown as MarksView

describe('a focus request', () => {
  it('is cleared once the panel says it has been honoured', () => {
    const { result } = renderHook(() => useMarking(book(), marks()))
    act(() => result.current.focusMark('m1', true))
    const asked = result.current.focus
    expect(asked).toMatchObject({ id: 'm1', edit: true })

    act(() => result.current.clearFocus(asked!.nonce))
    expect(result.current.focus).toBeNull()
  })

  it('survives a clear that names an older request', () => {
    const { result } = renderHook(() => useMarking(book(), marks()))
    act(() => result.current.focusMark('m1'))
    const first = result.current.focus!.nonce
    act(() => result.current.focusMark('m2'))
    /* The panel finished with m1 after m2 had been asked for. m2 is still
       owed; clearing on m1's word would lose it. */
    act(() => result.current.clearFocus(first))
    expect(result.current.focus).toMatchObject({ id: 'm2' })
  })
})
