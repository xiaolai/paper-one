import { describe, expect, it } from 'vitest'
import {
  NOOP_RECORDER,
  createKernelServices,
  writeQueue,
  type Card as CardRow,
  type MutationRecorder,
} from '../../../kernel'
import { hlcOf, makeHlc, type Hlc } from './clock'
import {
  JOURNAL_DIRTY_PATH,
  JOURNAL_META_PATH,
  JOURNAL_PATH,
  SYNC_DIR,
  createJournal,
  isValidJsonPrefix,
  type Journal,
  type JournalEntry,
} from './journal'
import { crashableFs, fsOver, journalLines, memoryStorage, type CrashableFs } from './journalFs.testkit'
import { marksDigest, recordDigest } from './merge'

const DEV = 'a1b2c3d4e5f60718'

/** A deterministic clock: strictly increasing, no wall time involved. */
function testClock() {
  let t = 0
  return () => makeHlc(++t, 0, DEV)
}

function journalOver(fs: CrashableFs, extra: { cards?: readonly CardRow[]; fsyncEvery?: number } = {}) {
  return createJournal({
    fs,
    queue: writeQueue(),
    clock: testClock(),
    fsync: (path) => fs.fsync(path),
    ...(extra.fsyncEvery === undefined ? {} : { fsyncEvery: extra.fsyncEvery }),
    ...(extra.cards === undefined ? {} : { cards: () => extra.cards ?? [] }),
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

  it('a commit settles only ITS OWN begin — an overlapped bracket is still recovered after a crash', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    // Two brackets in flight on ONE key — cards writes are not serialised by
    // the book queue, so this shape is reachable — and only the first commits.
    const a = await journal.begin('book:a', 'record')
    await journal.begin('book:a', 'record')
    await journal.commit(a, 'v-a')

    // Crash here: reopen over the exact bytes. The second begin must still
    // dangle and be recovered — a commit that swept the whole key lost it.
    const reopened = journalOver(fsOver(new Map(fs.store)))
    await reopened.open()
    const commits = reopened.entries().filter((e) => e.kind === 'commit')
    expect(commits).toHaveLength(2)
    expect(commits[0]).toMatchObject({ digest: 'v-a', rev: 1 })
    expect(commits[1]).toMatchObject({ book: 'book:a', what: 'record', rev: 2, origin: 'local' })
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

  it('a COMPLETE last line that is not an entry is corruption, not a torn tail', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    const token = await journal.begin('book:a', 'record')
    await journal.commit(token)
    await journal.close()
    /* Whole valid JSON, wrong shape. A torn append cannot leave this — a
     * byte prefix of `{...}` either fails to parse or IS the whole line —
     * so tolerating it would erase a line somebody wrote. */
    const held = fs.store.get(JOURNAL_PATH)!
    const withBadTail = new Uint8Array([...held, ...new TextEncoder().encode('{"seq":99}\n')])
    fs.store.set(JOURNAL_PATH, withBadTail)

    await expect(journalOver(fs).open()).rejects.toThrow(/not a journal entry/)
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

describe('load validation — a corrupt journal is refused, not absorbed', () => {
  const at = makeHlc(1, 0, DEV)
  const line = (entry: Record<string, unknown>): string => `${JSON.stringify(entry)}\n`
  const beginLine = (seq: number, epoch = 'e1') =>
    line({ seq, kind: 'begin', epoch, book: 'book:a', what: 'record', at, origin: 'local' })
  const commitLine = (seq: number, rev: number) =>
    line({ seq, kind: 'commit', epoch: 'e1', book: 'book:a', what: 'record', at, rev, origin: 'local' })
  const overFile = (text: string) => {
    const fs = crashableFs()
    fs.store.set(JOURNAL_PATH, new TextEncoder().encode(text))
    return journalOver(fs)
  }

  it('throws on a seq that does not strictly increase', async () => {
    await expect(overFile(beginLine(5) + beginLine(3)).open()).rejects.toThrow(/does not increase/)
    await expect(overFile(beginLine(4) + beginLine(4)).open()).rejects.toThrow(/does not increase/)
  })

  it('throws on a second epoch', async () => {
    await expect(overFile(beginLine(1, 'e1') + beginLine(2, 'e2')).open()).rejects.toThrow(/second epoch/)
  })

  it('throws on a commit rev that regresses its key', async () => {
    await expect(overFile(commitLine(1, 2) + commitLine(2, 1)).open()).rejects.toThrow(/regresses/)
    await expect(overFile(commitLine(1, 3) + commitLine(2, 3)).open()).rejects.toThrow(/regresses/)
  })

  it('still opens a valid file written the same way', async () => {
    const journal = overFile(beginLine(1) + commitLine(2, 1))
    await journal.open()
    expect(journal.head()).toBeGreaterThanOrEqual(2)
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

describe('carried findings — crash durability and load hardening', () => {
  const at = makeHlc(1, 0, DEV)
  const REC = { bookId: 'book:a', title: 'Moby-Dick', author: 'Melville', addedAt: 50 }
  const overFile = (files: Record<string, string>) => {
    const fs = crashableFs()
    for (const [path, text] of Object.entries(files)) fs.store.set(path, new TextEncoder().encode(text))
    return fs
  }

  it('#5 close keeps the dirty flag while a begin still dangles, and clears it once none do', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    await journal.begin('book:a', 'record') // no commit — the bracket dangles
    await journal.close()
    // A bracket between begin and commit is not a clean shutdown: the flag
    // stays so the next open recovers and verifies rather than looking clean.
    expect(await fs.exists(JOURNAL_DIRTY_PATH)).toBe(true)

    const reopened = journalOver(fs)
    await reopened.open() // recovers the dangling begin — nothing dangles now
    await reopened.close()
    expect(await fs.exists(JOURNAL_DIRTY_PATH)).toBe(false)
  })

  it('#6 a commit with no caller digest carries the folder digest, so a lost data write is caught', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    fs.store.set('books/book_a/book.json', new TextEncoder().encode(JSON.stringify(REC)))
    const token = await journal.begin('book:a', 'record')
    await journal.commit(token) // no digest, exactly as the kernel writers commit
    const commit = journal.entries().find((e) => e.kind === 'commit')!
    expect(commit.digest).toBe(await recordDigest(REC))

    // The data write is lost: the folder holds other bytes, and the shutdown
    // is unclean (no close). Verify must detect the torn commit/data pair.
    const other = { ...REC, title: 'Something else entirely' }
    fs.store.set('books/book_a/book.json', new TextEncoder().encode(JSON.stringify(other)))
    const reopened = journalOver(fs)
    await reopened.open()
    const records = reopened.entries().filter((e) => e.kind === 'commit' && e.what === 'record')
    expect(records).toHaveLength(2)
    expect(records[1]!.digest).toBe(await recordDigest(other))
  })

  it('#10 an unreadable folder in verify retains the dirty flag rather than passing by omission', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    fs.store.set('books/book_a/book.json', new TextEncoder().encode(JSON.stringify(REC)))
    const token = await journal.begin('book:a', 'record')
    await journal.commit(token, await recordDigest(REC))
    // Unclean shutdown; the folder is now present but will not parse — a read
    // ERROR, not an absence, so verify cannot certify agreement.
    fs.store.set('books/book_a/book.json', new TextEncoder().encode('{ not json at all'))
    const reopened = journalOver(fs)
    await reopened.open()
    await reopened.close() // a clean close must NOT clear the flag over an errored verify
    expect(await fs.exists(JOURNAL_DIRTY_PATH)).toBe(true)
  })

  it('#4 refuses a journal whose epoch disagrees with journal.meta.json', async () => {
    const fs = overFile({
      [JOURNAL_PATH]:
        JSON.stringify({ seq: 1, kind: 'begin', epoch: 'e1', book: 'book:a', what: 'record', at, origin: 'local' }) + '\n',
      [JOURNAL_META_PATH]: JSON.stringify({ epoch: 'e2', nextSeq: 2, journalFormat: 1, state: 'ready' }),
    })
    await expect(journalOver(fs).open()).rejects.toThrow(/meta says/)
  })

  it('#9 rejects a complete line carrying an invalid optional field (a rev on a begin)', async () => {
    const fs = overFile({
      [JOURNAL_PATH]:
        JSON.stringify({ seq: 1, kind: 'begin', epoch: 'e1', book: 'book:a', what: 'record', at, origin: 'local', rev: 3 }) +
        '\n',
    })
    await expect(journalOver(fs).open()).rejects.toThrow(/not a journal entry/)
  })

  it('#9 refuses a torn last line that is not even a valid JSON prefix of an entry', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    const token = await journal.begin('book:a', 'record')
    await journal.commit(token)
    await journal.close()
    // Garbage appended as a final line — not a byte-prefix of any entry, so it
    // is corruption where a torn tail would sit, not a tolerable truncation.
    const held = fs.store.get(JOURNAL_PATH)!
    fs.store.set(JOURNAL_PATH, new Uint8Array([...held, ...new TextEncoder().encode('@@@ not an entry')]))
    await expect(journalOver(fs).open()).rejects.toThrow(/not a valid entry prefix/)
  })

  it('#7/#8 fsyncs the presence register and the sync directory during bootstrap', async () => {
    // A shelf with a trash marker, so the bootstrap migrates it into the
    // presence register.
    const fs = crashableFs({
      'trash/book_ccc/book.json': JSON.stringify({ bookId: 'book:ccc', title: 'Gone', author: '' }),
      'trash/book_ccc/.removed': '5000',
    })
    await journalOver(fs).open()
    const fsynced = fs.ops.filter((op) => op.kind === 'fsync').map((op) => op.path)
    // #7: the presence register is made durable before `ready` — a marker
    // migrated but not fsynced would resurrect a deletion after a crash.
    expect(fsynced).toContain('sync/removed.json')
    // #8: the sync DIRECTORY is fsynced too, so the entries it names survive.
    expect(fsynced).toContain(SYNC_DIR)
  })

  it('#31 migrates colliding legacy cards revs at load instead of refusing to open', async () => {
    // Two legacy per-book cards streams, each at rev 1, that canonicalise onto
    // the one `cards ''` stream — their revs now collide.
    const fs = overFile({
      [JOURNAL_PATH]:
        JSON.stringify({ seq: 1, kind: 'commit', epoch: 'e1', book: 'book:a', what: 'cards', at, rev: 1, origin: 'local' }) +
        '\n' +
        JSON.stringify({ seq: 2, kind: 'commit', epoch: 'e1', book: 'book:b', what: 'cards', at, rev: 1, origin: 'local' }) +
        '\n',
      [JOURNAL_META_PATH]: JSON.stringify({ epoch: 'e1', nextSeq: 3, journalFormat: 1, state: 'ready' }),
    })
    const journal = journalOver(fs)
    await journal.open() // must NOT throw
    const cardCommits = journal.entries().filter((e) => e.kind === 'commit' && e.what === 'cards')
    expect(cardCommits.map((e) => [e.book, e.rev])).toEqual([
      ['', 1],
      ['', 2],
    ])
    // The renumbering is persisted, so the next load reads a clean stream.
    await journal.close()
    const reopened = journalOver(fs)
    await reopened.open()
    expect(reopened.entries().filter((e) => e.kind === 'commit' && e.what === 'cards').map((e) => e.rev)).toEqual([1, 2])
  })
})

describe('isValidJsonPrefix — proving a torn tail is a real truncation (#9)', () => {
  it('accepts strict prefixes of valid JSON across the grammar', () => {
    for (const s of [
      '{',
      '{"seq"',
      '{"seq":12',
      '{"seq":12,"kind":"be',
      '{"a":[1, 2',
      '[tru',
      '[fals',
      '[nul',
      '{"n":-12.5e',
      '-',
      '{"e":"\\u00',
      '{"s":"a\\"b',
      '{"nested":{"x":',
    ]) {
      expect(isValidJsonPrefix(s), s).toBe(true)
    }
  })

  it('accepts complete values, which are prefixes of themselves', () => {
    for (const s of ['{}', '[]', '123', 'true', 'false', 'null', '"x"', '{"a":[1,2,3]}']) {
      expect(isValidJsonPrefix(s), s).toBe(true)
    }
  })

  it('rejects bytes no completion can make valid', () => {
    for (const s of [
      '',
      '@@@',
      '}{',
      '{"a":1}x', // trailing junk past a complete value
      '{"a" 1}', // missing colon
      '{"a":1 2}', // missing comma
      '[1 2]',
      '{"e":"\\x"}', // invalid escape
      'tru3', // a wrong literal
      '{1:2}', // a non-string key
      `"a${String.fromCharCode(1)}b"`, // a raw control character in a string
    ]) {
      expect(isValidJsonPrefix(s), s).toBe(false)
    }
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

  it('a clear takes back only ITS OWN expectation — a concurrent operation keeps its arm', async () => {
    const journal = journalOver(crashableFs())
    await journal.open()
    // Two operations arm the same key; the first one's apply consumes one.
    const first = journal.expectRemote('book:a', 'record')
    journal.expectRemote('book:a', 'record')
    const consumed = await journal.begin('book:a', 'record')
    await journal.commit(consumed)
    // Its clear is a no-op now — under a shared counter it took back the
    // SECOND operation's still-armed expectation, whose apply then
    // journaled `local`: an echo.
    journal.clearRemote('book:a', 'record', first)
    const second = await journal.begin('book:a', 'record')
    await journal.commit(second)
    const after = await journal.begin('book:a', 'record')
    await journal.commit(after)
    const commits = journal.entries().filter((e) => e.kind === 'commit')
    expect(commits.map((e) => e.origin)).toEqual(['remote', 'remote', 'local'])
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
    // The marks digest is the REAL digest of this book's (empty) marks folder,
    // so the reopen's verify pass — which #5 now runs, because a begin dangles
    // at close — matches it and re-commits nothing.
    const emptyMarks = await marksDigest([])
    const marksToken = await journal.begin('book:a', 'marks')
    await journal.commit(marksToken, emptyMarks)
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

    // The compacted journal reloads into the same working state. A begin still
    // dangles at close, so the dirty flag STAYS (#5) and the reopen runs the
    // verify pass — a no-op here, because every kept digest matches the folder
    // (the record digests read null with no book.json, the marks digest is the
    // empty-folder digest).
    await journal.close()
    const reopened = journalOver(fs)
    await reopened.open()
    // v5 and the marks digest as compacted; the dangling begin was recovered
    // into a fresh commit (no digest — nothing was measured) at the file's end.
    expect(reopened.feed(0, reopened.head()).map((e) => e.digest)).toEqual(['v5', emptyMarks, undefined])
    expect(reopened.entries().filter((e) => e.kind === 'commit' && e.book === 'book:b')).toHaveLength(1)
  })

  it('keeps the unacked LOCAL commit under a later remote one — the outbox survives compact and reopen', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    const local = await journal.begin('book:a', 'record')
    await journal.commit(local, 'v-local')
    await journal.markRemote([{ book: 'book:a', what: 'record' }], async () => {
      const remote = await journal.begin('book:a', 'record')
      await journal.commit(remote, 'v-remote')
    })

    await journal.compact()
    // The local rev 1 is still unacked and still the thing to push…
    expect(journal.outbox()).toEqual([expect.objectContaining({ book: 'book:a', what: 'record', rev: 1 })])
    // …and the feed still serves the LAST commit, the remote one.
    expect(journal.feed(0, journal.head()).map((e) => e.digest)).toEqual(['v-remote'])

    await journal.close()
    const reopened = journalOver(fs)
    await reopened.open()
    expect(reopened.outbox()).toEqual([expect.objectContaining({ book: 'book:a', what: 'record', rev: 1 })])
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

  const CARD: readonly CardRow[] = [
    { id: 'c1', bookId: 'book:aaaa', kind: 'Excerpt', body: 'x', answer: '', source: '', cfi: null, createdAt: 700 },
  ]

  it('emits one local baseline commit per surface, with legacy stamps and digests, then publishes the epoch', async () => {
    const fs = shelf()
    const journal = journalOver(fs, { cards: CARD })
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
    // The kill: the underlying append starts failing after 2 lines.
    let appends = 0
    const append = fs.appendFile.bind(fs)
    fs.appendFile = async (path: string, bytes: Uint8Array) => {
      appends += 1
      if (appends > 2) throw new Error('killed')
      return append(path, bytes)
    }
    const journal = journalOver(fs, { cards: CARD })
    await expect(journal.open()).rejects.toThrow(/killed/)
    expect(journal.epoch()).toBeNull() // building: the epoch is not published
    const metaMidway = JSON.parse(new TextDecoder().decode(fs.store.get(JOURNAL_META_PATH)!)) as { epoch: string; state: string }
    expect(metaMidway.state).toBe('building')

    // The next launch: the fs behaves again, the build resumes.
    fs.appendFile = append
    const resumed = journalOver(fs, { cards: CARD })
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

  it('a runtime cards write joins the bootstrap baseline on the ONE (book "", cards) stream', async () => {
    const fs = shelf()
    const journal = journalOver(fs, { cards: CARD })
    await journal.open()

    // A caller names its own book id; the journal canonicalises to ''. Split
    // by caller, the runtime rev named a stream the payload never travels on.
    const token = await journal.begin('book:aaaa', 'cards')
    await journal.commit(token)

    const cardCommits = journal.entries().filter((e) => e.kind === 'commit' && e.what === 'cards')
    expect(cardCommits.map((e) => [e.book, e.rev])).toEqual([
      ['', 1],
      ['', 2],
    ])
    // The feed coalesces the surface to one entry, and the outbox pushes
    // the runtime rev on the canonical stream.
    expect(journal.feed(0, journal.head()).filter((e) => e.what === 'cards')).toHaveLength(1)
    expect(journal.outbox()).toContainEqual(expect.objectContaining({ book: '', what: 'cards', rev: 2 }))
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
    // (keepContent + refreshContent); one cover; cards — journaled under the
    // canonical cards book '', ONE cross-book surface; remove + restore.
    for (const expected of [
      'record book:a',
      'marks book:a',
      'cover book:a',
      'content book:a',
      'removed book:a',
      'cards ',
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
