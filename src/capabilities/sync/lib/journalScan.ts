import { JournalCorruption, entryOf, isValidJsonPrefix, keyOf, type JournalEntry } from './journalEntry'

/**
 * READING A JOURNAL FILE — the whole of what its TEXT has to satisfy, with no
 * filesystem anywhere near it.
 *
 * Lifted out of `createJournal`, which had grown past a thousand lines. This
 * is the half that decides whether a file is a journal at all, and every rule
 * in it was written after something went wrong:
 *
 *   - a torn TAIL is a crash artefact and is dropped; the same bytes anywhere
 *     else are corruption, because a crash leaves a PREFIX;
 *   - complete JSON that is not an entry is corruption wherever it sits;
 *   - seq strictly increases, one epoch throughout, commit and ack revs rise
 *     per key — a journal violating any of them cannot serve a feed that
 *     agrees with itself;
 *   - a commit's `begin` must not name another key's bracket, or one already
 *     closed;
 *   - legacy `cards` revs are RENUMBERED rather than refused, because
 *     canonicalising them onto one key collapses streams that once had their
 *     own numbering.
 *
 * Being a pure function of the text, every one of those is now reachable from
 * a test that writes a string — rather than through a filesystem fake, an
 * open, and whatever else the closure needed.
 */

export interface ScannedJournal {
  /** The entries to absorb, in order, with legacy revs renumbered. */
  readonly entries: readonly JournalEntry[]
  /** The single epoch the file names, or null when it holds no entries. */
  readonly epoch: string | null
  /** A torn last line was dropped — the file must be rewritten before append. */
  readonly torn: boolean
  /** A rev was renumbered — the file must be rewritten so it is paid once. */
  readonly repaired: boolean
}

/** Read a journal file's text, or throw `JournalCorruption` naming the line. */
export function scanJournal(text: string): ScannedJournal {
  const absorbed: JournalEntry[] = []
  const absorb = (entry: JournalEntry): void => void absorbed.push(entry)
    let torn = false
    let repaired = false
    const lines = text.split('\n')
    /* The load-time invariants (#4): one epoch — the same one `meta` names —
     * strictly-increasing seq, strictly-increasing commit and ack revs per
     * key. A journal violating them is not a crash artefact — a crash leaves
     * a PREFIX, and a prefix of a valid journal holds all three — it is
     * corruption, and deriving `nextSeq` from it would serve a feed that
     * disagrees with itself. */
    let lastSeq = 0
    let epoch: string | null = null
    const commitRev = new Map<string, number>()
    const ackedRev = new Map<string, number>()
    /**
     * The begins this load has SEEN, by seq, and the ones a commit has closed.
     *
     * `entryOf` can only check a reference against its own line, so all it
     * asks is `begin < seq`. That let a commit point at a begin belonging to
     * another book, another surface, another origin — or at one already
     * closed, or at nothing at all. The consequence is not cosmetic: `absorb`
     * clears a bracket by matching `begin.seq` WITHIN THE KEY, so a
     * misdirected reference leaves the real begin dangling forever. A key
     * with a permanently dangling begin is read as an unfinished write on
     * every open, which is what drives recovery and the verify pass.
     *
     * An ABSENT begin is accepted, and that is not laxity: `compact` keeps a
     * settled bracket's commit and drops its begin, so a compacted journal
     * legitimately holds commits whose begins are gone. What is refused is a
     * reference that is present and DISAGREES, or one used twice — neither of
     * which any writer or compaction produces.
     */
    const begins = new Map<number, JournalEntry>()
    const settled = new Set<number>()
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (line === '') continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        /* INCOMPLETE JSON, LAST LINE ONLY, AND ONLY A REAL PREFIX. A crash
         * mid-append truncates the tail into a strict byte-prefix of a
         * serialised entry; bytes that do not parse with valid lines AFTER
         * them, or bytes that are not even a valid JSON prefix, are
         * corruption — tolerating either would serve a feed with a hole in
         * it, or erase a line the disk actually holds. */
        const isTail = lines.slice(i + 1).every((rest) => rest === '')
        if (!isTail) throw new JournalCorruption(`journal: malformed line ${i + 1} is not the tail`)
        if (!isValidJsonPrefix(line)) {
          throw new JournalCorruption(`journal: malformed last line ${i + 1} is not a valid entry prefix`)
        }
        torn = true
        break
      }
      let entry = entryOf(raw)
      if (entry === null) {
        /* COMPLETE JSON that is not an entry. A torn append cannot leave
         * this — a byte prefix of `{...}` either fails to parse or IS the
         * whole line — so it is corruption wherever it sits, tail included. */
        throw new JournalCorruption(`journal: line ${i + 1} is complete but not a journal entry`)
      }
      if (entry.seq <= lastSeq) {
        throw new JournalCorruption(`journal: seq ${entry.seq} at line ${i + 1} does not increase past ${lastSeq}`)
      }
      lastSeq = entry.seq
      if (epoch === null) epoch = entry.epoch
      else if (entry.epoch !== epoch) {
        throw new JournalCorruption(`journal: line ${i + 1} names a second epoch`)
      }
      const key = keyOf(entry.book, entry.what)
      if (entry.kind === 'begin') begins.set(entry.seq, entry)
      if (entry.kind === 'commit' && entry.begin !== undefined) {
        if (settled.has(entry.begin)) {
          throw new JournalCorruption(
            `journal: line ${i + 1} commits begin ${entry.begin}, which an earlier commit already closed`,
          )
        }
        const opened = begins.get(entry.begin)
        if (opened !== undefined) {
          if (keyOf(opened.book, opened.what) !== key) {
            throw new JournalCorruption(
              `journal: line ${i + 1} commits begin ${entry.begin}, which belongs to a different book or surface`,
            )
          }
          if (opened.epoch !== entry.epoch || opened.origin !== entry.origin) {
            throw new JournalCorruption(
              `journal: line ${i + 1} commits begin ${entry.begin} under a different epoch or origin`,
            )
          }
        }
        settled.add(entry.begin)
      }
      if (entry.kind === 'commit') {
        const prev = commitRev.get(key) ?? 0
        if (entry.rev! <= prev) {
          /* CARDS ARE ONE STREAM MADE OF MANY. A legacy journal recorded
           * cards under the caller's book id; canonicalising them to `''`
           * here collapses those streams onto one, and their once-separate
           * revs now collide. Renumber onto a monotone tail rather than
           * refuse to open, and rewrite so the migration is paid once. Every
           * other key colliding is genuine corruption. */
          if (entry.what !== 'cards') {
            throw new JournalCorruption(`journal: commit rev ${entry.rev} at line ${i + 1} regresses its key`)
          }
          entry = { ...entry, rev: prev + 1 }
          repaired = true
        }
        commitRev.set(key, entry.rev!)
      } else if (entry.kind === 'acked') {
        const prev = ackedRev.get(key) ?? 0
        if (entry.rev! <= prev) {
          if (entry.what !== 'cards') {
            throw new JournalCorruption(`journal: ack rev ${entry.rev} at line ${i + 1} regresses its key`)
          }
          entry = { ...entry, rev: prev + 1 }
          repaired = true
        }
        ackedRev.set(key, entry.rev!)
      }
      absorb(entry)
    }
  return { entries: absorbed, epoch, torn, repaired }
}
