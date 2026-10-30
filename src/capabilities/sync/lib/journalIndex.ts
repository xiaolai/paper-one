import type { MutationKind } from '../../../kernel'
import type { JournalEntry } from './journalEntry'

/**
 * THE JOURNAL'S IN-MEMORY INDEX — what the file says, per `(book, what)`.
 *
 * Extracted from `createJournal`, which had grown past a thousand lines with
 * the parser, the durable writes, recovery, bootstrap, compaction and this
 * living in one closure. Its invariants are the ones every other half depends
 * on, and the hardest to reason about while they sit among file writes:
 *
 *   - a `begin` DANGLES until a commit naming it arrives;
 *   - a commit clears ONLY ITS OWN bracket, unless it names none;
 *   - `lastDigested` is the newest commit that can be COMPARED, which is not
 *     always the newest commit;
 *   - the next rev clears the ACK as well as the last commit.
 *
 * Every one of those was found the hard way, and each is stated beside the
 * line that keeps it. Nothing here touches a disk, so all of it is reachable
 * from a test with no filesystem at all.
 */

/** What the journal knows about one `(book, what)`. */
export interface KeyState {
  lastCommit?: JournalEntry
  /**
   * The most recent commit on this key that CARRIES a digest.
   *
   * Usually the same entry as `lastCommit`, and the two part exactly where it
   * matters: a recovery commit or a legacy line has no digest, and the verify
   * pass reads `last.digest === undefined` as "nothing to compare" and skips
   * the key. The keys that get a digestless head are precisely the ones that
   * crashed mid-write, so the check was blindest where it was needed most.
   */
  lastDigested?: JournalEntry
  lastLocalCommit?: JournalEntry
  lastRev: number
  lastAckedRev: number
  lastAcked?: JournalEntry
  /** Begins with no commit yet, in seq order. */
  dangling: JournalEntry[]
}

/**
 * The rev a NEW local commit on this key should carry.
 *
 * PAST THE ACK, NOT MERELY PAST THE LAST COMMIT. `lastRev + 1` alone was wrong
 * wherever an ack sits ahead of the surviving commits, which loading
 * explicitly permits: `compact` keeps the last acked entry, so a journal can
 * carry `lastAckedRev` above any commit still in the file. A new local commit
 * allocated at `lastRev + 1` then landed at or below the ack, and `outbox`
 * skips exactly that (`local.rev <= lastAckedRev`) — so the edit was
 * journalled, looked committed, and was never offered to a peer again. Silent,
 * and permanent for that key.
 */
export const nextRev = (state: KeyState): number => Math.max(state.lastRev, state.lastAckedRev) + 1

export interface JournalIndex {
  /** Every entry absorbed, in seq order. */
  entries(): readonly JournalEntry[]
  /** The state for a key, created empty if this is the first sight of it. */
  keyState(key: string): KeyState
  /** Every key's state, for the passes that walk them all. */
  states(): IterableIterator<KeyState>
  /** How many keys are tracked — compaction's reduction test. */
  size(): number
  /** Fold one entry in. */
  absorb(entry: JournalEntry, key: string): void
  /** Forget everything, for a reload or a compaction. */
  clear(): void
}

export function createJournalIndex(): JournalIndex {
  let all: JournalEntry[] = []
  const byKey = new Map<string, KeyState>()

  const keyState = (key: string): KeyState => {
    let held = byKey.get(key)
    if (!held) {
      held = { lastRev: 0, lastAckedRev: 0, dangling: [] }
      byKey.set(key, held)
    }
    return held
  }

  return {
    entries: () => all,
    keyState,
    states: () => byKey.values(),
    size: () => byKey.size,
    clear: () => {
      all = []
      byKey.clear()
    },
    absorb: (entry, key) => {
      all.push(entry)
      const state = keyState(key)
      if (entry.kind === 'begin') {
        state.dangling.push(entry)
      } else if (entry.kind === 'commit') {
        state.lastCommit = entry
        if (entry.digest !== undefined) state.lastDigested = entry
        if (entry.origin === 'local') state.lastLocalCommit = entry
        state.lastRev = Math.max(state.lastRev, entry.rev ?? 0)
        /* ONLY ITS OWN BRACKET. Brackets on one key can overlap, and a commit
         * that swept the key's every dangling begin dropped a write still in
         * flight from the crash record. A commit with no begin ref (baseline,
         * verify, a legacy line) still clears whole — those commit the key's
         * observed state, not one bracket. */
        state.dangling =
          entry.begin === undefined ? [] : state.dangling.filter((begin) => begin.seq !== entry.begin)
      } else {
        /* NOT validated against the key's commit revs, deliberately: crash
         * recovery renumbers revisions (a dropped tail, legacy cards lines),
         * so an ack honestly ahead of the surviving commits is a state the
         * crash suite REQUIRES loading — the outbox's CAS is what keeps a
         * live ack honest. */
        if ((entry.rev ?? 0) >= state.lastAckedRev) {
          state.lastAckedRev = entry.rev ?? 0
          state.lastAcked = entry
        }
      }
    },
  }
}

/** A `MutationKind` is part of a key; the book is the rest. */
export type { MutationKind }
