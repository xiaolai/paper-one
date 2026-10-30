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
 *   -tag:Abandoned          everything EXCEPT books so tagged
 *   is:reading              only books in flight; also is:unread, is:finished
 *   is:untagged             books carrying no tag of the reader's own
 *   is:reading tag:Sea      both, as you would expect
 *
 * `is:` is the OTHER axis a shelf is organised on — not what a book is about
 * but where the reader is with it — and it lives in the same field for the
 * same reason `tag:` does: what the reader can see is the whole query. The
 * Library panel writes it when a status row is clicked, so clicking there and
 * typing here are one thing. A STATUS is exclusive, since a book has one, so
 * writing a second `is:` status replaces the first rather than narrowing to
 * nothing.
 *
 * `is:untagged` is spelt with the same prefix because it reads as a state of
 * the book — "is untagged" — but it is NOT a status and does not displace one:
 * `is:reading is:untagged` is the books in flight that the reader has not yet
 * filed, which is a real question. Untagged means no tag OF THE READER'S OWN.
 * A book the publisher shelved under three subjects and the reader under none
 * is a book the reader has not organised, and that is what the row exists to
 * find.
 *
 * AND rather than OR, because narrowing is what a reader is doing when they add
 * a second tag. `tag:Sea tag:Classics` asking for everything nautical PLUS
 * everything classical would grow the shelf by adding a word to the query, which
 * is the opposite of what typing more means everywhere else.
 *
 * `-tag:` EXCLUDES, and it composes with everything above: `tag:Sea
 * -tag:Abandoned` is the nautical books not given up on. The minus is the
 * grammar every search box a reader has used agrees on — Gmail, GitHub,
 * Calibre — and it needs no new word to learn. A tag cannot be both required
 * and excluded: the parser resolves a hand-typed contradiction by letting the
 * LAST term win, the same rule `withTag` and `withExcludedTag` apply when they
 * take the other form out. Without that rule `tag:Sea -tag:Sea` was a scope no
 * book could satisfy, and the shelf emptied with both chips lit and nothing to
 * say why.
 */

/**
 * A quoted tag, so a tag with a space in it survives — `tag:"Book club"`.
 *
 * `\"` inside the quotes is a literal quote. Without that the writer had no way
 * to spell a tag containing one and DELETED it instead, producing a query for a
 * different tag — `He said "Hi"` searched for `He said Hi`, which matches
 * nothing. An escape in the grammar is what makes `withTag` able to round-trip.
 *
 * The optional leading `-` is captured, so one pattern reads both the required
 * and the excluded form and the two can never drift apart in what they accept.
 *
 * The `\\?` at the body's end takes a DANGLING BACKSLASH with it: without it,
 * `tag:"abc\` matched only through `abc`, the term was dropped as unterminated,
 * and the stray `\` leaked into the free text — a character the reader typed
 * mid-escape, searched against titles.
 */
const TAG = /(^|\s)(-?)tag:(?:"((?:[^"\\]|\\.)*\\?)("?)|(\S*))/gi

/* The closing quote is OPTIONAL AND CAPTURED, which is what makes a half-typed
 * term behave. Two bugs live here, one after the other:
 *
 * Without the `?` the quoted alternative failed on `tag:"Book club`, the bare
 * `\S*` matched instead, and the reader mid-word was searching for a tag called
 * `"Book` while `club` became free text.
 *
 * With the `?` but nothing capturing it, the same input became an ACTIVE tag
 * `Book club` — a complete, wrong answer applied while they were still typing
 * the tag's name. The fourth group says whether the quote was actually closed,
 * so an unterminated term can be DROPPED, which is what happens to every other
 * incomplete one and what the note on `parseQuery` has always claimed. */

/**
 * `is:reading`, `is:unread`, `is:finished`. No quoting, because the values are
 * a closed set and never contain a space; anything else after `is:` is not a
 * status and is left as text, so a reader typing `is:` has not asked for
 * anything yet — the same rule `tag:` follows for an empty term.
 */
/* ONE LIST, and the type and the regex are both derived from it — and so is
 * `ReadingStatus` in `library.ts`, which aliases `StatusTerm` rather than
 * restating the union. The values were once written four times, and three of
 * the places were silent when a fifth value missed one. This file is where the
 * list lives because the regex needs the literals; the domain type borrows it. */
const STATUSES = ['reading', 'unread', 'finished'] as const
export type StatusTerm = (typeof STATUSES)[number]
const STATUS = new RegExp(`(^|\\s)is:(${STATUSES.join('|')})?(?=\\s|$)`, 'gi')

/* Its own pattern rather than a fourth status, because it is not one:
 * `withStatus` replaces a status and must leave this alone, and the parser
 * reports it as its own flag rather than as the last `is:` to win. */
const UNTAGGED = /(^|\s)is:untagged(?=\s|$)/gi

/** Undo `withTag`'s escaping: `\"` and `\\` become the characters they spell. */
const unescape = (quoted: string): string => quoted.replace(/\\(.)/g, '$1')

/**
 * What one TAG match names.
 *
 * `unterminated` — the reader is still typing a quoted name; `parseQuery`
 * drops the term and `withoutTag` leaves it alone, and the DIFFERENCE is why
 * this returns a kind rather than a nullable string. `empty` is `tag:` with
 * nothing after it. Decoding was written out in both callers and they had to
 * agree on every step — unescape before compare, trim after — which is
 * exactly the kind of agreement that decays.
 */
function matchedTag(
  quoted: string | undefined,
  closed: string | undefined,
  bare: string | undefined,
): { kind: 'unterminated' } | { kind: 'empty' } | { kind: 'tag'; tag: string } {
  if (quoted !== undefined && !closed) return { kind: 'unterminated' }
  const tag = (quoted === undefined ? (bare ?? '') : unescape(quoted)).trim()
  return tag ? { kind: 'tag', tag } : { kind: 'empty' }
}

/**
 * Collapse the whitespace OUTSIDE quoted tag terms, and trim.
 *
 * Removing a term from the middle of a query leaves the space before it beside
 * the space after it — `moby tag:Sea dick` came out as `moby  dick`, which then
 * fails to match a title containing one space. The first cure was a global
 * `\s+` collapse, and it overcured: it also rewrote the whitespace INSIDE a
 * surviving quoted tag, so clearing a status turned `tag:"A  B"` into a query
 * for the different tag `A B`. The alternation matches quoted terms first and
 * hands them back untouched; only the whitespace between terms is collapsed.
 */
const collapse = (raw: string): string =>
  raw
    .replace(/(-?tag:"(?:[^"\\]|\\.)*\\?"?)|\s+/gi, (_match, term: string | undefined) => term ?? ' ')
    .trim()

export interface ParsedQuery {
  /** Tags to restrict to, in the order typed. Deduplicated by key. */
  readonly tags: readonly string[]
  /** Tags to keep OUT — `-tag:Name`. Deduplicated by key. */
  readonly excluded: readonly string[]
  /** The reading status to restrict to, if one was named. Last one wins. */
  readonly status: StatusTerm | null
  /** `is:untagged` — only books with none of the reader's own tags. */
  readonly untagged: boolean
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
 *
 * Within one polarity the FIRST spelling wins — `tag:Sea tag:sea` is one
 * restriction, named the way it was named first. ACROSS polarities the LAST
 * term wins: `tag:Sea -tag:Sea` excludes, `-tag:Sea tag:Sea` requires, because
 * the reader's latest word is the one that stands and a scope requiring what it
 * excludes matches nothing.
 */
export function parseQuery(raw: string, key: (tag: string) => string): ParsedQuery {
  const tags = new Map<string, string>()
  const excluded = new Map<string, string>()
  let status: StatusTerm | null = null
  let untagged = false
  const text = collapse(
    raw
      .replace(UNTAGGED, (_match, lead: string) => {
        untagged = true
        return lead
      })
      .replace(STATUS, (_match, lead: string, value?: string) => {
        // `is:` on its own, or `is:something-else`, is not a status. The bare
        // `is:` is dropped like an empty `tag:`; an unknown value never matched
        // the regex and stays as text, which is the honest reading of it.
        if (value) status = value.toLowerCase() as StatusTerm
        return lead
      })
      .replace(
        TAG,
        (_match, lead: string, minus: string, quoted?: string, closed?: string, bare?: string) => {
          const found = matchedTag(quoted, closed, bare)
          if (found.kind !== 'tag') return lead
          const k = key(found.tag)
          const [into, opposite] = minus ? [excluded, tags] : [tags, excluded]
          // The later term overrides the earlier opposite — see the header.
          opposite.delete(k)
          if (!into.has(k)) into.set(k, found.tag)
          // The leading whitespace is given back, or removing a middle term
          // would join the words on either side of it into one.
          return lead
        },
      ),
  )
  return { tags: [...tags.values()], excluded: [...excluded.values()], status, untagged, text }
}

/**
 * Clear a flag term and, optionally, write a replacement at the front — the
 * one shape `withStatus` and `withUntagged` share. At the front, like
 * `withTag`, so the reader sees what changed.
 */
function withFlag(raw: string, pattern: RegExp, term: string | null): string {
  const cleared = collapse(raw.replace(pattern, (_m, lead: string) => lead))
  if (!term) return cleared
  return cleared ? `${term} ${cleared}` : term
}

/**
 * Set the status term, replacing any that was there — one status at a time.
 * `null` clears it. `is:untagged` is not a status and is left where it is.
 */
export function withStatus(raw: string, status: StatusTerm | null): string {
  return withFlag(raw, STATUS, status && `is:${status}`)
}

/** Set or clear `is:untagged`. Idempotent, like the others. */
export function withUntagged(raw: string, on: boolean): string {
  return withFlag(raw, UNTAGGED, on ? 'is:untagged' : null)
}

/** A tag as a query term: quoted and escaped only when it has to be. */
function tagTerm(tag: string, minus: '' | '-'): string {
  /* Quoted only when it needs to be — `tag:Sea` reads better than `tag:"Sea"`,
   * and the reader is going to see this.
   *
   * A quote inside the tag is ESCAPED. Deleting it, which is what this did,
   * produced a well-formed query for a DIFFERENT tag: `He said "Hi"` came out
   * as `He said Hi`, and the shelf emptied with the chip still showing. The
   * parser now reads `\"`, so the term round-trips. */
  const escaped = tag.replace(/[\\"]/g, (ch) => `\\${ch}`)
  return /[\s"\\]/.test(tag) ? `${minus}tag:"${escaped}"` : `${minus}tag:${tag}`
}

/**
 * Put a tag term into a query the reader can then edit — the one workflow
 * `withTag` and `withExcludedTag` share, differing only in the minus.
 *
 * A tag already present IN THIS FORM is not written twice, so clicking a chip
 * twice is not an error state — unless the OPPOSITE form is also present, in
 * which case the query is rebuilt so the contradiction goes: a tag cannot be
 * both required and excluded, and the reader's latest word is the one that
 * stands.
 */
function withTagTerm(
  raw: string,
  tag: string,
  key: (t: string) => string,
  minus: '' | '-',
): string {
  if (!tag.trim()) return raw
  const { tags, excluded } = parseQuery(raw, key)
  const k = key(tag)
  const present = (minus ? excluded : tags).some((one) => key(one) === k)
  /* TEXTUALLY, not through the parse. The parse resolves a contradiction by
   * last-wins, so `-tag:Sea tag:Sea` reports required-only — and judged by
   * that alone, requiring Sea again returned the string unchanged with the
   * stale `-tag:Sea` still sitting in the field. The field is what the reader
   * reads; a resolved-away term left in it is a term the field is lying about. */
  const opposite = countForms(raw, k, key)[minus ? 'required' : 'excluded'] > 0
  if (present && !opposite) return raw
  const cleared = withoutTag(raw, tag, key)
  const term = tagTerm(tag, minus)
  return cleared ? `${term} ${cleared}` : term
}

/** How many times each FORM of this tag appears in the text — the raw count,
 *  before the parser's last-wins resolution hides the losers. */
function countForms(
  raw: string,
  targetKey: string,
  key: (t: string) => string,
): { required: number; excluded: number } {
  const counts = { required: 0, excluded: 0 }
  for (const match of raw.matchAll(TAG)) {
    const [, , minus, quoted, closed, bare] = match
    const found = matchedTag(quoted, closed, bare)
    if (found.kind !== 'tag' || key(found.tag) !== targetKey) continue
    counts[minus ? 'excluded' : 'required'] += 1
  }
  return counts
}

/**
 * Put a tag into a query the reader can then edit.
 *
 * Used when a chip is clicked, so clicking and typing produce the SAME thing —
 * there is no hidden scope that the text field disagrees with. If the same tag
 * was EXCLUDED, requiring it takes the exclusion out.
 */
export function withTag(raw: string, tag: string, key: (t: string) => string): string {
  return withTagTerm(raw, tag, key, '')
}

/**
 * Keep a tag OUT — `-tag:Name`. The mirror of `withTag`: idempotent, written at
 * the front, and it lifts a requirement on the same tag rather than sitting
 * beside it as a contradiction no book could satisfy.
 */
export function withExcludedTag(raw: string, tag: string, key: (t: string) => string): string {
  return withTagTerm(raw, tag, key, '-')
}

/**
 * Take a tag back out, for the chip that clears it — in EITHER form. A reader
 * lifting a tag from the shelf's scope means the whole of what they said about
 * it, required or excluded; two controls for the two forms would be a
 * distinction nobody clearing a chip is making.
 */
export function withoutTag(raw: string, tag: string, key: (t: string) => string): string {
  const target = key(tag)
  return collapse(
    raw.replace(
      TAG,
      (match, lead: string, _minus: string, quoted?: string, closed?: string, bare?: string) => {
        const found = matchedTag(quoted, closed, bare)
        // An unterminated term is not a tag: nothing to remove, and what the
        // reader is still typing must not be swallowed.
        if (found.kind === 'unterminated') return match
        /* UNESCAPED before comparing, exactly as `parseQuery` does. Comparing
         * the raw text meant the chip for a tag containing a quote matched
         * nothing and could not be cleared — the one tag `withTag` had just
         * learned to write. */
        return found.kind === 'tag' && key(found.tag) === target ? lead : match
      },
    ),
  )
}
