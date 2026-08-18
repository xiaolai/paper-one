/**
 * A tag's identity and its stored spelling — the two rules everyone who
 * writes, reads or merges a reader's tag has to share.
 *
 * Its own module, and a small one, because `bookFolder.ts` needs `tagKey`
 * to validate a record's tag clock on the way in (each entry is keyed by
 * `tagKey(spelling)`, and an entry keyed by anything else would give one tag
 * two registers), while `library.ts` — where these lived — reaches
 * `bookIndex`, which reaches `bookFolder`. Moving the two functions is what
 * keeps that a line rather than a loop. `library.ts` re-exports them, so
 * every caller it had still has them.
 */

/**
 * The identity of a tag, as opposed to its spelling.
 *
 * `Philosophy` and `philosophy` are ONE tag. Three steps, each earning its place:
 *
 *   trim         — a trailing space is not a different subject.
 *   NFC          — `Café` typed on macOS is decomposed (e + combining acute) and
 *                  the same word pasted from elsewhere is composed. They render
 *                  identically and compare unequal, which is the worst kind of
 *                  duplicate because nothing on screen can explain it.
 *   toLowerCase  — case-fold.
 *
 * NFC BEFORE lowercasing: lowercasing can change which decompositions apply, so
 * normalising second leaves the two forms of `Café` folding to different keys.
 *
 * The DISPLAY spelling is never this — it is whatever the reader first typed,
 * kept on the book. This is only ever the key.
 */
export function tagKey(tag: string): string {
  return tag.trim().normalize('NFC').toLowerCase()
}

/** The longest a reader's tag may be. Kept here so the field and the store
 *  enforce one number rather than two that could disagree. */
export const TAG_MAX = 60

/**
 * A tag as it will be STORED: trimmed and cut to `TAG_MAX`. Empty when nothing
 * is left.
 *
 * ONE FUNCTION, called by everyone who writes a tag AND by everyone who then
 * refers to it. The store trimmed and truncated on the way in while the panel
 * put the reader's raw text into the query — so a 70-character rename left the
 * shelf scoped to a tag that had never been written, and the view emptied
 * with nothing to say why. Whoever writes the tag and whoever names it must
 * agree, and they agree by calling this.
 */
export function normalizeTag(raw: string): string {
  return raw.trim().slice(0, TAG_MAX)
}
