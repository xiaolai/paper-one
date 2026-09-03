import { useEffect, useRef } from 'react'
import {
  forgetGeneration,
  keyFor,
  lookUp,
  remember,
  type CacheEntry,
} from '../../core/reanchorCache'
import type { Annotation } from '../../core/marks'
import type { ResolvedCfi } from '../../core/resolvedCfi'
import type { PassOutcome, PendingMark } from '../reader/reanchorPass'

/**
 * WI-22.A2 — **run the re-anchoring pass once per open, and WRITE what it
 * finds.**
 *
 * The host's half. `ReaderSession.reanchorUnplaced` owns the walk because it
 * owns the book; this owns the two things the walk must not: what is worth
 * walking for (the cache), and what happens to a hit (the store).
 *
 * ## Why the write is the whole point
 *
 * > ⚠️ **A HIT MUST BE A STORE WRITE, NOT A RENDER-TIME DECORATION.** A mark
 * > resolved only in memory is resolved again on every open, and — worse — is
 * > invisible to export, to sync and to the browser client, which is the exact
 * > class phase 21 spent three rounds removing.
 *
 * So a hit is `marks.place(id, cfi, sectionIndex)` — a stamped mutation that
 * lands in `marks.json`, travels on the ledger, and survives a relaunch. A
 * reader with imported unplaced marks opens the book and watches them become
 * navigable, which is the thing WI-21.7 promised and could not deliver.
 *
 * ## When it runs, and the two ways it stands down
 *
 * Once per (book, marks-are-read) — NOT per relocation, per render or per page
 * turn. `nextStep`'s posture in `enrich.ts` is the precedent and the plan
 * states the constraint outright: forty cold sections is ~139 ms, *"fine as a
 * one-off after open and not fine per page turn"*.
 *
 * The effect depends on the book id and on `ready`, and on nothing that moves
 * while the reader reads. The `walked` ref is what makes it once-per-open
 * rather than once-per-effect-run: React mounts an effect twice under Strict
 * Mode, and without it every open walked the book twice.
 *
 * ## The cache, and the one thing it must not remember
 *
 * `reanchorCache` is pure and holds nothing; this holds the map, in a ref, for
 * the life of the session. That satisfies the acceptance — *"one whose passage
 * does not exist stays unplaced and is not re-walked on the next open"* —
 * because a second open of the same book finds the miss remembered.
 *
 * ⚠️ **A MISS IS ONLY REMEMBERED FROM A COMPLETE WALK.** `PassOutcome.missed`
 * is empty unless `complete`, and this never invents one: a pass the reader cut
 * short by closing the book has established nothing about the marks it did not
 * reach, and remembering those would answer *"this passage is not in these
 * bytes"* for a book that was never looked at. That is a permanent wrong answer
 * bought for one interrupted open.
 *
 * ⚠️ **NO GENERATION MEANS NO CACHE, NEVER AN UNVERSIONED ONE** — `keyFor`
 * answers null when the book carries no `contentHash`, and a null key here
 * means walk and remember nothing. The cost of missing is a 3.46 ms re-walk;
 * the cost of a stale hit is a mark drawn on the wrong words.
 */

/**
 * What a walk answered.
 *
 * ⚠️ **`PassOutcome` ITSELF, not a structural copy of it, and the copy was a
 * real loss rather than a tidiness question.** This was re-declared here so the
 * hook could be tested without importing the reader — but the module was
 * already imported for `PendingMark`, so the copy bought nothing, and it typed
 * `cfi` as `string` where `PassOutcome` has `ResolvedCfi`. That silently undid
 * WI-22.A1 for the one value that travels from the resolver to the store.
 */
export type WalkResult = PassOutcome

export interface ReanchorDeps {
  /** Walk the open book — `Book.reanchor`, which reads through the navigator
   *  ref and answers an empty incomplete walk before one exists. */
  readonly reanchor: (pending: readonly PendingMark[]) => Promise<WalkResult>
  /**
   * Whether the book is PARSED and its navigator published.
   *
   * ⚠️ **NOT "a section has rendered", which is what this was.** `book.doc` is
   * the obvious signal and it is the wrong one twice over: it changes identity
   * on every section, so depending on it would put the walk on the reading
   * path; and the walk does not need a rendered section at all — it goes
   * through `section.createDocument()`, which parses an unopened one. A book
   * whose first section never produced a document (a backend that does not
   * publish one) would simply never be walked, and a pass that silently never
   * runs looks exactly like a pass that found nothing.
   *
   * `book.meta !== null` is the honest answer: `ReaderSession.#publish` calls
   * `onMeta` and `onNavigator` in the same breath, and `useBook`'s `reset`
   * clears meta on every open — so this is true exactly when there is a
   * navigator to ask.
   */
  readonly parsed: boolean
  /** The open book's id, or null. */
  readonly bookId: string | null
  /**
   * Which OPEN this is — `Book.generation`, bumped by `useBook.open()`.
   *
   * Without it a book closed and reopened is indistinguishable from the same
   * book still open, and an interrupted first pass (which deliberately places
   * and caches nothing) would never be retried. See `settled`.
   */
  readonly openGeneration: number
  /** The open book's `contentHash` — the cache's generation. Absent is legal. */
  readonly contentHash: string | undefined
  /** The open book's marks with no anchor here — `MarksView.unplaced`. */
  readonly unplaced: readonly Annotation[]
  /** Whether this book's marks have been READ. Walking before they have would
   *  walk for an empty list and mark the book done. */
  readonly ready: boolean
  /** The store write. `MarkStore['place']`, through `MarksView`. */
  readonly place: (id: string, cfi: ResolvedCfi, sectionIndex: number, bookId: string) => void
}

export function useReanchor(deps: ReanchorDeps): void {
  const held = useRef<ReadonlyMap<string, CacheEntry>>(new Map())
  /**
   * Which OPEN this session has already settled a walk for.
   *
   * ⚠️ **THE OPEN, NOT THE BYTES — and keying it on the bytes was wrong twice.**
   * The stamp used to be `<bookId>@<contentHash>`, which is a fact about a FILE
   * and not about an attempt:
   *
   *  - Closing a book and reopening it produced the same stamp, so the second
   *    open refused to walk. After an interrupted first open — which places
   *    nothing and caches nothing, deliberately — the marks were then never
   *    looked for again for the life of the session.
   *  - `generation` alone cannot tell two opens apart, so nothing distinguished
   *    "walked this" from "walked this once, and the reader has since come
   *    back". `useBook` bumps its own generation on every `open()`, and that is
   *    the identity of an ATTEMPT.
   *
   * ⚠️ **AND IT IS SET WHEN THE WALK SETTLES, NOT WHEN IT STARTS.** Stamping on
   * entry meant an effect whose cleanup ran mid-walk — a re-render under Strict
   * Mode, a prop change — discarded the result AND left the stamp behind, so
   * the replacement effect saw the book as done and never retried. `running`
   * is what keeps a second effect from starting a duplicate walk in the
   * meantime; `settled` is what says one finished.
   */
  const settled = useRef<string | null>(null)
  const running = useRef<string | null>(null)
  /**
   * Whether this HOOK is still mounted — which is not the same question as
   * whether the effect that started a walk is still the current one.
   *
   * ⚠️ **THE HOLE THE FIRST FIX LEFT, and it makes the pass never complete
   * under Strict Mode.** The walk used to be abandoned on a closure flag set by
   * each effect's cleanup. React mounts an effect, tears it down, and mounts it
   * again: effect 1 starts the walk and sets `running`; its cleanup sets the
   * flag; effect 2 sees the same stamp still `running` and stands down; the
   * walk then finishes, finds its flag false, discards a correct answer, and
   * clears `running` with nobody left to retry. The book is never re-anchored,
   * in exactly the environment every developer runs.
   *
   * The honest question at completion is not *"is the effect that started me
   * still alive"* but *"is this still the book that is open"* — asked of
   * `latest.current`, which every render refreshes — and *"is anyone still
   * here"*, which is this.
   */
  const mounted = useRef(true)
  useEffect(() => {
    /* ⚠️ **SET ON SETUP, NOT ONLY CLEARED ON TEARDOWN — and leaving out the
     * setup reproduced the very bug this ref exists to fix.** Strict Mode runs
     * setup, teardown, setup. A cleanup-only version latched `mounted` false at
     * the first teardown and never restored it, so every walk was discarded
     * from then on: the same silent no-op, arrived at from the other side. The
     * test above went red on exactly this, which is why it is written as
     * "still places what the walk found" rather than as a mount count. */
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  /* The generation each book was last seen at, so a book whose bytes changed
   * can name the generation to forget. See the effect. */
  const seen = useRef<Map<string, string>>(new Map())

  /* Read through a ref so the effect does not depend on them. `unplaced` is a
   * new array identity whenever the store republishes — which a note edit on
   * an unrelated mark does — and depending on it would restart the walk on
   * the reading path, which is the one thing the item forbids. */
  const latest = useRef(deps)
  latest.current = deps

  const { reanchor, parsed, bookId, contentHash, ready, openGeneration } = deps

  useEffect(() => {
    if (!parsed || !bookId || !ready) return
    const generation = contentHash ?? ''
    /* ⚠️ **THE OPEN ALONE, and putting the generation in it was wrong.**
     * `generation` is the library's hash of the file on DISK; the walk reads
     * the book the READER has parsed, which is whatever was loaded at this
     * open. When a backfill or a sync re-hashes a file underneath an open book
     * the two stop describing the same bytes — and a stamp carrying the hash
     * started a fresh walk of the OLD in-memory book, then filed its answers
     * under the NEW hash. Every one of those cache entries is a placement
     * derived from bytes the key does not name, which is the exact defect
     * `contentHash` was chosen as the generation to prevent.
     *
     * The cache is still invalidated below — that must happen the moment the
     * bytes change. What must NOT happen is walking again before the reader has
     * reopened the book, so the stamp names the open and only the open. */
    const stamp = `${openGeneration}:${bookId}`
    if (settled.current === stamp || running.current === stamp) return
    running.current = stamp

    /* ⚠️ **THE BYTES CHANGED, SO EVERY ANSWER ABOUT THEM IS A GUESS** —
     * WI-22.A3. `forgetGeneration` drops by GENERATION and not by mark: a
     * reader who replaces a book with a better scan has the same marks and
     * different bytes, and an entry that survived would place a mark by the old
     * document's geometry — *"phase 21's original defect arriving through the
     * cache"*.
     *
     * ⚠️ **THE GENERATION TO FORGET IS THIS BOOK'S PREVIOUS ONE, and it has to
     * be remembered rather than derived.** The map is keyed `<markId>@<generation>`
     * and carries no book, so "every generation that is not the current one" —
     * which is what the first version of this computed — is ALSO every other
     * book's current generation, and would have emptied the cache for the whole
     * library on each open. `forgetGeneration`'s own header says the opposite is
     * required: *"Entries for OTHER books are untouched: they carry their own
     * generations and a change here says nothing about them."*
     *
     * Naming the previous generation is safe for the reason `contentHash` was
     * chosen as the generation at all: it is BLAKE3 of the WHOLE file, so two
     * different books never share one and dropping by it cannot reach another
     * book's rows. */
    const before = seen.current.get(bookId)
    if (generation !== '') seen.current.set(bookId, generation)
    if (before !== undefined && before !== generation && before !== '') {
      held.current = forgetGeneration(held.current, before)
    }

    /* Still the same open, read from the CURRENT props rather than from this
     * effect's closure — see `mounted`. A book closed, replaced, or navigated
     * away from changes one of these three. */
    const stillHere = (): boolean => {
      const now = latest.current
      return (
        mounted.current &&
        now.bookId === bookId &&
        now.openGeneration === openGeneration &&
        /* The bytes must ALSO still be the ones this walk's answers will be
         * filed under. A re-hash mid-walk means the key would be wrong. */
        (now.contentHash ?? '') === generation
      )
    }

    void (async () => {
      const { unplaced, place } = latest.current
      const pending: PendingMark[] = []
      const keys = new Map<string, ReturnType<typeof keyFor>>()
      for (const mark of unplaced) {
        const key = keyFor(mark, contentHash === undefined ? {} : { contentHash })
        keys.set(mark.id, key)
        const known = key ? lookUp(held.current, key) : undefined
        /* ⚠️ **A REMEMBERED MISS IS SKIPPED; A REMEMBERED PLACEMENT IS
         * RE-PLACED.** This used to skip every cached answer alike, which is
         * right for `null` and wrong for a `Placement`: the mark is in
         * `unplaced` DESPITE a cached hit, so the write that should have moved
         * it did not land — a refused disk, a store that had not loaded. The
         * answer is in hand and costs nothing to reuse, and skipping it left
         * the mark unplaced for the session with the resolution already known.
         *
         * `undefined` and `null` are different answers here, which is the whole
         * cache — `undefined` is "nothing has been tried". */
        if (known === null) continue
        if (known !== undefined) {
          place(mark.id, known.cfi, known.sectionIndex, bookId)
          continue
        }
        pending.push({ id: mark.id, quote: mark.text, prefix: mark.prefix, suffix: mark.suffix })
      }
      if (pending.length === 0) return

      const outcome = await reanchor(pending)
      if (!stillHere()) return

      for (const hit of outcome.found) {
        const key = keys.get(hit.id)
        if (key) {
          held.current = remember(held.current, key, {
            cfi: hit.cfi,
            sectionIndex: hit.sectionIndex,
          })
        }
        place(hit.id, hit.cfi, hit.sectionIndex, bookId)
      }
      /* `missed` is empty unless the walk was complete — enforced by
       * `reanchorPass`, not by this loop remembering to check. */
      for (const id of outcome.missed) {
        const key = keys.get(id)
        if (key) held.current = remember(held.current, key, null)
      }
      /* ⚠️ **SETTLED ONLY ON A COMPLETE WALK, on a book still open.** An
       * incomplete outcome is the pass saying it established nothing — it
       * places nothing and reports no misses — so recording the open as done
       * would retire the question on the strength of an answer nobody gave.
       * That is the same defect as caching a miss from a cut-short walk,
       * one level up, and it is what `openGeneration` exists to let us retry.
       * Every other exit from this function leaves `settled` alone too. */
      if (outcome.complete) settled.current = stamp
    })()
      /* ⚠️ **A REJECTED WALK MUST NOT BE A SILENT DEAD END.** The promise is
       * detached, so without this a throw inside `reanchor` — a renderer torn
       * down mid-parse — surfaced as an unhandled rejection at the window and
       * left the book marked as in-flight for ever, because `running` is only
       * cleared below. Reported, and the attempt released so a later open can
       * try again. */
      .catch((cause: unknown) => {
        console.error('Paper: re-anchoring this book failed', cause)
      })
      .finally(() => {
        if (running.current === stamp) running.current = null
      })
  }, [reanchor, parsed, bookId, contentHash, ready, openGeneration])
}
