import { describe, expect, it } from 'vitest'
import { makeHlc, type Hlc } from './clock'
import { JOURNAL_DIRTY_PATH, createJournal, type Journal } from './journal'
import { crashableFs, type CrashableFs } from './journalFs.testkit'
import { parseRecord, writeQueue, type BookRecord } from '../../../kernel'
import { recordDigest } from './merge'

/**
 * WHAT A SECOND WRITER COSTS THE JOURNAL — measured, for WI-11.5.
 *
 * The plan's open question is what happens when something other than the app
 * writes into one library. `journal.ts` has CAS on `rev` and `writeQueue.ts`
 * serialises writes WITHIN a process; nothing coordinates two processes. The
 * plan's answer is an advisory lock and a plain statement that the daemon is
 * the eventual one — and it says, in as many words, "do not widen the
 * journal's assumptions quietly to make a second writer appear to work".
 *
 * So this file does not widen anything. It MEASURES the consequence, because
 * a limitation that is reasoned about rather than observed is a limitation
 * somebody will later assume away:
 *
 *   after a CLEAN shutdown, the next open runs neither `bootstrap` (the meta
 *   says `ready`) nor `verifyAfterUncleanShutdown` (the dirty flag is gone).
 *   A record changed behind the journal's back in that window is therefore
 *   invisible to it: no commit, no new rev, and the journal's account of that
 *   book stays one revision behind the folder with nothing anywhere saying so.
 *
 * WHAT THIS MEASURES NOW, and what changed under it.
 *
 * These cases were written when `paper` never journalled at all: every CLI
 * write went behind the journal's back, and the point was to measure what
 * that cost. Both halves of the mechanism are still true and still worth
 * pinning — a clean-closed journal notices nothing, an unclean one squares it
 * on the next open — but the CLI no longer takes that path by choice.
 *
 * `paper` journals a write whenever no Paper process holds the library, and
 * REFUSES the write outright when one does (`src/cli/paper.ts`): a mutation
 * that lands on disk and can never replicate is not something to do quietly
 * behind a warning. So the "second writer" here stands for the cases the CLI
 * can no longer create on purpose — another tool, an editor, a restore from
 * backup — which is exactly why the journal still has to survive them.
 *
 * `dev-docs/cli.md` states the same thing, and the two must be read together: if
 * this comment and that document ever disagree, one of them is describing a
 * version of the CLI that no longer exists.
 */

const DEV = 'a1b2c3d4e5f60718'

function testClock(): () => Hlc {
  let t = 0
  return () => makeHlc(++t, 0, DEV)
}

const record = (bookId: string, title: string): string =>
  JSON.stringify({ bookId, title, author: 'A', addedAt: 100 })

function shelf(): CrashableFs {
  return crashableFs({
    'books/book_aaaa/book.json': record('book:aaaa', 'Moby-Dick'),
    'books/book_aaaa/content.epub': 'bytes',
  })
}

function journalOver(fs: CrashableFs): Journal {
  return createJournal({ fs, queue: writeQueue(), clock: testClock(), fsync: (path) => fs.fsync(path) })
}

/** Commits for a book, in seq order — what the journal believes about it. */
const commitsFor = (journal: Journal, book: string): number =>
  journal.entries().filter((one) => one.kind === 'commit' && one.book === book).length

/**
 * AN OUT-OF-BAND WRITER — not the CLI.
 *
 * `paper` journals a write when no Paper process holds the library and
 * REFUSES it outright when one does, so it cannot create this situation on
 * purpose any more; `src/cli/journaling.test.ts` is where that behaviour is
 * held to its word, and this file must not be read as describing it. What is
 * modelled here is everything else that can write into a library folder —
 * another tool, an editor, a restore from backup, a sync client that is not
 * this one — and the question is what the journal knows afterwards.
 */
describe('an out-of-band writer, and what the journal does about it', () => {
  /**
   * A CHANGE MADE WHILE THE JOURNAL WAS CLEANLY CLOSED NEVER REACHES A PEER.
   *
   * This asserted that the outbox still held the BASELINE at its old rev and
   * called that "one revision stale". It is worse than stale, and the original
   * setup could not show it: the baseline was never ACKED, so that entry is
   * still pushable — and what it pushes is read from `book.json` AS IT NOW
   * STANDS. The peer would therefore receive the revised record under the OLD
   * revision number, which is a silent merge hazard rather than a missing
   * update.
   *
   * Acking the baseline first is what makes the claim checkable: with nothing
   * left to push, the change genuinely goes nowhere, and the emptiness of the
   * outbox is the assertion.
   */
  it('does not see a record changed while it was cleanly closed', async () => {
    const fs = shelf()
    const first = journalOver(fs)
    await first.open()
    const baseline = commitsFor(first, 'book:aaaa')
    expect(baseline).toBeGreaterThan(0)
    const revBefore = first.outbox().find((one) => one.book === 'book:aaaa' && one.what === 'record')?.rev
    expect(revBefore).toBeDefined()
    /* ACKED, so nothing is left pending. Without this the baseline entry stays
     * pushable and would carry the revised record under the old rev — the
     * hazard this test's own conclusion claimed did not exist. */
    expect(await first.ack('book:aaaa', 'record', revBefore as number)).toBe(true)
    expect(first.outbox().filter((one) => one.book === 'book:aaaa')).toEqual([])
    await first.close()
    /* Clean: the flag is down, and that is what the next open reads. */
    expect(await fs.exists(JOURNAL_DIRTY_PATH)).toBe(false)

    /* THE SECOND WRITER. A `paper book set` against this directory with the
     * app closed writes exactly this: a new `book.json`, and nothing else. */
    await fs.writeFile('books/book_aaaa/book.json', new TextEncoder().encode(record('book:aaaa', 'Moby-Dick, revised')))

    const second = journalOver(fs)
    await second.open()
    /* NOTHING NEW, AND NOTHING TO PUSH. `bootstrap` does not run (the meta
     * says ready) and the verify pass does not run (the shutdown was clean),
     * so the change is outside the journal's history entirely: no commit, and
     * an outbox with nothing in it for this book.
     *
     * That is the honest statement of the cost. The change is not merely late
     * — it is invisible, and stays invisible until something makes the journal
     * look at the folder again. */
    expect(commitsFor(second, 'book:aaaa')).toBe(baseline)
    expect(second.outbox().filter((one) => one.book === 'book:aaaa')).toEqual([])
    await second.close()
  })

  /**
   * AND THE HAZARD THE ACK ABOVE REMOVES, shown on purpose.
   *
   * With the baseline still unacked, the entry the journal offers a peer names
   * the OLD revision while the bytes it would send are the NEW ones — because
   * a push reads `book.json` as it now stands. A peer applying that sees a
   * revision it may already believe it has.
   */
  it('offers the revised record under the old revision when the baseline was never acked', async () => {
    const fs = shelf()
    const first = journalOver(fs)
    await first.open()
    const revBefore = first.outbox().find((one) => one.book === 'book:aaaa' && one.what === 'record')?.rev
    await first.close()

    await fs.writeFile('books/book_aaaa/book.json', new TextEncoder().encode(record('book:aaaa', 'Moby-Dick, revised')))

    const second = journalOver(fs)
    await second.open()
    const pending = second.outbox().find((one) => one.book === 'book:aaaa' && one.what === 'record')
    expect(pending?.rev).toBe(revBefore)
    /* The record a push would read is the revised one — the rev and the bytes
     * disagree, and nothing in the journal says so. */
    expect(new TextDecoder().decode(await fs.readFile('books/book_aaaa/book.json'))).toContain('revised')
    await second.close()
  })

  it('DOES square the same change after an unclean shutdown, through the verify pass', async () => {
    const fs = shelf()
    const first = journalOver(fs)
    await first.open()
    const baseline = commitsFor(first, 'book:aaaa')
    const revBefore = first.outbox().find((one) => one.book === 'book:aaaa' && one.what === 'record')?.rev

    /* No `close()`: the dirty flag stays up, which is exactly what a crash
     * leaves and is what the next open's verify pass keys on. */
    await fs.writeFile('books/book_aaaa/book.json', new TextEncoder().encode(record('book:aaaa', 'Moby-Dick, revised')))
    expect(await fs.exists(JOURNAL_DIRTY_PATH)).toBe(true)

    const second = journalOver(fs)
    await second.open()
    expect(commitsFor(second, 'book:aaaa')).toBeGreaterThan(baseline)
    /* And at a HIGHER rev, which is the difference that matters to a peer:
     * the journal has noticed, and what it will push describes the record as
     * it now stands. */
    const after = second.outbox().find((one) => one.book === 'book:aaaa' && one.what === 'record')
    expect(after?.rev).toBeGreaterThan(revBefore ?? 0)

    /* AND THE COMMIT DESCRIBES THE REVISED RECORD, not merely a later one.
     * A rev that rose says the journal noticed something; the digest is what
     * says it noticed THIS. Without it the assertion above is satisfied by any
     * re-commit at all, including one carrying the record as it was. */
    const revised = parseRecord(new TextDecoder().decode(await fs.readFile('books/book_aaaa/book.json')))
    expect(revised).not.toBeNull()
    const commit = second
      .entries()
      .filter((one) => one.kind === 'commit' && one.book === 'book:aaaa' && one.what === 'record')
      .at(-1)
    expect(commit?.digest).toBe(await recordDigest(revised as BookRecord))
    await second.close()
  })
})
