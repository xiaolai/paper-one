import { readBook, type KernelServices } from '../../../kernel'
import { blobFolderOf } from './ledger'

/**
 * The `contentHash` backfill (WI-C.3): a library that predates the ledger
 * has bytes and no hashes, and the content identity guard (§2.3) needs one
 * per copy. The hash is the plugin's BLAKE3 (`peer_hash_file`) — never
 * computed in TypeScript — and the pass is LAZY: a few books per call, so
 * it rides idle moments instead of hammering the disk at launch. The
 * resulting record edit is an ordinary local commit and replicates like
 * any other field.
 */

export interface BackfillOptions {
  readonly services: KernelServices
  readonly hashFile: (folder: string, name: string) => Promise<{ blake3: string; size: number }>
  readonly batch?: number
}

export interface Backfill {
  /** Hash up to `batch` unhashed copies. Resolves with how many were
   *  stamped; 0 means the pass is complete (until new bytes arrive). */
  runOnce(): Promise<number>
}

export function createBackfill({ services, hashFile, batch = 4 }: BackfillOptions): Backfill {
  const { library, fs } = services
  /** Books a hash attempt failed for — not retried this run of the app;
   *  a missing file will still be missing a second later. */
  const skipped = new Set<string>()

  return {
    runOnce: async () => {
      if (!fs) return 0
      let stamped = 0
      for (const row of library.getSnapshot()) {
        if (stamped >= batch) break
        if (row.hasContent !== true || row.contentHash !== undefined || skipped.has(row.bookId)) continue
        const record = await readBook(fs, row.bookId).catch(() => null)
        if (!record || record.contentHash) continue
        const name = `content.${record.ext ?? record.format ?? 'bin'}`
        try {
          const hashed = await hashFile(blobFolderOf(row.bookId), name)
          await library.update(row.bookId, (held) =>
            held.contentHash ? held : { ...held, contentHash: hashed.blake3 },
          )
          stamped += 1
        } catch {
          skipped.add(row.bookId)
        }
      }
      return stamped
    },
  }
}
