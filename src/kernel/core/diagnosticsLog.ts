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

export interface DiagnosticLogOptions {
  readonly capacity?: number
}

export function createDiagnosticLog({ capacity = DEFAULT_CAPACITY }: DiagnosticLogOptions = {}): DiagnosticLog {
  /* A capacity of zero would make `record` a no-op that still looks like a
     log, which is the shape of every silent-drop defect this repository has
     paid for. One is the floor: the last thing reported is always there. */
  const size = Math.max(1, Math.floor(capacity))
  let ring: DiagnosticEntry[] = []
  let lost = 0

  return {
    record: (entry) => {
      ring.push(entry)
      if (ring.length > size) {
        lost += ring.length - size
        ring = ring.slice(ring.length - size)
      }
    },
    entries: () => ring,
    dropped: () => lost,
    /* ONE OBJECT PER LINE, and a line that will not stringify is REPLACED
       rather than dropped. `fields` has been through `redact`, which walks and
       summarises, but a caller can still hand in something cyclic — and a
       single bad entry must not cost the whole window, which is the file the
       next person reads to find out what happened. */
    toJsonl: () =>
      ring
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
      ring = []
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
  let pending: unknown = null
  let writing = false
  let again = false
  let stopped = false

  const put = async (): Promise<void> => {
    if (writing) {
      /* COALESCED, NOT QUEUED — the same rule the sync scheduler follows. The
         file is the whole window every time, so a write that is waiting for
         another is a write of bytes that are already stale. */
      again = true
      return
    }
    writing = true
    try {
      do {
        again = false
        await write(log.toJsonl())
      } while (again && !stopped)
    } catch {
      /* A lost projection, not a second failure. The window is still in
         memory, and the next touch writes it. */
    } finally {
      writing = false
    }
  }

  return {
    touch: () => {
      if (stopped) return
      if (pending !== null) timers.clearTimeout(pending)
      pending = timers.setTimeout(() => {
        pending = null
        void put()
      }, flushMs)
    },
    flush: async () => {
      if (pending !== null) {
        timers.clearTimeout(pending)
        pending = null
      }
      await put()
    },
    stop: () => {
      stopped = true
      if (pending !== null) {
        timers.clearTimeout(pending)
        pending = null
      }
    },
  }
}
