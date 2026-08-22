/**
 * How a service handler refuses (phase 11, WI-11.3).
 *
 * The envelope answers a thrown value by copying THREE allow-listed fields
 * off it — `code`, `message`, `retryable` — and anything else becomes a bare
 * `internal`. So a refusal is a plain object with those three fields, and the
 * kernel builds it here rather than importing the transport's own helper: the
 * kernel imports nothing from a capability, and a handler that could only
 * refuse properly when the peer capability was composed would refuse
 * differently in the CLI, where it is not.
 *
 * The codes are the envelope's own vocabulary, spelled here so a caller
 * matches one set of strings whichever side answered. They are a SUBSET: the
 * envelope's `forbidden`, `duplicate-id`, `timeout`, `cancelled`,
 * `disconnected`, `frame-too-large`, `overloaded` and `unknown-service` are
 * the transport's to raise, and a handler that raised one of them would be
 * claiming something about a connection it cannot see.
 */

/** The three fields that cross the wire, and nothing else. */
export interface Refusal {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export const SERVICE_ERRORS = {
  /** The request body is not what the descriptor's input schema says. */
  malformed: 'malformed',
  /** The thing named is not here — a book id, a mark, a peer. */
  notFound: 'not-found',
  /** This host cannot answer: no transport, no journal, no filesystem. */
  unsupported: 'unsupported',
  /** The caller's precondition did not hold — the confirming count, a rev. */
  conflict: 'conflict',
  /** It could not be written. Retryable: the disk may be busy, not broken. */
  unwritable: 'unwritable',
  /**
   * The caller holds the grant and the act is still refused.
   *
   * Distinct from the router's grant check, which answers before a handler
   * runs: this is for a rule the SERVICE owns — a device may not rewrite its
   * own grants, and may not confer device management on another. Spelled
   * `forbidden` so it reaches a peer as the same code the envelope already
   * uses for an authorization refusal, rather than inventing a second word
   * for one idea.
   */
  forbidden: 'forbidden',
} as const

export type ServiceErrorCode = (typeof SERVICE_ERRORS)[keyof typeof SERVICE_ERRORS]

/** Build a refusal. `retryable` says whether the same call could work later. */
export function refuse(code: ServiceErrorCode, message: string, retryable = false): Refusal {
  return { code, message, retryable }
}

/** True when `value` is one of ours — for a caller catching across the seam. */
export function isRefusal(value: unknown): value is Refusal {
  if (typeof value !== 'object' || value === null) return false
  const one = value as Record<string, unknown>
  return typeof one['code'] === 'string' && typeof one['message'] === 'string' && typeof one['retryable'] === 'boolean'
}
