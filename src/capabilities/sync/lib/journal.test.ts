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

function journalOver(
  fs: CrashableFs,
  extra: {
    cards?: readonly CardRow[]
    fsyncEvery?: number
    compactEvery?: number
    onQuarantine?: (info: { moved: string; reason: string }) => void
  } = {},
) {
  return createJournal({
    fs,
    queue: writeQueue(),
    clock: testClock(),
    fsync: (path) => fs.fsync(path),
    ...(extra.fsyncEvery === undefined ? {} : { fsyncEvery: extra.fsyncEvery }),
    ...(extra.compactEvery === undefined ? {} : { compactEvery: extra.compactEvery }),
    ...(extra.cards === undefined ? {} : { cards: () => extra.cards ?? [] }),
    ...(extra.onQuarantine === undefined ? {} : { onQuarantine: extra.onQuarantine }),
  })
}

/**
 * A damaged journal opens, says why, and does not absorb what it found.
 *
 * The remedy changed with ADR 0001 Decision 9 and the rebuild it made
 * possible; the invariant did not. These cases have always been about a
 * contradictory file not being merged in — that is still what is asserted.
 */
async function expectQuarantined(fs: CrashableFs, reason: RegExp): Promise<void> {
  let told = ''
  const journal = journalOver(fs, { onQuarantine: (info) => (told = info.reason) })
  await journal.open()
  expect(told).toMatch(reason)
  await journal.close()
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

    const seen: { reason: string }[] = []
    const reopened = journalOver(fs, { onQuarantine: (info) => seen.push(info) })
    await reopened.open()
    expect(seen[0]?.reason).toMatch(/not the tail/)
    // NOT ABSORBED — the surviving lines of the damaged file are not adopted.
    expect(reopened.entries().some((e) => e.book === 'book:a' && e.kind === 'commit')).toBe(false)
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

    await expectQuarantined(fs, /not a journal entry/)
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
  /** Open a damaged file and hand back why it was quarantined. */
  const reasonFor = async (text: string): Promise<string> => {
    const fs = crashableFs()
    fs.store.set(JOURNAL_PATH, new TextEncoder().encode(text))
    let reason = ''
    const journal = journalOver(fs, { onQuarantine: (info) => (reason = info.reason) })
    await journal.open()
    /* NOT ABSORBED, which is the invariant these cases have always been
       about: the contradictory lines are gone from the read model, and the
       file that held them is moved aside rather than merged in. */
    expect(journal.entries().some((e) => e.epoch === 'e1')).toBe(false)
    await journal.close()
    return reason
  }

  it('quarantines a seq that does not strictly increase', async () => {
    expect(await reasonFor(beginLine(5) + beginLine(3))).toMatch(/does not increase/)
    expect(await reasonFor(beginLine(4) + beginLine(4))).toMatch(/does not increase/)
  })

  it('quarantines a second epoch', async () => {
    expect(await reasonFor(beginLine(1, 'e1') + beginLine(2, 'e2'))).toMatch(/second epoch/)
  })

  it('quarantines a commit rev that regresses its key', async () => {
    expect(await reasonFor(commitLine(1, 2) + commitLine(2, 1))).toMatch(/regresses/)
    expect(await reasonFor(commitLine(1, 3) + commitLine(2, 3))).toMatch(/regresses/)
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

  /**
   * THE KEY THAT CRASHED IS THE ONE THAT MUST BE VERIFIED.
   *
   * `recoverDangling` closed an unfinished bracket with a commit carrying no
   * digest, and the verify pass then skipped that key — it looks at the last
   * commit and a digestless one has nothing to compare. So the surface where
   * a crash landed between the write and its commit was the single surface
   * the unclean-shutdown check could not see, on that open and on every open
   * after, because the digestless head persists.
   */
  it('stamps the recovery commit with the folder, so the crashed key is verifiable', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    fs.store.set('books/book_a/book.json', new TextEncoder().encode(JSON.stringify(REC)))
    /* A begin with no commit: the crash-between-the-two shape. */
    await journal.begin('book:a', 'record')
    await journal.close()

    const reopened = journalOver(fs)
    await reopened.open()
    const recovery = reopened.entries().filter((e) => e.kind === 'commit').at(-1)
    expect(recovery).toMatchObject({ book: 'book:a', what: 'record' })
    expect(recovery!.digest).toBe(await recordDigest(REC))
    await reopened.close()

    /* And the verify pass can now use it: the folder moves under a dirty
     * journal, and the next open re-commits rather than skipping the key. */
    const moved = { ...REC, finished: true }
    const third = journalOver(fs)
    await third.open()
    fs.store.set('books/book_a/book.json', new TextEncoder().encode(JSON.stringify(moved)))
    /* Not closed — dirty, as after a crash. */
    const fourth = journalOver(fs)
    await fourth.open()
    expect(fourth.entries().filter((e) => e.kind === 'commit').at(-1)!.digest).toBe(await recordDigest(moved))
  })

  /**
   * THE SURFACES THAT ARE NOT DOCUMENTS were outside this check entirely.
   *
   * `cover`, `content` and `removed` had no digest at all, so a commit on any
   * of them carried none and the verify pass never looked — while these are
   * exactly the surfaces where a crash between the file operation and the
   * commit is most likely: an import writes bytes, an eviction deletes them.
   */
  it('catches content that vanished between its write and the crash', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs)
    await journal.open()
    fs.store.set('books/book_a/book.json', new TextEncoder().encode(JSON.stringify(REC)))
    fs.store.set('books/book_a/content.epub', new TextEncoder().encode('bytes'))
    const token = await journal.begin('book:a', 'content')
    await journal.commit(token)
    const committed = journal.entries().filter((e) => e.kind === 'commit').at(-1)
    expect(committed!.digest).toBe('content:content.epub')

    /* The bytes go, and the journal was never closed. */
    fs.store.delete('books/book_a/content.epub')
    const reopened = journalOver(fs)
    await reopened.open()
    const after = reopened.entries().filter((e) => e.kind === 'commit').at(-1)
    expect(after!.digest).toBe('content:none')
    expect(after!.rev).toBeGreaterThan(committed!.rev!)
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
    await expectQuarantined(fs, /meta says/)
  })

  it('#9 rejects a complete line carrying an invalid optional field (a rev on a begin)', async () => {
    const fs = overFile({
      [JOURNAL_PATH]:
        JSON.stringify({ seq: 1, kind: 'begin', epoch: 'e1', book: 'book:a', what: 'record', at, origin: 'local', rev: 3 }) +
        '\n',
    })
    await expectQuarantined(fs, /not a journal entry/)
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
    await expectQuarantined(fs, /not a valid entry prefix/)
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
      /* JSON'S NUMBER GRAMMAR, which the scanner used to approximate as
       * "some digits, maybe a dot, maybe an exponent". Every one of these is
       * a corrupt last line — the reader's most recent write — and reading it
       * as a torn tail discarded it without a word instead of quarantining
       * it. The closing bracket is what makes each impossible rather than
       * merely unfinished. */
      '[-]', // a sign with no number
      '[01]', // a leading zero
      '[1.]', // a fraction with no digits
      '[1e]', // an exponent with no digits
      '[1e+]', // a signed exponent with no digits
      '[-.5]', // no integer part
      '{"seq":01}',
      '{"seq":1.}',
    ]) {
      expect(isValidJsonPrefix(s), s).toBe(false)
    }
  })

  /* THE SAME SHAPES AT END OF INPUT ARE PREFIXES, and must stay accepted —
   * this is the distinction the whole function draws, and tightening the
   * grammar is exactly the change that could collapse it into "reject
   * everything unusual" and quarantine every genuine torn tail. */
  it('still accepts an unfinished number, which is what a torn tail looks like', () => {
    for (const s of ['[-', '[0', '[1', '[12', '[1.', '[1.5', '[1e', '[1e+', '[1e-', '[1e5', '{"seq":-']) {
      expect(isValidJsonPrefix(s), s).toBe(true)
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
  tint: 'yellow' as const,
  style: 'fill' as const,
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


/**
 * A JOURNAL THAT CONTRADICTS ITSELF IS REBUILT, NOT REFUSED.
 *
 * This is the failure that was actually hit. Two writers — a page reload while
 * appends were in flight — left the sequence going backwards mid-file. `open`
 * threw, `sync.start` failed, the composition rolled back, and a reader whose
 * library has nothing to do with sync got a fatal banner instead of their
 * books. Refusing the file was right; taking the app down with it was not, and
 * so was leaving sync dead until someone deleted a file by hand.
 *
 * Rebuilding is sound because the journal is DERIVED — the books and marks are
 * the truth, in their folders. What is genuinely lost is what a peer had
 * acknowledged, which is why the rebuild mints a new epoch.
 */
describe('recovering from a corrupt journal', () => {
  /** A journal whose seq goes backwards mid-file — the shape that happened. */
  const withBackwardsSeq = async (fs: CrashableFs) => {
    const first = journalOver(fs)
    await first.open()
    const token = await first.begin('book:a', 'record')
    await first.commit(token)
    await first.close()
    const rows = journalLines(fs, JOURNAL_PATH) as Record<string, unknown>[]
    expect(rows.length).toBeGreaterThan(1)
    /* THE SHAPE THAT ACTUALLY HAPPENED: a valid entry whose seq has already
       been used, appended after later ones — two writers, each with its own
       counter, on one append-only file. Re-appending the FIRST line verbatim
       makes a well-formed entry that violates only the ordering. */
    const replayed = [...rows, rows[0]!]
    fs.store.set(JOURNAL_PATH, new TextEncoder().encode(replayed.map((r) => JSON.stringify(r)).join('\n') + '\n'))
  }

  it('opens, rather than throwing', async () => {
    const fs = crashableFs()
    await withBackwardsSeq(fs)
    const journal = journalOver(fs)
    await expect(journal.open()).resolves.toBeUndefined()
    expect(journal.state()).toBe('ready')
    await journal.close()
  })

  it('moves the corrupt file aside rather than deleting it', async () => {
    const fs = crashableFs()
    await withBackwardsSeq(fs)
    const seen: { moved: string; reason: string }[] = []
    const journal = journalOver(fs, { onQuarantine: (info) => seen.push(info) })
    await journal.open()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.reason).toMatch(/does not increase past/)
    // The evidence is still on disk, under the name the report named.
    expect(fs.store.has(seen[0]!.moved)).toBe(true)
    expect(seen[0]!.moved).toMatch(/^sync\/journal\.corrupt-/)
    await journal.close()
  })

  it('mints a NEW epoch, because a peer must resync rather than be reconciled', async () => {
    const fs = crashableFs()
    await withBackwardsSeq(fs)
    const before = JSON.parse(new TextDecoder().decode(fs.store.get(JOURNAL_META_PATH)!)) as { epoch: string }
    const journal = journalOver(fs)
    await journal.open()
    expect(journal.epoch()).not.toBe(before.epoch)
    await journal.close()
  })

  it('rebuilds a baseline from the folders, so nothing the reader owns is lost', async () => {
    const fs = crashableFs()
    await withBackwardsSeq(fs)
    // A book on disk that the discarded journal never mentioned.
    fs.store.set(
      'books/book_rebuilt/book.json',
      new TextEncoder().encode(JSON.stringify({ bookId: 'book:rebuilt', title: 'Moby-Dick', author: 'Melville', addedAt: 1 })),
    )
    const journal = journalOver(fs)
    await journal.open()
    const books = (journalLines(fs, JOURNAL_PATH) as { book?: string }[]).map((row) => row.book)
    expect(books).toContain('book:rebuilt')
    await journal.close()
  })

  it('leaves a torn last line to the crash path, which is not corruption', async () => {
    /* A crash mid-append leaves a PREFIX, and a prefix satisfies every
       invariant — it must be trimmed silently, not quarantined. Quarantining
       it would throw away a good journal on every unclean shutdown. */
    const fs = crashableFs()
    const first = journalOver(fs)
    await first.open()
    const token = await first.begin('book:a', 'record')
    await first.commit(token)
    await first.close()
    const text = new TextDecoder().decode(fs.store.get(JOURNAL_PATH)!)
    fs.store.set(JOURNAL_PATH, new TextEncoder().encode(text + '{"seq":99,"kind":"beg'))
    const seen: unknown[] = []
    const journal = journalOver(fs, { onQuarantine: (info) => seen.push(info) })
    await journal.open()
    expect(seen).toEqual([])
    await journal.close()
  })
})

/**
 * A READ THAT FAILS IS NOT A FILE THAT IS ABSENT.
 *
 * Both paths below used to catch every error and carry on as though the
 * journal were empty. That is the most expensive confusion in this file: the
 * append fallback rewrites the file IN PLACE from what it just read, so one
 * failed read replaced the entire journal with a single line, and `open`
 * succeeded on a failed read with an empty outbox — silently withdrawing
 * every unsent local commit from the feed.
 *
 * `exists()` is what separates them, rather than an errno: the error shape
 * differs between the Node host and the webview's fs plugin, so matching a
 * code would be right on one and quietly wrong on the other.
 */
describe('a failing read is not an absent file', () => {
  it('never overwrites an existing journal when the append fallback cannot read it', async () => {
    const fs = crashableFs()
    /* No `appendFile`, so the read-modify-write fallback is the path taken. */
    const noAppend = { ...fs, appendFile: undefined } as unknown as CrashableFs
    const journal = journalOver(noAppend)
    await journal.open()
    const token = await journal.begin('a-book', 'record')
    await journal.commit(token, 'one')
    const before = journalLines(fs, JOURNAL_PATH)
    expect(before.length).toBeGreaterThan(0)

    /* The file is there; reading it fails. */
    noAppend.readFile = async () => {
      throw new Error('EIO: simulated transient read failure')
    }
    /* `begin` appends too, so the refusal can surface at either half — what
     * matters is that it surfaces rather than being absorbed. */
    await expect(
      (async () => {
        const second = await journal.begin('b-book', 'record')
        await journal.commit(second, 'two')
      })(),
    ).rejects.toThrow(/EIO/)

    /* THE ORIGINAL LINES ARE STILL THERE. Before the fix this file held one
     * line — the new one — and everything else was gone. */
    expect(journalLines(fs, JOURNAL_PATH)).toEqual(before)
  })

  it('refuses to open when the journal is present but unreadable', async () => {
    const fs = crashableFs()
    const first = journalOver(fs)
    await first.open()
    const token = await first.begin('a-book', 'record')
    await first.commit(token, 'one')
    await first.close()

    const broken = { ...fs } as unknown as CrashableFs
    broken.readFile = async (path: string) => {
      if (path === JOURNAL_PATH) throw new Error('EIO: simulated transient read failure')
      return fs.readFile(path)
    }
    await expect(journalOver(broken).open()).rejects.toThrow(/EIO/)
  })
})

/**
 * AN AMBIGUOUS APPEND STOPS THE JOURNAL, rather than renumbering over itself.
 *
 * `appendLine` writes bytes and then fsyncs; the caller's `absorb` runs only
 * after it returns. So a throw from either half skips the absorb while the
 * bytes may already be down, `nextSeq` and the per-key revs describe a shorter
 * journal than the file, and the next allocation reuses numbers the file
 * already holds. A retry then appends a DUPLICATE seq — which the loader reads
 * as corruption, not as a crash artefact, and quarantines the whole journal on
 * the next open.
 *
 * Poisoning until reopen is the honest answer, because neither half can be
 * disambiguated from here: a failed write may have written some bytes, and a
 * failed fsync follows a write that certainly reached the page cache.
 */
describe('an append that fails ambiguously', () => {
  it('refuses further use until reopened, instead of reusing a seq the file may hold', async () => {
    const fs = crashableFs()
    /* The durability barrier is injectable, so the ambiguous half — bytes
     * written, fsync refused — can be produced exactly. */
    let barrierFails = false
    const journal = createJournal({
      fs,
      queue: writeQueue(),
      clock: testClock(),
      fsync: async (path: string) => {
        if (barrierFails) throw new Error('EIO: the durability barrier refused')
        await fs.fsync(path)
      },
    })
    await journal.open()
    const first = await journal.begin('a-book', 'record')
    await journal.commit(first, 'one')
    const before = journalLines(fs, JOURNAL_PATH).length

    /* THE FAILURE IS ON A COMMIT, which is where the reuse actually is.
     *
     * `seq` is allocated with `nextSeq++` BEFORE the append, so a failed
     * append never hands the same seq out twice — asserting unique seqs would
     * have passed with or without the fix. The per-key REVISION is different:
     * `nextRev` reads state that only `absorb` advances, and `absorb` runs
     * after the append returns. A commit whose append fails therefore leaves
     * `lastRev` where it was, and the next commit for that key allocates the
     * same revision over a line the file may already hold. */
    const doomed = await journal.begin('b-book', 'record')
    /* Armed between the two halves, so the bracket opens normally and the
     * COMMIT is what fails — `begin` appends too, and tripping it there would
     * exercise a different path. */
    barrierFails = true
    await expect(journal.commit(doomed, 'two')).rejects.toThrow()

    /* Every later use refuses, rather than allocating over the file. */
    await expect(journal.begin('c-book', 'record')).rejects.toThrow(/reopened/)
    expect(() => journal.outbox()).toThrow(/reopened/)
    expect(() => journal.feed(0, Number.MAX_SAFE_INTEGER)).toThrow(/reopened/)

    /* And a fresh open re-derives from the file, which is the way back. */
    barrierFails = false
    const reopened = journalOver(fs)
    await reopened.open()
    const token = await reopened.begin('c-book', 'record')
    await reopened.commit(token, 'three')
    const lines = journalLines(fs, JOURNAL_PATH) as { seq: number; kind: string; book: string; rev?: number }[]
    expect(lines.length).toBeGreaterThan(before)

    /* PER-KEY REVISIONS STRICTLY INCREASE — the invariant the loader enforces
     * and the one a reused rev would break. Checked per key, because revisions
     * are per key and a global sort would hide the collision. */
    const byKey = new Map<string, number[]>()
    for (const line of lines) {
      if (line.kind !== 'commit' || line.rev === undefined) continue
      const held = byKey.get(line.book) ?? []
      held.push(line.rev)
      byKey.set(line.book, held)
    }
    for (const [book, revs] of byKey) {
      expect(new Set(revs).size, `duplicate revision for ${book}: ${revs.join(', ')}`).toBe(revs.length)
      expect(revs, `revisions for ${book} are not increasing`).toEqual([...revs].sort((a, b) => a - b))
    }

    /* And the reopen did not quarantine — a duplicate rev would have. */
    expect(reopened.state()).toBe('ready')
  })
})

/**
 * `recover: false` — the mode `paper` opens a DIRTY journal in.
 *
 * The CLI may append to a journal whose flag is up, because the flag is up on
 * any library whose app has run and refusing on it would disable journalling
 * outright. What it must not do is perform the app's recovery: that pass walks
 * every book and raises revs, and it is the app's job on the app's schedule.
 *
 * The promise that makes it safe is that declining the pass is NOT the same as
 * declaring the shelf sound — so `close()` has to leave the flag exactly as it
 * found it. Untested, that promise is just a comment.
 */
describe('opening a dirty journal without recovering', () => {
  it('appends, and leaves the dirty flag up for the app that still owes the pass', async () => {
    const fs = crashableFs()
    /* A first lifetime that ends UNCLEANLY, so the flag is up. */
    const first = journalOver(fs)
    await first.open()
    const token = await first.begin('a-book', 'record')
    await first.commit(token, 'one')
    expect(await fs.exists(JOURNAL_DIRTY_PATH)).toBe(true)
    /* No `close()` — this is the crash shape the flag exists to record. */

    const before = journalLines(fs, JOURNAL_PATH).length
    const cli = createJournal({ fs, queue: writeQueue(), clock: testClock(), recover: false })
    await cli.open()
    const mine = await cli.begin('b-book', 'record')
    await cli.commit(mine, 'two')
    await cli.close()

    /* The write landed... */
    expect(journalLines(fs, JOURNAL_PATH).length).toBeGreaterThan(before)
    /* ...and the flag is STILL UP, so the app's next open still recovers.
     * Clearing it here would advertise a clean shutdown nobody performed and
     * the owed verify pass would never run. */
    expect(await fs.exists(JOURNAL_DIRTY_PATH)).toBe(true)
  })

  it('still clears the flag on a clean journal, so the CLI does not disable itself', async () => {
    const fs = crashableFs()
    const first = journalOver(fs)
    await first.open()
    await first.close()
    expect(await fs.exists(JOURNAL_DIRTY_PATH)).toBe(false)

    const cli = journalOver(fs)
    await cli.open()
    const token = await cli.begin('a-book', 'record')
    await cli.commit(token, 'one')
    await cli.close()
    expect(await fs.exists(JOURNAL_DIRTY_PATH)).toBe(false)
  })
})

/**
 * A COUNTER PAST THE SAFE RANGE CANNOT BE INCREMENTED.
 *
 * `Number.isInteger(2 ** 53)` is true, and `2 ** 53 === 2 ** 53 + 1`. A `seq`
 * loaded at or beyond that stops advancing, so `nextSeq++` yields the same
 * number forever and every later append carries a duplicate — which this
 * loader reads as corruption and quarantines. A real journal never approaches
 * it; a hand-edited or garbled one names it in a single character, and the
 * validator accepted it because it only asked for an integer.
 */
describe('counters past the safe range', () => {
  /* The same builders the load-validation suite uses, so the only thing that
   * differs between the two cases below is the number. */
  const at = makeHlc(1, 0, DEV)
  const seqLine = (seq: number): string =>
    `${JSON.stringify({ seq, kind: 'begin', epoch: 'e1', book: 'book:a', what: 'record', at, origin: 'local' })}\n`
  const load = async (text: string) => {
    const fs = crashableFs()
    fs.store.set(JOURNAL_PATH, new TextEncoder().encode(text))
    const journal = journalOver(fs)
    await journal.open()
    return journal
  }

  it('refuses a seq that cannot be incremented', async () => {
    const journal = await load(seqLine(2 ** 53))
    expect(journal.entries().some((one) => one.seq === 2 ** 53)).toBe(false)
  })

  /* THE CONTROL. Without it the case above passes whenever the line fails to
   * load for ANY reason — a malformed stamp, a rejected epoch — which is how
   * a first draft of this test passed while proving nothing. */
  it('still accepts an ordinary seq written the same way', async () => {
    const journal = await load(seqLine(7))
    expect(journal.entries().some((one) => one.seq === 7)).toBe(true)
  })
})

/**
 * A COMMIT'S `begin` REFERENCE, CHECKED AGAINST THE JOURNAL AND NOT ONLY
 * AGAINST ITSELF.
 *
 * Per-line validation can only ask `begin < seq`. That accepted a commit
 * pointing at a begin on another book, another surface, another origin, or at
 * one an earlier commit had already closed — and `absorb` clears a bracket by
 * matching the seq WITHIN the key, so a misdirected reference leaves the real
 * begin dangling for good. A key with a permanently dangling begin is read as
 * an unfinished write on every single open.
 */
describe('a commit that references a begin it does not own', () => {
  /** Write two complete brackets on two books, then bend the second commit. */
  async function withBentReference(
    fs: CrashableFs,
    bend: (rows: Record<string, unknown>[]) => void,
  ): Promise<void> {
    const journal = journalOver(fs)
    await journal.open()
    const a = await journal.begin('book:a', 'record')
    await journal.commit(a)
    const b = await journal.begin('book:b', 'record')
    await journal.commit(b)
    await journal.close()
    const rows = journalLines(fs, JOURNAL_PATH) as Record<string, unknown>[]
    bend(rows)
    fs.store.set(JOURNAL_PATH, new TextEncoder().encode(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'))
  }

  /** The reason the journal was quarantined on the next open, if it was. */
  async function reasonFor(bend: (rows: Record<string, unknown>[]) => void): Promise<string | null> {
    const fs = crashableFs()
    await withBentReference(fs, bend)
    const seen: { moved: string; reason: string }[] = []
    const journal = journalOver(fs, { onQuarantine: (info) => seen.push(info) })
    await journal.open()
    await journal.close()
    return seen[0]?.reason ?? null
  }

  /** Where in `rows` the commits are, so a bend names one rather than an index. */
  const commitsOf = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
    rows.filter((row) => row['kind'] === 'commit')

  it('quarantines a reference to another book’s begin', async () => {
    expect(
      await reasonFor((rows) => {
        /* The second bracket's BEGIN is moved to the other book, so its
         * commit now points at a begin belonging to a different key — and to
         * one nothing else has closed, which is what separates this from the
         * already-settled case below. */
        const begins = rows.filter((row) => row['kind'] === 'begin')
        begins[1]!['book'] = begins[0]!['book']
      }),
    ).toMatch(/different book or surface/)
  })

  it('quarantines a reference an earlier commit already closed', async () => {
    expect(
      await reasonFor((rows) => {
        const commits = commitsOf(rows)
        const second = commits[1]!
        /* Same book as the first bracket, and the first commit closed it. */
        second['book'] = commits[0]!['book']
        second['begin'] = commits[0]!['begin']
      }),
    ).toMatch(/already closed/)
  })

  it('quarantines a reference whose begin disagrees about origin', async () => {
    expect(
      await reasonFor((rows) => {
        const begins = rows.filter((row) => row['kind'] === 'begin')
        begins[1]!['origin'] = 'remote'
      }),
    ).toMatch(/different epoch or origin/)
  })

  /* AND THE SHAPE THAT IS LEGITIMATE. `compact` keeps a settled bracket's
   * commit and drops its begin, so a compacted journal holds commits whose
   * begins are gone — a rule demanding the begin be present would refuse to
   * open every compacted journal there is. */
  it('opens a journal whose begins were compacted away', async () => {
    const fs = crashableFs()
    await withBentReference(fs, (rows) => {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index]!['kind'] === 'begin') rows.splice(index, 1)
      }
    })
    const seen: { moved: string; reason: string }[] = []
    const journal = journalOver(fs, { onQuarantine: (info) => seen.push(info) })
    await journal.open()
    expect(seen).toHaveLength(0)
    expect(journal.state()).toBe('ready')
    await journal.close()
  })
})

/**
 * THE FILE MUST STOP GROWING BY ITSELF.
 *
 * `compact()` existed and nothing in the app ever called it, so a journal grew
 * for the life of the library: every open read and split the whole file, every
 * entry stayed in memory, and `feed` rescanned all of it on every sync pass.
 * A shelf edited daily for a year is a file nobody ever asked to keep.
 *
 * The reason this is safe to do automatically is that `feed` ALREADY coalesces
 * to the last commit per key, and compaction keeps exactly that plus the last
 * ack and any dangling begin. The lines it drops are lines `feed` would have
 * discarded anyway — so a peer asking for changes since any seq gets the same
 * answer before and after, which the last test here asserts rather than
 * assumes.
 */
describe('the journal compacts itself', () => {
  const REC = { bookId: 'book:a', title: 'Moby-Dick', author: 'Melville', addedAt: 50 }

  /** `n` complete brackets on one book, through the real recorder. */
  async function churn(journal: ReturnType<typeof journalOver>, n: number): Promise<void> {
    for (let index = 0; index < n; index += 1) {
      const token = await journal.begin('book:a', 'record')
      await journal.commit(token, `digest-${index}`)
    }
  }

  it('shortens the file once it has outgrown what it would keep', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs, { compactEvery: 40 })
    await journal.open()
    fs.store.set('books/book_a/book.json', new TextEncoder().encode(JSON.stringify(REC)))
    await churn(journal, 60)
    /* One key, so compaction leaves a handful of lines rather than 120. */
    expect(journal.entries().length).toBeLessThan(40)
    expect(journalLines(fs, JOURNAL_PATH).length).toBe(journal.entries().length)
    await journal.close()
  })

  it('leaves a shelf with more surfaces than the floor alone, rather than churning', async () => {
    /* THE HALF THAT MAKES AN AUTOMATIC TRIGGER SAFE. A floor on its own means
     * a library with more surfaces than the floor compacts on every append and
     * removes almost nothing — a whole-file rewrite per edit. */
    const fs = crashableFs()
    const journal = journalOver(fs, { compactEvery: 4 })
    await journal.open()
    for (let index = 0; index < 20; index += 1) {
      const token = await journal.begin(`book:${index}`, 'record')
      await journal.commit(token, `d${index}`)
    }
    /* Twenty keys, one bracket each: nothing is superseded, so nothing is
     * dropped even though the floor was passed long ago. */
    expect(journal.entries().filter((e) => e.kind === 'commit')).toHaveLength(20)
    await journal.close()
  })

  it('answers a peer identically before and after compacting', async () => {
    const before = crashableFs()
    const uncompacted = journalOver(before, { compactEvery: 1_000_000 })
    await uncompacted.open()
    before.store.set('books/book_a/book.json', new TextEncoder().encode(JSON.stringify(REC)))
    await churn(uncompacted, 30)
    const wide = uncompacted.feed(0, uncompacted.head())
    const pushable = uncompacted.outbox()
    expect(uncompacted.entries().length).toBeGreaterThan(50)

    await uncompacted.compact()
    expect(uncompacted.entries().length).toBeLessThan(10)
    /* The same feed and the same outbox — the dropped lines were superseded
     * commits, which `feed` coalesced away in any case. */
    expect(uncompacted.feed(0, uncompacted.head())).toEqual(wide)
    expect(uncompacted.outbox()).toEqual(pushable)
    await uncompacted.close()
  })

  it('reopens a compacted journal without seeing corruption', async () => {
    const fs = crashableFs()
    const journal = journalOver(fs, { compactEvery: 20 })
    await journal.open()
    fs.store.set('books/book_a/book.json', new TextEncoder().encode(JSON.stringify(REC)))
    await churn(journal, 40)
    const head = journal.head()
    await journal.close()

    const seen: { moved: string; reason: string }[] = []
    const reopened = journalOver(fs, { compactEvery: 20, onQuarantine: (info) => seen.push(info) })
    await reopened.open()
    expect(seen).toHaveLength(0)
    expect(reopened.state()).toBe('ready')
    /* Seqs are preserved, so a peer's `since` still means what it meant. */
    expect(reopened.head()).toBe(head)
    await reopened.close()
  })
})
