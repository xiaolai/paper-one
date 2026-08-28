import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FIXTURE_FILES } from '../hosts/node/fixture.testkit'
import { LOCK_FILE, acquireDataLock, hostBootedAt, ownStartedAt, type LockOwner } from '../hosts/node/lock'
import { paper } from './paper'
import { EXIT, type CliSinks } from './run'

/**
 * A CLI WRITE REACHES THE SYNC JOURNAL (phase 11, WI-11.7).
 *
 * Until this existed it did not, and the consequence was not a slow sync but
 * no sync at all: `paper` composed the kernel's storage and never called
 * `bindRecorder`, so a mutation went to disk with no journal entry — and
 * replication is a journal feed. Measured on two machines, with the book's
 * folder present and `grep -c` on `journal.jsonl` answering `0`. Six
 * convergence steps across two runs waited for something that could not
 * happen.
 *
 * The cases below are the whole contract, and the refusals are what keep a
 * real library safe.
 */

const roots: string[] = []

async function library(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paper-journaling-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const full = join(root, rel)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return root
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

function sinks(): { sinks: CliSinks; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { sinks: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err }
}

/**
 * The app's take on the library, as `src-tauri/src/lock.rs` performs it:
 * the record written whole under a private name and `link`ed into place.
 * This process's own identity, so the CLI's liveness check finds it live by
 * pid, by start and by boot — the way a running Paper looks.
 */
async function appHolds(root: string): Promise<{ record: LockOwner; release: () => Promise<void> }> {
  const record: LockOwner = {
    pid: process.pid,
    host: hostname(),
    at: Date.now(),
    command: 'Paper',
    token: `app-${randomUUID()}`,
    startedAt: ownStartedAt(),
    bootedAt: hostBootedAt(),
  }
  const tmp = join(root, `.${LOCK_FILE}.${record.token}`)
  await writeFile(tmp, JSON.stringify(record))
  try {
    await link(tmp, join(root, LOCK_FILE))
  } finally {
    await rm(tmp, { force: true })
  }
  return { record, release: () => rm(join(root, LOCK_FILE), { force: true }) }
}

/** Every file under `root` with its size and mtime — what "wrote nothing" means. */
async function snapshot(root: string): Promise<Record<string, [number, number]>> {
  const out: Record<string, [number, number]> = {}
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const full = join(entry.parentPath, entry.name)
    const info = await stat(full)
    out[full.slice(root.length + 1)] = [info.size, info.mtimeMs]
  }
  return out
}

const journalAt = (root: string) => join(root, 'sync', 'journal.jsonl')
const dirtyAt = (root: string) => join(root, 'sync', 'journal.dirty')

describe('a CLI write and the journal', () => {
  it('journals the mutation, and closes the journal cleanly', async () => {
    const root = await library()
    const { sinks: s, err } = sinks()
    await expect(paper({ argv: ['book', 'add', 'wired', 'Wired'], sinks: s, dataDir: root })).resolves.toBe(EXIT.ok)
    expect(err).toEqual([])

    /* A `record` COMMIT FOR THIS BOOK — parsed, not grepped.
     *
     * The first version asserted the file contained `"wired"` and `"record"`
     * separately. Bootstrap writes a `record` entry for every book already on
     * the shelf, so the second half was satisfied by lines that had nothing to
     * do with this write, and the two could never contradict each other. A
     * journal is JSONL; reading it as such costs nothing and asserts the
     * actual claim. */
    const entries = (await readFile(journalAt(root), 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { kind: string; book: string; what: string })
    expect(entries.some((one) => one.kind === 'begin' && one.book === 'wired' && one.what === 'record')).toBe(true)
    expect(entries.some((one) => one.kind === 'commit' && one.book === 'wired' && one.what === 'record')).toBe(true)
    /* A clean close clears the flag. This is the half that lets the NEXT
     * command journal too; a CLI that left it up would disable itself. */
    expect(existsSync(dirtyAt(root))).toBe(false)
  })

  /**
   * THE SAFETY CASE, and the reason it is not gated on the flag.
   *
   * Two processes appending to one `journal.jsonl` would corrupt `nextSeq`
   * and the rev CAS — each holds them in memory, neither sees the other move
   * — and the app cannot take the advisory lock that would stop it.
   *
   * `journal.dirty` looks like the guard and is not: it means "not closed
   * cleanly", which is PERMANENTLY true in the field, because the app's
   * teardown hangs off `pagehide` and its async `journal.close()` cannot
   * finish before the process exits. Gating on it disabled journalling
   * outright on every machine the app had ever run.
   *
   * So the flag decides how to OPEN, and a live process decides WHETHER to.
   * With no Paper running there is no second writer: append, decline the
   * recovery pass the flag asks for, and leave the flag exactly as found so
   * the app still owes it.
   */
  it('journals a dirty library when no app holds it, and leaves the flag up', async () => {
    const root = await library()
    await mkdir(dirname(dirtyAt(root)), { recursive: true })
    await writeFile(dirtyAt(root), '')

    const { sinks: s, err } = sinks()
    await expect(paper({ argv: ['book', 'add', 'unwired', 'Unwired'], sinks: s, dataDir: root })).resolves.toBe(EXIT.ok)
    expect(err).toEqual([])

    /* The commit is in — this is the case that used to be silently lost. */
    expect(await readFile(journalAt(root), 'utf8')).toContain('"unwired"')
    /* THE FLAG SURVIVES. Clearing it would advertise a clean shutdown the app
     * never made, and the verify pass it owes would never run. */
    expect(existsSync(dirtyAt(root))).toBe(true)
  })

  /**
   * THE REFUSAL, with the app holding the library.
   *
   * With Paper live there IS a second writer, and appending would corrupt
   * `nextSeq` and the rev CAS. The app takes the data-root lock in Rust at
   * setup — the same file, the same record, published by `link` — so a
   * writing `paper` is refused BY THE LOCK, by name, and off macOS too. It
   * used to be refused by a `pgrep` for the bundle's executable path, which
   * could not see `pnpm app` and answered `unknown` everywhere else, where
   * every CLI write was therefore refused (WI-20.34).
   *
   * REFUSED rather than performed with a warning: the write would land on
   * disk, never enter the journal, never replicate, and stand to be
   * overwritten by the app that believes it owns the library. A script
   * reading the exit code could not tell that from a good write, and the
   * exit code is what automation reads. Nothing is written — not the book,
   * not the journal — and the flag the app left up stays up.
   */
  it('refuses the write by name when the app holds the library', async () => {
    const root = await library()
    await mkdir(dirname(dirtyAt(root)), { recursive: true })
    await writeFile(dirtyAt(root), '')
    /* THE JOURNAL THE OTHER PROCESS SUPPOSEDLY HOLDS. Without it the assertion
     * that nothing of ours reached it would be trivially true. */
    await writeFile(journalAt(root), '')
    const app = await appHolds(root)
    try {
      const { sinks: s, err } = sinks()
      await expect(
        paper({ argv: ['book', 'add', 'live', 'Live'], sinks: s, dataDir: root, lockWaitMs: 0 }),
      ).resolves.toBe(EXIT.refused)
      const said = err.join('\n')
      expect(said).toContain('another writer holds this library')
      expect(said).toContain('Paper')
      expect(said).toContain(String(app.record.pid))
    } finally {
      await app.release()
    }

    /* THE BOOK IS NOT THERE — asserted unconditionally, not "if the file
     * happens to exist". A refusal that still mutated would be the worst of
     * both: refused by exit code, written on disk. */
    const { sinks: s2, out } = sinks()
    await expect(paper({ argv: ['book', 'get', 'live', '--json'], sinks: s2, dataDir: root })).resolves.not.toBe(EXIT.ok)
    expect(out.join('')).not.toContain('"live"')
    /* And nothing of this book reached the journal the other process owns. */
    const entries = (await readFile(journalAt(root), 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { book: string })
    expect(entries.some((one) => one.book === 'live')).toBe(false)
    expect(existsSync(dirtyAt(root))).toBe(true)
  })

  /**
   * THE INTERLEAVING (Codex, round 2 of the phase-20 refute): a CLI checks,
   * the app takes ownership, the CLI resumes. Under the `link` protocol the
   * check IS the take — one syscall, one winner — so there is no "after its
   * check" to pause in, and the case reduces to its two outcomes: the app
   * first and the CLI refused (above), or the CLI first and the app refused.
   * This is the second. Exactly one journal opens either way.
   */
  it('refuses the app by name while a CLI write holds the library', async () => {
    const root = await library()
    const cli = await acquireDataLock(root, { command: 'paper book add racy Racy' })
    try {
      /* The app's own take, as `lock.rs` performs it: write whole, `link`.
       * `link` refuses an existing name, so the app reads who holds it. */
      const attempt = await appHolds(root).catch((error: unknown) => error)
      expect((attempt as { code?: string }).code).toBe('EEXIST')
      const holder = JSON.parse(await readFile(join(root, LOCK_FILE), 'utf8')) as { command: string; pid: number }
      expect(holder.command).toBe('paper book add racy Racy')
      expect(holder.pid).toBe(process.pid)
    } finally {
      await cli.release()
    }
    /* And with the CLI gone, the app's take is ordinary. */
    const app = await appHolds(root)
    await app.release()
  })

  /**
   * A READ HOLDS NO LOCK, SO IT WRITES NOTHING — not even the shelf cache.
   *
   * `paper book list` never took the lock (reads never do), but the host it
   * opened always ran `loadShelf`, and a rescan WROTE `index.json` through
   * the same `index.json.writing` temp the app's own index writes use. So
   * beside a running app a read was a second writer on one filename. The
   * fixture has no index — a first open, the case that rescans — and the app
   * holds the lock; the listing answers, and the tree is byte-for-byte what
   * it was.
   */
  it('performs no write or rename for a read while the app holds the library and the index is stale', async () => {
    const root = await library()
    const app = await appHolds(root)
    try {
      const before = await snapshot(root)
      const { sinks: s, out } = sinks()
      await expect(paper({ argv: ['book', 'list', '--json'], sinks: s, dataDir: root })).resolves.toBe(EXIT.ok)
      expect(out.join('')).toContain('"aaa"')
      expect(existsSync(join(root, 'index.json'))).toBe(false)
      expect(existsSync(join(root, 'index.json.writing'))).toBe(false)
      expect(await snapshot(root)).toEqual(before)
    } finally {
      await app.release()
    }
  })

  it('does not open a journal for a read', async () => {
    const root = await library()
    const { sinks: s } = sinks()
    await expect(paper({ argv: ['book', 'list', '--json'], sinks: s, dataDir: root })).resolves.toBe(EXIT.ok)
    /* A read that opened the journal would pay to load it and, worse, would
     * raise the flag on a library nobody is writing. */
    expect(existsSync(journalAt(root))).toBe(false)
    expect(existsSync(dirtyAt(root))).toBe(false)
  })
})
