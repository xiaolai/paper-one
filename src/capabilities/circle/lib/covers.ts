import { blake3 } from '@noble/hashes/blake3.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { MAX_COVER_BYTES, atomicWrite, defineSetting, messageOf, personFolderIn, type Setting, type VaultFs } from '../../../kernel'
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

/**
 * How much of the disk the circle's jackets may take, in MiB — the same shape
 * as the satchel's cover cap.
 *
 * ⚠️ **THE WHOLE PARSE WAS DISABLED, AND ONE CLAUSE OF IT NEEDED TO BE.** The
 * key and every bound are asserted by `names its index, its setting and the
 * setting's bounds`, so seven of the eight mutants the directive covered were
 * already dying (2026-09-14 mutation debt). `isSafeInteger` runs FIRST so the
 * one clause that decides nothing stands alone, under a directive that reaches
 * only it.
 */
// Stryker disable next-line StringLiteral: an empty key makes `defineSetting` throw while this module is imported, so every covering suite fails to load and Stryker's vitest runner reports it Survived (verified by hand 2026-09-14) — the key itself is asserted by the test named above.
export const COVER_CAP_SETTING: Setting<number> = defineSetting('circle.coverCapMB', 64, (raw) =>
  Number.isSafeInteger(raw) &&
  // Stryker disable next-line ConditionalExpression: `isSafeInteger` is true only for a number, so this clause narrows the type for the two below and refuses nothing that reached it.
  typeof raw === 'number' &&
  raw > 0 &&
  raw <= COVER_CAP_MAX_MB
    ? raw
    : undefined,
)

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
  /**
   * Report a jacket that could not be fetched.
   *
   * ⚠️ **OPTIONAL, AND IT EXISTS BECAUSE `circle.cover-failed` COULD NEVER
   * FIRE.** `circlePort` wraps the fetch in a `catch` that warns under that
   * name, and the fetch folded every rejection to `null` one layer down — so a
   * refused dial, a transport error and a peer that simply holds no jacket were
   * one answer, a row drew nothing, and the diagnostics ring said nothing. The
   * ANSWER stays `null`; only the reason travels.
   */
  readonly warn?: (event: string, fields: Record<string, unknown>) => void
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

function createCoverCache({ fs, now, capBytes, warn }: Pick<CoverFetchDeps, 'fs' | 'now' | 'capBytes' | 'warn'>): CoverCache {
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

  /**
   * The index, or a THROW for one that is there and will not read.
   *
   * ⚠️ **ABSENT IS EMPTY; DAMAGED IS NOT, AND THIS ANSWERED BOTH THE SAME.** A
   * stored `[]` — or `null`, or a number — read as no entries, and every caller
   * here is a read-modify-write, so the next jacket touched wrote an index
   * holding that one alone: every tracked cover and the cap's accounting gone,
   * and their files left on disk where the cap could no longer see them. Found
   * by the 2026-09-13 verify. Bytes that were not JSON threw already, but
   * unnamed. A malformed ENTRY is still dropped alone, below.
   */
  const readIndex = async (): Promise<CoverIndex> => {
    const out: CoverIndex = Object.create(null) as CoverIndex
    if (!(await fs.exists(COVER_INDEX_PATH))) return out
    const bytes = await fs.readFile(COVER_INDEX_PATH)
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes))
    } catch (cause) {
      throw new Error(`${COVER_INDEX_PATH} is not JSON`, { cause })
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${COVER_INDEX_PATH} is not an index of jackets`)
    }
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      /* `null` FIRST, because it is the half that has to be caught here:
         `typeof null` is `'object'`, so a null read past this line is a
         property read on null, which throws where a damaged entry should
         simply be dropped. */
      if (
        raw === null ||
        // Stryker disable next-line ConditionalExpression: a value that is not an object has no numeric `size` either, so the check below drops it anyway.
        typeof raw !== 'object'
      )
        continue
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
  /** Index a verified jacket in an index already read, and make room — inside the serialisation. */
  const keepIndexed = async (index: CoverIndex, key: string, size: number): Promise<void> => {
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
        if (!(await fs.exists(path))) {
          /* ⚠️ **A MISS IS ABOUT TO BECOME A DOWNLOAD, SO THE INDEX IS ASKED
             FIRST.** Over an index that will not read, the fetch went ahead:
             charged to the friend's budget, written to disk, and only then
             refused at `keepIndexed` — a jacket kept where the cap could never
             see it, once per digest. Read here it throws before the wire. */
          await readIndex()
          return null
        }
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
        await keepIndexed(await readIndex(), `${person}/${digest}`, bytes.length)
        return bytes
      }),
    keep: (person, digest, bytes, fence) =>
      serial(async () => {
        /* ⚠️ **FENCED AGAINST A PURGE THAT RAN WHILE THE BYTES WERE ON THEIR
           WAY.** A keep after it wrote the person's folder back into being
           around one picture, and an index entry with it. */
        if (purgesOf(person) !== fence) return false
        /* ⚠️ **THE INDEX IS READ BEFORE THE JACKET IS WRITTEN, AND IT WAS READ
           AFTER.** The miss asked it before the wire, but an index that read
           then and fails now — damaged, or merely busy, while the bytes were on
           their way — threw with the jacket already on disk and no entry naming
           it: a file the cap could never see (2026-09-14 verify).

           ⚠️ **AND THE CHARGE STANDS, DELIBERATELY.** The bytes crossed the wire
           before the index failed, and the budget counts what crossed. `charge`
           has no inverse, and one that refunded here would let an index failing
           at the keep buy transfer after transfer off a friend's budget; an
           index that STAYS unreadable is refused at the next miss, before the
           wire, which is what spares the budget. */
        const index = await readIndex()
        const path = coverPathOf(person, digest)
        /* Atomic, as every file the capability keeps is: a write cut short
           by a crash must not leave half a jacket under a whole digest. SPELLED
           OUT rather than `path`: the capability fs footprint
           (`scripts/capability-fs-footprint.test.mjs`) reviews every raw write
           by what it names, and `path` names nothing a reviewer can read. */
        await atomicWrite(fs, coverPathOf(person, digest), bytes)
        try {
          await keepIndexed(index, `${person}/${digest}`, bytes.length)
        } catch (cause) {
          /* The jacket has to land before the entry that names it, so a failure
             after it is UNDONE — left, it is the same unseen file by another
             route.

             ⚠️ **AND AN UNDO THAT FAILS IS SAID, NOT SWALLOWED.** It was
             `.catch(() => {})`, so a removal that failed as well left the jacket
             on disk, unindexed, with only the index error reported (2026-09-14
             verify). Both go up together, so whoever warns says a jacket was
             left behind. */
          try {
            await fs.remove(path)
          } catch (undo) {
            throw new AggregateError([cause, undo], 'circle: a jacket could not be indexed, and could not be taken back either')
          }
          throw cause
        }
        return true
      }),
    purge: (person) => {
      /* The generation moves NOW, not when the purge's turn comes: a fetch
         that starts after the purge was asked for is already on the far side
         of it, and the fences it takes must say so. */
      // Stryker disable next-line ArithmeticOperator: a fence is only ever compared for equality with an earlier reading of this count, and counting down is as strictly one-way as counting up.
      purges.set(person, purgesOf(person) + 1)
      return serial(async () => {
        let index: CoverIndex
        try {
          index = await readIndex()
        } catch (cause) {
          /* ⚠️ **AN INDEX THAT WILL NOT READ MUST NOT STOP A PERSON BEING
             FORGOTTEN — AND BYTES THAT WERE NOT JSON DID.** `index.ts` runs
             this purge before `purgePerson`, so a rejection here left every
             file of theirs on disk after the reader said to forget them. What
             the purge promises still holds without the index: the fence moved
             above, before this turn, and `purgePerson` removes the jackets
             with the folder. What it cannot do is drop their entries without
             rewriting everybody else's, so the index is left exactly as it is
             and the reason is SAID. A later `evict` drops an entry whose file
             is gone, once the index reads again. */
          warn?.('circle.cover-index-unreadable', { person, message: messageOf(cause) })
          return
        }
        const prefix = `${person}/`
        const theirs = Object.keys(index).filter((key) => key.startsWith(prefix))
        /* ⚠️ **A REWRITE IS NOT NOTHING, WHICH IS WHY THIS GUARD IS MEASURED
           NOW.** The index written would be the index READ — re-serialised,
           so the malformed entries `readIndex` passes over would be dropped
           from somebody else's file by a purge that has nothing of theirs to
           do. Disabled as "the guard spares a write" until 2026-09-14. */
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
    /* ⚠️ **EVERY GUARD HERE STOPS THE FETCH EARLY, AND EARLY IS THE WHOLE
       POINT OF IT.** This block was disabled whole, on the reasoning that the
       digest check at the end reaches the same answer. It does — and it
       reaches it after the bytes have crossed the wire, been charged to a
       friend's budget and been held in memory. What each guard saves is
       therefore measurable, and `what each guard saves` below measures it:
       the calls made, the bytes charged, and whether a guard that was removed
       turned a damaged answer into a throw the log then reports as a failed
       fetch. Of the 43 mutants the directive covered, 37 were already dying
       against the tests it hid them from (2026-09-14 mutation debt). */
    for (;;) {
      /* Chunk by chunk is where a transfer can stop: a chunk in flight lands
         and is paid for; the next is not asked for once nobody wants it. */
      if (abandoned.aborted) return null
      const answer = parseCoverAnswer(await session.call(CIRCLE_SERVICES.cover.name, { pub, offset: got }))
      if (answer === null || answer.offset !== got) return null
      if (size === null) size = answer.size
      else if (answer.size !== size) return null
      const chunk = bytesOfBase64(answer.bytes)
      if (
        chunk === null ||
        // Stryker disable next-line ConditionalExpression: `parseCoverAnswer` refuses an empty `bytes`, and every base64 text it does accept spells at least one byte, so a chunk of nothing cannot arrive. Kept because the assembly below counts on one.
        chunk.length === 0
      )
        return null
      /* ⚠️ **PAID FOR BEFORE IT IS KEPT**, as a page is: a friend's jacket
         draws on the same budget as their pages, and a chunk the budget
         refuses ends the fetch with nothing kept. */
      if (!charge(person, chunk.length)) return null
      got += chunk.length
      if (
        got > size ||
        // Stryker disable next-line ConditionalExpression: `parseCoverAnswer` holds `size` at or under the cap, so anything past the cap is past the size and the clause above has returned already. Kept because it states the bound where it is spent. The `>` itself is measured — a jacket of exactly the cap is fetched whole.
        got > MAX_COVER_BYTES
      )
        return null
      parts.push(chunk)
      if (!answer.more) break
    }
    /* WHAT ARRIVED IS WHAT WAS PROMISED. `got` is a number whatever happened,
       so this catches a `size` the loop never set as well — the `size === null
       ||` that used to spell that out could not fail on its own, the loop
       having set `size` from its first answer and broken only after
       (2026-09-14 mutation debt). */
    if (got !== size) return null
    const bytes = new Uint8Array(got)
    let at = 0
    for (const part of parts) {
      bytes.set(part, at)
      at += part.length
    }
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
        /* ⚠️ **FOLDED TO `null` HERE, WHICH IS WHY `circle.cover-failed` NEVER
           FIRED.** `circlePort` wraps this call in a `catch` that warns
           `circle.cover-failed`, and nothing ever reached it: a refused dial, a
           transport error and a peer that simply has no jacket all arrived as
           `null`, so a row drew nothing and the diagnostics ring said nothing
           either. The ANSWER stays `null` — a missing jacket is not worth
           failing a round over — and the reason is reported on the way past. */
        const bytes = await fetchOne(deps, person, device, pub, digest, abandon.signal).catch((thrown: unknown) => {
          deps.warn?.('circle.cover-fetch-failed', { person, digest, message: messageOf(thrown) })
          return null
        })
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
