import { describe, expect, it } from 'vitest'
import type { SocketLike } from '../kernel'
import { CODE_VAR, COOKIE_VAR, ORIGIN_VAR, cookieFrom, openShelf } from './shelfLink'

/**
 * THE AUTH FLOW BEHIND `paper --shelf` (WI-11.7).
 *
 * ## What is faked here, and what is not
 *
 * The socket is a stand-in; the credential's journey is not. That split is
 * deliberate. The one claim that only a real runtime can settle — that Node
 * puts a `Cookie` on a WebSocket handshake at all — is settled in
 * `nodeSocket.test.ts` against a real `node:http` upgrade. Everything here is
 * about which requests are made, in what order, with what headers, and what is
 * said when one of them refuses; none of that needs a real server, and a real
 * one would only make it slower and flakier.
 *
 * ## Why so many of these are refusals
 *
 * Because every one of them was a way to hand a credential to something that
 * is not the shelf, or to tell a reader the wrong repair. A pairing POST that
 * follows a redirect re-posts the six digits to an origin nobody named. A
 * `Set-Cookie` taken on faith makes a captive portal's cookie into a session.
 * A 401 read as "unreachable" sends someone to check their network when their
 * ninety days ran out.
 */

/** A socket that opens on the next tick and records nothing else. */
function fakeSocket(): SocketLike {
  const socket: SocketLike = {
    binaryType: '',
    send: () => {},
    close: () => {},
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  }
  queueMicrotask(() => socket.onopen?.call(socket, {}))
  return socket
}

interface Call {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** A `fetch` that answers from a table and records every call. */
function fakeFetch(answers: Record<string, () => Response>) {
  const calls: Call[] = []
  const call = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const answer = answers[url]
    if (!answer) throw new Error(`unexpected request to ${url}`)
    return answer()
  }) as typeof globalThis.fetch
  return { call, calls }
}

const SHELF = 'https://shelf.example'
const SUBMIT = `${SHELF}/api/auth/submit`
const SESSION = `${SHELF}/api/auth/session`

const paired = () =>
  new Response(null, { status: 204, headers: { 'set-cookie': 'paper_session=abc123; HttpOnly; Secure; Path=/' } })
const live = () => new Response(null, { status: 204 })
const unauthorised = () => new Response(null, { status: 401 })

/** Run `openShelf` and return the refusal message it threw. */
async function refusal(options: Parameters<typeof openShelf>[0]): Promise<string> {
  try {
    await openShelf(options)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected a refusal, got a caller')
}

describe('with a credential already in the environment', () => {
  it('checks it with the shelf and then opens the socket', async () => {
    const { call, calls } = fakeFetch({ [SESSION]: live })
    const opened: string[] = []
    const caller = await openShelf({
      key: SHELF,
      env: { [COOKIE_VAR]: 'paper_session=abc123', [ORIGIN_VAR]: SHELF },
      fetch: call,
      open: (cookie) => (url) => {
        opened.push(`${url} | ${cookie}`)
        return fakeSocket()
      },
    })
    expect(calls.map((one) => one.url)).toEqual([SESSION])
    expect((calls[0]?.init?.headers as Record<string, string>).Cookie).toBe('paper_session=abc123')
    /* NEVER PAIRS when it does not have to: a code is one of five attempts on
       something that expires in ninety seconds. */
    expect(calls.some((one) => one.url === SUBMIT)).toBe(false)
    expect(opened).toEqual([`wss://shelf.example/ws | paper_session=abc123`])
    await caller.close?.()
  })

  it('says the credential was refused, not that the shelf is unreachable', async () => {
    const { call } = fakeFetch({ [SESSION]: unauthorised })
    const message = await refusal({
      key: SHELF,
      env: { [COOKIE_VAR]: 'paper_session=stale', [ORIGIN_VAR]: SHELF },
      fetch: call,
    })
    expect(message).toContain('revoked or expired')
    expect(message).toContain(CODE_VAR)
  })

  /* THE OPPOSITE REPAIR. An outage must not read as a revocation, or a reader
     pairs again — spending a code — against a shelf that is simply down. */
  it('says the shelf is unreachable when the request itself fails', async () => {
    const call = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as typeof globalThis.fetch
    const message = await refusal({
      key: SHELF,
      env: { [COOKIE_VAR]: 'paper_session=abc', [ORIGIN_VAR]: SHELF },
      fetch: call,
    })
    expect(message).toContain('could not reach')
    expect(message).not.toContain('revoked')
  })
})

describe('with only the six digits', () => {
  it('pairs, reports the credential on the note sink, and connects', async () => {
    const { call, calls } = fakeFetch({ [SUBMIT]: paired, [SESSION]: live })
    const notes: string[] = []
    await openShelf({
      key: SHELF,
      env: { [CODE_VAR]: '123456' },
      fetch: call,
      open: () => fakeSocket,
      note: (line) => notes.push(line),
    })
    expect(calls.map((one) => one.url)).toEqual([SUBMIT, SESSION])
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ code: '123456' })
    /* THE CREDENTIAL GOES TO THE NOTE SINK — stderr — and never to stdout,
       which carries the command's answer and may be piped into `jq`. */
    const said = notes.join('\n')
    expect(said).toContain(`${COOKIE_VAR} = paper_session=abc123`)
    expect(said).toContain(`${ORIGIN_VAR} = ${SHELF}`)
    /* NOT A COMMAND TO PASTE. An apostrophe is a legal cookie-octet, so a
       quoted `export` line is a shell injection waiting for the one credential
       that contains one. */
    expect(said).not.toContain('export ')
    expect(said).not.toContain("'")
  })

  it('refuses to follow a redirect on the pairing request', async () => {
    const { call, calls } = fakeFetch({
      [SUBMIT]: () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/api/auth/submit' } }),
    })
    const message = await refusal({ key: SHELF, env: { [CODE_VAR]: '123456' }, fetch: call })
    expect(message).toContain('redirected')
    /* `redirect: 'manual'` is what makes the refusal possible at all — without
       it Node re-posts the body to the new origin before returning. */
    expect(calls[0]?.init?.redirect).toBe('manual')
  })

  it('refuses a success that issued no cookie', async () => {
    const { call } = fakeFetch({ [SUBMIT]: () => new Response(null, { status: 204 }) })
    expect(await refusal({ key: SHELF, env: { [CODE_VAR]: '123456' }, fetch: call })).toContain('issued no credential')
  })

  /* A COOKIE IS NOT A SESSION. Something that answers 204 with a cookie of its
     own — a portal, a proxy — would otherwise be paired with. The preflight
     catches it, and must say so in words that do not send the reader round the
     loop again. */
  it('refuses a cookie the shelf then will not accept, without telling anyone to pair again', async () => {
    const { call } = fakeFetch({
      [SUBMIT]: () => new Response(null, { status: 204, headers: { 'set-cookie': 'theme=dark; Path=/' } }),
      [SESSION]: unauthorised,
    })
    const message = await refusal({ key: SHELF, env: { [CODE_VAR]: '123456' }, fetch: call })
    expect(message).toContain('not the shelf answering')
    expect(message).not.toContain('revoked')
  })

  it.each([
    [409, 'not showing a code'],
    [410, 'expired'],
    [429, 'too many attempts'],
    [401, 'not right'],
  ])('keeps the shelf own vocabulary for HTTP %i', async (status, said) => {
    const { call } = fakeFetch({ [SUBMIT]: () => new Response(null, { status }) })
    expect(await refusal({ key: SHELF, env: { [CODE_VAR]: '123456' }, fetch: call })).toContain(said)
  })
})

describe('with neither', () => {
  it('names both variables rather than saying it cannot reach a remote shelf', async () => {
    const message = await refusal({ key: SHELF, env: {} })
    expect(message).toContain(COOKIE_VAR)
    expect(message).toContain(CODE_VAR)
    expect(message).toContain(SHELF)
  })
})

describe('a credential minted for one shelf', () => {
  /**
   * These variables are shared with `shot-client.mjs`, which points at a LOCAL
   * shelf by default. So a reader with one exported for local work would
   * otherwise hand it to whatever `--shelf` names next — over the network, to
   * a host that has no business seeing it.
   */
  it('is not sent to another, when the origin says which shelf it belongs to', async () => {
    const { call, calls } = fakeFetch({})
    const message = await refusal({
      key: SHELF,
      env: { [COOKIE_VAR]: 'paper_session=abc', [ORIGIN_VAR]: 'http://127.0.0.1:27182' },
      fetch: call,
    })
    expect(message).toContain(ORIGIN_VAR)
    /* REFUSED BEFORE ANY REQUEST. A guard that leaks the credential and then
       complains is not a guard. */
    expect(calls).toEqual([])
  })

  it('is sent when the declared origin agrees, in whatever spelling', async () => {
    const { call } = fakeFetch({ [SESSION]: live })
    await openShelf({
      key: SHELF,
      env: { [COOKIE_VAR]: 'paper_session=abc', [ORIGIN_VAR]: 'HTTPS://Shelf.Example:443/' },
      fetch: call,
      open: () => fakeSocket,
    })
  })
})

/**
 * THE AUDIT'S OWN FINDINGS, EACH WITH THE TEST THAT WOULD CATCH IT AGAIN.
 *
 * Every one of these passed before the fix and describes something that failed
 * quietly: a credential sent to the wrong host, a shell line that executes,
 * a proxy's cookie carried as a session, advice that could not be followed.
 */
describe('what the audit found', () => {
  it('refuses a credential with no stated audience, rather than sending it wherever --shelf points', async () => {
    const { call, calls } = fakeFetch({})
    const message = await refusal({ key: SHELF, env: { [COOKIE_VAR]: 'paper_session=abc' }, fetch: call })
    expect(message).toContain(ORIGIN_VAR)
    /* REFUSED BEFORE THE REQUEST. Binding that leaks first is not binding. */
    expect(calls).toEqual([])
  })

  it('refuses a cookie it could not put in a header', async () => {
    const { call, calls } = fakeFetch({})
    for (const bad of ['paper_session=has space', 'paper_session=has;semi', 'no-equals-sign', '=novalue']) {
      expect(await refusal({ key: SHELF, env: { [COOKIE_VAR]: bad, [ORIGIN_VAR]: SHELF }, fetch: call })).toContain(
        'well-formed',
      )
    }
    expect(calls).toEqual([])
  })

  /* THE SHELF ISSUES ONE. Anything else on that response belongs to a proxy or
     a portal, and joining them forwarded all of it to the socket and onto the
     reader's terminal as a credential to keep. */
  it('refuses a pairing response that sets more than one cookie', async () => {
    const { call } = fakeFetch({
      [SUBMIT]: () =>
        new Response(null, {
          status: 204,
          headers: [
            ['set-cookie', 'paper_session=abc; HttpOnly'],
            ['set-cookie', 'portal=xyz; Path=/'],
          ],
        }),
    })
    expect(await refusal({ key: SHELF, env: { [CODE_VAR]: '123456' }, fetch: call })).toContain('issued no credential')
  })

  it('pairs with the code when the stored cookie is refused, because that is what the advice says to do', async () => {
    const { call, calls } = fakeFetch({
      [SESSION]: (() => {
        let n = 0
        return () => (n++ === 0 ? unauthorised() : live())
      })(),
      [SUBMIT]: paired,
    })
    const notes: string[] = []
    await openShelf({
      key: SHELF,
      env: { [COOKIE_VAR]: 'paper_session=stale', [ORIGIN_VAR]: SHELF, [CODE_VAR]: '123456' },
      fetch: call,
      open: () => fakeSocket,
      note: (line) => notes.push(line),
    })
    /* stale checked, refused, then paired, then the new one checked. */
    expect(calls.map((one) => one.url)).toEqual([SESSION, SUBMIT, SESSION])
    expect(notes.join('\n')).toContain('was refused')
  })

  it('announces nothing when the credential it just minted does not verify', async () => {
    const { call } = fakeFetch({
      [SUBMIT]: () => new Response(null, { status: 204, headers: { 'set-cookie': 'paper_session=bogus; Path=/' } }),
      [SESSION]: unauthorised,
    })
    const notes: string[] = []
    const message = await refusal({ key: SHELF, env: { [CODE_VAR]: '123456' }, fetch: call, note: (l) => notes.push(l) })
    expect(message).toContain('not the shelf answering')
    /* THE CREDENTIAL MUST NOT HAVE BEEN OFFERED. It used to be printed the
       moment `/api/auth/submit` answered, so one the shelf then refused had
       already been handed over as a session to keep. */
    expect(notes.join('\n')).not.toContain('bogus')
  })
})

describe('cookieFrom', () => {
  function headers(...lines: string[]): Headers {
    const made = new Headers()
    for (const line of lines) made.append('set-cookie', line)
    return made
  }

  it('keeps the pair and drops the attributes', () => {
    expect(cookieFrom(headers('paper_session=abc; HttpOnly; Secure; Max-Age=7776000'))).toBe('paper_session=abc')
  })

  /* THE NAME IS NEVER SPELLED IN TYPESCRIPT. Whatever the server calls its
     cookie goes back — so a rename in `paper-webhost` cannot strand the CLI. */
  it('carries a cookie under any name, because it never looks for one', () => {
    expect(cookieFrom(headers('renamed=abc; HttpOnly'))).toBe('renamed=abc')
  })

  it('is null when nothing was set, and ignores a malformed segment', () => {
    expect(cookieFrom(headers())).toBeNull()
    expect(cookieFrom(headers('HttpOnly; Secure'))).toBeNull()
  })
})
