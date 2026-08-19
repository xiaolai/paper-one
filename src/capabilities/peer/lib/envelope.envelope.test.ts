import { describe, expect, it, vi } from 'vitest'
import type { ServiceContribution } from '../../../kernel'
import {
  DEFAULT_TIMEOUT_MS,
  ENVELOPE_ERRORS,
  ENVELOPE_SERVICE,
  ENVELOPE_VERSION,
  FrameTooLarge,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_JSON_DEPTH,
  MAX_PAYLOAD_BYTES,
  MalformedFrame,
  ServiceCallError,
  UNKNOWN_ID,
  UnsupportedVersion,
  createClient,
  createRouter,
  decodeFrame,
  encodeFrame,
  parseFrame,
  serviceError,
  type Frame,
  type ServiceError,
  type Timers,
} from './envelope'

/**
 * THE ENVELOPE CONTRACT (mobile-sync plan I.4; WI-5.6): the codec refuses
 * what is not a frame — malformed, oversized, another version — and the
 * router refuses, as a typed `err`, every request it must not run: an unknown
 * service, a duplicate id, a peer without the grant (before the handler sees a
 * byte), a frame from another version, a `stream` after `end`; and it takes
 * down what it is running on `cancel`, on timeout and on disconnect. Every
 * refusal is a frame a client can match on. The client stub correlates ids.
 *
 * Every case here would fail without its guard.
 */

/* ---------------------------------------------------------------- fixtures */

const frame = (over: Partial<Frame> = {}): Frame => ({
  v: ENVELOPE_VERSION,
  service: 'example.ping',
  id: 'r1',
  kind: 'req',
  body: { hello: 'world' },
  ...over,
})

/** A clock the tests drive by hand — the router's and the client's timers. */
function fakeTimers(): Timers & { advance(ms: number): void; pending(): number } {
  let now = 0
  let next = 0
  const queue: { at: number; id: number; fn: () => void }[] = []
  return {
    setTimeout: (fn, ms) => {
      const id = ++next
      queue.push({ at: now + ms, id, fn })
      return id
    },
    clearTimeout: (handle) => {
      const at = queue.findIndex((entry) => entry.id === handle)
      if (at >= 0) queue.splice(at, 1)
    },
    advance(ms) {
      now += ms
      for (;;) {
        const due = queue.filter((entry) => entry.at <= now).sort((a, b) => a.at - b.at || a.id - b.id)[0]
        if (!due) return
        queue.splice(queue.indexOf(due), 1)
        due.fn()
      }
    },
    pending: () => queue.length,
  }
}

/** Let the router's async handler dispatch settle. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

const ping: ServiceContribution = { name: 'example.ping', grant: 'example:ping', handler: async (req) => req }

/** A router over `services`, connected as `peer`; every frame it writes is decoded into `sent`. */
function harness(services: ServiceContribution[], hasGrant: (peer: string, grant: string) => boolean = () => true, timeoutMs?: number) {
  const timers = fakeTimers()
  const router = createRouter({ services, hasGrant, timers, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
  const sent: Frame[] = []
  const connection = router.connect('peer-a', (bytes) => sent.push(decodeFrame(bytes)))
  return { router, connection, sent, timers, send: (f: Frame) => connection.receive(encodeFrame(f)) }
}

const errBody = (f: Frame | undefined): ServiceError => f?.body as ServiceError

/* --------------------------------------------------------------- codec */

describe('the codec', () => {
  it('round-trips every kind, with a length prefix', () => {
    for (const kind of ['req', 'res', 'stream', 'end', 'err', 'cancel'] as const) {
      const f = frame({ kind, body: kind === 'end' || kind === 'cancel' ? null : { kind, n: [1, 2, 3] } })
      const bytes = encodeFrame(f)
      expect(new DataView(bytes.buffer).getUint32(0, false)).toBe(bytes.byteLength - HEADER_BYTES)
      expect(decodeFrame(bytes)).toEqual(f)
    }
  })

  it('round-trips a body with non-ASCII text, and JSON scalars', () => {
    expect(decodeFrame(encodeFrame(frame({ body: 'Ünïcödé — 书' }))).body).toBe('Ünïcödé — 书')
    expect(decodeFrame(encodeFrame(frame({ body: 0 }))).body).toBe(0)
    expect(decodeFrame(encodeFrame(frame({ body: false }))).body).toBe(false)
    expect(decodeFrame(encodeFrame(frame({ body: null }))).body).toBe(null)
  })

  it('refuses a payload over 4 MiB on encode', () => {
    const big = 'x'.repeat(MAX_FRAME_BYTES)
    expect(() => encodeFrame(frame({ body: big }))).toThrow(FrameTooLarge)
    // Just under the cap encodes: the cap is on the JSON payload, not the body string.
    const under = 'x'.repeat(MAX_FRAME_BYTES - 200)
    expect(decodeFrame(encodeFrame(frame({ body: under }))).body).toBe(under)
  })

  it('refuses an oversized declared length before decoding anything', () => {
    const header = new Uint8Array(HEADER_BYTES + 4)
    new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false)
    // No payload of that size is present; the header alone is judged.
    expect(() => decodeFrame(header)).toThrow(FrameTooLarge)
    let error: unknown
    try {
      decodeFrame(header)
    } catch (thrown) {
      error = thrown
    }
    expect((error as FrameTooLarge).bytes).toBe(MAX_FRAME_BYTES + 1)
  })

  it('refuses a short header, a length that disagrees with the bytes, non-UTF-8 and non-JSON', () => {
    expect(() => decodeFrame(new Uint8Array(2))).toThrow(MalformedFrame)
    const good = encodeFrame(frame())
    expect(() => decodeFrame(good.subarray(0, good.byteLength - 1))).toThrow(MalformedFrame)
    const bad = new Uint8Array(HEADER_BYTES + 2)
    new DataView(bad.buffer).setUint32(0, 2, false)
    bad.set([0xff, 0xfe], HEADER_BYTES)
    expect(() => decodeFrame(bad)).toThrow(/not UTF-8/)
    const text = new TextEncoder().encode('{nope')
    const notJson = new Uint8Array(HEADER_BYTES + text.byteLength)
    new DataView(notJson.buffer).setUint32(0, text.byteLength, false)
    notJson.set(text, HEADER_BYTES)
    expect(() => decodeFrame(notJson)).toThrow(/not JSON/)
  })

  it.each([
    ['not an object', 42],
    ['an array', [frame()]],
    ['a missing service', { v: 1, id: 'r1', kind: 'req', body: null }],
    ['an empty id', { ...frame(), id: '' }],
    ['a name over the bound', { ...frame(), service: 'x'.repeat(129) }],
    ['an unknown kind', { ...frame(), kind: 'push' }],
    ['a missing body', { v: 1, service: 'a.b', id: 'r1', kind: 'req' }],
    ['an unknown field', { ...frame(), extra: 1 }],
    ['a null id', { ...frame(), id: null }],
  ])('refuses %s as malformed', (_name, value) => {
    expect(() => parseFrame(value)).toThrow(MalformedFrame)
  })

  it('refuses an undefined body on encode rather than dropping the key on the wire', () => {
    expect(() => encodeFrame({ ...frame(), body: undefined })).toThrow(MalformedFrame)
  })

  it('refuses another version with a typed error that carries what it could read', () => {
    let error: unknown
    try {
      parseFrame({ ...frame(), v: 2 })
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeInstanceOf(UnsupportedVersion)
    expect((error as UnsupportedVersion).version).toBe(2)
    expect((error as UnsupportedVersion).id).toBe('r1')
    expect((error as UnsupportedVersion).service).toBe('example.ping')
    expect(() => parseFrame({ ...frame(), v: '1' })).toThrow(UnsupportedVersion)
    expect(() => parseFrame({ ...frame(), v: undefined })).toThrow(UnsupportedVersion)
  })

  it('serviceError builds the err body shape', () => {
    expect(serviceError('x', 'why')).toEqual({ code: 'x', retryable: false, message: 'why' })
    expect(serviceError('x', 'why', true).retryable).toBe(true)
  })
})

/* -------------------------------------------------------------- router */

describe('the router', () => {
  it('answers a request through the service that owns the name', async () => {
    const h = harness([ping])
    h.send(frame())
    await settle()
    expect(h.sent).toEqual([frame({ kind: 'res' })])
    expect(h.connection.inFlight).toBe(0)
    expect(h.timers.pending()).toBe(0)
  })

  it('refuses an unknown service, without any handler running', async () => {
    const handler = vi.fn(async () => 'never')
    const h = harness([{ ...ping, handler }])
    h.send(frame({ service: 'ghost.op' }))
    await settle()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.kind).toBe('err')
    expect(h.sent[0]?.id).toBe('r1')
    expect(errBody(h.sent[0]).code).toBe(ENVELOPE_ERRORS.unknownService)
    expect(handler).not.toHaveBeenCalled()
  })

  it('refuses a duplicate in-flight id, and leaves the first request alone', async () => {
    let release!: (value: unknown) => void
    const h = harness([{ ...ping, handler: () => new Promise((resolve) => (release = resolve)) }])
    h.send(frame())
    h.send(frame({ body: 'second' }))
    await settle()
    expect(h.sent).toHaveLength(1)
    expect(errBody(h.sent[0]).code).toBe(ENVELOPE_ERRORS.duplicateId)
    expect(h.connection.inFlight).toBe(1)
    release('first answer')
    await settle()
    expect(h.sent[1]).toEqual(frame({ kind: 'res', body: 'first answer' }))
    // Once answered, the id is free again: the same id is accepted, not refused.
    h.send(frame({ body: 'again' }))
    await settle()
    expect(h.sent).toHaveLength(2)
    expect(h.connection.inFlight).toBe(1)
    release('again')
  })

  it('checks the grant BEFORE dispatch: a peer without it gets forbidden and the handler is never called', async () => {
    const handler = vi.fn(async () => 'never')
    const hasGrant = vi.fn((peer: string, grant: string) => peer === 'peer-a' && grant === 'example:other')
    const h = harness([{ ...ping, handler }], hasGrant)
    h.send(frame())
    await settle()
    expect(hasGrant).toHaveBeenCalledWith('peer-a', 'example:ping')
    expect(handler).not.toHaveBeenCalled()
    expect(h.sent).toHaveLength(1)
    expect(errBody(h.sent[0]).code).toBe(ENVELOPE_ERRORS.forbidden)
    expect(h.connection.inFlight).toBe(0)
  })

  it('refuses a frame from another version as unsupported, echoing the id it could read', async () => {
    const h = harness([ping])
    const bytes = encodeFrame(frame())
    // Rewrite the payload's version by hand: the codec will not encode one.
    const text = new TextDecoder().decode(bytes.subarray(HEADER_BYTES)).replace('"v":1', '"v":2')
    const payload = new TextEncoder().encode(text)
    const forged = new Uint8Array(HEADER_BYTES + payload.byteLength)
    new DataView(forged.buffer).setUint32(0, payload.byteLength, false)
    forged.set(payload, HEADER_BYTES)
    h.connection.receive(forged)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.kind).toBe('err')
    expect(h.sent[0]?.id).toBe('r1')
    expect(h.sent[0]?.service).toBe('example.ping')
    expect(errBody(h.sent[0]).code).toBe(ENVELOPE_ERRORS.unsupported)
  })

  it('refuses malformed bytes as malformed, under the envelope\'s own name, and never throws', () => {
    const h = harness([ping])
    expect(() => h.connection.receive(new Uint8Array([1, 2]))).not.toThrow()
    expect(h.sent[0]?.kind).toBe('err')
    expect(h.sent[0]?.service).toBe(ENVELOPE_SERVICE)
    expect(h.sent[0]?.id).toBe(UNKNOWN_ID)
    expect(errBody(h.sent[0]).code).toBe(ENVELOPE_ERRORS.malformed)
  })

  it('cancel aborts the handler\'s signal, and a late cancel is nothing', async () => {
    let signal!: AbortSignal
    let release!: () => void
    const h = harness([
      {
        ...ping,
        handler: (_req, ctx) =>
          new Promise((resolve) => {
            signal = ctx.signal
            release = () => resolve('late')
          }),
      },
    ])
    h.send(frame())
    await settle()
    expect(signal.aborted).toBe(false)
    h.send(frame({ kind: 'cancel', body: null }))
    expect(signal.aborted).toBe(true)
    expect((signal.reason as ServiceError).code).toBe(ENVELOPE_ERRORS.cancelled)
    expect(h.connection.inFlight).toBe(0)
    // The handler resolving afterwards writes nothing: the peer has moved on.
    release()
    await settle()
    expect(h.sent).toEqual([])
    // A second cancel, for nothing in flight, is silently nothing.
    h.send(frame({ kind: 'cancel', body: null }))
    expect(h.sent).toEqual([])
    expect(h.timers.pending()).toBe(0)
  })

  it('times out a request on the injected clock: err timeout, signal aborted, late answer dropped', async () => {
    let signal!: AbortSignal
    let release!: () => void
    const h = harness(
      [{ ...ping, handler: (_req, ctx) => new Promise((resolve) => ((signal = ctx.signal), (release = () => resolve('late')))) }],
      () => true,
      1_000,
    )
    h.send(frame())
    await settle()
    h.timers.advance(999)
    expect(h.sent).toEqual([])
    h.timers.advance(1)
    expect(h.sent).toHaveLength(1)
    expect(errBody(h.sent[0]).code).toBe(ENVELOPE_ERRORS.timeout)
    expect(errBody(h.sent[0]).retryable).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(h.connection.inFlight).toBe(0)
    release()
    await settle()
    expect(h.sent).toHaveLength(1)
  })

  it('defaults the timeout to 30 s', async () => {
    const h = harness([{ ...ping, handler: () => new Promise(() => {}) }])
    h.send(frame())
    await settle()
    h.timers.advance(DEFAULT_TIMEOUT_MS - 1)
    expect(h.sent).toEqual([])
    h.timers.advance(1)
    expect(errBody(h.sent[0]).code).toBe(ENVELOPE_ERRORS.timeout)
  })

  it('an answered request stops its clock: nothing fires later', async () => {
    const h = harness([ping], () => true, 1_000)
    h.send(frame())
    await settle()
    expect(h.timers.pending()).toBe(0)
    h.timers.advance(10_000)
    expect(h.sent).toHaveLength(1)
  })

  it('streams an AsyncIterable answer as stream frames then end', async () => {
    const h = harness([
      {
        ...ping,
        handler: async function* () {
          yield 1
          yield 2
        },
      },
    ])
    h.send(frame())
    await settle()
    expect(h.sent.map((f) => [f.kind, f.body])).toEqual([
      ['stream', 1],
      ['stream', 2],
      ['end', null],
    ])
    expect(h.connection.inFlight).toBe(0)
  })

  it('hands the peer\'s stream frames to the handler as ctx.input, closed by end', async () => {
    const seen: unknown[] = []
    const h = harness([
      {
        ...ping,
        handler: async (_req, ctx) => {
          for await (const item of ctx.input) seen.push(item)
          return seen.length
        },
      },
    ])
    h.send(frame())
    h.send(frame({ kind: 'stream', body: 'a' }))
    h.send(frame({ kind: 'stream', body: 'b' }))
    await settle()
    h.send(frame({ kind: 'end', body: null }))
    await settle()
    expect(seen).toEqual(['a', 'b'])
    expect(h.sent).toEqual([frame({ kind: 'res', body: 2 })])
  })

  it('refuses a stream after end, and a stream or end for nothing in flight, as protocol errors', async () => {
    const h = harness([{ ...ping, handler: () => new Promise(() => {}) }])
    h.send(frame())
    h.send(frame({ kind: 'end', body: null }))
    h.send(frame({ kind: 'stream', body: 'too late' }))
    expect(h.sent).toHaveLength(1)
    expect(errBody(h.sent[0]).code).toBe(ENVELOPE_ERRORS.protocol)
    expect(errBody(h.sent[0]).message).toMatch(/stream after end/)
    h.send(frame({ kind: 'end', body: null }))
    expect(errBody(h.sent[1]).message).toMatch(/end after end/)
    h.send(frame({ id: 'nobody', kind: 'stream', body: 1 }))
    expect(errBody(h.sent[2]).code).toBe(ENVELOPE_ERRORS.protocol)
    h.send(frame({ id: 'nobody', kind: 'end', body: null }))
    expect(errBody(h.sent[3]).code).toBe(ENVELOPE_ERRORS.protocol)
    // The request itself is still in flight — the protocol error is about the frame, not the request.
    expect(h.connection.inFlight).toBe(1)
  })

  it('refuses res and err frames: answers travel the other way', () => {
    const h = harness([ping])
    h.send(frame({ kind: 'res' }))
    h.send(frame({ kind: 'err', body: serviceError('x', 'y') }))
    expect(h.sent.map((f) => errBody(f).code)).toEqual([ENVELOPE_ERRORS.protocol, ENVELOPE_ERRORS.protocol])
  })

  it('disconnect aborts every in-flight handler and writes nothing more', async () => {
    const signals: AbortSignal[] = []
    const releases: (() => void)[] = []
    const h = harness([
      {
        ...ping,
        handler: (_req, ctx) =>
          new Promise((resolve) => {
            signals.push(ctx.signal)
            releases.push(() => resolve('late'))
          }),
      },
    ])
    h.send(frame({ id: 'r1' }))
    h.send(frame({ id: 'r2' }))
    await settle()
    expect(h.connection.inFlight).toBe(2)
    h.connection.disconnect()
    expect(signals.map((s) => s.aborted)).toEqual([true, true])
    expect((signals[0]?.reason as ServiceError).code).toBe(ENVELOPE_ERRORS.disconnected)
    expect(h.connection.inFlight).toBe(0)
    expect(h.timers.pending()).toBe(0)
    for (const release of releases) release()
    await settle()
    // Nothing after the disconnect: not the late answers, not a refusal of a new request.
    h.send(frame({ id: 'r3' }))
    expect(h.sent).toEqual([])
    // Idempotent.
    h.connection.disconnect()
  })

  it('a ServiceError thrown by a handler crosses as is; anything else crosses as internal with no detail', async () => {
    const h = harness([
      { name: 'example.polite', grant: 'example:ping', handler: async () => Promise.reject(serviceError('busy', 'try later', true)) },
      { name: 'example.rude', grant: 'example:ping', handler: async () => Promise.reject(new Error('/Users/someone/books/secret.epub')) },
    ])
    h.send(frame({ service: 'example.polite', id: 'p' }))
    h.send(frame({ service: 'example.rude', id: 'q' }))
    await settle()
    const polite = h.sent.find((f) => f.id === 'p')
    const rude = h.sent.find((f) => f.id === 'q')
    expect(errBody(polite)).toEqual({ code: 'busy', retryable: true, message: 'try later' })
    expect(errBody(rude).code).toBe(ENVELOPE_ERRORS.internal)
    expect(JSON.stringify(rude)).not.toContain('secret')
  })

  it('an answer over the cap is refused as frame-too-large, and the request is settled', async () => {
    const h = harness([{ ...ping, handler: async () => 'x'.repeat(MAX_FRAME_BYTES) }])
    h.send(frame())
    await settle()
    expect(h.sent).toHaveLength(1)
    expect(errBody(h.sent[0]).code).toBe(ENVELOPE_ERRORS.frameTooLarge)
    expect(h.connection.inFlight).toBe(0)
  })

  it('tracks ids per connection: two peers may reuse one', async () => {
    const timers = fakeTimers()
    const router = createRouter({ services: [ping], hasGrant: () => true, timers })
    const a: Frame[] = []
    const b: Frame[] = []
    const ca = router.connect('a', (bytes) => a.push(decodeFrame(bytes)))
    const cb = router.connect('b', (bytes) => b.push(decodeFrame(bytes)))
    ca.receive(encodeFrame(frame({ body: 'from a' })))
    cb.receive(encodeFrame(frame({ body: 'from b' })))
    await settle()
    expect(a).toEqual([frame({ kind: 'res', body: 'from a' })])
    expect(b).toEqual([frame({ kind: 'res', body: 'from b' })])
  })

  it('refuses two services under one name at construction', () => {
    expect(() => createRouter({ services: [ping, ping], hasGrant: () => true })).toThrow(/registered twice/)
  })
})

/* -------------------------------------------------------------- client */

describe('the client', () => {
  /** A client wired straight into a router: bytes cross both ways synchronously. */
  function loopback(services: ServiceContribution[], hasGrant: (peer: string, grant: string) => boolean = () => true) {
    const timers = fakeTimers()
    const router = createRouter({ services, hasGrant, timers, timeoutMs: 5_000 })
    const toClient: Uint8Array[] = []
    let client!: ReturnType<typeof createClient>
    const connection = router.connect('peer', (bytes) => {
      toClient.push(bytes)
      client.receive(bytes)
    })
    const toRouter: Frame[] = []
    client = createClient({
      send: (bytes) => {
        toRouter.push(decodeFrame(bytes))
        connection.receive(bytes)
      },
      timers,
      timeoutMs: 2_000,
    })
    return { client, connection, timers, toRouter, toClient }
  }

  it('correlates ids: two calls in flight each get their own answer', async () => {
    let releases: ((v: unknown) => void)[] = []
    const { client, toRouter } = loopback([{ ...ping, handler: (req) => new Promise((resolve) => releases.push((v) => resolve(`${String(req)}:${String(v)}`))) }])
    const first = client.call('example.ping', 'one')
    const second = client.call('example.ping', 'two')
    await settle()
    expect(toRouter.map((f) => f.id)).toEqual(['c1', 'c2'])
    expect(client.inFlight).toBe(2)
    // Answer the SECOND first: correlation, not order, decides.
    releases[1]?.('B')
    releases[0]?.('A')
    await expect(second).resolves.toBe('two:B')
    await expect(first).resolves.toBe('one:A')
    expect(client.inFlight).toBe(0)
    releases = []
  })

  it('rejects with the err body the router sent', async () => {
    const { client } = loopback([ping], () => false)
    const failure = await client.call('example.ping', 1).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(ServiceCallError)
    expect((failure as ServiceCallError).error.code).toBe(ENVELOPE_ERRORS.forbidden)
    expect((failure as ServiceCallError).service).toBe('example.ping')
  })

  it('iterates a stream to its end', async () => {
    const { client } = loopback([
      {
        ...ping,
        handler: async function* () {
          yield 'a'
          yield 'b'
        },
      },
    ])
    const seen: unknown[] = []
    for await (const item of client.stream('example.ping', null)) seen.push(item)
    expect(seen).toEqual(['a', 'b'])
    expect(client.inFlight).toBe(0)
  })

  it('a stream that ends in err rejects the iteration after the items it got', async () => {
    const { client } = loopback([
      {
        ...ping,
        handler: async function* () {
          yield 'a'
          throw serviceError('broke', 'mid-stream')
        },
      },
    ])
    const seen: unknown[] = []
    let failure: unknown
    try {
      for await (const item of client.stream('example.ping', null)) seen.push(item)
    } catch (e) {
      failure = e
    }
    expect(seen).toEqual(['a'])
    expect((failure as ServiceCallError).error.code).toBe('broke')
  })

  it('an aborted call sends cancel and rejects as cancelled; the router aborts its handler', async () => {
    let signal!: AbortSignal
    const { client, toRouter, connection } = loopback([{ ...ping, handler: (_req, ctx) => new Promise(() => void (signal = ctx.signal)) }])
    const controller = new AbortController()
    const call = client.call('example.ping', 1, { signal: controller.signal })
    await settle()
    controller.abort()
    const failure = await call.catch((e: unknown) => e)
    expect((failure as ServiceCallError).error.code).toBe(ENVELOPE_ERRORS.cancelled)
    expect(toRouter.map((f) => f.kind)).toEqual(['req', 'cancel'])
    expect(signal.aborted).toBe(true)
    expect(connection.inFlight).toBe(0)
    expect(client.inFlight).toBe(0)
  })

  it('a call whose signal is already aborted is never sent', async () => {
    const { client, toRouter } = loopback([ping])
    const controller = new AbortController()
    controller.abort()
    await expect(client.call('example.ping', 1, { signal: controller.signal })).rejects.toBeInstanceOf(ServiceCallError)
    expect(toRouter).toEqual([])
  })

  it('times out on its own clock, sending cancel', async () => {
    const { client, timers, toRouter } = loopback([{ ...ping, handler: () => new Promise(() => {}) }])
    const call = client.call('example.ping', 1)
    await settle()
    timers.advance(2_000)
    const failure = await call.catch((e: unknown) => e)
    expect((failure as ServiceCallError).error.code).toBe(ENVELOPE_ERRORS.timeout)
    expect(toRouter.map((f) => f.kind)).toEqual(['req', 'cancel'])
    // A per-call timeout overrides the client's.
    const quick = client.call('example.ping', 2, { timeoutMs: 10 })
    await settle()
    timers.advance(10)
    expect(((await quick.catch((e: unknown) => e)) as ServiceCallError).error.code).toBe(ENVELOPE_ERRORS.timeout)
  })

  it('a res arriving after the id was dropped is ignored — the cancel/res race the protocol allows', async () => {
    const timers = fakeTimers()
    const sent: Frame[] = []
    const client = createClient({ send: (bytes) => sent.push(decodeFrame(bytes)), timers })
    const controller = new AbortController()
    const call = client.call('example.ping', 1, { signal: controller.signal })
    controller.abort()
    await call.catch(() => {})
    expect(() => client.receive(encodeFrame(frame({ id: 'c1', kind: 'res', body: 'late' })))).not.toThrow()
    expect(client.inFlight).toBe(0)
  })

  it('a stream frame for a plain call is a protocol error', async () => {
    const timers = fakeTimers()
    const client = createClient({ send: () => {}, timers })
    const call = client.call('example.ping', 1)
    client.receive(encodeFrame(frame({ id: 'c1', kind: 'stream', body: 'x' })))
    const failure = await call.catch((e: unknown) => e)
    expect((failure as ServiceCallError).error.code).toBe(ENVELOPE_ERRORS.protocol)
  })

  it('disconnect rejects every pending call and sends nothing more', async () => {
    const timers = fakeTimers()
    const sent: Frame[] = []
    const client = createClient({ send: (bytes) => sent.push(decodeFrame(bytes)), timers })
    const a = client.call('example.ping', 1)
    const b = client.call('example.ping', 2)
    client.disconnect()
    for (const p of [a, b]) {
      expect(((await p.catch((e: unknown) => e)) as ServiceCallError).error.code).toBe(ENVELOPE_ERRORS.disconnected)
    }
    expect(sent.map((f) => f.kind)).toEqual(['req', 'req'])
    await expect(client.call('example.ping', 3)).rejects.toBeInstanceOf(ServiceCallError)
    expect(sent).toHaveLength(2)
    expect(timers.pending()).toBe(0)
  })
})

/* ------------------------------------------------ hardening (adversarial) */

/**
 * The findings a branch audit raised against a hostile peer: live grant
 * revocation on an open session, bounded concurrency and queues, serialised
 * awaited sends, reflected diagnostic text, cancellable/bounded client
 * streams, restricted JSON, encode-failure hygiene, error-field leakage,
 * service correlation, and the wire-size boundary. Each case fails against the
 * pre-audit code and passes against the hardened code.
 */
describe('hardening against a hostile peer', () => {
  const ingest = (seen: unknown[]): ServiceContribution => ({
    name: 'example.ingest',
    grant: 'example:ingest',
    handler: async (_req, ctx) => {
      for await (const item of ctx.input) seen.push(item)
      return seen.length
    },
  })

  it('re-checks live grants on an open session: revocation aborts in-flight and refuses new work (H1)', async () => {
    let granted = true
    const timers = fakeTimers()
    const seen: unknown[] = []
    const router = createRouter({ services: [ingest(seen)], hasGrant: (_p, g) => granted && g === 'example:ingest', timers })
    const sent: Frame[] = []
    const conn = router.connect('peer-a', (bytes) => sent.push(decodeFrame(bytes)))
    conn.receive(encodeFrame(frame({ service: 'example.ingest', id: 'x', kind: 'req', body: null })))
    conn.receive(encodeFrame(frame({ service: 'example.ingest', id: 'x', kind: 'stream', body: 'one' })))
    await settle()
    expect(conn.inFlight).toBe(1)
    granted = false
    conn.recheckGrants()
    expect(conn.inFlight).toBe(0)
    expect(errBody(sent.find((f) => f.id === 'x' && f.kind === 'err')).code).toBe(ENVELOPE_ERRORS.forbidden)
    // A fresh request is now refused forbidden at dispatch — the check is live.
    conn.receive(encodeFrame(frame({ service: 'example.ingest', id: 'y', kind: 'req', body: null })))
    expect(errBody(sent.find((f) => f.id === 'y')).code).toBe(ENVELOPE_ERRORS.forbidden)
  })

  it('refuses a continuation frame whose grant was revoked, aborting the request (H1 per-frame)', async () => {
    let granted = true
    const timers = fakeTimers()
    const router = createRouter({
      services: [{ name: 'example.ingest', grant: 'example:ingest', handler: (_r, ctx) => new Promise(() => void ctx.input) }],
      hasGrant: (_p, g) => granted && g === 'example:ingest',
      timers,
    })
    const sent: Frame[] = []
    const conn = router.connect('peer-a', (bytes) => sent.push(decodeFrame(bytes)))
    conn.receive(encodeFrame(frame({ service: 'example.ingest', id: 'z', kind: 'req', body: null })))
    conn.receive(encodeFrame(frame({ service: 'example.ingest', id: 'z', kind: 'stream', body: 'a' })))
    await settle()
    expect(conn.inFlight).toBe(1)
    granted = false
    conn.receive(encodeFrame(frame({ service: 'example.ingest', id: 'z', kind: 'stream', body: 'b' })))
    expect(errBody(sent.find((f) => f.id === 'z' && f.kind === 'err')).code).toBe(ENVELOPE_ERRORS.forbidden)
    expect(conn.inFlight).toBe(0)
  })

  it('refuses work past the in-flight cap with a typed overloaded err, building no handler (H2)', async () => {
    const built: string[] = []
    const timers = fakeTimers()
    const slow: ServiceContribution = { name: 'example.slow', grant: 'example:ping', handler: (req) => new Promise(() => built.push(String(req))) }
    const router = createRouter({ services: [slow], hasGrant: () => true, timers, maxInFlight: 2 })
    const sent: Frame[] = []
    const conn = router.connect('peer-a', (bytes) => sent.push(decodeFrame(bytes)))
    for (const id of ['a', 'b', 'c']) conn.receive(encodeFrame(frame({ service: 'example.slow', id, body: id })))
    await settle()
    expect(conn.inFlight).toBe(2)
    expect(errBody(sent.find((f) => f.id === 'c')).code).toBe(ENVELOPE_ERRORS.overloaded)
    expect(built).toEqual(['a', 'b'])
  })

  it('bounds queued input by bytes, refusing the overflow and aborting the flooder (H3)', async () => {
    const timers = fakeTimers()
    const sink: ServiceContribution = { name: 'example.sink', grant: 'example:ping', handler: () => new Promise(() => {}) }
    const router = createRouter({ services: [sink], hasGrant: () => true, timers, maxQueuedBytes: 200 })
    const sent: Frame[] = []
    const conn = router.connect('peer-a', (bytes) => sent.push(decodeFrame(bytes)))
    conn.receive(encodeFrame(frame({ service: 'example.sink', id: 'q', body: null })))
    await settle()
    const body = 'x'.repeat(40)
    for (let i = 0; i < 4; i++) conn.receive(encodeFrame(frame({ service: 'example.sink', id: 'q', kind: 'stream', body })))
    expect(errBody(sent.find((f) => f.id === 'q' && f.kind === 'err')).code).toBe(ENVELOPE_ERRORS.overloaded)
    expect(conn.inFlight).toBe(0)
  })

  it('serialises awaited sends so stream order survives a slow transport (H4)', async () => {
    const timers = fakeTimers()
    const gen: ServiceContribution = {
      name: 'example.gen',
      grant: 'example:ping',
      handler: async function* () {
        yield 1
        yield 2
        yield 3
      },
    }
    const router = createRouter({ services: [gen], hasGrant: () => true, timers })
    const order: Frame[] = []
    const conn = router.connect(
      'peer-a',
      (bytes) =>
        new Promise<void>((resolve) => {
          const f = decodeFrame(bytes)
          setTimeout(() => {
            order.push(f)
            resolve()
          }, 2)
        }),
    )
    conn.receive(encodeFrame(frame({ service: 'example.gen', id: 'g', body: null })))
    /* Wait for ARRIVAL, then assert ORDER. A fixed sleep here raced the
     * event loop under full-suite load — 40ms was not always enough for four
     * 2ms-delayed sends — and a wait that names its condition cannot. */
    await vi.waitFor(() => expect(order.length).toBe(4))
    expect(order.map((f) => [f.kind, f.body])).toEqual([
      ['stream', 1],
      ['stream', 2],
      ['stream', 3],
      ['end', null],
    ])
  })

  it('disconnects when a send fails instead of swallowing it, aborting other work (H4)', async () => {
    const timers = fakeTimers()
    let otherSignal: AbortSignal | undefined
    const quick: ServiceContribution = { name: 'example.quick', grant: 'example:ping', handler: async () => 'done' }
    const slow: ServiceContribution = { name: 'example.slow', grant: 'example:ping', handler: (_r, ctx) => new Promise(() => (otherSignal = ctx.signal)) }
    const router = createRouter({ services: [quick, slow], hasGrant: () => true, timers })
    let fail = false
    const conn = router.connect('peer-a', (bytes) => {
      decodeFrame(bytes)
      return fail ? Promise.reject(new Error('link down')) : Promise.resolve()
    })
    conn.receive(encodeFrame(frame({ service: 'example.slow', id: 's', body: null })))
    await settle()
    expect(conn.inFlight).toBe(1)
    fail = true
    conn.receive(encodeFrame(frame({ service: 'example.quick', id: 'q', body: null })))
    await settle()
    expect(otherSignal?.aborted).toBe(true)
    expect(conn.inFlight).toBe(0)
  })

  const rawFrame = (value: Record<string, unknown>): Uint8Array => {
    const payload = new TextEncoder().encode(JSON.stringify(value))
    const bytes = new Uint8Array(HEADER_BYTES + payload.byteLength)
    new DataView(bytes.buffer).setUint32(0, payload.byteLength, false)
    bytes.set(payload, HEADER_BYTES)
    return bytes
  }
  const rawBody = (bodyLiteral: string): Uint8Array => {
    const payload = new TextEncoder().encode(`{"v":1,"service":"a.b","id":"r1","kind":"req","body":${bodyLiteral}}`)
    const bytes = new Uint8Array(HEADER_BYTES + payload.byteLength)
    new DataView(bytes.buffer).setUint32(0, payload.byteLength, false)
    bytes.set(payload, HEADER_BYTES)
    return bytes
  }

  it('refuses a near-cap unknown field without reflecting it, and never throws (M5)', () => {
    const h = harness([ping])
    const bigKey = 'z'.repeat(MAX_PAYLOAD_BYTES - 200)
    const bytes = rawFrame({ v: 1, service: 'example.ping', id: 'r1', kind: 'req', body: null, [bigKey]: 1 })
    expect(() => h.connection.receive(bytes)).not.toThrow()
    expect(h.sent).toHaveLength(1)
    expect(errBody(h.sent[0]).code).toBe(ENVELOPE_ERRORS.malformed)
    expect(encodeFrame(h.sent[0] as Frame).byteLength).toBeLessThan(1000)
    expect(JSON.stringify(h.sent[0])).not.toContain(bigKey)
  })

  it('refuses a near-cap unknown version without reflecting it, and never throws (M5)', () => {
    const h = harness([ping])
    const bigVersion = 'v'.repeat(MAX_PAYLOAD_BYTES - 200)
    const bytes = rawFrame({ v: bigVersion, service: 'example.ping', id: 'r1', kind: 'req', body: null })
    expect(() => h.connection.receive(bytes)).not.toThrow()
    expect(h.sent).toHaveLength(1)
    expect(errBody(h.sent[0]).code).toBe(ENVELOPE_ERRORS.unsupported)
    expect(encodeFrame(h.sent[0] as Frame).byteLength).toBeLessThan(1000)
    expect(JSON.stringify(h.sent[0])).not.toContain('vvvv')
  })

  it('a client stream broken out of sends cancel and tears down (M6)', async () => {
    const timers = fakeTimers()
    const sent: Frame[] = []
    const client = createClient({ send: (bytes) => void sent.push(decodeFrame(bytes)), timers })
    const iterator = client.stream('example.ping', null)[Symbol.asyncIterator]()
    client.receive(encodeFrame(frame({ id: 'c1', service: 'example.ping', kind: 'stream', body: 'a' })))
    const first = await iterator.next()
    expect(first.value).toBe('a')
    await iterator.return?.()
    expect(sent.map((f) => f.kind)).toEqual(['req', 'cancel'])
    expect(client.inFlight).toBe(0)
  })

  it('bounds a client stream buffer and cancels on overflow (M6)', async () => {
    const timers = fakeTimers()
    const sent: Frame[] = []
    const client = createClient({ send: (bytes) => void sent.push(decodeFrame(bytes)), timers, maxStreamBytes: 200 })
    const iterator = client.stream('example.ping', null)[Symbol.asyncIterator]()
    client.receive(encodeFrame(frame({ id: 'c1', service: 'example.ping', kind: 'stream', body: 'x'.repeat(300) })))
    const failure = await iterator.next().catch((e: unknown) => e)
    expect((failure as ServiceCallError).error.code).toBe(ENVELOPE_ERRORS.overloaded)
    expect(sent.some((f) => f.kind === 'cancel')).toBe(true)
  })

  it('refuses deeply nested and non-finite JSON bodies (M8)', () => {
    const deep = '['.repeat(MAX_JSON_DEPTH + 5) + ']'.repeat(MAX_JSON_DEPTH + 5)
    expect(() => decodeFrame(rawBody(deep))).toThrow(/nests too deeply/)
    expect(() => decodeFrame(rawBody('1e400'))).toThrow(/non-finite/)
    // A shallow, finite body still round-trips.
    expect(decodeFrame(rawBody('[1,2,3]')).body).toEqual([1, 2, 3])
  })

  it('rejects unencodable and oversized requests typed, leaking no pending state (M9)', async () => {
    const timers = fakeTimers()
    const sent: Frame[] = []
    const client = createClient({ send: (bytes) => void sent.push(decodeFrame(bytes)), timers })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(((await client.call('example.ping', cyclic).catch((e: unknown) => e)) as ServiceCallError).error.code).toBe(ENVELOPE_ERRORS.malformed)
    expect(((await client.call('example.ping', 10n).catch((e: unknown) => e)) as ServiceCallError).error.code).toBe(ENVELOPE_ERRORS.malformed)
    expect(((await client.call('example.ping', 'x'.repeat(MAX_FRAME_BYTES)).catch((e: unknown) => e)) as ServiceCallError).error.code).toBe(ENVELOPE_ERRORS.frameTooLarge)
    expect(sent).toEqual([])
    expect(client.inFlight).toBe(0)
    expect(timers.pending()).toBe(0)
  })

  it('strips extra fields from a handler-thrown ServiceError before it crosses (M10)', async () => {
    const leaky: ServiceContribution = {
      name: 'example.leaky',
      grant: 'example:ping',
      handler: async () => Promise.reject({ code: 'busy', retryable: true, message: 'later', stack: 'secret-stack', bookText: 'the-secret-book' }),
    }
    const h = harness([leaky])
    h.send(frame({ service: 'example.leaky', id: 'k', body: null }))
    await settle()
    const err = h.sent.find((f) => f.id === 'k')
    expect(errBody(err)).toEqual({ code: 'busy', retryable: true, message: 'later' })
    expect(Object.keys(errBody(err) as object).sort()).toEqual(['code', 'message', 'retryable'])
    expect(JSON.stringify(err)).not.toContain('secret')
  })

  it('refuses a continuation frame whose service does not match the request (L11)', async () => {
    const seen: unknown[] = []
    const h = harness([ingest(seen), { name: 'example.other', grant: 'example:ingest', handler: async () => 'other' }])
    h.send(frame({ service: 'example.ingest', id: 'm', kind: 'req', body: null }))
    await settle()
    h.send(frame({ service: 'example.other', id: 'm', kind: 'stream', body: 'wrong' }))
    expect(errBody(h.sent.find((f) => f.id === 'm' && f.kind === 'err')).code).toBe(ENVELOPE_ERRORS.protocol)
    h.send(frame({ service: 'example.ingest', id: 'm', kind: 'end', body: null }))
    await settle()
    expect(seen).toEqual([])
  })

  it('refuses a non-null body on end or cancel as malformed (L12)', () => {
    expect(() => parseFrame({ v: 1, service: 'a.b', id: 'r1', kind: 'end', body: { fat: 1 } })).toThrow(MalformedFrame)
    expect(() => parseFrame({ v: 1, service: 'a.b', id: 'r1', kind: 'cancel', body: [1, 2] })).toThrow(MalformedFrame)
    expect(parseFrame({ v: 1, service: 'a.b', id: 'r1', kind: 'end', body: null }).kind).toBe('end')
  })

  it('caps the ENCODED frame including its header at the wire limit (L13)', () => {
    const okBytes = encodeFrame(frame({ body: 'x'.repeat(MAX_PAYLOAD_BYTES - 100) }))
    expect(okBytes.byteLength).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    // A declared length between MAX_PAYLOAD_BYTES and MAX_FRAME_BYTES — whose
    // encoded frame would overrun the outer transport — is now refused.
    const header = new Uint8Array(HEADER_BYTES + 4)
    new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES, false)
    expect(() => decodeFrame(header)).toThrow(FrameTooLarge)
  })
})
