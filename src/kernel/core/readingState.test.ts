import { describe, expect, it } from 'vitest'
import { READING_STATES, STARS } from './readingState'

describe('the closed sets the record and the wire share', () => {
  it('names three reading states and five stars, and no others', () => {
    /* `parseRecord`, `isOpinion` and the wire all check membership here; a
       word dropped from this list is a state no reader can have. */
    expect(READING_STATES).toEqual(['want', 'reading', 'finished'])
    expect(STARS).toEqual([1, 2, 3, 4, 5])
  })
})
