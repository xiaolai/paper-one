// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ShelfChannel } from './channel'
import { useRemoteStores } from './useRemoteStores'

/**
 * The shelf's notes, held for as long as the link is open.
 *
 * The only test that mounted the browser client's tabs stubs this hook out, so
 * nothing asked whether it hands back a store at all, or whether that store
 * reads the shelf again when a dropped link comes back (WI-20.30).
 */

afterEach(cleanup)

const ROW = {
  id: 'm1',
  bookId: 'b1',
  cfi: 'epubcfi(/6/2)',
  sectionIndex: 1,
  text: 'the whale',
  prefix: '',
  suffix: '',
  note: '',
  kind: 'highlight',
  tint: 'yellow',
  style: 'fill',
  chapter: 'One',
  createdAt: 10,
}

/** A link that answers every `mark.list` with one mark, counts the reads, and lets the test reopen it. */
function linkOf() {
  let reads = 0
  const opened = new Set<(channel: ShelfChannel) => void>()
  const link = {
    call: async () => null,
    stream: (service: string) => ({
      [Symbol.asyncIterator]: async function* () {
        if (service === 'mark.list') reads += 1
        yield [ROW]
      },
    }),
    close: () => {},
    onClosed: () => () => {},
    onOpened: (fn: (channel: ShelfChannel) => void) => {
      opened.add(fn)
      return () => {
        opened.delete(fn)
      }
    },
  }
  const typed: ShelfChannel & { onOpened: typeof link.onOpened } = link
  return {
    link: typed,
    reads: () => reads,
    reopen: () => {
      for (const fn of [...opened]) fn(typed)
    },
    listening: () => opened.size,
  }
}

describe('useRemoteStores', () => {
  it('hands back a store that has read the shelf’s marks', async () => {
    const { link } = linkOf()
    const { result } = renderHook(() => useRemoteStores(link))
    await waitFor(() => expect(result.current.marks?.all.map((mark) => mark.id)).toEqual(['m1']))
  })

  it('reads the shelf again when the link reopens', async () => {
    const shelf = linkOf()
    const { result } = renderHook(() => useRemoteStores(shelf.link))
    await waitFor(() => expect(result.current.marks?.all).toHaveLength(1))
    const before = shelf.reads()
    act(() => shelf.reopen())
    await waitFor(() => expect(shelf.reads()).toBe(before + 1))
  })

  it('stops listening for a reopen once unmounted', async () => {
    const shelf = linkOf()
    const { result, unmount } = renderHook(() => useRemoteStores(shelf.link))
    await waitFor(() => expect(result.current.marks).not.toBeNull())
    unmount()
    expect(shelf.listening()).toBe(0)
  })

  it('takes a bare channel, which has no reopen to hear', async () => {
    const { link } = linkOf()
    const { onOpened: _ignored, ...bare } = link
    const { result } = renderHook(() => useRemoteStores(bare))
    await waitFor(() => expect(result.current.marks?.all).toHaveLength(1))
  })
})
