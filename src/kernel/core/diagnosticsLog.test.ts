import { describe, expect, it, vi } from 'vitest'
import { createDiagnostics } from './diagnostics'
import { createDiagnosticLog, createDiagnosticSpool } from './diagnosticsLog'

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
    const due = new Map<number, () => void>()
    return {
      timers: {
        setTimeout: (fn: () => void) => {
          const id = ++seq
          due.set(id, fn)
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
