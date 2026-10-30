/**
 * The bound on a field a work is named by — title, author, identifier,
 * language — and the one way of holding a value to it.
 *
 * ⚠️ **CUT IN ONE PLACE, OR THE CLAIMS DISAGREE.** A work's fields ride a
 * shelf row and a list item, and are hashed into the claim two peers match
 * by. Cut on the list and not on the claim, a book with a long title was
 * placed under a claim made from the whole title and linked back by one made
 * from the cut — so the item read as a book the reader did not have, and a
 * second placement made a duplicate. Cut nowhere on the shelf, a row with a
 * long title was written and then refused by the store's own reader, for
 * ever. Every reader of a field cuts it here, so what is published, what is
 * matched and what is read back are one string.
 */

/** The most characters one field of a work carries. */
export const MAX_WORK_FIELD = 1_024

/** A field within the bound — cut, not refused: it is the book's, not the reader's, and a long title is still that book. Never cut inside a surrogate pair. */
export function cutToField(value: string): string {
  if (value.length <= MAX_WORK_FIELD) return value
  const head = value.slice(0, MAX_WORK_FIELD)
  const last = head.charCodeAt(head.length - 1)
  return last >= 0xd8_00 && last <= 0xdb_ff ? head.slice(0, -1) : head
}

/**
 * The five fields a work is named by, and no other.
 *
 * ⚠️ **THE WIRE ALREADY REFUSES AN EXTRA ONE** (`page.ts`'s `isWork`), so a
 * work with a sixth field can only arrive by somebody editing a file on this
 * disk — which is exactly the case a store's own reader exists for, and the
 * one the received-side parser did not cover.
 */
const WORK_FIELDS = ['title', 'author', 'language', 'identifier', 'cover'] as const

/** BLAKE3, hex — what a cover on a shelf entry is. */
const COVER_DIGEST = /^[0-9a-f]{64}$/u

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Exactly these keys and no others. */
export const hasOnly = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key))

/**
 * A work as it may arrive from somebody else — the right five fields, of the
 * right types, with a cover that is a digest.
 *
 * ⚠️ **AND DELIBERATELY NO LENGTH BOUND, WHICH IS THE HALF THAT LOOKS LIKE THE
 * OMISSION AND IS NOT.** A field that is too long is CUT by whoever publishes
 * it — `cutToField` above says why in its own words — and a peer that did not
 * cut has sent a page this device has already accepted on the wire. Refusing
 * the row here would leave that page accepted and its row unreadable, which is
 * the permanent stall the shelf's own parser warns about from the other side:
 * *"a row with a long title was written and then refused by the store's own
 * reader, for ever."* A stranger's long title costs bytes; a refusal costs the
 * chain.
 *
 * ⚠️ **THREE PARSERS SPELLED THIS OUT, AND THE RECEIVED SIDE WAS THE WEAKEST OF
 * THEM.** `shelf.ts` and `lists.ts` each held key exactness and the bound;
 * `store.ts` — the one reading what other people sent — held neither, which is
 * the wrong way round for a difference nobody had decided on. Found by audit.
 */
export function isReceivedWork(value: unknown): boolean {
  if (!isObject(value) || !hasOnly(value, WORK_FIELDS)) return false
  return (
    typeof value['title'] === 'string' &&
    typeof value['author'] === 'string' &&
    typeof value['language'] === 'string' &&
    (value['identifier'] === undefined || typeof value['identifier'] === 'string') &&
    // Stryker disable next-line ConditionalExpression: a non-string never matches the digest pattern; the type check spells out what the pattern already refuses.
    (value['cover'] === undefined || (typeof value['cover'] === 'string' && COVER_DIGEST.test(value['cover'])))
  )
}

/**
 * A work in a file THIS device writes — the same shape, within the bound.
 *
 * The bound belongs here and not on the receiving side because this is the
 * side that can honour it: everything written here went through
 * {@link cutToField} first, so a field over the bound is this device's own bug
 * and refusing it is how that is found rather than published.
 */
export function isPublishableWork(value: unknown): boolean {
  if (!isReceivedWork(value)) return false
  const named = value as Record<string, unknown>
  return WORK_FIELDS.every((field) => {
    const held = named[field]
    return held === undefined || (typeof held === 'string' && held.length <= MAX_WORK_FIELD)
  })
}
