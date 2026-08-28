import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { link, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { hostname, uptime } from 'node:os'
import { join } from 'node:path'

/**
 * THE ADVISORY LOCK — one library, one writer, and since WI-20.40 the app
 * holds it too.
 *
 * `journal.ts` has CAS on `rev` and `writeQueue.ts` serialises writes WITHIN
 * a process. Nothing else coordinates two processes writing one library, so
 * this is what does: every writing `paper` takes it before it opens the
 * host, and the app takes it in Rust at setup, before its webview boots
 * (`src-tauri/src/lock.rs`). SAME FILE, SAME RECORD, SAME PROTOCOL — one lock,
 * not two that agree until somebody edits one. `paper book add` beside a
 * running app is refused by name with the app's pid; a second Paper is
 * refused with a dialog naming this `paper`.
 *
 * PUBLISHED BY `link`, NOT BY WRITE-AFTER-CREATE. This used to `open(path,
 * 'wx')` and then write the record, and a SIGKILL between the two left an
 * empty file that `readOwner` treated as held by somebody unnameable — with
 * no reclamation path, so every later writer was locked out until a human
 * deleted a file they had never heard of. The record is now written whole to
 * a private temp name, fsynced, and `link`ed into place: `link` is atomic and
 * exclusive on POSIX and NTFS, so the lock file never exists without a
 * readable owner. Which is also why an EMPTY lock file is reclaimable by
 * construction: this protocol cannot leave one, so it is the old crash
 * window, and provably nobody's.
 *
 * A PID IS NOT AN IDENTITY. The kernel hands a dead process's number to the
 * next one, and a machine that has rebooted has handed out every number
 * again. So the record carries the holder's start time and the host's boot
 * time, and a holder is live only when the pid runs AND both agree with what
 * the OS says now. An answer the OS cannot give refutes nothing — the check
 * falls back to the pid alone, which is the direction that keeps a lock held
 * rather than the one that makes two writers.
 *
 * WHAT IT STILL DOES NOT COVER: the phone. A satchel syncing with the desktop
 * UI closed needs a process that owns the library and answers over the
 * envelope — `NEXT.md`'s lease-tracked handoff — and this is not it.
 */

/** Beside the library it guards, and named for what holds it. */
export const LOCK_FILE = 'paper.cli.lock'

/**
 * How far a recorded start or boot may sit from the OS's answer and still be
 * the same process. `startedAt` is `Date.now() − process.uptime()`, and the
 * OS's answer for another pid comes through `ps` rounded to a second; a
 * reused pid is minutes or days away, not seconds. `lock.rs` uses the same.
 */
export const IDENTITY_TOLERANCE_MS = 5_000

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
  /**
   * When the holder's process started, epoch milliseconds — absent in a
   * record written before WI-20.34, or on a platform that cannot say. With
   * `bootedAt`, what makes the pid an identity rather than a number.
   */
  readonly startedAt?: number
  /** When the holder's host booted, epoch milliseconds. Same terms. */
  readonly bootedAt?: number
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
  /**
   * When did this pid start, epoch milliseconds — or null when the OS cannot
   * say. The default asks `ps`. Injectable for the same reason as `alive`:
   * a test cannot make the OS report a start time it did not see.
   */
  readonly startedAt?: (pid: number) => number | null
  /** When did this host boot, epoch milliseconds — or null. */
  readonly bootedAt?: () => number | null
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

/** This host's boot, as the record spells it. `os.uptime()` is whole seconds. */
export function hostBootedAt(now: number = Date.now()): number {
  return Math.round(now - uptime() * 1000)
}

/** This process's start, as the record spells it. */
export function ownStartedAt(now: number = Date.now()): number {
  return Math.round(now - process.uptime() * 1000)
}

/**
 * When `pid` started, asked of `ps` — the one portable way a Node process can
 * ask about another. `etime` is elapsed since start as `[[dd-]hh:]mm:ss`,
 * rounded to the second, so the answer is `now − elapsed` and the tolerance
 * above absorbs the rounding. Null wherever `ps` is not there (Windows) or
 * the pid is gone, and null refutes nothing.
 */
export function processStartedAt(pid: number, now: number = Date.now()): number | null {
  if (process.platform === 'win32') return null
  try {
    /* BOUNDED, because this runs inside the acquisition poll: a `ps` that
     * hangs (a wedged process table has been seen) would otherwise stall the
     * whole wait with no deadline of its own. A timeout answers null, and
     * null refutes nothing — the safe direction. */
    const out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    })
    const elapsed = parseElapsed(out.trim())
    return elapsed === null ? null : now - elapsed * 1000
  } catch {
    return null
  }
}

/** `[[dd-]hh:]mm:ss` → seconds, or null for anything else. */
export function parseElapsed(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text)
  if (!m) return null
  const [, days, hours, minutes, seconds] = m
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
}

async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const one = parsed as Record<string, unknown>
    /* A PID THAT COULD NOT HAVE BEEN WRITTEN IS NOT A RECORD. Every writer
     * records its own `process.pid` — a positive integer — so a fractional,
     * negative or non-finite value is corruption wearing a record's shape.
     * Accepted, it flowed to `kill()`, which throws on such input, and the
     * "gone holder" reading RECLAIMED the file — junk must land on the safe
     * side instead: held by somebody unnameable, like every other unreadable
     * lock. */
    if (typeof one['pid'] !== 'number' || !Number.isSafeInteger(one['pid']) || one['pid'] <= 0) return null
    if (typeof one['host'] !== 'string') return null
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
      ...(typeof one['startedAt'] === 'number' ? { startedAt: one['startedAt'] } : {}),
      ...(typeof one['bootedAt'] === 'number' ? { bootedAt: one['bootedAt'] } : {}),
    }
  } catch {
    /* Unreadable or not ours: treated as HELD by somebody unnameable rather
     * than as free. Reclaiming a lock file we cannot understand is exactly
     * the move that turns one confused writer into two. */
    return null
  }
}

/** A file that exists and holds nothing — see the module note. */
async function isEmpty(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size === 0
  } catch {
    return false
  }
}

/**
 * Take the lock on `dir`, or throw `LockHeld`.
 *
 * A STALE lock — one whose holder is gone, on this host — is reclaimed, because
 * the alternative is a crashed `paper` making the library unwritable until
 * somebody deletes a file they have never heard of. "Gone" is the pid not
 * running, OR running as a different process (its start time disagrees), OR
 * recorded before this host last booted. A lock from ANOTHER host is never
 * reclaimed: liveness cannot be checked across a machine, and guessing in the
 * permissive direction is how two writers happen.
 */
export async function acquireDataLock(dir: string, options: LockOptions = {}): Promise<DataLock> {
  const path = join(dir, LOCK_FILE)
  /* SANITISED, NOT TRUSTED. `waitMs: NaN` makes the deadline test below false
   * forever, and `sleep(NaN)` resolves immediately — an infinite hot loop
   * from one bad option. Non-finite or negative values take the default;
   * zero stays zero (one attempt, no wait), which is a meaning callers use. */
  const sane = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback
  const waitMs = sane(options.waitMs, DEFAULT_WAIT_MS)
  const pollMs = sane(options.pollMs, DEFAULT_POLL_MS)
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const alive = options.alive ?? livePid
  const startedAt = options.startedAt ?? processStartedAt
  const bootedAt = options.bootedAt ?? hostBootedAt
  const mine: LockOwner = {
    pid: process.pid,
    host: hostname(),
    at: now(),
    command: options.command ?? process.argv.slice(1).join(' '),
    token: randomUUID(),
    startedAt: ownStartedAt(),
    bootedAt: hostBootedAt(),
  }
  const deadline = now() + waitMs

  /** Still the process that wrote the record? See the module note. */
  const holds = (held: LockOwner): boolean => {
    if (!alive(held.pid)) return false
    if (held.bootedAt !== undefined) {
      const booted = bootedAt()
      if (booted !== null && Math.abs(held.bootedAt - booted) > IDENTITY_TOLERANCE_MS) return false
    }
    if (held.startedAt !== undefined) {
      const started = startedAt(held.pid)
      if (started !== null && Math.abs(held.startedAt - started) > IDENTITY_TOLERANCE_MS) return false
    }
    return true
  }

  for (;;) {
    if (await publish(path, mine)) {
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
    }
    const held = await readOwner(path)
    if (held === null && (await isEmpty(path))) {
      /* The old protocol's crash window — `wx`, then a kill before the write.
       * `link` cannot leave this shape, so it is provably nobody's. Moved
       * aside and looked at again, exactly like a stale record below, so a
       * lock that appeared under the name between the two looks is put back. */
      const aside = `${path}.stale-${mine.token}`
      try {
        await rename(path, aside)
      } catch {
        continue
      }
      if (await isEmpty(aside)) {
        await rm(aside, { force: true }).catch(() => {})
      } else {
        try {
          await link(aside, path)
          await rm(aside, { force: true }).catch(() => {})
        } catch {
          /* Somebody holds the name now. Leave the evidence and retry. */
        }
      }
      continue
    }
    if (held !== null && held.host === mine.host && !holds(held)) {
      /* Stale, and provably ours to clear: same host, and the holder is
       * gone — its pid dead, or its number reused by a process that started
       * at another time, or its record from before this boot.
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
         * deleted.
         *
         * SAID PLAINLY, because it is the protocol's one residual: when the
         * restore declines — a THIRD writer published into the gap — the
         * second writer's live lock is the file left aside, and that writer
         * still believes it holds. Three writers interleaved inside a
         * few-syscalls window behind a crash, on a filesystem with no
         * compare-and-swap to close it; `lock.rs` carries the identical
         * residual, deliberately, because it is one protocol. */
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

/**
 * Write the record whole under a private name, then `link` it into place.
 * True when the name was ours to take; false when somebody holds it. Any
 * other failure is thrown. The temp name is removed either way — and one a
 * killed helper left behind is named by that helper's token, so it blocks
 * nobody: the lock's own name is the only one contended.
 */
async function publish(path: string, owner: LockOwner): Promise<boolean> {
  const tmp = `${join(path, '..')}/.${LOCK_FILE}.${owner.token}`
  try {
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(JSON.stringify(owner))
      /* Durable before it is visible: a record that can be linked into
       * place and then lost to a power cut is an empty lock file with a
       * name — the shape this protocol exists to never produce. */
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(tmp, path)
      return true
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') return false
      throw error
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}
