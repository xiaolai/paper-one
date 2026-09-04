import { BOOKS_DIR, atomicWrite, defineSetting, isRefusal, type CoverName, type IndexFs, type RemovableBlobName, type Setting, type SettingsStore } from '../../../kernel'
import { blobFolderOf, type BlobFacts } from './ledger'

/**
 * Covers on a satchel, lazily and capped (WI-C.3, §2.5.4): a jacket is
 * fetched when its row asks for one, recorded in a small LRU index
 * (`sync/covers.json`), and the oldest are deleted once the cache is over
 * its byte cap. Books are never evicted — downloads are manual and stay
 * until it is evicted; this cache is jackets only.
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

/**
 * The largest cap this cache will honour, in megabytes — a terabyte.
 *
 * `capBytes()` multiplies the setting by 1 048 576, and the validator only
 * asked for a finite positive number: `1e300` passes it and comes out of the
 * multiplication as a number no total can ever reach, so the cap is switched
 * off by a settings file rather than by anyone deciding to switch it off.
 * Past `Number.MAX_SAFE_INTEGER` the arithmetic stops being exact as well.
 * A bound here keeps the product safe by construction.
 */
export const COVER_CAP_MAX_MB = 1024 * 1024

export const COVER_CAP_SETTING: Setting<number> = defineSetting('sync.coverCapMB', 200, (raw) =>
  typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 && raw <= COVER_CAP_MAX_MB ? raw : undefined,
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
  /** Told the facts of a jacket that landed, so the record can carry them (WI-23.C5). */
  readonly stamp?: (book: string, facts: { readonly name: CoverName; readonly size: number; readonly hash: string }) => Promise<void>
  /**
   * Delete one closed-name blob from a book's folder — the kernel's
   * `removeBlob` primitive (WI-10.2/10.5). Eviction's only delete: this
   * cache's own fs handle is namespace-confined and cannot reach books/.
   */
  readonly removeBlob: (book: string, name: RemovableBlobName) => Promise<void>
  /**
   * How many bytes a path holds, or `null` when it cannot be measured.
   *
   * The host's size port where there is one. Absent, the cache falls back to
   * reading the file — which is what it always did, and which pulls a
   * peer-supplied blob of unknown size into the webview to take its length.
   */
  readonly bytesAt?: (path: string) => Promise<number | null>
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

export function createCoverCache({
  fs,
  settings,
  lookup,
  fetchBlob,
  stamp,
  removeBlob,
  now = Date.now,
  bytesAt,
}: CoverCacheOptions): CoverCache {
  /* HOW BIG A FILE IS, without reading it.
   *
   * The composition passes the host's size port; where there is none — the
   * webview's fs plugin cannot `stat` — this falls back to reading, which is
   * what it always did. The fallback is the exception now rather than the
   * rule, so the common path stops pulling a peer-supplied blob of unknown
   * size into memory to take its `.length`. */
  const measure = async (path: string): Promise<number | null> => {
    if (bytesAt) return bytesAt(path)
    return (await fs.readFile(path)).length
  }
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
      /* NULL-PROTOTYPE, because the keys are BOOK IDS and a book id comes off
       * the wire from a peer. `{}` inherits `Object.prototype`, so a book
       * named `__proto__` did not become an entry — it ran the legacy
       * prototype setter, so that cover was never tracked, never counted
       * toward the cap and never evicted, and `out['toString']` answered a
       * function for a book nobody had. `Object.create(null)` has no such
       * keys to collide with. */
      const out: Record<string, CoverEntry> = Object.create(null) as Record<string, CoverEntry>
      for (const [book, raw] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof raw !== 'object' || raw === null) continue
        const entry = raw as Record<string, unknown>
        if (typeof entry['name'] !== 'string' || typeof entry['size'] !== 'number' || typeof entry['usedAt'] !== 'number') continue
        /* Finite, non-negative, or the row is corrupt: a NaN or negative
         * size poisons the byte total and a NaN stamp scrambles the LRU. */
        /* SAFE integers: a size at 2^53 or beyond stops adding exactly, so a
         * handful of them make the running total in `evictLocked` disagree
         * with itself and eviction either never starts or never stops. */
        if (!Number.isSafeInteger(entry['size']) || entry['size'] < 0) continue
        if (!Number.isFinite(entry['usedAt'])) continue
        out[book] = { name: entry['name'], size: entry['size'], usedAt: entry['usedAt'] }
      }
      return out
    } catch (cause) {
      /* ABSENT IS AN EMPTY INDEX; UNREADABLE IS NOT.
       *
       * Every failure used to answer `{}`, and the next write persists that —
       * so one transient read error made the cache forget every cover it was
       * tracking, permanently. The files stayed on disk, untracked, counting
       * toward nothing and never evicted, and the cap silently stopped
       * applying. Only a file that is not there is an empty index. */
      if (await fs.exists(COVER_INDEX_PATH)) throw cause
      return Object.create(null) as CoverIndex
    }
  }

  const writeIndex = async (index: CoverIndex): Promise<void> => {
    await atomicWrite(fs, COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify(index)))
  }

  const capBytes = (): number => settings.get(COVER_CAP_SETTING) * 1024 * 1024

  const evictLocked = async (index: Record<string, CoverEntry>, keep?: string): Promise<CoverIndex> => {
    const cap = capBytes()
    let total = Object.values(index).reduce((sum, entry) => sum + entry.size, 0)
    /* THE EXEMPTION PROTECTS THE CURRENT COVER, NOT AN OVERSIZED ONE.
     *
     * `keep` exists so the jacket just fetched is not evicted the instant it
     * arrives — sensible while a cover is a few hundred kilobytes. It was
     * unconditional, so a single entry LARGER THAN THE WHOLE CAP was exempt
     * from eviction for as long as it stayed current: the cache sat
     * permanently over its limit, and every other cover was deleted trying to
     * get under it. A cover this device cannot afford to keep is not made
     * affordable by being the newest one. */
    const exempt = keep !== undefined && (index[keep]?.size ?? 0) <= cap ? keep : undefined
    const oldestFirst = Object.entries(index)
      .filter(([book]) => book !== exempt)
      .sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [book, entry] of oldestFirst) {
      if (total <= cap) break
      /* An index entry naming something outside the closed set (a hand-edited
       * covers.json) is REFUSED by the primitive; the entry still leaves the
       * index, so a poisoned row cannot delete anything and stops being
       * tracked. */
      /* THE ENTRY LEAVES ONLY IF THE FILE DID.
       *
       * A swallowed delete used to untrack the row anyway and subtract its
       * size, so a file that would not delete became invisible: still on
       * disk, counted by nothing, never retried, and the cap enforced against
       * a total that understated the cache by exactly that much. Repeated,
       * the cache grows without bound while its own arithmetic says it is
       * under the limit.
       *
       * A refusal from the primitive is different and is still dropped — an
       * index row naming something outside the closed set (a hand-edited
       * `covers.json`) can delete nothing, and keeping it would stall
       * eviction on a row that will never succeed. */
      const removed = await removeBlob(book, entry.name as RemovableBlobName).then(
        () => true,
        (cause: unknown) => isRefusal(cause),
      )
      if (!removed) continue
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
              /* MEASURED, not read. This pulled the whole file into the
               * webview to take `.length` — for a jacket that is ordinarily a
               * few hundred kilobytes but is accepted from a PEER, so its size
               * is not this device's decision. `bytesAt` asks the filesystem
               * for the length. */
              const measured = await measure(`${BOOKS_DIR}/${folder}/${present}`)
              if (measured === null) throw new Error('the cover could not be measured')
              size = measured
            } catch {
              /* NOT TRACKED AT AN INVENTED SIZE.
               *
               * A failed measurement used to record zero — or, worse, the size
               * of a DIFFERENTLY NAMED prior cover — and return success. The
               * entry then counted for nothing against the cap and was never
               * worth evicting, and a same-name touch never measured again, so
               * the wrong number was permanent. Leaving the entry alone means
               * the next `ensure` tries again. */
              /* The entry is left exactly as it was — including absent, so a
               * cover that has never been measured is not entered at a made-up
               * size. `true`, because the cover IS here; what failed is
               * measuring it, and the next `ensure` will try again. */
              if (held !== undefined) index[book] = held
              else delete index[book]
              await writeIndex(index)
              return true
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
        /* AND THE SIZE, BEFORE A BYTE MOVES.
         *
         * The peer declares how big its cover is, and nothing here read that
         * number: a "cover" advertised at four gigabytes was fetched in full,
         * written to this device's disk, and only then measured — by which
         * point the disk is already gone. Eviction cannot undo a transfer.
         * Checked against the same cap eviction enforces, so the cache never
         * accepts a file it would immediately have to delete. */
        if (!Number.isSafeInteger(found.cover.size) || found.cover.size < 0 || found.cover.size > capBytes()) {
          return dropStale()
        }
        try {
          await fetchBlob(found.peerId, found.folder, found.cover)
        } catch {
          /* The fetch failing says nothing about the stale row — but the
           * cover is not here, so a tracked entry for it is a lie either
           * way. */
          return dropStale()
        }
        try {
          // Stryker disable next-line OptionalChaining: a cache with nobody to tell throws here and is caught below; the jacket is kept either way.
          await stamp?.(book, { name: found.cover.name as CoverName, size: found.cover.size, hash: found.cover.hash })
        } catch {
          /* The jacket is here either way; the facts wait for the circle's pass. */
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
