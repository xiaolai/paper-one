/**
 * The pure merge — the same functions run by the shelf merging a pushed row,
 * the satchel applying a pulled row, and the satchel applying an ack. An ack
 * is MERGED, never assigned, which is why these have to be a semilattice:
 * commutative, associative, idempotent, so that any delivery order and any
 * amount of redelivery converge on one state. The property tests in
 * `merge.test.ts` are the enforcement.
 *
 * `BookRecord` merges as REGISTER GROUPS, each group owned by one stamp and
 * taken WHOLE from whichever side stamps it later:
 *
 *   position + progress        by `positionAt`
 *   finished                   by `finishedAt`
 *   each tag                   by its `tagClock` register (per key)
 *   the book's own metadata    by `parsedAt` (a number — the parse's clock)
 *   addedAt                    min — when the book FIRST arrived anywhere
 *   openedAt                   max — when it was last opened anywhere
 *
 * Records from before the ledger carry no stamps. A missing group stamp is
 * the EPOCH (`hlcOf(0)`), a constant — deliberately not derived from any
 * field outside the group, because a stamp that moved when a neighbouring
 * field merged would break associativity. Legacy tags are synthesised into
 * clock registers at `hlcOf(addedAt)` — the documented legacy derivation —
 * so one register mechanism serves both eras. Remaining ties (two legacy
 * replicas that diverged before stamps existed) fall to the canonical
 * serialisation of the group: arbitrary, but the SAME arbitrary everywhere,
 * which is what convergence needs. A present group beats an absent one at
 * any stamp — absence is "never set", not "set to nothing".
 *
 * Inputs are expected in `parseRecord` shape (tags coherent with the clock
 * when one exists) — which is the only shape a record ever arrives in, off
 * disk or off the wire (`fromWire` re-validates).
 *
 * `mergeStranded` (kernel, trash rescue) is NOT re-expressed over this: its
 * "live side wins" is deliberately asymmetric — the live record is known to
 * be the one the reader kept using — and a commutative merge cannot say
 * that. It reconciles two LOCAL histories with a known winner; this merges
 * REPLICAS with none.
 */

import {
  DEVICE_LOCAL_FIELDS,
  hlcOf,
  parseRecord,
  tagRegisters,
  tagsFromClock,
  mergeCards as mergeCardsInKernel,
  mergeMarks as mergeMarksInKernel,
  cardStamp,
  markStamp,
  type BookRecord,
  type Card,
  type Mark,
  type TagClockEntry,
} from '../../../kernel'

/* ------------------------------------------------------------- canonical */

/** A value with every object's keys sorted, recursively — one serialisation
 *  for one meaning, whatever order a map was built in. */
function sortedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedDeep)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = sortedDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** Canonical JSON: sorted keys at every depth. The tie-breaker and the
 *  digests both read THIS, never `JSON.stringify` raw. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedDeep(value))
}

/* ------------------------------------------------------------ the record */

/** The later-stamped side, ties to the larger canonical serialisation. */
function pick<T>(atA: string, a: T, atB: string, b: T): T {
  if (atA < atB) return b
  if (atA > atB) return a
  return canonicalJson(a) < canonicalJson(b) ? b : a
}

const EPOCH = hlcOf(0)

/* The tag-register derivation (`tagRegisters`) is a KERNEL export now: the
 * Library's own tag writers stamp registers too (WI-C), and the synthesis of
 * legacy tags at `hlcOf(addedAt)` has to be one body or the two would drift. */

/** One register group: the fields that travel together, and their stamp. */
interface Group {
  readonly at: string
  readonly value: Partial<BookRecord>
}

const positionGroup = (r: BookRecord): Group | null =>
  r.position == null && r.progress === undefined
    ? null
    : {
        at: r.positionAt ?? EPOCH,
        value: {
          ...(r.position != null ? { position: r.position } : {}),
          ...(r.progress === undefined ? {} : { progress: r.progress }),
          ...(r.positionAt ? { positionAt: r.positionAt } : {}),
        },
      }

const finishedGroup = (r: BookRecord): Group | null =>
  r.finished === undefined
    ? null
    : {
        at: r.finishedAt ?? EPOCH,
        value: { finished: r.finished, ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}) },
      }

const metadataGroup = (r: BookRecord): Group => ({
  // The parse's own clock is a number; absent means never parsed and loses
  // to any parse. Padded to a fixed width so string order is numeric order.
  at: (r.parsedAt ?? -1).toString().padStart(16, '0'),
  value: {
    title: r.title,
    author: r.author,
    ...(r.sortAs ? { sortAs: r.sortAs } : {}),
    ...(r.series ? { series: r.series } : {}),
    ...(r.seriesIndex === undefined ? {} : { seriesIndex: r.seriesIndex }),
    ...(r.publisher ? { publisher: r.publisher } : {}),
    ...(r.published ? { published: r.published } : {}),
    ...(r.languages ? { languages: r.languages } : {}),
    ...(r.subjects ? { subjects: r.subjects } : {}),
    ...(r.parsedAt === undefined ? {} : { parsedAt: r.parsedAt }),
  },
})

/** A group merge where an absent side always loses: absence is "never set". */
const mergeGroup = (a: Group | null, b: Group | null): Partial<BookRecord> =>
  a === null ? (b === null ? {} : b.value) : b === null ? a.value : pick(a.at, a.value, b.at, b.value)

/** A scalar with no stamp of its own: present beats absent, and two present
 *  values tie to the larger — content facts and device-local names, which
 *  agree on every honest pair of replicas anyway. */
function scalar<T>(a: T | undefined, b: T | undefined): T | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return canonicalJson(a) < canonicalJson(b) ? b : a
}

/**
 * Merge two replicas of one book's record. Pure, and a semilattice — see the
 * module note for the register groups and the legacy rules.
 */
export function mergeRecord(a: BookRecord, b: BookRecord): BookRecord {
  /* The tag registers: per-key LWW over both sides' clocks (synthesised for
   * a legacy side), keys sorted so the output is canonical. */
  const clockA = tagRegisters(a)
  const clockB = tagRegisters(b)
  let tags: Pick<BookRecord, 'tags' | 'tagClock'> = {}
  if (clockA || clockB) {
    const merged: Record<string, TagClockEntry> = {}
    const keys = [...new Set([...Object.keys(clockA ?? {}), ...Object.keys(clockB ?? {})])].sort()
    for (const key of keys) {
      const mine = clockA?.[key]
      const theirs = clockB?.[key]
      merged[key] = mine === undefined ? theirs! : theirs === undefined ? mine : pick(mine.at, mine, theirs.at, theirs)
    }
    const spelled = tagsFromClock(merged)
    tags = { tagClock: merged, ...(spelled.length ? { tags: spelled } : {}) }
  }

  const addedAt =
    a.addedAt === undefined ? b.addedAt : b.addedAt === undefined ? a.addedAt : Math.min(a.addedAt, b.addedAt)
  const openedAt =
    a.openedAt === undefined ? b.openedAt : b.openedAt === undefined ? a.openedAt : Math.max(a.openedAt, b.openedAt)

  const bookId = scalar(a.bookId, b.bookId)
  const origin = scalar(a.origin ?? undefined, b.origin ?? undefined)
  const ext = scalar(a.ext, b.ext)
  const contentHash = scalar(a.contentHash, b.contentHash)
  const format = scalar(a.format, b.format)

  return {
    /* Each group taken WHOLE from its winner — a field from the losing
     * side's group must not leak under the winner's, which is why nothing
     * here spreads a group's two sides in sequence. */
    ...mergeGroup(metadataGroup(a), metadataGroup(b)),
    ...mergeGroup(positionGroup(a), positionGroup(b)),
    ...mergeGroup(finishedGroup(a), finishedGroup(b)),
    ...tags,
    ...(addedAt === undefined ? {} : { addedAt }),
    ...(openedAt === undefined ? {} : { openedAt }),
    ...(bookId === undefined ? {} : { bookId }),
    ...(origin === undefined ? {} : { origin }),
    ...(ext === undefined ? {} : { ext }),
    ...(contentHash === undefined ? {} : { contentHash }),
    ...(format === undefined ? {} : { format }),
  } as BookRecord
}

/* ------------------------------------------------------- marks and cards */

/**
 * Per id, LATEST ACTION WINS — tombstones included, in both directions. The
 * implementations live in the kernel (`marks.ts`, `cards.ts`) because the
 * stores use the same rule (`MarkStore.mergeRemote`); one rule, one body.
 * Re-exported here so the protocol code has one merge module.
 */
export const mergeMarks = mergeMarksInKernel
export const mergeCards = mergeCardsInKernel

/* ------------------------------------------------------------- the wire */

/**
 * A record as it travels: the device-local fields taken off, everything
 * else as it is. `format` travels — it says what the bytes ARE — while
 * `ext` stays home with the copy it names. Works over shelf rows too, which
 * can carry `hasContent`.
 */
export function toWire(record: BookRecord): BookRecord {
  const wire: Record<string, unknown> = { ...record }
  for (const field of DEVICE_LOCAL_FIELDS) delete wire[field]
  return wire as unknown as BookRecord
}

/**
 * A record off the wire: RE-VALIDATED through the same `parseRecord` every
 * file goes through — the wire is a trust boundary exactly as a file is —
 * and stripped of device-local fields AGAIN, because a peer asserting an
 * `origin` or an `ext` into this device is precisely what must not happen.
 * `null` for anything that does not parse to a record.
 */
export function fromWire(obj: unknown): BookRecord | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null
  const parsed = parseRecord(JSON.stringify(obj))
  return parsed === null ? null : toWire(parsed)
}

/* ------------------------------------------------------------- digests */

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The digest a `marks` commit carries (§2.4): canonical over each mark's
 * `(id, newest stamp)`, sorted by id — so a satchel compares digests rather
 * than `max stamp + count`, and the order rows happen to sit in a file is
 * not state.
 */
export function marksDigest(marks: readonly Mark[]): Promise<string> {
  const rows = [...marks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((mark) => [mark.id, markStamp(mark)])
  return sha256(canonicalJson(rows))
}

/** The same, for the one cross-book card collection. */
export function cardsDigest(cards: readonly Card[]): Promise<string> {
  const rows = [...cards].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((card) => [card.id, cardStamp(card)])
  return sha256(canonicalJson(rows))
}

/**
 * A record's digest: canonical JSON — keys sorted at every depth, the tag
 * clock's included — of the WIRE form, so two devices digest the same book
 * identically whatever their device-local fields say.
 */
export function recordDigest(record: BookRecord): Promise<string> {
  return sha256(canonicalJson(toWire(record)))
}
