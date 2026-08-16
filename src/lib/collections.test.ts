import { describe, expect, it } from 'vitest'
import {
  addCollection,
  collectionIdFor,
  parseCollections,
  removeCollection,
  scopeOf,
  type Collection,
} from './collections'

/**
 * A collection stores a PREDICATE, never a list of books.
 *
 * That is what these are mostly about. Membership lists go stale, leave dangling
 * ids when a book is removed, and can silently disagree with the tags a reader
 * sees on the row. A predicate cannot do any of those things.
 */

const philosophy: Collection = { id: '1', label: 'Philosophy', tag: 'Philosophy' }

describe('scopeOf', () => {
  it('becomes the scope it stands for', () => {
    expect(scopeOf(philosophy)).toEqual({ label: 'Philosophy', tag: 'Philosophy' })
  })

  it('carries a series predicate', () => {
    expect(scopeOf({ id: '2', label: 'Discworld', series: 'Discworld' })).toEqual({
      label: 'Discworld',
      series: 'Discworld',
    })
  })
})

describe('addCollection', () => {
  it('saves the current scope under its name', () => {
    const next = addCollection([], { label: 'Poetry', tag: 'Poetry' }, 'x')
    expect(next).toEqual([{ id: 'x', label: 'Poetry', tag: 'Poetry' }])
  })

  /* Refused by PREDICATE, not by label: two collections named differently over
   * the same tag are the same shelf twice, and always agree. */
  it('refuses a second collection over the same predicate', () => {
    const shelf = [philosophy]
    expect(addCollection(shelf, { label: 'Ethics etc', tag: 'Philosophy' }, 'y')).toBe(shelf)
  })

  it('refuses an empty name', () => {
    expect(addCollection([], { label: '   ', tag: 'X' }, 'z')).toEqual([])
  })

  it('caps a hostile name rather than storing it', () => {
    const long = 'y'.repeat(500)
    const [saved] = addCollection([], { label: long, tag: 'X' }, 'z')
    expect(saved?.label).toHaveLength(60)
  })
})

describe('removeCollection', () => {
  it('removes by id', () => {
    expect(removeCollection([philosophy], '1')).toEqual([])
  })

  it('returns its input unchanged for an id that is not there', () => {
    const shelf = [philosophy]
    expect(removeCollection(shelf, 'nope')).toBe(shelf)
  })
})

describe('parseCollections', () => {
  it('reads a stored list back', () => {
    expect(parseCollections(JSON.stringify([philosophy]))).toEqual([philosophy])
  })

  it('survives nonsense', () => {
    expect(parseCollections('not json')).toEqual([])
    expect(parseCollections(null)).toEqual([])
    expect(parseCollections('{"not":"an array"}')).toEqual([])
  })

  /* One corrupt entry must not cost a reader every collection they have. */
  it('drops a bad row and keeps the rest', () => {
    const raw = JSON.stringify([philosophy, { id: '', label: 'x', tag: 'y' }, 42])
    expect(parseCollections(raw)).toEqual([philosophy])
  })

  /* A collection with no predicate would restrict nothing while claiming to —
   * a shelf headed "Philosophy" showing the whole library. */
  it('drops a collection that restricts nothing', () => {
    expect(parseCollections(JSON.stringify([{ id: '1', label: 'Empty' }]))).toEqual([])
  })
})


/**
 * The id is derived, and that is a claim worth testing rather than a detail.
 *
 * Same scope, same id, on any machine — which is what will let collections be
 * replicated between devices without colliding. `crypto.randomUUID()` here would
 * make two machines that both saved "Philosophy" disagree forever.
 */
describe('collectionIdFor', () => {
  it('is stable for the same scope', () => {
    expect(collectionIdFor({ label: 'Philosophy', tag: 'Philosophy' })).toBe(
      collectionIdFor({ label: 'Philosophy', tag: 'Philosophy' }),
    )
  })

  /* The LABEL is not part of it: two readers who saved the same tag under
   * different names have the same shelf, and should not end up with two. */
  it('ignores the label', () => {
    expect(collectionIdFor({ label: 'Philosophy', tag: 'Phil' })).toBe(
      collectionIdFor({ label: 'Something else', tag: 'Phil' }),
    )
  })

  it('separates a series from a tag of the same name', () => {
    expect(collectionIdFor({ label: 'X', series: 'Dune' })).not.toBe(
      collectionIdFor({ label: 'X', tag: 'Dune' })
    )
  })
})
