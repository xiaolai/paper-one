import { describe, expect, it } from 'vitest'
import { NO_GLOSS } from './gloss'

/**
 * ⚠️ **MOST OF THIS FILE WAS ABOUT MODES**, and the modes are gone.
 *
 * `isLookUpMode`, `availableModes` and `effectiveMode` had thirteen cases
 * between them, all describing how `Look up` chose between Dictionary.app and
 * the gloss. The hand-off is deleted, so there is one behaviour, nothing to
 * choose between, and nothing to test — the cases were not weakened, the
 * functions they exercised do not exist. What is left is the port's own
 * contract, which is the part that was never about the system dictionary.
 */
describe('NO_GLOSS', () => {
  it('reports itself unavailable rather than pretending', () => {
    expect(NO_GLOSS.available).toBe(false)
  })

  /*
   * THE DEFAULT MUST NOT OFFER AN INSTALL, and this is the case that keeps a
   * browser client, iOS and Android from drawing a Look up button that would
   * send the reader to a models pane those builds do not have.
   *
   * It is the whole reason `installable` is a field rather than something the
   * reader UI infers from `available`. Inferring it would make the two states
   * — "no model yet" and "no such feature here" — indistinguishable, and the
   * app would name a feature it does not have on the platforms that have least.
   */
  it('offers no install either, because there is nowhere to install to', () => {
    expect(NO_GLOSS.installable).toBe(false)
  })

  /* Loud, not apologetic. A provider that resolved with a sentence would put
   * that sentence in front of the reader under an amber mark, which is the
   * one thing the mark must never be used for. */
  it('throws rather than resolving with an apology', async () => {
    await expect(NO_GLOSS.gloss('close', { sentence: 'x', bookTitle: 'y' }, new AbortController().signal))
      .rejects.toThrow(/Check `available`/)
  })
})
