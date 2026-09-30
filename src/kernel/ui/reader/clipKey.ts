/**
 * What makes two renders of a section the same render.
 *
 * A rendered section is kept on disk and played again, so something has to say
 * when the audio on disk is still the audio this section wants. That is a
 * digest, and the two it takes are here.
 *
 * ⚠️ **A DIGEST AND NOT A TIMESTAMP, AND THE PLAN SAYS WHY.** An mtime would let
 * a book whose text changed play stale audio over changed words, and would throw
 * away a perfectly correct render of a book that was merely re-saved. What is
 * being asked is *does this section still say this*, and only the text can
 * answer it.
 *
 * ⚠️ **AND TWO DIGESTS RATHER THAN ONE, WHICH IS NOT BELT AND BRACES.** They
 * answer different questions:
 *
 * | | over | answers |
 * |---|---|---|
 * | `textDigest` | `indexText`'s CANONICAL form — `passageText.canonicalTextOf` | does the section still say this |
 * | `spokenDigest` | the exact string the engine was handed | do the word offsets still mean what they meant |
 *
 * The canonical one is the plan's requirement, and its reason is agreement: it
 * is the same form phase 31 indexes, so the audio key and the search index
 * cannot disagree about what a section says. The spoken one is needed as well
 * because the canonical walk **collapses whitespace runs and block edges to a
 * single space** — so two documents can share a canonical form and still hand
 * the engine different strings, and then every word offset in the stored
 * timings points at the wrong character. Nothing would throw; the highlight
 * would simply be wrong for the whole chapter.
 *
 * # Why FNV-1a and not SHA-256
 *
 * `crypto.subtle.digest` is one line and unimpeachable, and it is ASYNC — which
 * would make every caller that wants to know whether a clip exists async, for a
 * value that is compared as an opaque string and never verified as a proof. FNV
 * is synchronous, pure, ten lines, and **the same function
 * `tauri-plugin-voices`'s `clips.rs` carries**, so the two halves can be
 * cross-checked against the published vectors rather than trusted.
 *
 * ⚠️ **AND IT IS NOT A SECURITY BOUNDARY, WHICH IS WHAT MAKES THAT ACCEPTABLE.**
 * Nobody is choosing the text adversarially to collide with their own earlier
 * text. What the digest has to survive is the ordinary case — a book re-imported
 * with a corrected typo — and two arbitrary strings colliding on 64 bits plus an
 * exact length match is not a case worth engineering against. If the day comes
 * that it is, the answer is a new prefix: the algorithm is written into the
 * value, so a change makes every stored key miss rather than quietly match.
 *
 * Measured 2026-09-30 in Node 24: 0.5 ms for a median section, 3.8 ms for the
 * character-weighted median, 63 ms at `MAX_SECTION_CHARS`. Against a render that
 * WI-34.0 measured at 315 s, that is free.
 */

/** FNV-1a's 64-bit offset basis. */
const OFFSET = 0xcbf2_9ce4_8422_2325n
/** FNV-1a's 64-bit prime. */
const PRIME = 0x0000_0100_0000_01b3n
/** 2^64 − 1, so the product wraps as the 64-bit function does. */
const MASK = 0xffff_ffff_ffff_ffffn

/**
 * FNV-1a, 64-bit, over bytes.
 *
 * ⚠️ **PINNED AGAINST THE PUBLISHED VECTORS IN THE TEST, NOT TRUSTED.** This is
 * on disk in every clip's name, so a change to it renames every clip a reader
 * has — silently, because a missing file reads as a section that was never
 * rendered. `clips.rs` pins the same three vectors on the Rust side, which is
 * what makes the two implementations one function rather than two.
 */
export function fnv1a64(bytes: Uint8Array): bigint {
  let hash = OFFSET
  for (let at = 0; at < bytes.length; at += 1) {
    hash = ((hash ^ BigInt(bytes[at]!)) * PRIME) & MASK
  }
  return hash
}

/**
 * A digest of some text, as the value stored in a clip's key.
 *
 * `fnv1a64:<characters>:<sixteen hex digits>` — the algorithm named, so a change
 * to it is a change every stored key notices; the LENGTH, because it is free and
 * makes a collision need both a length match and a hash match; and the hash,
 * zero-padded so two digests are the same width and a comparison cannot be
 * fooled by a leading zero going missing.
 *
 * ⚠️ **THE LENGTH IS IN CHARACTERS AND THE HASH IS OVER UTF-8 BYTES**, which are
 * two units on purpose. The characters are what the rest of this reader counts
 * in — `MAX_SECTION_CHARS`, the word offsets, the percentile tables — and the
 * bytes are what makes the hash the same value the Rust half computes.
 */
export function textDigest(text: string): string {
  const bytes = new TextEncoder().encode(text)
  return `fnv1a64:${text.length}:${fnv1a64(bytes).toString(16).padStart(16, '0')}`
}
