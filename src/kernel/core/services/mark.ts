import type { ServiceContext } from '../capability'
import { compareMarks, createMark, liveMarks, type Mark, type MarkKind, type MarkTint } from '../marks'
import type { ServiceEnvironment } from './environment'
import { descriptorOf, num, readInput, reqStr, str } from './input'
import { pages } from './paging'
import { SERVICE_ERRORS, refuse } from './refusals'
import { markRow, type MarkRow, type RemovedRow } from './rows'

/**
 * `mark.*` — a highlight, note or bookmark, anchored by CFI in one book
 * (phase 11, WI-11.3/11.5).
 *
 * MARKS LIVE IN BOOK FOLDERS, so "every mark" costs one read per book. That
 * is why `mark.list` with no `book` runs `loadAll` first and one with a book
 * runs `forBook`: the expensive answer is paid for at the moment somebody
 * asks for it, and the cheap one never pays for it at all.
 *
 * Every read goes through the store rather than the files, so it is ordered
 * against that book's writes on the shared queue. A read taken outside the
 * queue returned the file as it was BEFORE a highlight that had already been
 * made, which is how a mark came to be written over.
 */

const knownBook = (env: ServiceEnvironment, bookId: string): void => {
  if (!env.services.library.getSnapshot().some((one) => one.bookId === bookId)) {
    throw refuse(SERVICE_ERRORS.notFound, `no book ${bookId}`)
  }
}

/* `oneOf` LIVED HERE AND IS GONE. A member of a closed vocabulary, or a
 * refusal naming the whole set — which was right, and in the wrong place: the
 * table declares `choices` on the field now, so `readInput` refuses a value
 * outside the set exactly as it refuses every other malformed one AND the
 * generated reference prints the vocabulary. A rule enforced in a handler is
 * a rule no document can be held to.
 *
 * The silent-fallback trap it guarded against is unchanged: a caller's typo
 * must not become a yellow highlight they did not ask for and cannot explain.
 * `checkField` refuses it before any default is applied. */

export function markList(env: ServiceEnvironment) {
  return (req: unknown, ctx: ServiceContext): AsyncIterable<readonly MarkRow[]> => {
    const input = readInput(descriptorOf('mark.list'), req)
    const bookId = str(input, 'book')
    const limit = num(input, 'limit')
    /* An async generator rather than `await`-then-`pages`, because the read
     * itself is the expensive half on a whole-shelf list and the signal has
     * to be honoured before it starts. A `cancel` that arrives while 2 000
     * folders are being read must not be answered by reading all of them. */
    async function* run(): AsyncGenerator<readonly MarkRow[]> {
      if (ctx.signal.aborted) return
      let marks: readonly Mark[]
      if (bookId === undefined) {
        await env.services.marks.loadAll()
        /* BOTH HALVES. The snapshot splits annotations from bookmarks at the
         * one door every subscriber reads through — `all` is annotations
         * only — and they are the same record with a different `kind`. A
         * `mark.list` that read `all` alone would answer "every mark" while
         * silently omitting every bookmark on the shelf. */
        const snapshot = env.services.marks.getSnapshot()
        marks = [...snapshot.all, ...snapshot.allBookmarks]
      } else {
        knownBook(env, bookId)
        marks = liveMarks(await env.services.marks.forBook(bookId))
      }
      /* By book, then by the kernel's OWN comparator. A CFI does not order
       * lexically: two from different spine items address positions in
       * different documents and are not comparable as strings at all, so a
       * `localeCompare` interleaves chapters. `compareMarks` takes the
       * section first — the one part of a mark's position that is a plain
       * number — and leaves the CFI the job it is good at. The id breaks the
       * last tie, so the order is total and two calls agree. */
      const rows = [...marks]
        .sort((a, b) => a.bookId.localeCompare(b.bookId) || compareMarks(a, b) || a.id.localeCompare(b.id))
        .map(markRow)
      yield* pages(rows, ctx.signal, limit)
    }
    return run()
  }
}

export function markAdd(env: ServiceEnvironment) {
  return async (req: unknown): Promise<MarkRow> => {
    const input = readInput(descriptorOf('mark.add'), req)
    const bookId = reqStr(input, 'book')
    knownBook(env, bookId)
    /* Narrowed rather than checked: `choices` on the table's own fields is
     * what refuses anything else, before this runs. */
    const kind: MarkKind = (str(input, 'kind') as MarkKind | undefined) ?? 'highlight'
    const tint: MarkTint = (str(input, 'colour') as MarkTint | undefined) ?? 'yellow'
    /* `style` is not on the wire. It is a drawing decision the reader makes
     * in the app, it means nothing for a bookmark, and `validMarks` settles
     * it per kind on every read — so a caller choosing one here would be
     * choosing something the next read may overrule. */
    const mark = createMark({
      bookId,
      cfi: reqStr(input, 'cfi'),
      /* WHICH SPINE ITEM the anchor is in. Recorded at creation rather than
       * derived, because deriving it needs foliate's CFI parser, which is the
       * reader's and not the kernel's — and a mark whose section is wrong is
       * never offered to the overlay for the section it is actually in, so it
       * never draws. Defaulting to 0 is right for a single-document book and
       * wrong for every other; a caller that knows says so. */
      sectionIndex: num(input, 'section') ?? 0,
      text: str(input, 'text') ?? '',
      /* From the wire since phase 19; empty when the caller did not know. See
       * the table row — a mark with no context is one that cannot be found
       * again once its CFI stops resolving. */
      prefix: str(input, 'prefix') ?? '',
      suffix: str(input, 'suffix') ?? '',
      note: str(input, 'note') ?? '',
      kind,
      tint,
      style: 'fill',
      chapter: str(input, 'chapter') ?? '',
    })
    await env.services.marks.add(mark)
    return markRow(mark)
  }
}

export function markSet(env: ServiceEnvironment) {
  return async (req: unknown): Promise<MarkRow> => {
    const input = readInput(descriptorOf('mark.set'), req)
    const id = reqStr(input, 'mark')
    const bookId = str(input, 'book')
    const note = str(input, 'note')
    /* THE TABLE ENFORCES BOTH NOW. `colour`'s vocabulary is `choices` on the
     * field and "note or colour" is `atLeastOne` on the row, so `readInput`
     * refuses either the way it refuses every other malformed body — and the
     * generated reference prints both, which a rule living here could not. */
    const colour = str(input, 'colour') as MarkTint | undefined
    /* One mutator per field, each stamping its own edit, rather than one
     * rewrite of the row: the stamp is what makes the change merge as newer
     * on a peer, and a record rewritten past it replicates as an edit with no
     * stamp — which loses to everything. */
    if (note !== undefined) await env.services.marks.updateNote(id, note, bookId)
    if (colour !== undefined) await env.services.marks.setTint(id, colour, bookId)
    return markRow(await locate(env, id, bookId))
  }
}

export function markRemove(env: ServiceEnvironment) {
  return async (req: unknown): Promise<RemovedRow> => {
    const input = readInput(descriptorOf('mark.remove'), req)
    const id = reqStr(input, 'mark')
    const bookId = str(input, 'book')

    /* ASKED FIRST WHEN THE BOOK IS NAMED, because the store cannot answer it
     * afterwards. `remove(id, book)` routes by the HINT: given a book it
     * accepts that book as the owner without checking the mark is in it, and
     * the mutation then returns its input by identity — no write, no
     * rejection, and `removed: true` for a mark that never existed. The read
     * is on that book's queue, so it is ordered against its writes. */
    if (bookId !== undefined) {
      knownBook(env, bookId)
      const held = await env.services.marks.forBook(bookId)
      if (!held.some((one) => one.id === id && one.deletedAt === undefined)) return { id, removed: false }
      await env.services.marks.remove(id, bookId)
      return { id, removed: true }
    }

    try {
      await env.services.marks.remove(id)
    } catch (error) {
      /* ONLY "the store does not know this mark" is an absence — the exact
       * rejection it raises for an id nothing knows, which is the honest
       * answer to removing what is not there. A disk failure, a permission
       * error or a queue rejection reaches the same `catch`, and reporting
       * THOSE as `removed: false` tells a caller their mark is gone while it
       * is still on disk. Everything else is rethrown, and the envelope turns
       * it into a refusal the caller can see. */
      if (error instanceof Error && error.message === `no mark ${id} is known to the store`) return { id, removed: false }
      throw error
    }
    return { id, removed: true }
  }
}

/**
 * A mark by id, after a write.
 *
 * THE ORDER IS THE POINT, and it is a cost question. `loadAll` is one read
 * per book — on the 1 959-book library WI-8.6 measured, that is two thousand
 * filesystem round trips — so it is the LAST resort rather than the first.
 * The book, when the caller named one, is one read; the store's held snapshot
 * is none at all, and the write that just succeeded proves the store knew the
 * mark, so in practice the snapshot answers.
 *
 * Both halves of the snapshot are searched: `all` is annotations and
 * `allBookmarks` is the rest, and a bookmark's note is as editable as a
 * highlight's.
 */
async function locate(env: ServiceEnvironment, id: string, bookId: string | undefined): Promise<Mark> {
  if (bookId !== undefined) {
    const inBook = (await env.services.marks.forBook(bookId)).find((one) => one.id === id)
    if (inBook) return inBook
  }
  const held = env.services.marks.getSnapshot()
  const known = [...held.all, ...held.allBookmarks].find((one) => one.id === id)
  if (known) return known
  await env.services.marks.loadAll()
  const loaded = env.services.marks.getSnapshot()
  const anywhere = [...loaded.all, ...loaded.allBookmarks].find((one) => one.id === id)
  if (!anywhere) throw refuse(SERVICE_ERRORS.notFound, `no mark ${id}`)
  return anywhere
}
