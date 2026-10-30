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
   *
   * REJECTS ONCE EVERY BATCH HAS HAD ITS TURN, never before. A batch that
   * rejects is counted as wholly unsaved and the chain carries on; the first
   * cause is raised from here, so the caller still hears about the failure
   * without the failure deciding which later books get a record.
   */
  settled(): Promise<number>
}

export function createHandover<T>(
  size: number,
  shelve: (items: readonly T[]) => Promise<number>,
): Handover<T> {
  let pending: T[] = []
  let chain = Promise.resolve(0)
  /* The first batch that would not be shelved, held until every batch behind
   * it has run — see `flush`. */
  let failed: { cause: unknown } | null = null

  const flush = (): void => {
    if (pending.length === 0) return
    const ready = pending
    pending = []
    chain = chain.then(async (sofar) => {
      try {
        return sofar + (await shelve(ready))
      } catch (cause) {
        /* ⚠️ ONE BATCH'S FAILURE IS NOT THE CHAIN'S, and letting it become one
         * produced the exact orphan this file's header says cannot happen, by a
         * second route. `chain.then` on a REJECTED chain never runs its
         * callback — so a single rejected shelf write silently skipped every
         * batch queued behind it, and those books stayed on disk with no record
         * to see or remove them. The token was kept out of here to stop that;
         * a rejection walked around it.
         *
         * The whole batch is counted unsaved because a rejected `shelve` says
         * nothing about which of its books landed, and over-reporting what was
         * lost is the honest direction. The cause is raised by `settled` once
         * every batch has had its turn. */
        if (failed === null) failed = { cause }
        else console.error('Paper: another batch could not be shelved either', cause)
        return sofar + ready.length
      }
    })
  }

  return {
    add: (item) => {
      pending.push(item)
      if (pending.length >= size) flush()
    },
    flush,
    settled: async () => {
      /* FLUSHED FIRST. A caller that adds a last item and awaits without
       * flushing would otherwise settle a chain that does not contain it —
       * the same "reported before it was written" shape this file exists to
       * remove. */
      flush()
      const total = await chain
      if (failed !== null) throw failed.cause
      return total
    },
  }
}
