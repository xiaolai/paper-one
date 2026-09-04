import {
  OWN_LISTS_DIR,
  atomicWrite,
  compareEntries,
  foldList,
  isHlc,
  ownListPathIn,
  type Entry,
  type Hlc,
  type IndexFs,
  type ListState,
  type ShelvedWork,
  type VaultFs,
  type WriteQueue,
  LIST_ID,
  listIdOf,
} from '../../../kernel'
import { DEFAULT_BOUNDS, isSealedPage, pagesOver, type Bounds, type Publisher, type SealedPage, boundariesInOrder, reusesSequence } from './publish'

/**
 * The reader's own lists, as PUBLISHED — WI-23.E1's store.
 *
 * One file per list, `circle/lists/<listId>.json`, holding the list's log
 * rows as this reader's devices wrote them and the page boundaries sealed
 * when they were served. Same chain, same signing, same cursors as the shelf
 * (`pagesOver` builds all of them), under the list's own reserved claim
 * (`listWork`), served by `circle.lists` to a person the shelf switch is on
 * for and to nobody else.
 *
 * ⚠️ **THE ROWS ARE THE LOG, VERBATIM.** A page a friend already holds has
 * to be reproducible byte for byte, so nothing here rewrites a row: a
 * retitle is a new row, a move is a new `place` under the same `pub`, a
 * removal is a tombstone. `foldList` is what the reader sees; the file is
 * what the reader said.
 */

/** A list's log row — one of the five list kinds, and nothing else. */
export type ListRow = Extract<Entry, { op: 'create' | 'retitle' | 'place' | 'remove' | 'delete' }>

export interface ListFile {
  readonly rows: readonly ListRow[]
  readonly sealed: readonly SealedPage[]
}

export const NOTHING_LISTED: ListFile = { rows: [], sealed: [] }

/** One of the reader's lists, by id, as stored. */
export interface OwnList {
  readonly id: string
  readonly held: ListFile
}

/**
 * The bounds a list's own words carry — a title, a note, a work's fields.
 *
 * A page is capped (`MAX_PAGE_CHARS`), and an entry that cannot fit a page
 * can never be served: one over-long note would block the whole chain after
 * it, for ever. Generous for anything a reader types, far below the cap.
 */
export const MAX_LIST_TITLE = 200
export const MAX_LIST_NOTE = 2_000
export const MAX_WORK_FIELD = 1_024

/** One past the highest sequence this device has used on the list's log. */
export function nextListSeq(held: ListFile, device: string): number {
  let top = 0
  for (const row of held.rows) {
    if (row.device === device) top = Math.max(top, row.seq)
  }
  /* AND PAST EVERY SEALED BOUNDARY: a boundary can outlive the rows it was
     cut over, and a sequence inside one has been served — minting it again
     would put two entries at one position of a chain friends hold. */
  for (const sealed of held.sealed) {
    if (sealed.device === device) top = Math.max(top, sealed.to)
  }
  if (top >= Number.MAX_SAFE_INTEGER) throw new Error(`list log for ${device} has run out of sequence numbers`)
  return top + 1
}

/** The whole log this reader would serve for the list, in stamp order. */
export function listLogOf(held: ListFile): readonly Entry[] {
  return [...held.rows].sort(compareEntries)
}

/** What the list says now. */
export function stateOf(held: ListFile): ListState {
  return foldList(held.rows)
}

type Stamp = { readonly device: string; readonly at: Hlc }

/** A row before it is stamped — `Omit` over each member of the union, not over the union. */
type Unstamped<T> = T extends unknown ? Omit<T, 'device' | 'seq' | 'at'> : never

function append(held: ListFile, row: Unstamped<ListRow>, by: Stamp): ListFile {
  const stamped = { ...row, device: by.device, seq: nextListSeq(held, by.device), at: by.at } as ListRow
  return { ...held, rows: [...held.rows, stamped] }
}

export function createList(held: ListFile, title: string, by: Stamp): ListFile {
  return append(held, { op: 'create', title }, by)
}

export function retitleList(held: ListFile, title: string, by: Stamp): ListFile {
  return append(held, { op: 'retitle', title }, by)
}

/** Place a work at a position with a note; the same `pub` again moves it. */
export function placeOnList(
  held: ListFile,
  item: { readonly pub: string; readonly work: ShelvedWork; readonly position: number; readonly note: string },
  by: Stamp,
): ListFile {
  return append(held, { op: 'place', ...item }, by)
}

export function removeFromList(held: ListFile, pub: string, by: Stamp): ListFile {
  return append(held, { op: 'remove', pub }, by)
}

export function deleteList(held: ListFile, by: Stamp): ListFile {
  return append(held, { op: 'delete' }, by)
}

/** The pages a request for this list asks for — see `pagesOver`. */
export async function listPagesFor(
  held: ListFile,
  publisher: Publisher,
  since: Readonly<Record<string, number>>,
  hash: (value: string) => string,
  bounds: Bounds = DEFAULT_BOUNDS,
  version?: number,
): Promise<{ readonly pages: readonly string[]; readonly more: boolean; readonly held: ListFile }> {
  const built = await pagesOver(listLogOf(held), held.sealed, publisher, since, hash, bounds, version)
  return { pages: built.pages, more: built.more, held: { ...held, sealed: built.sealed } }
}

/* ────────────────────────────────────────────────────────────── the files */

/**
 * One of the reader's own lists. THROWS on a malformed file, for the reason
 * `readOwnShelf` does: read as "nothing", it would mint sequence numbers
 * already served and re-cut pages friends hold.
 */
export async function readOwnList(fs: VaultFs, listId: string): Promise<ListFile> {
  const path = ownListPathIn(listId)
  if (!(await fs.exists(path))) return NOTHING_LISTED
  const parsed: unknown = JSON.parse(new TextDecoder().decode(await fs.readFile(path)))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`list ${listId} is not a list file`)
  }
  const held = parsed as Record<string, unknown>
  const rows = held['rows']
  if (!Array.isArray(rows) || !rows.every(isListRow)) throw new Error(`list ${listId} has rows that will not read`)
  /* One position, one row: `pagesOver` collapses a reused `(device, seq)`
     by sequence, which would serve one entry and silently drop the other
     while the cursor moved past both. */
  if (reusesSequence(rows)) throw new Error(`list ${listId} reuses a sequence`)
  const sealed = held['sealed']
  if (!Array.isArray(sealed) || !sealed.every(isSealedPage)) throw new Error(`list ${listId} has no page boundaries`)
  /* A boundary carries the claim its page was served under; one naming
     another list's claim would sign this list's rows under that list's id. */
  if (sealed.some((one) => one.work !== undefined && listIdOf(one.work) !== listId)) throw new Error(`list ${listId} has a page boundary of another list`)
  if (!boundariesInOrder(sealed)) throw new Error(`list ${listId} has page boundaries out of order`)
  return { rows, sealed }
}

/** Every list this reader has a file for, by id, sorted. An absent folder is none. */
export async function ownListIds(fs: IndexFs): Promise<readonly string[]> {
  /* Stryker disable next-line ConditionalExpression: the platform's readDir refuses a missing folder; the fake does not, so the guard cannot be observed here. */
  if (!(await fs.exists(OWN_LISTS_DIR))) return []
  const entries = await fs.readDir(OWN_LISTS_DIR)
  /* A name that is not a list id is not a list — a stray file beside the
     lists used to make every `circle.lists` answer fail on its claim. */
  /* Stryker disable LogicalOperator,StringLiteral: the id rule below refuses any name the extension check would have let through, so the two clauses cannot be told apart. */
  return entries
    .filter((entry) => !entry.isDirectory && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .filter((id) => LIST_ID.test(id))
    .sort()
  /* Stryker restore LogicalOperator,StringLiteral */
}

const hasOnly = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key))
const isText = (value: unknown, most: number): value is string => typeof value === 'string' && value.length <= most

/**
 * EXACTLY a work's fields, each within its bound. The wire refuses a page
 * carrying a field the schema does not name, so a row this side accepted
 * with one would be a page every recipient refuses — for ever, since the
 * chain behind it cannot move.
 */
function isWork(value: unknown): value is ShelvedWork {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const named = value as Record<string, unknown>
  return (
    hasOnly(named, ['title', 'author', 'language', 'identifier', 'cover']) &&
    isText(named['title'], MAX_WORK_FIELD) &&
    isText(named['author'], MAX_WORK_FIELD) &&
    isText(named['language'], MAX_WORK_FIELD) &&
    (named['identifier'] === undefined || isText(named['identifier'], MAX_WORK_FIELD)) &&
    // Stryker disable next-line ConditionalExpression: a non-string never matches the digest pattern; the type check spells out what the pattern already refuses.
    (named['cover'] === undefined || (typeof named['cover'] === 'string' && /^[0-9a-f]{64}$/u.test(named['cover'])))
  )
}

const STAMP = ['op', 'device', 'seq', 'at']

function isListRow(value: unknown): value is ListRow {
  /* Stryker disable next-line ConditionalExpression: a non-object has no `op` member, so the check below refuses it anyway. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  /* A device is a name and a sequence a position on its log — from 1. */
  if (typeof row['device'] !== 'string' || row['device'] === '' || !Number.isSafeInteger(row['seq']) || (row['seq'] as number) < 1 || !isHlc(row['at'])) return false
  switch (row['op']) {
    case 'create':
    case 'retitle':
      return hasOnly(row, [...STAMP, 'title']) && isText(row['title'], MAX_LIST_TITLE)
    case 'place':
      return (
        hasOnly(row, [...STAMP, 'pub', 'work', 'position', 'note']) &&
        typeof row['pub'] === 'string' &&
        row['pub'] !== '' &&
        isWork(row['work']) &&
        Number.isSafeInteger(row['position']) &&
        isText(row['note'], MAX_LIST_NOTE)
      )
    case 'remove':
      return hasOnly(row, [...STAMP, 'pub']) && typeof row['pub'] === 'string' && row['pub'] !== ''
    case 'delete':
      return hasOnly(row, STAMP)
    // Stryker disable next-line all: an unnamed op falls out of the switch as `undefined`, which is `false` here.
    default:
      return false
  }
}

/** The lane the circle's own folder writes on — the shelf's. */
const OWN_LISTS_LANE = 'circle'

/** Change one list as one step on the circle's lane — `updateOwnShelf`'s rule. */
export async function updateOwnList(
  fs: VaultFs,
  queue: WriteQueue,
  listId: string,
  transform: (held: ListFile) => ListFile | Promise<ListFile>,
): Promise<ListFile> {
  let next: ListFile = NOTHING_LISTED
  await queue.append(OWN_LISTS_LANE, async () => {
    const held = await readOwnList(fs, listId)
    next = await transform(held)
    if (next !== held) await atomicWrite(fs, ownListPathIn(listId), new TextEncoder().encode(JSON.stringify(next)))
  })
  return next
}
