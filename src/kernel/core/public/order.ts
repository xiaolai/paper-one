import type { PublicEnvelope } from './envelope'

/**
 * The public layer's own ordering — WI-26.1.
 *
 * ## Why the circle's clock could not be reused
 *
 * ⚠️ **A SEPARATE SIGNING KEY STRIPS NEITHER IDENTIFIER.** Two travel on a
 * circle page and both had to go: `page.device` is the endpoint public key, and
 * the suffix of every HLC stamp is a separate random 16-hex id from
 * `ensureDeviceId`, bound in as the kernel clock by `services.bindClock`.
 * `monotonicClock()`'s `ZERO_DEVICE` is only the FALLBACK — reading the default
 * and not asking who binds it is the same mistake as trusting a green check
 * without asking whether the step ran.
 *
 * ⚠️ **AND THE STAMP CANNOT SIMPLY BE EMPTIED.** Measured against `hlc.ts` by
 * executing it:
 *
 * | Proposed stamp | Result |
 * |---|---|
 * | No device suffix | `isHlc` rejects; `parseHlc` throws |
 * | Literal `"0"` | `makeHlc` rejects |
 * | Sixteen zeroes | Valid, but `createClock` refuses it as a clock identity, and `hlcOf` yields EQUAL stamps for repeated same-millisecond events |
 * | The 64-hex voice key | `makeHlc` rejects — the field is 16 hex |
 *
 * So this layer defines its own: a per-voice sequence, durable across
 * restarts, with the rules below stated rather than inherited.
 *
 * ## "One voice, so no merging" is FALSE
 *
 * ⚠️ One author can sign conflicting revisions, or restart with a lost counter;
 * two recipients can then receive the same objects from different providers
 * **in opposite orders**. Reusing the circle's folds would keep their
 * dependencies — `compareEntries` breaks equal-stamp ties on entry `device` and
 * `seq`, and `resolved` reconciles conflicts sharing that pair — and neither
 * field exists here.
 *
 * ## The three rules, stated
 *
 * | Case | Rule |
 * |---|---|
 * | **Duplicate delivery** — one voice, one `seq`, the same bytes | kept once |
 * | **Equivocation** — one voice, one `seq`, DIFFERENT bytes | both dropped, and the `(voice, seq)` remembered so a later redelivery of either does not revive it |
 * | **Withdrawal precedence** | an `unnote` beats its `note` whatever their sequence numbers and whatever order they arrive |
 *
 * ⚠️ **EQUIVOCATION DROPS BOTH, AND THE LIMITS OF THAT ARE STATED RATHER THAN
 * HIDDEN.** Two of them:
 *
 *  - A replica that only ever saw one of the two keeps it. You cannot detect an
 *    equivocation you were never shown.
 *  - Detection reads `kept`, which retains every accepted envelope until its
 *    suppression horizon passes — so a pair split across two folds IS seen
 *    while both sides are still retained. What it cannot see is a pair whose
 *    first side has EXPIRED and been pruned: bounding that would mean
 *    remembering every sequence a voice has ever used, which is the unbounded
 *    store WI-26.3 exists to avoid. The limit is the retention horizon, not the
 *    fold boundary.
 *
 *    (This said detection read `held`, which it has not done since `kept`
 *    became what is persisted — a stale account of a limitation now narrower
 *    than it claimed. Found by audit.)
 *
 * What the rule does buy is that a replica which HAS seen both, in one fold or
 * across folds with both still live, reaches the same answer as any other in
 * either delivery order — and that only the voice's own key holder can cause
 * it, so it is not a denial vector somebody else can aim.
 *
 * ⚠️ **AND WITHDRAWAL BEATS PUBLICATION BY SEQUENCE-FREE RULE**, deliberately.
 * Ordering the two by `seq` would let a voice that lost its counter across a
 * restart re-publish at a lower sequence and un-withdraw something a reader
 * had taken back. A reader taking their words back must not be defeated by
 * delivery order OR by the publisher's own bookkeeping.
 *
 * PURE. No storage, no clock, no crypto: what arrives here has already been
 * verified by `checkPublicEnvelope`, and the caller supplies the held state.
 */

/** One publication, as this device holds it after the fold. */
export interface PublicHeld {
  /** The canonical bytes that were signed — see `readPublicEnvelope`. */
  readonly received: string
  readonly voice: string
  readonly pub: string
  readonly seq: number
  readonly at: number
  readonly expires: number
}

/** One accepted envelope, as this device keeps it. */
export interface KeptEnvelope {
  /** The canonical bytes that were signed. Verbatim, always. */
  readonly received: string
  readonly voice: string
  readonly pub: string
  readonly seq: number
  readonly at: number
  readonly expires: number
  readonly op: 'note' | 'unnote'
}

/** Everything one book's public annotations amount to on this device. */
export interface PublicFile {
  /**
   * Every accepted envelope, unexpired — INCLUDING withdrawals and both sides
   * of an equivocation.
   *
   * ⚠️ **THIS IS WHAT IS PERSISTED, AND WITHOUT IT A RELOAD FORGOT EVERY
   * WITHDRAWAL.** The store used to write only the live notes, so `withdrawn`
   * and `equivocated` — the two things WI-26.3 is about — died with the
   * process, and replaying a withdrawn note brought it straight back. Storing
   * the derived sets instead would mean storing UNSIGNED state beside signed
   * bytes, which is finding #3 wearing a third hat.
   *
   * So the evidence IS the envelopes. A withdrawal is a signed envelope; keep
   * it and the fold re-derives the suppression. An equivocation is two signed
   * envelopes at one sequence; keep both and the fold re-derives that too.
   * Nothing unsigned is stored and nothing has to be trusted on the way back
   * in — every line goes through `readPublicEnvelope` again.
   */
  readonly kept: readonly KeptEnvelope[]
  /** Live publications, in the order `compare` puts them. */
  readonly held: readonly PublicHeld[]
  /**
   * `<voice>#<pub>` for every publication withdrawn, until it would have
   * expired anyway.
   *
   * ⚠️ **BOUNDED BY THE EXPIRY, WHICH IS WHY THE EXPIRY IS SIGNED.** The circle
   * remembers a withdrawal for ever (`ForeignFile.withdrawn` says so
   * explicitly), which was reasonable for admitted humans. Public keys and
   * publication ids are unlimited, so an unbounded set is a store an attacker
   * chooses the size of. Each entry carries the moment it may be forgotten.
   */
  readonly withdrawn: readonly PublicWithdrawal[]
  /**
   * `<voice>#<seq>` for every sequence a voice has equivocated at.
   *
   * Bounded the same way: an equivocation is forgettable once every envelope
   * that could have carried it has expired.
   */
  readonly equivocated: readonly PublicWithdrawal[]
}

/** One suppression record and the moment it may be forgotten. */
export interface PublicWithdrawal {
  readonly key: string
  /** Epoch milliseconds. Past this, no valid envelope can revive the thing. */
  readonly until: number
}

export const EMPTY_PUBLIC_FILE: PublicFile = { kept: [], held: [], withdrawn: [], equivocated: [] }

/** `<voice>#<pub>` — a publication is unique to the voice that minted it. */
export function publicationKey(voice: string, pub: string): string {
  return `${voice}#${pub}`
}

/** `<voice>#<seq>` — one point in one voice's own stream. */
export function sequenceKey(voice: string, seq: number): string {
  return `${voice}#${seq}`
}

/**
 * Display order: when the voice says it published, then the voice, then its
 * sequence.
 *
 * ⚠️ **`at` IS THE PUBLISHER'S OWN CLOCK AND IS NOT EVIDENCE OF ANYTHING.** It
 * decides the order a reader sees a list in, and nothing else — no fold reads
 * it, no suppression depends on it, and a voice that lies about it gains a
 * position in a list. The tiebreaks are what make the order TOTAL and identical
 * on every replica, which is the property that actually matters.
 */
export function comparePublic(a: PublicHeld, b: PublicHeld): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  if (a.voice !== b.voice) return a.voice < b.voice ? -1 : 1
  return a.seq - b.seq
}

/** One verified envelope with the bytes it was verified as. */
export interface Delivered {
  readonly envelope: PublicEnvelope
  readonly received: string
}

/**
 * Fold verified envelopes into what this device holds.
 *
 * `now` drops suppression records that have outlived everything they could
 * suppress, and drops held publications that have expired. Both are the same
 * decision — an envelope is valid until its signed `expires` — applied to the
 * two sides of the file.
 */
export function foldPublic(held: PublicFile, arriving: readonly Delivered[], now: number): PublicFile {
  /* ⚠️ **EXPIRED STATE IS PRUNED BEFORE ANYTHING IS EVALUATED, AND IT USED TO
     BE PRUNED AFTER.** An expired withdrawal suppressed an arriving note on
     the first fold and permitted the same note if an empty fold had run
     first — so whether a publication appeared depended on how many times the
     caller had folded, which is not a rule. */
  /* ⚠️ **SUPPRESSION IS DERIVED FROM THE ENVELOPES, NOT CARRIED FORWARD.** This
     seeded itself from the previous fold's `withdrawn` map — before conflicts
     were known — so a withdrawal whose own sequence turned out to be
     EQUIVOCATED went on suppressing anyway: the cached entry outlived the
     evidence that justified it, and no later fold could take it back. The
     module's own rule is that the evidence IS the envelopes (`kept` exists for
     exactly this), and `forgetAt` below keeps an `unnote` alive as long as
     anything it suppresses. So it is recomputed every fold from what survives
     the conflict pass, and there is nothing left to invalidate. Found by audit.

     ⚠️ **EQUIVOCATION IS STILL CARRIED, AND THE ASYMMETRY IS THE POINT.** A
     conflict is detected by seeing TWO spellings of one sequence; once either
     side expires and is pruned it is no longer detectable at all, so forgetting
     the record would let the survivor revive. A withdrawal needs no such
     memory: the `unnote` itself is retained while it matters. */
  const withdrawn = new Map<string, number>()
  const equivocated = new Map(held.equivocated.filter((one) => one.until > now).map((one) => [one.key, one.until]))

  /* Everything this device has accepted, plus what has just arrived. Held
     envelopes come back through the same path as new ones, so a reload and a
     live delivery reach the same state. */
  const candidates: KeptEnvelope[] = [...held.kept, ...arriving.map(keptOf)]
  /* ⚠️ **A WITHDRAWAL MUST OUTLIVE THE NOTE IT SUPPRESSES, AND PRUNING IT BY
     ITS OWN EXPIRY DID NOT.** The derived `withdrawn` map below already takes
     the later of the two (see the note there) — but that map is DERIVED, and
     deliberately not stored: what persists is `kept`, the signed envelopes. So
     an `unnote` with a shorter lifetime than the note it took back was dropped
     from `kept` while the note was still live, and the next load had no
     evidence left to re-derive the suppression from. The withdrawn note came
     back. Reproduced by audit.
       Bounded exactly as WI-26.3 requires: the horizon is the later of two
     SIGNED expiries, so it is still a number the publisher chose and still
     inside `MAX_LIFETIME_MS`. Nothing is retained on the strength of anything
     unsigned. */
  /* ⚠️ **FROM WHAT IS ALREADY HELD, NEVER FROM WHAT IS ARRIVING.** Taking
     arriving notes into the horizon makes a withdrawal's retention extendable
     by anyone who publishes under the same id again — each new note pushes the
     forget-point out, and the suppression state stops being bounded, which is
     the exact property WI-26.3 exists to guarantee. It also contradicts the
     rule directly below: once a withdrawal has expired, a note may use that id
     again. What a withdrawal must outlive is the note it is ALREADY
     suppressing, and that note is by definition one this device already holds. */
  const noteExpiry = new Map<string, number>()
  for (const one of held.kept) {
    if (one.op !== 'note') continue
    const key = publicationKey(one.voice, one.pub)
    noteExpiry.set(key, Math.max(one.expires, noteExpiry.get(key) ?? 0))
  }
  const forgetAt = (one: KeptEnvelope): number =>
    one.op === 'unnote'
      ? Math.max(one.expires, noteExpiry.get(publicationKey(one.voice, one.pub)) ?? 0)
      : one.expires
  const all: KeptEnvelope[] = candidates.filter((one) => forgetAt(one) > now)

  /* ── pass one: WHO EQUIVOCATED ────────────────────────────────────────
   *
   * ⚠️ **CONFLICTS ARE RESOLVED BEFORE ANY EFFECT IS APPLIED, AND THEY USED TO
   * BE RESOLVED AS THEY ARRIVED.** Measured: `[note(p,1), unnote(p,2),
   * note(q,2)]` withdrew `p`, and swapping the last two left `p` visible —
   * because in one order the withdrawal took effect before its own sequence
   * was found to be equivocated, and in the other it never took effect at all.
   * Detecting an equivocation removes the publications; it cannot undo an
   * effect already applied. So nothing is applied until every conflict is
   * known. */
  /* ⚠️ **THE HORIZON IS ACCUMULATED IN THE SAME PASS THAT GROUPS.** It used to
     re-scan every envelope for each conflicting sequence — quadratic over a
     count an attacker chooses, synchronously, on the reader's thread, and worst
     exactly when a voice is equivocating hardest. One pass carries both. */
  const bytesAt = new Map<string, { spellings: Set<string>; until: number }>()
  for (const one of all) {
    const key = sequenceKey(one.voice, one.seq)
    const held = bytesAt.get(key)
    if (held === undefined) {
      bytesAt.set(key, { spellings: new Set([one.received]), until: one.expires })
      continue
    }
    held.spellings.add(one.received)
    held.until = Math.max(held.until, one.expires)
  }
  for (const [key, seen] of bytesAt) {
    if (seen.spellings.size < 2) continue
    /* Remembered until the LAST of the conflicting envelopes would have
       expired anyway — after that no valid envelope can carry the sequence
       and the record is dead weight. */
    equivocated.set(key, Math.max(seen.until, equivocated.get(key) ?? 0))
  }
  const honest = all.filter((one) => !equivocated.has(sequenceKey(one.voice, one.seq)))

  /* ── pass two: WHAT WAS TAKEN BACK ────────────────────────────────────
   *
   * Withdrawals first, and all of them, so a publication's fate does not
   * depend on whether its withdrawal happened to be earlier in the list. */
  for (const one of honest) {
    if (one.op !== 'unnote') continue
    const key = publicationKey(one.voice, one.pub)
    withdrawn.set(key, Math.max(one.expires, withdrawn.get(key) ?? 0))
  }
  /* ⚠️ **AND THE SUPPRESSION OUTLIVES THE NOTE, NOT ONLY THE WITHDRAWAL.** A
     short-lived `unnote` for a long-lived `note` used to be forgotten while
     the note was still valid, so the note came back — the exact replay
     WI-26.3 exists to prevent, arriving through the expiry rather than around
     it. Every note this device has seen for a withdrawn publication extends
     its suppression to cover itself. */
  for (const one of honest) {
    if (one.op !== 'note') continue
    const key = publicationKey(one.voice, one.pub)
    const until = withdrawn.get(key)
    if (until !== undefined) withdrawn.set(key, Math.max(until, one.expires))
  }

  /* ── pass three: WHAT IS LIVE ─────────────────────────────────────────── */
  const byPub = new Map<string, PublicHeld>()
  for (const one of honest) {
    if (one.op !== 'note') continue
    const key = publicationKey(one.voice, one.pub)
    if (withdrawn.has(key)) continue
    const standing = byPub.get(key)
    /* On a duplicate `pub` from one voice the EARLIER sequence stands, so a
       redelivery cannot quietly move a passage up the reader's list and two
       replicas folding in different orders hold the same words. */
    if (standing !== undefined && standing.seq <= one.seq) continue
    byPub.set(key, {
      received: one.received,
      voice: one.voice,
      pub: one.pub,
      seq: one.seq,
      at: one.at,
      expires: one.expires,
    })
  }

  return {
    /* ⚠️ **EVERY ACCEPTED ENVELOPE IS KEPT, INCLUDING THE EQUIVOCATING PAIRS.**
       Drop one side and the next reload sees a single envelope at that
       sequence, finds no conflict, and hands the reader something this device
       had already decided was equivocation. The evidence has to survive with
       the decision. Sorted so two devices holding the same set write the same
       bytes. */
    kept: dedupe(all).sort(byKept),
    held: [...byPub.values()].sort(comparePublic),
    withdrawn: [...withdrawn].map(([key, until]) => ({ key, until })).sort(byKey),
    equivocated: [...equivocated].map(([key, until]) => ({ key, until })).sort(byKey),
  }
}

/** One `KeptEnvelope` per distinct line. */
function dedupe(all: readonly KeptEnvelope[]): KeptEnvelope[] {
  const seen = new Map<string, KeptEnvelope>()
  for (const one of all) if (!seen.has(one.received)) seen.set(one.received, one)
  return [...seen.values()]
}

/** A stable order for what is written to disk. */
const byKept = (a: KeptEnvelope, b: KeptEnvelope): number => {
  if (a.voice !== b.voice) return a.voice < b.voice ? -1 : 1
  if (a.seq !== b.seq) return a.seq - b.seq
  return a.received < b.received ? -1 : a.received > b.received ? 1 : 0
}

/** What a verified delivery is kept as. */
function keptOf({ envelope, received }: Delivered): KeptEnvelope {
  return {
    received,
    voice: envelope.voice,
    pub: envelope.pub,
    seq: envelope.seq,
    at: envelope.at,
    expires: envelope.expires,
    op: envelope.op,
  }
}

const byKey = (a: PublicWithdrawal, b: PublicWithdrawal): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
