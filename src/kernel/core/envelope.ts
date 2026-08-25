import type { ServiceContext, ServiceContribution } from './capability'

/**
 * The service envelope on the peer channel — ONE protocol, versioned
 * (mobile-sync plan I.4). Every message is a frame:
 *
 *   { v: 1, service, id, kind: req | res | stream | end | err | cancel, body }
 *
 * length-prefixed JSON on the wire, capped at 4 MiB INCLUDING the header (so
 * the inner JSON payload is capped at `MAX_PAYLOAD_BYTES = 4 MiB − 4`, which
 * is exactly what the outer opaque-frame transport will carry). Above the
 * frame sit a `Router` (the shelf side: `req` frames go to the service that
 * owns the name, gated by the peer's LIVE grants, with a timeout, `cancel`,
 * bounded concurrency and disconnect) and a `Client` (the satchel side:
 * correlates ids, awaits `res`, iterates `stream … end`). Both are
 * POLICY-FREE: which peer holds which grant, what a handler does, what the
 * transport is — none of that is decided here. The router asks `hasGrant`
 * (re-asked at dispatch AND on every continuation frame, so a revoked grant
 * takes effect on an OPEN session); the transport hands bytes in and takes
 * bytes out.
 *
 * Sends are SERIALISED and AWAITED through one per-connection chain, so
 * `req`/`stream`/`end`/`cancel` keep their order, a slow transport applies
 * backpressure, and a failed write tears the connection down rather than
 * being swallowed.
 *
 * Every refusal is a typed `err` frame with a `ServiceError` body, sent
 * before any handler runs — unknown service, duplicate id, forbidden,
 * unsupported version, malformed, timeout, overloaded, protocol — so a peer
 * can tell them apart, and nothing about the request is acted on first. An
 * `err` frame never reflects unbounded attacker input: its `code`/`message`
 * are constant or capped, so building one can never itself exceed the cap.
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

/** The 4 MiB cap on the ENCODED frame (header + payload), on both encode and decode. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024
/** A big-endian u32 length, then the payload. */
export const HEADER_BYTES = 4
/**
 * The cap on the JSON payload alone. The 4 MiB wire cap counts the 4-byte
 * length header, so the inner payload can be at most `MAX_FRAME_BYTES −
 * HEADER_BYTES`; encoding or decoding a larger payload would produce an
 * encoded frame the outer transport refuses.
 */
export const MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES - HEADER_BYTES
/** Bounds on the two names, so a frame cannot carry a novel in its header. */
export const MAX_NAME_LENGTH = 128
/** Deepest `[`/`{` nesting a decoded body may carry — bounds the object graph. */
export const MAX_JSON_DEPTH = 64
/** Caps on the two public fields an `err` frame reflects, so it never grows unbounded. */
export const MAX_ERROR_CODE = 128
export const MAX_ERROR_MESSAGE = 256

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
  overloaded: 'overloaded',
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

/** A payload over `MAX_PAYLOAD_BYTES`, on encode or as declared by a header on decode. */
export class FrameTooLarge extends EnvelopeError {
  readonly bytes: number
  constructor(bytes: number) {
    super('frame-too-large', `frame of ${bytes} bytes exceeds the ${MAX_PAYLOAD_BYTES}-byte payload cap`)
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
 * answer `err unsupported` to the right request. The message is CONSTANT: the
 * offending `version` is kept on the error for diagnostics but never reflected
 * into the wire message, where an attacker-sized `v` could blow the cap.
 */
export class UnsupportedVersion extends EnvelopeError {
  readonly version: unknown
  readonly id: string | null
  readonly service: string | null
  constructor(version: unknown, id: string | null, service: string | null) {
    super('unsupported-version', `envelope version is not ${ENVELOPE_VERSION}`)
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
 * frame that would drop the key on the wire is refused before it does), and
 * `end`/`cancel` carry EXACTLY `null` (they are documented as empty, so a fat
 * body on them is a protocol lie, not something to parse and ignore).
 */
export function parseFrame(value: unknown): Frame {
  if (!isPlainObject(value)) throw new MalformedFrame('frame must be a JSON object')
  for (const key of Object.keys(value)) {
    if (!FRAME_KEYS.has(key)) throw new MalformedFrame('frame has an unknown field')
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
  if ((kind === 'end' || kind === 'cancel') && value.body !== null) throw new MalformedFrame(`frame.body must be null on ${kind}`)
  return { v: ENVELOPE_VERSION, service, id, kind: kind as FrameKind, body: value.body }
}

/**
 * A frame as bytes: a 4-byte big-endian length, then the JSON payload.
 * Validates the frame first (a bad frame is refused here, not by the peer)
 * and refuses a payload that, with its header, would exceed the wire cap.
 */
export function encodeFrame(frame: Frame): Uint8Array {
  const checked = parseFrame(frame)
  const payload = encoder.encode(JSON.stringify(checked))
  if (payload.byteLength > MAX_PAYLOAD_BYTES) throw new FrameTooLarge(payload.byteLength)
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength)
  new DataView(out.buffer).setUint32(0, payload.byteLength, false)
  out.set(payload, HEADER_BYTES)
  return out
}

/**
 * Reject a body whose `[`/`{` nesting is deeper than `maxDepth`. String-aware:
 * brackets inside a JSON string do not count, so `"[[[["` is depth 0. O(n)
 * over already-cap-bounded text, and it rejects BEFORE `JSON.parse` builds the
 * matching (much larger) object graph.
 */
function assertBoundedDepth(text: string, maxDepth: number): void {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (inString) {
      if (escaped) escaped = false
      else if (c === 0x5c /* \ */) escaped = true
      else if (c === 0x22 /* " */) inString = false
      continue
    }
    if (c === 0x22 /* " */) inString = true
    else if (c === 0x5b /* [ */ || c === 0x7b /* { */) {
      depth++
      if (depth > maxDepth) throw new MalformedFrame('frame body nests too deeply')
    } else if (c === 0x5d /* ] */ || c === 0x7d /* } */) depth--
  }
}

/**
 * Reject a body carrying a non-finite number. `JSON.parse("1e400")` yields
 * `Infinity`, which is NOT a JSON value: re-encoding it silently rewrites it
 * to `null`, mutating the body under any check that only asked `typeof x ===
 * "number"`. Walked iteratively so a deep graph cannot overflow the stack.
 */
function assertFiniteNumbers(root: unknown): void {
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const value = stack.pop()
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new MalformedFrame('frame body has a non-finite number')
    } else if (Array.isArray(value)) {
      for (const element of value) stack.push(element)
    } else if (value !== null && typeof value === 'object') {
      for (const nested of Object.values(value)) stack.push(nested)
    }
  }
}

/**
 * Exactly one frame from bytes. The declared length is judged BEFORE anything
 * is decoded or allocated: over the payload cap is `FrameTooLarge`, disagreeing
 * with the bytes present is `MalformedFrame`. Then UTF-8 (fatal), a bounded
 * JSON parse (depth-limited, every number proven finite), and `parseFrame`.
 */
export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.byteLength < HEADER_BYTES) throw new MalformedFrame(`frame header needs ${HEADER_BYTES} bytes, got ${bytes.byteLength}`)
  const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false)
  if (declared > MAX_PAYLOAD_BYTES) throw new FrameTooLarge(declared)
  const present = bytes.byteLength - HEADER_BYTES
  if (declared !== present) throw new MalformedFrame(`frame declares ${declared} payload bytes but ${present} are present`)
  let text: string
  try {
    text = decoder.decode(bytes.subarray(HEADER_BYTES))
  } catch {
    throw new MalformedFrame('frame payload is not UTF-8')
  }
  /* +1: the depth walker sees the whole frame text, and the envelope object
   * itself consumes the first level — the documented limit is the BODY's. */
  assertBoundedDepth(text, MAX_JSON_DEPTH + 1)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new MalformedFrame('frame payload is not JSON')
  }
  assertFiniteNumbers(value)
  return parseFrame(value)
}

/* --------------------------------------------------------- shared helpers */

function isServiceError(value: unknown): value is ServiceError {
  return (
    isPlainObject(value) &&
    typeof value.code === 'string' &&
    typeof value.retryable === 'boolean' &&
    typeof value.message === 'string'
  )
}

/**
 * A NEW `ServiceError` built from allow-listed fields only, each capped. A
 * handler that throws `{code, retryable, message, stack, bookText}` must not
 * ship the extras — only the three public fields cross the wire, and a public
 * message cannot itself grow past the cap.
 */
function toWireError(value: unknown): ServiceError {
  return {
    code: isServiceError(value) ? value.code.slice(0, MAX_ERROR_CODE) : ENVELOPE_ERRORS.internal,
    retryable: isServiceError(value) ? value.retryable : false,
    message: isServiceError(value) ? value.message.slice(0, MAX_ERROR_MESSAGE) : 'the service failed',
  }
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
/** Concurrency caps: unbounded handler tasks/timers are a memory-exhaustion lever. */
export const DEFAULT_MAX_IN_FLIGHT = 256
export const DEFAULT_MAX_IN_FLIGHT_GLOBAL = 1024
/** The byte budget for all of one connection's queued (not-yet-consumed) input. */
export const DEFAULT_MAX_QUEUED_BYTES = 16 * 1024 * 1024

export interface RouterOptions {
  /** The services this side answers for — the composition's, usually. */
  readonly services: Iterable<ServiceContribution>
  /**
   * The peer's persisted grants, asked BEFORE dispatch AND on every
   * continuation frame. Policy lives with the caller: the router only knows
   * the answer for this peer and this grant, and re-asks so a revoked grant
   * takes effect on an already-open session. Keep it cheap and synchronous.
   */
  readonly hasGrant: (peer: string, grant: string) => boolean
  /** Per-request; `err timeout` and the handler's signal aborted when it lapses. */
  readonly timeoutMs?: number
  /** Max concurrent requests per connection (per peer). Excess is `overloaded`. */
  readonly maxInFlight?: number
  /** Max concurrent requests across every connection this router serves. */
  readonly maxInFlightGlobal?: number
  /** Byte budget for one connection's queued input frames. */
  readonly maxQueuedBytes?: number
  readonly timers?: Timers
}

/** One peer's connection to the router: frames in, frames out, and a close. */
export interface RouterConnection {
  /** Which peer this connection speaks for. */
  readonly peer: string
  /** A frame from the peer, as bytes. Never throws: every fault is an `err` frame back. */
  receive(bytes: Uint8Array): void
  /**
   * Re-evaluate every in-flight request against the LIVE grants and abort any
   * whose grant is no longer held — called when a writer narrows this peer's
   * grants, so revocation reaches work already running.
   */
  recheckGrants(): void
  /** The peer is gone: every in-flight handler is aborted and nothing more is written. */
  disconnect(): void
  /** How many requests are in flight — for tests and diagnostics. */
  readonly inFlight: number
}

export interface Router {
  /**
   * `send` may return a promise; the router serialises and awaits it (a plain
   * value, `void` included, is treated as an already-completed write). Typed
   * `unknown` so a synchronous test sink can return anything.
   */
  connect(peer: string, send: (bytes: Uint8Array) => unknown): RouterConnection
}

/** A byte budget shared by one connection's input queues. */
interface ByteBudget {
  reserve(size: number): boolean
  release(size: number): void
}

function makeByteBudget(max: number): ByteBudget {
  let used = 0
  return {
    reserve(size) {
      if (used + size > max) return false
      used += size
      return true
    },
    release(size) {
      used = Math.max(0, used - size)
    },
  }
}

/**
 * The frames a peer streams in after a `req` (`stream` … `end`), as the
 * handler's `ctx.input`. Pull-based: frames queue until the handler asks.
 * BOUNDED by a shared byte budget (an overflowing push is refused, not
 * appended), consumed in O(1) through a head cursor, and CLEARED on close so
 * a cancelled/timed-out/disconnected request releases its queue at once.
 */
class InputQueue implements AsyncIterable<unknown> {
  private readonly items: { value: unknown; size: number }[] = []
  private head = 0
  private waiting: ((result: IteratorResult<unknown>) => void) | null = null
  private closed = false
  private ended = false

  constructor(private readonly budget: ByteBudget) {}

  /**
   * Queue one streamed body of `size` bytes. Returns false when the byte
   * budget is exhausted — the caller refuses the frame rather than growing the
   * queue without bound. A body handed straight to a waiting consumer is
   * delivered, not queued, so it needs no reservation.
   */
  push(item: unknown, size: number): boolean {
    if (this.closed) return true
    if (this.waiting) {
      const wake = this.waiting
      this.waiting = null
      wake({ value: item, done: false })
      return true
    }
    if (!this.budget.reserve(size)) return false
    this.items.push({ value: item, size })
    return true
  }

  /**
   * Graceful EOF: no more items will arrive, but what is QUEUED still
   * belongs to the handler — `close()` here on an `end` frame discarded
   * every buffered stream body the handler had not consumed yet. The abort
   * path stays `close()`, which does discard.
   */
  end(): void {
    if (this.closed || this.ended) return
    this.ended = true
    if (this.waiting && this.head >= this.items.length) {
      const wake = this.waiting
      this.waiting = null
      wake({ value: undefined, done: true })
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (let i = this.head; i < this.items.length; i++) this.budget.release(this.items[i]!.size)
    this.items.length = 0
    this.head = 0
    if (this.waiting) {
      const wake = this.waiting
      this.waiting = null
      wake({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        if (this.head < this.items.length) {
          const entry = this.items[this.head]!
          this.items[this.head] = { value: undefined, size: 0 }
          this.head++
          this.budget.release(entry.size)
          // Compact once the consumed prefix dominates, so memory tracks the
          // live tail rather than every item ever pushed.
          if (this.head > 32 && this.head * 2 >= this.items.length) {
            this.items.splice(0, this.head)
            this.head = 0
          }
          return Promise.resolve({ value: entry.value, done: false })
        }
        if (this.closed || this.ended) return Promise.resolve({ value: undefined, done: true })
        /* ONE consumer — the handler iterating `ctx.input`. A second
         * concurrent read would silently overwrite the first waiter and
         * leave its promise pending forever; refuse it loudly instead. */
        if (this.waiting) return Promise.reject(new Error('InputQueue: a second concurrent read on a single-consumer queue'))
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
  readonly grant: string
  readonly controller: AbortController
  readonly input: InputQueue
  /** True once the peer sent `end`: a `stream` after it is a protocol error. */
  ended: boolean
  timer: unknown
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

/**
 * A router over a set of services. Each `connect` is one peer's connection;
 * requests are tracked per connection (ids are the peer's namespace, and
 * two peers may reuse one). Concurrency is capped per connection AND across
 * every connection this router serves.
 */
/** A configured limit must actually limit: `NaN` disarms every `>` and `>=`
 *  comparison it feeds, and zero or a negative refuses all traffic. */
function positiveLimit(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`envelope: ${name} must be a positive integer, not ${String(value)}`)
  }
  return value
}

export function createRouter(options: RouterOptions): Router {
  const services = new Map<string, ServiceContribution>()
  for (const service of options.services) {
    if (services.has(service.name)) throw new Error(`envelope router: service "${service.name}" registered twice`)
    services.set(service.name, service)
  }
  const timers = options.timers ?? REAL_TIMERS
  const timeoutMs = positiveLimit('timeoutMs', options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const maxInFlight = positiveLimit('maxInFlight', options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT)
  const maxInFlightGlobal = positiveLimit('maxInFlightGlobal', options.maxInFlightGlobal ?? DEFAULT_MAX_IN_FLIGHT_GLOBAL)
  const maxQueuedBytes = positiveLimit('maxQueuedBytes', options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES)
  const hasGrant = options.hasGrant
  let globalInFlight = 0

  return {
    connect(peer, send) {
      const inFlight = new Map<string, InFlight>()
      const budget = makeByteBudget(maxQueuedBytes)
      let open = true

      /* Sends are serialised through one chain so ordering, backpressure and
       * send-error handling survive an async transport. When the chain is
       * idle and the transport is synchronous (a test), the write runs
       * inline; the first async write starts a chain the rest await. */
      let sending: Promise<unknown> | null = null
      const onSendError = () => {
        if (open) disconnect()
      }
      const enqueueBytes = (bytes: Uint8Array) => {
        if (!open) return
        if (sending) {
          sending = sending.then(() => (open ? send(bytes) : undefined)).catch(onSendError)
          return
        }
        let result: unknown
        try {
          result = send(bytes)
        } catch {
          onSendError()
          return
        }
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          /* Normalised first: a PromiseLike without `.catch` would throw
           * HERE, synchronously, and skip the disconnect the error path
           * owes the connection. */
          sending = Promise.resolve(result).catch(onSendError)
        }
      }

      /** Encode (may throw on an oversized body) then enqueue — the stream path. */
      const sendFrame = (frame: Frame) => {
        if (!open) return
        enqueueBytes(encodeFrame(frame))
      }

      /**
       * A typed `err` back to the peer. Its `code`/`message` are capped, so
       * encoding one can never itself exceed the cap; and even so the encode is
       * guarded, so `refuse()` can never throw out of `receive()` and wedge a
       * drain.
       */
      const refuse = (service: string, id: string, error: ServiceError) => {
        if (!open) return
        let bytes: Uint8Array
        try {
          bytes = encodeFrame({ v: ENVELOPE_VERSION, service, id, kind: 'err', body: toWireError(error) })
        } catch {
          return
        }
        enqueueBytes(bytes)
      }

      /** Take a request out of flight, stopping its clock and releasing its queue. Idempotent. */
      const settle = (id: string): InFlight | undefined => {
        const entry = inFlight.get(id)
        if (!entry) return undefined
        inFlight.delete(id)
        globalInFlight--
        timers.clearTimeout(entry.timer)
        entry.input.close()
        return entry
      }

      /**
       * The LAST frame of a request: encoded first (so a body over the cap
       * fails while the request is still ours to refuse), settled second (so
       * a peer that answers a `res` with a fresh `req` of the same id, on a
       * synchronous transport, does not meet its own request in flight), and
       * only then enqueued.
       */
      const answer = (frame: Frame) => {
        const bytes = encodeFrame(frame)
        settle(frame.id)
        enqueueBytes(bytes)
      }

      const abortAndRefuse = (id: string, error: ServiceError) => {
        const entry = settle(id)
        if (entry) {
          entry.controller.abort(error)
          refuse(entry.service, id, error)
        }
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
        /* Bounded concurrency, refused BEFORE a handler context (controller,
         * queue, timer, task) is built — so excess work costs a small frame,
         * not a live task. */
        if (inFlight.size >= maxInFlight || globalInFlight >= maxInFlightGlobal) {
          refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.overloaded, 'too many requests in flight', true))
          return
        }

        const controller = new AbortController()
        const entry: InFlight = { service: frame.service, grant: service.grant, controller, input: new InputQueue(budget), ended: false, timer: undefined }
        entry.timer = timers.setTimeout(() => {
          if (settle(frame.id) === undefined) return
          controller.abort(serviceError(ENVELOPE_ERRORS.timeout, `no answer within ${timeoutMs} ms`, true))
          refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.timeout, `no answer within ${timeoutMs} ms`, true))
        }, timeoutMs)
        globalInFlight++
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
                sendFrame({ v: ENVELOPE_VERSION, service: frame.service, id: frame.id, kind: 'stream', body: item })
                // Backpressure: let this write settle before producing the next.
                if (sending) await sending
                if (!live()) return
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
            /* A `ServiceError` is the handler speaking to the peer — rebuilt
             * from its public fields only, so a stack, a path or a book's text
             * hidden in extra properties never crosses. An answer over the cap
             * says so; anything else is a defect and crosses as `internal`. */
            const error = isServiceError(thrown)
              ? toWireError(thrown)
              : thrown instanceof FrameTooLarge
                ? serviceError(ENVELOPE_ERRORS.frameTooLarge, thrown.message)
                : serviceError(ENVELOPE_ERRORS.internal, 'the service failed')
            refuse(frame.service, frame.id, error)
          }
        })()
      }

      const disconnect = () => {
        if (!open) return
        open = false
        for (const id of [...inFlight.keys()]) {
          settle(id)?.controller.abort(serviceError(ENVELOPE_ERRORS.disconnected, 'peer disconnected'))
        }
      }

      return {
        peer,
        get inFlight() {
          return inFlight.size
        },
        recheckGrants() {
          if (!open) return
          for (const [id, entry] of [...inFlight]) {
            if (!hasGrant(peer, entry.grant)) abortAndRefuse(id, serviceError(ENVELOPE_ERRORS.forbidden, 'grant revoked'))
          }
        },
        receive(bytes) {
          if (!open) return
          const wireSize = bytes.byteLength
          let frame: Frame
          try {
            frame = decodeFrame(bytes)
          } catch (thrown) {
            if (thrown instanceof UnsupportedVersion) {
              refuse(thrown.service ?? ENVELOPE_SERVICE, thrown.id ?? UNKNOWN_ID, serviceError(ENVELOPE_ERRORS.unsupported, thrown.message))
            } else if (thrown instanceof FrameTooLarge) {
              /* The protocol has a name for exactly this — answering
               * `malformed` hid the one hint the peer could act on. */
              refuse(ENVELOPE_SERVICE, UNKNOWN_ID, serviceError(ENVELOPE_ERRORS.frameTooLarge, thrown.message))
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
               * answer on the wire has nothing left to abort. A cancel whose
               * service does not match the in-flight request is a protocol
               * error and does NOT touch the request. */
              const entry = inFlight.get(frame.id)
              if (entry && frame.service !== entry.service) {
                refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.protocol, 'service does not match the request'))
                return
              }
              settle(frame.id)?.controller.abort(serviceError(ENVELOPE_ERRORS.cancelled, 'cancelled by the peer'))
              return
            }
            case 'stream': {
              const entry = inFlight.get(frame.id)
              if (!entry) {
                refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.protocol, `stream for a request not in flight`))
                return
              }
              if (frame.service !== entry.service) {
                refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.protocol, 'service does not match the request'))
                return
              }
              if (entry.ended) {
                refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.protocol, `stream after end`))
                return
              }
              if (!hasGrant(peer, entry.grant)) {
                abortAndRefuse(frame.id, serviceError(ENVELOPE_ERRORS.forbidden, 'grant revoked'))
                return
              }
              if (!entry.input.push(frame.body, wireSize)) {
                abortAndRefuse(frame.id, serviceError(ENVELOPE_ERRORS.overloaded, 'input queue is full', true))
              }
              return
            }
            case 'end': {
              const entry = inFlight.get(frame.id)
              if (!entry) {
                refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.protocol, `end for a request not in flight`))
                return
              }
              if (frame.service !== entry.service) {
                refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.protocol, 'service does not match the request'))
                return
              }
              if (entry.ended) {
                refuse(frame.service, frame.id, serviceError(ENVELOPE_ERRORS.protocol, `end after end`))
                return
              }
              if (!hasGrant(peer, entry.grant)) {
                abortAndRefuse(frame.id, serviceError(ENVELOPE_ERRORS.forbidden, 'grant revoked'))
                return
              }
              entry.ended = true
              entry.input.end()
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
        disconnect,
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
  /** May return a promise; the client serialises and awaits it. See `Router.connect`. */
  readonly send: (bytes: Uint8Array) => unknown
  readonly timeoutMs?: number
  readonly timers?: Timers
  /** Request ids; the default counts. Injectable so a test can name them. */
  readonly nextId?: () => string
  /** Byte budget for a single stream's not-yet-read items. */
  readonly maxStreamBytes?: number
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
  readonly onStream: ((body: unknown, size: number) => void) | null
  timer: unknown
  cleanup: () => void
}

/** The byte budget for one stream's buffered-but-unread items. */
export const DEFAULT_MAX_STREAM_BYTES = 16 * 1024 * 1024

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
  const timeoutMs = positiveLimit('timeoutMs', options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const maxStreamBytes = positiveLimit('maxStreamBytes', options.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES)
  let counter = 0
  const nextId = options.nextId ?? (() => `c${++counter}`)
  const pending = new Map<string, Pending>()
  let open = true

  /* Sends serialised through one chain (see the router for the shape). */
  let sending: Promise<unknown> | null = null
  const onSendError = () => {
    if (open) disconnect()
  }
  const enqueueBytes = (bytes: Uint8Array) => {
    if (!open) return
    if (sending) {
      sending = sending.then(() => (open ? options.send(bytes) : undefined)).catch(onSendError)
      return
    }
    let result: unknown
    try {
      result = options.send(bytes)
    } catch {
      onSendError()
      return
    }
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      /* Normalised like the router's — see above. */
      sending = Promise.resolve(result).catch(onSendError)
    }
  }
  const writeFrame = (frame: Frame) => {
    if (!open) return
    enqueueBytes(encodeFrame(frame))
  }

  const finish = (id: string): Pending | undefined => {
    const entry = pending.get(id)
    if (!entry) return undefined
    pending.delete(id)
    timers.clearTimeout(entry.timer)
    entry.cleanup()
    return entry
  }

  /** Take a pending request out and send `cancel` for it (a clean stop, no reject). */
  const sendCancel = (id: string) => {
    const entry = finish(id)
    if (!entry) return
    writeFrame({ v: ENVELOPE_VERSION, service: entry.service, id, kind: 'cancel', body: null })
  }

  const encodeFailure = (thrown: unknown): ServiceError =>
    thrown instanceof FrameTooLarge
      ? serviceError(ENVELOPE_ERRORS.frameTooLarge, 'request exceeds the frame cap')
      : serviceError(ENVELOPE_ERRORS.malformed, 'request could not be encoded')

  /**
   * Send a `req`, and wire the timeout and the caller's signal to it. The
   * request is ENCODED before any pending state is registered, so a local
   * encode failure (a cyclic object, a `BigInt`, an oversized body) rejects
   * with a typed `ServiceCallError` and leaves no timer, listener or map entry
   * to leak until timeout.
   */
  const begin = (service: string, body: unknown, call: CallOptions, onStream: Pending['onStream']): { id: string; promise: Promise<Frame> } => {
    const id = nextId()
    const promise = new Promise<Frame>((resolve, reject) => {
      if (!open) {
        reject(new ServiceCallError(service, serviceError(ENVELOPE_ERRORS.disconnected, 'client is disconnected')))
        return
      }
      const signal = call.signal
      if (signal?.aborted) {
        reject(new ServiceCallError(service, serviceError(ENVELOPE_ERRORS.cancelled, 'cancelled before it was sent')))
        return
      }
      /* An injectable id generator that repeats an IN-FLIGHT id would
       * overwrite that call's pending entry — one or both then hang or
       * settle with the other's answer. Refuse the broken generator. */
      if (pending.has(id)) {
        reject(new ServiceCallError(service, serviceError(ENVELOPE_ERRORS.internal, `id ${JSON.stringify(id)} is already in flight`)))
        return
      }
      let reqBytes: Uint8Array
      try {
        reqBytes = encodeFrame({ v: ENVELOPE_VERSION, service, id, kind: 'req', body })
      } catch (thrown) {
        reject(new ServiceCallError(service, encodeFailure(thrown)))
        return
      }
      const fail = (error: ServiceError) => {
        if (finish(id) === undefined) return
        writeFrame({ v: ENVELOPE_VERSION, service, id, kind: 'cancel', body: null })
        reject(new ServiceCallError(service, error))
      }
      /* The per-call override must actually limit — `NaN` disarms the
       * timer's comparison and zero or a negative fires it before the
       * request leaves. Same rule the constructor applies to its default. */
      if (call.timeoutMs !== undefined && (!Number.isFinite(call.timeoutMs) || call.timeoutMs <= 0)) {
        reject(new ServiceCallError(service, serviceError(ENVELOPE_ERRORS.internal, `timeoutMs must be a positive finite number, not ${String(call.timeoutMs)}`)))
        return
      }
      const onAbort = () => fail(serviceError(ENVELOPE_ERRORS.cancelled, 'cancelled by the caller'))
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
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
      enqueueBytes(reqBytes)
    })
    return { id, promise }
  }

  const disconnect = () => {
    if (!open) return
    open = false
    for (const id of [...pending.keys()]) {
      const entry = finish(id)
      entry?.reject(new ServiceCallError(entry.service, serviceError(ENVELOPE_ERRORS.disconnected, 'disconnected')))
    }
  }

  return {
    get inFlight() {
      return pending.size
    },
    async call(service, body, call = {}) {
      const { promise } = begin(service, body, call, null)
      const frame = await promise
      if (frame.kind !== 'res') {
        throw new ServiceCallError(service, serviceError(ENVELOPE_ERRORS.protocol, `expected res, got ${frame.kind}`))
      }
      return frame.body
    },
    stream(service, body, call = {}) {
      const items: { value: unknown; size: number }[] = []
      let head = 0
      let bufferedBytes = 0
      let waiting: (() => void) | null = null
      let done: { error?: ServiceCallError } | null = null
      let streamId: string | null = null
      const wake = () => {
        const w = waiting
        waiting = null
        w?.()
      }
      /* Stop the stream: send `cancel`, and settle the iteration (cleanly, or
       * with an error). Used by an early `return()`/`throw()` from the
       * consumer AND by a buffer overflow when the sender outruns the reader. */
      let cancelWanted = false
      const teardown = (error?: ServiceCallError) => {
        /* `begin` can deliver a stream frame REENTRANTLY over a synchronous
         * transport, before `streamId` is assigned below — a teardown fired
         * in that window remembers the cancel and sends it once the id
         * lands. */
        if (streamId !== null) sendCancel(streamId)
        else cancelWanted = true
        if (!done) done = error ? { error } : {}
        wake()
      }
      const { id, promise } = begin(service, body, call, (item, size) => {
        if (done) return
        if (bufferedBytes + size > maxStreamBytes) {
          // The sender is outrunning the reader: stop rather than buffer without
          // bound. The overflowing item is dropped (not delivered then errored).
          teardown(new ServiceCallError(service, serviceError(ENVELOPE_ERRORS.overloaded, 'stream buffer overflow', true)))
          return
        }
        items.push({ value: item, size })
        bufferedBytes += size
        wake()
      })
      streamId = id
      if (cancelWanted) sendCancel(id)
      promise.then(
        (frame) => {
          if (done) return
          done = frame.kind === 'end' ? {} : { error: new ServiceCallError(service, serviceError(ENVELOPE_ERRORS.protocol, `expected end, got ${frame.kind}`)) }
          wake()
        },
        (error: ServiceCallError) => {
          if (done) return
          done = { error }
          wake()
        },
      )
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              for (;;) {
                if (head < items.length) {
                  const entry = items[head]!
                  items[head] = { value: undefined, size: 0 }
                  head++
                  bufferedBytes -= entry.size
                  if (head > 32 && head * 2 >= items.length) {
                    items.splice(0, head)
                    head = 0
                  }
                  return { value: entry.value, done: false }
                }
                if (done) {
                  if (done.error) throw done.error
                  return { value: undefined, done: true }
                }
                if (waiting) throw new ServiceCallError(service, serviceError(ENVELOPE_ERRORS.internal, 'a second concurrent read on a single-consumer stream'))
                await new Promise<void>((resolve) => {
                  waiting = resolve
                })
              }
            },
            return(): Promise<IteratorResult<unknown>> {
              teardown()
              return Promise.resolve({ value: undefined, done: true })
            },
            throw(reason?: unknown): Promise<IteratorResult<unknown>> {
              teardown()
              return Promise.reject(reason)
            },
          }
        },
      }
    },
    receive(bytes) {
      if (!open) return
      const wireSize = bytes.byteLength
      const frame = decodeFrame(bytes)
      const entry = pending.get(frame.id)
      if (!entry) return
      if (frame.service !== entry.service) {
        /* A continuation labelled with a service other than the request's is a
         * protocol violation: reject rather than resolve the wrong call. */
        finish(frame.id)
        entry.reject(new ServiceCallError(entry.service, serviceError(ENVELOPE_ERRORS.protocol, 'service does not match the request')))
        return
      }
      switch (frame.kind) {
        case 'stream':
          if (entry.onStream) entry.onStream(frame.body, wireSize)
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
              isServiceError(frame.body) ? toWireError(frame.body) : serviceError(ENVELOPE_ERRORS.protocol, 'err frame without a ServiceError body'),
            ),
          )
          return
        case 'req':
        case 'cancel':
          /* Requests travel the other way; a client is not a router. */
          return
      }
    },
    disconnect,
  }
}
