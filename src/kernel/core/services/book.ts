import { folderOf, type BookRecord } from '../bookFolder'
import type { ReadingState, Stars } from '../circle/log'
import { BLOB_FOLDER } from '../ports'
import { listTrash } from '../bookTrash'
import type { IndexedBook } from '../bookIndex'
import { allTags, byRecency, inScope, matchesQuery } from '../library'
import { parseQuery } from '../searchQuery'
import { fold, tagKey } from '../tags'
import type { ServiceContext } from '../capability'
import { findBook as find, type ServiceEnvironment } from './environment'
import { bool, descriptorOf, num, readInput, reqStr, str, type ServiceInput } from './input'
import { pages } from './paging'
import { trashFs } from './trash'
import { SERVICE_ERRORS, refuse } from './refusals'
import { bookDetail, bookRow, positionSet, type BookDetail, type BookRow, type PositionSetRow, type RemovedRow, type RestoredRow } from './rows'

/**
 * `book.*` — the noun the whole library hangs off (phase 11, WI-11.3/11.5).
 *
 * Every handler here reads the SHELF SNAPSHOT rather than the filesystem. The
 * snapshot is the library store's authority between writes — a coalesced
 * write still in flight is in it before it is on disk — so answering from it
 * is never staler than reading the folders, and costs no round trip per book.
 * That is what lets `book.list` answer on a 2 000-row library at all.
 *
 * The filters compose by AND, deliberately, and it is the same rule the shelf
 * itself uses: adding a term narrows. `tag:Sea tag:Classics` meaning "nautical
 * OR classical" would grow the result as the caller typed more, which is the
 * opposite of what typing more means anywhere else.
 */

/** A row is in the `since` delta when either stamp the index carries is at or
 *  past it. Coarse on purpose: `since` is a delta, not a resumable cursor —
 *  the plan defers cursors until something needs one — and these two stamps
 *  are all a shelf row has to date itself by. */
const touchedSince = (book: IndexedBook, since: number): boolean =>
  (book.addedAt ?? 0) >= since || (book.openedAt ?? 0) >= since

function filtered(books: readonly IndexedBook[], input: ServiceInput): readonly IndexedBook[] {
  const tag = str(input, 'tag')
  const author = str(input, 'author')
  const finished = bool(input, 'finished')
  const downloaded = bool(input, 'downloaded')
  const since = num(input, 'since')
  const wantedTag = tag === undefined ? null : tagKey(tag)
  /* FOLDED, not lower-cased — the same rule tags identify by (`fold`).
   * `toLowerCase` alone is not case-folding for every script and does not
   * normalise, so `Ångström` typed one way missed a record spelling it the
   * other, and a Turkish dotted I matched nothing. The filter and the stored
   * author go through the same function or they disagree. */
  const wantedAuthor = author === undefined ? null : fold(author)
  return books.filter((book) => {
    if (wantedTag !== null && !allTags(book).some((one) => tagKey(one) === wantedTag)) return false
    /* THE STORED FIELD, not the display fallback: `displayAuthor` answers
     * "Unknown author" for an empty one, so that phrase as a filter matched
     * every authorless book against a filter the doc says is over the field. */
    if (wantedAuthor !== null && !fold(book.author ?? '').includes(wantedAuthor)) return false
    if (finished !== undefined && (book.finished === true) !== finished) return false
    /* THREE STATES, and the filter names two of them exactly: `true` is a
     * measured yes, `false` a measured no, and an unmeasured row answers
     * NEITHER — collapsing unknown into "not downloaded" was a definite
     * answer the model never gave. */
    if (downloaded !== undefined && book.hasContent !== downloaded) return false
    if (since !== undefined && !touchedSince(book, since)) return false
    return true
  })
}

export function bookList(env: ServiceEnvironment) {
  return (req: unknown, ctx: ServiceContext): AsyncIterable<readonly BookRow[]> => {
    const input = readInput(descriptorOf('book.list'), req)
    const rows = byRecency(filtered(env.services.library.getSnapshot(), input)).map(bookRow)
    return pages(rows, ctx.signal, num(input, 'limit'))
  }
}

export function bookGet(env: ServiceEnvironment) {
  return async (req: unknown): Promise<BookDetail> => {
    const input = readInput(descriptorOf('book.get'), req)
    return bookDetail(find(env, reqStr(input, 'book')))
  }
}

export function bookSearch(env: ServiceEnvironment) {
  return (req: unknown, ctx: ServiceContext): AsyncIterable<readonly BookRow[]> => {
    const input = readInput(descriptorOf('book.search'), req)
    const raw = reqStr(input, 'query')
    /* THE SHELF'S OWN PARSER, not a second one. `tag:`, `-tag:`, `is:reading`
     * and `is:untagged` mean here exactly what they mean in the search field,
     * because it is the same function reading them — and a CLI that
     * understood a different dialect from the app would be a second query
     * language nobody asked for. */
    const query = parseQuery(raw, tagKey)
    const scope = {
      tags: query.tags,
      excluded: query.excluded,
      status: query.status,
      untagged: query.untagged,
    }
    const rows = byRecency(
      env.services.library.getSnapshot().filter((book) => inScope(book, scope) && matchesQuery(book, query.text)),
    ).map(bookRow)
    return pages(rows, ctx.signal, num(input, 'limit'))
  }
}

export function bookAdd(env: ServiceEnvironment) {
  return async (req: unknown): Promise<BookDetail> => {
    const input = readInput(descriptorOf('book.add'), req)
    const bookId = reqStr(input, 'book')
    /* BY FOLDER, not by id. `safeId` replaces every character outside
     * [A-Za-z0-9] with `_`, so the mapping is MANY-TO-ONE: `book:a/b` and
     * `book:a_b` are different ids and one directory. Compared by id alone,
     * adding the first while the second is on the shelf writes a record over
     * a book that is already there — a silent overwrite rather than the
     * conflict a caller can act on. */
    /* FOLDED, because the filesystem folds. macOS's default APFS volume is
     * case-INSENSITIVE, so `books/Case` and `books/case` are one directory —
     * and `migrateToFolders` already compares folder names lower-cased for
     * exactly this reason. Compared case-sensitively, two ids that differ
     * only in case pass the guard and the second write replaces the first
     * record while both calls report success. */
    /* THE FOLDER THE ID PRODUCES MUST BE A LEGAL ONE.
     *
     * `book` is bounded at the record's field length, and `safeId` can turn
     * 500 characters into a 500-character directory name — past the 80 the
     * blob contract allows (`BLOB_FOLDER`) and, on some filesystems, past the
     * component limit. Accepted here, it produced a book whose content
     * operations refused it later and whose folder might not be creatable at
     * all. Checked against the shared pattern so the API and the blob layer
     * cannot disagree about what a folder is. */
    const segmentOf = (id: string): string => {
      const at = folderOf(id)
      return at.slice(at.lastIndexOf('/') + 1)
    }
    if (!BLOB_FOLDER.test(segmentOf(bookId))) {
      throw refuse(
        SERVICE_ERRORS.malformed,
        `book ${bookId} does not name a usable folder — it must reduce to 1 to 80 characters of [A-Za-z0-9_]`,
      )
    }
    const folder = folderOf(bookId).toLowerCase()
    const clash = env.services.library.getSnapshot().find((one) => folderOf(one.bookId).toLowerCase() === folder)
    if (clash) {
      throw refuse(
        SERVICE_ERRORS.conflict,
        clash.bookId === bookId
          ? `book ${bookId} is already on the shelf`
          : `book ${bookId} would share a folder with ${clash.bookId}`,
      )
    }
    /* AND THE TRASH, which the live snapshot cannot see.
     *
     * `library.add` restores a matching trash path — that is how re-adding a
     * removed book brings its marks and bytes back — and `folderOf` is
     * many-to-one. So adding an ALIAS of a trashed id (`book:a/b` against a
     * trashed `book:a_b`) matched that folder, moved the removed book's
     * record, content and marks out of the trash, and relabelled the lot
     * under the new id. Silent, and it merges two logical books.
     *
     * Refused by name instead, with both ways out stated: the folder is
     * occupied, and the caller either wanted that book back or wants the
     * folder freed. */
    /* The trash entry's `folder` is the bare directory under `trash/`, while
     * `folderOf` answers `books/<safeId>` — so the comparison is on the last
     * segment of each. Comparing the whole path against a bare name silently
     * never matched, which this file's own test caught. */
    const segment = folder.slice(folder.lastIndexOf('/') + 1)
    const trashed = (await listTrash(trashFs(env))).find((one) => one.folder.toLowerCase() === segment)
    if (trashed) {
      throw refuse(
        SERVICE_ERRORS.conflict,
        trashed.bookId === bookId
          ? `book ${bookId} is in the trash — restore it, or empty the trash first`
          : `book ${bookId} would share a folder with ${trashed.bookId}, which is in the trash`,
      )
    }
    /* Against the blob layer's own set — declared as the row's `choices`,
     * so `readInput` refuses it, `--help` prints the vocabulary and this
     * handler holds no second copy of the rule. */
    const ext = str(input, 'ext')
    const record: BookRecord = {
      bookId,
      title: reqStr(input, 'title'),
      author: str(input, 'author') ?? '',
      addedAt: Date.now(),
      ...(ext === undefined ? {} : { ext }),
    }
    /* AND THE DECISION ITSELF IS MADE IN THE BOOK'S LANE — `AddGuard.fresh`.
     *
     * Everything above is a check-then-act across a lane boundary: the
     * snapshot and the trash are read here, and the folder is written there.
     * Between the two an aliasing `book.add` can publish its own optimistic
     * row for this folder, or a removal can put the folder in the trash for
     * `library.add` to silently restore and relabel — and `add` FOLDS rather
     * than refusing, so both callers were told their book was added and two
     * logical books ended up sharing one directory.
     *
     * The scans stay because they are the better MESSAGE: they name the
     * occupant, and they fold case, which a path derived from the id cannot on
     * a case-sensitive filesystem. They are the diagnosis; the lane is the
     * decision. */
    if ((await env.services.library.add(bookId, record, false, { fresh: true })) === 'folder-taken') {
      throw refuse(
        SERVICE_ERRORS.conflict,
        `book ${bookId} was not added: its folder was taken while the add waited its turn`,
      )
    }
    return bookDetail(find(env, bookId))
  }
}

export function bookSet(env: ServiceEnvironment) {
  return async (req: unknown): Promise<BookDetail> => {
    const input = readInput(descriptorOf('book.set'), req)
    const bookId = reqStr(input, 'book')
    find(env, bookId)
    /* NO TITLE, NO AUTHOR — withdrawn on the row (WI-20.7), so `readInput`
     * has already refused either by name before this runs. The edit went
     * through `patch` with no stamp and lost to the next parse. */
    const finished = bool(input, 'finished')
    const position = str(input, 'position')
    const progress = num(input, 'progress')
    /* The reader's own opinion (WI-23.B3). The row bounds the rating to a
     * whole number in [1, 5] and the review to `MAX_REVIEW`; the status is a
     * closed word this checks by name, so a typo is refused rather than
     * stored as a state no reader has. */
    const status = str(input, 'status')
    const rating = num(input, 'rating') as Stars | undefined
    const review = str(input, 'review')
    /* STATUS MOVES `finished` WITH IT — the row says so — so a request that
     * sends both, disagreeing, asks for two states at once. Refused by name
     * here rather than answered with whichever the store applied last, or
     * with the store's own refusal, which names no field. */
    if (status !== undefined && finished !== undefined && (status === 'finished') !== finished) {
      throw refuse(SERVICE_ERRORS.malformed, `status ${status} and finished ${String(finished)} disagree`)
    }
    /* A PATCH THAT CHANGES NOTHING IS NOT A READ, and the table says so now.
     *
     * `book.set` answers with the whole `BookDetail`, and `book:write` does
     * not imply `book:read` — so a peer granted only writes could send an
     * empty patch and use the reply as a read endpoint for every field of
     * every book. That rule lived here, where no document could be held to
     * it; it is `atLeastOne` on the row, so `readInput` refuses an empty patch
     * before this runs AND the reference and `--help` both say so. */
    /* AN EMPTY POSITION IS NOT A POSITION. `parseRecord` drops one on reload
     * while keeping the progress beside it, so storing it answered success
     * over a change that would not survive the next read. Clearing a position
     * is a different act and does not have a verb yet; refusing is honest
     * where a silent no-op is not. */
    if (position !== undefined && position === '') {
      throw refuse(SERVICE_ERRORS.malformed, 'position may not be empty')
    }
    if (progress !== undefined && position === undefined) {
      /* The store's one position mutator writes both together and is
       * identity-guarded on the pair, so a progress with no position would
       * either be dropped or would move the reader to nowhere. Refused by
       * name rather than half-applied. */
      throw refuse(SERVICE_ERRORS.malformed, 'progress needs position')
    }
    /* ONE WRITE, NOT THREE.
     *
     * This ran `update`, then `setFinished`, then `rememberPosition` — three
     * queued tasks, three whole-record writes and three journal brackets for
     * one request. Two consequences, both real: a failure in the second left
     * the first persisted with nothing saying the request had half happened,
     * and two concurrent `book.set` calls interleaved into a record matching
     * neither — this caller's title beside that caller's position, a state
     * nobody asked for and no retry reproduces.
     *
     * `patch` still stamps the ledger's registers (`finishedAt`, `positionAt`)
     * from one clock reading, which is what the three separate mutators were
     * there to guarantee; it is the store's own mutator, so nothing here
     * rewrites a record past them. The progress is carried from the RECORD
     * inside the patch rather than read off a snapshot out here — omitted
     * means "leave it alone", and the record is what actually holds it. */
    await env.services.library.patch(bookId, {
      ...(finished === undefined ? {} : { finished }),
      ...(position === undefined ? {} : { position: { position, ...(progress === undefined ? {} : { progress }) } }),
      ...(status === undefined ? {} : { status: status as ReadingState }),
      ...(rating === undefined ? {} : { rating }),
      ...(review === undefined ? {} : { review }),
    })
    return bookDetail(find(env, bookId))
  }
}

/**
 * `book.position` — one register, under its own grant. See the row.
 *
 * The same store verb `book.set` reaches for a position, so the two cannot
 * disagree about what a position write does; what differs is the door. A
 * progress not given keeps the record's — a device that knows where it is
 * but not how far through (a fixed-layout page) must not zero the bar.
 */
export function bookPosition(env: ServiceEnvironment) {
  return async (req: unknown): Promise<PositionSetRow> => {
    const input = readInput(descriptorOf('book.position'), req)
    const bookId = reqStr(input, 'book')
    /* Found, so a position for a book that is not here is refused here — the store's own answer would be a silent no-op. */
    // Stryker disable next-line CallExpression: the answer's own `find`, below, refuses an unknown book the same way; this one spares the store a write that is a no-op.
    find(env, bookId)
    const position = reqStr(input, 'position')
    /* A progress not given is left to the store, which reads the record
       inside the book's lane — a copy taken from the snapshot here could
       overwrite a progress that landed while this write waited its turn. */
    const progress = num(input, 'progress')
    // Stryker disable next-line ConditionalExpression: an explicit undefined reads as no progress in the store.
    await env.services.library.rememberPosition(bookId, position, ...(progress === undefined ? [] : [progress]))
    return positionSet(find(env, bookId))
  }
}

export function bookRemove(env: ServiceEnvironment) {
  return async (req: unknown): Promise<RemovedRow> => {
    const input = readInput(descriptorOf('book.remove'), req)
    const bookId = reqStr(input, 'book')
    const known = env.services.library.getSnapshot().some((one) => one.bookId === bookId)
    if (!known) return { id: bookId, removed: false }
    await env.services.library.remove(bookId)
    return { id: bookId, removed: true }
  }
}

export function bookRestore(env: ServiceEnvironment) {
  return async (req: unknown): Promise<RestoredRow> => {
    const input = readInput(descriptorOf('book.restore'), req)
    const bookId = reqStr(input, 'book')
    /* THE FOLDER IS NOT THE IDENTITY, and restoring by folder alone conflated
     * them. `folderOf` is many-to-one, so an id that merely sanitises to the
     * same directory matched a trashed book and brought it back RELABELLED as
     * the caller's id — a different logical book, reidentified, with its marks
     * and bytes attached to the wrong name.
     *
     * The trashed record's own `bookId` is the identity, so it is read and
     * compared before anything moves. A folder holding somebody else's book
     * is a conflict the caller can act on, not a restore. */
    const folder = folderOf(bookId).toLowerCase()
    const segment = folder.slice(folder.lastIndexOf('/') + 1)
    const trashed = (await listTrash(trashFs(env))).find((one) => one.folder.toLowerCase() === segment)
    if (trashed && trashed.bookId !== bookId) {
      throw refuse(
        SERVICE_ERRORS.conflict,
        `that folder holds ${trashed.bookId}, not ${bookId}; nothing was restored`,
      )
    }
    /* THE OUTCOME, not a boolean squeezed out of it. A restore that could
     * only bring back part of the book reported plain success, so the reader
     * was told their book was back while its record sat in the trash ageing
     * towards the sweep. An unreadable trash now REFUSES rather than
     * answering "there was nothing to restore". */
    /* AND THE IDENTITY IS READ AGAIN IN THE BOOK'S LANE — `RestoreGuard`.
     *
     * The scan above is a check-then-act across a lane boundary: the trash is
     * read here and the folder is emptied there, and a removal of an aliasing
     * id lands in exactly the folder this restore is about to empty. The scan
     * stays because it names the occupant and folds case; the lane is what
     * cannot be raced. Both refuse with the same sentence, because a caller
     * branching on the message must not be able to tell which one answered. */
    const outcome = await env.services.library.restore(bookId, { onlyThisBook: true })
    if (outcome.state === 'mismatch') {
      throw refuse(
        SERVICE_ERRORS.conflict,
        `that folder holds ${outcome.bookId}, not ${bookId}; nothing was restored`,
      )
    }
    /* AND A FOLDER WHOSE OWNER CANNOT BE ESTABLISHED IS REFUSED TOO, with its
     * own sentence because the reader's move is different: a mismatch names
     * the book in the way, and this one names the file to look at. Answering
     * "nothing to restore" over a record that would not read is the shape of
     * lie the outcome type was widened to stop. */
    if (outcome.state === 'unreadable') {
      throw refuse(
        SERVICE_ERRORS.conflict,
        `the record in the ${outcome.at} folder for ${bookId} could not be read, so it cannot be told whose book it is; nothing was restored`,
      )
    }
    return {
      bookId,
      restored: outcome.state !== 'absent',
      held: outcome.state === 'partial' ? outcome.held : [],
    }
  }
}
