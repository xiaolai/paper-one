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
