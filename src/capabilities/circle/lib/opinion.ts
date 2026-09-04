import { compareEntries } from '../../../kernel'
import type { BookRecord, Hlc, ReadingState, Stars } from '../../../kernel'
import { nextSeqFor, type OpinionRow, type ReviewRow, type SharedFile, MAX_TAGS } from './publish'

/**
 * What the reader thinks of a book, published — WI-23.B4's deciding half.
 *
 * The reader's opinion lives on the record (`status`, `rating`, `review`,
 * `tags` — WI-23.B3) and replicates by the ordinary sync. Publishing it is a
 * SEPARATE act: with the book's switch on, this turns the record's current
 * opinion into the entries the circle log needs, and only the ones that say
 * something new.
 *
 * ## Registers say the newest thing; a review is a publication
 *
 * `status`, `rate` and `tag` are last-writer registers on the wire, so
 * publishing one again with the same value is noise a recipient would fold
 * away — and a page a friend has to fetch for nothing. Each is emitted only
 * when it differs from what was last published. A review is a snapshot at
 * publication: editing it is `unreview` + `review`, two entries and a new
 * `pub`, because a signed entry cannot be rewritten in place.
 *
 * PURE. The caller supplies the record, the device, the stamp and the ids.
 */

/** The opinion as it stands — on the record, or as last published. */
export interface Opinion {
  readonly status?: ReadingState
  readonly stars?: Stars
  /** Sorted, so two orderings of one set are one opinion. */
  readonly tags: readonly string[]
  /** `''` is no review — on the record a review taken back, on the log none live. */
  readonly review: string
}

/** The opinion a record holds right now. */
export function opinionOf(record: Pick<BookRecord, 'status' | 'rating' | 'tags' | 'review'>): Opinion {
  return {
    ...(record.status === undefined ? {} : { status: record.status.state }),
    ...(record.rating === undefined ? {} : { stars: record.rating }),
    /* At most the wire's limit, so a shelf with a thousand tags publishes a
       register every recipient reads rather than a page every recipient
       refuses. The first by sort order, which is a rule two devices share. */
    tags: [...(record.tags ?? [])].sort().slice(0, MAX_TAGS),
    review: record.review?.text ?? '',
  }
}

/**
 * The opinion the store has published — the newest row of each register by
 * stamp, and the one review still out.
 *
 * ⚠️ **BY STAMP, NOT BY POSITION IN THE LIST**, for `fold`'s reason: two of
 * the reader's devices are two streams, and the rows of one file may hold
 * both once the publisher's store syncs. The newest stamp is the newest word.
 */
export function publishedOpinion(held: SharedFile): Opinion {
  let status: (OpinionRow & { readonly op: 'status' }) | undefined
  let rate: (OpinionRow & { readonly op: 'rate' }) | undefined
  let tag: (OpinionRow & { readonly op: 'tag' }) | undefined
  /* `compareEntries`, not the stamp alone: two devices can stamp alike, and
     a tie broken by position in the file is a tie two replicas break two
     ways. Device and sequence decide it the same way everywhere. */
  for (const row of held.opinions) {
    if (row.op === 'status' && (status === undefined || compareEntries(row, status) > 0)) status = row
    if (row.op === 'rate' && (rate === undefined || compareEntries(row, rate) > 0)) rate = row
    if (row.op === 'tag' && (tag === undefined || compareEntries(row, tag) > 0)) tag = row
  }
  const live = liveReview(held)
  return {
    ...(status === undefined ? {} : { status: status.state }),
    ...(rate === undefined ? {} : { stars: rate.stars }),
    tags: tag === undefined ? [] : [...tag.tags].sort(),
    review: live?.text ?? '',
  }
}

/** Every review still out — more than one when two devices each published. */
export function liveReviews(held: SharedFile): readonly ReviewRow[] {
  return held.reviews.filter((row) => row.unreviewed === undefined)
}

/** The review still out, or null — the NEWEST by stamp, however the rows are ordered. */
export function liveReview(held: SharedFile): ReviewRow | null {
  let live: ReviewRow | null = null
  for (const row of liveReviews(held)) {
    if (live === null || compareEntries(row, live) > 0) live = row
  }
  return live
}

const sameTags = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((one, i) => one === b[i])

/**
 * Publish what changed. The store to write back, or the same store when
 * nothing did — a caller writes only when the answer is a different object.
 *
 * ⚠️ **NOTHING IS PUBLISHED FOR AN OPINION THE READER HAS NOT GIVEN.** A
 * record with no rating emits no `rate`; a record with no tags emits no `tag`
 * unless tags were published before and have since been cleared, because
 * "no tags" is then a change and not a silence. The falsifier is a count: with
 * the switch off, zero rows; with it on, one row per changed register.
 */
export function republish(
  held: SharedFile,
  now: Opinion,
  device: string,
  at: Hlc,
  mintPub: () => string,
): SharedFile {
  const was = publishedOpinion(held)
  let next = held
  const stamped = () => ({ device, seq: nextSeqFor(next, device), at })

  if (now.status !== undefined && now.status !== was.status) {
    next = { ...next, opinions: [...next.opinions, { op: 'status', state: now.status, ...stamped() }] }
  }
  if (now.stars !== undefined && now.stars !== was.stars) {
    next = { ...next, opinions: [...next.opinions, { op: 'rate', stars: now.stars, ...stamped() }] }
  }
  /* Tags differ, in either direction: a first tag, a change, or the last
     one removed — an empty list published over a non-empty one is how the
     removal reaches a friend. Nothing said and nothing to say is the same
     empty list, so no row is written for it. */
  if (!sameTags(now.tags, was.tags)) {
    next = { ...next, opinions: [...next.opinions, { op: 'tag', tags: now.tags, ...stamped() }] }
  }
  if (now.review !== was.review) {
    /* Taken back first — a review is edited as a withdrawal plus a new
       publication, never rewritten in place. EVERY live one: two devices can
       each have published, and a change made here supersedes them all. */
    let seq = nextSeqFor(next, device)
    const gone = new Map<ReviewRow, { readonly seq: number; readonly at: Hlc }>()
    for (const live of liveReviews(next)) gone.set(live, { seq: seq++, at })
    // Stryker disable next-line ConditionalExpression,EqualityOperator: with nothing to take back the map copies the rows unchanged, and the publication that follows replaces the list anyway.
    if (gone.size > 0) {
      next = { ...next, reviews: next.reviews.map((row) => (gone.has(row) ? { ...row, unreviewed: gone.get(row)! } : row)) }
    }
    if (now.review !== '') {
      next = { ...next, reviews: [...next.reviews, { pub: mintPub(), text: now.review, ...stamped() }] }
    }
  }
  return next
}
