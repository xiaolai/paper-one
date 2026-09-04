import { folderOf, type CoverName, type HashPort, type Library } from '../../../kernel'

/**
 * A jacket's facts on the record, written and taken back INSIDE the book's
 * lane, against the file that is there at that moment — WI-23.C5.
 *
 * ⚠️ **THE FACTS DESCRIBE THE FILE, OR THEY ARE NOT WRITTEN.** Measured
 * outside the lane, a stamp queued behind a removal restored facts for a
 * deleted file, and a same-name replacement received the digest of the file
 * it replaced; fenced on a path merely existing, an unstamp spared facts for
 * a replacement nothing had stamped, and the circle advertised an obsolete
 * digest for as long as the stamp took to come. Both go through
 * `Library.updateAfter`, whose hook runs where the write does.
 */
export interface CoverStampDeps {
  readonly library: Pick<Library, 'updateAfter'>
  /** The host's hasher, read at call time — bound after the services are built; null on a composition without one. */
  readonly hashes: () => HashPort | null
}

export interface CoverStamp {
  readonly name: CoverName
  readonly size: number
  readonly hash: string
}

/** The plugin names a book's folder by its segment under `books/`, not by its path. */
const segmentOf = (live: string): string => {
  const folder = folderOf(live)
  return folder.slice(folder.lastIndexOf('/') + 1)
}

/** The jacket under `name`, measured in the lane — or null: no hasher, or one that would not answer. */
async function measured(hashes: HashPort | null, live: string, name: CoverName): Promise<CoverStamp | null> {
  if (hashes === null) return null
  try {
    const have = await hashes.hashFile(segmentOf(live), name)
    return { name, size: have.size, hash: have.blake3 }
  } catch {
    return null
  }
}

/**
 * Stamp a jacket that landed: what is written is a measurement taken in the
 * lane, never the offer as it was — a removal queued ahead has taken the
 * file (nothing is written), a same-name replacement is measured as itself.
 * Without a hasher, the file's presence under the name is all that can be
 * checked, and the verified transfer's facts stand in.
 */
export function stampMeasured(deps: CoverStampDeps, book: string, offered: CoverStamp): Promise<void> {
  const held: { facts: CoverStamp | null } = { facts: null }
  return deps.library.updateAfter(
    book,
    {
      before: async (target, live) => {
        const port = deps.hashes()
        if (port !== null) {
          held.facts = await measured(port, live, offered.name)
          return held.facts === null ? 'refuse' : 'go'
        }
        held.facts = (await target.exists(`${folderOf(live)}/${offered.name}`)) ? offered : null
        return held.facts === null ? 'refuse' : 'go'
      },
    },
    (record) => {
      const fresh = held.facts
      if (fresh === null) return record
      const have = record.coverFacts
      /* The whole tuple, not the hash alone: rewritten only when one of the three differs. */
      return have !== undefined && have.name === fresh.name && have.size === fresh.size && have.hash === fresh.hash ? record : { ...record, coverFacts: fresh }
    },
  )
}

/**
 * Take a jacket's facts back — unless they are VERIFIED to describe the file
 * under that name now. A file gone: its facts go. A file there that hashes
 * to the facts held: a replacement already stamped as itself, kept. A file
 * there that hashes to something else, or that cannot be measured: facts the
 * record cannot back, cleared — the next measurement puts them right, and
 * until then the circle advertises nothing rather than an obsolete digest.
 */
export function unstampUnlessVerified(deps: CoverStampDeps, book: string, name: string): Promise<void> {
  const held: { present: CoverStamp | null } = { present: null }
  return deps.library.updateAfter(
    book,
    {
      before: async (target, live) => {
        if (!(await target.exists(`${folderOf(live)}/${name}`))) return 'go'
        held.present = await measured(deps.hashes(), live, name as CoverName)
        return 'go'
      },
    },
    (record) => {
      const facts = record.coverFacts
      /* THE FACTS OF THIS NAME, not any facts — `removeBlob`'s rule. */
      if (facts === undefined || facts.name !== name) return record
      const present = held.present
      if (present !== null && present.hash === facts.hash && present.size === facts.size) return record
      const { coverFacts: _gone, ...rest } = record
      return rest
    },
  )
}
