import { BOOKS_DIR, COVER_NAMES, atomicWrite, defineSetting, isContentHash, isRefusal, type CoverName, type HashPort, type IndexFs, type RemovableBlobName, type Setting, type SettingsStore } from '../../../kernel'
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
  /**
   * A stamp still OWED: the record does not carry this jacket's facts — the
   * stamp failed when it landed, or the file under this name is not the one
   * the index knew. Paid by the next `ensure` that finds the jacket present
   * and can MEASURE it (`hashes`): the facts stamped are always a fresh
   * measurement of the file that is there. ⚠️ Not a digest kept from the
   * landing: a same-name file replaced since — at any size — is not those
   * bytes, and stamping the old digest onto it published facts that were
   * wrong. Absent once the stamp has taken, and on every entry from before
   * this field existed; a `pendingHash` an older index wrote reads as owed.
   */
  readonly owed?: true
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
   * Told that the jacket this cache was tracking under `name` is NOT here
   * after all — or not the file the facts describe — so the record stops
   * carrying THAT name's facts and no other's: a book can hold a legacy
   * `cover.webp` beside `cover.jpg`, and clearing whatever facts were there
   * discarded a valid measurement of the file still present. A record whose
   * `coverFacts` describe a file that is gone is a digest the circle
   * publishes and this device cannot serve. Told on eviction (the primitive
   * clears nothing for a file already gone), on a tracked jacket found
   * missing or replaced, and on a stamp owed that cannot be paid.
   */
  readonly unstamp?: (book: string, name: string) => Promise<void>
  /**
   * The host's hasher, read at CALL time like `bytesAt` — bound after the
   * services are built, and absent on a composition without one. With it, a
   * stamp still owed is paid from a FRESH measurement of the file that is
   * there; without it, only for a file of the size the digest was taken
   * over. See `measured`.
   */
  readonly hashes?: () => HashPort | null
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
  unstamp,
  hashes,
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
        /* A stamp owed is a flag — or, from an index the previous build
         * wrote, the digest it kept: either reads as owed, and the debt is
         * paid from a fresh measurement, never from that digest. */
        const owed = entry['owed'] === true || isContentHash(entry['pendingHash'])
        out[book] = {
          name: entry['name'],
          size: entry['size'],
          usedAt: entry['usedAt'],
          ...(owed ? { owed: true } : {}),
        }
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
      /* THE FACTS GO WITH THE FILE, here too. The primitive clears them when
         it deletes a file that was there; an entry whose file was already
         gone resolves as the documented no-op and clears nothing, and the
         record kept describing a jacket this device could not serve. Said
         for every entry that leaves — clearing facts already absent costs
         nothing. */
      await unstamp?.(book, entry.name)
    }
    return index
  }

  /**
   * The facts of the jacket present under `name`, MEASURED — or null: no
   * hasher on this composition, or one that would not answer.
   *
   * ⚠️ **A STAMP OWED IS PAID FROM THE FILE THAT IS THERE, OR NOT AT ALL.**
   * The digest taken when a jacket landed described those bytes; a same-name
   * file replaced or restored since — at ANY size, a size is not an
   * identity — is not them, and stamping the old digest onto it published
   * facts that were wrong. Without a measurement the debt stands and the
   * record carries no facts it cannot back.
   */
  const measured = async (folder: string, name: string): Promise<{ readonly size: number; readonly hash: string } | null> => {
    const port = hashes?.() ?? null
    if (port === null) return null
    try {
      const facts = await port.hashFile(folder, name)
      return { size: facts.size, hash: facts.blake3 }
    } catch {
      return null
    }
  }

  /* The honest name first, the legacy read-only name second — THE KERNEL'S
   * list, shared by local discovery and remote-answer validation. It was
   * restated here (and in `ledger.ts`, and in `protocol.ts`) while the kernel
   * exported `COVER_NAMES` all along; a name added to the kernel's set would
   * have been parsed, cached and landed by three files that disagreed. */
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
          /* THE JACKET THE INDEX KNEW IS GONE, AND ANOTHER NAME IS HERE — a
             legacy `cover.webp` beside where `cover.jpg` was. Its facts go
             (they describe a file that is not there), and the file that IS
             here owes a stamp like any jacket nobody has measured. Left
             alone, the entry quietly took the new name and the record kept
             describing the old file. */
          const replaced = held !== undefined && held.name !== present
          if (replaced) await unstamp?.(book, held.name)
          /* A STAMP STILL OWED IS PAID HERE, from a fresh measurement — see
             `measured`. A swallowed stamp used to be permanent: this path had
             nothing to stamp with, and on a phone there is no circle pass to
             do it later. Without a hasher the debt stands, unpaid, and the
             record carries no facts for a file nothing has measured. */
          let owed = replaced || held?.owed === true
          if (owed) {
            const facts = await measured(folder, present)
            if (facts !== null && stamp) {
              try {
                await stamp(book, { name: present as CoverName, size: facts.size, hash: facts.hash })
                owed = false
              } catch {
                /* Still owed; the next `ensure` tries again. */
              }
              size = facts.size
            } else {
              await unstamp?.(book, present)
            }
          }
          index[book] = { name: present, size, usedAt: now(), ...(owed ? { owed: true } : {}) }
          /* Evicted here too: DISCOVERY grows the tracked bytes exactly as
           * a fetch does, and a discovery path that never evicted let the
           * cache climb past its cap one found jacket at a time. */
          await writeIndex(await evictLocked(index, book))
          return true
        }
        /* THE FACTS GO WITH THE FILE. A jacket this cache was tracking is not
         * here after all — a folder replaced or restored behind the index —
         * and a record still carrying its facts is a digest the circle
         * publishes and this device cannot serve. Eviction clears them
         * through `removeBlob`; this is the other way a jacket goes missing,
         * and nothing cleared them. Told before any fetch below, which stamps
         * afresh when a jacket lands. */
        if (book in index) await unstamp?.(book, index[book]!.name)
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
        let owed = false
        try {
          // Stryker disable next-line OptionalChaining: a cache with nobody to tell throws here and is caught below; the jacket is kept either way.
          await stamp?.(book, { name: found.cover.name as CoverName, size: found.cover.size, hash: found.cover.hash })
        } catch {
          /* The jacket is here either way. THE DEBT IS RECORDED, not
           * forgotten: the next `ensure` that finds the jacket present pays
           * it from a fresh measurement of the file. This used to wait for
           * "the circle's pass" — which a phone does not compose, so on a
           * phone the facts never arrived at all. */
          owed = true
        }
        index[book] = {
          name: found.cover.name,
          size: found.cover.size,
          usedAt: now(),
          ...(owed ? { owed: true } : {}),
        }
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
