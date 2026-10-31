/**
 * The bound, before the read — WI-22.C3.
 *
 * `importLimits.ts` states the rule and names the failure to avoid:
 * *"The order is the point: a bound that runs AFTER the read has not bounded
 * anything."*
 *
 * ## Why the routing tuple is in cleartext
 *
 * ⚠️ `review.md`: *"`frame.rs:36` has already read the whole frame and
 * `envelope.ts:1013` parses the body before dispatch, so `work` is known only
 * after decoding."* Moving the check earlier in the same function cannot fix
 * that — the information the check needs is inside the thing it is supposed to
 * gate. So a `circle-page` frame is
 *
 * ```
 * { person: 64 hex chars, workDigest: 64 hex chars } ‖ signedBody
 * ```
 *
 * a fixed-size prefix, OUTSIDE the signature, carrying only what accounting
 * needs. The handler charges from the prefix and refuses without parsing.
 *
 * ⚠️ **THE PREFIX IS NOT TRUSTED FOR ANYTHING BUT ACCOUNTING.** It is unsigned,
 * so a peer can lie about it — and lying only mis-charges its own budget, while
 * the body's signature is what decides whose data this is. A prefix that were
 * load-bearing for identity would be a way to spend someone else's quota.
 *
 * ## Why the ledger is persisted
 *
 * ⚠️ *"Reconnecting resets the cap, so retained data grows as
 * `sessions × budget`."* A per-session budget is not a budget; it is a per-
 * session budget. So the ledger is keyed by PEER, survives the session, and is
 * the caller's to store — this module decides, it does not persist.
 *
 * PURE. No clock of its own: `now` is passed in, which is what lets the window
 * be tested without waiting for it.
 */

/** How much one peer may send, and over what window. */
export interface Budget {
  /** Bytes per peer per window, across every work. */
  readonly perPeer: number
  /** Bytes per `(peer, work)` per window. */
  readonly perWork: number
  /** Window length in milliseconds. */
  readonly windowMs: number
}

/**
 * Deliberately modest, and stated as a starting point rather than a measurement.
 *
 * A page is capped by the frame at just under 4 MiB, so `perWork` admits a
 * handful of full pages per work per day and `perPeer` a few dozen across a
 * library. A reader sharing passages from a book produces kilobytes; these
 * bound the case where somebody is not doing that.
 */
export const DEFAULT_BUDGET: Budget = {
  perPeer: 64 * 1024 * 1024,
  perWork: 16 * 1024 * 1024,
  windowMs: 24 * 60 * 60 * 1000,
}

/** What one peer has spent. The caller persists this; it is plain data. */
export interface Spend {
  /** When the current window opened. */
  readonly since: number
  readonly total: number
  /** Bytes per work digest. */
  readonly byWork: Readonly<Record<string, number>>
}

export const NOTHING_SPENT: Spend = { since: 0, total: 0, byWork: {} }

/** Length of each cleartext prefix field, in hex characters. */
const FIELD = 64
export const PREFIX_CHARS = FIELD * 2

export interface Routing {
  readonly person: string
  readonly workDigest: string
}

/**
 * The routing prefix, or null when the frame does not begin with one.
 *
 * ⚠️ **FIXED SIZE AND HEX-ONLY, so parsing it cannot itself be an attack.**
 * A length-prefixed or delimited prefix would mean reading a length a peer
 * chose before deciding whether to read anything — which is the shape this
 * whole module exists to refuse, reproduced in miniature.
 */
export function readRouting(frame: string): Routing | null {
  if (frame.length < PREFIX_CHARS) return null
  const person = frame.slice(0, FIELD)
  const workDigest = frame.slice(FIELD, PREFIX_CHARS)
  if (!/^[0-9a-f]{64}$/u.test(person) || !/^[0-9a-f]{64}$/u.test(workDigest)) return null
  return { person, workDigest }
}

export type Charge =
  | { readonly allowed: true; readonly spend: Spend }
  | { readonly allowed: false; readonly why: 'per-peer' | 'per-work' }

/**
 * Charge a frame against a peer's budget, before it is parsed.
 *
 * ⚠️ **THE WINDOW ROLLS; IT DOES NOT RESET ON CONNECT.** `since` is carried in
 * the persisted spend, so a peer that disconnects and returns resumes its
 * window. That is the entire fix for `sessions × budget`, and it is why this
 * takes the stored spend rather than starting from zero.
 *
 * A refusal costs one frame and no parse, which is the posture `envelope.ts`
 * already takes for bounded concurrency: refuse *"BEFORE a handler context
 * (controller, queue, timer, task) is built — so excess work costs a small
 * frame, not a live task."*
 */
export function charge(
  spend: Spend,
  work: string,
  bytes: number,
  now: number,
  budget: Budget = DEFAULT_BUDGET,
): Charge {
  /* A fresh window only when the old one has genuinely elapsed. `since === 0`
     is a peer that has never spent, which starts its window now. */
  const rolled = spend.since === 0 || now - spend.since >= budget.windowMs
  const base: Spend = rolled ? { since: now, total: 0, byWork: {} } : spend

  const total = base.total + bytes
  if (total > budget.perPeer) return { allowed: false, why: 'per-peer' }
  const forWork = (base.byWork[work] ?? 0) + bytes
  if (forWork > budget.perWork) return { allowed: false, why: 'per-work' }

  return {
    allowed: true,
    spend: { since: base.since, total, byWork: { ...base.byWork, [work]: forWork } },
  }
}

/**
 * A blocked person's budget — zero, and the ledger says so rather than the
 * caller remembering to check.
 *
 * `relationships.md` requires that *"a blocked person's leaf is refused … and
 * its budget is zero AND PERSISTED"*, so reconnection buys nothing. Expressing
 * it as a budget rather than as a branch means every path that charges is
 * covered, including ones written later.
 */
export const BLOCKED_BUDGET: Budget = { perPeer: 0, perWork: 0, windowMs: DEFAULT_BUDGET.windowMs }
