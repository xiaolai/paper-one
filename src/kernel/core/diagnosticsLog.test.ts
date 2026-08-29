import { describe, expect, it, vi } from 'vitest'
import { createDiagnostics } from './diagnostics'
import {
  createDiagnosticLog,
  createDiagnosticSpool,
  DEFAULT_CAPACITY,
  DEFAULT_FLUSH_MS,
  type DiagnosticEntry,
} from './diagnosticsLog'

/**
 * The window a running Paper can be asked about afterwards.
 *
 * The reason it exists is in the module header: the app's own account of a
 * failed sync went to a webview console on the far end of an ssh connection,
 * so three e2e runs each ended with a timeout and no cause. These cases are
 * about the two properties that make the file safe to read and safe to keep —
 * it is bounded, and it never carries anything `redact` would have removed.
 */

const sink = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

describe('the window is bounded by construction', () => {
  it('keeps the newest entries and counts what fell off', () => {
    const log = createDiagnosticLog({ capacity: 3 })
    for (let i = 0; i < 5; i++) {
      log.record({ at: i, level: 'info', scope: 'sync', event: `e${i}`, fields: {} })
    }
    expect(log.entries().map((e) => e.event)).toEqual(['e2', 'e3', 'e4'])
    expect(log.dropped()).toBe(2)
  })

  it('never becomes a no-op that still looks like a log', () => {
    /* A capacity of zero would record nothing while every caller believed it
       was recording — the shape of every silent-drop defect in this tree. */
    const log = createDiagnosticLog({ capacity: 0 })
    log.record({ at: 1, level: 'warn', scope: 'sync', event: 'kept', fields: {} })
    expect(log.entries().map((e) => e.event)).toEqual(['kept'])
  })

  it('falls back rather than accepting a capacity that is not a finite bound', () => {
    /* `Math.max(1, NaN)` is NaN, and every comparison against NaN is false —
       so nothing is ever evicted. `Infinity` evicts nothing either. Both turn
       "bounded by construction" into unbounded growth in the one module whose
       entire claim is the bound. */
    /* PAST THE FALLBACK, not five entries. The first version of this recorded
       five and asserted the window was no larger than DEFAULT_CAPACITY — which
       the BROKEN implementation also satisfies, since five is under two
       thousand either way. A test a bug passes is not a test. */
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
      const log = createDiagnosticLog({ capacity: bad })
      for (let i = 0; i < DEFAULT_CAPACITY + 5; i++) {
        log.record({ at: i, level: 'info', scope: 's', event: `e${i}`, fields: {} })
      }
      expect(log.entries().length, `capacity ${String(bad)}`).toBe(DEFAULT_CAPACITY)
      expect(log.dropped(), `capacity ${String(bad)}`).toBe(5)
    }
  })

  it('hands out a copy, so a reader cannot rewrite what the window said', () => {
    /* Entries were stored and returned by reference, and `fields` is a mutable
       Record — so anything that read the log could retroactively change it,
       and the file is a projection of the window. */
    const log = createDiagnosticLog()
    const fields: Record<string, unknown> = { kind: 'timeout' }
    log.record({ at: 1, level: 'warn', scope: 's', event: 'e', fields })
    fields['kind'] = 'tampered'
    /* Cast because `readonly` is a COMPILE-time guard and this case is about
       the runtime one: plain JavaScript, or anything reached through an `any`,
       can still call `pop` on the array it was handed. */
    const taken = log.entries() as DiagnosticEntry[]
    taken.pop()
    expect(log.entries()).toHaveLength(1)
    expect(log.entries()[0]?.fields['kind']).toBe('timeout')
  })

  it('falls back rather than allocating an absurd but finite window', () => {
    /* `new Array(size)` throws RangeError past 2**32-1, and merely allocating
       hundreds of megabytes short of that defeats the bound this module is
       for. Finiteness alone was not enough. */
    expect(() => createDiagnosticLog({ capacity: 2 ** 32 })).not.toThrow()
    const log = createDiagnosticLog({ capacity: 2 ** 32 })
    log.record({ at: 1, level: 'info', scope: 's', event: 'e', fields: {} })
    expect(log.entries()).toHaveLength(1)
  })

  it('freezes NESTED values too, which redact does not flatten', () => {
    /* The comment here once said `redact` had "summarised" nested values so a
       shallow freeze sufficed. It had not — `redact` bounds depth and returns
       nested objects intact, so this was a live route back into the window. */
    const log = createDiagnosticLog()
    log.record({ at: 1, level: 'warn', scope: 's', event: 'e', fields: { nested: { kind: 'original' } } })
    const nested = log.entries()[0]?.fields['nested'] as Record<string, unknown>
    try {
      nested['kind'] = 'tampered'
    } catch {
      /* Strict mode throws on a frozen target; either way the value must hold. */
    }
    expect((log.entries()[0]?.fields['nested'] as Record<string, unknown>)['kind']).toBe('original')
  })

  it('does not throw out of record when a field cannot be read', () => {
    /* `{ ...fields }` invokes getters. The reporting path absorbs a throw; a
       direct caller of the log would not. */
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('cannot be read')
      },
    })
    const log = createDiagnosticLog()
    expect(() => log.record({ at: 1, level: 'error', scope: 's', event: 'e', fields: hostile })).not.toThrow()
    expect(log.entries()[0]?.event).toBe('e')
  })

  it('clears the count with the window, so a stale drop total cannot outlive it', () => {
    const log = createDiagnosticLog({ capacity: 1 })
    log.record({ at: 1, level: 'info', scope: 's', event: 'a', fields: {} })
    log.record({ at: 2, level: 'info', scope: 's', event: 'b', fields: {} })
    expect(log.dropped()).toBe(1)
    log.clear()
    expect(log.entries()).toEqual([])
    expect(log.dropped()).toBe(0)
  })
})

describe('the file projection', () => {
  it('is one JSON object per line, parseable back', () => {
    const log = createDiagnosticLog()
    log.record({ at: 7, level: 'warn', scope: 'sync.push', event: 'sync.session-failed', fields: { kind: 'timeout' } })
    log.record({ at: 8, level: 'info', scope: 'peer', event: 'peer.dialled', fields: {} })
    const rows = log.toJsonl().split('\n').map((line) => JSON.parse(line))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ at: 7, level: 'warn', scope: 'sync.push', event: 'sync.session-failed' })
    expect(rows[0].fields).toEqual({ kind: 'timeout' })
  })

  it('replaces one unserialisable entry rather than losing the window', () => {
    /* The file is what the next person reads to find out what happened. One
       cyclic field costing every other line would make the worst failures the
       least legible, which is exactly backwards. */
    const cyclic: Record<string, unknown> = { kind: 'weird' }
    cyclic['self'] = cyclic
    const log = createDiagnosticLog()
    log.record({ at: 1, level: 'error', scope: 's', event: 'before', fields: {} })
    log.record({ at: 2, level: 'error', scope: 's', event: 'bad', fields: cyclic })
    log.record({ at: 3, level: 'error', scope: 's', event: 'after', fields: {} })
    const rows = log.toJsonl().split('\n').map((line) => JSON.parse(line))
    expect(rows.map((r) => r.event)).toEqual(['before', 'bad', 'after'])
    expect(rows[1].fields).toEqual({ note: 'fields could not be serialised' })
  })

  it('is empty rather than a stray newline when nothing has been reported', () => {
    expect(createDiagnosticLog().toJsonl()).toBe('')
  })
})

/**
 * THE PROPERTY THAT MAKES A FILE SAFE, and the reason `record` was added to
 * `createDiagnostics` rather than teeing the sink somewhere.
 *
 * Redaction runs ONCE, above both readers. A console line that leaks a token
 * is bad; a FILE that leaks one is bad for as long as the file exists, and
 * this one is written to a reader's own data directory.
 */
describe('what reaches a recorder', () => {
  it('has been redacted, exactly as the console line has', () => {
    const log = createDiagnosticLog()
    const out = sink()
    const diag = createDiagnostics({ sink: out, record: log.record, now: () => 42 })
    diag.warn('sync.session-failed', { kind: 'forbidden', authToken: 'sh-secret', peerId: 'abcd', count: 3 })

    const entry = log.entries()[0]
    if (entry === undefined) throw new Error('nothing was recorded')
    expect(entry).toMatchObject({ at: 42, level: 'warn', scope: 'kernel', event: 'sync.session-failed' })
    expect(entry.fields['kind']).toBe('forbidden')
    expect(entry.fields['count']).toBe(3)
    expect(entry.fields['authToken']).not.toBe('sh-secret')
    expect(entry.fields['peerId']).not.toBe('abcd')
    /* The same object the console was handed — not a second redaction that
       could drift from it. */
    expect(out.warn).toHaveBeenCalledWith('[paper:kernel] sync.session-failed', entry.fields)
  })

  it('carries the compound scope a child builds, so a pane can filter by capability', () => {
    const log = createDiagnosticLog()
    createDiagnostics({ sink: sink(), record: log.record, scope: 'kernel' })
      .child('sync')
      .child('push')
      .error('refused', {})
    expect(log.entries()[0]?.scope).toBe('kernel.sync.push')
  })

  it('does not cost the console its line when the recorder throws', () => {
    /* A diagnostic is written from a catch block more often than not. A
       recorder that turned one failure into two would be worse than no
       recorder — the same rule the sink already follows. */
    const out = sink()
    const diag = createDiagnostics({
      sink: out,
      record: () => {
        throw new Error('recorder is broken')
      },
    })
    expect(() => diag.error('boom', { a: 1 })).not.toThrow()
    expect(out.error).toHaveBeenCalledWith('[paper:kernel] boom', { a: 1 })
  })

  it('still records when the SINK throws, which is the untested direction', () => {
    /* The mirror of the case above. Isolation was only ever proved one way —
       a throwing recorder not costing the console its line — and the console
       is the reader far more likely to be a test double or a closed bridge. */
    const log = createDiagnosticLog()
    const broken = {
      info: vi.fn(),
      warn: vi.fn(() => {
        throw new Error('sink is broken')
      }),
      error: vi.fn(),
    }
    const diag = createDiagnostics({ sink: broken, record: log.record })
    expect(() => diag.warn('reported anyway', { kind: 'x' })).not.toThrow()
    expect(log.entries()[0]?.event).toBe('reported anyway')
  })

  it('survives fields that cannot be redacted, rather than throwing out of the report', () => {
    /* `redact` WALKS the value: a getter that throws makes redaction itself
       throw, out of warn/error, past a guard that only wrapped the sink call.
       A diagnostic is written from a catch block more often than not. */
    const log = createDiagnosticLog()
    const out = sink()
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('cannot be read')
      },
    })
    const diag = createDiagnostics({ sink: out, record: log.record })
    expect(() => diag.error('still-reported', hostile)).not.toThrow()
    expect(log.entries()[0]?.event).toBe('still-reported')
    expect(out.error).toHaveBeenCalled()
  })

  it('records nothing at all when diagnostics are disabled', () => {
    /* `enabled: false` is `NOOP_DIAGNOSTICS`, and a recorder must not be a
       way around it — a release build that turned diagnostics off would
       otherwise still be filling a file. */
    const log = createDiagnosticLog()
    createDiagnostics({ sink: sink(), record: log.record, enabled: false }).warn('ignored', {})
    expect(log.entries()).toEqual([])
  })
})

/**
 * The projection onto disk. Timers are injected so these run without waiting.
 */
describe('the spool', () => {
  const fakeTimers = () => {
    let seq = 0
    const asked: number[] = []
    const due = new Map<number, () => void>()
    return {
      timers: {
        setTimeout: (fn: () => void, ms: number) => {
          const id = ++seq
          due.set(id, fn)
          asked.push(ms)
          return id
        },
        clearTimeout: (handle: unknown) => {
          due.delete(handle as number)
        },
      },
      run: () => {
        for (const [id, fn] of [...due]) {
          due.delete(id)
          fn()
        }
      },
      pending: () => due.size,
      /* The delay actually requested — a debounce nobody asserts could be zero. */
      asked: () => asked,
    }
  }

  const spooled = (write: (jsonl: string) => Promise<void>) => {
    const log = createDiagnosticLog()
    const clock = fakeTimers()
    const spool = createDiagnosticSpool({ log, write, timers: clock.timers })
    return { log, spool, clock }
  }

  it('settles a burst into ONE write', async () => {
    /* A refused sync session reports once per book. Forty whole-file writes
       for one window would turn a report into an I/O problem. */
    const writes: string[] = []
    const { log, spool, clock } = spooled(async (jsonl) => {
      writes.push(jsonl)
    })
    for (let i = 0; i < 40; i++) {
      log.record({ at: i, level: 'warn', scope: 'sync', event: 'sync.push-refused', fields: { book: `b${i}` } })
      spool.touch()
    }
    expect(writes).toHaveLength(0)
    clock.run()
    await Promise.resolve()
    expect(writes).toHaveLength(1)
    expect(writes[0]?.split('\n')).toHaveLength(40)
  })

  it('writes on flush without waiting for the debounce, and cancels it', async () => {
    /* Shutdown: the tail is the part worth having. */
    const writes: string[] = []
    const { log, spool, clock } = spooled(async (jsonl) => {
      writes.push(jsonl)
    })
    log.record({ at: 1, level: 'error', scope: 's', event: 'last-words', fields: {} })
    spool.touch()
    await spool.flush()
    expect(writes).toHaveLength(1)
    expect(clock.pending()).toBe(0)
    clock.run()
    expect(writes).toHaveLength(1)
  })

  it('does not become a second failure when the write fails', async () => {
    /* The whole point of a diagnostic is to report a failure. One that threw
       out of its own reporting would be worse than none. */
    const { log, spool } = spooled(async () => {
      throw new Error('disk is gone')
    })
    log.record({ at: 1, level: 'error', scope: 's', event: 'e', fields: {} })
    await expect(spool.flush()).resolves.toBeUndefined()
  })

  /**
   * ⚠️ **THE CASE THAT LET A HIGH THROUGH.** The flush test below covered a
   * PENDING TIMER only, and `put()` used to return early whenever a write was
   * already running — so `flush()` resolved before the bytes were on disk, and
   * the one caller that needs it is the shutdown handshake, whose entire
   * purpose is not to lose the tail. Every test passed. An audit found it by
   * reading.
   *
   * Held open with a deferred write, which is the only way to observe the
   * window where the bug lived.
   */
  it('does not resolve flush while a write is still in flight, and writes the latest window', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const writes: string[] = []
    let started = 0
    const log = createDiagnosticLog()
    const clock = fakeTimers()
    const spool = createDiagnosticSpool({
      log,
      timers: clock.timers,
      write: async (jsonl) => {
        started += 1
        writes.push(jsonl)
        if (started === 1) await gate
      },
    })

    log.record({ at: 1, level: 'info', scope: 's', event: 'first', fields: {} })
    spool.touch()
    clock.run()
    await Promise.resolve()
    expect(started).toBe(1)

    /* A second report arrives while the first write is blocked — this is what
       a shutdown during a slow disk looks like. */
    log.record({ at: 2, level: 'error', scope: 's', event: 'second', fields: {} })
    let settled = false
    const flushing = spool.flush().then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled, 'flush resolved while a write was still in flight').toBe(false)

    release()
    await flushing
    expect(settled).toBe(true)
    /* And the LATEST window reached disk, not the one from before the flush. */
    expect(writes[writes.length - 1]).toContain('second')
  })

  /* ⚠️ **ONE FIX HERE IS STRUCTURAL AND NOT COVERED, said plainly.** `kick`
     loops rather than awaiting the live drain once, which closes a completion
     race: `drain` can decide the window is clean and resolve, and before its
     `finally` clears `inFlight` a waiting caller can set it dirty again, await
     a promise that is already finishing, and get back with nothing written.
     Reverting the loop to a single await passes every case in this file —
     measured — because the window is two microtasks inside one promise chain
     and cannot be interleaved from the public API with these fakes. The loop
     makes the state unreachable rather than detected; that is the argument for
     it, and there is no test standing behind it. */
  it('keeps writing after a failed write, rather than losing the pending one', async () => {
    /* A write that failed used to leave the loop and take a concurrently-set
       pending write with it — with the timer already cancelled, nothing was
       left to retry it. */
    let attempt = 0
    const writes: string[] = []
    const log = createDiagnosticLog()
    const clock = fakeTimers()
    const spool = createDiagnosticSpool({
      log,
      timers: clock.timers,
      write: async (jsonl) => {
        attempt += 1
        if (attempt === 1) throw new Error('disk hiccup')
        writes.push(jsonl)
      },
    })
    log.record({ at: 1, level: 'error', scope: 's', event: 'first', fields: {} })
    await spool.flush()
    expect(writes).toHaveLength(0)

    log.record({ at: 2, level: 'error', scope: 's', event: 'second', fields: {} })
    await spool.flush()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('second')
  })

  it('takes the writer slot before the writer runs, so a re-entrant write cannot start a second drain', async () => {
    /* `inFlight = drain().finally(…)` looks like a lock and is not one: an
       async function runs synchronously to its first `await`, so `drain`
       reached `write()` while the slot was still null. A `write` that called
       back in would start a second drain and the two would overwrite each
       other's `finally`. */
    let live = 0
    let peak = 0
    let reentered = false
    const log = createDiagnosticLog()
    const clock = fakeTimers()
    let spool: ReturnType<typeof createDiagnosticSpool> | null = null
    spool = createDiagnosticSpool({
      log,
      timers: clock.timers,
      write: async () => {
        live += 1
        peak = Math.max(peak, live)
        if (!reentered) {
          reentered = true
          /* Re-enter exactly once — a writer that logs, or a shutdown racing
             its own flush. */
          void spool?.flush()
        }
        await Promise.resolve()
        live -= 1
      },
    })
    log.record({ at: 1, level: 'info', scope: 's', event: 'e', fields: {} })
    await spool.flush()
    expect(peak, 'two drains ran at once').toBe(1)
  })

  it('asks for the debounce it was configured with', () => {
    /* The fake timer used to discard the delay, so a debounce of zero — or of
       the wrong constant — would have passed every case here. */
    const log = createDiagnosticLog()
    const clock = fakeTimers()
    createDiagnosticSpool({ log, write: async () => {}, timers: clock.timers, flushMs: 250 }).touch()
    expect(clock.asked()).toEqual([250])

    const other = fakeTimers()
    createDiagnosticSpool({ log, write: async () => {}, timers: other.timers }).touch()
    expect(other.asked()).toEqual([DEFAULT_FLUSH_MS])
  })

  it('writes on no path at all once stopped', async () => {
    /* "Stops writing" has to mean every entry point. The old case only proved
       a scheduled timer was cancelled, and `flush()` still wrote. */
    const writes: string[] = []
    const { log, spool, clock } = spooled(async (jsonl) => {
      writes.push(jsonl)
    })
    log.record({ at: 1, level: 'info', scope: 's', event: 'e', fields: {} })
    spool.stop()
    spool.touch()
    expect(clock.pending()).toBe(0)
    await spool.flush()
    clock.run()
    await Promise.resolve()
    expect(writes).toHaveLength(0)
  })

  it('stops writing once stopped', async () => {
    const writes: string[] = []
    const { log, spool, clock } = spooled(async (jsonl) => {
      writes.push(jsonl)
    })
    log.record({ at: 1, level: 'info', scope: 's', event: 'e', fields: {} })
    spool.touch()
    spool.stop()
    clock.run()
    await Promise.resolve()
    expect(writes).toHaveLength(0)
  })
})
