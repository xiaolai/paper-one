import { describe, expect, it } from 'vitest'
import { socketUrl } from '../kernel'
import { shelfAddress } from './shelfAddress'

/**
 * WHAT `--shelf` ACCEPTS, AND WHAT IT WILL NOT GUESS (WI-11.7).
 *
 * Every refusal here is checked BEFORE anything reaches the network, because
 * the alternatives all fail somewhere the reader cannot see: a guessed
 * hostname fails inside a TLS handshake, a subpath fails as a 404 the socket
 * reports as `refused`, and userinfo does not fail at all — it succeeds, and
 * puts a password in every connection error for the life of the session.
 */

/** The happy path, unwrapped, so a test reads about the address and not the union. */
function address(key: string) {
  const resolved = shelfAddress(key)
  if (!resolved.ok) throw new Error(`expected ${key} to resolve, got: ${resolved.message}`)
  return resolved.address
}

function refusal(key: string): string {
  const resolved = shelfAddress(key)
  if (resolved.ok) throw new Error(`expected ${key} to be refused, got ${resolved.address.origin}`)
  return resolved.message
}

describe('an address it accepts', () => {
  it('takes an https origin as written', () => {
    expect(address('https://shelf.example')).toEqual({
      origin: 'https://shelf.example',
      socket: 'wss://shelf.example/ws',
      submit: 'https://shelf.example/api/auth/submit',
      session: 'https://shelf.example/api/auth/session',
    })
  })

  it('keeps a non-default port, on both the origin and the socket', () => {
    const one = address('https://shelf.example:8443')
    expect(one.origin).toBe('https://shelf.example:8443')
    expect(one.socket).toBe('wss://shelf.example:8443/ws')
  })

  it('allows plain http to loopback, which is the address the tooling already defaults to', () => {
    expect(address('http://127.0.0.1:27182')).toMatchObject({
      origin: 'http://127.0.0.1:27182',
      socket: 'ws://127.0.0.1:27182/ws',
    })
    expect(address('http://localhost:27182').socket).toBe('ws://localhost:27182/ws')
  })

  it('allows a non-loopback IPv6 literal over https — that is a proxy, not the shelf itself', () => {
    expect(address('https://[2001:db8::1]').socket).toBe('wss://[2001:db8::1]/ws')
  })

  it('tolerates surrounding whitespace, which is a shell mistake and not an attack', () => {
    expect(address('  https://shelf.example  ').origin).toBe('https://shelf.example')
  })

  /* ONE ADDRESS, NOT TWO. Case and a default port are the two ways the same
     shelf gets written differently; both collapse here rather than producing
     two spellings that behave the same and read as separate shelves. */
  it.each([
    ['https://SHELF.Example', 'https://shelf.example'],
    ['https://shelf.example:443', 'https://shelf.example'],
    ['HTTPS://Shelf.Example:443/', 'https://shelf.example'],
    ['http://127.0.0.1:80', 'http://127.0.0.1'],
  ])('canonicalises %s to %s', (written, canonical) => {
    expect(address(written).origin).toBe(canonical)
  })

  /* The ws scheme is derived ONCE, in the kernel, and shared with the browser
     client. This asserts they agree rather than asserting a second copy. */
  it('derives its socket scheme from the kernel, not a second rule', () => {
    for (const key of ['https://shelf.example', 'http://127.0.0.1:27182', 'https://shelf.example:8443']) {
      const url = new URL(key)
      expect(address(key).socket).toBe(socketUrl({ protocol: url.protocol, host: url.host }))
    }
  })
})

describe('an address it refuses', () => {
  it('refuses a bare hostname rather than guessing a certificate identity', () => {
    expect(refusal('studio')).toContain('full address with a scheme')
    expect(refusal('studio.tail1234.ts.net')).toContain('full address with a scheme')
  })

  it('refuses plain http to anywhere but loopback, and says what to do', () => {
    const message = refusal('http://shelf.example')
    expect(message).toContain('in the clear')
    expect(message).toContain('https')
  })

  it('refuses IPv6 loopback, because the shelf binds IPv4 only', () => {
    expect(refusal('http://[::1]:27182')).toContain('IPv4 loopback only')
  })

  it.each([
    ['a path', 'https://shelf.example/paper'],
    ['a query', 'https://shelf.example/?token=x'],
    ['a fragment', 'https://shelf.example/#x'],
    ['a scheme that is not http', 'ftp://shelf.example'],
    ['a scheme that is not http (ws)', 'ws://shelf.example'],
    ['an empty key', ''],
    ['whitespace only', '   '],
  ])('refuses %s', (_what, key) => {
    expect(shelfAddress(key).ok).toBe(false)
  })

  it('refuses an inner space or control character', () => {
    expect(refusal('https://shelf.example/ x')).toContain('control character')
    /* A NUL, written as an ESCAPE. It went in as a raw byte first, and
       `scripts/no-binary-source.test.mjs` caught it and named the byte offset
       — the same reason `shelfAddress.ts` spells its character class in
       escapes. A control character in source is invisible to every reader of
       it, including the one who put it there. */
    expect(refusal('https://shelf\u0000.example')).toContain('control character')
  })

  /**
   * THE ONE REFUSAL THAT MUST NOT EXPLAIN ITSELF WITH THE INPUT.
   *
   * `channel.ts` interpolates its url into every connection error, so an
   * accepted userinfo address would print the password on each failure. The
   * refusal must not do it either — a message that quotes the offending key to
   * be helpful is the same leak, one step earlier.
   */
  it('refuses userinfo WITHOUT putting the secret in the message', () => {
    const message = refusal('https://user:hunter2@shelf.example')
    expect(message).toContain('username or password')
    expect(message).not.toContain('hunter2')
    expect(message).not.toContain('user:')
  })

  it('does not leak a password through the bare-hostname path either', () => {
    /* A malformed key still reaches `JSON.stringify(raw)`. Anything shaped
       like credentials must not get that far — this pins that the userinfo
       check runs on a parseable URL before any echo of the input. */
    for (const key of ['https://a:b@c', 'https://:hunter2@shelf.example']) {
      expect(refusal(key)).not.toContain('hunter2')
      expect(refusal(key)).not.toContain('b@c')
    }
  })
})
