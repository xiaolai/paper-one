import { describe, expect, it } from 'vitest'
import { checkSession, normalizeCode, signOut, submitCode } from './session'

/** A `fetch` that answers one status, and records what it was asked. */
function answering(status: number, calls: { url: string; init: RequestInit | undefined }[] = []) {
  const fetcher = ((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(new Response(null, { status }))
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

const failing = (() => Promise.reject(new TypeError('network'))) as unknown as typeof fetch

describe('checkSession', () => {
  it('reads 204 as connected and 401 as needing a code', async () => {
    expect(await checkSession(answering(204).fetcher)).toEqual({ kind: 'connected' })
    expect(await checkSession(answering(401).fetcher)).toEqual({ kind: 'needs-code' })
  })

  it('treats an unreachable shelf as unreachable, NOT as needing a code', async () => {
    /* The distinction the whole screen turns on. Showing code entry to someone
     * whose shelf is asleep sends them hunting for a screen that is not on. */
    expect(await checkSession(failing)).toEqual({ kind: 'unreachable' })
  })

  it('treats an answer it does not understand as unreachable', async () => {
    /* A proxy error page or a version skew. Asking for a code would not fix
     * either, so it must not be reported as a missing credential. */
    for (const status of [500, 502, 418, 302]) {
      expect(await checkSession(answering(status).fetcher)).toEqual({ kind: 'unreachable' })
    }
  })

  it('sends the cookie', async () => {
    const { fetcher, calls } = answering(204)
    await checkSession(fetcher)
    expect(calls[0]?.init?.credentials).toBe('same-origin')
  })
})

describe('submitCode', () => {
  it('maps every status the shelf distinguishes to its own outcome', async () => {
    const cases = [
      [204, 'connected'],
      [401, 'wrong'],
      [409, 'no-code-showing'],
      [410, 'expired'],
      [429, 'no-attempts-left'],
    ] as const
    for (const [status, kind] of cases) {
      expect(await submitCode('123456', answering(status).fetcher)).toEqual({ kind })
    }
  })

  it('does not fold the fixable cases together', async () => {
    /* Each of these has a DIFFERENT fix, and a single "could not sign in"
     * would send someone hunting for a typo when no code is on screen. */
    const kinds = await Promise.all(
      [409, 410, 429, 401].map(async (status) => (await submitCode('1', answering(status).fetcher)).kind),
    )
    expect(new Set(kinds).size).toBe(4)
  })

  it('reports a network failure as unreachable rather than as a wrong code', async () => {
    expect(await submitCode('123456', failing)).toEqual({ kind: 'unreachable' })
  })

  it('posts the code as json, same-origin', async () => {
    const { fetcher, calls } = answering(204)
    await submitCode('123456', fetcher)
    expect(calls[0]?.url).toBe('/api/auth/submit')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.credentials).toBe('same-origin')
    expect(calls[0]?.init?.body).toBe('{"code":"123456"}')
  })
})

describe('signOut', () => {
  it('does not throw when the shelf cannot be reached', async () => {
    /* The screen still has to clear. The shelf keeps the credential until it
     * hears otherwise, which is the safe direction to fail. */
    await expect(signOut(failing)).resolves.toBeUndefined()
  })
})

describe('normalizeCode', () => {
  it('keeps digits, drops everything else, and stops at six', () => {
    expect(normalizeCode('123456')).toBe('123456')
    expect(normalizeCode('12 34-56')).toBe('123456')
    expect(normalizeCode('1234567890')).toBe('123456')
    expect(normalizeCode('abc')).toBe('')
    /* A pasted code with a stray space or dash is the common case, and
     * refusing it would be the app being pedantic at the one moment the reader
     * is already doing something tedious. */
    expect(normalizeCode(' 12-34 56 ')).toBe('123456')
  })
})
