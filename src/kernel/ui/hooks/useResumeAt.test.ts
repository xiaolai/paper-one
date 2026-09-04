// @vitest-environment jsdom
import { act, render, renderHook } from '@testing-library/react'
import { createElement, useLayoutEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { IndexFs } from '../../core/bookIndex'
import type { BookRecord, readBook } from '../../core/bookFolder'
import { useResumeAt } from './useResumeAt'

/**
 * The record's word on where to resume, and WHEN it is allowed to speak.
 *
 * `locationToOpen` ranks a resume above the row's cached position, so a resume
 * that outlives the open it was read for is a stale answer that wins. These
 * pin that no committed render answers with a previous open's value, and that
 * a read answering nothing clears the value its own open holds.
 */

type Read = typeof readBook

function reads() {
  const pending: { resolve(record: BookRecord | null): void; reject(cause: unknown): void }[] = []
  const read = vi.fn<Read>(
    () =>
      new Promise<BookRecord | null>((resolve, reject) => {
        pending.push({ resolve, reject })
      }),
  )
  return { read, pending }
}

const FS = {} as IndexFs
const record = (position: string): BookRecord => ({ title: 'Moby-Dick', author: '', position })
const settle = () => act(async () => {})

describe('where the open book resumes', () => {
  it('lets the row speak until the record does, then says what the record holds', async () => {
    const { read, pending } = reads()
    const { result } = renderHook(({ bookId }) => useResumeAt(bookId, FS, read), { initialProps: { bookId: 'book:a' as string | null } })
    expect(result.current).toBeNull()
    await act(async () => pending[0]!.resolve(record('p1')))
    expect(result.current).toEqual({ bookId: 'book:a', position: 'p1' })
  })

  it('never answers a previous open’s value on ANY committed render of a reopen — the reader reads the first one', async () => {
    /* The reader's ref takes `lastLocation` from a committed render, and the
       old hook cleared the stale value from a passive effect — AFTER that
       commit. A log written in a layout effect sees exactly what each commit
       answered, before any passive effect runs; `waitFor` would have looked
       past the render that mattered. */
    const { read, pending } = reads()
    const committed: (string | null)[] = []
    function Probe({ bookId }: { readonly bookId: string | null }) {
      const answer = useResumeAt(bookId, FS, read)
      useLayoutEffect(() => {
        committed.push(answer === null ? null : answer.position)
      })
      return null
    }
    const { rerender } = render(createElement(Probe, { bookId: 'book:a' }))
    await act(async () => pending[0]!.resolve(record('p1')))
    expect(committed.at(-1)).toBe('p1')
    /* Closed, then the same book opened again with its record read still on its way. */
    rerender(createElement(Probe, { bookId: null }))
    const reopenedAt = committed.length
    rerender(createElement(Probe, { bookId: 'book:a' }))
    await settle()
    expect(read).toHaveBeenCalledTimes(2)
    expect(committed.slice(reopenedAt)).not.toContain('p1')
    expect(committed.slice(reopenedAt).every((one) => one === null)).toBe(true)
    /* And the new read's answer is what the reopen resumes at. */
    await act(async () => pending[1]!.resolve(record('p2')))
    expect(committed.at(-1)).toBe('p2')
  })

  it('answers null for a reopen until its own read lands, whatever the previous open read', async () => {
    const { read, pending } = reads()
    const { result, rerender } = renderHook(({ bookId }) => useResumeAt(bookId, FS, read), { initialProps: { bookId: 'book:a' as string | null } })
    await act(async () => pending[0]!.resolve(record('p1')))
    expect(result.current).toEqual({ bookId: 'book:a', position: 'p1' })
    rerender({ bookId: null })
    expect(result.current).toBeNull()
    rerender({ bookId: 'book:a' })
    expect(result.current).toBeNull()
    await settle()
    expect(read).toHaveBeenCalledTimes(2)
    expect(result.current).toBeNull()
    await act(async () => pending[1]!.resolve(record('p2')))
    expect(result.current).toEqual({ bookId: 'book:a', position: 'p2' })
  })

  it('clears what its own open holds on a read that answers nothing, or will not read', async () => {
    /* A filesystem change re-reads the same open: a record now gone or
       unreadable clears the value the earlier read of this open left. */
    const { read, pending } = reads()
    const { result, rerender } = renderHook(({ bookId, fs }) => useResumeAt(bookId, fs, read), { initialProps: { bookId: 'book:a' as string | null, fs: FS as IndexFs | null } })
    await act(async () => pending[0]!.resolve(record('p1')))
    expect(result.current).toEqual({ bookId: 'book:a', position: 'p1' })
    rerender({ bookId: 'book:a', fs: { ...FS } as IndexFs })
    await act(async () => pending[1]!.resolve(null))
    expect(result.current).toBeNull()
    rerender({ bookId: 'book:a', fs: { ...FS, extra: 1 } as IndexFs })
    await act(async () => pending[2]!.resolve(record('p3')))
    expect(result.current).toEqual({ bookId: 'book:a', position: 'p3' })
    rerender({ bookId: 'book:a', fs: { ...FS, extra: 2 } as IndexFs })
    await act(async () => pending[3]!.reject(new Error('unreadable')))
    expect(result.current).toBeNull()
  })

  it('switches books cleanly: another book’s value is never answered, and a read that lands after the switch is ignored', async () => {
    const { read, pending } = reads()
    const { result, rerender } = renderHook(({ bookId }) => useResumeAt(bookId, FS, read), { initialProps: { bookId: 'book:a' as string | null } })
    rerender({ bookId: 'book:b' })
    /* The first open's read lands late: it belongs to an open that is over. */
    await act(async () => pending[0]!.resolve(record('late')))
    expect(result.current).toBeNull()
    await act(async () => pending[1]!.resolve(record('q1')))
    expect(result.current).toEqual({ bookId: 'book:b', position: 'q1' })
    rerender({ bookId: 'book:a' })
    expect(result.current).toBeNull()
    await settle()
    expect(read).toHaveBeenCalledTimes(3)
    expect(result.current).toBeNull()
    await act(async () => pending[2]!.resolve(record('p4')))
    expect(result.current).toEqual({ bookId: 'book:a', position: 'p4' })
  })

  it('reads nothing without a filesystem or a book', () => {
    const { read } = reads()
    const { result, rerender } = renderHook(({ bookId, fs }) => useResumeAt(bookId, fs, read), { initialProps: { bookId: null as string | null, fs: FS as IndexFs | null } })
    expect(result.current).toBeNull()
    rerender({ bookId: 'book:a', fs: null })
    expect(result.current).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
})
