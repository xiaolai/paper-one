import type { Wanted } from './freshness'

/**
 * The backfill: one book at a time, resumable, and never on the reading path.
 *
 * ## ⚠️ PROGRESS IS PER BOOK AND SURVIVES A QUIT
 *
 * At 1 959 books, **a backfill that begins again never finishes**. What makes
 * this resumable is not a cursor held here — it is that the plugin's
 * `state.json` records each book AFTER the commit that made it searchable, so
 * "what is left to do" is a question asked of the index rather than remembered
 * by the driver. `pending()` is that question, and it is asked once per sweep
 * rather than once per book.
 *
 * ⚠️ **AND A BOOK THAT WOULD NOT READ IS RECORDED, NOT SKIPPED.** Skipped, it
 * comes back in `pending()` on the next sweep and is retried for ever — a loop
 * that costs a parse per book per launch and never makes progress. Recorded, it
 * is named to the reader (WI-31.7) and tried again only when its bytes change.
 *
 * ## It yields, and it stops
 *
 * `reanchorPass`'s posture, for its reasons: a cold section is ~3.5 ms and a
 * forty-section book is ~139 ms, which is fine as forty pieces and is not fine
 * as one task. Both `live()` and `breathe()` are required rather than optional,
 * so a caller that supplies neither gets a sweep that never yields — which is
 * the mistake worth failing loudly on.
 */

/** What the builder does with one book, supplied by the capability. */
export interface BuildDeps {
  /** Every book whose text belongs in the index, most recently read first. */
  readonly wanted: () => readonly Wanted[]
  /** Which of those the index does not already hold at that generation. */
  readonly pending: (books: readonly Wanted[]) => Promise<readonly string[]>
  /**
   * Extract and index ONE book.
   *
   * Resolves `'indexed'` when it went in, `'unreadable'` when the book yielded
   * nothing this build could read (already recorded by the caller), and
   * `'skipped'` when it should simply be tried again later — a book being
   * written to, a reader who closed it mid-walk.
   */
  readonly indexOne: (bookId: string) => Promise<'indexed' | 'unreadable' | 'skipped'>
  /** Take books the shelf no longer wants out of the index. */
  readonly forget: (bookIds: readonly string[]) => Promise<void>
  /** Books the index currently holds — for the removal diff. */
  readonly indexed: () => Promise<readonly string[]>
  /** Commit whatever is pending, so a quit here loses at most one batch. */
  readonly flush: () => Promise<void>
  /** False the moment the sweep should stop. Asked before every book. */
  readonly live: () => boolean
  /** Hand the main thread back. Awaited between books. */
  readonly breathe: () => Promise<void>
}

/** What one sweep did. */
export interface SweepOutcome {
  readonly indexed: number
  readonly unreadable: number
  readonly skipped: number
  readonly forgotten: number
  /** False when `live()` went false — there is more to do. */
  readonly complete: boolean
}

const NOTHING: SweepOutcome = {
  indexed: 0,
  unreadable: 0,
  skipped: 0,
  forgotten: 0,
  complete: true,
}

/**
 * Index every book that is not current, and forget every book that should not
 * be there.
 *
 * ⚠️ **THE REMOVALS GO FIRST.** A sweep interrupted after indexing and before
 * forgetting leaves a removed book searchable until the next sweep — and a
 * reader who evicted a book and immediately searched for it would find it. The
 * other order leaves at worst a book indexed a little later, which nobody can
 * see.
 */
export async function sweep(deps: BuildDeps): Promise<SweepOutcome> {
  if (!deps.live()) return { ...NOTHING, complete: false }

  const wanted = deps.wanted()
  let forgotten = 0
  const held = await deps.indexed()
  const keep = new Set(wanted.map(([bookId]) => bookId))
  const drop = held.filter((bookId) => !keep.has(bookId))
  if (drop.length > 0) {
    await deps.forget(drop)
    forgotten = drop.length
  }
  if (!deps.live()) return { ...NOTHING, forgotten, complete: false }

  const todo = await deps.pending(wanted)
  let indexed = 0
  let unreadable = 0
  let skipped = 0
  for (let at = 0; at < todo.length; at += 1) {
    /* ASKED BEFORE THE WORK. Checking afterwards still pays for the book
     * nobody is waiting for any more — a whole EPUB's worth of parsing. */
    if (!deps.live()) {
      /* ⚠️ **FLUSHED ON THE WAY OUT, so a quit costs at most one batch.** The
       * plugin commits every `BATCH` books on its own; without this, the books
       * between the last batch and the interruption are re-extracted on the
       * next launch, which on a slow book is minutes for nothing. */
      await deps.flush()
      return { indexed, unreadable, skipped, forgotten, complete: false }
    }
    if (at > 0) await deps.breathe()
    if (!deps.live()) {
      await deps.flush()
      return { indexed, unreadable, skipped, forgotten, complete: false }
    }
    const bookId = todo[at]
    if (bookId === undefined) continue
    const outcome = await deps.indexOne(bookId)
    if (outcome === 'indexed') indexed += 1
    else if (outcome === 'unreadable') unreadable += 1
    else skipped += 1
  }
  /* ⚠️ **THE LAST BATCH IS COMMITTED BEFORE THE SWEEP CLAIMS TO BE COMPLETE.**
   * Without it, `complete: true` is a claim about books the index has not yet
   * made durable — and the next launch's `pending()` would disagree with it. */
  await deps.flush()
  return { indexed, unreadable, skipped, forgotten, complete: true }
}
