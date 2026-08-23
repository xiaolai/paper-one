import { atomicWrite, type IndexFs } from '../../../kernel'

/**
 * WHICH BOOKS TURNED UP HERE ON THEIR OWN, and which device sent them.
 *
 * A satchel that imports a book pushes it, and the shelf fetches the bytes and
 * commits before acking — so the book simply APPEARS in the library, complete,
 * with nothing to say where it came from. That is the right behaviour and the
 * wrong silence: the reader curates this collection, and a title arriving
 * without provenance is the one thing a library should never do.
 *
 * NOT AN APPROVAL QUEUE, and the distinction is the whole design. The shelf is
 * the unattended device — it answers satchels rather than dialling them, and
 * the tray keeps it alive with the window closed — so a gate here would be a
 * book waiting for consent on a machine nobody is looking at. The decision
 * "may this device add to my library" is made once, per device, with a SAS
 * both people read, and is revisable at `sync:push`. This is the other half of
 * that bargain: trust granted in advance, and told about afterwards.
 *
 * IT CLEARS ITSELF WHEN THE BOOK IS OPENED, which is the reader saying they
 * noticed. No timer, no unread badge to dismiss, no number anybody has to
 * defend — `openedAt` already merges as a max across devices, so opening it
 * anywhere counts, which is right: the reader knows about the book either way.
 * A notice that outlived being read would become the sort of permanent
 * decoration nobody sees after a week.
 */

export const ARRIVALS_INDEX_PATH = 'sync/arrivals.json'

export interface Arrival {
  /** The name the peer record carried when the book landed. */
  readonly from: string
  /** When it landed here, so `openedAt` can be compared against it. */
  readonly at: number
}

/**
 * Read the index, defensively — the same shape `readDownloadSizes` is written
 * in and for the same measured reason: a read-modify-write over a transient
 * failure would persist an empty object over every arrival this device had
 * recorded. A row that is not a usable pair is dropped INDIVIDUALLY so a
 * hand-edited entry cannot cost the ones beside it.
 */
export async function readArrivals(fs: IndexFs): Promise<Readonly<Record<string, Arrival>>> {
  let raw: Uint8Array
  try {
    raw = await fs.readFile(ARRIVALS_INDEX_PATH)
  } catch (cause) {
    if (await fs.exists(ARRIVALS_INDEX_PATH)) throw cause
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: Record<string, Arrival> = {}
  for (const [book, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const { from, at } = value as { from?: unknown; at?: unknown }
    if (typeof from !== 'string' || from === '') continue
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue
    out[book] = { from, at }
  }
  return out
}

/** Serialised like the downloads ledger: two read-modify-writes racing would
 *  drop one of the two arrivals they were each recording. */
let queue: Promise<unknown> = Promise.resolve()
const serialWrite = <T,>(task: () => Promise<T>): Promise<T> => {
  const next = queue.then(task, task)
  queue = next.catch(() => {})
  return next
}

export function recordArrival(fs: IndexFs, book: string, arrival: Arrival): Promise<void> {
  return serialWrite(async () => {
    const held = { ...(await readArrivals(fs)), [book]: arrival }
    await atomicWrite(fs, ARRIVALS_INDEX_PATH, new TextEncoder().encode(JSON.stringify(held)))
  })
}

export function dropArrival(fs: IndexFs, book: string): Promise<void> {
  return serialWrite(async () => {
    const held = { ...(await readArrivals(fs)) }
    if (!(book in held)) return
    delete held[book]
    await atomicWrite(fs, ARRIVALS_INDEX_PATH, new TextEncoder().encode(JSON.stringify(held)))
  })
}

/**
 * The sentence a book shows about where it came from, or null once the reader
 * has opened it since it landed.
 *
 * `openedAt` ABSENT MEANS NEVER OPENED, which is the common case for a book
 * that has just arrived and the one this exists to cover — so a missing value
 * must read as "still worth saying", never as "0, which is older than the
 * arrival, so acknowledged".
 */
export function describeArrival(
  arrival: Arrival,
  book: { readonly openedAt?: number },
): { label: string } | null {
  const opened = book.openedAt
  if (typeof opened === 'number' && opened > arrival.at) return null
  return { label: `Added from ${arrival.from}` }
}
