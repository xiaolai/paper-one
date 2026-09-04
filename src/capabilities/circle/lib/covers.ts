import { blake3 } from '@noble/hashes/blake3.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { MAX_COVER_BYTES, atomicWrite, charge, defineSetting, personFolderIn, type Setting, type Spend, type VaultFs } from '../../../kernel'
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
  /** The per-person spend ledger the fetch driver charges — the same one, so a jacket and a page draw on one budget. */
  readonly spend: (person: string) => Spend
  readonly spent: (person: string, next: Spend) => void
  readonly now: () => number
  readonly capBytes: () => number
}

export interface CoverFetcher {
  /** The jacket's bytes — from the cache, or fetched and verified — or null: not served, not verified, not paid for, or not answering. */
  ensure(person: string, device: string, pub: string, digest: string): Promise<Uint8Array | null>
}

interface CoverEntry {
  readonly size: number
  readonly usedAt: number
}

type CoverIndex = Record<string, CoverEntry>

export function createCoverFetcher({ fs, dial, spend, spent, now, capBytes }: CoverFetchDeps): CoverFetcher {
  const inFlight = new Map<string, Promise<Uint8Array | null>>()
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
      if (!Number.isSafeInteger(entry['size']) || (entry['size'] as number) < 0 || typeof entry['usedAt'] !== 'number') continue
      out[key] = { size: entry['size'] as number, usedAt: entry['usedAt'] }
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
      await fs.remove(coverPathOf(key.slice(0, cut), key.slice(cut + 1))).catch(() => {})
      delete index[key]
      total -= entry.size
    }
  }

  const fetchOne = async (person: string, device: string, pub: string, digest: string): Promise<Uint8Array | null> => {
    const session = await dial(device)
    try {
      const parts: Uint8Array[] = []
      let size: number | null = null
      let got = 0
      /* Stryker disable ConditionalExpression,LogicalOperator,EqualityOperator: every guard here ends the fetch with nothing kept — and so would the digest check at the end, or the throw the guard forestalls, for anything a guard let through. One outcome, on purpose; the guards name the reason and spare the bytes. */
      for (;;) {
        const answer = parseCoverAnswer(await session.call(CIRCLE_SERVICES.cover.name, { pub, offset: got }))
        if (answer === null || answer.offset !== got) return null
        if (size === null) size = answer.size
        else if (answer.size !== size) return null
        const chunk = bytesOfBase64(answer.bytes)
        if (chunk === null || chunk.length === 0) return null
        /* ⚠️ **PAID FOR BEFORE IT IS KEPT**, as a page is: a friend's jacket
           draws on the same budget as their pages, and a chunk the budget
           refuses ends the fetch with nothing kept. */
        const charged = charge(spend(person), 'cover', chunk.length, now())
        if (!charged.allowed) return null
        spent(person, charged.spend)
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
      return bytesToHex(blake3(bytes)) === digest ? bytes : null
    } finally {
      await session.close().catch(() => {})
    }
  }

  return {
    ensure: (person, device, pub, digest) => {
      const key = `${person}/${digest}`
      const running = inFlight.get(key)
      if (running !== undefined) return running
      const task = (async (): Promise<Uint8Array | null> => {
        const path = coverPathOf(person, digest)
        if (await fs.exists(path)) {
          const bytes = await fs.readFile(path)
          await serial(async () => {
            const index = await readIndex()
            index[key] = { size: bytes.length, usedAt: now() }
            await writeIndex(index)
          })
          return bytes
        }
        const bytes = await fetchOne(person, device, pub, digest).catch(() => null)
        if (bytes === null) return null
        await serial(async () => {
          // Stryker disable next-line StringLiteral: the folder is the file's parent — Tauri's mkdir is recursive, and the fake needs none.
          await fs.mkdir(`${personFolderIn(person)}/covers`)
          await fs.writeFile(path, bytes)
          const index = await readIndex()
          index[key] = { size: bytes.length, usedAt: now() }
          await evict(index, key)
          await writeIndex(index)
        })
        return bytes
      })().finally(() => inFlight.delete(key))
      inFlight.set(key, task)
      return task
    },
  }
}
