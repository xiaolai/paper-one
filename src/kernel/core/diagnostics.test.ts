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
      expect(out[key], key).toBe(REDACTED)
    }
    // `secrets` IS redacted: a trailing-`s` plural counts as its singular. This
    // stays a word rule, not a substring one — the next case proves `peerless`
    // and friends (which merely end in `s`) are left alone.
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

  it('walks arrays and plain objects, reduces an Error to its type, and passes other values through', () => {
    const error = new Error('a line of the book leaked into a throw')
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
      // The Error's message — which could be book text or a secret — is gone;
      // only its type survives.
      error: '[Error]',
      date,
    })
  })

  it('splits acronym boundaries, so APIKey and JWTToken cannot sail past the list', () => {
    const out = redact({ APIKey: 'k', JWTToken: 't', HTTPAuthorization: 'a', APIVersion: 3 })
    expect(out['APIKey']).toBe(REDACTED)
    expect(out['JWTToken']).toBe(REDACTED)
    expect(out['HTTPAuthorization']).toBe(REDACTED)
    // A benign acronym compound is untouched.
    expect(out['APIVersion']).toBe(3)
  })

  it("keeps an Error's name only when it is shaped like a type", () => {
    const hostile = new Error('x')
    hostile.name = 'the secret is hunter2'
    expect(redact({ hostile })['hostile']).toBe('[Error]')
    class CapabilityError extends Error {
      override name = 'CapabilityError'
    }
    expect(redact({ typed: new CapabilityError('y') })['typed']).toBe('[CapabilityError]')
  })

  it('reduces containers it cannot walk — a Map, a Set, a class instance — to their type', () => {
    class Session {
      token = 'secret'
    }
    const out = redact({
      map: new Map([['token', 'secret']]),
      set: new Set(['secret']),
      bytes: new Uint8Array([1, 2, 3]),
      instance: new Session(),
    })
    expect(out).toEqual({ map: '[Map]', set: '[Set]', bytes: '[Uint8Array]', instance: '[Session]' })
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

describe('a sink that throws', () => {
  it('loses the diagnostic and nothing else — the caller in a catch block is not handed a second failure', () => {
    const sink = {
      info: () => {
        throw new Error('channel closed')
      },
      warn: () => {
        throw new Error('channel closed')
      },
      error: () => {
        throw new Error('channel closed')
      },
    }
    const diagnostics = createDiagnostics({ sink })
    expect(() => diagnostics.info('boot', {})).not.toThrow()
    expect(() => diagnostics.warn('boot', { why: 'x' })).not.toThrow()
    expect(() => diagnostics.error('boot', {})).not.toThrow()
    expect(() => diagnostics.child('sync').warn('push', {})).not.toThrow()
  })
})

/**
 * THE FOUR THE KEY-NAME RULE COULD NOT SEE, each one an audit finding.
 *
 * `redact` decides by KEY. That covers a secret in a field called `token` and
 * nothing about the shape of what arrives, so depth was bounded while width
 * and length were not, one key was interpreted rather than stored, and the
 * line the scope is filtered on could be forged from inside a field.
 */
describe('what a shape can do that a key name cannot', () => {
  it('stores __proto__ as data instead of letting it set a prototype', () => {
    /* `out[key] = value` invokes the prototype setter: the field vanishes as
       an own property — neither redacted nor reported — and the object's
       prototype changes for every later reader. */
    const out = redact(JSON.parse('{"__proto__": {"polluted": true}, "kept": 1}') as Record<string, unknown>)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true)
    expect(out['kept']).toBe(1)
  })

  it('bounds a wide object, and says how much it left out', () => {
    /* Depth was bounded and width was not, so one wide object was walked,
       formatted and written in full on an error path. */
    const wide: Record<string, unknown> = {}
    for (let i = 0; i < 500; i++) wide[`k${i}`] = i
    const out = redact(wide)
    expect(Object.keys(out).length).toBeLessThan(200)
    expect(String(out['…'])).toMatch(/more/)
  })

  it('bounds a wide array the same way', () => {
    const out = redact({ list: Array.from({ length: 500 }, (_, i) => i) })
    const list = out['list'] as unknown[]
    expect(list.length).toBeLessThan(200)
    expect(String(list[list.length - 1])).toMatch(/more/)
  })

  it('truncates a free-form string, which is where book text arrives', () => {
    /* Callers pass `message: thrown.message`, and `sync.session-failed` is one
       of them — so a paragraph of a book reaches the log under a key no list
       of names will ever contain. */
    const out = redact({ message: 'x'.repeat(5_000) })
    const said = String(out['message'])
    expect(said.length).toBeLessThan(700)
    expect(said).toMatch(/more chars/)
  })

  it('leaves an ordinary message intact', () => {
    /* The bound has to be generous or it would cost every real diagnostic its
       meaning, which is a worse trade than the one it is making. */
    const message = 'sync.push answered an ack that does not match the pushed group'
    expect(redact({ message })['message']).toBe(message)
  })

  it('cannot be made to forge a log line from inside a scope or an event', () => {
    /* The line exists to be filtered on. A newline in either half forges a
       second line that looks real, and hides the rest of the true one from a
       grep on the scope. */
    const out = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    createDiagnostics({ sink: out, scope: 'kernel\n[paper:peer] forged' }).info('e\nalso-forged', {})
    const written = String(out.info.mock.calls[0]?.[0])
    expect(written).not.toContain('\n')
    expect(written.startsWith('[paper:kernel?')).toBe(true)
  })
})
