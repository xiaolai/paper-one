import { randomUUID } from 'node:crypto'
import { link, open, readFile, rename, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

/**
 * THE ADVISORY LOCK — WI-11.5's answer to the writer question, and an
 * interim one that says so.
 *
 * `journal.ts` has CAS on `rev` and `writeQueue.ts` serialises writes WITHIN
 * a process. Nothing coordinates two processes writing one library. A
 * read-only CLI is safe today; a writing one is not, and the honest thing is
 * to say which parts of that this fixes and which it does not.
 *
 * WHAT IT FIXES: two `paper` processes. `open(path, 'wx')` is an atomic
 * exclusive create — the POSIX primitive, not a check-then-write — so exactly
 * one of two simultaneous writers gets the file and the other is refused by
 * name, with the holder's pid and command in the message.
 *
 * WHAT IT DOES NOT FIX, and this is stated here rather than only in the docs
 * because it is the thing a reader of this file will otherwise assume: THE
 * APP DOES NOT TAKE THIS LOCK. It cannot — a webview's filesystem is the
 * Tauri fs plugin, which has no exclusive create, and giving it one is a Rust
 * command with an ACL entry and a manifest change that this phase does not
 * make. So `paper book set` while the app is open is not blocked, and
 * `secondWriter.test.ts` measures exactly what it costs: after a clean
 * shutdown the journal never notices the change, so it never pushes.
 *
 * THE DAEMON IS THE EVENTUAL ANSWER — one process owning the library, every
 * caller reaching it over the envelope — and this is not it. The trigger for
 * revisiting is in the plan's "Deferred, deliberately": the phone needing to
 * sync with the desktop UI closed, or the CLI needing to write while the app
 * is open.
 */

/** Beside the library it guards, and named for what holds it. */
export const LOCK_FILE = 'paper.cli.lock'

/** Who holds it, as the file records. Every field is for the refusal message
 *  — a lock that cannot say who holds it is a lock people delete. */
export interface LockOwner {
  readonly pid: number
  readonly host: string
  /** Epoch milliseconds. */
  readonly at: number
  /** The command line, so a stuck lock names the thing that is stuck. */
  readonly command: string
  /**
   * A fresh value per acquisition, and the ONLY thing `release` compares on.
   *
   * Identity was `pid + host + at`, and its own test refuted it: two locks
   * taken by ONE process in the same millisecond carry the same triple, so
   * the first one's release deleted the second one's file — the exact
   * stale-disposer defect `exclusiveSlot` was written against, in a different
   * costume. A token is not a clock and cannot collide with itself.
   */
  readonly token: string
}

export interface DataLock {
  readonly owner: LockOwner
  /** Idempotent, and safe to call after the lock was reclaimed by somebody
   *  else — it removes the file only while this process still owns it. */
  release(): Promise<void>
}

/** Thrown when the lock is held and did not come free in time. */
export class LockHeld extends Error {
  readonly owner: LockOwner | null
  constructor(owner: LockOwner | null, path: string) {
    super(
      owner === null
        ? `another process holds ${path}`
        : `pid ${owner.pid} on ${owner.host} holds ${path} (${owner.command}, since ${new Date(owner.at).toISOString()})`,
    )
    this.name = 'LockHeld'
    this.owner = owner
  }
}

export interface LockOptions {
  /** How long to WAIT before refusing. Zero refuses at once. */
  readonly waitMs?: number
  /** How often to retry while waiting. */
  readonly pollMs?: number
  /** What to record as the holder's command. */
  readonly command?: string
  /** Injected so a test can drive both without sleeping. */
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  /**
   * Is this pid alive? The default asks the operating system with signal 0,
   * which tests for existence without delivering anything. Injectable
   * because a test cannot conjure a dead pid it is sure nothing has reused.
   */
  readonly alive?: (pid: number) => boolean
}

const DEFAULT_WAIT_MS = 5_000
const DEFAULT_POLL_MS = 50

function livePid(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    /* EPERM means it EXISTS and is somebody else's — alive, and not ours to
     * reclaim. Only ESRCH is "no such process". */
    return (error as { code?: string }).code === 'EPERM'
  }
}

async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const one = parsed as Record<string, unknown>
    if (typeof one['pid'] !== 'number' || typeof one['host'] !== 'string') return null
    return {
      pid: one['pid'],
      host: one['host'],
      at: typeof one['at'] === 'number' ? one['at'] : 0,
      command: typeof one['command'] === 'string' ? one['command'] : '',
      /* A lock file written before tokens existed has none. Empty never
       * equals a real token, so such a file is never released by us — held
       * until its pid dies and it is reclaimed as stale, which is the safe
       * direction. */
      token: typeof one['token'] === 'string' ? one['token'] : '',
    }
  } catch {
    /* Unreadable or not ours: treated as HELD by somebody unnameable rather
     * than as free. Reclaiming a lock file we cannot understand is exactly
     * the move that turns one confused writer into two. */
    return null
  }
}

/**
 * Take the lock on `dir`, or throw `LockHeld`.
 *
 * A STALE lock — one whose pid is gone, on this host — is reclaimed, because
 * the alternative is a crashed `paper` making the library unwritable until
 * somebody deletes a file they have never heard of. A lock from ANOTHER host
 * is never reclaimed: liveness cannot be checked across a machine, and
 * guessing in the permissive direction is how two writers happen.
 */
export async function acquireDataLock(dir: string, options: LockOptions = {}): Promise<DataLock> {
  const path = join(dir, LOCK_FILE)
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const alive = options.alive ?? livePid
  const mine: LockOwner = {
    pid: process.pid,
    host: hostname(),
    at: now(),
    command: options.command ?? process.argv.slice(1).join(' '),
    token: randomUUID(),
  }
  const deadline = now() + waitMs

  for (;;) {
    try {
      /* `wx` — create, and FAIL if it exists. One syscall, atomic, and the
       * reason this is a lock rather than a race: an `exists`-then-`write`
       * has a window between the two that both writers pass through. */
      const handle = await open(path, 'wx')
      try {
        await handle.writeFile(JSON.stringify(mine))
        await handle.close()
      } catch (cause) {
        /* THE FILE EXISTS THE MOMENT `wx` RETURNS, so a failed write leaves a
         * lock nobody can read — and `readOwner` treats an unreadable file as
         * HELD BY SOMEBODY UNNAMEABLE, which is the safe reading everywhere
         * except here, where it would be held forever by nobody. Removed
         * before the throw, so the library stays writable. */
        await handle.close().catch(() => {})
        await rm(path, { force: true }).catch(() => {})
        throw cause
      }
      let released = false
      return {
        owner: mine,
        release: async () => {
          if (released) return
          /* Only while it is still OURS. A lock reclaimed as stale by
           * somebody else belongs to them now, and removing it would drop
           * their guard rather than ours. */
          const held = await readOwner(path)
          if (held !== null && held.token !== '' && held.token === mine.token) {
            await rm(path, { force: true })
          }
          /* MARKED RELEASED ONLY ONCE IT IS. Set before the removal, a
           * transient failure could not be retried: this process would go on
           * running while a file with its pid in it sat there, and every
           * later writer would wait for a holder that had already let go. */
          released = true
        },
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
      const held = await readOwner(path)
      if (held !== null && held.host === mine.host && !alive(held.pid)) {
        /* Stale, and provably ours to clear: same host, and the pid is gone.
         *
         * CLAIMED BY RENAME, not by `rm`. Two processes can both read the
         * same stale owner; if both then unlinked it, the first would create
         * its lock and the SECOND would delete that one and create its own —
         * two writers, each believing it holds the lock, which is the exact
         * outcome this file exists to prevent. `rename` is atomic and has one
         * winner: whoever moves the stale file aside owns the removal, and
         * the loser simply finds it gone and retries the ordinary create. */
        const aside = `${path}.stale-${mine.token}`
        try {
          await rename(path, aside)
        } catch {
          continue
        }
        /* AND IT IS STILL THE ONE WE JUDGED STALE.
         *
         * The rename has one winner, which stops two reclaimers from both
         * unlinking — but not this: A reads stale S; B reads stale S, renames
         * it aside and creates ITS lock; A then renames B's LIVE lock aside
         * and creates its own, and both believe they hold it. So what was
         * moved is read back, and anything that is not the stale owner we
         * decided to reclaim is put straight back. The window between the two
         * renames is a few syscalls wide, and a loser simply retries. */
        const moved = await readOwner(aside)
        if (moved === null || moved.token !== held.token || moved.pid !== held.pid) {
          /* We moved somebody's LIVE lock. Put it back with `link`, never
           * `rename`: POSIX rename REPLACES its destination, so restoring
           * that way would silently destroy a third process's lock created in
           * the gap — turning one confused writer into two, which is the
           * outcome this whole file exists to prevent. `link` fails when the
           * destination exists, so a restore either succeeds or declines.
           *
           * If it declines, the file stays under its `.stale-<token>` name:
           * evidence, and named for the process that moved it, rather than
           * deleted. */
          try {
            await link(aside, path)
            await rm(aside, { force: true }).catch(() => {})
          } catch {
            /* Somebody holds the name now. Leave the evidence and retry. */
          }
          continue
        }
        await rm(aside, { force: true }).catch(() => {})
        continue
      }
      if (now() >= deadline) throw new LockHeld(held, path)
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())))
    }
  }
}
