import {
  atomicWrite,
  circleFolderIn,
  circlePathIn,
  type ForeignEntry,
  type IndexFs,
  type VaultFs,
  type WriteQueue,
} from '../../../kernel'

/**
 * Where a friend's passages live on this device — WI-22.D1 and WI-22.E3.
 *
 * One file per `(book, person)`, beside `marks.json` and never inside it. The
 * path helpers and the reason are in `bookFolder.ts`; what is here is the
 * reading, the writing and the purge.
 *
 * ## Absent and unreadable are not the same answer
 *
 * ⚠️ **`readMarks` names this as the most destructive line it ever had**, and
 * the same trap is here: a book nobody has shared from and a file that would
 * not read look identical to a caller who collapses both to `[]` — so a
 * momentary read failure loads nothing, and the next write puts that nothing
 * on disk over everything the reader had received. Absent is empty, which is
 * the truth. Anything else THROWS.
 *
 * ## Every write goes through the shelf's queue
 *
 * The same queue `marks.json` uses, keyed on the same book folder — so a
 * circle write and a marks write for one book cannot interleave, and neither
 * can two circle writes for two people in the same book.
 */

/**
 * What one person's file holds.
 *
 * ⚠️ **THIS WAS A BARE LIST, AND A LIST CANNOT HOLD A WITHDRAWAL FOR A SHARE
 * THAT HAS NOT ARRIVED.** `fold` states the guarantee it needs in as many
 * words — *"an `unshare` for a `pub` not yet seen is REMEMBERED, not
 * dropped"* — because pages may arrive out of order, and a withdrawal that is
 * dropped comes straight back the moment the share it withdraws lands. That is
 * exactly the *"comes straight back"* failure `Mark.deletedAt` exists to
 * prevent, one level up, and with a list on disk there was nowhere to keep it.
 *
 * Within ONE device the chain hash makes out-of-order delivery impossible —
 * `checkPage` refuses a page whose `prevPageHash` does not match. Across two
 * devices of the same person it is ordinary: their laptop can withdraw what
 * their phone published, and the two pages travel independently.
 *
 * `surfaces.md` specifies the ENTRY shape and says the file holds entries; it
 * does not say the file is nothing else. This completes that design rather
 * than contradicting it.
 */
export interface ForeignFile {
  readonly entries: readonly ForeignEntry[]
  /**
   * Every `pub` this person has withdrawn, including ones never seen.
   *
   * A tombstone, not a deletion — the same shape and the same reason as
   * `Mark.deletedAt`. It grows without bound in principle; in practice it
   * grows by one per withdrawal, which is a human act.
   */
  readonly withdrawn: readonly string[]
  /**
   * The chain head per publishing device: `chainHash` of the last page taken.
   *
   * ⚠️ **WITHOUT THIS THE CHAIN IS A FIELD, NOT A CHAIN.** `checkPage` refuses a
   * page whose `prevPageHash` does not match what the receiver expects — and
   * "what the receiver expects" is only meaningful if it SURVIVES a relaunch.
   * Held here rather than in memory because a gap in a log is exactly the thing
   * a restart must not forgive: a peer that could reset the chain by waiting
   * for the app to close could substitute a page at will.
   *
   * Keyed by device, because the log is keyed by `(device, seq)` — see
   * `mergeLogs`, and `PagesRequest.since`.
   */
  readonly heads: Readonly<Record<string, string>>
}

/** Nothing held for this person, which is the ordinary case for most books. */
export const NOTHING_SHARED: ForeignFile = { entries: [], withdrawn: [], heads: {} }

/**
 * How a book's writes are serialised.
 *
 * ⚠️ **TAKEN FROM THE LIBRARY, AND IT USED TO BE DERIVED HERE** as
 * `` `book:${bookId}` ``. `Library.lane` says why in as many words —
 * *"deriving either again elsewhere is a race that does not show up in a
 * diff"* — and the kernel has already paid for it once: `folderOf` is
 * MANY-TO-ONE, so `book:a/b` and `book:a_b` are two ids over ONE directory,
 * and a second derivation puts them on two lanes over the same files. It also
 * follows a rekeyed book to the lane its earlier writes are still draining on.
 *
 * The header above this claims a circle write and a marks write for one book
 * cannot interleave. With a lane string of its own that was simply false, and
 * this is what makes the sentence true.
 */
export type LaneFor = (bookId: string) => string

/**
 * One person's entries for one book, or `[]` when there are none.
 *
 * THROWS on an unreadable or malformed file — see the module header.
 */
export async function readForeign(
  fs: VaultFs,
  bookId: string,
  person: string,
): Promise<ForeignFile> {
  const path = circlePathIn(bookId, person)
  if (!(await fs.exists(path))) return NOTHING_SHARED
  const bytes = await fs.readFile(path)
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`circle file for ${bookId}/${person} is not a circle file`)
  }
  const held = parsed as Record<string, unknown>
  const rows = held['entries']
  if (!Array.isArray(rows)) {
    throw new Error(`circle file for ${bookId}/${person} has no entry list`)
  }
  /* ⚠️ **A WITHDRAWAL LIST THAT WILL NOT READ IS A FILE THAT THROWS, not one
   * that reads as "nothing withdrawn".** Silently emptying it un-withdraws
   * every passage this person has taken back — the file would then resurrect
   * them on the next page that mentions one, which is the failure the list
   * exists to prevent, produced by the code that reads it. */
  const gone = held['withdrawn']
  if (!Array.isArray(gone) || !gone.every((one) => typeof one === 'string')) {
    throw new Error(`circle file for ${bookId}/${person} has no withdrawal list`)
  }
  /* ⚠️ **EVERY ENTRY IS CHECKED, AND VALIDATION USED TO STOP AT THE ARRAY.**
   * `[null]` parsed as a `ForeignFile`, and the first `entry.passage.quote`
   * downstream threw — AFTER the per-person error isolation had already run,
   * so one malformed record took down every other person's overlay for that
   * book. This file is written by a remote peer, which makes it the least
   * trusted input the capability has; `validMarks` applies the same rule to
   * `marks.json` and for the same reason.
   *
   * A malformed ROW is dropped and reported; a malformed FILE still throws,
   * because a file that will not parse at all is a fact worth surfacing rather
   * than silently reading as empty (see the header). */
  const kept: ForeignEntry[] = []
  for (const row of rows) {
    if (isForeignEntry(row, person)) kept.push(asShared(row))
    else console.warn(`Paper: dropped a malformed circle entry in ${bookId}/${person}`)
  }
  /* ⚠️ **A WITHDRAWN `pub` WINS OVER AN ENTRY THAT NAMES IT**, whatever order
   * they were written in. Otherwise a file that somehow held both would draw a
   * passage its author has taken back — and the reader would have no way to
   * make it stop. */
  /* ⚠️ **A HEAD MAP THAT WILL NOT READ THROWS TOO.** Reading it as "no chain
   * yet" resets every chain to its start, which is precisely the substitution
   * `prevPageHash` exists to refuse — and it would be granted by a relaunch. */
  const heads = held['heads']
  if (
    typeof heads !== 'object' ||
    heads === null ||
    Array.isArray(heads) ||
    !Object.values(heads).every((one) => typeof one === 'string')
  ) {
    throw new Error(`circle file for ${bookId}/${person} has no chain heads`)
  }
  const withdrawn = [...new Set(gone)]
  const hidden = new Set(withdrawn)
  return {
    entries: kept.filter((one) => !hidden.has(one.pub)),
    withdrawn,
    heads: heads as Readonly<Record<string, string>>,
  }
}

/**
 * The entry as it was shared, with any `resolved` left on disk thrown away.
 *
 * ⚠️ **A CACHED ANCHOR CANNOT BE VALIDATED, SO IT IS NOT READ BACK.** `resolved`
 * says where a passage landed in THIS build of THIS book — and nothing stored
 * beside it says which book that was. A well-formed
 * `epubcfi(/6/4!/4/2)` from an earlier edition addresses a different sentence
 * in a later one, and checking its SHAPE cannot tell the two apart. The
 * reader's own re-anchoring cache does not have this problem because it is
 * keyed on `contentHash` (`reanchorCache.ts`, `useReanchor`); this one carries
 * no such key, so every value in it is a claim with no evidence.
 *
 * ⚠️ **AND IT IS THE ONE FIELD NOTHING DOWNSTREAM RE-EXAMINES.**
 * `annotationsFor` SKIPS the resolver for any entry that already has an anchor
 * (`entry.resolved === undefined` is the filter), so a wrong one is never
 * caught — it goes straight to the painter and draws somebody's claim over
 * text they never marked. That is the same hole as `fresh.cfi as never`,
 * reached through the file instead of through a cast.
 *
 * ⚠️ **DROPPED, NOT REFUSED.** Throwing the row away would lose a real passage
 * somebody shared over a stale optimisation. Without the field the entry goes
 * back through the resolver, which is exactly where an unanchored passage
 * belongs, and costs one walk of a book that is open anyway.
 *
 * **What it would take to keep it.** The cache has to carry the `contentHash`
 * it was computed against and be dropped when that moves — the shape
 * `reanchorCache` already uses. `OverlayRequest` does not carry a content hash
 * today, so that is a seam to widen rather than a check to add here. Until
 * then this is an optimisation that can be wrong and cannot be checked, and
 * one of those is not an optimisation.
 */
function asShared(entry: ForeignEntry): ForeignEntry {
  /* Stryker disable next-line ConditionalExpression: an allocation, not a
     behaviour. Without the early return the destructure below rebuilds an
     object with exactly the same fields, so nothing observable differs — only
     the number of objects made while reading a file. */
  if (!('resolved' in entry)) return entry
  const { resolved: _stale, ...rest } = entry
  return rest
}

/**
 * Whether one row is an entry, and whether it is THIS person's.
 *
 * ⚠️ **`person` IS CHECKED AGAINST THE FILE IT CAME FROM, not trusted.** A
 * record inside Alice's file could name Bob as its author, and everything
 * downstream reads that field: the relationship epoch it is checked against,
 * the name shown beside the mark, and which file a purge would have to clear.
 * The FILE is the authenticated statement of who sent something; the field
 * inside it is a claim, and the two must agree.
 */
function isForeignEntry(row: unknown, person: string): row is ForeignEntry {
  /* Stryker disable next-line ConditionalExpression: unobservable for anything
     `JSON.parse` can produce. A string, a number or a boolean has no `passage`
     member, so the check below reads `undefined` and refuses the row anyway —
     this one refuses it a line earlier and says why. */
  if (typeof row !== 'object' || row === null) return false
  const entry = row as Record<string, unknown>
  const passage = entry['passage']
  if (typeof passage !== 'object' || passage === null) return false
  const parts = passage as Record<string, unknown>
  const claimed = entry['person']
  /* ⚠️ **COMPARED EXACTLY, AND IT USED TO BE COMPARED THROUGH THE PATH.** The
   * old comment argued that asking whether two ids resolve to the same FILE was
   * "exactly as strong as the filesystem allows", since colliding ids already
   * share a file. That reasoning is wrong in the direction that matters:
   * `safeId` maps every non-alphanumeric to `_`, so `"/"`, `"-"` and `"a/b"`
   * all resolve into somebody else's file — and this predicate then accepted a
   * row claiming ANY of them as the author of the entries in `a_b.json`. The
   * collision was already a fact about the layout; agreeing with it here made
   * it a fact about who the reader is told wrote a passage.
   *
   * An exact comparison refuses those, which is failing closed on ids that
   * cannot be told apart — the right direction. It costs nothing real: a person
   * id is a 64-hex public key (`PersonId` in `person.rs`), and `safeId` is the
   * identity function on hex, so for every id the system actually mints the
   * file name IS the id.
   *
   * ⚠️ It also removes the path call from a predicate. Not because that call
   * could throw — an audit reported it could, and it cannot: `safeId` throws
   * only on the empty string, which the line below already refuses — but
   * because a validity check that builds a path is doing two jobs, and the
   * second one is the one that would have to grow a `try`. */
  /* ⚠️ **ONE COMPARISON, AND THERE USED TO BE THREE.** A `typeof` test and an
   * empty-string test stood in front of this one, and mutation testing showed
   * both were unreachable: `person` is never the empty string — `circlePathIn`
   * goes through `safeId`, which THROWS on it, so `readForeign` cannot even
   * build the path — and a `claimed` of any other type is `!== person`
   * already. Two clauses that cannot change an answer are two clauses a reader
   * has to work out are dead, and the next person to edit this has to keep
   * them true for nothing. */
  if (claimed !== (person as unknown)) return false
  return (
    typeof entry['pub'] === 'string' &&
    entry['pub'] !== '' &&
    typeof entry['epoch'] === 'number' &&
    typeof entry['receivedAt'] === 'number' &&
    typeof parts['quote'] === 'string' &&
    typeof parts['prefix'] === 'string' &&
    typeof parts['suffix'] === 'string' &&
    typeof parts['chapter'] === 'string'
  )
}

/** Replace one person's entries for one book, on the shelf's queue. */
export async function writeForeign(
  fs: VaultFs,
  queue: WriteQueue,
  lane: LaneFor,
  bookId: string,
  person: string,
  held: ForeignFile,
  /**
   * Told after the bytes land — see `circleChanged`.
   *
   * ⚠️ **REQUIRED, NOT OPTIONAL, SO A CALLER CANNOT FORGET.** The overlay's
   * `subscribe` is what makes a passage landing mid-session appear at all; a
   * writer that lands one silently is the seam's promise broken from the
   * inside. The same reason `checkPage` takes `maySpeak` as a required
   * argument rather than looking one up.
   */
  changed: () => void,
): Promise<void> {
  await queue.append(lane(bookId), async () => {
    /* ⚠️ **`atomicWrite`, AND THIS WAS A RAW `writeFile` — which would have
     * failed on the FIRST production write.** `circle/` does not exist until
     * something creates it, and a bare `writeFile` creates no parent; the fake
     * filesystem these tests run against is permissive and created one
     * implicitly, so every test passed against a call that cannot work on a
     * real disk. The same fake hid the second half: a raw write is not atomic,
     * so an interruption leaves truncated JSON that `readForeign` then refuses
     * for ever — a book whose foreign marks are permanently unreadable.
     *
     * `atomicWrite` makes the parent and renames into place. It is the same
     * primitive `marks.json` is written with; using anything else here was the
     * whole defect. */
    await atomicWrite(
      fs,
      circlePathIn(bookId, person),
      new TextEncoder().encode(JSON.stringify(held)),
    )
  })
  /* AFTER the queued write, not inside it: a listener that re-reads would
     otherwise queue behind the very task it is reacting to. */
  changed()
}

/**
 * Drop everything one person sent for one book — `retain: 'purge'`.
 *
 * ⚠️ **AND IT PROMISES NOTHING ABOUT THE OTHER DIRECTION.** What they already
 * received of yours is theirs; `relationships.md` requires the COPY say so, and
 * the same honesty belongs in the function's name and its comment rather than
 * only in a dialog somebody may not write.
 *
 * Idempotent: purging a person who sent nothing is not an error, because a
 * reader blocking somebody must not be told the block failed on the strength of
 * their never having shared anything.
 */
export async function purgeForeign(
  fs: VaultFs,
  queue: WriteQueue,
  lane: LaneFor,
  bookId: string,
  person: string,
  /** Told after the removal — see `writeForeign`. */
  changed: () => void,
): Promise<void> {
  await queue.append(lane(bookId), async () => {
    const path = circlePathIn(bookId, person)
    if (await fs.exists(path)) await fs.remove(path)
  })
  changed()
}

/**
 * Every person who has sent something for this book.
 *
 * ⚠️ **AN ABSENT FOLDER IS AN EMPTY LIST AND NOT AN ERROR**, because that is
 * the ordinary case: almost every book on a shelf has no circle folder at all.
 * A throw here would make the overlay pass fail for the common book rather than
 * the rare one.
 */
export async function peopleFor(fs: IndexFs, bookId: string): Promise<readonly string[]> {
  /* `IndexFs`, not `VaultFs` — listing is the seam `bookIndex.ts` names, and
     `VaultFs` deliberately has no `readDir`. Taking the narrower type here
     would mean inventing a second listing capability beside the one that
     exists. */
  const folder = circleFolderIn(bookId)
  if (!(await fs.exists(folder))) return []
  const entries = await fs.readDir(folder)
  return (
    entries
      .filter((entry) => !entry.isDirectory && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      /* ⚠️ **SORTED, because `readDir` order is not specified and this order is
       * load-bearing.** `drawable` groups several readers at one anchor into
       * ONE mark, and the FIRST entry it sees supplies that mark's person, its
       * publication and its overlay key. Left in directory order, which mark a
       * shared passage is filed under could change between two reads of an
       * unchanged disk — so a redraw would move the key and foliate would see a
       * different annotation. */
      .sort()
  )
}
