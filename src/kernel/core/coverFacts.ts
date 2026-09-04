import { COVER_NAMES, folderOf, type BookRecord, type CoverFacts } from './bookFolder'
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
  const folder = folderOf(bookId)
  /* The plugin names the folder by its segment under `books/`, not by its path. */
  const segment = folder.slice(folder.lastIndexOf('/') + 1)
  for (const name of COVER_NAMES) {
    if (!(await fs.exists(`${folder}/${name}`))) continue
    const hashed = await hashes.hashFile(segment, name)
    return { name, size: hashed.size, hash: hashed.blake3 }
  }
  return null
}

/**
 * The digest the circle may publish for a record: its jacket's, when the
 * jacket is measured and within what the circle serves — otherwise nothing.
 */
export function publishableCover(record: Pick<BookRecord, 'coverFacts'>): string | undefined {
  const facts = record.coverFacts
  return facts !== undefined && facts.size <= MAX_COVER_BYTES ? facts.hash : undefined
}

export interface CoverFactsPass {
  /** Stamp up to a batch of records that hold a jacket and no facts. Answers how many were stamped. */
  runOnce(): Promise<number>
}

export interface CoverFactsPassOptions {
  readonly fs: CoverFs
  readonly library: {
    getSnapshot(): readonly (Pick<BookRecord, 'coverFacts'> & { readonly bookId: string })[]
    update(bookId: string, change: (record: BookRecord) => BookRecord): Promise<void>
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
  const failed = new Set<string>()
  return {
    runOnce: async () => {
      const port = hashes()
      if (port === null) return 0
      let stamped = 0
      for (const row of library.getSnapshot()) {
        if (stamped >= batch) break
        if (row.coverFacts !== undefined || jacketless.has(row.bookId) || failed.has(row.bookId)) continue
        try {
          const facts = await measureCover(fs, port, row.bookId)
          if (facts === null) {
            jacketless.add(row.bookId)
            continue
          }
          await library.update(row.bookId, (held) => (held.coverFacts === undefined ? { ...held, coverFacts: facts } : held))
          stamped += 1
        } catch {
          /* A file the port would not hash: left for the next run, not retried every change. */
          failed.add(row.bookId)
        }
      }
      return stamped
    },
  }
}
