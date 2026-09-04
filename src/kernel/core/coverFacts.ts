import { COVER_NAMES, folderOf, type BookRecord, type CoverFacts, type CoverName } from './bookFolder'
import type { HashPort } from './ports'

/**
 * A book's jacket, measured — WI-23.C5.
 *
 * The circle publishes a cover as a DIGEST on the shelf entry and serves the
 * bytes on request; the digest has to be this device's own measurement of the
 * file it will serve. `measureCover` takes it through the hash port (BLAKE3 in
 * Rust), and `createCoverFactsPass` stamps it onto the records that hold a
 * jacket and no facts yet — the same shape as the sync capability's
 * `contentHash` backfill, and for the same reason: a hash port arrives late,
 * and a library predates it.
 */

/**
 * The largest jacket the circle serves or fetches, in bytes. A jacket the
 * kernel writes is downscaled to tens of kilobytes; one above this is a file
 * somebody put there by hand, and it is not the circle's to carry.
 */
export const MAX_COVER_BYTES = 1024 * 1024

/** What `measureCover` reads: a filesystem that can say whether a path is there. */
export interface CoverFs {
  exists(path: string): Promise<boolean>
}

/**
 * The jacket a book holds, measured: the first of the two names that exists,
 * hashed by the port. Null when the book has no jacket.
 */
export async function measureCover(fs: CoverFs, hashes: HashPort, bookId: string): Promise<CoverFacts | null> {
  const name = await coverNameHere(fs, bookId)
  if (name === null) return null
  const folder = folderOf(bookId)
  /* The plugin names the folder by its segment under `books/`, not by its path. */
  const hashed = await hashes.hashFile(folder.slice(folder.lastIndexOf('/') + 1), name)
  return { name, size: hashed.size, hash: hashed.blake3 }
}

/** The cover name a book's folder holds — the honest name first, the legacy one second — or null. */
export async function coverNameHere(fs: CoverFs, bookId: string): Promise<CoverName | null> {
  const folder = folderOf(bookId)
  for (const name of COVER_NAMES) {
    if (await fs.exists(`${folder}/${name}`)) return name
  }
  return null
}

/**
 * The digest the circle may publish for a record: its jacket's, when the
 * jacket is measured and within what the circle serves — otherwise nothing.
 */
export function publishableCover(record: Pick<BookRecord, 'coverFacts'>): string | undefined {
  const facts = record.coverFacts
  /* WITHIN THE BOUND AT BOTH ENDS. An empty file is a jacket nobody can
     fetch — the cover protocol refuses a zero-sized answer and the server has
     no offset zero to serve from — so advertising its digest offers a cover
     that fails on every friend's shelf. */
  return facts !== undefined && facts.size > 0 && facts.size <= MAX_COVER_BYTES ? facts.hash : undefined
}

export interface CoverFactsPass {
  /** Stamp up to a batch of records that hold a jacket and no facts. Answers how many were stamped. */
  runOnce(): Promise<number>
}

export interface CoverFactsPassOptions {
  readonly fs: CoverFs
  readonly library: {
    getSnapshot(): readonly (Pick<BookRecord, 'coverFacts'> & { readonly bookId: string })[]
    /**
     * `Library.updateAfter` — the jacket is MEASURED and its facts written
     * inside the book's lane, in one turn. A measurement taken outside it
     * queued its stamp behind a removal already in the lane and restored
     * facts for a deleted file; a same-name replacement received the digest
     * of the file it replaced.
     */
    updateAfter(
      bookId: string,
      hooks: { readonly before: (target: { exists(path: string): Promise<boolean> }, live: string) => Promise<'go' | 'refuse'> },
      change: (record: BookRecord) => BookRecord,
    ): Promise<void>
  }
  /** Read per run, not captured: the port is bound by the peer, which may start later. */
  readonly hashes: () => HashPort | null
  readonly batch?: number
}

/**
 * The pass over the library: a few books per run, so a caller on the
 * library's change feed converges in steps rather than hashing a thousand
 * jackets inside one change.
 *
 * ⚠️ **A BOOK FOUND WITHOUT A JACKET IS NOT LOOKED AT AGAIN THIS RUN.** The
 * pass runs on every library change, and two `exists` calls per book per
 * change is a stat storm on a large shelf. It is safe because every path a
 * jacket lands by stamps the facts itself — the store after `keepCover`, the
 * sync capability after a verified landing — so a jacket that arrives later
 * never depends on this pass to be measured.
 */
export function createCoverFactsPass({ fs, library, hashes, batch = 4 }: CoverFactsPassOptions): CoverFactsPass {
  const jacketless = new Set<string>()
  /**
   * Books the port would not hash, and the run at which each is tried again.
   *
   * A failure used to be permanent for the life of the pass: a jacket being
   * replaced under the hasher, a port that was briefly gone, a file the
   * filesystem would not open once — each parked the book until the
   * capability was recreated. Bounded RETRY instead: the wait between tries
   * doubles with every failure, in runs, so a file that never hashes costs
   * one attempt per 2ⁿ library changes rather than one per change — and a
   * transient fault costs the jacket a few passes, not the session.
   */
  const failed = new Map<string, { readonly retryAt: number; readonly failures: number }>()
  let run = 0
  /* ONE PASS AT A TIME. The library fires on every change, and every stamp
   * IS a change, so a pass that stamped four books queued four more passes
   * behind it — each hashing the same books again while the first was still
   * writing.
   *
   * ⚠️ **A CALL MADE DURING A PASS IS OWED ONE PASS AFTER IT — NOT THIS ONE,
   * AND NOT ONE EACH.** Joined to the running pass, it was dropped: the
   * running pass had already walked past the books it would stamp, and with
   * every stamp's notification joining the pass that made it, no pass ever
   * followed — a shelf of a thousand jackets measured its first four and
   * stopped. One pass each was the storm above. Every call that arrives while
   * one runs shares ONE follow-up, which is what converging in steps means. */
  let inFlight: Promise<number> | null = null
  let follow: Promise<number> | null = null
  const pass = async (): Promise<number> => {
    const port = hashes()
    if (port === null) return 0
    run += 1
    let attempted = 0
    let stamped = 0
    for (const row of library.getSnapshot()) {
      /* THE BATCH COUNTS EVERY BOOK LOOKED AT, not only the ones stamped.
       * Counting stamps let one run walk an entire large library — two
       * filesystem probes per jacketless book — because none of them
       * counted, while the contract promised a bounded pass. */
      if (attempted >= batch) break
      if (row.coverFacts !== undefined || jacketless.has(row.bookId)) continue
      const held = failed.get(row.bookId)
      if (held !== undefined && run < held.retryAt) continue
      attempted += 1
      /* Found without a jacket OFF the lane — one `exists` per name, which
         is what the pass always cost — so a shelf of jacketless books takes
         no lane at all. The measurement itself is inside the lane, below. */
      if ((await coverNameHere(fs, row.bookId)) === null) {
        jacketless.add(row.bookId)
        continue
      }
      try {
        /* ⚠️ **MEASURED INSIDE THE LANE** — `updateAfter`'s `before` — so the
         * facts stamped describe the file at the moment they are written,
         * whatever landed or left between the snapshot and this book's turn:
         * a removal queued ahead has taken the file (nothing to stamp), and a
         * same-name replacement is measured as itself, never handed a digest
         * taken earlier. A check that the path still existed was not that: a
         * file that replaced the measured one passed it and received the old
         * digest. A hasher that fails is the pass's failure to retry, not the
         * store's to note and repair — captured, and raised after. */
        const measured: { facts: CoverFacts | null; failure: unknown } = { facts: null, failure: null }
        let wrote = false
        await library.updateAfter(
          row.bookId,
          {
            before: async (_target, live) => {
              try {
                measured.facts = await measureCover(fs, port, live)
              } catch (cause) {
                measured.failure = cause
                return 'refuse'
              }
              return measured.facts === null ? 'refuse' : 'go'
            },
          },
          (held) => {
            const facts = measured.facts
            if (held.coverFacts !== undefined || facts === null) return held
            wrote = true
            return { ...held, coverFacts: facts }
          },
        )
        if (measured.failure !== null) throw measured.failure
        if (measured.facts === null) {
          jacketless.add(row.bookId)
          continue
        }
        /* Counted only when THIS pass wrote the facts: another writer — the
         * store after `keepCover`, sync after a landing — may have stamped
         * the record between the snapshot and the lane, and a count of
         * "records this pass stamped" must not claim their work. */
        failed.delete(row.bookId)
        if (wrote) stamped += 1
      } catch {
        const failures = (held?.failures ?? 0) + 1
        failed.set(row.bookId, { retryAt: run + Math.min(2 ** failures, MAX_RETRY_WAIT_RUNS), failures })
      }
    }
    return stamped
  }
  const runOnce = (): Promise<number> => {
    if (inFlight === null) {
      /* ⚠️ **BEGUN ON THE NEXT MICROTASK, AFTER `inFlight` IS SET.** The pass's
       * first stamp can fire the library's change feed synchronously, and a
       * feed that called `runOnce` back while `inFlight` was still null began
       * a second pass inside the first — and a third inside that. */
      const running = Promise.resolve()
        .then(pass)
        .finally(() => {
          if (inFlight === running) inFlight = null
        })
      inFlight = running
      return running
    }
    if (follow === null) {
      const next = (): Promise<number> => {
        follow = null
        return runOnce()
      }
      /* After the running pass, however it ended: a pass that threw still
         owes the caller the one it asked for. */
      follow = inFlight.then(next, next)
    }
    return follow
  }
  return { runOnce }
}

/** The longest a failed jacket waits between tries, in runs of the pass. */
const MAX_RETRY_WAIT_RUNS = 64
