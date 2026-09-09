import { ANCHOR_PER_TASK } from '../../core/public/bounds'
import {
  cfiFor,
  distinguishable,
  indexText,
  reanchorIn,
  type ForeignPassage,
  type ResolvedCfi,
  type TextIndex,
} from './reanchor'

/**
 * WI-22.A2 — **the pass that makes an unplaced mark reachable.**
 *
 * Phase 21 built the `unplaced` class so a name-matched import could KEEP marks
 * it had nowhere to draw; Marginalia lists one with its jump control disabled
 * and the sentence *"Paper has not found this passage here yet."* This walks the
 * book once and retires that sentence for every mark whose passage is really
 * here.
 *
 * ## What is in this module and what is deliberately not
 *
 * The WALK is here: which sections to visit, in what order, how long to keep
 * going, and what may be concluded from stopping. The WRITE is not — a hit is
 * `marks.place(id, cfi, sectionIndex)`, a store mutation stamped like every
 * other, which the plan states as the item's first constraint:
 *
 * > ⚠️ **A HIT MUST BE A STORE WRITE, NOT A RENDER-TIME DECORATION.** A mark
 * > resolved only in memory is resolved again on every open, and — worse — is
 * > invisible to export, to sync and to the browser client.
 *
 * The CACHE is not here either. `reanchorCache` is pure and says so: *"this
 * decides what may be reused and what must be recomputed. Where the answers
 * live is the caller's."* This module answers what a walk found; the caller
 * decides what to remember and what to write.
 *
 * ## One index per section, not one per mark
 *
 * The loop is section-outer, mark-inner, and it builds `indexText` ONCE per
 * section — that is why `reanchorIn` exists. A cold section is 3.46 ms end to
 * end with 1.76 ms of that in the index, so a mark-outer loop over five marks
 * and forty sections would build 200 indices for 40 documents. Section-outer
 * builds 40.
 *
 * ## ⚠️ It must not run on the reading path
 *
 * `nextStep`'s posture in `enrich.ts` is the precedent — it answers
 * `{ kind: 'idle', why: 'reading' }` and stands down. Forty cold sections is
 * ~139 ms, which is fine as a one-off after an open and is not fine per page
 * turn. Two things here carry that:
 *
 *  - `live()` is asked BEFORE every section, so a book the reader closed, or
 *    turned away from, stops the walk within one section rather than at the
 *    end of the book.
 *  - `breathe()` is awaited BETWEEN sections, so the ~139 ms is spent as forty
 *    3.5 ms pieces with the main thread handed back in between. A pass that
 *    held the thread for 139 ms would drop frames on the open it runs after.
 *
 * Neither is optional and neither has a default that skips: a caller that
 * supplies neither gets a pass that never yields, which is why both are
 * required rather than `?`.
 *
 * ⚠️ **AND THE INNER LOOP YIELDS TOO, WHICH IT DID NOT — WI-26.7.** Yielding
 * between SECTIONS bounds the pass at (marks × one section) rather than at one
 * section, and that was fine while the marks were the reader's own and a
 * handful of friends'. Public annotations are published by strangers with free
 * keys, so the same inner loop is however many a flood published, per section,
 * in one uninterruptible task. `ANCHOR_PER_TASK` is the slice; the count of
 * marks is now a number an attacker chooses and the task length is not.
 */

/** A mark waiting for a home — its passage, and the id the store knows it by. */
export interface PendingMark extends ForeignPassage {
  readonly id: string
}

/** Where a mark was found. `ResolvedCfi`, because `cfiFor` minted it (WI-22.A1). */
export interface Placement {
  readonly id: string
  readonly cfi: ResolvedCfi
  readonly sectionIndex: number
}

export interface PassDeps {
  /** How many spine items the book has. */
  readonly sections: number
  /**
   * The document for one section, or null when there is none to parse.
   *
   * A CFI is a PATH and is valid in any document with the same structure, so
   * this does NOT need the section to be rendered — `section.createDocument()`
   * parses an unopened one. `refuseBookScripts` wraps every one of them, which
   * is what makes the path derived here address the same text the reader sees;
   * `bookScripts.test.ts`'s *"address the same passage by the same path"* is
   * that assertion.
   */
  readonly documentFor: (index: number) => Promise<Node | null>
  /** False the moment this pass's book stops being the open one. Asked before
   *  every section, so a closed book stops the walk rather than finishing it. */
  readonly live: () => boolean
  /** Hand the main thread back. Awaited between sections — see the header. */
  readonly breathe: () => Promise<void>
}

export interface PassOutcome {
  /** Every mark that was found, with the anchor to write. */
  readonly found: readonly Placement[]
  /**
   * The ids walked to the end of the book WITHOUT a hit.
   *
   * ⚠️ **EMPTY UNLESS `complete`, and that is the point of the field.** A miss
   * is only a fact once every section has been looked at; a pass cut short has
   * established nothing about the marks it did not place. Remembering one of
   * those in the cache would answer *"this passage is not in these bytes"* for
   * a book that was never read to the end — a permanent wrong answer bought
   * for one interrupted open. `reanchorCache`'s own header is explicit that
   * `null` means *"this was tried against these exact bytes and the passage is
   * not in them"*, which an incomplete walk cannot say.
   */
  readonly missed: readonly string[]
  /** Whether every section was visited. False when `live()` went false. */
  readonly complete: boolean
  /** How many sections were actually indexed — for the diagnostics log, and so
   *  a caller can tell "walked and found nothing" from "never walked". */
  readonly walked: number
}

const NOTHING: readonly Placement[] = []
const NO_IDS: readonly string[] = []

/* ⚠️ **THE WHOLE-BOOK AMBIGUITY RULE, AND ITS TWO NUMBERS LIVE IN
   `reanchor.ts` NOW.** `AMBIGUITY_MARGIN = 0.2` and `MIN_AGREEMENT = 0.25`
   stood here, byte-identical to that module's `MIN_MARGIN` and
   `MIN_CONFIDENCE` and beside a comment admitting they were the same number
   for the same reason. Nothing held the pair together, so a change to one made
   within-section and across-section selection disagree about one question.
   `distinguishable` is that question, asked once. Found by audit.

   What the rule IS, since this is the module it was written for:
   `reanchor`'s *"ONE CANDIDATE NEEDS NO CONTEXT"* is correct WITHIN a document
   — there is nothing to choose between — and a sweep inherits it as a
   first-hit-wins rule across the book. `docs/design/circle/review.md` states
   the failure exactly: *"wrong context around 'the whale' in section 1,
   matching context in section 20; a first-hit sweep picks section 1 and
   reports confidence."* That is a mark drawn on the wrong words, which is the
   defect the whole phase exists to remove. */

/** One place a passage could be, with the evidence for it. */
interface Candidate {
  readonly cfi: ResolvedCfi
  readonly sectionIndex: number
  readonly agreement: number
}

/**
 * The best two candidates so far, and nothing else.
 *
 * ⚠️ **EVERY MATCHING SECTION USED TO BE KEPT, AND SELECTION LOOKS AT TWO.**
 * The list grew as marks × sections — a number both halves of which a stranger
 * influences — to answer a question that needs the top score and the runner-up.
 * The two kept here are the two `decide` would have sorted to the front, ties
 * included: a candidate equal to the best becomes the RUNNER-UP rather than
 * displacing it, which is what a stable sort does with equal keys. Found by
 * audit.
 */
function keepBest(at: readonly Candidate[], one: Candidate): Candidate[] {
  const [best, next] = at
  if (best === undefined) return [one]
  if (one.agreement > best.agreement) return [one, best]
  if (next === undefined || one.agreement > next.agreement) return [best, one]
  return [...at]
}

/**
 * Which candidate to place a passage at, or null when the book cannot say.
 *
 * ONE candidate is unambiguous by construction: the quote occurs in exactly one
 * section of this build, so there is nowhere else it could be and the context is
 * not needed to choose. `reanchor` has already refused a section where the quote
 * occurs several times with no context agreement, so a candidate that reached
 * here was decided within its own document.
 */
export function decide(candidates: readonly Candidate[]): Candidate | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]!
  const [best, next] = [...candidates].sort((a, b) => b.agreement - a.agreement)
  if (!best || !next) return null
  return distinguishable(best.agreement, next.agreement) ? best : null
}

/**
 * Walk EVERY section for every pending mark, then choose.
 *
 * ⚠️ **THE SENTENCE HERE USED TO SAY THE OPPOSITE OF WHAT THIS DOES, TWICE.**
 * It said the walk stops *"early when all are placed"* — it does not, and
 * cannot: a candidate in section 3 is only the answer once section 20 has been
 * ruled out, which is `AMBIGUITY_MARGIN`'s whole argument. And it said a
 * section that will not parse is *"a section with no hits"* — it is not; a
 * failed load returns `complete: false` immediately, because carrying on would
 * let the caller cache *"this passage is not in these bytes"* for a passage
 * sitting in the one section nobody could read. Both claims described an
 * earlier version and outlived it. Found by audit.
 *
 * What it does: index each section once, offer every still-decidable mark to
 * it, keep the best two candidates per mark, and place a mark only where the
 * book can distinguish one of them. It yields between sections and inside the
 * mark loop, and every outcome after an interrupted walk is `complete: false`
 * with nothing placed.
 */
/**
 * What a walk has learnt so far — carried between sections rather than closed
 * over, so the per-section step can be read on its own.
 */
interface Held {
  /** The best two candidates per mark. See {@link keepBest}. */
  readonly candidates: Map<string, Candidate[]>
  /** Marks some section refused to choose for. Permanent once added. */
  readonly undecidable: Set<string>
}

/**
 * Offer one indexed section to every mark still worth asking about.
 *
 * `false` when the reader closed the book mid-batch — the caller turns that
 * into the one early exit, because an interrupted walk may place nothing.
 */
async function offerSection(
  index_: TextIndex,
  index: number,
  pending: readonly PendingMark[],
  held: Held,
  deps: PassDeps,
): Promise<boolean> {
  let sinceBreath = 0
  for (const mark of pending) {
    /* ⚠️ **A MARK ALREADY REFUSED IS NOT MATCHED AGAIN.** `undecidable` is
       permanent — one section saying *"it might well be here"* settles the
       mark as unplaceable for the whole walk — and every later section still
       ran the full quote search and context scoring for it, then threw the
       answer away. On a flooded book that is the expensive step, repeated for
       marks whose outcome is already fixed. Found by audit. */
    if (held.undecidable.has(mark.id)) continue
    /* ⚠️ **THE COUNT OF MARKS IS A NUMBER A STRANGER CHOOSES.** See the
       header. Asked BEFORE the work for `live()`'s reason: a check afterwards
       still pays for the mark the reader has already navigated away from. */
    sinceBreath += 1
    if (sinceBreath > ANCHOR_PER_TASK) {
      /* ⚠️ **ONE, NOT ZERO — THE MARK ABOUT TO BE DONE IS THIS BATCH'S
         FIRST.** Resetting to zero left the current mark uncounted, so the
         batches were 64 and then 65 for ever after: the bound was off by one
         against the number it is named for, quietly and in the direction of
         more work per task. Found by audit. */
      sinceBreath = 1
      await deps.breathe()
      if (!deps.live()) return false
    }
    const hit = reanchorIn(index_, mark)
    if (hit.kind === 'absent') continue
    /* ⚠️ **A SECTION THAT COULD NOT CHOOSE DISQUALIFIES THE WHOLE MARK.**
       `reanchorIn` used to answer `null` for both "not here" and "here several
       times and the context cannot say which", and this loop skipped both — so
       a section saying *"it might well be here"* contributed NOTHING, and a
       lone candidate from somewhere else then looked unique and got placed.
       The evidence pointing away from the answer was the evidence being
       discarded.

       Refusing the mark outright rather than merely ignoring that section is
       the same posture `decide` takes for a near tie: where the book cannot
       say, an unplaced mark that says so is better than a highlight on the
       likelier of two passages. */
    if (hit.kind === 'ambiguous') {
      held.undecidable.add(mark.id)
      /* Its candidates can never be chosen now, and holding them costs a whole
         book's worth of memory for an answer that is already `null`. */
      held.candidates.delete(mark.id)
      continue
    }
    /* The cfi is composed NOW, while the range's nodes are still in a live
       document. The next section replaces it, and a Range kept across that is
       a pair of references into a document nobody holds. */
    const one = { cfi: cfiFor(index, hit.range), sectionIndex: index, agreement: hit.agreement }
    held.candidates.set(mark.id, keepBest(held.candidates.get(mark.id) ?? [], one))
  }
  return true
}

/**
 * Turn a finished walk into placements and misses.
 *
 * ⚠️ **THIS YIELDS TOO, AND IT USED TO BE THE ONE PLACE THAT DID NOT.**
 * Everything before it is sliced and cancellable because the mark count is a
 * number a stranger chooses — and then every one of those marks was decided in
 * a single synchronous task, holding the main thread for the whole of it and
 * ignoring a reader who had already closed the book. The work per mark is
 * small; the number of them is not, which is the argument the scan already
 * makes. `null` when the reader left mid-batch. Found by audit.
 */
async function chosen(
  pending: readonly PendingMark[],
  held: Held,
  deps: PassDeps,
): Promise<{ found: Placement[]; missed: string[] } | null> {
  const found: Placement[] = []
  const missed: string[] = []
  let sinceBreath = 0
  for (const mark of pending) {
    sinceBreath += 1
    if (sinceBreath > ANCHOR_PER_TASK) {
      sinceBreath = 1
      await deps.breathe()
      if (!deps.live()) return null
    }
    const one = held.undecidable.has(mark.id) ? null : decide(held.candidates.get(mark.id) ?? [])
    if (one) found.push({ id: mark.id, cfi: one.cfi, sectionIndex: one.sectionIndex })
    /* ⚠️ **AMBIGUOUS IS REPORTED AS MISSED, and the two are genuinely
       different questions with one right answer.** "Not in this build" and "in
       two places and the context cannot say which" both mean DO NOT PLACE, and
       both are established facts about these exact bytes — so both are worth
       remembering rather than re-walking on the next open. What must never
       happen is placing one, which is what a first-hit sweep did. */
    else missed.push(mark.id)
  }
  return { found, missed }
}

export async function reanchorPass(
  pending: readonly PendingMark[],
  deps: PassDeps,
): Promise<PassOutcome> {
  /* NOTHING WAITING IS A COMPLETE ANSWER — there is no question to settle. */
  if (pending.length === 0) return { found: NOTHING, missed: NO_IDS, complete: true, walked: 0 }
  /* ⚠️ **A BOOK WITH NO SECTIONS IS NOT A BOOK THAT DOES NOT CONTAIN THESE
   * PASSAGES.** This used to answer `complete: true` with an empty `missed`,
   * which is self-contradictory: it claims every section was looked at while
   * naming none of the still-unplaced marks. A backend with no spine — a PDF, a
   * CBZ — or one whose sections have not been built yet is a book this pass
   * cannot speak about, and `complete: false` is how it says so. */
  if (!Number.isInteger(deps.sections) || deps.sections <= 0) {
    return { found: NOTHING, missed: NO_IDS, complete: false, walked: 0 }
  }

  /* ⚠️ **EVERY SECTION IS WALKED FOR EVERY MARK, and an earlier version of this
   * stopped at the first hit.** Breaking early is only sound if the first hit is
   * the right one, which is exactly what a whole-book sweep cannot assume — see
   * `AMBIGUITY_MARGIN`. The saving it bought was real and the answer it bought
   * was sometimes a mark on the wrong words, and that trade is not close.
   *
   * The plan's cost budget already assumes a full walk: *"a cold section costs
   * 3.46 ms and forty of them ~139 ms; that is fine as a one-off after open"*. */
  const held: Held = { candidates: new Map(), undecidable: new Set() }
  let walked = 0

  /* ⚠️ **AN INTERRUPTED WALK PLACES NOTHING, and it used to place what it had
   * found so far.** With a first-hit rule that was defensible; with the
   * whole-book ambiguity rule it is not — a candidate from section 3 is only
   * the answer once section 20 has been ruled out, and a walk that stopped at
   * section 4 has not ruled out anything. Placing it anyway would put a mark
   * on the wrong words on exactly the opens the reader cut short, which is the
   * hardest kind of defect to see. `cutShort` is the one early exit. */
  const cutShort = (): PassOutcome => ({
    found: NOTHING,
    missed: NO_IDS,
    complete: false,
    walked,
  })

  for (let index = 0; index < deps.sections; index += 1) {
    /* ASKED BEFORE THE WORK, not after: checking afterwards still pays for the
     * section the reader has already navigated away from. */
    if (!deps.live()) return cutShort()
    if (index > 0) await deps.breathe()
    if (!deps.live()) return cutShort()

    let doc: Node | null = null
    try {
      doc = await deps.documentFor(index)
    } catch (cause) {
      /* ⚠️ **A SECTION THAT WOULD NOT LOAD MAKES THE WHOLE PASS INCONCLUSIVE,
       * and it used to be treated as an empty one.** Carrying on and then
       * answering `complete: true` is the worst available outcome: the caller
       * writes `missed` into the cache as a REMEMBERED FAILURE — *"this was
       * tried against these exact bytes and the passage is not in them"* — for
       * a passage that may be sitting in the one section nobody could read. The
       * mark is then never looked for again while it is there, which is a
       * permanent wrong answer bought for one bad section.
       *
       * `enrichOne`'s *"never throws, a failure is a result"* is the right
       * posture for a pass that ENRICHES and the wrong one here, because the
       * two differ in what a gap costs: a book that fails to parse simply keeps
       * the metadata it had, while a section that fails to parse silently
       * changes the meaning of every miss in the book.
       *
       * Still reported rather than swallowed — a section that will not parse is
       * a fact about the book worth one line. */
      console.warn(`Paper: could not read section ${index} while re-anchoring`, cause)
      return cutShort()
    }
    /* ⚠️ **CHECKED AFTER THE AWAIT TOO.** `documentFor` is the slow step —
     * parsing a cold section — and the loop's own check happens before it, so a
     * book closed DURING the last section's load was still indexed and still
     * answered `complete: true`. There is no next iteration to catch it. */
    if (!deps.live()) return cutShort()
    /* A section with no document is a section with no text, not a failure: a
     * spine item a backend does not build (an unstyled cover, a nav document)
     * has nothing to find and says so by answering null rather than throwing. */
    if (!doc) continue

    /* ONCE PER SECTION. See the header — this is the whole reason `reanchorIn`
     * is split out of `reanchor`. */
    const index_ = indexText(doc)
    /* ⚠️ COUNTED HERE, not at the top of the iteration. `walked` is documented
     * as sections actually INDEXED, and incrementing it for a section that was
     * never read made the one field that distinguishes "walked and found
     * nothing" from "never walked" report the first for the second. */
    walked += 1
    if (index_.text === '') continue

    if (!(await offerSection(index_, index, pending, held, deps))) return cutShort()
  }

  const answer = await chosen(pending, held, deps)
  if (answer === null) return cutShort()

  return {
    found: answer.found,
    /* Only now — every section looked at. A walk cut short returns above with
       `complete: false` and an empty `missed`. */
    missed: answer.missed,
    complete: true,
    walked,
  }
}
