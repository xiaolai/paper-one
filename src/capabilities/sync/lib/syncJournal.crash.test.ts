import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { writeQueue } from '../../../kernel'
import { makeHlc } from './clock'
import { createJournal, type JournalEntry } from './journal'
import { crashableFs, fsOver, type CrashableFs } from './journalFs.testkit'

/**
 * THE CRASH-POINT STATE MACHINE. A scenario runs once, cleanly, over a fake
 * fs that logs every mutation and every fsync. Then, for EVERY op boundary K
 * and every durability policy — everything reached the disk; nothing
 * non-fsynced did; everything did but the last in-flight append kept only a
 * byte PREFIX — the files a crash at K could have left are reconstructed,
 * and a fresh journal is opened over them. Whatever the crash left, recovery
 * must produce a journal that holds the invariants below; there is no crash
 * point at which it may throw, lose an ack it acknowledged, resurrect a
 * dangling begin, or serve a feed that disagrees with itself.
 */

const DEV = 'a1b2c3d4e5f60718'

function journalOver(fs: CrashableFs, fsyncEvery = 2) {
  let t = 0
  return createJournal({
    fs,
    queue: writeQueue(),
    clock: () => makeHlc(++t, 0, DEV),
    fsync: (path) => fs.fsync(path),
    fsyncEvery,
    cards: () => [
      { id: 'c1', bookId: 'book:aaaa', kind: 'Excerpt', body: 'x', answer: '', source: '', cfi: null, createdAt: 700 },
    ],
  })
}

const SHELF = {
  'books/book_aaaa/book.json': JSON.stringify({ bookId: 'book:aaaa', title: 'Moby-Dick', author: 'M', addedAt: 100 }),
  'books/book_bbbb/book.json': JSON.stringify({ bookId: 'book:bbbb', title: 'Walden', author: 'T', addedAt: 200 }),
  'trash/book_cccc/book.json': JSON.stringify({ bookId: 'book:cccc', title: 'Gone', author: '' }),
  'trash/book_cccc/.removed': '5000',
}

/** The invariants every recovered journal must hold, whatever the crash left. */
async function holdsInvariants(view: Map<string, Uint8Array>): Promise<void> {
  const fs = fsOver(view)
  const journal = journalOver(fs)
  await journal.open() // MUST not throw: recovery is total over crash states
  const entries = journal.entries()

  // Seq is strictly increasing, and every entry names the one epoch.
  const epochs = new Set(entries.map((e) => e.epoch))
  expect(epochs.size).toBeLessThanOrEqual(1)
  for (let i = 1; i < entries.length; i++) {
    expect(entries[i]!.seq).toBeGreaterThan(entries[i - 1]!.seq)
  }

  // No begin dangles after recovery: each key's last begin has a later commit.
  const lastBegin = new Map<string, number>()
  const lastCommit = new Map<string, number>()
  const lastLocal = new Map<string, JournalEntry>()
  const lastAcked = new Map<string, number>()
  const revs = new Map<string, number>()
  for (const entry of entries) {
    const key = `${entry.what} ${entry.book}`
    if (entry.kind === 'begin') lastBegin.set(key, entry.seq)
    if (entry.kind === 'commit') {
      lastCommit.set(key, entry.seq)
      if (entry.origin === 'local') lastLocal.set(key, entry)
      // Revs never move backwards within a key.
      expect(entry.rev!).toBeGreaterThan(revs.get(key) ?? 0)
      revs.set(key, entry.rev!)
    }
    if (entry.kind === 'acked') lastAcked.set(key, Math.max(lastAcked.get(key) ?? 0, entry.rev!))
  }
  for (const [key, beginSeq] of lastBegin) {
    expect(lastCommit.get(key) ?? -1, `dangling begin for ${key}`).toBeGreaterThan(beginSeq)
  }

  // An ack acknowledges revs the journal actually reached, and an acked
  // mutation's key is in the feed (its state is served, not forgotten).
  const feed = journal.feed(0, journal.head())
  const feedKeys = new Set(feed.map((e) => `${e.what} ${e.book}`))
  for (const [key, acked] of lastAcked) {
    expect(acked).toBeLessThanOrEqual(revs.get(key) ?? 0)
    expect(feedKeys.has(key), `acked ${key} missing from the feed`).toBe(true)
  }

  // The outbox claims exactly the unacked local heads.
  for (const out of journal.outbox()) {
    const key = `${out.what} ${out.book}`
    expect(lastLocal.get(key)?.rev).toBe(out.rev)
    expect(out.rev).toBeGreaterThan(lastAcked.get(key) ?? 0)
  }

  // The feed serves the LAST commit per key, in seq order.
  for (let i = 1; i < feed.length; i++) expect(feed[i]!.seq).toBeGreaterThan(feed[i - 1]!.seq)
  for (const served of feed) {
    expect(served.seq).toBe(lastCommit.get(`${served.what} ${served.book}`))
  }

  // Replays are idempotent: close and reopen invents nothing new.
  await journal.close()
  const again = journalOver(fsOver(new Map(fs.store)))
  await again.open()
  expect(again.entries()).toEqual(entries)
}

/** One eventful session: bootstrap, local and remote commits, acks, a compaction. */
async function eventfulSession(fs: CrashableFs): Promise<void> {
  const journal = journalOver(fs)
  await journal.open()
  const commitOn = async (book: string, what: 'record' | 'marks', digest?: string) => {
    const token = await journal.begin(book, what)
    await journal.commit(token, digest)
  }
  await commitOn('book:aaaa', 'record', 'v-local-1')
  await journal.markRemote([{ book: 'book:bbbb', what: 'record' }], async () => {
    await commitOn('book:bbbb', 'record', 'v-remote-1')
  })
  await commitOn('book:aaaa', 'marks', 'm1')
  const mine = journal.outbox().find((e) => e.book === 'book:aaaa' && e.what === 'record')!
  await journal.ack('book:aaaa', 'record', mine.rev)
  await commitOn('book:aaaa', 'record', 'v-local-2')
  await journal.compact()
  await commitOn('book:bbbb', 'marks', 'm2')
  await journal.close()
}

describe('crash at every op boundary, under every durability policy', () => {
  it('recovery holds the invariants at every single point', async () => {
    const fs = crashableFs(SHELF)
    await eventfulSession(fs)
    expect(fs.ops.length).toBeGreaterThan(20) // the machine is not vacuous

    for (let k = 0; k < fs.ops.length; k++) {
      for (const policy of ['all', 'none', 'torn'] as const) {
        await holdsInvariants(fs.durableView(k, policy))
      }
    }
  }, 30_000)

  it('a torn tail of any proportion is survivable', async () => {
    const fs = crashableFs(SHELF)
    await eventfulSession(fs)
    const last = fs.ops.length - 1
    for (const tear of [0, 0.1, 0.33, 0.5, 0.9, 0.99]) {
      await holdsInvariants(fs.durableView(last, 'torn', tear))
    }
  })

  it('a deletion recorded in presence does not resurrect across any crash point', async () => {
    const fs = crashableFs(SHELF)
    await eventfulSession(fs)
    for (let k = 0; k < fs.ops.length; k++) {
      const view = fs.durableView(k, 'none')
      const reopened = fsOver(view)
      const journal = journalOver(reopened)
      await journal.open()
      /* Whatever the crash lost, once recovery has run the removal is back:
       * either the presence write survived, or the trash marker did and the
       * resumed bootstrap re-migrated it. The trash marker itself is never
       * deleted by the journal, which is what makes this recoverable. */
      const presence = reopened.store.get('sync/removed.json')
      expect(presence, `presence lost at op ${k} and not recovered`).toBeTruthy()
      const parsed = JSON.parse(new TextDecoder().decode(presence!)) as Record<string, { state: string }>
      expect(parsed['book:cccc']?.state).toBe('removed')
    }
  })
})

describe('seeded multi-operation properties', () => {
  type Step =
    | { readonly op: 'local'; readonly book: string; readonly what: 'record' | 'marks' }
    | { readonly op: 'remote'; readonly book: string; readonly what: 'record' | 'marks' }
    | { readonly op: 'ack'; readonly book: string; readonly what: 'record' | 'marks' }
    | { readonly op: 'compact' }

  const arbStep: fc.Arbitrary<Step> = fc.oneof(
    fc.record({
      op: fc.constantFrom('local' as const, 'remote' as const, 'ack' as const),
      book: fc.constantFrom('book:aaaa', 'book:bbbb', 'book:dddd'),
      what: fc.constantFrom('record' as const, 'marks' as const),
    }),
    fc.constant({ op: 'compact' as const }),
  )

  async function run(fs: CrashableFs, steps: readonly Step[]): Promise<void> {
    const journal = journalOver(fs)
    await journal.open()
    for (const step of steps) {
      if (step.op === 'compact') {
        await journal.compact()
      } else if (step.op === 'ack') {
        const head = journal.outbox().find((e) => e.book === step.book && e.what === step.what)
        if (head) await journal.ack(step.book, step.what, head.rev)
      } else if (step.op === 'remote') {
        await journal.markRemote([{ book: step.book, what: step.what }], async () => {
          const token = await journal.begin(step.book, step.what)
          await journal.commit(token)
        })
      } else {
        const token = await journal.begin(step.book, step.what)
        await journal.commit(token, `d${Math.random().toString(36).slice(2, 6)}`)
      }
    }
    await journal.close()
  }

  it('any step sequence, any crash point, any policy: the invariants hold', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbStep, { minLength: 1, maxLength: 12 }),
        fc.nat(),
        fc.constantFrom('all' as const, 'none' as const, 'torn' as const),
        fc.constantFrom(0, 0.25, 0.5, 0.8),
        async (steps, kSeed, policy, tear) => {
          const fs = crashableFs(SHELF)
          await run(fs, steps)
          const k = kSeed % fs.ops.length
          await holdsInvariants(fs.durableView(k, policy, tear))
        },
      ),
      { numRuns: 60 },
    )
  }, 60_000)

  it('remote provenance never leaks into the outbox across a crash', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arbStep, { minLength: 1, maxLength: 10 }), fc.nat(), async (steps, kSeed) => {
        const fs = crashableFs(SHELF)
        await run(fs, steps)
        const k = kSeed % fs.ops.length
        const journal = journalOver(fsOver(fs.durableView(k, 'all')))
        await journal.open()
        /* Every outbox entry must trace to a LOCAL commit — a remote row or
         * an ack that became pushable would echo a peer's change back at it. */
        const entries = journal.entries()
        for (const out of journal.outbox()) {
          const commit = entries.find(
            (e) => e.kind === 'commit' && e.book === out.book && e.what === out.what && e.rev === out.rev,
          )
          expect(commit?.origin).toBe('local')
        }
      }),
      { numRuns: 40 },
    )
  }, 60_000)
})
