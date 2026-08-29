import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * THE ADVISORY LOCK'S TWO FAILURE PATHS THAT NEED A FILESYSTEM TO MISBEHAVE.
 *
 * `src/cli/writers.test.ts` proves the protocol over a real directory —
 * publishing by `link`, reclaiming a stale record, putting back a live one it
 * moved aside. What it cannot reach is a filesystem that REFUSES: a rename
 * that fails for a reason which does not clear, and two releases in flight at
 * once. Both were real defects (the 2026-08-28 round-3 audit, #51 and #52),
 * and both need `node:fs/promises` to answer something a temp directory never
 * will — so the two calls that matter are hookable here and everything else
 * is the real thing.
 */

/** Set per test; null means "call the real one". */
const hooks: {
  rename: ((from: string, to: string) => Promise<void>) | null
  rm: ((path: string, options: unknown) => Promise<void>) | null
} = { rename: null, rm: null }

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    rename: (from: string, to: string) => (hooks.rename ? hooks.rename(from, to) : real.rename(from, to)),
    rm: (path: string, options?: unknown) =>
      hooks.rm ? hooks.rm(path, options) : real.rm(path, options as Parameters<typeof real.rm>[1]),
  }
})

const { LOCK_FILE, LockHeld, acquireDataLock, livePid, zombiePid } = await import('./lock')

afterEach(() => {
  hooks.rename = null
  hooks.rm = null
})

const library = () => mkdtemp(join(tmpdir(), 'paper-lock-'))

/** A record for a holder that is gone: reclamation's own precondition. */
const staleRecord = () =>
  JSON.stringify({ pid: 999_999, host: hostname(), at: 1, command: 'a crashed paper', token: 'stale-token' })

describe('a reclamation the filesystem will not allow', () => {
  /**
   * ⚠️ **AN INFINITE, CPU-HOT LOOP — WITH `waitMs: 0` NO PROTECTION.**
   *
   * Both reclamation branches caught every `rename` failure and went round
   * again immediately: no deadline test, no poll delay. A failure that does
   * not clear — no write permission on the data directory, a scanner holding
   * the file open on Windows — therefore span at a full core forever, in a
   * CLI whose whole contract is to refuse and exit. `ENOENT` is the one that
   * means progress (the file went away, which is the race the protocol
   * expects); everything else waits its poll and then refuses like any other
   * lock that did not come free.
   */
  it('refuses within the wait instead of spinning, and says what stopped it', async () => {
    const dataDir = await library()
    await writeFile(join(dataDir, LOCK_FILE), staleRecord())

    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let attempts = 0
    hooks.rename = async (from, to) => {
      attempts += 1
      /* A LOOP THAT DOES NOT END IS NOT A TEST RESULT. Past any plausible
         number of polls the fixture relents, so a version that spins fails on
         the count below rather than hanging the suite out to its timeout. */
      if (attempts > 20) {
        await real.rename(from, to)
        return
      }
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    }

    let clock = 0
    const slept: number[] = []
    const refused = await acquireDataLock(dataDir, {
      waitMs: 200,
      pollMs: 50,
      alive: () => false,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms)
        clock += ms
      },
    }).catch((thrown: unknown) => thrown)

    expect(refused).toBeInstanceOf(LockHeld)
    /* THE REASON TRAVELS WITH THE REFUSAL. Without it the message names a
       holder and the actual fault — a directory this process cannot write —
       is nowhere. */
    expect((refused as InstanceType<typeof LockHeld>).cause).toMatchObject({ code: 'EPERM' })
    expect(slept.reduce((total, one) => total + one, 0)).toBe(200)
    expect(attempts, 'the reclamation span rather than waiting out its poll').toBeLessThanOrEqual(10)

    await rm(dataDir, { recursive: true, force: true })
  })
})

describe('two releases in flight at once', () => {
  /**
   * ⚠️ **`release` IS DOCUMENTED IDEMPOTENT AND WAS NOT SAFE CONCURRENTLY.**
   *
   * It reads the record, checks the token, then unlinks. Two calls in flight
   * both read OUR token; the first unlinks; a new owner publishes into the
   * gap; and the second — still holding the answer from before — unlinks the
   * NEW OWNER'S FILE. Two writers over one library, caused by the one
   * function whose comment promises it cannot happen.
   */
  it('does not remove the lock a new owner published while the first release was in flight', async () => {
    const dataDir = await library()
    const path = join(dataDir, LOCK_FILE)
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

    const mine = await acquireDataLock(dataDir, { command: 'the first writer' })

    let removals = 0
    let taking = false
    let other: Awaited<ReturnType<typeof acquireDataLock>> | null = null
    hooks.rm = async (target, options) => {
      /* Only the LOCK's own removal is instrumented — `publish` removes its
         private temp name through this same call. */
      if (target !== path) {
        await real.rm(target, options as Parameters<typeof real.rm>[1])
        return
      }
      removals += 1
      await real.rm(target, options as Parameters<typeof real.rm>[1])
      /* THE GAP, MADE REAL: the name is free for a moment, and somebody
         takes it. A second removal after this point is the defect. Guarded so
         a version that DOES remove twice does not turn into two writers
         racing for the same name inside the fixture — the assertions below
         are what should report it. */
      if (taking) return
      taking = true
      other = await acquireDataLock(dataDir, { command: 'the next writer' })
    }

    await Promise.all([mine.release(), mine.release()])

    expect(removals, 'the second release ran its own removal').toBe(1)
    expect(other, 'nobody took the lock, so this proves nothing').not.toBeNull()
    const held = JSON.parse(await readFile(path, 'utf8')) as { token: string }
    expect(held.token, 'a second release deleted the next writer’s lock').toBe(other!.owner.token)

    hooks.rm = null
    await other!.release()
    await rm(dataDir, { recursive: true, force: true })
  })

  /* AND A FAILED RELEASE IS STILL RETRYABLE. Latching on the attempt rather
     than on the removal would leave this process running while a file with
     its pid in it sat there, and every later writer waiting for a holder that
     had already let go. */
  it('can be retried when the removal fails', async () => {
    const dataDir = await library()
    const path = join(dataDir, LOCK_FILE)
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const mine = await acquireDataLock(dataDir, { command: 'the writer' })

    hooks.rm = async (target, options) => {
      if (target !== path) {
        await real.rm(target, options as Parameters<typeof real.rm>[1])
        return
      }
      throw Object.assign(new Error('input/output error'), { code: 'EIO' })
    }
    await expect(mine.release()).rejects.toThrow(/input\/output/)

    hooks.rm = null
    await mine.release()
    await expect(readFile(path, 'utf8')).rejects.toThrow()

    await rm(dataDir, { recursive: true, force: true })
  })
})

describe('a clock that moved under a live holder', () => {
  /* THE TWO HALVES OF THE LOCK MUST AGREE. `lock.rs` reached this rule first:
     a wall-clock correction shifts both recorded stamps by the same amount,
     and reading that as "the holder is gone" reclaims a LIVE process's lock —
     two writers over one library, which is the outcome this file exists to
     prevent. A genuinely different process disagrees on start time by its own
     age, not by the clock's offset, so a reused pid still fails. */
  const record = { pid: 4242, host: hostname(), at: 1_000, command: 'Paper', token: 't', startedAt: 500_000, bootedAt: 100_000 }

  it('does not call a running holder stale when both stamps shifted together', async () => {
    const dir = await library()
    await writeFile(join(dir, LOCK_FILE), JSON.stringify(record))
    const SHIFT = 3_600_000 // an hour of clock correction
    await expect(
      acquireDataLock(dir, {
        waitMs: 0,
        alive: () => true,
        startedAt: () => record.startedAt - SHIFT,
        bootedAt: () => record.bootedAt - SHIFT,
      }),
    ).rejects.toBeInstanceOf(LockHeld)
  })

  it('still reclaims when the start time disagrees by more than the boot time — a different process on a reused pid', async () => {
    const dir = await library()
    await writeFile(join(dir, LOCK_FILE), JSON.stringify(record))
    const lock = await acquireDataLock(dir, {
      waitMs: 0,
      alive: () => true,
      startedAt: () => record.startedAt + 600_000,
      bootedAt: () => record.bootedAt,
    })
    expect(lock.owner.pid).toBe(process.pid)
    await lock.release()
  })
})

/**
 * A ZOMBIE IS NOT ALIVE, and `kill(pid, 0)` says it is.
 *
 * `livePid` used to be that call alone. An unreaped process keeps its pid
 * table entry, so signal 0 succeeds for a corpse — and on Linux it keeps its
 * ORIGINAL START TIME too, so it also passes the identity check in `holds`.
 * Both guards, defeated by one state. On macOS the start time instead becomes
 * unreadable, which passes the no-start-time fallback: the same wrong
 * conclusion by the opposite route.
 *
 * Measured 2026-08-29 on Linux: Paper killed under a container PID 1 that
 * never calls `wait()` left its lock held for good, and the app would not
 * reopen — no error, no paint. `paper` beside such a corpse is refused just as
 * permanently, which is this file's half.
 *
 * ⚠️ **THE REAL-ZOMBIE CASE IS TESTED IN RUST, NOT HERE, AND THAT IS A GAP
 * WORTH NAMING RATHER THAN PAPERING OVER.** Node reaps its own children —
 * libuv waits on SIGCHLD — so `spawn` cannot produce the state from a test in
 * this language, and every shell construct that can is racy enough that the
 * test would fail for reasons unrelated to the thing it checks. A test that is
 * flaky about its own setup teaches a reader to re-run rather than read.
 * `src-tauri/src/lock.rs`'s `a_zombie_is_not_alive_though_the_kernel_still_
 * answers_for_it` builds one properly, because Rust's `Child` does NOT reap on
 * drop, and it is red under a knockout of the exclusion.
 *
 * What is checkable here is the reading itself, in both directions — which is
 * what would break if `ps` output or the parse ever moved.
 */
describe('a zombie holder', () => {
  it('reads a running process as not one, and cannot say for a pid that is gone', () => {
    /* BOTH DIRECTIONS. A parse that answered `true` for everything would look
       right on a zombie and wrong here; `null` rather than `false` for an
       absent pid matters because a caller reads `false` as alive, and
       reclaiming a running app's library is the worse of the two mistakes. */
    /* Windows has neither the concept nor a `ps` to ask, so it cannot say —
       which `livePid` reads as "not refuted", leaving the pid alive. The
       module header's "WINDOWS IS FAIL-CLOSED ON A CRASH" is the same rule. */
    expect(zombiePid(process.pid)).toBe(process.platform === 'win32' ? null : false)
    expect(zombiePid(0x7ffffff)).toBeNull()
  })

  it('keeps a live pid alive, so the exclusion has not swallowed the ordinary case', () => {
    expect(livePid(process.pid)).toBe(true)
  })
})
