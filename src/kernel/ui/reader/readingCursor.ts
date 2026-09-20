/**
 * Where the voice is in a section, and where a step would take it.
 *
 * The pure half of the transport. It holds no document, no engine and no React
 * state — a plan is two lists of offsets, and every control a reader presses is
 * arithmetic over them. That split is the same one `speech.ts` makes for the
 * follow-along's page decision, and for the same reason: the part that can be
 * wrong is the arithmetic, and arithmetic is testable without a DOM or a voice.
 *
 * ⚠️ **A STEP ANSWERS `null` AT A SECTION'S EDGE RATHER THAN CLAMPING.** Clamping
 * would make "next sentence" on the last sentence do nothing, which reads as a
 * dead button; the reading's answer is to walk into the next section, and only
 * the hook knows how to do that. So the edge is reported, not absorbed.
 */

import type { Span } from './wordSnap/sentenceOf'

export interface ReadingPlan {
  /**
   * Every sentence of the section, in order.
   *
   * CONTIGUOUS AND COVERING, as `sentenceSpansOf` guarantees — which is what
   * makes `sentenceIndexAt` total: every offset in the section is inside exactly
   * one sentence, so a position can always be turned back into a cursor.
   */
  readonly sentences: readonly Span[]
  /** Ascending block starts, from `SpokenText.blocks`. */
  readonly blocks: readonly number[]
}

/** How far a step moves, in whichever unit the caller asked for. */
export type Step = -1 | 1

/**
 * The sentence holding `offset`, or the nearest one when it holds none.
 *
 * Used to turn a position the reader created some other way — a tap, a resumed
 * reading, a jump from the contents — back into a cursor.
 */
export function sentenceIndexAt(plan: ReadingPlan, offset: number): number {
  if (plan.sentences.length === 0) return 0
  /* A linear scan, deliberately. A section holds hundreds of sentences, not
   * millions, and this runs on a button press rather than per word — a binary
   * search here would be a second thing to get wrong for no measurable gain. */
  for (const [at, span] of plan.sentences.entries()) {
    if (offset < span.end) return at
  }
  return plan.sentences.length - 1
}

/**
 * One sentence forward or back, or `null` past the section's edge.
 */
export function stepSentence(plan: ReadingPlan, at: number, by: Step): number | null {
  const next = at + by
  if (next < 0 || next >= plan.sentences.length) return null
  return next
}

/**
 * The block `at`'s sentence begins in, as an index into `plan.blocks`.
 *
 * `-1` for a section with no blocks recorded, which is a section with no text.
 */
export function blockIndexAt(plan: ReadingPlan, at: number): number {
  const start = plan.sentences[at]?.start
  if (start === undefined) return -1
  let found = -1
  for (const [index, block] of plan.blocks.entries()) {
    if (block <= start) found = index
    else break
  }
  return found
}

/**
 * The first sentence of the next or previous paragraph, or `null` past the edge.
 *
 * ⚠️ **BACK GOES TO THE START OF THE CURRENT PARAGRAPH FIRST, AND THAT IS THE
 * CONVENTION RATHER THAN AN OVERSIGHT.** Every audio player's back button
 * restarts the current track before it leaves for the previous one, because a
 * listener who has drifted presses back to hear THIS paragraph again far more
 * often than to hear the one before it. Going straight to the previous paragraph
 * would make re-hearing the current one impossible in one press.
 *
 * Forward has no matching case: a listener never means "the end of this
 * paragraph" by "next paragraph".
 */
export function stepParagraph(plan: ReadingPlan, at: number, by: Step): number | null {
  const here = blockIndexAt(plan, at)
  if (here === -1) return null

  if (by === 1) {
    const nextBlock = plan.blocks[here + 1]
    if (nextBlock === undefined) return null
    const target = sentenceIndexAt(plan, nextBlock)
    /**
     * ⚠️ **A FORWARD STEP MUST ADVANCE, AND THIS RETURNED `at` ITSELF.** A block
     * boundary need not be a sentence boundary: a heading with no full stop
     * leaves one sentence spanning the heading AND the paragraph after it, so
     * the sentence CONTAINING the next block's start is the one already being
     * spoken. Answering it made "next paragraph" cancel the current sentence and
     * speak it again — a button that looks broken because it is.
     *
     * The remaining words of that next paragraph begin at the following
     * sentence, so that is where the step goes. Found by an audit, which also
     * found that `readingCursor.test.ts` asserted the defect as correct.
     */
    if (target > at) return target
    return at + 1 < plan.sentences.length ? at + 1 : null
  }

  const blockStart = plan.blocks[here]
  const sentenceStart = plan.sentences[at]?.start
  /* Not already at the paragraph's first sentence: restart this paragraph. */
  if (blockStart !== undefined && sentenceStart !== undefined && sentenceStart > blockStart) {
    return sentenceIndexAt(plan, blockStart)
  }
  const previousBlock = plan.blocks[here - 1]
  if (previousBlock === undefined) return null
  return sentenceIndexAt(plan, previousBlock)
}
