import { describe, expect, it } from 'vitest'
import { explainFatal } from './reportFatal'

/**
 * THE FATAL SURFACE HAS TO STATE THE FAULT, not the victim.
 *
 * A packaged app has no console anyone will read, so this banner is the only
 * account of a startup failure there is. It printed `name`, `message` and
 * `stack` and dropped `cause` — and `cause` is where the diagnosis lives:
 * `composeCapabilities` reports `capability "sync" failed to start; nothing
 * stays registered`, which names what gave way, while the sentence that says
 * WHY hangs one link below it.
 *
 * That cost two debugging sessions and one bug report with nothing actionable
 * in it. Both times the fault — a path Rust would not accept, then a journal
 * whose sequence went backwards — was one `cause` away from the text on screen.
 */

const errorWith = (message: string, cause: unknown) => new Error(message, { cause })

describe('explainFatal', () => {
  it('prints the cause under the error', () => {
    const text = explainFatal(errorWith('capability "sync" failed to start', new Error('seq 12040 does not increase past 12047')))
    expect(text).toContain('capability "sync" failed to start')
    expect(text).toContain('caused by:')
    expect(text).toContain('seq 12040 does not increase past 12047')
  })

  it('follows a chain more than one link deep', () => {
    const text = explainFatal(errorWith('outer', errorWith('middle', new Error('the actual fault'))))
    expect(text).toContain('the actual fault')
  })

  it('spells out an AggregateError, which is how a rollback reports itself', () => {
    /* The registry wraps a failed start together with every teardown that then
       failed; the interesting one can be any of them. */
    const text = explainFatal(new AggregateError([new Error('first thing'), new Error('second thing')], 'rollback failed'))
    expect(text).toContain('rollback failed')
    expect(text).toContain('first thing')
    expect(text).toContain('second thing')
  })

  /* THIS RUNS WHERE THINGS ARE ALREADY GOING WRONG. A reporter that recurses
     for ever, or hangs, replaces a bad error message with no error message. */
  it('survives a cycle', () => {
    const a = new Error('a')
    const b = errorWith('b', a)
    ;(a as Error & { cause?: unknown }).cause = b
    expect(() => explainFatal(a)).not.toThrow()
    expect(explainFatal(a)).toContain('…')
  })

  it('caps the depth', () => {
    let deep: unknown = new Error('bottom')
    for (let i = 0; i < 20; i++) deep = errorWith(`level ${i}`, deep)
    const text = explainFatal(deep)
    expect(text).toContain('…')
    expect(text).not.toContain('bottom')
  })

  it('takes something that is not an Error at all', () => {
    // `unhandledrejection` hands over whatever was rejected — often a string.
    expect(explainFatal('just a string')).toBe('just a string')
    expect(explainFatal(undefined)).toBe('undefined')
  })
})
