import { defineSetting, type Setting } from '../../../kernel'

/**
 * The marks QUARANTINE — the pull side's answer to one bad row (WI-20.25).
 *
 * A pull page fetches marks for every row whose digest differs, and the
 * cursor advances past the page once it is applied. That fetch is scheduled
 * by the digest comparison and by nothing else — `ledger.ts` says so at the
 * fetch — so a page could not "skip the invalid answer and advance": the
 * skipped book's marks would never be asked for again. It threw instead, and
 * one marks answer that would not validate failed that page every session,
 * forever, and every row behind it.
 *
 * So an invalid answer is SET ASIDE here, by book, per shelf: the page still
 * advances, and every later session re-fetches the held books regardless of
 * digest until one answers validly. A repair the shelf makes without a new
 * journal seq — the case the digest scheduler can never see — is picked up by
 * the next session.
 *
 * BOUNDED, because a faulty or hostile shelf could otherwise grow the list,
 * and the per-session work, without limit: `QUARANTINE_CAP` books, the oldest
 * dropped and COUNTED, so the reader is told what fell off rather than
 * shown a list that quietly stopped growing. Codex's round-2 objection (#10);
 * the number is theirs.
 *
 * Persisted as a setting beside the cursor, so it survives a relaunch the way
 * the cursor does, and read back through the same parse discipline: a shape
 * that does not validate is the empty list, never a throw at boot.
 */

export const QUARANTINE_CAP = 64

export interface Quarantine {
  /** Whose answers these were. A re-pair to another shelf starts empty. */
  readonly peerId: string
  /** Oldest first; the newest is last. */
  readonly books: readonly string[]
  /** How many were dropped off the old end, ever, for this shelf. */
  readonly dropped: number
}

export const EMPTY_QUARANTINE: Quarantine = { peerId: '', books: [], dropped: 0 }

export const SYNC_QUARANTINE_SETTING: Setting<Quarantine> = defineSetting('sync.quarantine', EMPTY_QUARANTINE, (raw) => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value['peerId'] !== 'string') return undefined
  if (!Array.isArray(value['books']) || !value['books'].every((one) => typeof one === 'string')) return undefined
  if (typeof value['dropped'] !== 'number' || !Number.isInteger(value['dropped']) || value['dropped'] < 0) return undefined
  return { peerId: value['peerId'], books: [...(value['books'] as string[])].slice(-QUARANTINE_CAP), dropped: value['dropped'] }
})

/** The list as it applies to ONE shelf: what was held for another peer is not
 *  this peer's, and a re-pair does not inherit a stranger's backlog. */
export function quarantineFor(held: Quarantine, peerId: string): Quarantine {
  return held.peerId === peerId ? held : { peerId, books: [], dropped: 0 }
}

/** Hold a book, newest last; a book already held moves to the newest end.
 *  Past the cap the oldest goes, and is counted. */
export function setAside(held: Quarantine, book: string): Quarantine {
  const books = held.books.filter((one) => one !== book)
  books.push(book)
  const over = Math.max(0, books.length - QUARANTINE_CAP)
  return { peerId: held.peerId, books: over > 0 ? books.slice(over) : books, dropped: held.dropped + over }
}

/** A book whose marks answered validly at last — or was removed on the shelf,
 *  so there is nothing left to repair. Unchanged, by identity, when the book
 *  was not held. */
export function release(held: Quarantine, book: string): Quarantine {
  if (!held.books.includes(book)) return held
  return { ...held, books: held.books.filter((one) => one !== book) }
}
