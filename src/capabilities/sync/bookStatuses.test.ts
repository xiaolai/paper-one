import { describe, expect, it } from 'vitest'
import { sync } from './index'

/**
 * THE ORDER THE TWO ACTIVITIES ARE OFFERED IN, which is a priority.
 *
 * The kernel takes the FIRST `BookStatus` that answers — see
 * `BookActivity.test.tsx`, which pins that rule at the other end — so this
 * list decides what a book says when both have something to say. A download
 * is in flight and gone in a minute; an arrival note has no deadline and
 * sits there until the reader opens the book. The note listed first would
 * shadow the progress of a re-download for the whole transfer, and the array
 * literal is the only place that is decided.
 */

describe('what a book says when two capabilities both have something to say', () => {
  it('offers the transient activity before the standing one', () => {
    expect(sync.bookStatuses?.map((one) => one.id)).toEqual(['sync:downloading', 'sync:arrived'])
  })

  it('says nothing about a book with neither', () => {
    /* `of` runs on every visible row on every tick, before any runtime has
       started. Its answer for the ordinary book is null, and it must reach
       that without touching a store that does not exist yet. */
    const book = { bookId: 'bk-none', title: 'x', author: 'y', addedAt: 1 }
    for (const one of sync.bookStatuses ?? []) {
      expect(one.of(book as never)).toBeNull()
    }
  })
})

describe('what the statuses answer without a runtime', () => {
  /* THE STATE THE SHELF ACTUALLY RENDERS IN FIRST. `bookStatuses` are read at
     COMPOSITION — before any `start` has run, and again after a teardown —
     so `of` and `subscribe` are called against stores that no runtime owns.
     The old tests asserted the order and an empty lookup and stopped there,
     which left the two paths a reader hits on every cold launch untested. */

  it('subscribes and unsubscribes with no runtime at all', () => {
    /* A shelf mounted before sync starts holds these subscriptions, and
       unmounting must give them back — a listener retained per mount is a
       shelf that redraws for every past screen it ever had. */
    for (const status of sync.bookStatuses ?? []) {
      let fired = 0
      const off = status.subscribe(() => (fired += 1))
      expect(typeof off, `${status.id} returns an unsubscribe`).toBe('function')
      off()
      expect(fired, `${status.id} said nothing on its own`).toBe(0)
    }
  })

  it('survives being asked about a book with nothing on it', () => {
    /* `of` runs for every visible row on every tick. A book with no progress
       and no arrival is the overwhelmingly common case, and it must reach
       null without touching a store that does not exist yet. */
    const bare = { bookId: 'nothing-doing', title: '', author: '', addedAt: 0 }
    for (const status of sync.bookStatuses ?? []) {
      expect(() => status.of(bare as never), status.id).not.toThrow()
      expect(status.of(bare as never), status.id).toBeNull()
    }
  })

  it('is pure — asking twice does not change the answer', () => {
    /* `sync:arrived` used to CLEAR the arrival from inside `of`, so the same
       question asked twice gave two different answers and the second render
       React is free to perform lost the notice. */
    const book = { bookId: 'bk1', title: 'x', author: 'y', addedAt: 1 }
    for (const status of sync.bookStatuses ?? []) {
      expect(status.of(book as never), status.id).toEqual(status.of(book as never))
    }
  })
})
