import { LockHeld, acquireDataLock, type DataLock } from '../hosts/node/lock'
import { makeDataDir } from '../hosts/node/fs'
import { defaultDataDir, openNodeServices } from '../hosts/node/services'
import { messageOf, readingGrant } from '../kernel'
import { openLocalJournal, type LocalJournal } from '../capabilities/sync'
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
 * over the envelope. It is resolved HERE — `runCommand` parses first and then
 * asks `open` for a caller, and this is where the parsed `shelf` decides
 * WHICH caller to build rather than what to call. (This note used to say
 * "before the command is parsed", which was the intent, not the order.)
 * `args.ts` refuses a `--shelf` that appears after the verb for the same
 * reason: it is a global, not a service argument.
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
export async function paper({ argv, sinks, dataDir, remote, lockWaitMs }: PaperOptions): Promise<number> {
  let lock: DataLock | null = null
  /** Raised by `open` when no remote is wired; caught below, like the lock's. */
  let noRemote: Error | null = null
  /** Thrown by `open` when the lock is held; caught below so the message is
   *  one line rather than a stack. */
  let refusedBy: LockHeld | null = null

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
    const writes = !readingGrant(descriptor.grant)
    if (writes) {
      /* THE DIRECTORY FIRST. A lock published into a directory that does not
       * exist is ENOENT, not "held" — so on a machine that has never run
       * Paper, the first write failed before it could take a lock on the
       * library it was about to create.
       *
       * AND THE LOCK IS THE WHOLE ANSWER TO "IS THE APP RUNNING". The app
       * takes this same lock in Rust at setup (WI-20.40), so a writing
       * `paper` beside a running Paper is refused here, by name, with the
       * app's pid — and off macOS too. The `pgrep` that used to guess
       * answered `unknown` there and refused every write, and could not see
       * `pnpm app` here. */
      await makeDataDir(root)
      try {
        lock = await acquireDataLock(root, lockWaitMs === undefined ? {} : { waitMs: lockWaitMs })
      } catch (error) {
        if (!(error instanceof LockHeld)) throw error
        refusedBy = error
        throw error
      }
    }
    /* A READ HOLDS NO LOCK, SO IT MAY NOT WRITE — not even the shelf cache.
     * `loadShelf` rescans a stale index and used to write the result back
     * through the same `index.json.writing` temp the app's own index writes
     * use, so `paper book list` beside a running app was a second writer on
     * one filename. The rescan is served from memory instead. */
    const host = await openNodeServices({ dataDir: root, persist: writes })
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
     * With the lock held there is no second writer to ask about: the dirty
     * flag, if up, was left by a crash, and the journal opens without the
     * recovery pass the flag asks for (that pass is the app's). A failure to
     * open is thrown through after the host is closed — an open host behind
     * a failure leaks the file store and, on a directory this process just
     * locked, leaves the shelf loaded for nobody. */
    let journal: LocalJournal | null = null
    if (writes) {
      try {
        journal = await openLocalJournal({ services: host.services })
      } catch (error) {
        /* THE FIRST FAILURE IS THE ONE REPORTED. A `close()` that also
         * failed used to REPLACE it — the reader saw "could not close the
         * host" over the reason the journal would not open. */
        await host.close().catch((also: unknown) => {
          sinks.err(`paper: closing the host after that also failed — ${messageOf(also)}`)
        })
        throw error
      }
    }
    return localCaller({
      services: host.services,
      /* The journal first: its `close()` drains the shared queue and clears
       * the dirty flag, and the flag must come down before the process can
       * exit, or the next app start reads a crash that did not happen. */
      close: async () => {
        /* THE HOST CLOSES WHATEVER THE JOURNAL DID: a journal that would not
         * close used to skip the host's own drain, leaving the write queue
         * and the store unflushed on the way out. */
        try {
          await journal?.close()
        } finally {
          await host.close()
        }
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
    if (refusedBy === null || error !== refusedBy) {
      /* EVERY OTHER FAILURE STILL GETS A NAME AND AN EXIT CODE.
       *
       * `open()` runs before `runCommand`'s own try, so a library that will
       * not load, a missing filesystem or a remote that will not connect
       * rejected straight out of `paper()` — the bin saw an unhandled
       * rejection, the reader saw a stack trace, and a script saw whatever
       * Node exits with rather than a code it could branch on. The sentinels
       * above keep their specific messages; this is the floor under them. */
      sinks.err(`paper: ${plain(messageOf(error))}`)
      return EXIT.refused
    }
    /* REFUSED BY NAME, with the holder in the message: a lock that says only
     * "busy" is a lock people delete. */
    sinks.err(`paper: another writer holds this library — ${(refusedBy as LockHeld).message}`)
    return EXIT.refused
  } finally {
    /* After the caller, which `runCommand` closes — draining the write queue
     * is the last write, and the lock must outlive the last byte rather than
     * the last call. A release that FAILS is said and does not become the
     * exit: `paper()` promises an exit code, and a rejection out of a
     * `finally` replaced the code the command had earned with a stack. The
     * lock file is named so a human can remove what this could not. */
    try {
      await (lock as DataLock | null)?.release()
    } catch (error) {
      sinks.err(`paper: could not release the library lock — ${plain(messageOf(error))}`)
    }
  }
}
