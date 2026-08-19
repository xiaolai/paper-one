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
 * Fold a string to the form two spellings of one word share.
 *
 *   NFC             — `Café` typed on macOS is decomposed (e + combining acute)
 *                     and the same word pasted from elsewhere is composed. They
 *                     render identically and compare unequal, which is the worst
 *                     kind of duplicate because nothing on screen can explain it.
 *   lower, UPPER, lower — case-folding, not lowercasing. `toLowerCase` alone
 *                     left `Straße` and `STRASSE` distinct, because ß only
 *                     reaches `ss` through its uppercase form. The first lower
 *                     is what brings capital ẞ along: upper-first left ẞ→ß
 *                     while SS→ss, two keys for one word — lowered first, all
 *                     three spellings meet at `ss`. The round trip is the
 *                     closest JavaScript comes to Unicode case folding without
 *                     a library; its one known deviation is Turkish dotless ı,
 *                     which merges with i — accepted, since a locale-correct
 *                     fold needs a locale nothing here has.
 *   NFC again       — case mapping can denormalise (`İ` lowers to `i` + a
 *                     combining dot), so the fold renormalises what it made.
 *
 * NFC BEFORE the case fold: case mapping can change which decompositions apply,
 * so normalising only afterwards leaves the two forms of `Café` folding apart.
 *
 * Shared by `tagKey` and `matchesQuery`, so a search matches by the same rule
 * tags deduplicate by — it lowercased without normalising, and a decomposed
 * `café` typed into the field missed the composed one in every title.
 */
export const fold = (text: string): string =>
  text.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC')

/**
 * The identity of a tag, as opposed to its spelling.
 *
 * `Philosophy` and `philosophy` are ONE tag: trim — a trailing space is not a
 * different subject — then `fold`.
 *
 * The DISPLAY spelling is never this — it is whatever the reader first typed,
 * kept on the book. This is only ever the key.
 */
export function tagKey(tag: string): string {
  return fold(tag.trim())
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
  /* Normalised BEFORE the cut and cut BY CODE POINT, not by UTF-16 unit.
   * `slice` counts units, so a tag whose sixtieth character was an emoji or
   * any astral-plane letter was cut through the middle of its surrogate pair,
   * storing a lone surrogate no font can draw — and cutting a decomposed
   * string could drop a combining mark off the last letter, so two spellings
   * that fold to one key stored as two different truncations. */
  return [...raw.trim().normalize('NFC')].slice(0, TAG_MAX).join('')
}
