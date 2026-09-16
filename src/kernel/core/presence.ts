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
import { isMissingFile, type VaultFs } from './bookVault'
import { hlcOf, isHlc, laterHlc, type Hlc } from './hlc'

/** Where the register lives: beside the journal, under the sync directory. */
export const PRESENCE_PATH = 'sync/removed.json'

/** The one write-queue key every `notePresence` call must be serialised on. */
// Stryker disable next-line StringLiteral: a queue key is shared by reference — every caller imports this constant, nothing stores it, and a spelling that collided with another lane could only serialise more, never less.
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
 * removal forgotten. ABSENT is the empty register, and nothing else is.
 *
 * ⚠️ **UNREADABLE AND NOT-AN-OBJECT USED TO BE THE EMPTY REGISTER TOO, AND
 * THAT ERASED EVERY REMOVAL THIS DEVICE HAD EVER RECORDED.** The paragraph
 * here argued that this file is derived state and an unreadable history
 * refuses nothing. It is not derived: nothing else on disk remembers that a
 * book was removed once the fortnight of trash is up. And `notePresence` is a
 * read-modify-write of the WHOLE file, so a momentary read failure or a
 * truncated file read as no removals and the next removal wrote `{ that one
 * book }` over all the rest. A satchel that was in a drawer then re-uploads
 * the books the reader deleted — the deletion that resurrects, which the
 * header above names as the thing this file exists to prevent. Found by the
 * 2026-09-13 audit.
 *
 * `isMissingFile` is the distinction, as it is in `readBook`: a book that is
 * not there, told apart from a read that FAILED, on the message alone —
 * Tauri's fs errors carry no code. `journalDigests` already said in a comment
 * that this throws; it does now.
 */
export async function readPresence(fs: VaultFs): Promise<Presence> {
  let raw: string
  try {
    raw = new TextDecoder().decode(await fs.readFile(PRESENCE_PATH))
  } catch (cause) {
    if (isMissingFile(cause)) return {}
    throw cause
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error('the presence register is not JSON', { cause })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the presence register is not a record of books')
  }
  const presence: Record<string, PresenceEntry> = Object.create(null) as Record<string, PresenceEntry>
  for (const key of Object.keys(parsed)) {
    if (key === '') continue
    const value = (parsed as Record<string, unknown>)[key]
    if (
      value === null ||
      Array.isArray(value) ||
      // Stryker disable next-line ConditionalExpression: a string, number or boolean has no `state`, so the test below drops it either way; `value === null` is the clause that decides, and it is a line of its own.
      typeof value !== 'object'
    ) {
      continue
    }
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
  /* ONLY A STRICTLY NEWER STAMP WRITES. An equal stamp with a DIFFERENT state
   * is a tie the register cannot order, and the held value wins because
   * rewriting on a tie would let two replicas flap; an equal stamp with the
   * SAME state is a repeat, and a no-op.
   *
   * ⚠️ **THIS WAS TWO TESTS, AND THE STATES IN THEM DECIDED NOTHING.** The first
   * refused a tie whose state differed, the second a tie whose state matched —
   * which is every tie, whatever the states. Mutation testing found that either
   * state comparison could be deleted and no test could tell, because nothing
   * could: one condition says what the two did. */
  if (held && held.at >= at) return false
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
  /* ⚠️ **EVERY STAMP THE RECORD CARRIES, FOUND RATHER THAN LISTED — AND THE
   * LIST WAS MISSING THREE.** `positionAt`, `finishedAt` and each tag's `at`
   * were named here by hand, while `status.at`, `ratingAt` and `review.at` were
   * not. This decides whether a live folder PREDATES the removal that names it,
   * so a record touched after the removal was written — a rating arriving from
   * a peer, a status set, a review typed — read as older than it was, and
   * `finishPendingRemovals` trashed a book the reader had just touched, taking
   * the newer value with it. Found by audit.
   *
   * A hand-written list is a list the next stamped field is left out of, and
   * that has now happened three times in one function. Every `Hlc` in the
   * record counts, wherever it sits, so the walk finds them: an HLC has a shape
   * nothing else in a record matches — a title, a CFI, an extension and an
   * origin are all refused by `isHlc` — and the record is JSON, so there is
   * nothing to cycle through. */
  for (const stamp of stampsIn(record, 0)) latest = laterHlc(latest, stamp)!
  return latest
}

/**
 * Every `Hlc` inside a record, however deeply it sits.
 *
 * Four levels because the deepest one is real: `tagClock` → the tag's object →
 * `at` is three from the record, and one more is the room for the next nested
 * group rather than a number chosen to look generous.
 */
function* stampsIn(value: unknown, depth: number): Generator<Hlc> {
  if (isHlc(value)) {
    yield value
    return
  }
  if (
    depth >= 4 ||
    value === null ||
    // Stryker disable next-line ConditionalExpression: a string, number or boolean holds no stamp at any depth, so this saves the walk and changes nothing it finds; the depth and `null` clauses are lines of their own.
    typeof value !== 'object'
  ) {
    return
  }
  for (const one of Object.values(value)) yield* stampsIn(one, depth + 1)
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
      /* A folder with no readable record still moves: there is nothing to
       * say it is newer than the removal, and the trash keeps it either way.
       *
       * ⚠️ **THE `catch` BELOW WOULD OTHERWISE SKIP IT.** `readBook` now
       * throws for a record that is present and damaged, and this loop's
       * catch-and-continue would turn that into "leave the folder alone" —
       * the opposite of what the line above promises. The weaker question is
       * asked explicitly: what matters here is whether anything says the book
       * is NEWER than the removal, and an unreadable record says nothing. */
      // Stryker disable next-line ArrowFunction: `undefined` and `null` are equally false to the one check that reads `record`.
      const record = await readBook(fs, bookId).catch(() => null)
      if (record && recordStamp(record) > entry.at) continue
      if (await trashBook(fs, bookId)) finished.push(bookId)
    } catch {
      /* ONE FOLDER THAT WILL NOT MOVE DOES NOT STOP THE OTHERS, and there is
         nothing else to do here: the catch ends the loop body, so the `continue`
         that used to stand in it was a step the loop took anyway. */
    }
  }
  return finished
}
