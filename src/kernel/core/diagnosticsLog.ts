/**
 * The diagnostics a running Paper can still be asked about afterwards.
 *
 * WHAT THIS EXISTS FOR, precisely, because it is a whole module for something
 * that looks like a nicety. `Diagnostics` writes to a `Sink`, and the two
 * sinks that existed were the console and nothing — the console in a dev
 * build, nothing in a release. So the app's own account of a failure lived in
 * a webview console, which is reachable by a person with devtools open and by
 * nobody else.
 *
 * That is not a theoretical gap. `scripts/sync-scenario.sh` drives two
 * machines over ssh, and it has never completed a clean pass in three
 * attempts. When a convergence step times out, the satchel has ALREADY
 * written why — `sync.session-failed`, with the refusal kind and the message —
 * into a console on the far end of an ssh connection. WI-8.6 could not read
 * it, guessed at the cause instead, wrote "WebKit suspends timers in a hidden
 * page … is a sufficient explanation", marked its own guess UNVERIFIED, and
 * that guess then shaped this feature's documentation and its harness for
 * weeks. The measurement that refuted it took an afternoon; reading the log
 * would have taken a second.
 *
 * So: a bounded window of what was reported, kept in memory, projectable to a
 * file. Two readers, one structure — a dev pane that wants the window, and a
 * harness over ssh that wants the file.
 *
 * BOUNDED BY CONSTRUCTION, not by a rotation policy. It holds the last
 * `capacity` entries and the file is a PROJECTION of exactly that, rewritten
 * whole. There is no growth to manage, no rotation to get wrong, and no way
 * for a machine left running for a month to fill a disk with its own
 * complaints.
 *
 * REDACTION IS UPSTREAM AND MUST STAY THERE. `createDiagnostics` redacts
 * before it reaches any sink, so what arrives here has already lost its
 * secrets, peer identities, book text and envelope bodies. This module must
 * never take a field from anywhere else, because writing to a FILE is a much
 * longer-lived mistake than writing to a console.
 */

/**
 * The file, and the switch that turns it on outside a dev build.
 *
 * DECLARED HERE BECAUSE TWO PROGRAMS SHARE THEM. The app writes the file and
 * `scripts/sync-scenario.sh` reads it over ssh from the far machine, so a
 * second spelling of either name is a harness that quietly reads nothing —
 * the same reason `serviceTable.ts` exists. Both sit at the root of the data
 * directory, beside `index.json`.
 *
 * The switch is a FILE rather than a setting because the decision is made
 * before the services that hold settings exist, and because a harness driving
 * a release build over ssh can create a path where it cannot open a pane.
 */
export const DIAGNOSTICS_FILE = 'diagnostics.jsonl'
export const DIAGNOSTICS_SWITCH = 'diagnostics.on'

/** One reported diagnostic, structured — the console gets a formatted line. */
export interface DiagnosticEntry {
  /** Epoch milliseconds. */
  readonly at: number
  readonly level: 'info' | 'warn' | 'error'
  /** The compound scope: `sync`, `sync.push`, `peer` — as `child()` builds it. */
  readonly scope: string
  readonly event: string
  /** Already redacted by `createDiagnostics`. */
  readonly fields: Record<string, unknown>
}

export interface DiagnosticLog {
  /** Hand to `createDiagnostics` as its `record`. */
  record(entry: DiagnosticEntry): void
  /** The window, oldest first. */
  entries(): readonly DiagnosticEntry[]
  /** How many fell off the back — reported so a reader knows the window moved. */
  dropped(): number
  /** The window as JSON Lines, which is what the file holds. */
  toJsonl(): string
  clear(): void
}

/** Enough to hold a failed sync session and what led to it, and small enough
 *  that rewriting the file whole is cheaper than deciding not to. */
export const DEFAULT_CAPACITY = 2_000

/** Past this a window is not a window. `new Array` throws past 2**32-1, and
 *  anything near it defeats the bound this module exists for. */
export const MAX_CAPACITY = 1_000_000

/** The depth `redact` walks to; a snapshot need never freeze deeper. */
const FREEZE_DEPTH = 8

export interface DiagnosticLogOptions {
  readonly capacity?: number
}

export function createDiagnosticLog({ capacity = DEFAULT_CAPACITY }: DiagnosticLogOptions = {}): DiagnosticLog {
  /* FINITE, and checked as such. `Math.max(1, NaN)` is NaN — every comparison
     against it is false, so nothing is ever evicted — and `Infinity` evicts
     nothing either. Both turn "bounded by construction" into unbounded growth
     in a module whose whole claim is the bound, so a value that is not a
     finite positive number falls back rather than being coerced. */
  const asked = Math.floor(capacity)
  /* AND AN UPPER BOUND, because `new Array(size)` throws `RangeError` past
     2**32-1 and merely allocating hundreds of megabytes short of that is no
     better in a module whose point is a bound. Finiteness alone was not
     enough. */
  const size = Number.isFinite(asked) && asked >= 1 && asked <= MAX_CAPACITY ? asked : DEFAULT_CAPACITY

  /* A REAL RING, with a write index. This was an array plus `slice`, which
     copied up to `capacity` references on EVERY record once full — O(capacity)
     steady state for a structure named after the one that is O(1). */
  const slots: (DiagnosticEntry | undefined)[] = new Array<DiagnosticEntry | undefined>(size)
  let next = 0
  let held = 0
  let lost = 0

  /* SNAPSHOT ON THE WAY IN. `fields` is a mutable `Record` and entries were
     stored by reference, so a caller could rewrite what the window said long
     after reporting it — and the file is a projection of the window. A shallow
     copy of `fields` is enough: `redact` has already replaced every nested
     value with a summarised one. */
  /* Depth-bounded, failure-tolerant, and applied to what is STORED — see
     `snapshot`. The bound matches the one `redact` walks to, so this can never
     be the longer walk of the two. */
  const freezeDeep = (value: unknown, depth = 0): void => {
    if (depth > FREEZE_DEPTH || value === null || typeof value !== 'object') return
    try {
      Object.freeze(value)
      for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested, depth + 1)
    } catch {
      /* An object that refuses to freeze is left as it is. */
    }
  }

  const snapshot = (entry: DiagnosticEntry): DiagnosticEntry => {
    /* ⚠️ **DEEP, AND THE NOTE HERE USED TO BE WRONG ABOUT WHY IT NEED NOT BE.**
       It said `redact` "has already summarised" nested values, so a shallow
       freeze was enough. It has not: `redact` bounds DEPTH but returns nested
       plain objects and arrays intact, so `entries()[0].fields.nested.kind = …`
       rewrote the window and the file through a value the log had handed out.
       `createDiagnostics` freezes on its side too; this is the log keeping its
       own promise rather than inheriting one from its only current caller.

       AND THE SPREAD IS GUARDED, because `{ ...fields }` invokes getters: a
       hostile field could throw out of `record`, which the reporting path
       absorbs but a direct caller would not. */
    let fields: Record<string, unknown>
    try {
      fields = { ...entry.fields }
    } catch {
      fields = { note: 'fields could not be read' }
    }
    const frozen: DiagnosticEntry = {
      at: entry.at,
      level: entry.level,
      scope: entry.scope,
      event: entry.event,
      fields,
    }
    freezeDeep(frozen)
    return frozen
  }

  const ordered = (): DiagnosticEntry[] => {
    const out: DiagnosticEntry[] = []
    const from = held < size ? 0 : next
    for (let i = 0; i < held; i++) {
      const entry = slots[(from + i) % size]
      if (entry !== undefined) out.push(entry)
    }
    return out
  }

  return {
    record: (entry) => {
      if (held === size) lost += 1
      slots[next] = snapshot(entry)
      next = (next + 1) % size
      if (held < size) held += 1
    },
    /* A COPY, not the live structure. Returning the internal array let a
       caller mutate history through the value it was handed to read. */
    entries: () => ordered(),
    dropped: () => lost,
    /* ONE OBJECT PER LINE, and a line that will not stringify is REPLACED
       rather than dropped. `fields` has been through `redact`, which walks and
       summarises, but a caller can still hand in something cyclic — and a
       single bad entry must not cost the whole window, which is the file the
       next person reads to find out what happened. */
    toJsonl: () =>
      ordered()
        .map((entry) => {
          try {
            return JSON.stringify(entry)
          } catch {
            return JSON.stringify({
              at: entry.at,
              level: entry.level,
              scope: entry.scope,
              event: entry.event,
              fields: { note: 'fields could not be serialised' },
            })
          }
        })
        .join('\n'),
    clear: () => {
      slots.fill(undefined)
      next = 0
      held = 0
      lost = 0
    },
  }
}

/**
 * The file the window is projected into, debounced.
 *
 * WRITTEN WHOLE, NOT APPENDED. The log is already bounded, so the file is a
 * projection of exactly that window — which means there is no rotation policy
 * to get wrong, no growth to manage, and no way for a machine left running
 * for a month to fill a disk with its own complaints. Appending would need
 * all three.
 *
 * DEBOUNCED, because a diagnostic is written from a catch block and failures
 * arrive in bursts: a sync session that refuses forty books reports forty
 * times in a few milliseconds, and forty whole-file writes for one window
 * would turn a report into an I/O problem. One write settles the burst.
 *
 * NEVER THROWS, and never lets a write it could not finish stop the next one.
 * A diagnostic is allowed to be lost — that is what a diagnostic is — and the
 * one thing it must never do is become a second failure on top of the one it
 * was reporting.
 */
export interface DiagnosticSpool {
  /** The window changed; a write follows once the burst settles. */
  touch(): void
  /** Write now, and wait for it — for a shutdown that must not lose the tail. */
  flush(): Promise<void>
  stop(): void
}

export interface SpoolTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const REAL_TIMERS: SpoolTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Long enough to settle a burst of refusals, short enough that a crash a
 *  moment later still leaves the interesting part on disk. */
export const DEFAULT_FLUSH_MS = 2_000

export interface DiagnosticSpoolOptions {
  readonly log: DiagnosticLog
  /** Writes the whole file. Injected: the kernel does not know a filesystem. */
  readonly write: (jsonl: string) => Promise<void>
  readonly flushMs?: number
  readonly timers?: SpoolTimers
}

export function createDiagnosticSpool({
  log,
  write,
  flushMs = DEFAULT_FLUSH_MS,
  timers = REAL_TIMERS,
}: DiagnosticSpoolOptions): DiagnosticSpool {
  let handle: unknown = null
  /* A FLAG, NOT A NULL HANDLE. `SpoolTimers.setTimeout` returns `unknown`, and
     `null` is a legal value for it — a conforming timer that returned null
     would make every cancellation a no-op and let debounces stack up. */
  let armed = false
  let inFlight: Promise<void> | null = null
  let dirty = false
  let stopped = false

  const cancelPending = (): void => {
    if (!armed) return
    timers.clearTimeout(handle)
    handle = null
    armed = false
  }

  /* ONE WRITER, AND THE CATCH IS PER ITERATION. A failing write used to leave
     the whole loop, discarding a `dirty` a concurrent caller had just set —
     with the timer already cancelled, that write was lost with nothing left to
     retry it. Catching inside the loop keeps the flag and takes another pass. */
  const drain = async (): Promise<void> => {
    while (dirty && !stopped) {
      dirty = false
      try {
        await write(log.toJsonl())
      } catch {
        /* A lost projection, not a second failure. The window is still in
           memory, and the next touch or flush writes it. */
      }
    }
  }

  /* THE PROMISE IS SHARED, which is what makes `flush` mean anything. It used
     to return early when a write was already running, so `flush()` resolved
     BEFORE the bytes were on disk — and the one caller that needs it is the
     shutdown handshake, whose entire purpose is not to lose the tail. Marking
     the window dirty and awaiting the live drain guarantees the LATEST
     snapshot has been written by the time it resolves. */
  const kick = async (): Promise<void> => {
    dirty = true
    /* ⚠️ **LOOPED, BECAUSE AWAITING THE LIVE DRAIN ONCE IS NOT ENOUGH.** The
       first fix shared `inFlight` and returned it, which closes the ordinary
       case and leaves a completion race: `drain` can decide `dirty` is false
       and resolve, and before its `finally` clears `inFlight` a waiting
       `flush()` sets `dirty` again, sees a non-null `inFlight`, and awaits a
       promise that is already finishing. It resolves with the window dirty and
       nobody writing — which is the same lost tail, in a smaller window.
       Re-checking after the await is what actually closes it: by then
       `finally` has run, `inFlight` is null, and this starts the next drain. */
    while (dirty && !stopped) {
      if (inFlight === null) {
        /* ⚠️ **STARTED ON A MICROTASK, so the slot is taken before any of
           `drain` runs.** `inFlight = drain().finally(…)` looks like a lock and
           is not one: an async function executes synchronously up to its first
           `await`, so `drain` reaches `write()` while `inFlight` is STILL NULL.
           A `write` that called back into `flush()` would find the slot empty,
           start a second drain, and the two would overwrite each other's
           `finally`. Deferring the body by one microtask makes the assignment
           happen first, which is what the guard was supposed to mean. */
        inFlight = Promise.resolve()
          .then(drain)
          .finally(() => {
            inFlight = null
          })
      }
      await inFlight
    }
  }

  return {
    touch: () => {
      if (stopped) return
      cancelPending()
      handle = timers.setTimeout(() => {
        armed = false
        handle = null
        void kick()
      }, flushMs)
      armed = true
    },
    flush: async () => {
      cancelPending()
      /* NO-OP ONCE STOPPED, so "stops writing" means every path and not just
         the timer. The composition root flushes and never stops, so a shutdown
         still gets its tail; a stopped spool is one whose owner has gone. */
      if (stopped) return
      await kick()
    },
    stop: () => {
      stopped = true
      cancelPending()
    },
  }
}
