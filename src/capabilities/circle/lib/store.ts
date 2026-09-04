import {
  READING_STATES,
  STARS,
  atomicWrite,
  circleFolderIn,
  circlePathIn,
  isHlc,
  compareItems,
  personFolderIn,
  personListPathIn,
  personListsDirIn,
  personShelfPathIn,
  type ForeignEntry,
  type HeldWork,
  type Hlc,
  type IndexFs,
  type ListItem,
  type ReadingState,
  type Stars,
  type VaultFs,
  type WriteQueue,
  LIST_ID,
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
  /**
   * The highest `seq` held per publishing device — what the next request asks
   * from (`PagesRequest.since`).
   *
   * ⚠️ **PERSISTED, AND IT WAS NOT — WI-23.A2.** `takePages` derived a cursor
   * from the entries it accepted, and the stored entries carry no `seq`, so a
   * relaunch started every cursor from zero and re-fetched every log in full.
   * A cursor that lives in memory is a cursor that lasts one session. Written
   * in the same atomic write as `heads`, because the two describe one state:
   * the chain head says WHAT was last taken and this says HOW FAR.
   *
   * Keyed by device, for `heads`'s reason: the log is keyed by `(device, seq)`.
   */
  readonly cursor: Readonly<Record<string, number>>
  /**
   * Which CHAIN `heads` and `cursor` describe — the page version negotiated
   * when they were last advanced. WI-23.B2.
   *
   * ⚠️ **THE v1 CHAIN AND THE v2 CHAIN ARE TWO CHAINS**, sealed separately by
   * the publisher, so a head taken from one is not a head on the other. When
   * the negotiated version moves — the publisher upgraded, or this side did —
   * `takePages` starts the new chain from nothing: heads and cursor reset,
   * and the new chain is fetched from its first page. What is HELD survives
   * the reset: `entries` and `withdrawn` are the folded state of the log, and
   * a share re-delivered on the new chain is a duplicate the fold already
   * keeps once. One full re-fetch per log per upgrade is the price of a chain
   * that reproduces byte for byte, and it is paid once.
   */
  readonly v: number
  /**
   * What this person thinks of the book — the folded registers, WI-23.B5.
   *
   * Each register keeps the entry that won it — value, stamp, and the
   * `(device, seq)` the fold breaks an equal stamp by — so applying pages one
   * at a time folds to exactly what folding the whole log would, ties
   * included. `receive.test.ts` holds that as a property, over every kind.
   */
  readonly opinion: HeldOpinion
  /** This person's reviews still out. */
  readonly reviews: readonly HeldReview[]
  /**
   * The works on this person's SHELF — WI-23.C1/C3. Only ever non-empty in
   * the person's shelf file (`personShelfPathIn`), which is this same shape
   * under a different path: one chain, one fold, one parser.
   */
  readonly works: readonly HeldWork[]
  /** Every shelved `pub` taken back — `withdrawn`'s twin for the shelf. */
  readonly unshelved: readonly string[]
  /**
   * A LIST, folded — WI-23.E1. Only ever non-empty in a list file
   * (`personListPathIn`), which is this same shape under a third path: one
   * chain, one fold, one parser, as the shelf is.
   */
  readonly list: HeldList
  /**
   * Every review `pub` this person has taken back, including ones never seen
   * — `withdrawn`'s twin, kept apart from it on purpose.
   *
   * ⚠️ **ONE LIST FOR BOTH KINDS WAS WRONG, AND THE PROPERTY TEST FOUND IT.**
   * `fold` keeps a withdrawn-shares set and an unreviewed set; a store that
   * merged them let an `unreview` naming a passage's `pub` take the passage
   * down. An honest publisher never mints one `pub` for two things, which is
   * exactly why the store must not rely on it: a tombstone must withdraw only
   * the kind it names.
   */
  readonly unreviewed: readonly string[]
}

/** A register as the file holds it: the winning entry's value and its identity. */
export interface HeldRegister<T> {
  readonly value: T
  readonly at: Hlc
  readonly device: string
  readonly seq: number
  /** Which relationship epoch it arrived under, for `HeldWork.epoch`'s reason. */
  readonly epoch?: number
}

export interface HeldOpinion {
  readonly status?: HeldRegister<ReadingState>
  readonly stars?: HeldRegister<Stars>
  readonly tags?: HeldRegister<readonly string[]>
}

/** A review this person published, as the recipient holds it. */
export interface HeldReview {
  readonly pub: string
  readonly text: string
  readonly at: Hlc
  /** `(device, seq)` of the entry, for `ForeignEntry.device`'s reason. */
  readonly device?: string
  readonly seq?: number
  /** Which relationship epoch it arrived under — see `ForeignEntry.epoch`. */
  readonly epoch: number
}

/** Nothing held for this person, which is the ordinary case for most books. */
/**
 * A list as this device holds it — `foldList`, kept incrementally, so that
 * `applyEntries` over pages one at a time answers what folding the whole log
 * would. The title register keeps its winning entry's `(device, seq)` for
 * the tie rule; `removed` is the tombstone set, kept for ever.
 */
export interface HeldList {
  readonly created: boolean
  /**
   * The relationship epoch the `create` arrived under — `HeldWork.epoch`'s
   * reason, for the list's existence: a list retained across a block must
   * not be drawn on re-admission. ⚠️ **EACH PART CARRIES ITS OWN EPOCH**,
   * not the list one for all of them: one epoch on the list, moved by
   * whichever page came last, let a `place` under the new relationship
   * re-expose a title and a creation that arrived under the old one. The
   * title's epoch is on its register, an item's on the item. Absent on a
   * list kept before epochs were, which reads as the first epoch.
   */
  readonly createdEpoch?: number
  /** The winning title, with the epoch it arrived under — drawn only under that relationship. */
  readonly title?: HeldRegister<string>
  /**
   * WITHDRAWALS CARRY NO EPOCH, and are never gated on one: `deleted` and
   * `removed` only ever take content away, and a withdrawal that stopped
   * counting on re-admission would REVIVE what it withdrew — the one
   * direction the epoch exists to prevent.
   */
  readonly deleted: boolean
  /** In the position rule's order — `compareItems`. Each carries the epoch it arrived under. */
  readonly items: readonly ListItem[]
  readonly removed: readonly string[]
}

export const NO_LIST_HELD: HeldList = { created: false, deleted: false, items: [], removed: [] }

/** The chain the first build fetched — the only one there was before `ForeignFile.v`. */
const FIRST_CHAIN = 1

export const NOTHING_SHARED: ForeignFile = {
  entries: [],
  withdrawn: [],
  heads: {},
  cursor: {},
  v: FIRST_CHAIN,
  opinion: {},
  reviews: [],
  unreviewed: [],
  works: [],
  unshelved: [],
  list: NO_LIST_HELD,
}

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
  return readFileAt(fs, circlePathIn(bookId, person), person, `${bookId}/${person}`)
}

/** One of a friend's lists, as this device holds it — WI-23.E1. */
export async function readHeldList(fs: VaultFs, person: string, listId: string): Promise<ForeignFile> {
  return readFileAt(fs, personListPathIn(person, listId), person, `${person}/lists/${listId}`)
}

/**
 * Every list held for a person, by id. An absent folder is an empty map,
 * for `peopleFor`'s reason: almost every person has no lists.
 */
export async function heldListIdsOf(fs: IndexFs, person: string): Promise<readonly string[]> {
  const folder = personListsDirIn(person)
  /* Stryker disable next-line ConditionalExpression: the platform's readDir refuses a missing folder; the fake does not, so the guard cannot be observed here. */
  if (!(await fs.exists(folder))) return []
  const entries = await fs.readDir(folder)
  /* Only names that ARE list ids: a stray file beside the lists made
     `listWork` refuse its claim and the whole round with it. */
  /* Stryker disable LogicalOperator,StringLiteral,MethodExpression: the id rule below refuses any name the extension check would have let through. */
  return entries
    .filter((entry) => !entry.isDirectory && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .filter((id) => LIST_ID.test(id))
    .sort()
  /* Stryker restore LogicalOperator,StringLiteral,MethodExpression */
}

/**
 * A friend's SHELF, as this device holds it — WI-23.C3: the same shape as a
 * per-book file, under `circle/<person>/shelf.json`, the first circle file
 * outside a book. One parser, one fold, one chain.
 */
export async function readHeldShelf(fs: VaultFs, person: string): Promise<ForeignFile> {
  return readFileAt(fs, personShelfPathIn(person), person, `${person}/shelf`)
}

async function readFileAt(fs: VaultFs, path: string, person: string, where: string): Promise<ForeignFile> {
  if (!(await fs.exists(path))) return NOTHING_SHARED
  const bytes = await fs.readFile(path)
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`circle file for ${where} is not a circle file`)
  }
  const held = parsed as Record<string, unknown>
  /* One parser per part of the file — the chain state, and each domain's
     rows with their withdrawals — so a shape can move in one without the
     others being read past. A withdrawn `pub` wins over a row that names it
     in every domain, whatever order they were written in: otherwise a file
     that somehow held both would draw a passage its author has taken back,
     and the reader would have no way to make it stop. */
  const chain = readChain(held, where)
  const passages = readPassages(held, person, where)
  const reviews = readTombstoned(held, 'reviews', 'unreviewed', isHeldReview, where, 'a review list', 'a review withdrawal list')
  const shelf = readTombstoned(held, 'works', 'unshelved', isHeldWork, where, 'a shelf', 'a shelf withdrawal list')
  /* ⚠️ **AN OPINION THAT WILL NOT PARSE IS A FILE THAT THROWS**, for the
   * reason a bad withdrawal list is: read as "nothing said", the next page
   * naming an older word would make that word current again, and the reader
   * would be shown a rating this person has since changed. Absent is empty —
   * nothing said, which loses nothing. `undefined` is absent; `null` is a
   * value, and not one an opinion can be. */
  const opinion = readOpinion(held['opinion'] === undefined ? {} : held['opinion'])
  if (opinion === null) throw new Error(`circle file for ${where} has an opinion that will not read`)
  /* A list that will not read throws, for the opinion's reason: read as
     "no list", the next page would re-place what the person removed. */
  const list = held['list'] === undefined ? NO_LIST_HELD : readList(held['list'])
  if (list === null) throw new Error(`circle file for ${where} has a list that will not read`)
  return {
    entries: passages.rows,
    withdrawn: passages.gone,
    ...chain,
    opinion,
    reviews: reviews.rows,
    unreviewed: reviews.gone,
    works: shelf.rows,
    unshelved: shelf.gone,
    list,
  }
}

/**
 * The chain state: heads, cursor and version.
 *
 * ⚠️ **A HEAD MAP THAT WILL NOT READ THROWS.** Reading it as "no chain yet"
 * resets every chain to its start, which is precisely the substitution
 * `prevPageHash` exists to refuse — and it would be granted by a relaunch.
 *
 * ⚠️ **A FILE 0.1.3 WROTE HAS NEITHER `cursor` NOR `v`, AND IT IS NOT A FILE
 * THAT WILL NOT READ.** That build persisted the chain heads and nothing
 * about how far along them it was; refusing it made every passage a friend
 * had sent before the upgrade throw on the first read after it. Read as a
 * chain started from nothing — heads and cursor empty, on the first chain —
 * with what is HELD kept, for `ForeignFile.v`'s reason: the folded entries
 * and withdrawals survive, and a share re-delivered from the start is a
 * duplicate the fold keeps once. The heads go WITH the cursor: a head kept
 * beside an empty cursor asks for the first page and refuses it as a gap,
 * for ever. One full re-fetch per log, once, is the price. Both absent and
 * nothing else is the shape; one of the two alone is a hand-made file.
 *
 * ⚠️ **A CURSOR THAT WILL NOT READ THROWS, and an ABSENT one does too.** Read
 * as "nothing fetched yet" it would re-fetch every log from zero — which is
 * the exact defect the field was added to remove, granted by a relaunch.
 * Absent is refused for `heads`'s reason — save the one shape above. The
 * version likewise: refused rather than guessed, since a head read into the
 * wrong chain is a chain that never verifies again.
 */
function readChain(held: Record<string, unknown>, where: string): Pick<ForeignFile, 'heads' | 'cursor' | 'v'> {
  const heads = held['heads']
  if (typeof heads !== 'object' || heads === null || Array.isArray(heads) || !Object.values(heads).every((one) => typeof one === 'string')) {
    throw new Error(`circle file for ${where} has no chain heads`)
  }
  const legacy = held['cursor'] === undefined && held['v'] === undefined
  const cursor = legacy ? {} : held['cursor']
  if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor) || !Object.values(cursor).every((one) => Number.isSafeInteger(one) && (one as number) >= 0)) {
    throw new Error(`circle file for ${where} has no fetch cursor`)
  }
  const v = legacy ? FIRST_CHAIN : held['v']
  if (!Number.isSafeInteger(v) || (v as number) < 1) {
    throw new Error(`circle file for ${where} names no chain version`)
  }
  return {
    heads: legacy ? {} : (heads as Readonly<Record<string, string>>),
    cursor: cursor as Readonly<Record<string, number>>,
    v: v as number,
  }
}

/**
 * The passages, and every `pub` withdrawn.
 *
 * ⚠️ **A WITHDRAWAL LIST THAT WILL NOT READ IS A FILE THAT THROWS, not one
 * that reads as "nothing withdrawn".** Silently emptying it un-withdraws
 * every passage this person has taken back — the file would then resurrect
 * them on the next page that mentions one, which is the failure the list
 * exists to prevent, produced by the code that reads it.
 *
 * ⚠️ **EVERY ENTRY IS CHECKED, AND VALIDATION USED TO STOP AT THE ARRAY.**
 * `[null]` parsed as a `ForeignFile`, and the first `entry.passage.quote`
 * downstream threw — AFTER the per-person error isolation had already run,
 * so one malformed record took down every other person's overlay for that
 * book. This file is written by a remote peer, which makes it the least
 * trusted input the capability has; `validMarks` applies the same rule to
 * `marks.json` and for the same reason. A malformed ROW is dropped and
 * reported; a malformed FILE still throws, because a file that will not parse
 * at all is a fact worth surfacing rather than silently reading as empty.
 */
function readPassages(held: Record<string, unknown>, person: string, where: string): { readonly rows: readonly ForeignEntry[]; readonly gone: readonly string[] } {
  const rows = held['entries']
  if (!Array.isArray(rows)) throw new Error(`circle file for ${where} has no entry list`)
  const gone = readNames(held['withdrawn'], () => new Error(`circle file for ${where} has no withdrawal list`))
  const kept: ForeignEntry[] = []
  for (const row of rows) {
    if (isForeignEntry(row, person)) kept.push(asShared(row))
    else console.warn(`Paper: dropped a malformed circle entry in ${where}`)
  }
  const hidden = new Set(gone)
  return { rows: kept.filter((one) => !hidden.has(one.pub)), gone }
}

/**
 * A tombstoned domain — reviews, shelf rows — with its withdrawal list. Absent
 * is empty, which loses nothing: nothing was said. Present and malformed
 * throws, for the withdrawal list's reason.
 */
function readTombstoned<T extends { readonly pub: string }>(
  held: Record<string, unknown>,
  rowsKey: string,
  goneKey: string,
  isRow: (value: unknown) => value is T,
  where: string,
  rowsWhat: string,
  goneWhat: string,
): { readonly rows: readonly T[]; readonly gone: readonly string[] } {
  const rows = held[rowsKey] === undefined ? [] : held[rowsKey]
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error(`circle file for ${where} has ${rowsWhat} that will not read`)
  const gone = readNames(held[goneKey] === undefined ? [] : held[goneKey], () => new Error(`circle file for ${where} has ${goneWhat} that will not read`))
  const hidden = new Set(gone)
  return { rows: (rows as readonly T[]).filter((one) => !hidden.has(one.pub)), gone }
}

/** A list of names — `pub`s withdrawn — deduplicated, or the error the caller names. */
function readNames(value: unknown, refuse: () => Error): readonly string[] {
  if (!Array.isArray(value) || !value.every((one) => typeof one === 'string')) throw refuse()
  return [...new Set(value as string[])]
}

/** A held list, or `null` for one that will not read. A removed pub wins over an item that names it. */
function readList(value: unknown): HeldList | null {
  /* Stryker disable next-line ConditionalExpression: a string has no `created` member, so the check below refuses it anyway. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const held = value as Record<string, unknown>
  if (typeof held['created'] !== 'boolean' || typeof held['deleted'] !== 'boolean') return null
  const items = held['items']
  if (!Array.isArray(items) || !items.every(isListItem)) return null
  const removed = held['removed']
  if (!Array.isArray(removed) || !removed.every((one) => typeof one === 'string')) return null
  const title = held['title']
  if (title !== undefined) {
    if (!isRegisterShape(title) || typeof title['value'] !== 'string') return null
  }
  const createdEpoch = held['createdEpoch']
  if (createdEpoch !== undefined && !isEpoch(createdEpoch)) return null
  const gone = new Set(removed as string[])
  return {
    created: held['created'],
    ...(createdEpoch === undefined ? {} : { createdEpoch }),
    ...(title === undefined
      ? {}
      : { title: { value: title['value'] as string, at: title.at, device: title.device, seq: title.seq, ...(title['epoch'] === undefined ? {} : { epoch: title['epoch'] as number }) } }),
    deleted: held['deleted'],
    items: [...(items as ListItem[]).filter((one) => !gone.has(one.pub))].sort(compareItems),
    removed: [...new Set(removed as string[])],
  }
}

function isListItem(value: unknown): value is ListItem {
  if (!isHeldWork(value)) return false
  const row = value as unknown as Record<string, unknown>
  return (
    // Stryker disable next-line ConditionalExpression: `hasStampOrNone` above already refused a device that is not a string; this spells that an item has one.
    typeof row['device'] === 'string' &&
    Number.isSafeInteger(row['seq']) &&
    Number.isSafeInteger(row['position']) &&
    typeof row['note'] === 'string'
  )
}

function isHeldWork(value: unknown): value is HeldWork {
  /* Stryker disable next-line all: a non-object has no `pub` member, so the
     check below refuses it anyway; this refuses it a line earlier. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (typeof row['pub'] !== 'string' || row['pub'] === '' || !isHlc(row['at']) || !hasStampOrNone(row)) return false
  if (row['epoch'] !== undefined && !isEpoch(row['epoch'])) return false
  const work = row['work']
  if (typeof work !== 'object' || work === null || Array.isArray(work)) return false
  const named = work as Record<string, unknown>
  return (
    typeof named['title'] === 'string' &&
    typeof named['author'] === 'string' &&
    typeof named['language'] === 'string' &&
    (named['identifier'] === undefined || typeof named['identifier'] === 'string') &&
    // Stryker disable next-line ConditionalExpression: a non-string never matches the digest pattern; the type check spells out what the pattern already refuses.
    (named['cover'] === undefined || (typeof named['cover'] === 'string' && /^[0-9a-f]{64}$/u.test(named['cover'])))
  )
}

/** A register's identity — stamp, device and sequence — as every one carries it. */
function isRegisterShape(value: unknown): value is Record<string, unknown> & { at: Hlc; device: string; seq: number } {
  /* Stryker disable next-line ConditionalExpression: a non-object has no `at`
     member, so the check below refuses it anyway. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const held = value as Record<string, unknown>
  /* A device is a name and a sequence a position from 1: an empty device or
     a zero sequence is an identity no entry ever had, and it would take part
     in the tie rule as though one did. */
  return (
    isHlc(held['at']) &&
    typeof held['device'] === 'string' &&
    held['device'] !== '' &&
    Number.isSafeInteger(held['seq']) &&
    (held['seq'] as number) >= 1 &&
    (held['epoch'] === undefined || isEpoch(held['epoch']))
  )
}

/** The opinion, whole or null — every register present must read, or none does. */
function readOpinion(value: unknown): HeldOpinion | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const held = value as Record<string, unknown>
  const out: { status?: HeldRegister<ReadingState>; stars?: HeldRegister<Stars>; tags?: HeldRegister<readonly string[]> } = {}
  if (held['status'] !== undefined) {
    const one = held['status']
    if (!isRegisterShape(one) || !(READING_STATES as readonly unknown[]).includes(one['value'])) return null
    out.status = { value: one['value'] as ReadingState, at: one.at, device: one.device, seq: one.seq, ...(one['epoch'] === undefined ? {} : { epoch: one['epoch'] as number }) }
  }
  if (held['stars'] !== undefined) {
    const one = held['stars']
    if (!isRegisterShape(one) || !(STARS as readonly unknown[]).includes(one['value'])) return null
    out.stars = { value: one['value'] as Stars, at: one.at, device: one.device, seq: one.seq, ...(one['epoch'] === undefined ? {} : { epoch: one['epoch'] as number }) }
  }
  if (held['tags'] !== undefined) {
    const one = held['tags']
    const tags = isRegisterShape(one) ? one['value'] : undefined
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) return null
    out.tags = { value: tags as readonly string[], at: (one as { at: Hlc }).at, device: (one as { device: string }).device, seq: (one as { seq: number }).seq, ...((one as { epoch?: number }).epoch === undefined ? {} : { epoch: (one as { epoch: number }).epoch }) }
  }
  return out
}

function isHeldReview(value: unknown): value is HeldReview {
  /* Stryker disable next-line ConditionalExpression: a non-object has no `pub`
     member, so the check below refuses it anyway. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row['pub'] === 'string' &&
    row['pub'] !== '' &&
    typeof row['text'] === 'string' &&
    isHlc(row['at']) &&
    isEpoch(row['epoch']) &&
    hasStampOrNone(row)
  )
}

/** The optional `(device, seq)` a held row may carry: both or neither, and well-formed when there. */
function hasStampOrNone(row: Record<string, unknown>): boolean {
  if (row['device'] === undefined && row['seq'] === undefined) return true
  return typeof row['device'] === 'string' && row['device'] !== '' && Number.isSafeInteger(row['seq']) && (row['seq'] as number) >= 1
}

/** A relationship epoch: the first admission is 1, and each re-admission counts up. */
function isEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
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
    isEpoch(entry['epoch']) &&
    typeof entry['receivedAt'] === 'number' &&
    (entry['at'] === undefined || isHlc(entry['at'])) &&
    hasStampOrNone(entry) &&
    typeof parts['quote'] === 'string' &&
    typeof parts['prefix'] === 'string' &&
    typeof parts['suffix'] === 'string' &&
    typeof parts['chapter'] === 'string' &&
    /* A note is optional, and a string when there: an object would reach the
       painter as text and throw under the reader's own notes. */
    (parts['note'] === undefined || typeof parts['note'] === 'string')
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
  /**
   * Whether the person is still admitted, asked INSIDE the lane — see
   * `writePersonFile`. Required, for `changed`'s reason.
   */
  admits: () => Promise<boolean>,
): Promise<void> {
  await writeOnLane(fs, queue, lane(bookId), circlePathIn(bookId, person), held, changed, admits)
}

/**
 * One circle file, replaced whole on ONE lane, the caller told after — the
 * write every held file goes through, per book or per person.
 *
 * ⚠️ **RE-ASKED INSIDE THE LANE, NOT ONLY BEFORE IT.** The round asks the
 * record before every keep and a purge takes the same lane — but a keep
 * queued behind a purge ran after it, and put the person's file back from
 * the dead. The record the purge leaves says exited, and that is read here,
 * on the lane, with nothing between the answer and the write.
 *
 * ⚠️ **`atomicWrite`, AND THIS WAS A RAW `writeFile` — which would have failed
 * on the FIRST production write.** `circle/` does not exist until something
 * creates it, and a bare `writeFile` creates no parent; the fake filesystem
 * these tests run against is permissive and created one implicitly, so every
 * test passed against a call that cannot work on a real disk. The same fake
 * hid the second half: a raw write is not atomic, so an interruption leaves
 * truncated JSON that `readForeign` then refuses for ever — a book whose
 * foreign marks are permanently unreadable. `atomicWrite` makes the parent
 * and renames into place, as `marks.json` is written.
 */
async function writeOnLane(
  fs: VaultFs,
  queue: WriteQueue,
  laneKey: string,
  path: string,
  held: ForeignFile,
  changed: () => void,
  admits: () => Promise<boolean>,
): Promise<void> {
  await queue.append(laneKey, async () => {
    if (!(await admits())) return
    await atomicWrite(fs, path, new TextEncoder().encode(JSON.stringify(held)))
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

/** Replace one of a friend's lists, on the person's lane — `writeHeldShelf`'s rule. */
export async function writeHeldList(
  fs: VaultFs,
  queue: WriteQueue,
  person: string,
  listId: string,
  held: ForeignFile,
  changed: () => void,
  admits: () => Promise<boolean>,
): Promise<void> {
  await writePersonFile(fs, queue, person, personListPathIn(person, listId), held, changed, admits)
}

/** One of a person's files, replaced whole on the PERSON's lane — the lane their folder is purged on — and the caller told after. */
function writePersonFile(
  fs: VaultFs,
  queue: WriteQueue,
  person: string,
  path: string,
  held: ForeignFile,
  changed: () => void,
  admits: () => Promise<boolean>,
): Promise<void> {
  return writeOnLane(fs, queue, personFolderIn(person), path, held, changed, admits)
}

/**
 * Replace a friend's shelf, on the PERSON's lane — WI-23.C3. Not a book's
 * lane: the shelf is about books this reader may not have. The same lane the
 * person's folder is purged on, so a fetch landing and a purge cannot
 * interleave.
 */
export async function writeHeldShelf(
  fs: VaultFs,
  queue: WriteQueue,
  person: string,
  held: ForeignFile,
  changed: () => void,
  admits: () => Promise<boolean>,
): Promise<void> {
  await writePersonFile(fs, queue, person, personShelfPathIn(person), held, changed, admits)
}
