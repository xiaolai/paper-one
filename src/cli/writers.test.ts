import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MUTATION_KINDS, SERVICE_TABLE, readingGrant, type MutationKind, type MutationToken } from '../kernel'
import { FIXTURE_FILES } from '../hosts/node/fixture.testkit'
import { LOCK_FILE, LockHeld, acquireDataLock } from '../hosts/node/lock'
import { openNodeServices, type NodeHost } from '../hosts/node/services'
import { localCaller } from './caller'
import { paper } from './paper'
import { EXIT, runCommand } from './run'

/**
 * THE WRITE SERVICES, AND THE WRITER QUESTION (WI-11.5).
 *
 * Two properties, and the plan names both.
 *
 * ONE JOURNAL BRACKET PER MUTATION, no dangling begin. The journal plugs into
 * the kernel at `bindRecorder`, so a recorder bound here sees exactly what a
 * journal would see — the same `begin`/`commit` pairs, in the same order, on
 * the same queued task. A CLI write that produced two brackets, or one that
 * left a begin open, would be a write a journal could not settle.
 *
 * TWO WRITERS CANNOT INTERLEAVE. The advisory lock is an atomic exclusive
 * create, so the second `paper` is refused by name with the holder's pid in
 * the message. What it does NOT cover is stated in `lock.ts` and measured in
 * `sync/lib/secondWriter.test.ts`: the app does not take this lock, because a
 * webview's filesystem has no exclusive create.
 */

const roots: string[] = []
const hosts: NodeHost[] = []

async function library(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paper-writers-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const full = join(root, rel)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return root
}

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()?.close()
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

/** What the recorder saw — the journal's own view of a write. */
interface Bracket {
  readonly kind: 'begin' | 'commit'
  readonly book: string
  readonly what: MutationKind
}

/** A host with a recording `MutationRecorder` bound, exactly where a journal
 *  binds. Nothing about the write path changes; this only watches it. */
async function watched(dataDir: string): Promise<{ host: NodeHost; seen: Bracket[] }> {
  const host = await openNodeServices({ dataDir })
  hosts.push(host)
  const seen: Bracket[] = []
  host.services.bindRecorder({
    begin: async (book, what) => {
      seen.push({ kind: 'begin', book, what })
      return { book, what }
    },
    commit: async (token: MutationToken) => {
      seen.push({ kind: 'commit', book: token.book, what: token.what })
    },
  })
  return { host, seen }
}

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

async function through(host: NodeHost, argv: readonly string[]): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const code = await runCommand(argv, async () => localCaller({ services: host.services }), {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  await host.services.drain()
  return { code, out: out.join('\n'), err: err.join('\n') }
}

/** Every begin matched by a commit, in order, and nothing left open. */
function bracketsAreWholeAndPaired(seen: readonly Bracket[]): { pairs: number; dangling: number } {
  const open = new Map<string, number>()
  let pairs = 0
  for (const entry of seen) {
    const key = `${entry.what}\u0000${entry.book}`
    if (entry.kind === 'begin') open.set(key, (open.get(key) ?? 0) + 1)
    else {
      const held = open.get(key) ?? 0
      expect(held).toBeGreaterThan(0)
      open.set(key, held - 1)
      pairs += 1
    }
  }
  return { pairs, dangling: [...open.values()].reduce((total, one) => total + one, 0) }
}

describe('every write service, through the CLI', () => {
  /* WHICH COMMANDS LOCK is read from the service's own grant, in the entry,
   * from the descriptor the parse produced — so there is no second derivation
   * from argv to keep in step with the table. Asserted through `paper()`,
   * because that is where it is decided. */
  it('takes the lock for every write service and for no read service', async () => {
    for (const descriptor of SERVICE_TABLE) {
      const dataDir = await library()
      const held = await acquireDataLock(dataDir)
      try {
        const err: string[] = []
        const words: string[] = [descriptor.noun, descriptor.verb]
        /* A CROSS-FIELD RULE IS NOT ON ANY FIELD, so a body built from
         * `required` alone is a usage error for `mark.set` — and a usage error
         * never reaches the lock, which is the very thing being measured. */
        const needed = new Set<string>(descriptor.atLeastOne?.slice(0, 1) ?? [])
        for (const field of descriptor.input) {
          if (field.required !== true && !needed.has(field.name)) continue
          /* A field with a closed vocabulary takes one of its words. */
          const value = field.choices?.[0] ?? (field.type === 'number' ? '1' : 'aaa')
          if (field.positional !== undefined) words.push(value)
          else if (field.type === 'boolean') words.push(`--${field.name}`)
          else words.push(`--${field.name}`, value)
        }
        const code = await paper({
          argv: words,
          dataDir,
          lockWaitMs: 0,
          sinks: { out: () => {}, err: (line) => err.push(line) },
        })
        const refused = err.join('\n').includes('another writer holds this library')
        expect({ name: descriptor.name, refused }).toEqual({
          name: descriptor.name,
          refused: !readingGrant(descriptor.grant),
        })
        if (refused) expect(code).toBe(EXIT.refused)
      } finally {
        await held.release()
      }
    }
  })

  /* A command that is about to be a usage error must not scan a library, nor
   * queue behind somebody's import, to be told it is a typo. */
  it('opens nothing for help or for a usage error', async () => {
    const dataDir = await library()
    const held = await acquireDataLock(dataDir)
    try {
      for (const argv of [['--help'], ['book', 'lst'], ['book', 'set']]) {
        const out: string[] = []
        const err: string[] = []
        const code = await paper({
          argv,
          dataDir,
          lockWaitMs: 0,
          sinks: { out: (line) => out.push(line), err: (line) => err.push(line) },
        })
        expect({ argv, code }).toEqual({ argv, code: argv[0] === '--help' ? EXIT.ok : EXIT.usage })
        expect(err.join('\n')).not.toContain('another writer holds this library')
      }
    } finally {
      await held.release()
    }
  })

  it('sets fields on a record, and the change is on disk', async () => {
    const dataDir = await library()
    const { host } = await watched(dataDir)
    expect((await through(host, ['book', 'set', 'bbb', '--title', 'Moby-Dick or, The Whale'])).code).toBe(EXIT.ok)
    const written = JSON.parse(await readFile(join(dataDir, 'books/bbb/book.json'), 'utf8')) as { title: string }
    expect(written.title).toBe('Moby-Dick or, The Whale')
  })

  it('adds and removes a book, and a removal is recoverable', async () => {
    const dataDir = await library()
    const { host } = await watched(dataDir)
    expect((await through(host, ['book', 'add', 'ddd', 'A New One', 'An Author'])).code).toBe(EXIT.ok)
    expect(host.services.library.getSnapshot().some((one) => one.bookId === 'ddd')).toBe(true)

    expect((await through(host, ['book', 'remove', 'aaa'])).code).toBe(EXIT.ok)
    expect(host.services.library.getSnapshot().some((one) => one.bookId === 'aaa')).toBe(false)
    /* To the trash, not away — and `trash list` can see it. */
    const trash = JSON.parse((await through(host, ['trash', 'list', '--json'])).out) as { bookId: string }[]
    expect(trash.map((one) => one.bookId)).toContain('aaa')

    expect((await through(host, ['book', 'restore', 'aaa'])).code).toBe(EXIT.ok)
    expect(host.services.library.getSnapshot().some((one) => one.bookId === 'aaa')).toBe(true)
  })

  it('writes, edits and removes a mark', async () => {
    const dataDir = await library()
    const { host } = await watched(dataDir)
    const made = JSON.parse(
      (await through(host, ['mark', 'add', 'bbb', 'epubcfi(/6/4!/4/2/1:0)', 'call me Ishmael', '--json'])).out,
    ) as { id: string }
    expect(made.id).toBeTruthy()

    expect((await through(host, ['mark', 'set', made.id, '--note', 'the opening', '--book', 'bbb'])).code).toBe(EXIT.ok)
    const listed = JSON.parse((await through(host, ['mark', 'list', 'bbb', '--json'])).out) as { note: string }[]
    expect(listed.map((one) => one.note)).toContain('the opening')

    expect((await through(host, ['mark', 'set', made.id, '--colour', 'green', '--book', 'bbb'])).code).toBe(EXIT.ok)
    const recoloured = JSON.parse((await through(host, ['mark', 'list', 'bbb', '--json'])).out) as { tint: string }[]
    expect(recoloured.map((one) => one.tint)).toContain('green')

    expect((await through(host, ['mark', 'remove', made.id, '--book', 'bbb'])).code).toBe(EXIT.ok)
    expect(JSON.parse((await through(host, ['mark', 'list', 'bbb', '--json'])).out)).toEqual([])
  })

  it('adds and removes a card', async () => {
    const { host } = await watched(await library())
    const made = JSON.parse((await through(host, ['card', 'add', 'a thought', '--kind', 'Idea', '--json'])).out) as {
      id: string
    }
    expect(JSON.parse((await through(host, ['card', 'list', '--json'])).out)).toHaveLength(1)
    expect((await through(host, ['card', 'remove', made.id])).code).toBe(EXIT.ok)
    expect(JSON.parse((await through(host, ['card', 'list', '--json'])).out)).toEqual([])
  })

  it('tags, untags and renames across the shelf', async () => {
    const { host } = await watched(await library())
    expect((await through(host, ['tag', 'add', 'whales', '--book', 'bbb'])).code).toBe(EXIT.ok)
    expect((await through(host, ['tag', 'rename', 'whales', 'cetaceans'])).code).toBe(EXIT.ok)
    const tags = JSON.parse((await through(host, ['tag', 'list', '--json'])).out) as { tag: string }[]
    expect(tags.map((one) => one.tag)).toContain('cetaceans')
    expect(tags.map((one) => one.tag)).not.toContain('whales')
    expect((await through(host, ['tag', 'remove', 'cetaceans'])).code).toBe(EXIT.ok)
    const after = JSON.parse((await through(host, ['tag', 'list', '--json'])).out) as { tag: string }[]
    expect(after.map((one) => one.tag)).not.toContain('cetaceans')
  })

  it('evicts this device’s bytes without touching the record', async () => {
    const dataDir = await library()
    const { host } = await watched(dataDir)
    const gone = JSON.parse((await through(host, ['content', 'evict', 'aaa', '--json'])).out) as { here: boolean }
    expect(gone.here).toBe(false)
    /* The RECORD is untouched: eviction is about this device's copy. */
    expect(host.services.library.getSnapshot().some((one) => one.bookId === 'aaa')).toBe(true)
    await expect(readFile(join(dataDir, 'books/aaa/content.epub'))).rejects.toThrow()
  })

  it('empties the trash only for the count the caller expects', async () => {
    const { host } = await watched(await library())
    await through(host, ['book', 'remove', 'aaa'])
    const wrong = await through(host, ['trash', 'empty', '5'])
    expect(wrong.code).toBe(EXIT.refused)
    expect(wrong.err).toContain('nothing was deleted')
    const right = await through(host, ['trash', 'empty', '1'])
    expect(right.code).toBe(EXIT.ok)
    expect(JSON.parse((await through(host, ['trash', 'list', '--json'])).out)).toEqual([])
  })

  it('refuses shelf.sync and shelf.verify where no sync capability is composed', async () => {
    const { host } = await watched(await library())
    for (const argv of [['shelf', 'sync'], ['shelf', 'verify']]) {
      const run = await through(host, argv)
      expect(run.code).toBe(EXIT.refused)
      expect(run.err).toContain('unsupported')
    }
  })
})

describe('the journal bracket a CLI write leaves', () => {
  it('is one begin/commit pair per mutation, with nothing dangling', async () => {
    const dataDir = await library()
    const { host, seen } = await watched(dataDir)
    await through(host, ['book', 'set', 'bbb', '--title', 'Renamed'])
    const { pairs, dangling } = bracketsAreWholeAndPaired(seen)
    expect(pairs).toBe(1)
    expect(dangling).toBe(0)
    expect(seen.map((one) => one.kind)).toEqual(['begin', 'commit'])
    expect(seen[0]?.book).toBe('bbb')
    expect(seen[0]?.what).toBe('record')
  })

  it('brackets a mark write under its own kind, on the book it belongs to', async () => {
    const { host, seen } = await watched(await library())
    await through(host, ['mark', 'add', 'bbb', 'epubcfi(/6/4!/4/2/1:0)', 'a passage'])
    const { pairs, dangling } = bracketsAreWholeAndPaired(seen)
    expect(pairs).toBe(1)
    expect(dangling).toBe(0)
    expect(seen[0]?.what).toBe('marks')
    expect(seen[0]?.book).toBe('bbb')
  })

  it('brackets every kind it touches, and only kinds the kernel declares', async () => {
    const { host, seen } = await watched(await library())
    await through(host, ['book', 'set', 'bbb', '--finished'])
    await through(host, ['mark', 'add', 'aaa', 'epubcfi(/6/4!/4/2/1:1)', 'x'])
    await through(host, ['card', 'add', 'a thought'])
    await through(host, ['content', 'evict', 'aaa'])
    const { dangling } = bracketsAreWholeAndPaired(seen)
    expect(dangling).toBe(0)
    for (const entry of seen) expect(MUTATION_KINDS).toContain(entry.what)
    expect(new Set(seen.map((one) => one.what))).toEqual(new Set(['record', 'marks', 'cards', 'content']))
  })

  it('leaves no bracket at all for a write the service refused', async () => {
    const { host, seen } = await watched(await library())
    expect((await through(host, ['book', 'set', 'nope', '--title', 'x'])).code).toBe(EXIT.refused)
    expect(seen).toEqual([])
  })
})

describe('two writers cannot interleave', () => {
  it('refuses the second by name, with the holder’s pid in the message', async () => {
    const dataDir = await library()
    const held = await acquireDataLock(dataDir, { command: 'paper book set …' })
    try {
      const err: string[] = []
      const code = await paper({
        argv: ['book', 'set', 'bbb', '--title', 'Second'],
        dataDir,
        lockWaitMs: 0,
        sinks: { out: () => {}, err: (line) => err.push(line) },
      })
      expect(code).toBe(EXIT.refused)
      expect(err.join('\n')).toContain('another writer holds this library')
      expect(err.join('\n')).toContain(String(held.owner.pid))
      /* AND NOTHING WAS WRITTEN. A refusal that had already changed the file
       * would be the worst of both. */
      const record = JSON.parse(await readFile(join(dataDir, 'books/bbb/book.json'), 'utf8')) as { title: string }
      expect(record.title).toBe('Moby-Dick')
    } finally {
      await held.release()
    }
  })

  it('lets a READ through while a writer holds the lock', async () => {
    const dataDir = await library()
    const held = await acquireDataLock(dataDir)
    try {
      const out: string[] = []
      const code = await paper({
        argv: ['book', 'list', '--json'],
        dataDir,
        lockWaitMs: 0,
        sinks: { out: (line) => out.push(line), err: () => {} },
      })
      expect(code).toBe(EXIT.ok)
      expect(JSON.parse(out.join('\n'))).toHaveLength(3)
    } finally {
      await held.release()
    }
  })

  it('takes the lock, does the write, and gives it back', async () => {
    const dataDir = await library()
    const code = await paper({
      argv: ['book', 'set', 'bbb', '--title', 'Locked and written'],
      dataDir,
      sinks: { out: () => {}, err: () => {} },
    })
    expect(code).toBe(EXIT.ok)
    const record = JSON.parse(await readFile(join(dataDir, 'books/bbb/book.json'), 'utf8')) as { title: string }
    expect(record.title).toBe('Locked and written')
    /* Released, so the next writer is not refused by a ghost. */
    await expect(readFile(join(dataDir, LOCK_FILE))).rejects.toThrow()
  })

  /* The lock is taken BEFORE the host is opened, so opening the host is the
   * first thing that can throw while it is held. Written the obvious way —
   * the release in a `finally` around the command — a throw there left the
   * file on disk with this process's pid in it, and the next `paper` waited
   * for a process that had already exited. */
  it('gives the lock back when opening the library throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paper-writers-'))
    roots.push(root)
    /* `books` as a FILE: the shelf read fails with ENOTDIR, which is what an
     * unreadable library looks like rather than an absent one. */
    await writeFile(join(root, 'books'), 'not a directory')
    const err: string[] = []
    /* A NAMED REFUSAL AND AN EXIT CODE, not a rejection.
     *
     * `open()` runs before `runCommand`'s own try, so this used to reject
     * straight out of `paper()`: the bin saw an unhandled rejection, the
     * reader saw a stack trace, and a script saw whatever Node exits with
     * rather than a code it could branch on. The lock still has to come back
     * either way, which is what this test was really for. */
    await expect(
      paper({
        argv: ['book', 'set', 'bbb', '--title', 'x'],
        dataDir: root,
        sinks: { out: () => {}, err: (line) => err.push(line) },
      }),
    ).resolves.toBe(EXIT.refused)
    expect(err.join('\n')).toContain('paper:')
    await expect(readFile(join(root, LOCK_FILE))).rejects.toThrow()
  })

  it('gives the lock back even when the command failed', async () => {
    const dataDir = await library()
    expect(
      await paper({
        argv: ['book', 'set', 'nope', '--title', 'x'],
        dataDir,
        sinks: { out: () => {}, err: () => {} },
      }),
    ).toBe(EXIT.refused)
    await expect(readFile(join(dataDir, LOCK_FILE))).rejects.toThrow()
  })

  it('waits, then refuses, when the holder does not let go', async () => {
    const dataDir = await library()
    const held = await acquireDataLock(dataDir)
    try {
      const slept: number[] = []
      let clock = 0
      await expect(
        acquireDataLock(dataDir, {
          waitMs: 300,
          pollMs: 100,
          now: () => clock,
          sleep: async (ms) => {
            slept.push(ms)
            clock += ms
          },
        }),
      ).rejects.toBeInstanceOf(LockHeld)
      /* It actually waited rather than refusing on sight. */
      expect(slept.reduce((total, one) => total + one, 0)).toBe(300)
    } finally {
      await held.release()
    }
  })

  it('reclaims a lock whose holder is gone, on this host', async () => {
    const dataDir = await library()
    await writeFile(
      join(dataDir, LOCK_FILE),
      JSON.stringify({ pid: 999_999, host: (await import('node:os')).hostname(), at: 1, command: 'paper' }),
    )
    const taken = await acquireDataLock(dataDir, { waitMs: 0, alive: () => false })
    expect(taken.owner.pid).toBe(process.pid)
    await taken.release()
  })

  /* Liveness cannot be checked across a machine, and guessing in the
   * permissive direction is how two writers happen. */
  /* THE RENAME HAS ONE WINNER, but that alone does not close the race: A
   * reads stale S; B reads stale S, reclaims it and creates B's lock; A then
   * renames B's LIVE lock aside and creates its own. So what was moved is
   * read back, and anything that is not the stale owner we judged is put
   * straight back. */
  it('puts a lock back when the file it moved aside was not the stale one', async () => {
    const dataDir = await library()
    const stale = { pid: 999_999, host: (await import('node:os')).hostname(), at: 1, command: 'crashed', token: 'stale-token' }
    await writeFile(join(dataDir, LOCK_FILE), JSON.stringify(stale))
    /* `alive` says the stale pid is gone, so reclamation starts — but the
     * file it finds under the lock's name is somebody ELSE'S live one. */
    const live = { pid: process.pid, host: stale.host, at: 2, command: 'the other writer', token: 'live-token' }
    let looked = 0
    await expect(
      acquireDataLock(dataDir, {
        waitMs: 0,
        alive: (pid) => {
          /* Swapped in exactly once, between the stale read and the rename. */
          if (looked++ === 0) writeFileSync(join(dataDir, LOCK_FILE), JSON.stringify(live))
          return pid === process.pid
        },
      }),
    ).rejects.toBeInstanceOf(LockHeld)
    /* The live lock is still where its owner left it. */
    const after = JSON.parse(await readFile(join(dataDir, LOCK_FILE), 'utf8')) as { token: string }
    expect(after.token).toBe('live-token')
  })

  it('never reclaims a lock from another host, however old', async () => {
    const dataDir = await library()
    await writeFile(
      join(dataDir, LOCK_FILE),
      JSON.stringify({ pid: 1, host: 'some-other-mac', at: 1, command: 'paper book add' }),
    )
    await expect(acquireDataLock(dataDir, { waitMs: 0, alive: () => false })).rejects.toBeInstanceOf(LockHeld)
  })

  /* A lock file we cannot understand is HELD by somebody unnameable, not
   * free. Reclaiming one is exactly the move that turns one confused writer
   * into two. */
  it('treats an unreadable lock file as held rather than as absent', async () => {
    const dataDir = await library()
    await writeFile(join(dataDir, LOCK_FILE), 'not json at all')
    await expect(acquireDataLock(dataDir, { waitMs: 0, alive: () => false })).rejects.toBeInstanceOf(LockHeld)
  })

  it('does not remove a lock that was reclaimed from it', async () => {
    const dataDir = await library()
    const mine = await acquireDataLock(dataDir)
    /* Somebody else decided we were stale and took it. */
    await rm(join(dataDir, LOCK_FILE), { force: true })
    const theirs = await acquireDataLock(dataDir, { command: 'the other one' })
    await mine.release()
    /* Still theirs: our release removed nothing, because it no longer owned
     * anything. */
    const owner = JSON.parse(await readFile(join(dataDir, LOCK_FILE), 'utf8')) as { command: string }
    expect(owner.command).toBe('the other one')
    await theirs.release()
  })
})
