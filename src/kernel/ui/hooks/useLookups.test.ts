// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hlcOf } from '../../core/hlc'
import { createLookups } from '../../core/lookupStore'
import type { LookupEntry } from '../../core/lookups'
import { useLookups } from './useLookups'

/**
 * The lookup history, bound to React — the adapter Marginalia's Dictionary
 * view reads (WI-17.3). What an adapter can get wrong is small and all of it is
 * here: a snapshot that does not follow the store, and a removal whose refusal
 * escapes as an unhandled rejection.
 */

afterEach(cleanup)

const entry = (over: Partial<LookupEntry> = {}): LookupEntry => ({
  bookId: 'moby',
  cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:7)',
  chapter: 'Loomings',
  spelled: 'wharves',
  sentence: 'Belted round by wharves.',
  gloss: 'Where ships dock.',
  language: 'en',
  at: 1_000,
  ...over,
})

function memory() {
  const map = new Map<string, string>()
  return {
    getItem: vi.fn((key: string) => map.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void map.set(key, value)),
  }
}

describe('useLookups', () => {
  it('follows the store as lookups are recorded', async () => {
    const store = createLookups({ storage: memory(), clock: () => hlcOf(1) })
    const { result } = renderHook(() => useLookups(store))
    expect(result.current.all).toEqual([])

    await act(async () => {
      await store.record(entry())
    })

    expect(result.current.all.map((one) => one.term)).toEqual(['wharves'])
    expect(result.current.persistent).toBe(true)
  })

  it('removes a word through the store', async () => {
    const store = createLookups({ storage: memory(), clock: () => hlcOf(1) })
    await store.record(entry())
    const { result } = renderHook(() => useLookups(store))

    await act(async () => {
      result.current.remove('Wharves')
    })

    expect(result.current.all).toEqual([])
    expect(store.stored()[0]?.deletedAt).toBe(hlcOf(1))
  })

  /* A refused write is what `persistent` reports; it must not also escape. */
  it('lets a refused removal go, and says the history is not being saved', async () => {
    const storage = memory()
    const store = createLookups({ storage, clock: () => hlcOf(1) })
    await store.record(entry())
    storage.setItem.mockImplementation(() => {
      throw new Error('the disk is full')
    })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const { result } = renderHook(() => useLookups(store))

    await act(async () => {
      result.current.remove('wharves')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
    expect(result.current.persistent).toBe(false)
  })

  /* AND A NEW STORE IS A NEW REMOVE: the verb must act on the store the hook was
     given last, not on the first one it ever saw. */
  it('removes from the store it was given most recently', async () => {
    const first = createLookups({ storage: memory(), clock: () => hlcOf(1) })
    const second = createLookups({ storage: memory(), clock: () => hlcOf(2) })
    await first.record(entry())
    await second.record(entry())
    const { result, rerender } = renderHook(({ store }) => useLookups(store), { initialProps: { store: first } })

    rerender({ store: second })
    await act(async () => {
      result.current.remove('wharves')
    })

    expect(second.getSnapshot().all).toEqual([])
    expect(first.getSnapshot().all).toHaveLength(1)
  })

  it('keeps one remove across renders, so a row does not rebind it every time', () => {
    const store = createLookups({ storage: memory() })
    const { result, rerender } = renderHook(() => useLookups(store))
    const first = result.current.remove

    rerender()

    expect(result.current.remove).toBe(first)
  })
})
