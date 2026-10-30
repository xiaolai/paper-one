import { describe, expect, it } from 'vitest'
import { BOOK_DRAG_TYPE, hasBookDrag, readBookDrag } from './bookDrag'

/**
 * The drag payload is an external input like any other: whatever a drop hands
 * over is checked before it is believed. `writeBookDrag` is not exercised here
 * because `DataTransfer` does not exist outside a real browser event — the
 * write side is one `setData` call, and the round trip is driven in the app.
 */

/** A DataTransfer-shaped fake: the two members the readers touch. */
function transfer(data: Record<string, string>): DataTransfer {
  return {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer
}

describe('readBookDrag', () => {
  it('reads the ids a drag carried', () => {
    expect(readBookDrag(transfer({ [BOOK_DRAG_TYPE]: '["book:a","book:b"]' }))).toEqual([
      'book:a',
      'book:b',
    ])
  })

  it('is null for a drag that is not books at all', () => {
    expect(readBookDrag(transfer({ 'text/plain': 'hello' }))).toBeNull()
    expect(readBookDrag(null)).toBeNull()
  })

  /* The contract says "carried none → null", so every caller has ONE
   * emptiness to check — `[]` slipping through made zero-book work. */
  it('treats an empty list as no drag', () => {
    expect(readBookDrag(transfer({ [BOOK_DRAG_TYPE]: '[]' }))).toBeNull()
  })

  it('refuses a payload that only claims to be a list', () => {
    expect(readBookDrag(transfer({ [BOOK_DRAG_TYPE]: 'not json' }))).toBeNull()
    expect(readBookDrag(transfer({ [BOOK_DRAG_TYPE]: '{"a":1}' }))).toBeNull()
    expect(readBookDrag(transfer({ [BOOK_DRAG_TYPE]: '[1,2]' }))).toBeNull()
  })
})

describe('hasBookDrag', () => {
  it('recognises the type without reading the payload', () => {
    expect(hasBookDrag(transfer({ [BOOK_DRAG_TYPE]: 'x' }))).toBe(true)
    expect(hasBookDrag(transfer({ Files: '' }))).toBe(false)
    expect(hasBookDrag(null)).toBe(false)
  })
})
