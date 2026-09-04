import {
  atomicWrite,
  mergeRelationship,
  newRelationship,
  personFolderIn,
  relationshipPathIn,
  type Hlc,
  type IndexFs,
  type Relationship,
  type VaultFs,
  type WriteQueue,
  hlcOf,
  isHlc,
} from '../../../kernel'
import { purgeForeign, type LaneFor } from './store'

/**
 * Where the reader's decisions about a person live — WI-23.C2 and C3, over
 * the record WI-22.E1 decided.
 *
 * `circle/<person>/relationship.json`: the `Relationship` record, one per
 * person, read-merge-written so two of this device's own writers converge
 * by `changedAt` exactly as two of the reader's DEVICES will once the row
 * rides the sync — which is WI-22.E1's remaining half and not this one's.
 * Until it does, a switch turned on the phone is on the phone.
 *
 * ## Absent is the default, not an error
 *
 * A person the peer names and no file speaks for is somebody the reader
 * paired with and has decided nothing about: admitted, first epoch, shelf
 * OFF. That is `newRelationship`, and it is what a read of nothing answers.
 * A file that is present and will not read THROWS, for `readForeign`'s
 * reason — read as the default it would turn a shelf switch off, silently,
 * which is the safe direction and still a lie about what the reader chose.
 */

/** The lane a person's own folder writes on. Not a book's: those are the library's. */
export const personLane = (person: string): string => personFolderIn(person)

/**
 * The stamp a record that does not exist carries: the beginning of time.
 *
 * ⚠️ **NOT THE CLOCK.** A default built at read time with the current stamp
 * merged as the NEWER word — a laptop that had merely never read the file
 * turned off a shelf the phone had explicitly turned on. A record nobody
 * wrote has decided nothing, and a stamp from before everything is what
 * loses to any decision at all.
 */
const UNDECIDED: Hlc = hlcOf(0)

export async function readRelationship(fs: VaultFs, person: string): Promise<Relationship> {
  const path = relationshipPathIn(person)
  if (!(await fs.exists(path))) return newRelationship(person, UNDECIDED)
  const parsed: unknown = JSON.parse(new TextDecoder().decode(await fs.readFile(path)))
  const held = readRecord(parsed, person)
  if (held === null) throw new Error(`the relationship file for ${person} will not read`)
  return held
}

/**
 * Write a record, merged with whatever is on disk by `changedAt` — so a
 * writer holding a stale copy cannot put an older decision back over a
 * newer one. On the person's lane, so a purge cannot interleave with it.
 */
export async function writeRelationship(
  fs: VaultFs,
  queue: WriteQueue,
  record: Relationship,
): Promise<Relationship> {
  let kept = record
  await queue.append(personLane(record.person), async () => {
    const path = relationshipPathIn(record.person)
    if (await fs.exists(path)) {
      const held = readRecord(JSON.parse(new TextDecoder().decode(await fs.readFile(path))), record.person)
      /* A record that will not read is not overwritten: it may hold a newer
         decision than the one being written, and a decision about a person
         is not something to guess at. `readRelationship` refuses it the same
         way, so the reader is shown the file rather than a fresh default. */
      if (held === null) throw new Error(`the relationship file for ${record.person} will not read`)
      kept = mergeRelationship(held, record)
    }
    await atomicWrite(fs, path, new TextEncoder().encode(JSON.stringify(kept)))
  })
  return kept
}

/**
 * Drop everything one person sent, and everything decided about them — the
 * per-book files across every book, then the person's own folder.
 *
 * ⚠️ **AND IT PROMISES NOTHING ABOUT THE OTHER DIRECTION**, as `purgeForeign`
 * says: what they already received of yours is theirs. Idempotent, because a
 * reader removing somebody who sent nothing must not be told it failed.
 */
export async function purgePerson(
  fs: IndexFs,
  queue: WriteQueue,
  lane: LaneFor,
  person: string,
  books: readonly string[],
  changed: () => void,
): Promise<void> {
  /* EVERY step is attempted, and what failed is raised together at the end:
     one book's file refusing to go used to end the loop, leaving every later
     book's file and the person's folder on disk — a person half forgotten,
     with nothing saying which half. */
  const failures: unknown[] = []
  try {
    for (const bookId of books) {
      try {
        await purgeForeign(fs, queue, lane, bookId, person, () => {})
      } catch (cause) {
        failures.push(cause)
      }
    }
    try {
      await queue.append(personLane(person), async () => {
        const folder = personFolderIn(person)
        /* Stryker disable next-line ConditionalExpression: the platform's removeDir refuses a missing folder; the fake does not, so the guard cannot be observed here. */
        if (await fs.exists(folder)) await fs.removeDir(folder)
      })
    } catch (cause) {
      failures.push(cause)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `could not purge everything of ${person}: ${failures.length} of ${books.length + 1} steps failed`)
    }
  } finally {
    /* Told even when a step failed: what was removed before it is gone, and
       a screen holding the old overlays must not keep drawing them. */
    changed()
  }
}

const STATES = new Set(['admitted', 'muted', 'blocked', 'exited'])
const RETAINS = new Set(['keep', 'purge'])

/** A record of the shape `relationships.ts` decides, for THIS person, or null. */
function readRecord(value: unknown, person: string): Relationship | null {
  /* Stryker disable next-line ConditionalExpression: a non-object has no `person` member, so the check below refuses it anyway. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const held = value as Record<string, unknown>
  /* Compared against the folder it came from, for `isForeignEntry`'s reason:
     the file is the authenticated statement of whom it is about. */
  if (held['person'] !== person) return null
  /* Stryker disable next-line ConditionalExpression: `has` answers false for anything that is not one of the words, strings included. */
  if (typeof held['state'] !== 'string' || !STATES.has(held['state'])) return null
  if (!Number.isSafeInteger(held['epoch']) || (held['epoch'] as number) < 1) return null
  if (!isHlc(held['admittedAt']) || !isHlc(held['changedAt'])) return null
  /* Stryker disable next-line ConditionalExpression: as above. */
  if (typeof held['retain'] !== 'string' || !RETAINS.has(held['retain'])) return null
  /* Absent on every record written before the switch existed — WI-23.C2 —
     and absent reads as OFF, the default: refusing the record would make a
     block or a purge throw over a file that is simply older than the field. */
  if (held['shelf'] !== undefined && typeof held['shelf'] !== 'boolean') return null
  if (held['shelfAt'] !== undefined && !isHlc(held['shelfAt'])) return null
  return {
    person,
    state: held['state'] as Relationship['state'],
    epoch: held['epoch'] as number,
    admittedAt: held['admittedAt'],
    changedAt: held['changedAt'],
    retain: held['retain'] as Relationship['retain'],
    shelf: held['shelf'] === true,
    /* A record from before the switch existed has decided nothing about it:
       stamped as undecided, so a decision taken on another device — however
       early — wins the merge. A record that has the switch but not its stamp
       reads the stamp as `changedAt`, the kernel's own fallback. */
    ...(held['shelfAt'] !== undefined ? { shelfAt: held['shelfAt'] } : held['shelf'] === undefined ? { shelfAt: UNDECIDED } : {}),
  }
}

