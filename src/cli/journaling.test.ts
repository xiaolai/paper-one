import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FIXTURE_FILES } from '../hosts/node/fixture.testkit'
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

const journalAt = (root: string) => join(root, 'sync', 'journal.jsonl')
const dirtyAt = (root: string) => join(root, 'sync', 'journal.dirty')

describe('a CLI write and the journal', () => {
  it('journals the mutation, and closes the journal cleanly', async () => {
    const root = await library()
    const { sinks: s, err } = sinks()
    await expect(paper({ argv: ['book', 'add', 'wired', 'Wired'], sinks: s, dataDir: root, appPresence: async () => 'absent' as const })).resolves.toBe(EXIT.ok)
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
    await expect(paper({ argv: ['book', 'add', 'unwired', 'Unwired'], sinks: s, dataDir: root, appPresence: async () => 'absent' as const })).resolves.toBe(EXIT.ok)
    expect(err).toEqual([])

    /* The commit is in — this is the case that used to be silently lost. */
    expect(await readFile(journalAt(root), 'utf8')).toContain('"unwired"')
    /* THE FLAG SURVIVES. Clearing it would advertise a clean shutdown the app
     * never made, and the verify pass it owes would never run. */
    expect(existsSync(dirtyAt(root))).toBe(true)
  })

  /**
   * THE REFUSAL, on the one input this machine cannot be asked to produce.
   *
   * With Paper live there IS a second writer, and appending would corrupt
   * `nextSeq` and the rev CAS. The command is REFUSED rather than performed
   * with a warning: the write would land on disk, never enter the journal,
   * never replicate, and stand to be overwritten by the app that believes it
   * owns the library. A script reading the exit code could not tell that from
   * a good write, and the exit code is what automation reads.
   *
   * Nothing is written — not the book, not the journal.
   */
  it('refuses the write outright when the app holds the library', async () => {
    const root = await library()
    await mkdir(dirname(dirtyAt(root)), { recursive: true })
    await writeFile(dirtyAt(root), '')
    /* THE JOURNAL THE OTHER PROCESS SUPPOSEDLY HOLDS. Without it the refusal
     * could be about an absent file rather than a held one, and the assertion
     * that nothing of ours reached it would be trivially true. */
    await writeFile(journalAt(root), '')

    const { sinks: s, err } = sinks()
    await expect(
      paper({
        argv: ['book', 'add', 'live', 'Live'],
        sinks: s,
        dataDir: root,
        appPresence: async () => 'running' as const,
      }),
    ).resolves.toBe(EXIT.refused)
    expect(err.join('\n')).toContain('quit Paper')

    /* THE BOOK IS NOT THERE — asserted unconditionally, not "if the file
     * happens to exist". A refusal that still mutated would be the worst of
     * both: refused by exit code, written on disk. */
    const { sinks: s2, out } = sinks()
    await expect(
      paper({ argv: ['book', 'get', 'live', '--json'], sinks: s2, dataDir: root, appPresence: async () => 'absent' as const }),
    ).resolves.not.toBe(EXIT.ok)
    expect(out.join('')).not.toContain('"live"')
    /* And nothing of this book reached the journal the other process owns.
     * The journal is CREATED here first, because "the file does not exist" and
     * "the file exists without this book" are different claims and only the
     * second is the one being made. */
    const journal = journalAt(root)
    expect(existsSync(journal)).toBe(true)
    const entries = (await readFile(journal, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { book: string })
    expect(entries.some((one) => one.book === 'live')).toBe(false)
    expect(existsSync(dirtyAt(root))).toBe(true)
  })

  /**
   * THE STARTUP WINDOW — a live app whose dirty flag is not yet up.
   *
   * `open()` writes the flag before it returns, so there is a moment where
   * the app holds the library and the flag says otherwise. Gating on the flag
   * alone let the CLI open a journal in exactly that moment, which is two
   * writers on one `journal.jsonl`. The caller's answer has to bind whatever
   * the flag says.
   */
  it('refuses to journal beside a live app even when the flag is down', async () => {
    const root = await library()
    const { sinks: s, err } = sinks()
    await expect(
      paper({
        argv: ['book', 'add', 'racy', 'Racy'],
        sinks: s,
        dataDir: root,
        appPresence: async () => 'running' as const,
      }),
    ).resolves.toBe(EXIT.refused)
    expect(err.join('\n')).toContain('Paper is running')
    expect(existsSync(journalAt(root))).toBe(false)
  })

  /* An undecidable answer is treated as a live app, not as a free pass —
   * `absent` is the only answer that unlocks journalling. */
  it('refuses to journal when the app cannot be probed', async () => {
    const root = await library()
    const { sinks: s, err } = sinks()
    await expect(
      paper({
        argv: ['book', 'add', 'murky', 'Murky'],
        sinks: s,
        dataDir: root,
        appPresence: async () => 'unknown' as const,
      }),
    ).resolves.toBe(EXIT.refused)
    expect(err.join('\n')).toContain('could not be determined')
    expect(existsSync(journalAt(root))).toBe(false)
  })

  it('does not open a journal for a read', async () => {
    const root = await library()
    const { sinks: s } = sinks()
    await expect(paper({ argv: ['book', 'list', '--json'], sinks: s, dataDir: root, appPresence: async () => 'absent' as const })).resolves.toBe(EXIT.ok)
    /* A read that opened the journal would pay to load it and, worse, would
     * raise the flag on a library nobody is writing. */
    expect(existsSync(journalAt(root))).toBe(false)
    expect(existsSync(dirtyAt(root))).toBe(false)
  })
})
