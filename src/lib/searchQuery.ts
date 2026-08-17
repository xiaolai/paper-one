/**
 * The search field parses `tag:` out of what the reader typed.
 *
 * This is what replaced collections. A collection was a saved scope; a tag
 * already persists and already scopes, so the only thing missing was a way to
 * SAY which tags — and a text field says it better than hidden state, because
 * what the reader can see is the whole query. It can be edited, corrected,
 * copied out and pasted back.
 *
 *   whales                  every book
 *   tag:Sea whales          inside one tag
 *   tag:Sea tag:Classics    inside both — AND, not OR
 *
 * AND rather than OR, because narrowing is what a reader is doing when they add
 * a second tag. `tag:Sea tag:Classics` asking for everything nautical PLUS
 * everything classical would grow the shelf by adding a word to the query, which
 * is the opposite of what typing more means everywhere else.
 */

/**
 * A quoted tag, so a tag with a space in it survives — `tag:"Book club"`.
 *
 * `\"` inside the quotes is a literal quote. Without that the writer had no way
 * to spell a tag containing one and DELETED it instead, producing a query for a
 * different tag — `He said "Hi"` searched for `He said Hi`, which matches
 * nothing. An escape in the grammar is what makes `withTag` able to round-trip.
 */
const TAG = /(^|\s)tag:(?:"((?:[^"\\]|\\.)*)"?|(\S*))/gi

/* The closing quote is OPTIONAL, which is what makes a half-typed term behave.
 * Without the `?` the quoted alternative simply failed on `tag:"Book club`, the
 * bare `\S*` matched instead, and the reader mid-word was searching for a tag
 * literally called `"Book` while `club` became free text — a shelf emptying
 * under their hands for a reason nothing on screen could explain. Now it is one
 * unterminated tag term, which `parseQuery` drops like any other incomplete one. */

/** Undo `withTag`'s escaping: `\"` and `\\` become the characters they spell. */
const unescape = (quoted: string): string => quoted.replace(/\\(.)/g, '$1')

export interface ParsedQuery {
  /** Tags to restrict to, in the order typed. Deduplicated by key. */
  readonly tags: readonly string[]
  /** Everything that was not a `tag:` term, for the text matcher. */
  readonly text: string
}

/**
 * Split a query into its tags and its text.
 *
 * Unterminated or empty terms are DROPPED rather than treated as text: a reader
 * midway through typing `tag:` has not asked for anything yet, and matching the
 * literal string "tag:" against titles would empty the shelf under their hands.
 * That is why the bare form matches `\S*` and not `\S+` — the plus refused to
 * match `tag:` at all, so it survived as text and did exactly that.
 */
export function parseQuery(raw: string, key: (tag: string) => string): ParsedQuery {
  const tags: string[] = []
  const seen = new Set<string>()
  const text = raw
    .replace(TAG, (_match, lead: string, quoted?: string, bare?: string) => {
      const tag = (quoted === undefined ? (bare ?? '') : unescape(quoted)).trim()
      if (tag) {
        const k = key(tag)
        if (!seen.has(k)) {
          seen.add(k)
          tags.push(tag)
        }
      }
      // The leading whitespace is given back, or removing a middle term would
      // join the words on either side of it into one.
      return lead
    })
    /* Runs of space collapsed, because removing a term from the MIDDLE leaves
     * the space before it and the space after it side by side — `moby tag:Sea
     * dick` came out as `moby  dick`, which then fails to match a title
     * containing a single space. */
    .replace(/\s+/g, ' ')
    .trim()
  return { tags, text }
}

/**
 * Put a tag into a query the reader can then edit.
 *
 * Used when a chip is clicked, so clicking and typing produce the SAME thing —
 * there is no hidden scope that the text field disagrees with. A tag already
 * present is not added twice, so clicking a chip twice is not an error state.
 */
export function withTag(raw: string, tag: string, key: (t: string) => string): string {
  const { tags } = parseQuery(raw, key)
  if (tags.some((one) => key(one) === key(tag))) return raw
  if (!tag.trim()) return raw
  /* Quoted only when it needs to be — `tag:Sea` reads better than `tag:"Sea"`,
   * and the reader is going to see this.
   *
   * A quote inside the tag is ESCAPED. Deleting it, which is what this did,
   * produced a well-formed query for a DIFFERENT tag: `He said "Hi"` came out
   * as `He said Hi`, and the shelf emptied with the chip still showing. The
   * parser now reads `\"`, so the term round-trips. */
  const escaped = tag.replace(/[\\"]/g, (ch) => `\\${ch}`)
  const term = /[\s"\\]/.test(tag) ? `tag:"${escaped}"` : `tag:${tag}`
  return raw.trim() ? `${term} ${raw.trim()}` : term
}

/** Take a tag back out, for the chip that clears it. */
export function withoutTag(raw: string, tag: string, key: (t: string) => string): string {
  const target = key(tag)
  return raw
    .replace(TAG, (match, lead: string, quoted?: string, bare?: string) => {
      /* UNESCAPED before comparing, exactly as `parseQuery` does. Comparing the
       * raw text meant the chip for a tag containing a quote matched nothing and
       * could not be cleared — the one tag `withTag` had just learned to write. */
      const found = (quoted === undefined ? (bare ?? '') : unescape(quoted)).trim()
      return found && key(found) === target ? lead : match
    })
    /* Collapsed, for the same reason `parseQuery` collapses: removing a term
     * from the MIDDLE leaves the space before it beside the space after it, and
     * `moby tag:Sea dick` came back as `moby  dick` — which then fails to match
     * a title containing one space. */
    .replace(/\s+/g, ' ')
    .trim()
}
