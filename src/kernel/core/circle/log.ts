import { laterHlc, type Hlc } from '../hlc'

/**
 * The shared log — WI-22.C1 and WI-22.C2.
 *
 * Per `(person, work)`, append-only, tombstoned. **Sequenced per DEVICE**, and
 * merged across devices by HLC.
 *
 * ## No CFI crosses this
 *
 * ⚠️ The publisher's anchor is a path through *their* package and addresses
 * different words in the recipient's build — the defect the whole of phase 21
 * exists to remove, and shipping it into a social feature would reintroduce it
 * at scale. What travels is what `markContext` captures: the quote and the 32
 * characters either side. `Passage` below has no `cfi` field and cannot grow
 * one without the type changing under every caller.
 *
 * ## And no tint or style either
 *
 * ⚠️ `review.md`: they *"leak the reader's private colour vocabulary even when
 * the note is withheld"* — `Mark.tint` carries meaning the reader assigned
 * (*"agreements in green and questions in purple"*). And `surfaces.md`
 * independently forbids drawing a foreign mark in your own tints, so the
 * recipient was never going to use them. A field that must not be sent and must
 * not be used is a field that should not exist.
 *
 * ## Retraction has an identity
 *
 * A `share` mints a `pub`. An `unshare` names one. Without it,
 * `share(P), share(P), unshare(P)` is unresolvable — the review's own check —
 * and worse: a tombstone that repeated the quote in order to identify it would
 * disclose the withdrawn passage to a peer who had never seen the share.
 *
 * PURE. No storage, no clock, no crypto — the caller supplies ids and stamps,
 * which is what lets this be tested without any of them.
 */

/** What travels: the quote and its neighbours. Never an anchor. */
export interface Passage {
  readonly quote: string
  readonly prefix: string
  readonly suffix: string
  /** The reader's own words, when they chose to share them — see `withNote`. */
  readonly note?: string
  /** The TOC label at the time of marking, for a list that reads sensibly. */
  readonly chapter: string
}

/** One entry in one device's stream. */
export type Entry =
  | {
      readonly op: 'share'
      readonly pub: string
      readonly device: string
      readonly seq: number
      readonly at: Hlc
      readonly passage: Passage
    }
  | {
      readonly op: 'unshare'
      readonly pub: string
      readonly device: string
      readonly seq: number
      readonly at: Hlc
      /* ⚠️ NO `passage`. The type is what enforces the disclosure rule, not a
       * reviewer noticing. See the module header. */
    }

/** What a recipient believes about one publication after folding the log. */
export interface Held {
  readonly pub: string
  readonly passage: Passage
  /** When the share was made — for ordering a reader's list. */
  readonly at: Hlc
}

/**
 * Fold a log into what is currently shared.
 *
 * ⚠️ **AN `unshare` FOR A `pub` NOT YET SEEN IS REMEMBERED, not dropped.**
 * Pages arrive out of order — the design says a recipient *"may receive page 7
 * before page 3"* — so a withdrawal can land before the publication it
 * withdraws. Dropping it would make the share reappear when page 3 arrived and
 * stay for ever, which is precisely the *"comes straight back"* failure
 * `Mark.deletedAt` exists to prevent, one level up.
 *
 * ⚠️ **AND A LATER SHARE OF THE SAME `pub` DOES NOT RESURRECT IT.** A `pub` is
 * minted per share and never reused, so two entries naming one `pub` are a
 * duplicate delivery or a forgery, not a re-share. Re-sharing a passage mints a
 * NEW `pub`, which is exactly what makes `share, share, unshare` resolvable.
 */
export function fold(entries: readonly Entry[]): readonly Held[] {
  const shares = new Map<string, Held>()
  const withdrawn = new Set<string>()
  for (const entry of entries) {
    if (entry.op === 'unshare') {
      withdrawn.add(entry.pub)
      shares.delete(entry.pub)
      continue
    }
    if (withdrawn.has(entry.pub)) continue
    const seen = shares.get(entry.pub)
    /* Duplicate delivery: keep one, and keep the EARLIER stamp so a redelivery
       cannot quietly move a passage up the reader's list. */
    if (seen) {
      shares.set(entry.pub, { ...seen, at: laterHlc(seen.at, entry.at) === seen.at ? entry.at : seen.at })
      continue
    }
    shares.set(entry.pub, { pub: entry.pub, passage: entry.passage, at: entry.at })
  }
  return [...shares.values()]
}

/**
 * Merge two logs of one `(person, work)`.
 *
 * ⚠️ **BY `(device, seq)`, WHICH IS WHY THERE IS NO PUBLISHER ELECTION.**
 * `review.md`: *"two desktops at seq 10, disconnect, publish on both — both
 * mint seq 11 and both pages verify, because there is no previous-page hash or
 * signed log head."* Putting the device in the key makes that two streams
 * rather than one collision, and electing a publisher would need a quorum
 * protocol, a failover story and an answer for the split brain — for a problem
 * that disappears when the key is right.
 *
 * Ordered by HLC so a reader's list is in the order things were said, across
 * every device, with `(device, seq)` as the tiebreak — an HLC already carries a
 * node id, so a tie here means one device stamped twice at one instant.
 */
export function mergeLogs(a: readonly Entry[], b: readonly Entry[]): readonly Entry[] {
  const byKey = new Map<string, Entry>()
  for (const entry of [...a, ...b]) byKey.set(`${entry.device}#${entry.seq}`, entry)
  return [...byKey.values()].sort(compareEntries)
}

/** Log order: when it was said, then which device said it, then its sequence. */
export function compareEntries(a: Entry, b: Entry): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  if (a.device !== b.device) return a.device < b.device ? -1 : 1
  return a.seq - b.seq
}

/**
 * The next sequence number for one device's stream.
 *
 * Per device, so two desktops never contend. A gap is detectable because the
 * page chain carries `prevPageHash`; this only has to not reuse a number.
 */
export function nextSeq(entries: readonly Entry[], device: string): number {
  let highest = 0
  for (const entry of entries) {
    if (entry.device === device && entry.seq > highest) highest = entry.seq
  }
  return highest + 1
}

/**
 * What a NEW subscriber is served — the compacted view, not the raw log.
 *
 * ⚠️ **`review.md`'s audience-epoch finding.** A peer catching up from nothing
 * must not be able to pull withdrawn history: the raw log contains every
 * passage ever shared, including the ones taken back, and serving it to someone
 * admitted last week hands them everything the publisher has ever retracted.
 *
 * The raw log is served only from a point a peer has already acknowledged —
 * where the tombstones it is about to receive are ones it needs in order to
 * drop what it already holds.
 */
export function compacted(entries: readonly Entry[], device: string): readonly Entry[] {
  const live = new Set(fold(entries).map((held) => held.pub))
  return entries
    .filter((entry): entry is Extract<Entry, { op: 'share' }> => entry.op === 'share' && live.has(entry.pub))
    .map((entry, i) => ({ ...entry, device, seq: i + 1 }))
}
