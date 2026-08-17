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
  atomicWrite,
  marksPathIn,
  recordPath,
  trashOf,
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
  readonly status: 'migrated' | 'already' | 'failed' | 'skipped'
  readonly reason?: string
  /** How many of the shared store's marks were filed under this book. */
  readonly marks?: number
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v.slice(0, 4000) : undefined
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
/* Whole or nothing, never sliced: `str` cuts at 4000, and a shortened path or
 * URL is not a rougher way back to the book — it is one that opens nothing. */
const origin = (v: unknown): string | undefined =>
  typeof v === 'string' && v && v.length <= 8_000 ? v : undefined
const list = (v: unknown, limit = 64): readonly string[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const clean = v
    .filter((one): one is string => typeof one === 'string' && one !== '')
    .slice(0, limit)
  return clean.length ? clean : undefined
}
/* The reader's OWN tags are not the book's declared subjects, and 64 is the
 * bound for the latter — see `MAX_TAGS` in `bookFolder`. Sharing it here sliced
 * a reader with sixty-five tags down to sixty-four ON A MIGRATION THAT RUNS
 * ONCE, and the completed record then reports `already` for ever after, so
 * nothing would have gone back for them. */
const TAG_LIMIT = 4096

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
    ...(list(row.tags, TAG_LIMIT) ? { tags: list(row.tags, TAG_LIMIT)! } : {}),
    /* NOT `str`, which slices at 4000. A CFI is a path through a document and a
     * shortened one parses as nothing — see `MAX_POSITION`. Carried whole, or
     * not at all: this runs once, so a position lost here is lost for good. */
    ...(typeof row.position === 'string' && row.position && row.position.length <= 64_000
      ? { position: row.position }
      : {}),
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
    /* The reader's own file, OR the address it was opened from. Phase 3 kept
     * `path` and `url` apart; phase 4 has one `origin` because a fallback is a
     * fallback whatever kind of address it holds — and dropping `url` on the
     * way through made every book ever opened from one unopenable, which is
     * most of what a real phase-3 library turned out to contain. */
    ...(origin(row.path) ?? origin(row.url) ? { origin: (origin(row.path) ?? origin(row.url))! } : {}),
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
/** Where the list of books already carried across is kept — see `DONE_FILE`. */
export const DONE_FILE = 'migrated.json'

/**
 * The books this migration has already carried across, by phase-3 id.
 *
 * WITHOUT THIS, REMOVING A MIGRATED BOOK DID NOT REMOVE IT. The phase-3 store is
 * read on every launch and never written, by design — it is the copy that lets a
 * bad migration be walked back. But "already done" was decided by asking whether
 * the phase-4 folder exists, and removing a book moves that folder to the trash.
 * So the next launch found no record, copied the bytes out of the phase-3 layout
 * again, and put the book back on the shelf. There was no failure and no race;
 * it happened every time.
 *
 * A list of ids, written where the migration can find it and the phase-3 store
 * stays untouched. Being told a book is done outranks looking for its folder.
 */
async function readDone(fs: VaultFs): Promise<Set<string>> {
  try {
    if (!(await fs.exists(DONE_FILE))) return new Set()
    const parsed: unknown = JSON.parse(new TextDecoder().decode(await fs.readFile(DONE_FILE)))
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((one): one is string => typeof one === 'string'))
  } catch {
    /* Unreadable is the same as absent HERE, and only here: the cost of being
     * wrong is re-migrating a book that is already migrated, which is idempotent
     * — the folder check below still catches it. */
    return new Set()
  }
}

export async function migrateToFolders(
  fs: VaultFs,
  { rows, marks }: MigrationSources,
): Promise<MigrationOutcome[]> {
  const grouped = marksByBook(marks)
  const outcomes: MigrationOutcome[] = []
  const done = await readDone(fs)
  /* WHICH FOLDERS THIS RUN HAS CLAIMED. `safeId` replaces everything that is not
   * alphanumeric with an underscore, so it is not injective: two phase-3 rows
   * keyed by URL — `.../a-b` and `.../a_b` — land on one directory. The second
   * would find the first's record, report `already`, and its tags, position and
   * marks would be permanently unreachable with nothing said. Renaming the
   * scheme would move every folder in an existing library, so the collision is
   * REPORTED instead, which is the part that was missing. */
  const claimed = new Map<string, string>()

  for (const row of rows) {
    const bookId = typeof row.bookId === 'string' ? row.bookId : ''
    if (!bookId) continue
    /* FOLDED, because the default macOS volume is case-insensitive: `url_x_A`
     * and `url_x_a` are two strings and one directory. Comparing them verbatim
     * distinguished names the filesystem does not, which let exactly the
     * collision this check exists for through. */
    const folder = folderOf(bookId).toLowerCase()
    const owner = claimed.get(folder)
    if (owner !== undefined && owner !== bookId) {
      outcomes.push({
        bookId,
        status: 'failed',
        reason: `its folder name collides with ${owner} — left in the previous library`,
      })
      continue
    }
    claimed.set(folder, bookId)
    try {
      /* ALREADY DONE, so nothing happens. This is what makes a second run — or
       * a run after a crash — safe: a book whose record is FINISHED is left
       * exactly as it is, because rewriting it would overwrite whatever the
       * reader has done since.
       *
       * FINISHED, not merely present. The first version of this migration wrote
       * a record for a row it had no bytes for, and this check then reported it
       * `already` on every later run — so the one state that needed repairing
       * was the one state guaranteed never to be revisited. A record with
       * neither content nor a path back is unfinished business, and falls
       * through to be tried again. */
      /* ALREADY CARRIED ACROSS, whether or not its folder is there now. The
       * folder can be absent because the reader REMOVED the book, and re-running
       * the migration then undid that — see `readDone`. */
      /* OR ITS REMOVED COPY IS SITTING IN THE TRASH, which proves the same
       * thing: a book only reaches the trash by having been on the shelf. This
       * is what covers a library removed BEFORE the ledger existed — without it,
       * upgrading resurrects every such book exactly once, which is the bug the
       * ledger was written for arriving through the door it left open. */
      if (done.has(bookId) || (await fs.exists(trashOf(bookId)))) {
        done.add(bookId)
        outcomes.push({ bookId, status: 'already' })
        continue
      }
      const existing = await readBook(fs, bookId)
      /* PRESENT BUT UNREADABLE IS NOT ABSENT. `readBook` answers both with null,
       * and the retry below writes the phase-3 row when it gets one — so a
       * momentary read failure on a finished book replaced everything the reader
       * had done since with the state it was migrated from. This runs once, so
       * that would be permanent. Reported and skipped instead. */
      if (!existing && (await fs.exists(recordPath(bookId)))) {
        outcomes.push({
          bookId,
          status: 'failed',
          reason: 'its record is there but could not be read — left untouched',
        })
        continue
      }
      if (existing && ((await hasBytes(fs, bookId, existing)) || existing.origin)) {
        done.add(bookId)
        outcomes.push({ bookId, status: 'already' })
        continue
      }

      /* WHAT IS ON DISK WINS over what the row says, when both exist. Falling
       * through to retry must not undo a rename, a tag or a position the reader
       * has applied since the incomplete record was written. */
      const record = existing ? { ...recordFromRow(row), ...existing } : recordFromRow(row)
      const name = `book.${record.ext ?? 'epub'}`

      // The bytes first, then the cover, then the marks, and the RECORD LAST.
      // A record is what puts a book on the shelf, so writing it last means a
      // crash midway leaves a folder that is simply not a book yet, rather than
      // a book missing its content.
      const legacyContent = typeof row.vault === 'string' ? row.vault : null
      const copied = legacyContent
        ? await copy(fs, legacyContent, contentPathIn(bookId, name))
        : false
      /* A ROW WITH NO BYTES AND NO WAY BACK TO THEM IS NOT MIGRATED.
       *
       * Phase 3 only began keeping its own copies near the end, so most rows in
       * a real library have no `vault` — and phase 4 dropped the `url` field
       * that used to open those. Writing a record anyway put books on the shelf
       * that could never be opened, and marked them `already` so the migration
       * would never revisit them.
       *
       * `origin` is the reader's own file and IS a way back, so a row with one
       * still migrates: `openStored` falls back to it. A row with neither is
       * left in the phase-3 store, reported, and picked up by a later run if
       * anything ever makes it recoverable. */
      /* THE SAME TEST THE RECORD USES. `str` slices at 4000 and accepts what
       * `origin` rejects past 8000 — so a row with a very long address passed
       * this gate, then had that address DROPPED by `recordFromRow`, and was
       * reported `migrated` as a book with neither content nor a way back. */
      if (!copied && !record.origin) {
        outcomes.push({
          bookId,
          status: 'skipped',
          reason: 'no stored copy and no original path — left in the previous library',
        })
        continue
      }
      const legacyCover = typeof row.cover === 'string' ? row.cover : null
      if (legacyCover) {
        await copy(fs, legacyCover, `${folderOf(bookId)}/cover.webp`)
      }

      const mine = grouped.get(bookId) ?? []
      /* ONLY IF THE FOLDER HAS NONE. A retry of an incomplete record reaches
       * here a second time, and writing the phase-3 snapshot over `marks.json`
       * would discard every highlight made since the first attempt. The phase-3
       * store is the source only for a book that has no marks of its own yet. */
      if (mine.length && !(await fs.exists(marksPathIn(bookId)))) {
        await writeMarks(fs, bookId, mine)
      }

      await writeBook(fs, bookId, record)
      done.add(bookId)
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
  /* Written LAST and best effort. Failing to record what was done costs a
   * repeat, which is idempotent; failing the migration over it would cost the
   * books. */
  if (done.size) {
    await atomicWrite(fs, DONE_FILE, new TextEncoder().encode(JSON.stringify([...done]))).catch(
      (cause: unknown) => {
        console.error('Paper: could not record which books were carried across', cause)
      },
    )
  }
  return outcomes
}

/** Whether a record's own folder actually holds the book it describes. */
async function hasBytes(fs: VaultFs, bookId: string, record: BookRecord): Promise<boolean> {
  return fs.exists(contentPathIn(bookId, `book.${record.ext ?? 'epub'}`))
}

/**
 * Copy one file, tolerating a source that is not there.
 *
 * A row can name a vault copy or a cover that has since been deleted — phase 3
 * had bugs that produced exactly that — so a missing source is a book without
 * its bytes rather than a failed migration.
 */
async function copy(fs: VaultFs, from: string, to: string): Promise<boolean> {
  let bytes: Uint8Array
  try {
    bytes = await fs.readFile(from)
  } catch {
    // A row naming a copy that is not there — phase 3 had bugs producing exactly
    // that. Reported as "no bytes", not as a failure.
    return false
  }
  await atomicWrite(fs, to, bytes)
  return true
}

/** A line for the reader, since a silent migration is indistinguishable from none. */
export function summariseMigration(outcomes: readonly MigrationOutcome[]): string | null {
  const migrated = outcomes.filter((one) => one.status === 'migrated')
  const failed = outcomes.filter((one) => one.status === 'failed')
  if (migrated.length === 0 && failed.length === 0) return null
  const marks = migrated.reduce((sum, one) => sum + (one.marks ?? 0), 0)
  const skipped = outcomes.filter((one) => one.status === 'skipped')
  const parts = [`${migrated.length} ${migrated.length === 1 ? 'book' : 'books'} moved`]
  if (marks) parts.push(`${marks} ${marks === 1 ? 'note' : 'notes'} kept`)
  // Named separately from a failure, because it is not one: those books are
  // still in the previous library and nothing was lost.
  if (skipped.length) parts.push(`${skipped.length} had no stored copy`)
  if (failed.length) parts.push(`${failed.length} could not be moved`)
  return parts.join(', ')
}
