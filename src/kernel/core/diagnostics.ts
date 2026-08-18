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
 * `context` — which contains `text` — is not. Secrets, peer identities, book
 * text and envelope bodies are the four things the plan says never enter a
 * log; `key` and `endpoint` are the two more that tend to travel with them.
 */
export const REDACTED_WORDS: ReadonlySet<string> = new Set([
  'secret',
  'token',
  'key',
  'body',
  'text',
  'peer',
  'endpoint',
])

export const REDACTED = '[redacted]'

/** How deep a nested value is walked before it is summarised. */
const MAX_DEPTH = 8

/** `authToken` → `auth`, `token`; `peer_id` → `peer`, `id`; `Body` → `body`. */
function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
}

function isRedactedKey(key: string): boolean {
  return wordsOf(key).some((word) => REDACTED_WORDS.has(word))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/**
 * The fields with every value under a redacted key replaced.
 *
 * Walks plain objects and arrays, however nested; anything else — an Error,
 * a Date, a class instance — passes through as it is, because it is a value
 * and not a container of keyed fields. Depth is bounded so a cyclic structure
 * cannot hang the logger: past `MAX_DEPTH` a container becomes `[deep]`.
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
  if (isPlainObject(value)) {
    if (depth > MAX_DEPTH) return '[deep]'
    return redactObject(value, depth)
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
}: DiagnosticsOptions = {}): Diagnostics {
  if (!enabled) return NOOP_DIAGNOSTICS
  const at = (name: string): Diagnostics => {
    const line = (event: string) => `[paper:${name}] ${event}`
    return {
      child: (child) => at(`${name}.${child}`),
      info: (event, fields = {}) => sink.info(line(event), redact(fields)),
      warn: (event, fields = {}) => sink.warn(line(event), redact(fields)),
      error: (event, fields = {}) => sink.error(line(event), redact(fields)),
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
