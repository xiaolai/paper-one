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
 *   is:reading              only books in flight; also is:unread, is:finished
 *   is:reading tag:Sea      both, as you would expect
 *
 * `is:` is the OTHER axis a shelf is organised on — not what a book is about
 * but where the reader is with it — and it lives in the same field for the
 * same reason `tag:` does: what the reader can see is the whole query. The
 * Library panel writes it when a status row is clicked, so clicking there and
 * typing here are one thing. It is EXCLUSIVE, since a book has one status, so
 * writing a second `is:` replaces the first rather than narrowing to nothing.
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
const TAG = /(^|\s)tag:(?:"((?:[^"\\]|\\.)*)("?)|(\S*))/gi

/* The closing quote is OPTIONAL AND CAPTURED, which is what makes a half-typed
 * term behave. Two bugs live here, one after the other:
 *
 * Without the `?` the quoted alternative failed on `tag:"Book club`, the bare
 * `\S*` matched instead, and the reader mid-word was searching for a tag called
 * `"Book` while `club` became free text.
 *
 * With the `?` but nothing capturing it, the same input became an ACTIVE tag
 * `Book club` — a complete, wrong answer applied while they were still typing
 * the tag's name. The third group says whether the quote was actually closed, so
 * an unterminated term can be DROPPED, which is what happens to every other
 * incomplete one and what the note on `parseQuery` has always claimed. */

/**
 * `is:reading`, `is:unread`, `is:finished`. No quoting, because the values are
 * a closed set and never contain a space; anything else after `is:` is not a
 * status and is left as text, so a reader typing `is:` has not asked for
 * anything yet — the same rule `tag:` follows for an empty term.
 */
/* ONE LIST, and the type and the regex are both derived from it. The values
 * were written three times — in the pattern, in the type, in an array — and
 * a fourth time as `ReadingStatus` in `library.ts`; four places to add
 * `abandoned` to, and three of them silent when missed. */
const STATUSES = ['reading', 'unread', 'finished'] as const
export type StatusTerm = (typeof STATUSES)[number]
const STATUS = new RegExp(`(^|\\s)is:(${STATUSES.join('|')})?(?=\\s|$)`, 'gi')

/** Undo `withTag`'s escaping: `\"` and `\\` become the characters they spell. */
const unescape = (quoted: string): string => quoted.replace(/\\(.)/g, '$1')

export interface ParsedQuery {
  /** Tags to restrict to, in the order typed. Deduplicated by key. */
  readonly tags: readonly string[]
  /** The reading status to restrict to, if one was named. Last one wins. */
  readonly status: StatusTerm | null
  /** Everything that was not a `tag:` or `is:` term, for the text matcher. */
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
  let status: StatusTerm | null = null
  const text = raw
    .replace(STATUS, (_match, lead: string, value?: string) => {
      // `is:` on its own, or `is:something-else`, is not a status. The bare
      // `is:` is dropped like an empty `tag:`; an unknown value never matched
      // the regex and stays as text, which is the honest reading of it.
      if (value) status = value.toLowerCase() as StatusTerm
      return lead
    })
    .replace(TAG, (_match, lead: string, quoted?: string, closed?: string, bare?: string) => {
      // Opened and not closed: the reader is still typing the name. Dropped,
      // like `tag:` on its own, rather than applied as though they had finished.
      if (quoted !== undefined && !closed) return lead
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
  return { tags, status, text }
}

/**
 * Set the status term, replacing any that was there — one status at a time.
 * `null` clears it. Written at the front, like `withTag`, so the reader sees
 * what changed.
 */
export function withStatus(raw: string, status: StatusTerm | null): string {
  const cleared = raw.replace(STATUS, (_m, lead: string) => lead).replace(/\s+/g, ' ').trim()
  if (!status) return cleared
  return cleared ? `is:${status} ${cleared}` : `is:${status}`
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
    .replace(TAG, (match, lead: string, quoted?: string, closed?: string, bare?: string) => {
      // An unterminated term is not a tag, so there is nothing here to remove.
      if (quoted !== undefined && !closed) return match
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
