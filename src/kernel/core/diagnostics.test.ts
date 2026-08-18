import { describe, expect, it, vi } from 'vitest'
import { REDACTED, createDiagnostics, defaultDiagnostics, redact } from './diagnostics'
import { NOOP_DIAGNOSTICS } from './ports'

/**
 * The redaction rule, at the edges. The contract suite shows it working on a
 * realistic envelope; this pins the WORD rule — what counts as a key named
 * `token` — because the difference between "substring" and "word" is the
 * difference between redacting `context` and not.
 */
describe('redact', () => {
  it('matches the reserved words as whole words of a key, in any casing style', () => {
    const fields = {
      token: 1,
      Token: 2,
      authToken: 3,
      auth_token: 4,
      'auth-token': 5,
      TOKEN_VALUE: 6,
      apiKey: 7,
      peerId: 8,
      bookText: 9,
      requestBody: 10,
      endpointUrl: 11,
      secrets: 12,
    }
    const out = redact(fields)
    for (const key of Object.keys(fields)) {
      if (key === 'secrets') continue
      expect(out[key], key).toBe(REDACTED)
    }
    // `secrets` is not `secret`: the rule is words, not stems. Named so nobody
    // "fixes" it into a substring match by accident — see the next case.
    expect(out['secrets']).toBe(12)
  })

  it('leaves a key that merely contains a reserved word alone', () => {
    expect(redact({ context: 'a', tokenizer: 'b', keyboard: 'c', textual: 'd', peerless: 'e', bodyguard: 'f' })).toEqual({
      context: 'a',
      tokenizer: 'b',
      keyboard: 'c',
      textual: 'd',
      peerless: 'e',
      bodyguard: 'f',
    })
  })

  it('walks arrays and plain objects, and passes other values through', () => {
    const error = new Error('boom')
    const date = new Date(0)
    const out = redact({
      list: [{ token: 'x', n: 1 }, 'plain', 2],
      deep: { a: { b: { peer: 'p', keep: true } } },
      error,
      date,
    })
    expect(out).toEqual({
      list: [{ token: REDACTED, n: 1 }, 'plain', 2],
      deep: { a: { b: { peer: REDACTED, keep: true } } },
      error,
      date,
    })
    expect(out['error']).toBe(error)
  })

  it('bounds the depth it walks, so a cycle cannot hang the logger', () => {
    const loop: Record<string, unknown> = {}
    loop['self'] = loop
    const out = redact({ loop })
    let at: unknown = out['loop']
    let depth = 0
    while (typeof at === 'object' && at !== null) {
      at = (at as Record<string, unknown>)['self']
      depth += 1
    }
    expect(at).toBe('[deep]')
    expect(depth).toBeGreaterThan(0)
  })

  it('does not mutate what it was given', () => {
    const fields = { token: 'x', nested: { body: 'y' } }
    redact(fields)
    expect(fields).toEqual({ token: 'x', nested: { body: 'y' } })
  })
})

describe('createDiagnostics', () => {
  it('formats the scope into the line and redacts before the sink sees it', () => {
    const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    createDiagnostics({ sink, scope: 'test' }).child('peer').warn('hello', { secret: 's', n: 1 })
    expect(sink.warn).toHaveBeenCalledWith('[paper:test.peer] hello', { secret: REDACTED, n: 1 })
  })

  it('is exactly the no-op when disabled, and the no-op is its own child', () => {
    expect(createDiagnostics({ enabled: false })).toBe(NOOP_DIAGNOSTICS)
    expect(NOOP_DIAGNOSTICS.child('anything')).toBe(NOOP_DIAGNOSTICS)
  })

  it('defaults to enabled in a dev build and to the no-op otherwise', () => {
    // Vitest runs with `import.meta.env.DEV` true — the dev default — and the
    // release side is asked for explicitly.
    expect(defaultDiagnostics()).not.toBe(NOOP_DIAGNOSTICS)
    expect(defaultDiagnostics(false)).toBe(NOOP_DIAGNOSTICS)
  })
})
