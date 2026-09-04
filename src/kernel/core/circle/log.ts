import { canonicalJson } from '../canonicalJson'
import { type Hlc } from '../hlc'

/**
 * The shared log — WI-22.C1 and WI-22.C2, and WI-23.B1's four kinds.
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
 * ## The book, not the passage — WI-23.B1
 *
 * `reading.md` §"Tier 1": the log gains what a reader thinks of the BOOK.
 * Three of the four are REGISTERS — the newest one wins — and one is a
 * publication like a passage:
 *
 * | `op` | Payload | Fold rule |
 * |---|---|---|
 * | `status` | `state` | last-writer per work |
 * | `rate` | `stars` | last-writer per work |
 * | `tag` | `tags` | last-writer per work |
 * | `review` / `unreview` | `text` / — | append, tombstone |
 *
 * ⚠️ **A REGISTER'S "NEWEST" IS BY HLC, NOT BY SEQUENCE.** Two of a person's
 * devices are two sequence streams (`mergeLogs` says why), so "the last
 * `status` entry" is meaningless across them; "the `status` entry with the
 * latest stamp" is not. `Entry.at` already exists for this.
 *
 * ⚠️ **`review` CARRIES NO PASSAGE AND `unreview` CARRIES NO TEXT**, for the
 * reason `unshare` carries none: a tombstone that repeats what it retracts
 * discloses the retracted thing to a peer who never saw it. A review is a
 * snapshot at publication; editing it is `unreview` + `review`, a new `pub`.
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

/** Where a reader is with a book — Douban's 想读 / 在读 / 读过. */
export type ReadingState = 'want' | 'reading' | 'finished'
export const READING_STATES: readonly ReadingState[] = ['want', 'reading', 'finished']

/** One to five, and nothing else. A `4.2` is what Douban says. */
export type Stars = 1 | 2 | 3 | 4 | 5
export const STARS: readonly Stars[] = [1, 2, 3, 4, 5]

/** What every entry carries: which stream it is in, where, and when. */
export interface Stamped {
  readonly device: string
  readonly seq: number
  readonly at: Hlc
}

/** One entry in one device's stream. */
export type Entry =
  | (Stamped & {
      readonly op: 'share'
      readonly pub: string
      readonly passage: Passage
    })
  | (Stamped & {
      readonly op: 'unshare'
      readonly pub: string
      /* ⚠️ NO `passage`. The type is what enforces the disclosure rule, not a
       * reviewer noticing. See the module header. */
    })
  | (Stamped & {
      readonly op: 'status'
      readonly state: ReadingState
    })
  | (Stamped & {
      readonly op: 'rate'
      readonly stars: Stars
    })
  | (Stamped & {
      readonly op: 'tag'
      readonly tags: readonly string[]
    })
  | (Stamped & {
      readonly op: 'review'
      readonly pub: string
      readonly text: string
    })
  | (Stamped & {
      readonly op: 'unreview'
      readonly pub: string
      /* ⚠️ NO `text`, for `unshare`'s reason. */
    })
  /* ── the shelf — WI-23.C1 ──────────────────────────────────────────────
   *
   * ⚠️ **ON A LOG OF ITS OWN, `(person, 'shelf')`, AND NEVER ON A PER-WORK
   * LOG.** The per-work log is asked for per work — `circle.pages` takes a
   * claim — and the whole point of a shelf is to learn about works the
   * recipient cannot name yet. So a `shelf` entry names its work IN CLEAR:
   * the claim's own inputs, not their digests. That is the disclosure the
   * per-person switch (WI-23.C2) exists to gate, and it is why these two ops
   * are served by `circle.shelf` under `SHELF_WORK` and nothing else. */
  | (Stamped & {
      readonly op: 'shelf'
      /** Minted per shelving; `unshelf` names it. */
      readonly pub: string
      readonly work: ShelvedWork
    })
  | (Stamped & {
      readonly op: 'unshelf'
      readonly pub: string
      /* ⚠️ NO `work`: a tombstone that repeated the title would disclose a
       * book to a peer who never saw it on the shelf. */
    })
  /* ── a list — WI-23.E1 ─────────────────────────────────────────────────
   *
   * ⚠️ **ON A LOG OF ITS OWN, `(person, listId)`, AND ON NOTHING ELSE.** A
   * list is a titled, ordered set of works with a note per item; it is not
   * per work, so it is not an entry on the per-work log, and it names works
   * the recipient may not have, so it needs the SHELF's disclosure rule —
   * served only to a person the shelf switch is on for. `foldList` in
   * `list.ts` folds these five; `fold` ignores them, because they never
   * reach it. */
  | (Stamped & {
      readonly op: 'create'
      readonly title: string
    })
  | (Stamped & {
      readonly op: 'retitle'
      readonly title: string
    })
  | (Stamped & {
      /** A work at a position, with a note. Re-placing the same `pub` moves it. */
      readonly op: 'place'
      readonly pub: string
      readonly work: ShelvedWork
      readonly position: number
      readonly note: string
    })
  | (Stamped & {
      readonly op: 'remove'
      readonly pub: string
      /* ⚠️ NO `work`, for `unshelf`'s reason. */
    })
  | (Stamped & {
      /** The whole list, for good. A new list is a new id. */
      readonly op: 'delete'
    })

/**
 * A work on a shelf, in clear — the claim's own inputs.
 *
 * `cover` is a digest the recipient may fetch under the blob path (WI-23.C5);
 * the cover's bytes never ride a page, which is a signed, canonical, bounded
 * frame a cover would fill four times over.
 */
export interface ShelvedWork {
  readonly title: string
  readonly author: string
  readonly identifier?: string
  /** BCP-47 primary subtag, or `''`. */
  readonly language: string
  readonly cover?: string
}

/** The ops that are registers: one value per work, the newest stamp wins. */
export const REGISTER_OPS = ['status', 'rate', 'tag'] as const

/** What a recipient believes about one publication after folding the log. */
export interface Held {
  readonly pub: string
  readonly passage: Passage
  /** When the share was made — for ordering a reader's list. */
  readonly at: Hlc
}

/** A review still out, as the recipient holds it. */
export interface HeldReview {
  readonly pub: string
  readonly text: string
  readonly at: Hlc
}

/** A register's current value, and the stamp that made it current. */
export interface Register<T> {
  readonly value: T
  readonly at: Hlc
}

/** A work still on the shelf, as the recipient holds it. */
export interface HeldWork {
  readonly pub: string
  readonly work: ShelvedWork
  readonly at: Hlc
  /** `(device, seq)` of the entry, kept so a duplicate `pub` folds by the earlier stamp — see `receive.ts`. Absent on rows written before it was kept. */
  readonly device?: string
  readonly seq?: number
  /** Which relationship epoch it arrived under — `ForeignEntry.epoch`'s reason: a re-admission must not revive it. Absent on rows written before it was kept, which read as the current epoch. */
  readonly epoch?: number
}

/** What a recipient believes about one log after folding it. */
export interface Folded {
  readonly shares: readonly Held[]
  readonly reviews: readonly HeldReview[]
  readonly status?: Register<ReadingState>
  readonly stars?: Register<Stars>
  readonly tags?: Register<readonly string[]>
  /** Only ever non-empty for the shelf log. */
  readonly shelf: readonly HeldWork[]
}

/**
 * Fold a log into what is currently shared, said and thought.
 *
 * ⚠️ **AN `unshare` FOR A `pub` NOT YET SEEN IS REMEMBERED, not dropped.**
 * Pages arrive out of order — the design says a recipient *"may receive page 7
 * before page 3"* — so a withdrawal can land before the publication it
 * withdraws. Dropping it would make the share reappear when page 3 arrived and
 * stay for ever, which is precisely the *"comes straight back"* failure
 * `Mark.deletedAt` exists to prevent, one level up. An `unreview` is held the
 * same way, for the same reason.
 *
 * ⚠️ **AND A LATER SHARE OF THE SAME `pub` DOES NOT RESURRECT IT.** A `pub` is
 * minted per share and never reused, so two entries naming one `pub` are a
 * duplicate delivery or a forgery, not a re-share. Re-sharing a passage mints a
 * NEW `pub`, which is exactly what makes `share, share, unshare` resolvable.
 *
 * ⚠️ **A REGISTER KEEPS THE NEWEST STAMP, whatever order the entries came.**
 * Equal stamps are one device stamping twice in one instant — an HLC carries
 * its node — so the tie falls to `(device, seq)`, the later sequence being that
 * device's later word. Stated so two recipients folding the same log agree.
 */
export function fold(entries: readonly Entry[]): Folded {
  const shares = new Map<string, Held & Stamped>()
  const withdrawn = new Set<string>()
  const reviews = new Map<string, HeldReview & Stamped>()
  const unreviewed = new Set<string>()
  const shelf = new Map<string, HeldWork & Stamped>()
  const unshelved = new Set<string>()
  let status: (Register<ReadingState> & Stamped) | undefined
  let stars: (Register<Stars> & Stamped) | undefined
  let tags: (Register<readonly string[]> & Stamped) | undefined

  for (const entry of resolved(entries)) {
    switch (entry.op) {
      case 'unshare':
        withdrawn.add(entry.pub)
        shares.delete(entry.pub)
        break
      case 'share': {
        if (withdrawn.has(entry.pub)) break
        const seen = shares.get(entry.pub)
        /* Duplicate delivery: keep ONE entry, whole — the one that stamps
           first, so a redelivery cannot quietly move a passage up the
           reader's list, and two replicas folding in different orders hold
           the same passage with the same words. */
        if (seen && !earlier(entry, seen)) break
        shares.set(entry.pub, { pub: entry.pub, passage: entry.passage, at: entry.at, device: entry.device, seq: entry.seq })
        break
      }
      case 'unreview':
        unreviewed.add(entry.pub)
        reviews.delete(entry.pub)
        break
      case 'review': {
        if (unreviewed.has(entry.pub)) break
        const seen = reviews.get(entry.pub)
        if (seen && !earlier(entry, seen)) break
        reviews.set(entry.pub, { pub: entry.pub, text: entry.text, at: entry.at, device: entry.device, seq: entry.seq })
        break
      }
      case 'unshelf':
        unshelved.add(entry.pub)
        shelf.delete(entry.pub)
        break
      case 'shelf': {
        if (unshelved.has(entry.pub)) break
        const seen = shelf.get(entry.pub)
        if (seen && !earlier(entry, seen)) break
        shelf.set(entry.pub, { pub: entry.pub, work: entry.work, at: entry.at, device: entry.device, seq: entry.seq })
        break
      }
      case 'status':
        if (newer(entry, status)) status = { value: entry.state, at: entry.at, device: entry.device, seq: entry.seq }
        break
      case 'rate':
        if (newer(entry, stars)) stars = { value: entry.stars, at: entry.at, device: entry.device, seq: entry.seq }
        break
      case 'tag':
        if (newer(entry, tags)) tags = { value: entry.tags, at: entry.at, device: entry.device, seq: entry.seq }
        break
      /* A list's entries are folded by `foldList`; a per-work or shelf log
         never carries one, and one that did says nothing here. */
      // Stryker disable all: five arms of one decision — the type names them so a new kind fails to compile.
      case 'create':
      case 'retitle':
      case 'place':
      case 'remove':
      case 'delete':
        break
      // Stryker restore all
      default:
        unhandled(entry)
    }
  }
  return {
    /* In LOG ORDER, not arrival order: a Map remembers insertion, and two
       replicas that received the pages differently would otherwise list the
       same passages differently. */
    shares: [...shares.values()].sort(compareEntries).map(({ device: _d, seq: _s, ...held }) => held),
    reviews: [...reviews.values()].sort(compareEntries).map(({ device: _d, seq: _s, ...held }) => held),
    shelf: [...shelf.values()].sort(compareEntries).map(({ device: _d, seq: _s, ...held }) => held),
    ...(status === undefined ? {} : { status: { value: status.value, at: status.at } }),
    ...(stars === undefined ? {} : { stars: { value: stars.value, at: stars.at } }),
    ...(tags === undefined ? {} : { tags: { value: tags.value, at: tags.at } }),
  }
}

/** Whether `entry` comes before `held` in log order — the earlier stamp, ties by `(device, seq)`. */
function earlier(entry: Stamped, held: Stamped): boolean {
  // Stryker disable next-line EqualityOperator: after `resolved()` two entries never share a stamp, so `<` and `<=` agree.
  return compareEntries(entry, held) < 0
}

/** Whether `entry` is a later word than the register `held` — by stamp, then `(device, seq)`. */
function newer(entry: Stamped, held: Stamped | undefined): boolean {
  // Stryker disable next-line EqualityOperator: as above — no two entries share a stamp.
  return held === undefined || compareEntries(entry, held) > 0
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
  return [...resolved([...a, ...b])].sort(compareEntries)
}

/**
 * The entries with every fork resolved — ONE ENTRY PER (device, seq), chosen
 * the way `mergeLogs` chooses, so a fold over a raw list and a fold over the
 * merged one hold the same passage with the same words.
 */
function resolved(entries: readonly Entry[]): readonly Entry[] {
  const byKey = new Map<string, Entry>()
  for (const entry of entries) {
    const key = `${entry.device}#${entry.seq}`
    const seen = byKey.get(key)
    /* ⚠️ **A FORK — one (device, seq), two different entries — IS RESOLVED
     * THE SAME WAY ON EVERY REPLICA.** An honest device never writes two
     * entries at one sequence, so a fork is a forgery or a corruption; what
     * matters is that two replicas merging the same two logs in either order
     * hold the same entry, or they diverge for ever. The canonical spelling
     * orders them, and the lesser is kept: arbitrary, and the same everywhere. */
    // Stryker disable next-line EqualityOperator: two entries spelled alike are one entry; keeping either is the same.
    if (seen === undefined || canonicalJson(entry) < canonicalJson(seen)) byKey.set(key, entry)
  }
  return [...byKey.values()]
}

/**
 * The arm no entry reaches: `Entry` is a closed union, so a new kind of entry
 * fails to compile here rather than falling silently through a switch.
 */
// Stryker disable next-line all: unreachable — the type is closed.
function unhandled(entry: never): never {
  throw new Error(`log: an entry of an unknown kind: ${JSON.stringify(entry)}`)
}

/** Log order: when it was said, then which device said it, then its sequence. */
export function compareEntries(a: Stamped, b: Stamped): number {
  // Stryker disable next-line EqualityOperator: under the inequality guard, `<=` is `<`.
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  // Stryker disable next-line EqualityOperator: as above.
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
    if (entry.device === device) highest = Math.max(highest, entry.seq)
  }
  /* `nextSeqFor` refuses the same overflow: past the safe range two numbers
     read alike, and the wire would refuse the page anyway. */
  if (highest >= Number.MAX_SAFE_INTEGER) throw new Error(`device ${device} has no sequence numbers left`)
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
 *
 * A register's history is retracted history too: only its NEWEST value is
 * served, and a review taken back is not. `phase-23` records that serving this
 * view needs a chain of its own, and that item is not yet written.
 */
export function compacted(raw: readonly Entry[], device: string): readonly Entry[] {
  /* Forks resolved first, as `fold` and `mergeLogs` resolve them, so the
     stream served does not depend on which side of a fork arrived first. */
  const entries = resolved(raw)
  const folded = fold(entries)
  const live = new Set(folded.shares.map((held) => held.pub))
  const liveReviews = new Set(folded.reviews.map((held) => held.pub))
  const liveShelf = new Set(folded.shelf.map((held) => held.pub))
  /* The ENTRY each register folded to — the same rule `fold` applies, so the
     one served is the one a recipient would have folded to anyway. */
  const winners = new Set<Entry>()
  for (const op of REGISTER_OPS) {
    let best: Entry | undefined
    for (const entry of entries) {
      if (entry.op === op && newer(entry, best)) best = entry
    }
    /* Stryker disable next-line ConditionalExpression: a register nobody set
       has no winner, and `has` matches no entry to `undefined`. The guard is
       for the type. */
    if (best !== undefined) winners.add(best)
  }
  /* The ENTRY each live publication folded to — the first in log order under
     its `pub` — so a duplicate or a forged twin does not survive compaction
     beside the one that was folded. */
  const chosen = new Set<Entry>()
  for (const op of ['share', 'review', 'shelf'] as const) {
    const first = new Map<string, Entry>()
    for (const entry of entries) {
      /* Stryker disable next-line EqualityOperator,ConditionalExpression: the three passes are symmetric — an entry skipped in its own pass is chosen in another, and the union is the same set. */
      if (entry.op !== op) continue
      const seen = first.get(entry.pub)
      if (seen === undefined || earlier(entry, seen)) first.set(entry.pub, entry)
    }
    for (const entry of first.values()) chosen.add(entry)
  }
  const kept = entries.filter((entry) => {
    switch (entry.op) {
      case 'share':
        return live.has(entry.pub) && chosen.has(entry)
      case 'review':
        return liveReviews.has(entry.pub) && chosen.has(entry)
      case 'shelf':
        return liveShelf.has(entry.pub) && chosen.has(entry)
      case 'status':
      case 'rate':
      case 'tag':
        return winners.has(entry)
      /* A tombstone that fell out of the switch would filter as `undefined`,
         which is `false` here. The cases are named so the switch is
         exhaustive and a new kind fails to compile rather than being served
         by default. */
      // Stryker disable all: see the note above — the arms are one decision the type checks.
      case 'unshare':
      case 'unreview':
      case 'unshelf':
        return false
      /* A list log is compacted by `compactedList`; these never reach here. */
      case 'create':
      case 'retitle':
      case 'place':
      case 'remove':
      case 'delete':
        return false
      // Stryker restore all
      // Stryker disable next-line all: `fold`, above, has already refused an entry of an unknown kind.
      default:
        return unhandled(entry)
    }
  })
  /* In LOG ORDER before renumbering, so two replicas holding the same entries
     in a different arrival order compact to the same stream. */
  return [...kept].sort(compareEntries).map((entry, i) => ({ ...entry, device, seq: i + 1 }))
}
