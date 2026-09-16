import { describe, expect, it } from 'vitest'
import { lookUpSays } from './lookUpWords'

/**
 * The words Look up says, which two surfaces draw — the popup's face and
 * Marginalia's row (#124). Asserted here once; each surface's own test asserts
 * that it shows them, so a change to a sentence turns both red together, which
 * is the coordination two copies of them could not have.
 */
describe('what Look up says', () => {
  it('waits without naming a definition', () => {
    expect(lookUpSays({ kind: 'asking', term: 'gam' })).toEqual({ said: 'Looking…', because: null })
  })

  it('hands back the definition itself once there is one', () => {
    expect(lookUpSays({ kind: 'ready', term: 'gam', text: 'a meeting of whalers' })).toEqual({
      said: 'a meeting of whalers',
      because: null,
    })
  })

  /* "couldn’t", not a bare clause: an apology in the definition's own words
     reads as a definition — `core/gloss.ts`'s doctrine. And the cause is kept
     APART from the sentence, because the popup gives it a line of its own. */
  it('says Paper could not, and keeps the cause separate', () => {
    expect(lookUpSays({ kind: 'failed', term: 'gam', reason: 'The runtime stopped' })).toEqual({
      said: 'Paper couldn’t define “gam”.',
      because: 'The runtime stopped',
    })
  })

  it('says what is missing when nothing can answer', () => {
    expect(lookUpSays({ kind: 'unavailable', term: 'gam', installAt: null })).toEqual({
      said: 'Paper needs a language model to define “gam”.',
      because: null,
    })
  })

  /* NAMES NO TERM. The reader selected a paragraph; quoting a chapter back at
     them says nothing they cannot see. */
  it('names no term for a passage that is not one', () => {
    const words = lookUpSays({ kind: 'tooLong' })
    expect(words.said).toBe('That passage is too long to look up — select a word or a short phrase.')
    expect(words.because).toBe(null)
  })
})
