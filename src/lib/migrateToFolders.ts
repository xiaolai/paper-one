/**
 * Move a phase-3 library into phase-4 folders.
 *
 * ```
 * before                              after
 *   paper.store.v1.json                 books/<id>/book.json
 *     paper.library.v1  (rows)          books/<id>/content.<ext>
 *     paper.marks.v1    (all books)     books/<id>/cover.webp
 *   books/<id>.<ext>                    books/<id>/marks.json
 *   covers/<id>.jpg
 * ```
 *
 * THIS IS THE ONE PIECE THAT RUNS ONCE, against data that exists once, and whose
 * failure mode is a reader's own writing. Everything else in this phase can be
 * re-run, reverted, or fixed in the next commit. So it is shaped by four rules
 * rather than by convenience:
 *
 *   IDEMPOTENT — safe to run twice, and safe after a half-finished one. A book
 *     whose folder already has a record is skipped, so a crash midway costs the
 *     books not yet reached and nothing else.
 *
 *   ADDITIVE — the old files are READ and never deleted. If phase 4 turns out to
 *     be wrong, the phase-3 layout is still on disk. Reclaiming that space is a
 *     later decision made deliberately, not a side effect of migrating.
 *
 *   PER BOOK — one unreadable book costs that book and is named. A migration
 *     that fails whole is a migration that cannot be resumed.
 *
 *   LAST — after every other item, so the layout it is writing into is settled.
 *     Writing a one-shot migration against an undecided shape is the worst
 *     possible order.
 */

import type { VaultFs } from './bookVault'
import { extensionFor } from './bookVault'
import {
  contentPathIn,
  folderOf,
  readBook,
  writeBook,
  writeMarks,
  type BookRecord,
} from './bookFolder'

/** What phase 3 wrote as a library row. Everything optional — it is old data. */
interface LegacyRow {
  readonly bookId?: unknown
  readonly title?: unknown
  readonly author?: unknown
  readonly url?: unknown
  readonly path?: unknown
  readonly vault?: unknown
  readonly cover?: unknown
  readonly lastOpened?: unknown
  readonly position?: unknown
  readonly progress?: unknown
  readonly finished?: unknown
  readonly tags?: unknown
  readonly subjects?: unknown
  readonly series?: unknown
  readonly seriesIndex?: unknown
  readonly publisher?: unknown
  readonly published?: unknown
  readonly languages?: unknown
  readonly sortAs?: unknown
}

export interface MigrationOutcome {
  readonly bookId: string
  readonly status: 'migrated' | 'already' | 'failed'
  readonly reason?: string
  /** How many of the shared store's marks were filed under this book. */
  readonly marks?: number
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v.slice(0, 4000) : undefined
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const list = (v: unknown): readonly string[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const clean = v.filter((one): one is string => typeof one === 'string' && one !== '').slice(0, 64)
  return clean.length ? clean : undefined
}

/** A phase-3 row as a phase-4 record. Field names changed; meanings did not. */
export function recordFromRow(row: LegacyRow): BookRecord {
  return {
    title: str(row.title) ?? '',
    author: str(row.author) ?? '',
    ...(str(row.sortAs) ? { sortAs: str(row.sortAs)! } : {}),
    ...(str(row.series) ? { series: str(row.series)! } : {}),
    ...(num(row.seriesIndex) === undefined ? {} : { seriesIndex: num(row.seriesIndex)! }),
    ...(str(row.publisher) ? { publisher: str(row.publisher)! } : {}),
    ...(str(row.published) ? { published: str(row.published)! } : {}),
    ...(list(row.languages) ? { languages: list(row.languages)! } : {}),
    ...(list(row.subjects) ? { subjects: list(row.subjects)! } : {}),
    ...(list(row.tags) ? { tags: list(row.tags)! } : {}),
    ...(str(row.position) ? { position: str(row.position)! } : {}),
    ...(num(row.progress) === undefined
      ? {}
      : { progress: Math.min(1, Math.max(0, num(row.progress)!)) }),
    ...(typeof row.finished === 'boolean' ? { finished: row.finished } : {}),
    /* `lastOpened` becomes `openedAt` AND `addedAt`. The old shape had one
     * timestamp and phase 4 has two; using it for both is the only honest
     * answer, because "when was this added" was never recorded and inventing a
     * date would put migrated books in an order nobody chose. */
    ...(num(row.lastOpened) === undefined
      ? {}
      : { openedAt: num(row.lastOpened)!, addedAt: num(row.lastOpened)! }),
    // The reader's own file, kept for provenance only — see `BookRecord`.
    ...(str(row.path) ? { origin: str(row.path)! } : {}),
    ...(str(row.vault) ? { ext: extensionFor(str(row.vault)!) } : {}),
  }
}

/** Group the shared marks store by the book each mark belongs to. */
export function marksByBook(raw: unknown): Map<string, unknown[]> {
  const grouped = new Map<string, unknown[]>()
  if (!Array.isArray(raw)) return grouped
  for (const mark of raw) {
    const id = (mark as { bookId?: unknown })?.bookId
    if (typeof id !== 'string' || !id) continue
    const bucket = grouped.get(id)
    if (bucket) bucket.push(mark)
    else grouped.set(id, [mark])
  }
  return grouped
}

export interface MigrationSources {
  /** The phase-3 library rows, already JSON-parsed. */
  readonly rows: readonly LegacyRow[]
  /** The phase-3 shared marks store, already JSON-parsed. */
  readonly marks: unknown
}

/**
 * Carry every phase-3 book into its own folder.
 *
 * The content and cover are COPIED rather than moved, so the old layout survives
 * a migration that goes wrong. That doubles the disk a library takes until the
 * old files are cleared, which is stated in the plan and is the price of being
 * able to go back.
 */
export async function migrateToFolders(
  fs: VaultFs,
  { rows, marks }: MigrationSources,
): Promise<MigrationOutcome[]> {
  const grouped = marksByBook(marks)
  const outcomes: MigrationOutcome[] = []

  for (const row of rows) {
    const bookId = typeof row.bookId === 'string' ? row.bookId : ''
    if (!bookId) continue
    try {
      /* ALREADY DONE, so nothing happens. This is what makes a second run — or
       * a run after a crash — safe: a book whose record exists is finished, and
       * rewriting it would overwrite whatever the reader has done since. */
      if (await readBook(fs, bookId)) {
        outcomes.push({ bookId, status: 'already' })
        continue
      }

      const record = recordFromRow(row)
      const name = `book.${record.ext ?? 'epub'}`

      // The bytes first, then the cover, then the marks, and the RECORD LAST.
      // A record is what puts a book on the shelf, so writing it last means a
      // crash midway leaves a folder that is simply not a book yet, rather than
      // a book missing its content.
      const legacyContent = typeof row.vault === 'string' ? row.vault : null
      if (legacyContent) {
        await copy(fs, legacyContent, contentPathIn(bookId, name))
      }
      const legacyCover = typeof row.cover === 'string' ? row.cover : null
      if (legacyCover) {
        await copy(fs, legacyCover, `${folderOf(bookId)}/cover.webp`)
      }

      const mine = grouped.get(bookId) ?? []
      if (mine.length) await writeMarks(fs, bookId, mine)

      await writeBook(fs, bookId, record)
      outcomes.push({ bookId, status: 'migrated', marks: mine.length })
    } catch (cause) {
      /* Named, and the loop continues. A migration that fails whole is a
       * migration that cannot be resumed, and the reader is left with neither
       * layout complete. */
      outcomes.push({
        bookId,
        status: 'failed',
        reason: cause instanceof Error ? cause.message : 'could not be migrated',
      })
    }
  }
  return outcomes
}

/**
 * Copy one file, tolerating a source that is not there.
 *
 * A row can name a vault copy or a cover that has since been deleted — phase 3
 * had bugs that produced exactly that — so a missing source is a book without
 * its bytes rather than a failed migration.
 */
async function copy(fs: VaultFs, from: string, to: string): Promise<void> {
  let bytes: Uint8Array
  try {
    bytes = await fs.readFile(from)
  } catch {
    return
  }
  await fs.mkdir(to.slice(0, to.lastIndexOf('/')))
  const writing = `${to}.writing`
  try {
    await fs.writeFile(writing, bytes)
    await fs.rename(writing, to)
  } catch (cause) {
    await fs.remove(writing).catch(() => {})
    throw cause
  }
}

/** A line for the reader, since a silent migration is indistinguishable from none. */
export function summariseMigration(outcomes: readonly MigrationOutcome[]): string | null {
  const migrated = outcomes.filter((one) => one.status === 'migrated')
  const failed = outcomes.filter((one) => one.status === 'failed')
  if (migrated.length === 0 && failed.length === 0) return null
  const marks = migrated.reduce((sum, one) => sum + (one.marks ?? 0), 0)
  const parts = [`${migrated.length} ${migrated.length === 1 ? 'book' : 'books'} moved`]
  if (marks) parts.push(`${marks} ${marks === 1 ? 'note' : 'notes'} kept`)
  if (failed.length) parts.push(`${failed.length} could not be moved`)
  return parts.join(', ')
}
