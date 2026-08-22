import { LockHeld, acquireDataLock, type DataLock } from '../hosts/node/lock'
import { appPresence, makeDataDir, nodeFsyncPort, type AppPresence } from '../hosts/node/fs'
import { defaultDataDir, openNodeServices } from '../hosts/node/services'
import { readingGrant } from '../kernel'
import { JournalInUse, openLocalJournal, type LocalJournal } from '../capabilities/sync'
import { localCaller, type ServiceCaller } from './caller'
import { plain } from './format'
import { EXIT, runCommand, type CliSinks, type OpenCaller } from './run'

/**
 * `paper` — the process entry (WI-11.4), and the CLI's composition root.
 *
 * WITH NO SHELF CONFIGURED IT HOSTS `KernelServices` IN-PROCESS against the
 * local data directory and calls the handler directly. No daemon for `paper
 * book list` on your own machine: the books are files you own, the question
 * is about those files, and a background process to answer it would be a
 * second thing to install, supervise and debug for no gain.
 *
 * `--shelf <key>` is the other caller (WI-11.6): the identical command table
 * over the envelope. It is resolved HERE, before the command is parsed,
 * because it decides which caller to build rather than what to call — which
 * is why `args.ts` refuses it if one appears after the verb.
 *
 * Everything a command does lives in `run.ts`, which is pure but for the
 * caller and the two sinks. This file exists to build those three and to own
 * the process's exit.
 */

/* `readShelf` LIVED HERE AND IS GONE — `parseArgs` reads `--shelf` now.
 *
 * There were two parsers over one argv. This one scanned for `--shelf` and
 * removed it wherever it appeared; `parseArgs` then REFUSED a `--shelf` after
 * the verb, which nothing could reach because this had already taken it out.
 * So `paper book list --shelf k` was documented as an error, asserted as an
 * error by a test calling `parseArgs` directly, and worked perfectly in the
 * shipped binary. The test was measuring the parser that does not run.
 *
 * One parser now, and the flag behaves like `--json`: read wherever it
 * appears, because it decides which CALLER to build rather than what to call.
 */

export interface PaperOptions {
  readonly argv: readonly string[]
  readonly sinks: CliSinks
  /** The data directory. Defaults to the app's, on this platform. */
  readonly dataDir?: string
  /**
   * How a `--shelf <key>` command reaches that shelf.
   *
   * Injected rather than imported, because the envelope lives in a capability
   * and the boundary rules let nobody but a composition root reach one. The
   * bin supplies it; a test supplies a client over the fake wire; a build
   * without it says so by name instead of pretending the shelf is local.
   */
  readonly remote?: (shelf: string) => Promise<ServiceCaller>
  /**
   * Whether the reader's app is holding this library open.
   *
   * INJECTED SO A TEST DOES NOT DEPEND ON THE DEVELOPER'S DOCK. The default
   * asks the operating system, so a suite run with Paper open answered
   * differently from the same suite run with it closed — a test that passes
   * or fails on what else is running is not a test.
   */
  readonly appPresence?: () => Promise<AppPresence>
  /** How long a write waits for the lock before refusing. See `lock.ts`. */
  readonly lockWaitMs?: number
}

/**
 * Run `paper` once and answer with an exit code.
 *
 * The host is opened only when a command is actually going to run, so
 * `paper --help` and `paper nonsense` do not scan a 2 000-book library to
 * print a usage line. The caller is closed in a `finally`, so a command that
 * throws still drains the write queue — a CLI that exited with a write in
 * flight would be the one way this can lose a reader's work.
 */
export async function paper({
  argv,
  sinks,
  dataDir,
  remote,
  lockWaitMs,
  appPresence: presence = appPresence,
}: PaperOptions): Promise<number> {
  let lock: DataLock | null = null
  /** Raised by `open` when no remote is wired; caught below, like the lock's. */
  let noRemote: Error | null = null
  /** Thrown by `open` when the lock is held; caught below so the message is
   *  one line rather than a stack. */
  let refusedBy: LockHeld | null = null
  let journalBusy: JournalInUse | null = null

  const open: OpenCaller = async (descriptor, shelf) => {
    if (shelf !== null) {
      /* CHECKED HERE, not before the parse. `paper --shelf k --help` is a
       * request for help and gets it; a mistyped verb is a usage error and
       * says so. Answering "cannot reach a remote shelf" to either would be
       * refusing a question that was never about the shelf. */
      if (!remote) {
        noRemote = new Error('no remote')
        throw noRemote
      }
      return remote(shelf)
    }

    const root = dataDir ?? defaultDataDir()
    /* THE LOCK IS TAKEN BEFORE THE HOST IS OPENED, and only for a command
     * that WRITES — read from the service's own grant, so a service added to
     * the table is locked or not by its declaration and there is no second
     * derivation to keep in step. Before, because opening a host reads the
     * shelf and may rewrite `index.json`, which is itself a write into the
     * directory a second `paper` might be halfway through. Only for writes,
     * because `paper book list` beside a running import is a perfectly safe
     * thing to want and a read that queued behind one would make the CLI feel
     * broken for no gain. */
    if (!readingGrant(descriptor.grant)) {
      /* THE DIRECTORY FIRST. `wx` on a path whose parent does not exist is
       * ENOENT, not EEXIST — so on a machine that has never run Paper, the
       * first write failed before it could take a lock on the library it was
       * about to create. */
      await makeDataDir(root)
      try {
        lock = await acquireDataLock(root, lockWaitMs === undefined ? {} : { waitMs: lockWaitMs })
      } catch (error) {
        if (!(error instanceof LockHeld)) throw error
        refusedBy = error
        throw error
      }
    }
    const host = await openNodeServices({ dataDir: root })
    /* THE JOURNAL, FOR A WRITE, ON THE SAME CONDITION AS THE LOCK — read from
     * the service's grant, so there is no second derivation of "this command
     * writes" to keep in step with the first.
     *
     * Without it a CLI mutation reached disk and never reached sync, so it
     * could not replicate to another machine at all — not slowly, not
     * eventually: the journal is the feed, and the entry was never in it. A
     * read stays out of this entirely; `paper book list` should not pay to
     * open a journal it cannot dirty.
     *
     * `openLocalJournal` REFUSES when the app holds the journal, which is the
     * safety this write path never had. It is caught rather than thrown
     * through so the host is closed — an open host behind a refusal leaks the
     * file store and, on a directory this process just locked, leaves the
     * shelf loaded for nobody. */
    let journal: LocalJournal | null = null
    if (!readingGrant(descriptor.grant)) {
      /* THE DIRTY FLAG IS NOT THE QUESTION; A LIVE SECOND WRITER IS.
       *
       * The flag says "not closed cleanly", which in the field is close to
       * permanent — an app killed mid-teardown leaves it up. So the flag
       * decides how to OPEN a journal, and a live process decides WHETHER to.
       * `absent` is the only answer that permits it: `unknown` is treated as
       * `running`, because a guess in the permissive direction puts a second
       * writer on `journal.jsonl` and corrupts `nextSeq` and the rev CAS. */
      const openable = (await presence()) === 'absent'
      try {
        journal = await openLocalJournal({
          services: host.services,
          fsync: nodeFsyncPort(host.dataDir),
          allowDirty: openable,
        })
      } catch (error) {
        await host.close()
        if (!(error instanceof JournalInUse)) throw error
        /* REFUSED, NOT WARNED, and this is a deliberate change of behaviour.
         *
         * The write would land on disk and never enter the journal, so it
         * could never replicate and the app — which believes it owns the
         * library — may overwrite it. `paper` used to do it anyway and print
         * a warning, which meant a script reading the exit code could not
         * tell a durable, replicating write from a doomed one. Exit codes are
         * what automation reads, and this one was lying.
         *
         * It costs the reader nothing they cannot undo in a second: quit
         * Paper and run it again. `docs/cli.md` has always said not to write
         * while the app is open; this enforces it instead of advising it.
         * Reads are untouched. */
        journalBusy = error
        throw error
      }
    }
    return localCaller({
      services: host.services,
      /* The journal first: its `close()` drains the shared queue and clears
       * the dirty flag, and the flag must come down before the process can
       * exit, or the next app start reads a crash that did not happen. */
      close: async () => {
        await journal?.close()
        await host.close()
      },
    })
  }

  try {
    return await runCommand(argv, open, sinks)
  } catch (error) {
    if (noRemote !== null && error === noRemote) {
      sinks.err('paper: this build cannot reach a remote shelf')
      return EXIT.usage
    }
    if (journalBusy !== null && error === journalBusy) {
      /* Cast for the same reason `refusedBy` below is cast: the assignment
       * happens inside the `open` closure, which control-flow analysis cannot
       * see, so it narrows this to `null` and then to `never`. */
      sinks.err(`paper: ${(journalBusy as JournalInUse).message}`)
      sinks.err('paper: quit Paper on this machine and run this again — a write made now could not replicate')
      return EXIT.refused
    }
    if (refusedBy === null || error !== refusedBy) {
      /* EVERY OTHER FAILURE STILL GETS A NAME AND AN EXIT CODE.
       *
       * `open()` runs before `runCommand`'s own try, so a library that will
       * not load, a missing filesystem or a remote that will not connect
       * rejected straight out of `paper()` — the bin saw an unhandled
       * rejection, the reader saw a stack trace, and a script saw whatever
       * Node exits with rather than a code it could branch on. The sentinels
       * above keep their specific messages; this is the floor under them. */
      sinks.err(`paper: ${plain(error instanceof Error ? error.message : String(error))}`)
      return EXIT.refused
    }
    /* REFUSED BY NAME, with the holder in the message: a lock that says only
     * "busy" is a lock people delete. */
    sinks.err(`paper: another writer holds this library — ${(refusedBy as LockHeld).message}`)
    return EXIT.refused
  } finally {
    /* After the caller, which `runCommand` closes — draining the write queue
     * is the last write, and the lock must outlive the last byte rather than
     * the last call. */
    await (lock as DataLock | null)?.release()
  }
}
