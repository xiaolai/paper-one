/**
 * The presence register — whether each book is ON the shelf or REMOVED, as an
 * LWW register that outlives the trash.
 *
 * The trash answers "can this removal be undone" and forgets after a
 * fortnight. Replication needs a different answer — "was this book removed,
 * and when, relative to everything else that happened to it" — and needs it
 * FOREVER, because a satchel that was in a drawer for a month must not
 * re-upload the book it still holds. So removal writes here first, the trash
 * rename second: a crash between the two leaves a folder that is still live
 * and a register that says removed, which `finishPendingRemovals` closes at
 * launch by finishing the move. The other order would leave a book gone with
 * no record that anyone removed it — a deletion that resurrects.
 *
 * Re-adding writes `live` with a newer stamp, so the register encodes the
 * whole history's LAST word rather than a one-way flag. Entries are kept
 * forever; at one small JSON row per book ever removed, forever is cheap.
 *
 * SERIALISATION IS THE CALLER'S. `notePresence` is a read-modify-write of one
 * shared file, and two books' removals run on two different queue keys — the
 * library serialises every call to it on one key (`PRESENCE_KEY`) of the same
 * write queue, which is what makes the RMW safe. Stated here because nothing
 * in the signature can enforce it.
 */

import { folderOf, readBook, type BookRecord, atomicWrite } from './bookFolder'
import { trashBook, type TrashFs } from './bookTrash'
import type { VaultFs } from './bookVault'
import { hlcOf, isHlc, laterHlc, type Hlc } from './hlc'

/** Where the register lives: beside the journal, under the sync directory. */
export const PRESENCE_PATH = 'sync/removed.json'

/** The one write-queue key every `notePresence` call must be serialised on. */
export const PRESENCE_KEY = 'sync:presence'

export type PresenceState = 'live' | 'removed'

export interface PresenceEntry {
  readonly state: PresenceState
  readonly at: Hlc
}

export type Presence = Readonly<Record<string, PresenceEntry>>

/**
 * Read the register, dropping malformed ENTRIES individually — one hand-edited
 * row must not cost the register beside it, which for this file would mean a
 * removal forgotten. Absent, unreadable and not-an-object are all the empty
 * register: this file is derived state plus history, and an unreadable history
 * refuses nothing — the journal's verify pass is what audits it.
 */
export async function readPresence(fs: VaultFs): Promise<Presence> {
  let raw: string
  try {
    raw = new TextDecoder().decode(await fs.readFile(PRESENCE_PATH))
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const presence: Record<string, PresenceEntry> = Object.create(null) as Record<string, PresenceEntry>
  for (const key of Object.keys(parsed)) {
    if (key === '') continue
    const value = (parsed as Record<string, unknown>)[key]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    if (entry['state'] !== 'live' && entry['state'] !== 'removed') continue
    if (!isHlc(entry['at'])) continue
    presence[key] = { state: entry['state'], at: entry['at'] }
  }
  return presence
}

/** Write the register whole and atomically, like every other file here. */
export async function writePresence(fs: VaultFs, presence: Presence): Promise<void> {
  await atomicWrite(fs, PRESENCE_PATH, new TextEncoder().encode(JSON.stringify(presence, null, 2)))
}

/**
 * Set one book's register — LAST WRITER WINS, judged by the stamp, so a
 * stale caller cannot roll a newer decision back. Resolves with whether it
 * wrote. Must run on `PRESENCE_KEY` — see the module note.
 */
export async function notePresence(
  fs: VaultFs,
  bookId: string,
  state: PresenceState,
  at: Hlc,
): Promise<boolean> {
  const presence = await readPresence(fs)
  const held = presence[bookId]
  /* `<=` ON A REPEAT of the same state, `<` never: an equal stamp with a
   * DIFFERENT state is a tie the register cannot order, and the held value
   * wins because rewriting on a tie would let two replicas flap. An equal
   * stamp with the SAME state is a no-op either way. */
  if (held && (held.at > at || (held.at === at && held.state !== state))) return false
  if (held && held.at === at && held.state === state) return false
  await writePresence(fs, { ...presence, [bookId]: { state, at } })
  return true
}

/**
 * The newest thing a RECORD knows about itself — the stamp a presence entry
 * is compared against when launch recovery has to decide whether a live
 * folder predates the removal that names it. Every ledger stamp the record
 * carries, and the legacy times under `hlcOf`, so a phase-4 record still has
 * an answer.
 */
export function recordStamp(record: BookRecord): Hlc {
  let latest: Hlc = hlcOf(record.addedAt)
  latest = laterHlc(latest, hlcOf(record.openedAt))!
  latest = laterHlc(latest, hlcOf(record.parsedAt))!
  latest = laterHlc(latest, record.positionAt)!
  latest = laterHlc(latest, record.finishedAt)!
  for (const key of Object.keys(record.tagClock ?? {})) {
    latest = laterHlc(latest, record.tagClock![key]!.at)!
  }
  return latest
}

/**
 * Launch recovery: finish any removal the register recorded and a crash left
 * undone. A live folder whose presence says `removed`, with a stamp newer
 * than anything the record itself knows, is a removal that wrote its register
 * and died before the rename — so the rename happens now. A record NEWER
 * than the removal is left standing: that is a re-add racing a crash, and
 * keeping a book wrongly is recoverable where trashing one wrongly is the
 * reader's work gone.
 *
 * Returns the ids it finished. Best-effort per book: one folder that will
 * not move must not stop the others.
 */
export async function finishPendingRemovals(fs: TrashFs): Promise<string[]> {
  const presence = await readPresence(fs)
  const finished: string[] = []
  for (const bookId of Object.keys(presence)) {
    const entry = presence[bookId]!
    if (entry.state !== 'removed') continue
    try {
      if (!(await fs.exists(folderOf(bookId)))) continue
      const record = await readBook(fs, bookId)
      /* A folder with no readable record still moves: there is nothing to
       * say it is newer than the removal, and the trash keeps it either way. */
      if (record && recordStamp(record) > entry.at) continue
      if (await trashBook(fs, bookId)) finished.push(bookId)
    } catch {
      continue
    }
  }
  return finished
}
