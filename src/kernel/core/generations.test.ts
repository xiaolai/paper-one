import { describe, expect, it } from 'vitest'
import { createGenerations } from './generations'

/**
 * THE LAST OPEN WINS, whoever asked.
 *
 * The counter this replaces was advanced by exactly one of its producers — the
 * stored-book route — so a shelf open still reading its bytes stayed "fresh"
 * however many books the reader picked, dropped or followed a link to in the
 * meantime. When it landed it moved them out of the book they had chosen and
 * into the one they had abandoned.
 *
 * Every claim supersedes every earlier one here, which is the property that
 * cannot hold if only some callers claim.
 */
describe('open generations', () => {
  it('keeps the only claim fresh', () => {
    const fresh = createGenerations().claim()
    expect(fresh()).toBe(true)
  })

  /* THE REGRESSION. A second claim from ANY caller retires the first — that is
     what the old counter could not do, because most callers never claimed. */
  it('retires an earlier claim as soon as anything else claims', () => {
    const generations = createGenerations()
    const first = generations.claim()
    const second = generations.claim()
    expect(first(), 'an abandoned open was still considered current').toBe(false)
    expect(second()).toBe(true)
  })

  it('keeps only the newest of many', () => {
    const generations = createGenerations()
    const claims = [generations.claim(), generations.claim(), generations.claim()]
    expect(claims.map((fresh) => fresh())).toEqual([false, false, true])
  })

  /* Asking twice does not change the answer: a predicate is a question, not a
     transition, and an open checks it after every await. */
  it('answers the same however often it is asked', () => {
    const generations = createGenerations()
    const first = generations.claim()
    generations.claim()
    expect([first(), first(), first()]).toEqual([false, false, false])
  })

  it('gives independent counters to independent instances', () => {
    const a = createGenerations()
    const b = createGenerations()
    const first = a.claim()
    b.claim()
    b.claim()
    expect(first(), 'one screen’s opens retired another’s').toBe(true)
  })
})
