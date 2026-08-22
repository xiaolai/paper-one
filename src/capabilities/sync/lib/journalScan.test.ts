import { describe, expect, it } from 'vitest'
import { JournalCorruption, keyOf } from './journalEntry'
import { createJournalIndex, nextRev } from './journalIndex'
import { scanJournal } from './journalScan'

/**
 * READING A JOURNAL FILE, AS A PURE FUNCTION OF ITS TEXT.
 *
 * These rules used to live inside `createJournal`, so reaching any of them
 * meant a filesystem fake, an `open`, and whatever else the closure needed —
 * which is why the ones below were covered only where some other test happened
 * to walk past them. A string in, entries or a refusal out.
 */

const AT = '018f00000000-0001-abcdefabcdefabcd'

/**
 * One serialised line. `rev: undefined` DROPS the field rather than writing a
 * null — a begin carrying a rev is corruption by `entryOf`'s own rule, so a
 * fixture that wrote one would be testing the wrong refusal.
 */
const line = (over: Record<string, unknown> & { seq: number }): string => {
  const entry: Record<string, unknown> = {
    kind: 'commit',
    epoch: 'e1',
    book: 'book:a',
    what: 'record',
    at: AT,
    origin: 'local',
    rev: over.seq,
    ...over,
  }
  for (const [key, value] of Object.entries(entry)) if (value === undefined) delete entry[key]
  return JSON.stringify(entry)
}

const file = (...lines: string[]): string => `${lines.join('\n')}\n`

describe('an ordinary journal', () => {
  it('reads its entries in order and names its epoch', () => {
    const scanned = scanJournal(file(line({ seq: 1 }), line({ seq: 2, rev: 2 })))
    expect(scanned.entries.map((one) => one.seq)).toEqual([1, 2])
    expect(scanned.epoch).toBe('e1')
    expect(scanned.torn).toBe(false)
    expect(scanned.repaired).toBe(false)
  })

  it('reads an empty file as no entries and no epoch', () => {
    expect(scanJournal('')).toMatchObject({ entries: [], epoch: null, torn: false, repaired: false })
  })

  it('ignores blank lines rather than reading them as entries', () => {
    expect(scanJournal(`\n${line({ seq: 1 })}\n\n`).entries).toHaveLength(1)
  })
})

/**
 * A TORN TAIL IS A CRASH ARTEFACT; THE SAME BYTES ANYWHERE ELSE ARE NOT.
 *
 * A crash mid-append truncates the LAST line into a strict byte-prefix of a
 * serialised entry. Bytes that do not parse with valid lines after them, or
 * bytes that are not even a valid JSON prefix, are corruption — tolerating
 * either would serve a feed with a hole in it, or erase a line the disk holds.
 */
describe('a truncated line', () => {
  it('drops a torn last line and says the file needs rewriting', () => {
    const scanned = scanJournal(`${line({ seq: 1 })}\n{"seq":2,"kind":"comm`)
    expect(scanned.entries.map((one) => one.seq)).toEqual([1])
    expect(scanned.torn).toBe(true)
  })

  it('refuses a malformed line that is NOT the tail', () => {
    expect(() => scanJournal(file('{"seq":2,"kind":"comm', line({ seq: 3 })))).toThrow(JournalCorruption)
    expect(() => scanJournal(file('{"seq":2,"kind":"comm', line({ seq: 3 })))).toThrow(/not the tail/)
  })

  it('refuses a last line that is not even a valid JSON prefix', () => {
    /* `[01]` is digits and a bracket, and no completion makes it valid JSON —
     * so it is a corrupt last line, which is the reader's most recent write,
     * and must be kept and quarantined rather than silently discarded. */
    expect(() => scanJournal(`${line({ seq: 1 })}\n[01]`)).toThrow(/not a valid entry prefix/)
  })

  /* COMPLETE JSON THAT IS NOT AN ENTRY is corruption wherever it sits — a
   * torn append cannot leave it, because a byte prefix of `{...}` either fails
   * to parse or IS the whole line. */
  it('refuses complete JSON that is not a journal entry, tail included', () => {
    expect(() => scanJournal(file(line({ seq: 1 }), '{"seq":2}'))).toThrow(/complete but not a journal entry/)
  })
})

describe('the load-time invariants', () => {
  it('refuses a seq that does not increase', () => {
    expect(() => scanJournal(file(line({ seq: 2 }), line({ seq: 2 })))).toThrow(/does not increase past/)
    expect(() => scanJournal(file(line({ seq: 2 }), line({ seq: 1 })))).toThrow(/does not increase past/)
  })

  it('refuses a second epoch', () => {
    expect(() => scanJournal(file(line({ seq: 1 }), line({ seq: 2, epoch: 'e2' })))).toThrow(/second epoch/)
  })

  it('refuses a commit rev that regresses its key', () => {
    expect(() => scanJournal(file(line({ seq: 1, rev: 5 }), line({ seq: 2, rev: 5 })))).toThrow(/commit rev/)
  })

  it('refuses an ack rev that regresses its key', () => {
    const ack = (seq: number, rev: number) => line({ seq, rev, kind: 'acked' })
    expect(() => scanJournal(file(ack(1, 5), ack(2, 5)))).toThrow(/ack rev/)
  })

  /* PER KEY, not across the file. Two books' revs are unrelated, and a check
   * that compared them would refuse an ordinary journal. */
  it('lets two keys carry the same revs', () => {
    const scanned = scanJournal(file(line({ seq: 1, rev: 1 }), line({ seq: 2, book: 'book:b', rev: 1 })))
    expect(scanned.entries).toHaveLength(2)
  })
})

/**
 * CARDS ARE ONE STREAM MADE OF MANY.
 *
 * A legacy journal recorded cards under the caller's book id; canonicalising
 * them to `''` collapses those streams onto one, and their once-separate revs
 * now collide. Renumber onto a monotone tail rather than refuse to open — and
 * say the file needs rewriting, so the migration is paid once.
 */
describe('legacy cards revs', () => {
  const cards = (seq: number, book: string, rev: number) => line({ seq, book, what: 'cards', rev })

  it('renumbers a collision rather than refusing the file', () => {
    const scanned = scanJournal(file(cards(1, 'book:a', 1), cards(2, 'book:b', 1)))
    expect(scanned.entries.map((one) => one.rev)).toEqual([1, 2])
    expect(scanned.repaired).toBe(true)
    /* And they are one key now. */
    expect(new Set(scanned.entries.map((one) => one.book))).toEqual(new Set(['']))
  })

  it('refuses the same collision on any other surface', () => {
    expect(() => scanJournal(file(line({ seq: 1, rev: 1 }), line({ seq: 2, rev: 1 })))).toThrow(/commit rev/)
  })
})

/**
 * A COMMIT'S `begin` REFERENCE, CHECKED AGAINST THE FILE.
 *
 * Per-line validation can only ask `begin < seq`. That let a commit point at a
 * begin belonging to another book, another surface, another origin — or at one
 * already closed. The index clears a bracket by matching the seq WITHIN the
 * key, so a misdirected reference leaves the real begin dangling for good.
 */
describe('a commit that references a begin it does not own', () => {
  const begin = (seq: number, over: Record<string, unknown> = {}) => line({ seq, kind: 'begin', rev: undefined, ...over })

  it('accepts a reference to its own open bracket', () => {
    expect(scanJournal(file(begin(1), line({ seq: 2, begin: 1 }))).entries).toHaveLength(2)
  })

  it('refuses a reference to another key’s begin', () => {
    expect(() => scanJournal(file(begin(1, { book: 'book:b' }), line({ seq: 2, begin: 1 })))).toThrow(
      /different book or surface/,
    )
  })

  it('refuses a reference an earlier commit already closed', () => {
    expect(() => scanJournal(file(begin(1), line({ seq: 2, begin: 1 }), line({ seq: 3, rev: 3, begin: 1 })))).toThrow(
      /already closed/,
    )
  })

  it('refuses a reference whose begin disagrees about origin', () => {
    expect(() => scanJournal(file(begin(1, { origin: 'remote' }), line({ seq: 2, begin: 1 })))).toThrow(
      /different epoch or origin/,
    )
  })

  /**
   * AN ABSENT BEGIN IS ACCEPTED, and that is not laxity: `compact` keeps a
   * settled bracket's commit and drops its begin, so a compacted journal
   * legitimately holds commits whose begins are gone. A rule demanding the
   * begin be present would refuse to open every compacted journal there is.
   */
  it('accepts a commit whose begin was compacted away', () => {
    expect(scanJournal(file(line({ seq: 2, begin: 1 }))).entries).toHaveLength(1)
  })
})

/**
 * THE IN-MEMORY INDEX, over what the scan produced.
 *
 * Its four invariants, each stated where it is kept and none of them reachable
 * before the split without a filesystem and an open.
 */
describe('the index', () => {
  const fold = (text: string) => {
    const index = createJournalIndex()
    for (const entry of scanJournal(text).entries) index.absorb(entry, keyOf(entry.book, entry.what))
    return index
  }

  it('holds a begin as dangling until its own commit arrives', () => {
    const open = fold(file(line({ seq: 1, kind: 'begin', rev: undefined })))
    expect(open.keyState(keyOf('book:a', 'record')).dangling).toHaveLength(1)

    const closed = fold(file(line({ seq: 1, kind: 'begin', rev: undefined }), line({ seq: 2, begin: 1 })))
    expect(closed.keyState(keyOf('book:a', 'record')).dangling).toEqual([])
  })

  /* A COMMIT WITH NO BEGIN REF clears the key WHOLE — those commit the key's
   * observed state, not one bracket. */
  it('clears every bracket for a commit that names none', () => {
    const index = fold(
      file(
        line({ seq: 1, kind: 'begin', rev: undefined }),
        line({ seq: 2, kind: 'begin', rev: undefined }),
        line({ seq: 3, rev: 3 }),
      ),
    )
    expect(index.keyState(keyOf('book:a', 'record')).dangling).toEqual([])
  })

  /**
   * `lastDigested` IS NOT ALWAYS `lastCommit`.
   *
   * A recovery commit or a legacy line has no digest, and the verify pass
   * reads a digestless head as "nothing to compare" and skips the key — so the
   * check was blindest on exactly the keys that crashed mid-write.
   */
  it('remembers the newest commit that can be compared', () => {
    const index = fold(file(line({ seq: 1, digest: 'd1' }), line({ seq: 2, rev: 2 })))
    const state = index.keyState(keyOf('book:a', 'record'))
    expect(state.lastCommit?.seq).toBe(2)
    expect(state.lastDigested?.seq).toBe(1)
  })

  /**
   * THE NEXT REV CLEARS THE ACK, NOT ONLY THE LAST COMMIT.
   *
   * `compact` keeps the last acked entry, so a journal can carry
   * `lastAckedRev` above any commit still in the file. A new local commit at
   * `lastRev + 1` then landed at or below the ack, and `outbox` skips exactly
   * that — so the edit was journalled, looked committed, and was never offered
   * to a peer again.
   */
  it('allocates a rev past the ack as well as past the last commit', () => {
    const index = fold(file(line({ seq: 1, rev: 1 }), line({ seq: 2, rev: 9, kind: 'acked' })))
    const state = index.keyState(keyOf('book:a', 'record'))
    expect(state.lastRev).toBe(1)
    expect(state.lastAckedRev).toBe(9)
    expect(nextRev(state)).toBe(10)
  })
})
