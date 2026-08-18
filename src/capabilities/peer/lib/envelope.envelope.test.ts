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
