import { describe, expect, it } from 'vitest'
import type { IndexedBook } from './bookIndex'
import { fakeFs } from './fakeFs.testkit'
import type { MutationKind, MutationRecorder, MutationToken } from './ports'
import { createKernelServices } from './services'

/**
 * The bind/unbind contract of the recorder and clock ports (C2).
 *
 * Binding is late — the sync journal arrives after the stores exist — and its
 * disposer must RESTORE the previous target, not leave the stores delegating
 * into a journal that has since closed. These tests drive a real write through
 * the store and watch which recorder it reaches.
 */

function spyRecorder(): { recorder: MutationRecorder; kinds: MutationKind[] } {
  const kinds: MutationKind[] = []
  return {
    kinds,
    recorder: {
      begin: async (book: string, what: MutationKind): Promise<MutationToken> => {
        kinds.push(what)
        return { book, what }
      },
      commit: async () => {},
    },
  }
}

const BOOK: IndexedBook = { bookId: 'book_x', title: 'X', author: '', openedAt: 1 }

function servicesWith(defaultRecorder: MutationRecorder) {
  const fs = fakeFs({ 'books/book_x/book.json': JSON.stringify({ bookId: 'book_x', title: 'X' }) })
  return createKernelServices({ fs, storage: null, initialBooks: [BOOK], recorder: defaultRecorder })
}

describe('bindRecorder / bindClock disposers', () => {
  it('restores the default recorder on dispose, so no write reaches a torn-down journal', async () => {
    const base = spyRecorder()
    const journal = spyRecorder()
    const services = servicesWith(base.recorder)

    const unbind = services.bindRecorder(journal.recorder)
    await services.library.update('book_x', (record) => ({ ...record, title: 'A' }))
    await services.drain()
    expect(journal.kinds).toEqual(['record'])
    expect(base.kinds).toEqual([])

    unbind.dispose()
    await services.library.update('book_x', (record) => ({ ...record, title: 'B' }))
    await services.drain()
    // The write after unbind reaches the DEFAULT, never the unbound journal.
    expect(journal.kinds).toEqual(['record'])
    expect(base.kinds).toEqual(['record'])
  })

  it('frees the slot so the services can be bound again (re-composition)', async () => {
    const services = servicesWith(spyRecorder().recorder)
    const first = services.bindRecorder(spyRecorder().recorder)
    expect(() => services.bindRecorder(spyRecorder().recorder)).toThrow(/already bound/)
    first.dispose()
    expect(() => services.bindRecorder(spyRecorder().recorder)).not.toThrow()
  })

  it('dispose is idempotent and identity-guarded — an old disposer cannot unbind a newer target', async () => {
    const base = spyRecorder()
    const services = servicesWith(base.recorder)
    const first = services.bindRecorder(spyRecorder().recorder)
    first.dispose()
    const second = spyRecorder()
    services.bindRecorder(second.recorder)
    // The stale disposer fires again; it must not touch the new binding.
    first.dispose()
    await services.library.update('book_x', (record) => ({ ...record, title: 'C' }))
    await services.drain()
    expect(second.kinds).toEqual(['record'])
    expect(base.kinds).toEqual([])
  })

  it('bindClock returns a disposer that frees the slot', () => {
    const services = servicesWith(spyRecorder().recorder)
    const unbind = services.bindClock(() => '000000000000-0000-0000000000000000' as never)
    expect(() => services.bindClock(() => '000000000000-0000-0000000000000000' as never)).toThrow(/already bound/)
    unbind.dispose()
    expect(() => services.bindClock(() => '000000000000-0000-0000000000000000' as never)).not.toThrow()
  })
})
