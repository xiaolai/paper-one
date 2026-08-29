import type { DiagnosticEntry } from './diagnosticsLog'
import type { Diagnostics } from './ports'
import { NOOP_DIAGNOSTICS } from './ports'

/**
 * `Diagnostics`, the working one — see the port in `ports.ts`.
 *
 * Local only. There is no backend and nothing here can reach one: a
 * `Diagnostics` writes to a `Sink`, and the two sinks that exist are the
 * console and nothing. What it adds over calling the console directly is the
 * scope on every line and the redaction below, which is applied BEFORE the
 * sink sees the fields — so a capability that logs an envelope by accident
 * logs an envelope with its body gone.
 */

export interface Sink {
  info(message: string, fields: Record<string, unknown>): void
  warn(message: string, fields: Record<string, unknown>): void
  error(message: string, fields: Record<string, unknown>): void
}

/**
 * The words that mark a field as not for the log.
 *
 * Matched as WORDS of the key, not as substrings and not only as the whole
 * key: `token`, `authToken`, `auth_token` and `peer-id` are all caught, and
 * `context` — which contains `text` — is not. A trailing-`s` plural counts as
 * its singular, so `secrets`, `tokens` and `keys` are caught too, WITHOUT
 * becoming a substring rule (`peerless` stems to `peerles`, not `peer`).
 * Secrets, peer identities, book text and envelope bodies are the four the
 * plan says never enter a log; the credential words below tend to travel with
 * them.
 */
export const REDACTED_WORDS: ReadonlySet<string> = new Set([
  'secret',
  'token',
  'key',
  'body',
  'text',
  'peer',
  'endpoint',
  'password',
  'credential',
  'authorization',
  'cookie',
  'bearer',
  'signature',
  'mac',
  'sas',
])

export const REDACTED = '[redacted]'

/** How deep a nested value is walked before it is summarised. */
const MAX_DEPTH = 8

/** `authToken` → `auth`, `token`; `peer_id` → `peer`, `id`; `Body` → `body`;
 *  and the acronym boundary too: `APIKey` → `api`, `key` — without the
 *  acronym-to-word split, every ALL-CAPS-led compound sailed past the list. */
function wordsOf(key: string): string[] {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
}

function isRedactedKey(key: string): boolean {
  return wordsOf(key).some(
    (word) =>
      REDACTED_WORDS.has(word) ||
      (word.endsWith('s') && REDACTED_WORDS.has(word.slice(0, -1))) ||
      /* `bodies` → `body`: the plain trailing-s rule left every -ies plural
       * of a listed word unredacted. */
      (word.endsWith('ies') && REDACTED_WORDS.has(`${word.slice(0, -3)}y`)),
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/**
 * The fields with every value under a redacted key replaced.
 *
 * Walks plain objects and arrays, however nested. An Error is reduced to its
 * type alone — its `message` and `stack` are exactly where book text or a
 * secret ends up when a throw is logged, which the plan forbids. A Date or
 * other primitive-like value passes through as it is. Depth is bounded so a
 * cyclic structure cannot hang the logger: past `MAX_DEPTH` a container
 * becomes `[deep]`.
 */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  return redactObject(fields, 0)
}

function redactObject(fields: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = isRedactedKey(key) ? REDACTED : redactValue(value, depth + 1)
  }
  return out
}

function redactValue(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    if (depth > MAX_DEPTH) return '[deep]'
    return value.map((one) => redactValue(one, depth + 1))
  }
  /* An Error's message and stack are unbounded, caller-shaped text — the very
   * place a secret or a line of a book leaks into a log. Keep only its type —
   * and only when the NAME is shaped like a type: `name` is an ordinary
   * mutable property, so a caller-set sentence (or a secret) could ride it
   * out otherwise. One identifier-shaped word ending in Error/Exception
   * carries a class name and nothing else. */
  if (value instanceof Error) {
    return /^[A-Za-z][A-Za-z0-9]{0,40}(Error|Exception)$/.test(value.name) ? `[${value.name}]` : '[Error]'
  }
  if (isPlainObject(value)) {
    if (depth > MAX_DEPTH) return '[deep]'
    return redactObject(value, depth)
  }
  /* A Date is a value — but a COPY of one: expando properties riding the
   * original would reach the sink otherwise. Any OTHER object — a Map, a
   * Set, a typed array, a class instance — is an opaque container this
   * walker cannot see into, so it is reduced to its constructor's name;
   * and that name is caller-mutable, so it passes the same shape gate an
   * Error's does or becomes the fixed marker. A function's source is a
   * body of text nobody meant to log. */
  if (value instanceof Date) return new Date(value.getTime())
  if (typeof value === 'function') return '[function]'
  if (typeof value === 'object' && value !== null) {
    let ctor: unknown
    try {
      ctor = (value as { constructor?: { name?: string } }).constructor?.name
    } catch {
      /* A proxy or accessor that throws on inspection earns the marker. */
      ctor = undefined
    }
    return typeof ctor === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(ctor) ? `[${ctor}]` : '[object]'
  }
  return value
}

export interface DiagnosticsOptions {
  /** Where lines go. Console by default. */
  readonly sink?: Sink
  /** Off means `NOOP_DIAGNOSTICS` — nothing is formatted, nothing is written. */
  readonly enabled?: boolean
  /** The top scope. `kernel` unless said otherwise. */
  readonly scope?: string
  /**
   * A second reader of every report, STRUCTURED — see `diagnosticsLog.ts`.
   *
   * The `sink` receives a formatted line because the console is a place a
   * person reads. This receives the scope, event and fields apart, because a
   * pane wants to filter by capability and a file wants to be greppable by
   * event. Both get the SAME redacted fields: redaction happens once, above
   * both, and neither can be given anything the other was not.
   *
   * Absent by default. A composition root that wants a window of what
   * happened passes one; nothing else changes.
   */
  readonly record?: (entry: DiagnosticEntry) => void
  /** Injectable so a test can assert the stamp rather than tolerate it. */
  readonly now?: () => number
}

/**
 * A `Diagnostics` writing to `sink`, or the no-op when disabled.
 *
 * Every line is `[paper:<scope>] <event>` followed by the redacted fields, so
 * a console filter on the scope shows one capability's lines and a filter on
 * `paper:` shows all of them.
 */
export function createDiagnostics({
  sink = console,
  enabled = true,
  scope = 'kernel',
  record,
  now = Date.now,
}: DiagnosticsOptions = {}): Diagnostics {
  if (!enabled) return NOOP_DIAGNOSTICS
  /* THE SINK IS GUARDED HERE, ONCE. A diagnostic is written from a catch
   * block more often than not — the store's failure path, a teardown, a
   * reporter's own reporter — and a sink that throws (a console replaced by
   * a test double, a bridge whose channel has closed) would turn the report
   * of one failure into a second, unhandled one at whichever of the ~fifty
   * call sites happened to be on the stack. The 2026-08-28 audit found the
   * guard missing at several of them; one guard at the factory covers every
   * caller, present and future, and a sink that fails is simply a diagnostic
   * that was lost — which is what a diagnostic is allowed to be. */
  /* DEEP, because a shallow freeze protects the wrong layer. `redact` bounds
     DEPTH but still returns objects and arrays, and the sink runs before the
     recorder — so a sink could reach one level in and change what the recorder
     was about to be handed, which is exactly the drift that redacting once
     exists to prevent. The walk is bounded by `MAX_DEPTH` above it, and a
     value that will not freeze is skipped rather than allowed to throw: this
     runs on the path that must never raise.

     ⚠️ **ONE RESIDUAL, NAMED RATHER THAN CLOSED. `Object.freeze` DOES NOT
     MAKE A `Date` IMMUTABLE** — its value lives in an internal slot, so
     `setTime()` still works on a frozen one. `redact` returns a fresh copy of
     a Date, and the sink runs before the recorder, so a sink that mutated a
     Date field would change what the recorder is then handed. Not closed here
     for a reason: the fix is for `redact` to return an ISO string instead, and
     that is a change to what every existing caller and its test see, decided
     on its own merits rather than at the end of an audit round. The exposure
     is a sink that calls a Date setter; the two sinks that exist are the
     console and this log. */
  const deepFreeze = (value: unknown, depth = 0): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return
    try {
      Object.freeze(value)
      for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, depth + 1)
    } catch {
      /* An exotic object that refuses to freeze is left as it is. */
    }
  }

  const quietly = (write: () => void | PromiseLike<void>): void => {
    try {
      const answered = write()
      /* AND A REJECTED PROMISE IS A THROW THAT ARRIVES LATE. TypeScript lets an
         `async` function satisfy a callback typed `void`, so a sink or recorder
         that is async turns a caught failure into an UNHANDLED rejection —
         which is the second failure this guard exists to prevent, only harder
         to trace back. Attached, never awaited: `Diagnostics` is synchronous
         and must stay so. */
      if (answered !== undefined && typeof (answered as PromiseLike<void>).then === 'function') {
        void (answered as PromiseLike<void>).then(undefined, () => {
          /* A lost diagnostic, as above. */
        })
      }
    } catch {
      /* A lost diagnostic, not a second failure. */
    }
  }
  const at = (name: string): Diagnostics => {
    const line = (event: string) => `[paper:${name}] ${event}`
    /* REDACTED ONCE, FOR BOTH. Calling `redact` per reader would let the two
       drift the moment one of them is given a different argument, and the
       file is the reader where that mistake lasts. `record` is guarded on its
       own so a failing recorder cannot cost the console its line — the same
       rule the sink already has, for the same reason. */
    const report = (level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>): void => {
      /* ⚠️ **REDACTION IS GUARDED TOO, and it was not.** `redact` walks the
         value it is given — `Object.entries`, property reads, prototype checks
         — so a getter that throws, a hostile proxy, or an `Error` subclass with
         an accessor for `name` makes REDACTION ITSELF throw, out of `info`,
         `warn` or `error`, past the `quietly` that only ever wrapped the sink
         call. A diagnostic is written from a catch block more often than not,
         so that is precisely the second failure this file promises never to
         cause. It was introduced when the two readers were factored into one
         `report`; before that, `redact` sat inside the guard by accident of
         being an argument.

         An event whose FIELDS cannot be read is still an event worth
         reporting, so this substitutes a marker rather than dropping the
         line. */
      let safe: Record<string, unknown>
      try {
        safe = redact(fields)
      } catch {
        safe = { note: 'fields could not be redacted' }
      }
      /* FROZEN, so the sink cannot rewrite what the recorder is about to be
         given. The two readers are handed one object on purpose — redacting
         twice is how they come to disagree — and that only holds if neither
         can change it. SHALLOW: `redact` summarises nested values but does
         return objects, so a nested value is still shared. The log takes its
         own copy on the way in, which is the second line of that defence. */
      deepFreeze(safe)
      quietly(() => sink[level](line(event), safe))
      if (record !== undefined) quietly(() => record({ at: now(), level, scope: name, event, fields: safe }))
    }
    return {
      child: (child) => at(`${name}.${child}`),
      info: (event, fields = {}) => report('info', event, fields),
      warn: (event, fields = {}) => report('warn', event, fields),
      error: (event, fields = {}) => report('error', event, fields),
    }
  }
  return at(scope)
}

/**
 * The default for a composition root: the console in a dev build, nothing in
 * a release build. `enabled` overrides either way, which is how a release
 * build gets diagnostics turned on deliberately rather than by default.
 */
export function defaultDiagnostics(enabled: boolean = import.meta.env.DEV): Diagnostics {
  return createDiagnostics({ enabled })
}
