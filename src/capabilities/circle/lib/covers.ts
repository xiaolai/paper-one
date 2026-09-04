import { blake3 } from '@noble/hashes/blake3.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { MAX_COVER_BYTES, atomicWrite, defineSetting, personFolderIn, type Setting, type VaultFs } from '../../../kernel'
import { bytesOfBase64 } from './base64'
import type { Dialled } from './fetch'
import { CIRCLE_SERVICES, parseCoverAnswer } from './protocol'

/**
 * A friend's jacket, fetched and kept — the recipient's half of WI-23.C5.
 *
 * The shelf entry names the digest; this asks the device that published the
 * entry for the bytes, chunk by chunk under `circle:read`, charges every
 * chunk to that person's budget as a page is charged, verifies the whole
 * file against the digest before keeping a byte of it, and keeps what it
 * verified under the person's own folder — which `purgePerson` removes
 * whole, so a block takes the pictures with the pages.
 *
 * ⚠️ **LAZY, AND NEVER IN THE ROUND.** A jacket is fetched when a screen
 * shows the row that wants it, one fetch per digest at a time. The round
 * moves what is signed; a picture is not, and a friend with a thousand
 * books must not cost a thousand transfers on a timer.
 */

export const COVER_CAP_MAX_MB = 1024

/** How much of the disk the circle's jackets may take, in MiB — the same shape as the satchel's cover cap. */
/* Stryker disable StringLiteral,ConditionalExpression: the key is refused at load by `defineSetting`, so the module cannot be imported with another; a non-number never passes `isSafeInteger`. */
export const COVER_CAP_SETTING: Setting<number> = defineSetting('circle.coverCapMB', 64, (raw) =>
  typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 && raw <= COVER_CAP_MAX_MB ? raw : undefined,
)
/* Stryker restore StringLiteral,ConditionalExpression */

export const COVER_INDEX_PATH = 'circle/covers.json'

/** Where a verified jacket is kept: under its person, by its digest, with no extension — the bytes say what they are. */
export const coverPathOf = (person: string, digest: string): string => `${personFolderIn(person)}/covers/${digest}`

export interface CoverFetchDeps {
  readonly fs: VaultFs
  /** Dial the device that published the shelf entry. Rejects when it does not answer. */
  readonly dial: (device: string) => Promise<Dialled>
  /**
   * Charge one chunk to the person's budget — the same ledger the fetch
   * driver charges, so a jacket and a page draw on one budget. `false` is a
   * budget spent, and the chunk is not kept.
   *
   * ⚠️ **ONE OPERATION, NOT A READ AND A WRITE.** A `spend`/`spent` pair
   * held a snapshot across the chunk's await, and a cadence round holding its
   * own snapshot across ITS awaits wrote back over the charge — so the two
   * together could spend past the budget. The ledger reads, decides and
   * commits in one synchronous step, and neither side keeps a copy.
   */
  readonly charge: (person: string, bytes: number) => boolean
  readonly now: () => number
  readonly capBytes: () => number
}

export interface CoverFetcher {
  /**
   * The jacket's bytes — from the cache, or fetched and verified — or null:
   * not served, not verified, not paid for, not answering, or abandoned.
   *
   * ⚠️ **THE SIGNAL REACHES THE TRANSFER.** One fetch per digest is shared by
   * every caller that wants it, and it is stopped — the next chunk not asked
   * for, the session closed, the budget spared — once the LAST of them has
   * abandoned it: a row scrolled away, a screen unmounted. A signal that
   * only cancelled the answer left the bytes moving for nobody.
   */
  ensure(person: string, device: string, pub: string, digest: string, signal?: AbortSignal): Promise<Uint8Array | null>
  /**
   * Forget everything held for one person: their index entries, and any
   * fetch of theirs still on its way — which keeps nothing when it lands.
   * The files themselves go with the person's folder (`purgePerson`); this
   * is what keeps the index honest and the folder from coming back.
   */
  purge(person: string): Promise<void>
}

/** The bytes that open each kind of jacket the shelf can carry. */
const SIGNATURES: readonly (readonly [string, readonly (readonly [number, number])[]])[] = [
  ['image/jpeg', [[0, 0xff], [1, 0xd8], [2, 0xff]]],
  ['image/png', [[0, 0x89], [1, 0x50], [2, 0x4e], [3, 0x47], [4, 0x0d], [5, 0x0a], [6, 0x1a], [7, 0x0a]]],
  ['image/gif', [[0, 0x47], [1, 0x49], [2, 0x46], [3, 0x38]]],
  /* `RIFF....WEBP`: the four bytes between are the file's length. */
  ['image/webp', [[0, 0x52], [1, 0x49], [2, 0x46], [3, 0x46], [8, 0x57], [9, 0x45], [10, 0x42], [11, 0x50]]],
]

/** What the bytes say they are — a jacket can be a PNG under any name — or a type that says nothing, which a browser then sniffs. */
export function imageTypeOf(bytes: Uint8Array): string {
  for (const [type, signature] of SIGNATURES) {
    if (signature.every(([offset, byte]) => bytes[offset] === byte)) return type
  }
  return 'application/octet-stream'
}

interface CoverEntry {
  readonly size: number
  readonly usedAt: number
}

type CoverIndex = Record<string, CoverEntry>

/**
 * The jackets kept on disk: a content-addressed store under each person's
 * folder, an index of sizes and last use, and a cap the index is held to.
 * Every operation is serialised on one chain, as the satchel's cache is —
 * two fetches landing together must not each write the index the other
 * read — and every byte handed out is verified against its digest first.
 */
interface CoverCache {
  /** The kept bytes for a digest, verified, touched as used and with room made — or null: not kept, kept and no longer the jacket its digest names, or the person purged since `fence` was taken. */
  take(person: string, digest: string, fence: number): Promise<Uint8Array | null>
  /** Keep verified bytes, unless the person was purged since `fence` was taken. Whether they landed. */
  keep(person: string, digest: string, bytes: Uint8Array, fence: number): Promise<boolean>
  /** The fence a fetch about to start measures a later purge against. */
  fenceOf(person: string): number
  /** Drop the person's index entries and the files they name, and fence every fetch of theirs still on its way. */
  purge(person: string): Promise<void>
}

function createCoverCache({ fs, now, capBytes }: Pick<CoverFetchDeps, 'fs' | 'now' | 'capBytes'>): CoverCache {
  /* How many times each person has been purged — the fence a fetch that was
     on its way when the purge ran is measured against before it keeps. */
  const purges = new Map<string, number>()
  const purgesOf = (person: string): number => purges.get(person) ?? 0
  /* One writer of the index at a time, as the satchel's cache has: two
     fetches landing together must not each write the index the other read. */
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task)
    chain = next.catch(() => {})
    return next
  }

  const readIndex = async (): Promise<CoverIndex> => {
    const out: CoverIndex = Object.create(null) as CoverIndex
    if (!(await fs.exists(COVER_INDEX_PATH))) return out
    const parsed: unknown = JSON.parse(new TextDecoder().decode(await fs.readFile(COVER_INDEX_PATH)))
    // Stryker disable next-line ConditionalExpression: a number or a word has no entries to walk; the type check spells out what the walk finds.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      // Stryker disable next-line ConditionalExpression: a word has no `size`, so the check below drops it anyway.
      if (typeof raw !== 'object' || raw === null) continue
      const entry = raw as Record<string, unknown>
      /* A FINITE use: `1e400` is valid JSON and parses to infinity, and a
         difference of two infinities is `NaN`, which sorts nowhere. */
      if (!Number.isSafeInteger(entry['size']) || (entry['size'] as number) < 0 || !Number.isFinite(entry['usedAt'])) continue
      out[key] = { size: entry['size'] as number, usedAt: entry['usedAt'] as number }
    }
    return out
  }
  const writeIndex = (index: CoverIndex): Promise<void> => atomicWrite(fs, COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify(index)))

  /** Oldest first, past the cap — the one just landed exempt, or it would be evicted by its own arrival. */
  const evict = async (index: CoverIndex, keep: string): Promise<void> => {
    const cap = capBytes()
    let total = Object.values(index).reduce((sum, entry) => sum + entry.size, 0)
    for (const [key, entry] of Object.entries(index).sort((a, b) => a[1].usedAt - b[1].usedAt)) {
      if (total <= cap) break
      if (key === keep) continue
      const cut = key.indexOf('/')
      const path = coverPathOf(key.slice(0, cut), key.slice(cut + 1))
      /* ⚠️ **ONLY A FILE THAT IS GONE LEAVES THE INDEX.** One that would not
         go stays counted — untracked, it was disk the cap no longer saw, and
         a file that refused every time let the cache grow past the cap for
         good. A file already gone is gone: nothing to remove, the entry goes. */
      if (await fs.exists(path)) {
        try {
          await fs.remove(path)
        } catch {
          continue
        }
      }
      delete index[key]
      total -= entry.size
    }
  }
  /** Index a verified jacket and make room — inside the serialisation. */
  const keepIndexed = async (key: string, size: number): Promise<void> => {
    const index = await readIndex()
    index[key] = { size, usedAt: now() }
    /* Room made on EVERY touch, not only after a download: an index rebuilt
       from what was on disk, or a cap lowered in Settings, was otherwise over
       the cap until the next jacket happened to land. */
    await evict(index, key)
    await writeIndex(index)
  }

  return {
    fenceOf: purgesOf,
    /* ⚠️ **THE HIT IS LOOKED UP, READ AND TOUCHED INSIDE THE SERIALISATION.**
       Outside it, an eviction between the `exists` and the read deleted the
       file under it — and a touch after the read put an entry back for a
       file the eviction had just removed. */
    take: (person, digest, fence) =>
      serial(async () => {
        /* ⚠️ **THE HIT IS FENCED AS THE KEEP IS.** A purge queued before this
           turn must not be answered from the file it is about to remove, nor
           have that file re-indexed behind it — the index would then name a
           jacket in a folder that is gone. */
        if (purgesOf(person) !== fence) return null
        const path = coverPathOf(person, digest)
        if (!(await fs.exists(path))) return null
        const bytes = await fs.readFile(path)
        /* Verified as it is drawn, as it was verified when it landed: a write
           cut short, or a file changed on disk, is not the jacket its digest
           names, and would otherwise be trusted under it for ever. Dropped,
           and the caller fetches it again. */
        if (!verifies(bytes, digest)) {
          await fs.remove(path).catch(() => {})
          const index = await readIndex()
          delete index[`${person}/${digest}`]
          await writeIndex(index)
          return null
        }
        await keepIndexed(`${person}/${digest}`, bytes.length)
        return bytes
      }),
    keep: (person, digest, bytes, fence) =>
      serial(async () => {
        /* ⚠️ **FENCED AGAINST A PURGE THAT RAN WHILE THE BYTES WERE ON THEIR
           WAY.** A keep after it wrote the person's folder back into being
           around one picture, and an index entry with it. */
        if (purgesOf(person) !== fence) return false
        /* Atomic, as every file the capability keeps is: a write cut short
           by a crash must not leave half a jacket under a whole digest. */
        await atomicWrite(fs, coverPathOf(person, digest), bytes)
        await keepIndexed(`${person}/${digest}`, bytes.length)
        return true
      }),
    purge: (person) => {
      /* The generation moves NOW, not when the purge's turn comes: a fetch
         that starts after the purge was asked for is already on the far side
         of it, and the fences it takes must say so. */
      purges.set(person, purgesOf(person) + 1)
      return serial(async () => {
        const index = await readIndex()
        const prefix = `${person}/`
        const theirs = Object.keys(index).filter((key) => key.startsWith(prefix))
        // Stryker disable next-line ConditionalExpression: with none of theirs the index written is the index read; the guard spares a write.
        if (theirs.length === 0) return
        /* The files too, not only the index: between this and the folder's
           removal a hit would otherwise answer from the file and re-index it. */
        for (const key of theirs) {
          delete index[key]
          const cut = key.indexOf('/')
          await fs.remove(coverPathOf(key.slice(0, cut), key.slice(cut + 1))).catch(() => {})
        }
        await writeIndex(index)
      })
    },
  }
}

/**
 * The transport half: one jacket, asked for chunk by chunk from the device
 * that published the entry, each chunk charged before it is kept, and the
 * whole verified against the digest — the whole file, or nothing.
 */
async function fetchOne(
  { dial, charge }: Pick<CoverFetchDeps, 'dial' | 'charge'>,
  person: string,
  device: string,
  pub: string,
  digest: string,
  abandoned: AbortSignal,
): Promise<Uint8Array | null> {
  if (abandoned.aborted) return null
  const session = await dial(device)
  try {
    const parts: Uint8Array[] = []
    let size: number | null = null
    let got = 0
    /* Stryker disable ConditionalExpression,LogicalOperator,EqualityOperator: every guard here ends the fetch with nothing kept — and so would the digest check at the end, or the throw the guard forestalls, for anything a guard let through. One outcome, on purpose; the guards name the reason and spare the bytes. */
    for (;;) {
      /* Chunk by chunk is where a transfer can stop: a chunk in flight lands
         and is paid for; the next is not asked for once nobody wants it. */
      if (abandoned.aborted) return null
      const answer = parseCoverAnswer(await session.call(CIRCLE_SERVICES.cover.name, { pub, offset: got }))
      if (answer === null || answer.offset !== got) return null
      if (size === null) size = answer.size
      else if (answer.size !== size) return null
      const chunk = bytesOfBase64(answer.bytes)
      if (chunk === null || chunk.length === 0) return null
      /* ⚠️ **PAID FOR BEFORE IT IS KEPT**, as a page is: a friend's jacket
         draws on the same budget as their pages, and a chunk the budget
         refuses ends the fetch with nothing kept. */
      if (!charge(person, chunk.length)) return null
      got += chunk.length
      // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator: the answer's own bound holds `size` under the cap, so past the cap is past the size; the second clause spells the first.
      if (got > size || got > MAX_COVER_BYTES) return null
      parts.push(chunk)
      if (!answer.more) break
    }
    if (size === null || got !== size) return null
    const bytes = new Uint8Array(got)
    let at = 0
    for (const part of parts) {
      bytes.set(part, at)
      at += part.length
    }
    /* Stryker restore ConditionalExpression,LogicalOperator,EqualityOperator */
    /* THE DIGEST ON THE SHELF ENTRY IS THE CONTRACT: the whole file, or nothing. */
    return verifies(bytes, digest) ? bytes : null
  } finally {
    await session.close().catch(() => {})
  }
}

/** One transfer, and how many callers still want it. */
interface Transfer {
  readonly task: Promise<Uint8Array | null>
  readonly abandon: AbortController
  wanted: number
}

/** The two halves joined: the cache first, the wire only for what it lacks, and never the same digest twice at once. */
export function createCoverFetcher(deps: CoverFetchDeps): CoverFetcher {
  const cache = createCoverCache(deps)
  const inFlight = new Map<string, Transfer>()
  /* Every caller counts, and one is let go when its signal says so; a caller
     with no signal wants the jacket until it lands. The transfer is
     abandoned when the count reaches nought — not before, or one row
     scrolling away would stop the jacket the row beside it is waiting for. */
  const wanting = (transfer: Transfer, signal: AbortSignal | undefined): Promise<Uint8Array | null> => {
    transfer.wanted += 1
    signal?.addEventListener(
      'abort',
      () => {
        transfer.wanted -= 1
        if (transfer.wanted === 0) transfer.abandon.abort()
      },
      { once: true },
    )
    return transfer.task
  }
  return {
    ensure: (person, device, pub, digest, signal) => {
      if (signal?.aborted) return Promise.resolve(null)
      const key = `${person}/${digest}`
      const running = inFlight.get(key)
      if (running !== undefined) return wanting(running, signal)
      const abandon = new AbortController()
      const task = (async (): Promise<Uint8Array | null> => {
        const fence = cache.fenceOf(person)
        const kept = await cache.take(person, digest, fence)
        if (kept !== null) return kept
        const bytes = await fetchOne(deps, person, device, pub, digest, abandon.signal).catch(() => null)
        if (bytes === null) return null
        return (await cache.keep(person, digest, bytes, fence)) ? bytes : null
      })().finally(() => inFlight.delete(key))
      const transfer: Transfer = { task, abandon, wanted: 0 }
      inFlight.set(key, transfer)
      return wanting(transfer, signal)
    },
    purge: (person) => cache.purge(person),
  }
}

/** Whether the bytes are the jacket the digest names — the whole file, or nothing. */
function verifies(bytes: Uint8Array, digest: string): boolean {
  return bytesToHex(blake3(bytes)) === digest
}
