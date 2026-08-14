import { describe, expect, it } from 'vitest'
import { wordLengthAt } from './speech'

/**
 * `collectText` and `rangeAt` are NOT unit-tested here, deliberately.
 *
 * Both need a real Document, and this suite runs without a DOM environment.
 * Adding one means adding a dependency and re-resolving the lockfile — which
 * is what the Linux build is currently blocked on, under pnpm's release-age
 * policy — for a test that would assert against jsdom's approximation of
 * WebKit's layout rather than against WebKit.
 *
 * They are verified instead against the running app through the MCP bridge, on
 * the actual engine the reader ships on, per the project's own end-to-end note.
 * That is better evidence for exactly the thing that can go wrong here: the
 * highlight landing on the wrong word. What is left below is the part with no
 * DOM in it, which is also the part with the sharp edge.
 */

describe('wordLengthAt', () => {
  it('measures the word when the engine reports no length', () => {
    // WebKit reports charLength 0 on some voices, and a zero-width highlight
    // is invisible — indistinguishable from boundaries not working at all.
    expect(wordLengthAt('Call me Ishmael', 8)).toBe(7)
    expect(wordLengthAt('Call me Ishmael', 0)).toBe(4)
  })

  it('measures a word ending at the end of the text', () => {
    expect(wordLengthAt('Call me', 5)).toBe(2)
  })

  it('never returns zero, so the highlight is never invisible', () => {
    // Pointed at whitespace — which a conforming engine does not do, since
    // charIndex is a word start. The floor is what stops a malformed event
    // producing a zero-width box.
    expect(wordLengthAt('Call me', 4)).toBe(1)
    expect(wordLengthAt('Call ', 4)).toBe(1)
    expect(wordLengthAt('', 0)).toBe(1)
  })
})
