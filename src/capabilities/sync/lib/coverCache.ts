import { BOOKS_DIR, atomicWrite, defineSetting, type IndexFs, type RemovableBlobName, type Setting, type SettingsStore } from '../../../kernel'
import { blobFolderOf, type BlobFacts } from './ledger'

/**
 * Covers on a satchel, lazily and capped (WI-C.3, §2.5.4): a jacket is
 * fetched when its row asks for one, recorded in a small LRU index
 * (`sync/covers.json`), and the oldest are deleted once the cache is over
 * its byte cap. Books are never evicted — downloads are manual and stay
 * until "Remove download"; this cache is jackets only.
 *
 * `lookup` answers where a book's cover is and how to verify it (the
 * `sync.content` call, injected so the cache is testable over the fake
 * wire); `fetchBlob` is the verified transfer. The legacy name: `lookup`
 * answers `cover.webp` for a shelf that predates the honest name, and the
 * cache asks for exactly what it was told — the jpg-then-webp order lives
 * on the SERVING side (`ledger.handleContent` tries jpg first). Note for
 * C.6: the real plugin currently refuses to LAND a fetch under the
 * read-only name `cover.webp`; until that is decided, a legacy cover simply
 * does not arrive and the row keeps its tinted stand-in.
 */

export const COVER_CAP_SETTING: Setting<number> = defineSetting('sync.coverCapMB', 200, (raw) =>
  typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined,
)

export const COVER_INDEX_PATH = 'sync/covers.json'

export interface CoverEntry {
  readonly name: string
  readonly size: number
  readonly usedAt: number
}

export type CoverIndex = Readonly<Record<string, CoverEntry>>

export interface CoverLookup {
  readonly peerId: string
  readonly folder: string
  readonly cover: BlobFacts | null
}

export interface CoverCacheOptions {
  readonly fs: IndexFs
  readonly settings: SettingsStore
  /** Where a book's cover is — the `sync.content` answer, reduced. */
  readonly lookup: (book: string) => Promise<CoverLookup | null>
  readonly fetchBlob: (peerId: string, folder: string, blob: BlobFacts) => Promise<void>
  /**
   * Delete one closed-name blob from a book's folder — the kernel's
   * `removeBlob` primitive (WI-10.2/10.5). Eviction's only delete: this
   * cache's own fs handle is namespace-confined and cannot reach books/.
   */
  readonly removeBlob: (book: string, name: RemovableBlobName) => Promise<void>
  readonly now?: () => number
}

export interface CoverCache {
  /** Have this book's cover here: cheap when present (an LRU touch), a
   *  verified fetch when not. Resolves with whether a cover is here now. */
  ensure(book: string): Promise<boolean>
  /** The tracked bytes and entries, for the Storage section. */
  index(): Promise<CoverIndex>
  totalBytes(): Promise<number>
  /** Delete oldest entries until under the cap. Ran after every fetch. */
  evict(): Promise<void>
}

export function createCoverCache({ fs, settings, lookup, fetchBlob, removeBlob, now = Date.now }: CoverCacheOptions): CoverCache {
  /* Serialised: two ensure()s racing the index write would drop one entry. */
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T,>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task)
    chain = next.catch(() => {})
    return next
  }

  const readIndex = async (): Promise<CoverIndex> => {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(await fs.readFile(COVER_INDEX_PATH)))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
      const out: Record<string, CoverEntry> = {}
      for (const [book, raw] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof raw !== 'object' || raw === null) continue
        const entry = raw as Record<string, unknown>
        if (typeof entry['name'] !== 'string' || typeof entry['size'] !== 'number' || typeof entry['usedAt'] !== 'number') continue
        /* Finite, non-negative, or the row is corrupt: a NaN or negative
         * size poisons the byte total and a NaN stamp scrambles the LRU. */
        if (!Number.isInteger(entry['size']) || entry['size'] < 0) continue
        if (!Number.isFinite(entry['usedAt'])) continue
        out[book] = { name: entry['name'], size: entry['size'], usedAt: entry['usedAt'] }
      }
      return out
    } catch {
      return {}
    }
  }

  const writeIndex = async (index: CoverIndex): Promise<void> => {
    await atomicWrite(fs, COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify(index)))
  }

  const capBytes = (): number => settings.get(COVER_CAP_SETTING) * 1024 * 1024

  const evictLocked = async (index: Record<string, CoverEntry>, keep?: string): Promise<CoverIndex> => {
    const cap = capBytes()
    let total = Object.values(index).reduce((sum, entry) => sum + entry.size, 0)
    const oldestFirst = Object.entries(index)
      .filter(([book]) => book !== keep)
      .sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [book, entry] of oldestFirst) {
      if (total <= cap) break
      /* An index entry naming something outside the closed set (a hand-edited
       * covers.json) is REFUSED by the primitive; the entry still leaves the
       * index, so a poisoned row cannot delete anything and stops being
       * tracked. */
      await removeBlob(book, entry.name as RemovableBlobName).catch(() => {})
      delete index[book]
      total -= entry.size
    }
    return index
  }

  /* The honest name first, the legacy read-only name second — ONE list,
   * shared by local discovery and remote-answer validation. */
  const COVER_NAMES = ['cover.jpg', 'cover.webp'] as const
  const coverHere = async (folder: string): Promise<string | null> => {
    for (const name of COVER_NAMES) {
      if (await fs.exists(`${BOOKS_DIR}/${folder}/${name}`)) return name
    }
    return null
  }

  return {
    ensure: (book) =>
      serial(async () => {
        const folder = blobFolderOf(book)
        const index = { ...(await readIndex()) } as Record<string, CoverEntry>
        const present = await coverHere(folder)
        if (present !== null) {
          const held = index[book]
          /* First seen here (a cover that predates the index, or a row the
           * parse refused): measure it, or it enters the ledger at zero
           * bytes and is never worth evicting. A held size is kept — the
           * touch path must stay one read cheap. */
          let size = held?.size
          if (size === undefined || held?.name !== present) {
            try {
              size = (await fs.readFile(`${BOOKS_DIR}/${folder}/${present}`)).length
            } catch {
              size = held?.size ?? 0
            }
          }
          index[book] = { name: present, size, usedAt: now() }
          /* Evicted here too: DISCOVERY grows the tracked bytes exactly as
           * a fetch does, and a discovery path that never evicted let the
           * cache climb past its cap one found jacket at a time. */
          await writeIndex(await evictLocked(index, book))
          return true
        }
        const dropStale = async (): Promise<false> => {
          if (book in index) {
            delete index[book]
            await writeIndex(index)
          }
          return false
        }
        const found = await lookup(book)
        if (!found || found.cover === null) return dropStale()
        /* CORRELATED before a byte moves: the folder and the name are the
         * peer's words. Folder names are deterministic (`safeId`), so the
         * answer's folder must be THIS book's; and the name must be a COVER
         * name — a "cover" labelled `content.epub` would aim the fetch at
         * the book's bytes. (Whether the legacy `cover.webp` may LAND is
         * the plugin's call — see the module note.) */
        if (found.folder !== folder) return dropStale()
        if (!(COVER_NAMES as readonly string[]).includes(found.cover.name)) return dropStale()
        try {
          await fetchBlob(found.peerId, found.folder, found.cover)
        } catch {
          /* The fetch failing says nothing about the stale row — but the
           * cover is not here, so a tracked entry for it is a lie either
           * way. */
          return dropStale()
        }
        index[book] = { name: found.cover.name, size: found.cover.size, usedAt: now() }
        await writeIndex(await evictLocked(index, book))
        return true
      }),
    index: () => serial(readIndex),
    totalBytes: () =>
      serial(async () => Object.values(await readIndex()).reduce((sum, entry) => sum + entry.size, 0)),
    evict: () =>
      serial(async () => {
        await writeIndex(await evictLocked({ ...(await readIndex()) }))
      }),
  }
}
