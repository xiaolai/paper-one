import { describe, expect, it } from 'vitest'
import {
  NOOP_RECORDER,
  createKernelServices,
  writeQueue,
  type MutationRecorder,
} from '../../../kernel'
import { hlcOf, makeHlc, type Hlc } from './clock'
import {
  JOURNAL_DIRTY_PATH,
  JOURNAL_META_PATH,
  JOURNAL_PATH,
  createJournal,
  type Journal,
  type JournalEntry,
} from './journal'
import { crashableFs, journalLines, memoryStorage, type CrashableFs } from './journalFs.testkit'
import { recordDigest } from './merge'

const DEV = 'a1b2c3d4e5f60718'

/** A deterministic clock: strictly increasing, no wall time involved. */
function testClock() {
  let t = 0
  return () => makeHlc(++t, 0, DEV)
}

function journalOver(fs: CrashableFs, extra: { storage?: ReturnType<typeof memoryStorage>; fsyncEvery?: number } = {}) {
  return createJournal({
    fs,
    queue: writeQueue(),
    clock: testClock(),
    fsync: (path) => fs.fsync(path),
    ...(extra.fsyncEvery === undefined ? {} : { fsyncEvery: extra.fsyncEvery }),
    ...(extra.storage === undefined ? {} : { storage: extra.storage }),
  })
}

describe('open and close', () => {
  it('a fresh, empty root opens ready with a published epoch and a dirty flag; close clears it', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    expect(journal.state()).toBe('ready')
    expect(journal.epoch()).toBeTruthy()
    expect(await fs.exists(JOURNAL_DIRTY_PATH)).toBe(true)
    await journal.close()
    expect(await fs.exists(JOURNAL_DIRTY_PATH)).toBe(false)
    const meta = JSON.parse(new TextDecoder().decode(fs.store.get(JOURNAL_META_PATH)!)) as { state: string }
    expect(meta.state).toBe('ready')
  })

  it('refuses a begin before open — fail loud, not a silent hole in the feed', async () => {
    const journal = journalOver(crashableFs())
    await expect(journal.begin('book:a', 'record')).rejects.toThrow(/before open/)
  })
})

describe('the bracket: begin, commit, seq and rev', () => {
  it('appends one line per side, seq strictly increasing, rev per (book, what)', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()

    const t1 = await journal.begin('book:a', 'record')
    await journal.commit(t1, 'digest-1')
    const t2 = await journal.begin('book:a', 'record')
    await journal.commit(t2)
    const t3 = await journal.begin('book:a', 'marks')
    await journal.commit(t3)

    const entries = journal.entries()
    expect(entries.map((e) => e.kind)).toEqual(['begin', 'commit', 'begin', 'commit', 'begin', 'commit'])
    for (let i = 1; i < entries.length; i++) expect(entries[i]!.seq).toBeGreaterThan(entries[i - 1]!.seq)
    const commits = entries.filter((e) => e.kind === 'commit')
    expect(commits.map((e) => e.rev)).toEqual([1, 2, 1]) // per key, monotone
    expect(commits[0]!.digest).toBe('digest-1')
    expect(commits.every((e) => e.origin === 'local')).toBe(true)
    // And the lines are really in the file, one JSON per line.
    expect(journalLines(fs, JOURNAL_PATH)).toHaveLength(6)
  })
})

describe('load tolerance', () => {
  it('discards a truncated last line and carries on', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    const token = await journal.begin('book:a', 'record')
    await journal.commit(token)
    await journal.close()
    // Tear the tail mid-line, as a crash mid-append would.
    const held = fs.store.get(JOURNAL_PATH)!
    fs.store.set(JOURNAL_PATH, held.subarray(0, held.length - 7))

    const reopened = journalOver(fs)
    await reopened.open()
    // The torn commit is gone; its begin now dangles and was re-committed.
    const kinds = reopened.entries().map((e) => `${e.kind}:${e.book}`)
    expect(kinds).toEqual(['begin:book:a', 'commit:book:a'])
  })

  it('throws on a malformed line that is NOT the tail — that is corruption, not a crash', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    const token = await journal.begin('book:a', 'record')
    await journal.commit(token)
    await journal.close()
    const text = new TextDecoder().decode(fs.store.get(JOURNAL_PATH)!)
    const lines = text.split('\n')
    lines[0] = lines[0]!.slice(0, 10)
    fs.store.set(JOURNAL_PATH, new TextEncoder().encode(lines.join('\n')))

    await expect(journalOver(fs).open()).rejects.toThrow(/not the tail/)
  })

  it('commits a dangling begin with a fresh seq at load', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    await journal.begin('book:a', 'record') // crash here: no commit
    await journal.close()

    const reopened = journalOver(fs)
    await reopened.open()
    const commits = reopened.entries().filter((e) => e.kind === 'commit')
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({ book: 'book:a', what: 'record', rev: 1, origin: 'local' })
    expect(commits[0]!.seq).toBeGreaterThan(reopened.entries()[0]!.seq)
    // Idempotent: opening again invents nothing further.
    await reopened.close()
    const again = journalOver(fs)
    await again.open()
    expect(again.entries()).toEqual(reopened.entries())
  })
})

describe('the unclean-shutdown verify pass', () => {
  const REC = { bookId: 'book:a', title: 'Moby-Dick', author: 'Melville', addedAt: 50 }

  it('re-commits a (book, what) whose folder digest moved past its last commit', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    // The book lands after open, so the bootstrap has no say in this test.
    fs.store.set('books/book_a/book.json', new TextEncoder().encode(JSON.stringify(REC)))
    const token = await journal.begin('book:a', 'record')
    await journal.commit(token, await recordDigest(REC))
    // NOT closed — the dirty flag stays, as after a crash. The folder then
    // changes under the journal (the write the crash lost track of).
    const moved = { ...REC, finished: true }
    fs.store.set('books/book_a/book.json', new TextEncoder().encode(JSON.stringify(moved)))

    const reopened = journalOver(fs)
    await reopened.open()
    const commits = reopened.entries().filter((e) => e.kind === 'commit')
    expect(commits).toHaveLength(2)
    expect(commits[1]).toMatchObject({ book: 'book:a', what: 'record', rev: 2, origin: 'local' })
    expect(commits[1]!.digest).toBe(await recordDigest(moved))
  })

  it('re-commits nothing when the digests agree, and nothing after a CLEAN close', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    fs.store.set('books/book_a/book.json', new TextEncoder().encode(JSON.stringify(REC)))
    const token = await journal.begin('book:a', 'record')
    await journal.commit(token, await recordDigest(REC))

    const reopened = journalOver(fs) // dirty, digests equal
    await reopened.open()
    expect(reopened.entries().filter((e) => e.kind === 'commit')).toHaveLength(1)
    await reopened.close()

    fs.store.set('books/book_a/book.json', new TextEncoder().encode(JSON.stringify({ ...REC, finished: true })))
    const clean = journalOver(fs) // closed cleanly: no dirty flag, no verify
    await clean.open()
    expect(clean.entries().filter((e) => e.kind === 'commit')).toHaveLength(1)
  })
})

describe('origin — the echo fix', () => {
  it('stamps remote exactly the begins markRemote named, one shot each, FIFO', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()

    await journal.markRemote([{ book: 'book:a', what: 'record' }], async () => {
      const remote = await journal.begin('book:a', 'record')
      await journal.commit(remote)
      // A DIFFERENT key inside the window stays local.
      const local = await journal.begin('book:b', 'record')
      await journal.commit(local)
    })
    // And the SAME key after the window is local again.
    const after = await journal.begin('book:a', 'record')
    await journal.commit(after)

    const commits = journal.entries().filter((e) => e.kind === 'commit')
    expect(commits.map((e) => `${e.book}:${e.origin}`)).toEqual(['book:a:remote', 'book:b:local', 'book:a:local'])
  })

  it('clears an expectation the apply never consumed — a no-op row must not relabel the next local edit', async () => {
    const journal = journalOver(crashableFs())
    await journal.open()
    await journal.markRemote([{ book: 'book:a', what: 'record' }], async () => {
      /* The merge decided nothing moved: no begin at all. */
    })
    const token = await journal.begin('book:a', 'record')
    await journal.commit(token)
    expect(journal.entries().filter((e) => e.kind === 'commit')[0]!.origin).toBe('local')
  })
})

describe('feed, outbox, ack', () => {
  async function commitOn(journal: Journal, book: string, what: 'record' | 'marks', digest?: string): Promise<void> {
    const token = await journal.begin(book, what)
    await journal.commit(token, digest)
  }

  it('feed pages commits in (since, until], coalesced to the last per key', async () => {
    const journal = journalOver(crashableFs())
    await journal.open()
    await commitOn(journal, 'book:a', 'record', 'v1')
    await commitOn(journal, 'book:a', 'record', 'v2')
    await commitOn(journal, 'book:b', 'record', 'v1')

    const whole = journal.feed(0, journal.head())
    expect(whole.map((e) => [e.book, e.digest])).toEqual([
      ['book:a', 'v2'],
      ['book:b', 'v1'],
    ])
    // A bounded page sees what fell inside it, nothing more.
    const firstCommitSeq = journal.entries().find((e) => e.kind === 'commit')!.seq
    const early = journal.feed(0, firstCommitSeq)
    expect(early.map((e) => e.digest)).toEqual(['v1'])
    expect(journal.feed(journal.head(), journal.head())).toEqual([])
  })

  it('outbox lists local commits newer than the last ack; ack is a CAS on the exact rev', async () => {
    const journal = journalOver(crashableFs())
    await journal.open()
    await commitOn(journal, 'book:a', 'record')
    await commitOn(journal, 'book:b', 'marks')

    expect(journal.outbox().map((e) => `${e.what} ${e.book} r${e.rev}`)).toEqual(['record book:a r1', 'marks book:b r1'])

    // Acked: leaves the outbox.
    expect(await journal.ack('book:a', 'record', 1)).toBe(true)
    expect(journal.outbox().map((e) => e.book)).toEqual(['book:b'])
    // A second identical ack is a no-op, not an error.
    expect(await journal.ack('book:a', 'record', 1)).toBe(false)

    // The CAS: a newer local commit beats a stale ack, and the entry stays.
    await commitOn(journal, 'book:b', 'marks') // rev 2
    expect(await journal.ack('book:b', 'marks', 1)).toBe(false)
    expect(journal.outbox().map((e) => `${e.book} r${e.rev}`)).toEqual(['book:b r2'])
    expect(await journal.ack('book:b', 'marks', 2)).toBe(true)
    expect(journal.outbox()).toEqual([])
  })

  it('a remote commit is never pushable — but does not bury an unacked local one', async () => {
    const journal = journalOver(crashableFs())
    await journal.open()
    await commitOn(journal, 'book:a', 'record') // local, rev 1
    await journal.markRemote([{ book: 'book:a', what: 'record' }], async () => {
      await commitOn(journal, 'book:a', 'record') // remote, rev 2
    })
    // The local rev 1 is still unacked and still the thing to push.
    expect(journal.outbox()).toEqual([expect.objectContaining({ book: 'book:a', rev: 1 })])
    expect(await journal.ack('book:a', 'record', 1)).toBe(true)
    expect(journal.outbox()).toEqual([])

    // A key that only ever heard remote commits has nothing to push.
    await journal.markRemote([{ book: 'book:c', what: 'record' }], async () => {
      await commitOn(journal, 'book:c', 'record')
    })
    expect(journal.outbox()).toEqual([])
  })
})

describe('compaction', () => {
  it('keeps the last commit and ack per key and any dangling begin, and survives a reopen', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    for (let i = 0; i < 5; i++) {
      const token = await journal.begin('book:a', 'record')
      await journal.commit(token, `v${i + 1}`)
    }
    const marksToken = await journal.begin('book:a', 'marks')
    await journal.commit(marksToken, 'm1')
    await journal.ack('book:a', 'marks', 1)
    await journal.begin('book:b', 'record') // dangling at compaction time

    await journal.compact()
    const lines = journalLines(fs, JOURNAL_PATH) as JournalEntry[]
    expect(lines.map((e) => `${e.kind} ${e.what} ${e.book}`)).toEqual([
      'commit record book:a',
      'commit marks book:a',
      'acked marks book:a',
      'begin record book:b',
    ])
    expect(lines[0]!.digest).toBe('v5')

    // The compacted journal reloads into the same working state. Closed
    // first: an unclean shutdown would ALSO trigger the verify pass, which
    // is its own test above.
    await journal.close()
    const reopened = journalOver(fs)
    await reopened.open()
    // v5 and m1 as compacted; the dangling begin was recovered into a fresh
    // commit (no digest — nothing was measured) at the end of the file.
    expect(reopened.feed(0, reopened.head()).map((e) => e.digest)).toEqual(['v5', 'm1', undefined])
    expect(reopened.entries().filter((e) => e.kind === 'commit' && e.book === 'book:b')).toHaveLength(1)
  })
})

describe('bootstrap — building to ready over an existing shelf', () => {
  const shelf = () =>
    crashableFs({
      'books/book_aaaa/book.json': JSON.stringify({ bookId: 'book:aaaa', title: 'Moby-Dick', author: 'M', addedAt: 100 }),
      'books/book_aaaa/content.epub': 'bytes',
      'books/book_aaaa/marks.json': JSON.stringify([
        {
          id: 'm1',
          bookId: 'book:aaaa',
          cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:5)',
          sectionIndex: 0,
          text: 'passage',
          prefix: '',
          suffix: '',
          note: '',
          kind: 'highlight',
          chapter: 'One',
          createdAt: 900,
        },
      ]),
      'books/book_bbbb/book.json': JSON.stringify({ bookId: 'book:bbbb', title: 'Walden', author: 'T', addedAt: 200 }),
      'trash/book_cccc/book.json': JSON.stringify({ bookId: 'book:cccc', title: 'Gone', author: '' }),
      'trash/book_cccc/.removed': '5000',
    })

  const CARD = JSON.stringify([
    { id: 'c1', bookId: 'book:aaaa', kind: 'Excerpt', body: 'x', answer: '', source: '', cfi: null, createdAt: 700 },
  ])

  it('emits one local baseline commit per surface, with legacy stamps and digests, then publishes the epoch', async () => {
    const fs = shelf()
    const storage = memoryStorage({ 'paper.cards.v1': CARD })
    const journal = journalOver(fs, { storage })
    await journal.open()

    expect(journal.state()).toBe('ready')
    expect(journal.epoch()).toBeTruthy()
    const commits = journal.entries().filter((e) => e.kind === 'commit')
    const named = commits.map((e) => `${e.what} ${e.book}`)
    expect(named.sort()).toEqual([
      'cards ',
      'marks book:aaaa',
      'record book:aaaa',
      'record book:bbbb',
      'removed book:cccc',
    ])
    expect(commits.every((e) => e.origin === 'local')).toBe(true)
    // Legacy stamps: the record's addedAt, the newest mark's createdAt, the trash marker.
    const stampOf = (what: string, book: string) => commits.find((e) => `${e.what} ${e.book}` === `${what} ${book}`)!.at
    expect(stampOf('record', 'book:aaaa')).toBe(hlcOf(100))
    expect(stampOf('marks', 'book:aaaa')).toBe(hlcOf(900))
    expect(stampOf('removed', 'book:cccc')).toBe(hlcOf(5000))
    expect(commits.find((e) => e.what === 'marks')!.digest).toBeTruthy()
    // The trash marker became a presence entry — the register outlives the fortnight.
    const presence = JSON.parse(new TextDecoder().decode(fs.store.get('sync/removed.json')!)) as Record<string, { state: string; at: Hlc }>
    expect(presence['book:cccc']).toEqual({ state: 'removed', at: hlcOf(5000) })
  })

  it('killed mid-way it resumes: no duplicate baselines, the same epoch, ready only at the end', async () => {
    const fs = shelf()
    const storage = memoryStorage({ 'paper.cards.v1': CARD })
    // The kill: the underlying append starts failing after 2 lines.
    let appends = 0
    const append = fs.appendFile.bind(fs)
    fs.appendFile = async (path: string, bytes: Uint8Array) => {
      appends += 1
      if (appends > 2) throw new Error('killed')
      return append(path, bytes)
    }
    const journal = journalOver(fs, { storage })
    await expect(journal.open()).rejects.toThrow(/killed/)
    expect(journal.epoch()).toBeNull() // building: the epoch is not published
    const metaMidway = JSON.parse(new TextDecoder().decode(fs.store.get(JOURNAL_META_PATH)!)) as { epoch: string; state: string }
    expect(metaMidway.state).toBe('building')

    // The next launch: the fs behaves again, the build resumes.
    fs.appendFile = append
    const resumed = journalOver(fs, { storage })
    await resumed.open()
    expect(resumed.state()).toBe('ready')
    expect(resumed.epoch()).toBe(metaMidway.epoch) // the SAME epoch, kept across the kill
    const commits = resumed.entries().filter((e) => e.kind === 'commit')
    // One baseline per surface — nothing emitted twice across the two runs.
    expect(commits.map((e) => `${e.what} ${e.book}`).sort()).toEqual([
      'cards ',
      'marks book:aaaa',
      'record book:aaaa',
      'record book:bbbb',
      'removed book:cccc',
    ])
  })
})

/* ------------------------------------------------------------------------ */
/* The kernel's writers, through the REAL journal                           */
/* ------------------------------------------------------------------------ */

const REC = { title: 'Moby-Dick', author: 'Melville', ext: 'epub', addedAt: 42 }
const MARK = {
  id: 'm1',
  bookId: 'book:a',
  cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:5)',
  sectionIndex: 0,
  text: 'passage',
  prefix: '',
  suffix: '',
  note: '',
  kind: 'highlight' as const,
  chapter: 'One',
  createdAt: 42,
}
const CARD = {
  id: 'c1',
  bookId: 'book:a',
  kind: 'Excerpt' as const,
  body: 'x',
  answer: '',
  source: '',
  cfi: null,
  createdAt: 42,
}

/** Every kernel writer, in one pass — the enumerated-writers scenario. */
async function everyWriter(kernel: ReturnType<typeof createKernelServices>): Promise<void> {
  const { library, marks, cards } = kernel
  await marks.open('book:a')
  await library.add('book:a', REC)
  await library.update('book:a', (record) => ({ ...record, finished: true }))
  await marks.add({ ...MARK })
  await marks.updateNote('m1', 'a thought')
  await library.keepContent('book:a', 'moby.epub', new Blob(['WHALE']))
  await library.keepJacket('book:a', new Blob(['not an image']))
  await library.refreshContent('book:a')
  await cards.add({ ...CARD })
  await library.remove('book:a')
  await library.restore('book:a')
  await kernel.drain()
}

describe('every kernel writer brackets through the journal', () => {
  it('one begin and one commit per write, with the right kind', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    const storage = memoryStorage()
    const kernel = createKernelServices({ fs, storage, recorder: journal, clock: testClock() })
    await everyWriter(kernel)

    const begins = journal.entries().filter((e) => e.kind === 'begin')
    const commits = journal.entries().filter((e) => e.kind === 'commit')
    expect(commits.length).toBe(begins.length) // every begin has its commit
    const kinds = commits.map((e) => `${e.what} ${e.book}`)
    // add, update, restore-merge write the record; marks twice; content twice
    // (keepContent + refreshContent); one cover; cards; remove + restore.
    for (const expected of [
      'record book:a',
      'marks book:a',
      'cover book:a',
      'content book:a',
      'removed book:a',
      'cards book:a',
    ]) {
      expect(kinds).toContain(expected)
    }
    expect(kinds.filter((k) => k === 'removed book:a').length).toBe(2) // remove + restore
    expect(commits.every((e) => e.origin === 'local')).toBe(true)
  })

  it('and with the NOOP recorder the very same writers leave identical files', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    const withJournal = createKernelServices({ fs, storage: memoryStorage(), recorder: journal, clock: testClock() })
    await everyWriter(withJournal)
    await journal.close()

    const bare = crashableFs()
    const withNoop = createKernelServices({ fs: bare, storage: memoryStorage(), recorder: NOOP_RECORDER, clock: testClock() })
    await everyWriter(withNoop)

    const visible = (store: Map<string, Uint8Array>) =>
      Object.fromEntries(
        [...store.entries()]
          .filter(([path]) => !path.startsWith('sync/journal'))
          .map(([path, bytes]) => [path, new TextDecoder().decode(bytes)] as [string, string])
          .sort(([a], [b]) => (a < b ? -1 : 1)),
      )
    expect(visible(fs.store)).toEqual(visible(bare.store))
  })
})

/* A recorder that hands out tokens and forgets — pinning that the spy-based
 * contract test and this file agree about what the writers do. */
const spyKinds = async (): Promise<string[]> => {
  const seen: string[] = []
  const recorder: MutationRecorder = {
    begin: async (book, what) => {
      seen.push(`${what} ${book}`)
      return { book, what }
    },
    commit: async () => {},
  }
  const kernel = createKernelServices({ fs: crashableFs(), storage: memoryStorage(), recorder, clock: testClock() })
  await everyWriter(kernel)
  return seen
}

describe('the journal and a spy see the same writers', () => {
  it('kind for kind', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    const kernel = createKernelServices({ fs, storage: memoryStorage(), recorder: journal, clock: testClock() })
    await everyWriter(kernel)
    const journaled = journal
      .entries()
      .filter((e) => e.kind === 'begin')
      .map((e) => `${e.what} ${e.book}`)
    expect(journaled).toEqual(await spyKinds())
  })
})
