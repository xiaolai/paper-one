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
