import { MAX_WORK_FIELD } from './lists'
import {
  OWN_SHELF_PATH,
  atomicWrite,
  compareEntries,
  primaryLanguage,
  type Entry,
  type Hlc,
  type ShelvedWork,
  type VaultFs,
  type WriteQueue,
  isHlc,
} from '../../../kernel'
import { isSealedPage, pagesOver, type Bounds, type Publisher, type SealedPage, DEFAULT_BOUNDS, boundariesInOrder } from './publish'

/**
 * The reader's own shelf, as PUBLISHED — WI-23.C1's store.
 *
 * ⚠️ **A LOG PER PERSON, NOT ENTRIES PER WORK.** The recipient asks about
 * books it does NOT have, so it cannot ask per work; the shelf is one log per
 * publisher, keyed `(person, 'shelf')`, holding `shelf` / `unshelf` entries
 * that each name one work in clear. Same chain, same signing, same per-device
 * cursor as the per-book log (`pagesOver` builds both), its own file —
 * `circle/shelf.json`, in the capability's own namespace — and its own
 * service, `circle.shelf`.
 *
 * ## The store reproduces what it published
 *
 * A row keeps the work as it was published — title, author, identifier,
 * language, cover digest — because a page a friend already holds has to be
 * reproducible byte for byte. When the book's metadata changes the old row is
 * taken back and a new one published: a signed entry cannot be rewritten in
 * place. `bookId` is kept so the shelf can be diffed against the library, and
 * it never travels: it is derived from the bytes of THIS copy.
 *
 * ## What is disclosed
 *
 * ⚠️ Exactly the claim's inputs, in clear. The per-work log hashes them; this
 * one cannot, because a recipient has to draw a title it has never seen. That
 * is the whole reason the shelf is behind a per-person switch (WI-23.C2) that
 * is off by default, and why nothing here decides whether to serve — the
 * exchange does, per caller.
 */

/** One book on the shelf as published, and its removal if any. */
export interface ShelfRow {
  /** Minted per shelving; `unshelf` names it. */
  readonly pub: string
  /** This copy's id — for the diff, never served. */
  readonly bookId: string
  readonly work: ShelvedWork
  readonly device: string
  readonly seq: number
  readonly at: Hlc
  readonly unshelved?: { readonly seq: number; readonly at: Hlc }
}

export interface ShelfFile {
  readonly works: readonly ShelfRow[]
  readonly sealed: readonly SealedPage[]
}

export const NOTHING_SHELVED: ShelfFile = { works: [], sealed: [] }

/** BLAKE3, hex — what a cover on a shelf entry is (WI-23.C5). */
export const COVER_DIGEST = /^[0-9a-f]{64}$/u

/** A book as the library holds it, narrowed to what the shelf publishes. */
export interface ShelvedBook {
  readonly bookId: string
  readonly title?: string
  readonly author?: string
  readonly identifier?: string
  readonly languages?: readonly string[]
  /** The cover's digest, when the caller has one to publish (WI-23.C5). */
  readonly cover?: string
}

/** The work a book publishes as. Absent title and author publish as `''`. */
export function workOf(book: ShelvedBook): ShelvedWork {
  return {
    title: book.title ?? '',
    author: book.author ?? '',
    ...(book.identifier === undefined ? {} : { identifier: book.identifier }),
    language: primaryLanguage(book.languages?.[0]),
    ...(book.cover === undefined ? {} : { cover: book.cover }),
  }
}

const sameWork = (a: ShelvedWork, b: ShelvedWork): boolean =>
  a.title === b.title && a.author === b.author && a.identifier === b.identifier && a.language === b.language && a.cover === b.cover

/** One past the highest sequence this device has used on the shelf log. */
export function nextShelfSeq(held: ShelfFile, device: string): number {
  let top = 0
  for (const row of held.works) {
    if (row.device !== device) continue
    top = Math.max(top, row.seq, row.unshelved?.seq ?? 0)
  }
  /* And past every sealed boundary, for `nextSeqFor`'s reason: a boundary
     can outlive the rows it covers, and a sequence inside one was served. */
  for (const sealed of held.sealed) {
    if (sealed.device === device) top = Math.max(top, sealed.to)
  }
  if (top >= Number.MAX_SAFE_INTEGER) throw new Error(`the shelf log for ${device} has run out of sequence numbers`)
  return top + 1
}

/** The rows still on the shelf, by this copy's id. */
export function shelvedNow(held: ShelfFile): ReadonlyMap<string, ShelfRow> {
  const live = new Map<string, ShelfRow>()
  for (const row of held.works) {
    if (row.unshelved === undefined) live.set(row.bookId, row)
  }
  return live
}

/**
 * Bring the published shelf up to the library: shelve what is new, unshelve
 * what is gone, and re-publish what changed. The same store when nothing did.
 *
 * ⚠️ **REMOVING A BOOK PUBLISHES `unshelf`; ADDING ONE PUBLISHES `shelf`** —
 * the item's acceptance. The log then reproduces the published shelf exactly:
 * the live rows ARE the shelf, and a friend folding the log holds the same
 * set.
 */
export function syncShelf(
  held: ShelfFile,
  books: readonly ShelvedBook[],
  device: string,
  at: Hlc,
  mintPub: () => string,
): ShelfFile {
  const live = shelvedNow(held)
  const onShelf = new Map(books.map((book) => [book.bookId, workOf(book)]))
  let next = held
  const stamped = () => ({ device, seq: nextShelfSeq(next, device), at })
  const unshelve = (row: ShelfRow) => {
    const gone = stamped()
    next = {
      ...next,
      works: next.works.map((one) => (one === row ? { ...one, unshelved: { seq: gone.seq, at: gone.at } } : one)),
    }
  }
  const shelve = (bookId: string, work: ShelvedWork) => {
    next = { ...next, works: [...next.works, { pub: mintPub(), bookId, work, ...stamped() }] }
  }

  for (const [bookId, row] of live) {
    const now = onShelf.get(bookId)
    if (now === undefined) unshelve(row)
    else if (!sameWork(row.work, now)) {
      /* Changed metadata is a new publication under a new pub, never a row
         rewritten under the old one. */
      unshelve(row)
      shelve(bookId, now)
    }
  }
  for (const [bookId, work] of onShelf) {
    if (!live.has(bookId)) shelve(bookId, work)
  }
  return next
}

/** The whole shelf log this reader would serve, in stamp order. */
export function shelfLogOf(held: ShelfFile): readonly Entry[] {
  const entries: Entry[] = []
  for (const row of held.works) {
    entries.push({ op: 'shelf', pub: row.pub, work: row.work, device: row.device, seq: row.seq, at: row.at })
    if (row.unshelved) {
      entries.push({ op: 'unshelf', pub: row.pub, device: row.device, seq: row.unshelved.seq, at: row.unshelved.at })
    }
  }
  return [...entries].sort(compareEntries)
}

/** The pages a request for the shelf asks for — see `pagesOver`. */
export async function shelfPagesFor(
  held: ShelfFile,
  publisher: Publisher,
  since: Readonly<Record<string, number>>,
  hash: (value: string) => string,
  bounds: Bounds = DEFAULT_BOUNDS,
  version?: number,
): Promise<{ readonly pages: readonly string[]; readonly more: boolean; readonly held: ShelfFile }> {
  const built = await pagesOver(shelfLogOf(held), held.sealed, publisher, since, hash, bounds, version)
  return { pages: built.pages, more: built.more, held: { ...held, sealed: built.sealed } }
}

/* ────────────────────────────────────────────────────────────── the file */

/**
 * The reader's own shelf as published. THROWS on a malformed file, for the
 * reason `readShared` does: reading it as "nothing shelved" would mint
 * sequence numbers already served and re-cut pages friends hold.
 */
export async function readOwnShelf(fs: VaultFs): Promise<ShelfFile> {
  if (!(await fs.exists(OWN_SHELF_PATH))) return NOTHING_SHELVED
  const parsed: unknown = JSON.parse(new TextDecoder().decode(await fs.readFile(OWN_SHELF_PATH)))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the published shelf is not a shelf file')
  }
  const held = parsed as Record<string, unknown>
  const works = held['works']
  if (!Array.isArray(works) || !works.every(isShelfRow)) throw new Error('the published shelf has no work list')
  if (reusesSequence(works)) throw new Error('the published shelf reuses a sequence')
  const sealed = held['sealed']
  if (!Array.isArray(sealed) || !sealed.every(isSealedPage)) throw new Error('the published shelf has no page boundaries')
  if (!boundariesInOrder(sealed)) throw new Error('the published shelf has page boundaries out of order')
  return { works, sealed }
}

function isShelfRow(value: unknown): value is ShelfRow {
  /* Stryker disable next-line ConditionalExpression: a non-object has no `pub` member, so the check below refuses it anyway. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (typeof row['pub'] !== 'string' || row['pub'] === '') return false
  /* The stamp is an HLC and the sequence a position on this device's log —
     at least 1: a row saying otherwise would be signed into a page, or
     take a sequence a real entry holds. */
  if (typeof row['bookId'] !== 'string' || typeof row['device'] !== 'string' || !isHlc(row['at'])) return false
  if (!Number.isSafeInteger(row['seq']) || (row['seq'] as number) < 1) return false
  const work = row['work']
  /* Stryker disable next-line ConditionalExpression: a string has no `title` member, so the check below refuses it anyway. */
  if (typeof work !== 'object' || work === null || Array.isArray(work)) return false
  /* EXACTLY a row's fields and a work's, each within its bound: the wire
     refuses a page carrying a field the schema does not name, so a row
     accepted here with one would be a page every recipient refuses. */
  if (!hasOnly(row, ['pub', 'bookId', 'work', 'device', 'seq', 'at', 'unshelved'])) return false
  const named = work as Record<string, unknown>
  if (!hasOnly(named, ['title', 'author', 'language', 'identifier', 'cover'])) return false
  if (!isText(named['title']) || !isText(named['author']) || !isText(named['language'])) return false
  if (named['identifier'] !== undefined && !isText(named['identifier'])) return false
  /* A cover is a digest, and a store row with anything else in its place would be a page every recipient refuses. */
  // Stryker disable next-line ConditionalExpression: a non-string never matches the digest pattern; the type check spells out what the pattern already refuses.
  if (named['cover'] !== undefined && !(typeof named['cover'] === 'string' && COVER_DIGEST.test(named['cover']))) return false
  const gone = row['unshelved']
  if (gone === undefined) return true
  /* Stryker disable next-line ConditionalExpression: a non-object has no `seq` member, so the check below refuses it anyway. */
  if (typeof gone !== 'object' || gone === null) return false
  const mark = gone as Record<string, unknown>
  /* A removal comes AFTER the shelving it removes, on the same log. */
  return Number.isSafeInteger(mark['seq']) && (mark['seq'] as number) > (row['seq'] as number) && isHlc(mark['at'])
}

/** Every `(device, seq)` a shelf file holds — rows and removals — is one position, held once. */
function reusesSequence(works: readonly ShelfRow[]): boolean {
  const held = new Set<string>()
  for (const row of works) {
    for (const seq of [row.seq, ...(row.unshelved === undefined ? [] : [row.unshelved.seq])]) {
      const key = `${row.device}:${seq}`
      if (held.has(key)) return true
      held.add(key)
    }
  }
  return false
}

/** The lane the circle's own folder writes on — not a book's, and not a person's. */
export const OWN_SHELF_LANE = 'circle'

const hasOnly = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key))
const isText = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_WORK_FIELD

/**
 * Change the published shelf as one step on its lane — read, transform,
 * write — for `updateShared`'s reason: the library's driver and the
 * exchange's sealing both change this file. The transform answering the same
 * object writes nothing.
 */
export async function updateOwnShelf(
  fs: VaultFs,
  queue: WriteQueue,
  transform: (held: ShelfFile) => ShelfFile | Promise<ShelfFile>,
): Promise<ShelfFile> {
  let next: ShelfFile = NOTHING_SHELVED
  await queue.append(OWN_SHELF_LANE, async () => {
    const held = await readOwnShelf(fs)
    next = await transform(held)
    if (next !== held) await atomicWrite(fs, OWN_SHELF_PATH, new TextEncoder().encode(JSON.stringify(next)))
  })
  return next
}
