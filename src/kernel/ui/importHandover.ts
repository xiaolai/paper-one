/**
 * The shelf-writing half of an import: collect copies, hand them over a batch
 * at a time, and settle.
 *
 * # Why this is its own unit
 *
 * Both intake routes — a multi-book drop and a folder walk — grew their own
 * copy of this: a pending array, a `SHELVE_BATCH` threshold, a promise chain,
 * and a final flush. They diverged, and they diverged on the part that
 * matters. Each guarded its handover with the import's generation token, so a
 * SUPERSEDED batch dropped copies it had already made — leaving bytes on disk
 * with no shelf record, which is a book the reader can neither see nor remove.
 * The drop route's `finally` even carried a comment saying this must not
 * happen, three lines above the guard that made it happen.
 *
 * **THERE IS NO TOKEN IN HERE, AND THAT IS THE DESIGN.** A generation token
 * answers "am I still the import the reader is waiting for", which decides
 * what is reported and which book opens. It cannot decide whether finished
 * work is recorded, because the bytes exist either way. Keeping the token out
 * of this file makes that a property of the type rather than a rule each route
 * has to remember — and it is why the two routes cannot drift here again.
 *
 * # Chained, not parallel
 *
 * `shelve` already writes several books at once, so starting a batch per
 * handover would put the whole library in flight together — the defect
 * `addMany` exists to prevent. Each batch waits for the one before it, and
 * `settled()` is what a notice waits on, so "N added" stays a statement about
 * writes that finished rather than writes that were started.
 */

export interface Handover<T> {
  /** Take one finished copy. Hands the batch over once it is full. */
  add(item: T): void
  /** Hand over whatever is pending, however few. */
  flush(): void
  /**
   * Every handover so far, settled, summing what `shelve` returned.
   *
   * Callers await this even when superseded: the writes belong to whoever
   * made the copies, and walking away leaves a chain nothing is holding.
   */
  settled(): Promise<number>
}

export function createHandover<T>(
  size: number,
  shelve: (items: readonly T[]) => Promise<number>,
): Handover<T> {
  let pending: T[] = []
  let chain = Promise.resolve(0)

  const flush = (): void => {
    if (pending.length === 0) return
    const ready = pending
    pending = []
    chain = chain.then(async (sofar) => sofar + (await shelve(ready)))
  }

  return {
    add: (item) => {
      pending.push(item)
      if (pending.length >= size) flush()
    },
    flush,
    settled: () => {
      /* FLUSHED FIRST. A caller that adds a last item and awaits without
       * flushing would otherwise settle a chain that does not contain it —
       * the same "reported before it was written" shape this file exists to
       * remove. */
      flush()
      return chain
    },
  }
}
