import { describe, expect, it } from 'vitest'
import {
  SERVICE_NAMES,
  buildServices,
  createKernelServices,
  serviceDescriptor,
  type ServiceContribution,
  type ServiceDescriptor,
} from '../kernel'
import { fakeFs } from '../kernel/testkit'
import { localCaller } from './caller'

/**
 * THE IN-PROCESS CALLER, held to the contract the ROUTER keeps.
 *
 * The CLI's premise is that a command does the same thing whether it ran
 * against the local library or across the envelope. That only holds if the two
 * callers agree about the things a handler can observe — and the one a handler
 * can observe most easily is its abort signal.
 *
 * `ServiceContext` defines abort as cancellation, timeout or disconnection.
 * The router aborts on exactly those. This caller used to abort in a `finally`
 * — on success too — so a handler that releases a reservation, logs a
 * cancellation, or refuses follow-up work on abort behaved one way in-process
 * and another over the wire.
 */

/** A table with one service replaced by a handler the test controls. */
function callerOver(name: string, handler: ServiceContribution['handler']) {
  const services = createKernelServices({ fs: fakeFs({}), storage: null, initialBooks: [] })
  const built = buildServices({ services }).map((one) => (one.name === name ? { ...one, handler } : one))
  return localCaller({ services, contributions: built })
}

/** The first `req` and the first `stream` in the table, so this follows it. */
const REQ = SERVICE_NAMES.find((name) => serviceDescriptor(name)?.kind === 'req') as string
const STREAM = SERVICE_NAMES.find((name) => serviceDescriptor(name)?.kind === 'stream') as string

describe('the abort signal a handler is given', () => {
  it('is NOT aborted after a call that answered', async () => {
    let seen: AbortSignal | null = null
    const caller = callerOver(REQ, async (_req, ctx) => {
      seen = ctx.signal
      return { ok: true }
    })
    await caller.call(REQ, bodyFor(REQ))
    expect(seen).toBeInstanceOf(AbortSignal)
    expect((seen as unknown as AbortSignal).aborted).toBe(false)
  })

  /* A CALL THAT FAILED IS A CANCELLATION from the handler's point of view:
   * nobody is waiting for the rest of the work. */
  it('IS aborted after a call that threw', async () => {
    let seen: AbortSignal | null = null
    const caller = callerOver(REQ, async (_req, ctx) => {
      seen = ctx.signal
      throw new Error('no')
    })
    await expect(caller.call(REQ, bodyFor(REQ))).rejects.toThrow()
    expect((seen as unknown as AbortSignal).aborted).toBe(true)
  })

  it('is NOT aborted after a stream that ran out of pages', async () => {
    let seen: AbortSignal | null = null
    const caller = callerOver(STREAM, (_req, ctx) => {
      seen = ctx.signal
      return (async function* () {
        yield [1]
        yield [2]
      })()
    })
    const got: unknown[] = []
    for await (const page of caller.stream(STREAM, bodyFor(STREAM))) got.push(page)
    expect(got).toHaveLength(2)
    expect((seen as unknown as AbortSignal).aborted).toBe(false)
  })

  /* AND BREAKING OUT IS a cancellation — the case abort exists for, and the
   * one that makes stopping early actually stop the work. */
  it('IS aborted when the consumer breaks out early', async () => {
    let seen: AbortSignal | null = null
    const caller = callerOver(STREAM, (_req, ctx) => {
      seen = ctx.signal
      return (async function* () {
        yield [1]
        yield [2]
        yield [3]
      })()
    })
    for await (const _page of caller.stream(STREAM, bodyFor(STREAM))) break
    expect((seen as unknown as AbortSignal).aborted).toBe(true)
  })

  it('IS aborted when the consumer throws mid-stream', async () => {
    let seen: AbortSignal | null = null
    const caller = callerOver(STREAM, (_req, ctx) => {
      seen = ctx.signal
      return (async function* () {
        yield [1]
        yield [2]
      })()
    })
    await expect(
      (async () => {
        for await (const _page of caller.stream(STREAM, bodyFor(STREAM))) throw new Error('stop')
      })(),
    ).rejects.toThrow('stop')
    expect((seen as unknown as AbortSignal).aborted).toBe(true)
  })

  /* ONE CONTROLLER PER ITERATION. A shared one was aborted by whichever pass
   * finished first, so a second pass over the same iterable started already
   * cancelled and every handler refused at once. */
  it('gives a fresh signal to a second pass over the same iterable', async () => {
    const seen: AbortSignal[] = []
    const caller = callerOver(STREAM, (_req, ctx) => {
      seen.push(ctx.signal)
      return (async function* () {
        yield [1]
      })()
    })
    const iterable = caller.stream(STREAM, bodyFor(STREAM))
    for await (const _page of iterable) break
    for await (const _page of iterable) void _page
    expect(seen).toHaveLength(2)
    expect(seen[0]?.aborted).toBe(true)
    expect(seen[1]?.aborted).toBe(false)
  })
})

/** A body that satisfies the descriptor's required fields, whatever they are. */
function bodyFor(name: string): Record<string, unknown> {
  const descriptor = serviceDescriptor(name) as ServiceDescriptor
  const out: Record<string, unknown> = {}
  for (const field of descriptor.input) {
    if (field.required !== true) continue
    out[field.name] =
      field.type === 'string' ? 'x' : field.type === 'number' ? (field.min ?? 0) : field.type === 'boolean' ? true : ['x']
  }
  return out
}
