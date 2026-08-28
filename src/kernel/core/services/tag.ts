import { tagCounts } from '../library'
import { normalizeTag, tagKey } from '../tags'
import type { ServiceContext } from '../capability'
import type { ServiceEnvironment } from './environment'
import { descriptorOf, list, num, readInput, reqList, reqStr } from './input'
import { pages } from './paging'
import { SERVICE_ERRORS, refuse } from './refusals'
import type { TagChange, TagCountRow } from './rows'

/**
 * `tag.*` — a normalised string on a book (phase 11, WI-11.3/11.5).
 *
 * TAGS CARRY THE BOOK'S GRANTS, which is the one place this table's
 * grant/noun symmetry is broken on purpose. A `tag:write` that could rewrite
 * `book.json` without `book:write` would be a grant that lies about what it
 * permits — there is no tag store, a tag IS a field of a record, and the
 * permission has to describe the file that changes.
 *
 * `tag.list` is `req` and not `stream`, and that is a measurement rather than
 * an oversight: a shelf has orders of magnitude fewer tags than books (the
 * 1 959-book library measured in WI-8.6 has a few hundred), so the whole
 * answer is kilobytes and paging it would be ceremony.
 */

/** A spelling the store would actually write, or a refusal. `normalizeTag`
 *  trims and cuts to the stored bound; a caller whose tag survives none of
 *  that has not named a tag, and telling them so beats writing nothing and
 *  answering "done". */
function stored(raw: string): string {
  const tag = normalizeTag(raw)
  if (tag === '' || tagKey(tag) === '') throw refuse(SERVICE_ERRORS.malformed, `${JSON.stringify(raw)} is not a tag`)
  /* NO LENGTH CHECK HERE. `normalizeTag` truncates at `TAG_MAX`, and an
   * overlong name silently becoming a SHORTER, DIFFERENT tag is how
   * `tag.remove` and `tag.rename` could act on a tag the caller never named.
   * The bound belongs at the table — every tag field declares
   * `maxLength: TAG_MAX`, so the request is refused before a handler runs and
   * there is no second bound to keep in step with the record's. */
  return tag
}

/** Book ids that are actually on the shelf, or a refusal naming the first
 *  that is not — a partial apply would leave the caller unable to say which
 *  books were tagged. */
function known(env: ServiceEnvironment, bookIds: readonly string[]): readonly string[] {
  const shelf = new Set(env.services.library.getSnapshot().map((one) => one.bookId))
  for (const id of bookIds) if (!shelf.has(id)) throw refuse(SERVICE_ERRORS.notFound, `no book ${id}`)
  /* DEDUPLICATED. `--book a --book a` is one book, and counting it twice
   * would report a change to two books where one was touched — the answer
   * this call exists to give. Order kept, so the refusal above still names
   * the first bad id a caller wrote. */
  return [...new Set(bookIds)]
}


export function tagList(env: ServiceEnvironment) {
  return (req: unknown, ctx: ServiceContext): AsyncIterable<readonly TagCountRow[]> => {
    const input = readInput(descriptorOf('tag.list'), req)
    const limit = num(input, 'limit')
    /* IN PAGES, because a record permits 4 096 tags per book: an ordinary
     * shelf answers in one page and a heavily tagged one no longer produces a
     * frame too large to send. `tagCounts` already orders most-used first with
     * a name tie-break, and reports `mine` — whether any book carries it as
     * the READER'S tag rather than only as a publisher's subject, which is
     * what decides whether it can be renamed at all. It builds fresh rows, so
     * copying each one again would buy no isolation. */
    async function* run(): AsyncGenerator<readonly TagCountRow[]> {
      yield* pages(tagCounts(env.services.library.getSnapshot()), ctx.signal, limit)
    }
    return run()
  }
}

export function tagAdd(env: ServiceEnvironment) {
  return async (req: unknown): Promise<TagChange> => {
    const input = readInput(descriptorOf('tag.add'), req)
    const tag = stored(reqStr(input, 'tag'))
    /* `book` is required by the descriptor, so `readInput` has already
     * refused a request without it — the `?? []` fallback could not run and
     * stated a second, softer contract beside the table's. */
    const bookIds = known(env, reqList(input, 'book'))
    /* WHAT THE STORE WROTE, not what a snapshot predicted.
     *
     * This counted, from the in-memory shelf, the books that did not appear
     * to carry the tag — and the writer decides from the RECORD, which can
     * disagree: a book whose publisher `subjects` already carry the key is
     * skipped there while a row that has not been rescanned still shows no
     * such tag. The service then reported a book as changed that nothing was
     * written for. Two concurrent `tag.add`s had the same problem in the
     * other direction, both counting the same book. The writer is the only
     * thing that knows, so it is the thing that answers. */
    return { tag, books: await env.services.library.tagBooks(bookIds, [tag]) }
  }
}

export function tagRemove(env: ServiceEnvironment) {
  return async (req: unknown): Promise<TagChange> => {
    const input = readInput(descriptorOf('tag.remove'), req)
    const tag = stored(reqStr(input, 'tag'))
    const named = list(input, 'book')
    if (named === undefined) {
      /* ABSENT means shelf-wide. An explicitly EMPTY list does not, and the
       * difference is the whole guard: `--book ,,` collapses to `[]`, and a
       * wire body may carry `book: []` outright. Reading either as "every
       * book" turns a selection the caller believes is empty into a bulk
       * mutation across the library.
       *
       * Counted BEFORE the write, because afterwards no book carries it. */
      const books = env.services.library.ownTagCount(tag)
      await env.services.library.removeTag(tag)
      return { tag, books }
    }
    if (named.length === 0) {
      throw refuse(SERVICE_ERRORS.malformed, 'book was given as an empty list; omit it entirely to mean the whole shelf')
    }
    const bookIds = known(env, named)
    /* WHAT CHANGED, not what was asked for, and answered by the WRITER. A book
     * that did not carry the tag is not a book this call untagged, and
     * reporting it as one makes the answer useless for deciding whether
     * anything happened — but a snapshot is not the authority on what a record
     * held, so the count comes from the mutator that read it. */
    return { tag, books: await env.services.library.untagBooks(bookIds, tag) }
  }
}

export function tagRename(env: ServiceEnvironment) {
  return async (req: unknown): Promise<TagChange> => {
    const input = readInput(descriptorOf('tag.rename'), req)
    const from = stored(reqStr(input, 'from'))
    const to = stored(reqStr(input, 'to'))
    /* Counted before, for the same reason `tag.remove` counts before. And
     * renaming ONTO an existing name MERGES rather than failing — tags fold
     * by key, so the books simply end up under one tag, which is what a
     * reader who typed the other spelling meant. */
    const books = env.services.library.ownTagCount(from)
    if (books === 0) throw refuse(SERVICE_ERRORS.notFound, `no book carries ${JSON.stringify(from)} as your own tag`)
    await env.services.library.renameTag(from, to)
    return { tag: to, books }
  }
}
