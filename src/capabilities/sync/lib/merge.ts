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
  type BookRecord,
  type Card,
  type Mark,
  type TagClockEntry,
  canonicalJson,
} from '../../../kernel'

/* ------------------------------------------------------------- canonical */

/* ⚠️ **MOVED TO `core/canonicalJson.ts`, and re-exported here so this module's
 * own readers still find it.** The circle needs the same function to compute
 * signed bytes and cannot import it from a capability; `wire.md` makes the move
 * a hard ORDERING constraint, because two canonicalisers disagreeing about key
 * order is a signature that verifies on one machine and fails on another. The
 * body is unchanged, null prototype and all. */
export { canonicalJson }

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

const metadataValue = (r: BookRecord): Partial<BookRecord> => ({
  title: r.title,
  author: r.author,
  /* ⚠️ `identifier` AND `metaSchema` ARE METADATA-GROUP FIELDS (WI-21.3), not
   * scalars. Both are facts the PARSE produced, so they travel with the parse
   * that produced them and are stamped by the same `parsedAt`: a replica that
   * parsed later knows more about the book than one that parsed earlier, and
   * splitting either out would let a stale replica's identifier survive its own
   * title. The group's tie and stamp rules were modelled over 10 000 cases and
   * stayed commutative, associative and idempotent with these in it. */
  ...(r.identifier ? { identifier: r.identifier } : {}),
  ...(r.metaSchema === undefined ? {} : { metaSchema: r.metaSchema }),
  ...(r.sortAs ? { sortAs: r.sortAs } : {}),
  ...(r.series ? { series: r.series } : {}),
  ...(r.seriesIndex === undefined ? {} : { seriesIndex: r.seriesIndex }),
  ...(r.publisher ? { publisher: r.publisher } : {}),
  ...(r.published ? { published: r.published } : {}),
  ...(r.languages ? { languages: r.languages } : {}),
  ...(r.subjects ? { subjects: r.subjects } : {}),
  ...(r.parsedAt === undefined ? {} : { parsedAt: r.parsedAt }),
})

/**
 * The metadata group, taken whole from the better-informed PARSE.
 *
 * The order is lexicographic over four keys, and each one is there for a
 * defect:
 *
 *  1. **Has it been parsed at all?** Absent `parsedAt` means never parsed and
 *     loses to any parse. Unchanged, and checked FIRST so the schema rule below
 *     can never promote a record that has not actually parsed.
 *  2. **Which metadata schema did the parse write?** ⚠️ **THIS ONE IS A DATA-LOSS
 *     FIX (WI-21.3, found by audit).** `parsedAt` alone let an OLDER build's
 *     LATER parse win — a record still at schema 0, which knows nothing about
 *     `identifier`, beating a schema-1 record that carries one, and ERASING it.
 *     It self-heals wherever the bytes are present (the record drops to schema 0
 *     and `needsEnrichment` re-selects it), but a satchel with
 *     `hasContent: false` cannot re-parse and keeps the loss for good.
 *
 *     The cost, stated: during a rolling upgrade a not-yet-updated device's
 *     corrected OPF stops winning until it updates. Both sides parsed the same
 *     file, so what it loses is a title correction for the length of the
 *     upgrade; what the other order loses is a field, permanently, on the
 *     replica least able to recover it.
 *  3. **Which parse is later.** A NUMBER, compared as one — the old fixed-width
 *     decimal encoding broke on anything `toString` spells with an exponent, and
 *     lexical order quietly stopped being numeric order.
 *  4. **The canonical serialisation**, `pick`'s own tie.
 *
 * A lexicographic max over a total order, so it stays commutative, associative
 * and idempotent — which `merge.test.ts`'s property tests check, and which is
 * why they had to start GENERATING `metaSchema` before this could be trusted.
 */
const mergeMetadata = (a: BookRecord, b: BookRecord): Partial<BookRecord> => {
  const va = metadataValue(a)
  const vb = metadataValue(b)
  if (a.parsedAt === undefined && b.parsedAt !== undefined) return vb
  if (b.parsedAt === undefined && a.parsedAt !== undefined) return va
  const schemaA = a.metaSchema ?? 0
  const schemaB = b.metaSchema ?? 0
  if (schemaA !== schemaB) return schemaA > schemaB ? va : vb
  if (a.parsedAt !== undefined && b.parsedAt !== undefined && a.parsedAt !== b.parsedAt) {
    return a.parsedAt > b.parsedAt ? va : vb
  }
  return canonicalJson(va) < canonicalJson(vb) ? vb : va
}

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
  /* SELF-MERGE IS A FIXED POINT. Two identical replicas have nothing to
   * reconcile, and the answer must be the record ITSELF — not the record
   * with a tag clock synthesised onto it and its orphan stamps dropped,
   * which is what running the register machinery over two equal legacy
   * sides produced. That non-identity re-journalled — and re-pushed — a
   * book that had not changed, every time an echo of it came back. */
  if (canonicalJson(a) === canonicalJson(b)) return a

  /* The tag registers: per-key LWW over both sides' clocks (synthesised for
   * a legacy side), keys sorted so the output is canonical. Null prototype:
   * the keys are reader-chosen, and `__proto__` is a legal tag. */
  const clockA = tagRegisters(a)
  const clockB = tagRegisters(b)
  let tags: Pick<BookRecord, 'tags' | 'tagClock'> = {}
  if (clockA || clockB) {
    const merged: Record<string, TagClockEntry> = Object.create(null) as Record<string, TagClockEntry>
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
    ...mergeMetadata(a, b),
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
  /* The serialisation itself can throw — a cycle, a BigInt, a getter that
   * traps. This is a trust boundary; anything unserialisable is "not a
   * record", never an exception escaping into the protocol machine. */
  let raw: string
  try {
    raw = JSON.stringify(obj)
  } catch {
    return null
  }
  const parsed = parseRecord(raw)
  return parsed === null ? null : toWire(parsed)
}

/* ------------------------------------------------------------- digests */

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * One digest pipeline for both row collections: sort by id, canonical JSON
 * of the WHOLE rows, hash. The rows themselves are in the digest — not just
 * `(id, newest stamp)` — because two replicas that diverged under ONE stamp
 * (two legacy rows edited apart, then stamped alike) digested identically,
 * and the pull that should have merged them was skipped forever. Row order
 * is still not state: the sort is the canonicalisation.
 */
function rowsDigest(rows: readonly { readonly id: string }[]): Promise<string> {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return sha256(canonicalJson(sorted))
}

/** The digest a `marks` commit carries (§2.4) — see `rowsDigest`. */
export function marksDigest(marks: readonly Mark[]): Promise<string> {
  return rowsDigest(marks)
}

/** The same, for the one cross-book card collection. */
export function cardsDigest(cards: readonly Card[]): Promise<string> {
  return rowsDigest(cards)
}

/**
 * A record's digest: canonical JSON — keys sorted at every depth, the tag
 * clock's included — of the WIRE form, so two devices digest the same book
 * identically whatever their device-local fields say.
 */
export function recordDigest(record: BookRecord): Promise<string> {
  return sha256(canonicalJson(toWire(record)))
}
