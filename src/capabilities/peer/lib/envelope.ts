import type { ServiceContext, ServiceContribution } from '../../../kernel'

/**
 * The service envelope on the peer channel — ONE protocol, versioned
 * (mobile-sync plan I.4). Every message is a frame:
 *
 *   { v: 1, service, id, kind: req | res | stream | end | err | cancel, body }
 *
 * length-prefixed JSON on the wire, capped at 4 MiB. Above the frame sit a
 * `Router` (the shelf side: `req` frames go to the service that owns the
 * name, gated by the peer's grants, with a timeout, `cancel` and disconnect)
 * and a `Client` (the satchel side: correlates ids, awaits `res`, iterates
 * `stream … end`). Both are POLICY-FREE: which peer holds which grant, what a
 * handler does, what the transport is — none of that is decided here. The
 * router asks `hasGrant`; the transport hands bytes in and takes bytes out.
 *
 * Every refusal is a typed `err` frame with a `ServiceError` body, sent
 * before any handler runs — unknown service, duplicate id, forbidden,
 * unsupported version, malformed, timeout, protocol — so a peer can tell
 * them apart, and nothing about the request is acted on first.
 */

/* ------------------------------------------------------------------ frames */

export const ENVELOPE_VERSION = 1 as const
export const FRAME_KINDS = ['req', 'res', 'stream', 'end', 'err', 'cancel'] as const
export type FrameKind = (typeof FRAME_KINDS)[number]

export interface Frame {
  readonly v: typeof ENVELOPE_VERSION
  readonly service: string
  readonly id: string
  readonly kind: FrameKind
  /** Any JSON value; `null` when a kind carries nothing (`end`, `cancel`). */
  readonly body: unknown
}

/** The 4 MiB cap on a frame's JSON payload, on both encode and decode. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024
/** A big-endian u32 length, then the payload. */
export const HEADER_BYTES = 4
/** Bounds on the two names, so a frame cannot carry a novel in its header. */
export const MAX_NAME_LENGTH = 128

/** What an `err` frame carries. */
export interface ServiceError {
  readonly code: string
  readonly retryable: boolean
  readonly message: string
}

export function serviceError(code: string, message: string, retryable = false): ServiceError {
  return { code, retryable, message }
}

/** The error codes the envelope itself emits, so a peer can match on them. */
export const ENVELOPE_ERRORS = {
  unknownService: 'unknown-service',
  duplicateId: 'duplicate-id',
  forbidden: 'forbidden',
  unsupported: 'unsupported',
  malformed: 'malformed',
  timeout: 'timeout',
  protocol: 'protocol',
  internal: 'internal',
  frameTooLarge: 'frame-too-large',
  cancelled: 'cancelled',
  disconnected: 'disconnected',
} as const

/**
 * The service and id an `err` frame carries when the offending frame had
 * none that could be read — a malformed frame, or one from another version
 * with no usable `id`. Both are valid names, so the refusal itself encodes.
 */
export const ENVELOPE_SERVICE = 'envelope'
export const UNKNOWN_ID = '?'

/* -------------------------------------------------------- typed failures */

/** Every failure the codec raises is one of these; `code` says which. */
export class EnvelopeError extends Error {
  readonly code: 'frame-too-large' | 'malformed-frame' | 'unsupported-version'
  constructor(code: EnvelopeError['code'], message: string) {
    super(message)
    this.name = 'EnvelopeError'
    this.code = code
  }
}

/** A payload over `MAX_FRAME_BYTES`, on encode or as declared by a header on decode. */
export class FrameTooLarge extends EnvelopeError {
  readonly bytes: number
  constructor(bytes: number) {
    super('frame-too-large', `frame of ${bytes} bytes exceeds the ${MAX_FRAME_BYTES}-byte cap`)
    this.name = 'FrameTooLarge'
    this.bytes = bytes
  }
}

/** Not a frame: a short header, a length that does not match, bad JSON, a wrong shape or field. */
export class MalformedFrame extends EnvelopeError {
  constructor(message: string) {
    super('malformed-frame', message)
    this.name = 'MalformedFrame'
  }
}

/**
 * A frame from another envelope version. Carries what could be read of the
 * frame's `id` and `service` — strings, if they were — so the router can
 * answer `err unsupported` to the right request.
 */
export class UnsupportedVersion extends EnvelopeError {
  readonly version: unknown
  readonly id: string | null
  readonly service: string | null
  constructor(version: unknown, id: string | null, service: string | null) {
    super('unsupported-version', `envelope version ${JSON.stringify(version)} is not ${ENVELOPE_VERSION}`)
    this.name = 'UnsupportedVersion'
    this.version = version
    this.id = id
    this.service = service
  }
}

/* ------------------------------------------------------------------ codec */

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const FRAME_KEYS = new Set<string>(['v', 'service', 'id', 'kind', 'body'])
const KIND_SET: ReadonlySet<string> = new Set(FRAME_KINDS)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readName(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new MalformedFrame(`frame.${field} must be a non-empty string`)
  if (value.length > MAX_NAME_LENGTH) throw new MalformedFrame(`frame.${field} exceeds ${MAX_NAME_LENGTH} characters`)
  return value
}

/**
 * A parsed JSON value as a `Frame`, every field checked: exactly the five
 * keys, `v` this version (else `UnsupportedVersion`), names bounded and
 * non-empty, `kind` from the closed set, `body` present (a JSON `null` is
 * present; an absent key is not — `undefined` does not survive JSON, so a
 * frame that would drop the key on the wire is refused before it does).
 */
export function parseFrame(value: unknown): Frame {
  if (!isPlainObject(value)) throw new MalformedFrame('frame must be a JSON object')
  for (const key of Object.keys(value)) {
    if (!FRAME_KEYS.has(key)) throw new MalformedFrame(`frame has an unknown field ${JSON.stringify(key)}`)
  }
  if (value.v !== ENVELOPE_VERSION) {
    const asName = (field: unknown) => (typeof field === 'string' && field.length > 0 && field.length <= MAX_NAME_LENGTH ? field : null)
    throw new UnsupportedVersion(value.v, asName(value.id), asName(value.service))
  }
  const service = readName(value.service, 'service')
  const id = readName(value.id, 'id')
  const kind = value.kind
  if (typeof kind !== 'string' || !KIND_SET.has(kind)) throw new MalformedFrame(`frame.kind must be one of ${FRAME_KINDS.join(', ')}`)
  if (!Object.hasOwn(value, 'body') || value.body === undefined) throw new MalformedFrame('frame.body must be present (null when empty)')
  return { v: ENVELOPE_VERSION, service, id, kind: kind as FrameKind, body: value.body }
}

/**
 * A frame as bytes: a 4-byte big-endian length, then the JSON payload.
 * Validates the frame first (a bad frame is refused here, not by the peer)
 * and refuses a payload over the cap.
 */
export function encodeFrame(frame: Frame): Uint8Array {
  const checked = parseFrame(frame)
  const payload = encoder.encode(JSON.stringify(checked))
  if (payload.byteLength > MAX_FRAME_BYTES) throw new FrameTooLarge(payload.byteLength)
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength)
  new DataView(out.buffer).setUint32(0, payload.byteLength, false)
  out.set(payload, HEADER_BYTES)
  return out
}

/**
 * Exactly one frame from bytes. The declared length is judged BEFORE anything
 * is decoded or allocated: over the cap is `FrameTooLarge`, disagreeing with
 * the bytes present is `MalformedFrame`. Then UTF-8 (fatal), JSON, and
 * `parseFrame`.
 */
export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.byteLength < HEADER_BYTES) throw new MalformedFrame(`frame header needs ${HEADER_BYTES} bytes, got ${bytes.byteLength}`)
  const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false)
  if (declared > MAX_FRAME_BYTES) throw new FrameTooLarge(declared)
  const present = bytes.byteLength - HEADER_BYTES
  if (declared !== present) throw new MalformedFrame(`frame declares ${declared} payload bytes but ${present} are present`)
  let text: string
  try {
    text = decoder.decode(bytes.subarray(HEADER_BYTES))
  } catch {
    throw new MalformedFrame('frame payload is not UTF-8')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new MalformedFrame('frame payload is not JSON')
  }
  return parseFrame(value)
}

/* ------------------------------------------------------------------ router */

/** The timers the router uses — injectable so a test can drive time. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const REAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export const DEFAULT_TIMEOUT_MS = 30_000

export interface RouterOptions {
  /** The services this side answers for — the composition's, usually. */
  readonly services: Iterable<ServiceContribution>
  /**
   * The peer's persisted grants, asked BEFORE dispatch. Policy lives with the
   * caller: the router only knows the answer for this peer and this grant.
   */
  readonly hasGrant: (peer: string, grant: string) => boolean
  /** Per-request; `err timeout` and the handler's signal aborted when it lapses. */
  readonly timeoutMs?: number
  readonly timers?: Timers
}

/** One peer's connection to the router: frames in, frames out, and a close. */
export interface RouterConnection {
  /** A frame from the peer, as bytes. Never throws: every fault is an `err` frame back. */
  receive(bytes: Uint8Array): void
  /** The peer is gone: every in-flight handler is aborted and nothing more is written. */
  disconnect(): void
  /** How many requests are in flight — for tests and diagnostics. */
  readonly inFlight: number
}

export interface Router {
  connect(peer: string, send: (bytes: Uint8Array) => void): RouterConnection
}

/**
 * The frames a peer streams in after a `req` (`stream` … `end`), as the
 * handler's `ctx.input`. Pull-based: frames queue until the handler asks.
 */
class InputQueue implements AsyncIterable<unknown> {
  private readonly items: unknown[] = []
  private waiting: ((result: IteratorResult<unknown>) => void) | null = null
  private closed = false

  push(item: unknown): void {
    if (this.closed) return
    if (this.waiting) {
      const wake = this.waiting
      this.waiting = null
      wake({ value: item, done: false })
    } else {
      this.items.push(item)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.waiting) {
      const wake = this.waiting
      this.waiting = null
      wake({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift(), done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

interface InFlight {
  readonly service: string
  readonly controller: AbortController
  readonly input: InputQueue
  /** True once the peer sent `end`: a `stream` after it is a protocol error. */
  ended: boolean
  timer: unknown
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

function isServiceError(value: unknown): value is ServiceError {
  return (
    isPlainObject(value) &&
    typeof value.code === 'string' &&
    typeof value.retryable === 'boolean' &&
    typeof value.message === 'string'
  )
}

/**
 * A router over a set of services. Each `connect` is one peer's connection;
 * requests are tracked per connection (ids are the peer's namespace, and
 * two peers may reuse one).
 */
export function createRouter(options: RouterOptions): Router {
  const services = new Map<string, ServiceContribution>()
  for (const service of options.services) {
    if (services.has(service.name)) throw new Error(`envelope router: service "${service.name}" registered twice`)
    services.set(service.name, service)
  }
  const timers = options.timers ?? REAL_TIMERS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const hasGrant = options.hasGrant

  return {
    connect(peer, send) {
      const inFlight = new Map<string, InFlight>()
      let open = true

      const write = (frame: Frame) => {
        if (!open) return
        send(encodeFrame(frame))
      }
      const refuse = (service: string, id: string, error: ServiceError) => {
        write({ v: ENVELOPE_VERSION, service, id, kind: 'err', body: error })
      }
      /** Take a request out of flight, stopping its clock. Idempotent. */
      const settle = (id: string): InFlight | undefined => {
        const entry = inFlight.get(id)
        if (!entry) return undefined
        inFlight.delete(id)
        timers.clearTimeout(entry.timer)
        entry.input.close()
        return entry
      }
      /**
       * The LAST frame of a request: encoded first (so a body over the cap
       * fails while the request is still ours to refuse), settled second (so
       * a peer that answers a `res` with a fresh `req` of the same id, on a
       * synchronous transport, does not meet its own request in flight), and
       * only then written.
       */
      const answer = (frame: Frame) => {
        const bytes = encodeFrame(frame)
        settle(frame.id)
        if (open) send(bytes)
      }

      const dispatch = (frame: Frame) => {
        const service = services.get(frame.service)
        if (!service) {
          refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.unknownService, `no service named ${JSON.stringify(frame.service)}`))
          return
        }
        if (inFlight.has(frame.id)) {
          refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.duplicateId, `request ${JSON.stringify(frame.id)} is already in flight`))
          return
        }
        if (!hasGrant(peer, service.grant)) {
          refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.forbidden, `peer lacks grant ${JSON.stringify(service.grant)}`))
          return
        }

        const controller = new AbortController()
        const entry: InFlight = { service: frame.service, controller, input: new InputQueue(), ended: false, timer: undefined }
        entry.timer = timers.setTimeout(() => {
          if (settle(frame.id) === undefined) return
          controller.abort(serviceError(ENVELOPE_ERRORS.timeout, `no answer within ${timeoutMs} ms`, true))
          refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.timeout, `no answer within ${timeoutMs} ms`, true))
        }, timeoutMs)
        inFlight.set(frame.id, entry)

        const ctx: ServiceContext = { peer, signal: controller.signal, input: entry.input }
        /* Still ours to answer? A request that timed out, was cancelled or
         * whose peer disconnected is out of flight, and its late answer is
         * dropped rather than written to a peer that has moved on. */
        const live = () => inFlight.get(frame.id) === entry

        void (async () => {
          try {
            const result = await service.handler(frame.body, ctx)
            if (isAsyncIterable(result)) {
              for await (const item of result) {
                if (!live()) return
                write({ v: ENVELOPE_VERSION, service: frame.service, id: frame.id, kind: 'stream', body: item })
              }
              if (!live()) return
              answer({ v: ENVELOPE_VERSION, service: frame.service, id: frame.id, kind: 'end', body: null })
            } else {
              if (!live()) return
              answer({ v: ENVELOPE_VERSION, service: frame.service, id: frame.id, kind: 'res', body: result })
            }
          } catch (thrown) {
            if (!live()) return
            settle(frame.id)
            /* A `ServiceError` is the handler speaking to the peer and goes as
             * is; an answer over the cap says so. Anything else is a defect and
             * crosses the wire as `internal` with no message: a stack, a path
             * or a book's text in an exception is not the peer's to read. */
            const error = isServiceError(thrown)
              ? thrown
              : thrown instanceof FrameTooLarge
                ? serviceError(ENVELOPE_ERRORS.frameTooLarge, thrown.message)
                : serviceError(ENVELOPE_ERRORS.internal, 'the service failed')
            refuse(frame.service, frame.id, error)
          }
        })()
      }

      return {
        get inFlight() {
          return inFlight.size
        },
        receive(bytes) {
          if (!open) return
          let frame: Frame
          try {
            frame = decodeFrame(bytes)
          } catch (thrown) {
            if (thrown instanceof UnsupportedVersion) {
              refuse(thrown.service ?? ENVELOPE_SERVICE, thrown.id ?? UNKNOWN_ID, serviceError(ENVELOPE_ERRORS.unsupported, thrown.message))
            } else {
              refuse(ENVELOPE_SERVICE, UNKNOWN_ID, serviceError(ENVELOPE_ERRORS.malformed, thrown instanceof Error ? thrown.message : 'malformed frame'))
            }
            return
          }
          switch (frame.kind) {
            case 'req':
              dispatch(frame)
              return
            case 'cancel': {
              /* Idempotent, and silent when late: a cancel that crosses the
               * answer on the wire has nothing left to abort. */
              const entry = settle(frame.id)
              entry?.controller.abort(serviceError(ENVELOPE_ERRORS.cancelled, 'cancelled by the peer'))
              return
            }
            case 'stream': {
              const entry = inFlight.get(frame.id)
              if (!entry) {
                refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.protocol, `stream for a request not in flight`))
                return
              }
              if (entry.ended) {
                refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.protocol, `stream after end`))
                return
              }
              entry.input.push(frame.body)
              return
            }
            case 'end': {
              const entry = inFlight.get(frame.id)
              if (!entry) {
                refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.protocol, `end for a request not in flight`))
                return
              }
              if (entry.ended) {
                refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.protocol, `end after end`))
                return
              }
              entry.ended = true
              entry.input.close()
              return
            }
            case 'res':
            case 'err':
              /* Answers travel the other way. One arriving here is a peer
               * confused about which side it is on. */
              refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.protocol, `${frame.kind} frames are not accepted by a router`))
              return
          }
        },
        disconnect() {
          if (!open) return
          open = false
          for (const id of [...inFlight.keys()]) {
            settle(id)?.controller.abort(serviceError(ENVELOPE_ERRORS.disconnected, 'peer disconnected'))
          }
        },
      }
    },
  }
}

/* ------------------------------------------------------------------ client */

/** Thrown by `Client.call` / `Client.stream` when the router answers `err`. */
export class ServiceCallError extends Error {
  readonly service: string
  readonly error: ServiceError
  constructor(service: string, error: ServiceError) {
    super(`${service}: ${error.code}: ${error.message}`)
    this.name = 'ServiceCallError'
    this.service = service
    this.error = error
  }
}

export interface CallOptions {
  readonly signal?: AbortSignal
  /** Overrides the client's default. */
  readonly timeoutMs?: number
}

export interface ClientOptions {
  readonly send: (bytes: Uint8Array) => void
  readonly timeoutMs?: number
  readonly timers?: Timers
  /** Request ids; the default counts. Injectable so a test can name them. */
  readonly nextId?: () => string
}

export interface Client {
  /** One answer. Rejects with `ServiceCallError` on `err`, `timeout` or an abort. */
  call(service: string, body: unknown, options?: CallOptions): Promise<unknown>
  /** Many answers, `stream` by `stream` until `end`. Same rejections. */
  stream(service: string, body: unknown, options?: CallOptions): AsyncIterable<unknown>
  /**
   * A frame from the router, as bytes. Frames for no request in flight are
   * dropped — see below. Throws `EnvelopeError` on bytes that are not a
   * frame: a router that sends garbage is the transport's problem to raise.
   */
  receive(bytes: Uint8Array): void
  /** The router is gone: every pending call rejects with `disconnected`. */
  disconnect(): void
  readonly inFlight: number
}

interface Pending {
  readonly service: string
  readonly resolve: (frame: Frame) => void
  readonly reject: (error: ServiceCallError) => void
  readonly onStream: ((body: unknown) => void) | null
  timer: unknown
  cleanup: () => void
}

/**
 * The satchel side, a stub until a consumer arrives: it correlates ids and
 * turns frames back into promises and async iterables. Frames for an id no
 * longer pending are DROPPED, and that is by design, not by neglect: a
 * `cancel` we sent and a `res` the router had already written cross on the
 * wire, and the late `res` is exactly this case. There is no protocol error
 * to raise about a race the protocol allows.
 */
export function createClient(options: ClientOptions): Client {
  const timers = options.timers ?? REAL_TIMERS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let counter = 0
  const nextId = options.nextId ?? (() => `c${++counter}`)
  const pending = new Map<string, Pending>()
  let open = true

  const write = (frame: Frame) => {
    if (!open) return
    options.send(encodeFrame(frame))
  }

  const finish = (id: string): Pending | undefined => {
    const entry = pending.get(id)
    if (!entry) return undefined
    pending.delete(id)
    timers.clearTimeout(entry.timer)
    entry.cleanup()
    return entry
  }

  /** Send a `req`, and wire the timeout and the caller's signal to it. */
  const begin = (service: string, body: unknown, call: CallOptions, onStream: Pending['onStream']): Promise<Frame> =>
    new Promise<Frame>((resolve, reject) => {
      if (!open) {
        reject(new ServiceCallError(service, serviceError(ENVELOPE_ERRORS.disconnected, 'client is disconnected')))
        return
      }
      const id = nextId()
      const fail = (error: ServiceError) => {
        if (finish(id) === undefined) return
        write({ v: ENVELOPE_VERSION, service, id, kind: 'cancel', body: null })
        reject(new ServiceCallError(service, error))
      }
      const onAbort = () => fail(serviceError(ENVELOPE_ERRORS.cancelled, 'cancelled by the caller'))
      const signal = call.signal
      if (signal?.aborted) {
        reject(new ServiceCallError(service, serviceError(ENVELOPE_ERRORS.cancelled, 'cancelled before it was sent')))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const ms = call.timeoutMs ?? timeoutMs
      const entry: Pending = {
        service,
        resolve,
        reject,
        onStream,
        timer: undefined,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      }
      entry.timer = timers.setTimeout(() => fail(serviceError(ENVELOPE_ERRORS.timeout, `no answer within ${ms} ms`, true)), ms)
      pending.set(id, entry)
      write({ v: ENVELOPE_VERSION, service, id, kind: 'req', body })
    })

  return {
    get inFlight() {
      return pending.size
    },
    async call(service, body, call = {}) {
      const frame = await begin(service, body, call, null)
      if (frame.kind !== 'res') {
        throw new ServiceCallError(service, serviceError(ENVELOPE_ERRORS.protocol, `expected res, got ${frame.kind}`))
      }
      return frame.body
    },
    stream(service, body, call = {}) {
      const items: unknown[] = []
      let waiting: (() => void) | null = null
      let done: { error?: ServiceCallError } | null = null
      const wake = () => {
        const w = waiting
        waiting = null
        w?.()
      }
      begin(service, body, call, (item) => {
        items.push(item)
        wake()
      }).then(
        (frame) => {
          done = frame.kind === 'end' ? {} : { error: new ServiceCallError(service, serviceError(ENVELOPE_ERRORS.protocol, `expected end, got ${frame.kind}`)) }
          wake()
        },
        (error: ServiceCallError) => {
          done = { error }
          wake()
        },
      )
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              for (;;) {
                if (items.length > 0) return { value: items.shift(), done: false }
                if (done) {
                  if (done.error) throw done.error
                  return { value: undefined, done: true }
                }
                await new Promise<void>((resolve) => {
                  waiting = resolve
                })
              }
            },
          }
        },
      }
    },
    receive(bytes) {
      if (!open) return
      const frame = decodeFrame(bytes)
      const entry = pending.get(frame.id)
      if (!entry) return
      switch (frame.kind) {
        case 'stream':
          if (entry.onStream) entry.onStream(frame.body)
          else {
            finish(frame.id)
            entry.reject(new ServiceCallError(entry.service, serviceError(ENVELOPE_ERRORS.protocol, 'stream frame for a plain call')))
          }
          return
        case 'res':
        case 'end':
          finish(frame.id)
          entry.resolve(frame)
          return
        case 'err':
          finish(frame.id)
          entry.reject(
            new ServiceCallError(
              entry.service,
              isServiceError(frame.body) ? frame.body : serviceError(ENVELOPE_ERRORS.protocol, 'err frame without a ServiceError body'),
            ),
          )
          return
        case 'req':
        case 'cancel':
          /* Requests travel the other way; a client is not a router. */
          return
      }
    },
    disconnect() {
      if (!open) return
      open = false
      for (const id of [...pending.keys()]) {
        const entry = finish(id)
        entry?.reject(new ServiceCallError(entry.service, serviceError(ENVELOPE_ERRORS.disconnected, 'disconnected')))
      }
    },
  }
}
