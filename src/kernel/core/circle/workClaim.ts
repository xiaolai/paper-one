import { workKey } from '../workKey'

/**
 * What a build CLAIMS about the work it is — WI-22.C1.
 *
 * ## Why a set, and not `workKey`
 *
 * ⚠️ **`workKey` CANNOT IDENTIFY ONE WORK ACROSS BUILDS, and this repository
 * proves it against itself.** `workKey.test.ts` contains a test named *"keeps
 * the corpus's three builds three different works"* whose own comment reads:
 * *"Three real builds of Moby-Dick declare three unrelated identifiers — a
 * Gutenberg URL, a Standard Ebooks URL and an ISBN — so the key says they are
 * different works, and **it is WRONG**."*
 *
 * `docs/design/circle/wire.md` made one scalar the log key, so two readers of
 * the same book would get two different logs and never meet, by construction —
 * and `workKey` answers `null` for a book declaring no identifier at all, which
 * on the measured shelf was every book before the metadata backfill and 33
 * after it. Those could not have a log.
 *
 * So a work is named by a **claim set**, and two claims are compared by
 * INTERSECTION rather than by equality:
 *
 * | Match | Rule |
 * |---|---|
 * | **strong** | `ids` share at least one element |
 * | **weak** | `language` and `author` equal, **and** `titles` share an element |
 * | **none** | keep the log under its own claim; a later build may bridge it |
 *
 * A build declaring both an ISBN and a `dc:identifier` bridges two populations
 * that would otherwise never meet, and the bridge grows as builds declare more.
 * That is the property a scalar cannot have at any cost.
 *
 * ## `language` is required, and its absence was a correctness bug
 *
 * ⚠️ *Moby-Dick* in English and *Moby-Dick* in Chinese translation share a
 * title, an author and often an identifier — and share no passages at all. A
 * quote from one can never anchor in the other, so merging their logs produces
 * a list of passages guaranteed not to resolve. `phase-21-the-circle.md`
 * required the field; `wire.md` dropped it; it is back.
 *
 * ## Everything but the language is HASHED
 *
 * ⚠️ `review.md`: *"opaque `dc:identifier`s cross verbatim (a licence URL
 * containing an email would too)"*. Matching is equality, and equality survives
 * hashing — so a licence URL carrying an email, a library barcode or a purchase
 * id never crosses the wire, while two peers holding the same identifier still
 * match on it.
 *
 * `language` stays in clear because it is compared against a small closed set
 * and hashing it would buy nothing: an attacker enumerates every BCP-47 subtag
 * in a millisecond.
 *
 * PURE, and browser-safe by construction — string work over strings, no
 * platform binding. The digest is injected rather than imported for that
 * reason: `crypto.subtle` is async and not everywhere, and a module that
 * reached for it would take this whole subtree out of a browser's reach.
 */

/** One work, as a build claims it. Every field but `language` is a digest. */
export interface WorkClaim {
  /** Digests of every identifier the build declares, sorted and deduplicated. */
  readonly ids: readonly string[]
  /**
   * Digests of every spelling of the title this build supports — the full
   * normalised title, and the title proper with any subtitle removed.
   *
   * ⚠️ **A SET, FOR THE REASON `ids` IS ONE, and the corpus proved it.** Two of
   * the three corpus builds title the book *Moby-Dick; or, The Whale* and the
   * third titles it *Moby-Dick*. Compared as one string they are two works, so
   * the weak key failed on exactly the population it exists to serve — the
   * books with no shared identifier.
   */
  readonly titles: readonly string[]
  /** Digest of the normalised author. */
  readonly author: string
  /** BCP-47 primary subtag, lower-case, IN CLEAR. `''` when the book says none. */
  readonly language: string
}

/** How two claims met, or that they did not. */
export type WorkMatch = 'strong' | 'weak' | 'none'

/**
 * The primary language subtag, lower-cased — `en` from `en-GB`, `zh` from
 * `zh-Hans-CN`.
 *
 * ⚠️ **THE PRIMARY SUBTAG AND NOT THE WHOLE TAG.** `en-GB` and `en-US` are one
 * reading population and one set of passages; splitting them would partition
 * every English work by which publisher's spelling convention the OPF happened
 * to name. Chinese is the case that argues the other way — `zh-Hans` and
 * `zh-Hant` are genuinely different text — and it is deliberately not special
 * cased here: the WEAK key is a fallback for books with no identifier, and
 * being slightly too generous there costs a mis-match the strong key would not
 * have made, while being too strict costs the fallback entirely.
 */
export function primaryLanguage(tag: string | undefined): string {
  if (!tag) return ''
  /* Stryker disable next-line StringLiteral: `split` always yields a first element, so the fallback is for the type. */
  const first = tag.trim().toLowerCase().split(/[-_]/u)[0] ?? ''
  return /^[a-z]{2,3}$/u.test(first) ? first : ''
}

/**
 * A title or an author reduced to what two builds can be expected to agree on.
 *
 * ⚠️ **A LEADING ARTICLE IS DROPPED, because cataloguing conventions disagree
 * about it and always have.** One build files *The Whale*, another files
 * *Whale, The*, a third *Whale*. Only English articles are handled, which is a
 * stated limit rather than an oversight: the weak key is already scoped by
 * `language`, so an English rule applied to an English population is not the
 * blunt instrument it would be applied globally.
 *
 * Punctuation and case go for the same reason `canonicalise` drops them in
 * `reanchor.ts` — they are typography, and typography is exactly what differs
 * between two builds of one work.
 */
export function normaliseName(value: string | undefined): string {
  if (!value) return ''
  const folded = value
    .normalize('NFC')
    .toLowerCase()
    /* Punctuation to spaces rather than to nothing: "rock'n'roll" must not
       become one word while "rock 'n' roll" stays three. */
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  /* An article-only title is still a title: `folded` is trimmed, so an
     article is dropped only when a word follows it, and "The" stays "the"
     rather than becoming '' and matching every other such book on the weak
     key. One space, because the fold above collapsed every run to one. */
  return folded.replace(/^(?:the|a|an) /u, '')
}

/**
 * The title with any subtitle removed — *"Moby-Dick; or, The Whale"* to
 * *"Moby-Dick"*.
 *
 * `;` and `:` are the two separators cataloguing conventions use, and a build
 * is free to carry the subtitle or drop it. Both spellings go into `titles`, so
 * a build that carries it still meets one that does not.
 *
 * ⚠️ **THIS OVER-MERGES ON PURPOSE, and the resolver is why that is
 * affordable.** *Dune* and *Dune: Messiah* by one author in one language
 * collide here. What a false weak match costs is that a recipient is offered
 * passages from the wrong volume — and those passages are not in the book they
 * are reading, so `reanchorPass` finds nothing and they stay unplaced and
 * readable. A false NON-match costs the feature outright for every book with no
 * shared identifier.
 *
 * That asymmetry is `workKey`'s own, stated the other way round: *"An equal key
 * is strong evidence; an unequal key is almost no evidence at all."* Being
 * generous here spends a re-anchoring pass; being strict spends the feature.
 */
export function titleProper(raw: string | undefined): string {
  /* ⚠️ **THE RAW TITLE, NOT THE NORMALISED ONE, and the first version took the
   * normalised one — which cannot work.** `normaliseName` replaces every
   * non-alphanumeric run with a space, so `;` and `:` are gone before this
   * could look for them and the cut silently never happened. The whole function
   * returned its input and the corpus went on failing, which is the shape of
   * defect that reads as "the rule does not help" rather than "the rule did not
   * run". */
  if (!raw) return ''
  const cut = raw.search(/[;:]/u)
  /* Stryker disable next-line EqualityOperator: a separator at the very start cuts to '', and the fallback below reads the whole title then, as the other branch would. */
  const head = cut < 0 ? raw : raw.slice(0, cut)
  const folded = normaliseName(head)
  /* A title that starts with a separator, or is nothing but one, keeps its
     whole self. */
  return folded === '' ? normaliseName(raw) : folded
}

/** What a book record offers, narrowed to the four fields a claim reads. */
export interface ClaimSource {
  readonly title?: string
  readonly author?: string
  readonly identifier?: string
  readonly languages?: readonly string[]
}

/**
 * Build a claim from a book record and a digest function.
 *
 * `digest` is injected — see the module header. It must be deterministic across
 * machines, because two peers hash independently and compare the results.
 *
 * ⚠️ **`workKey`'s NORMALISATION IS REUSED FOR THE IDENTIFIER, not replaced.**
 * It already folds an ISBN to its thirteen-digit form and a UUID to a canonical
 * spelling, which is real work and correct; what it could not do was be the
 * only thing in the key. Reusing it means the strong match is as strong as it
 * ever was, and a second normaliser cannot drift from the first.
 */
export function claimFor(book: ClaimSource, digest: (value: string) => string): WorkClaim {
  const key = workKey(book.identifier)
  /* Two spellings: the whole title, and the title proper. Each is normalised
     independently — `titleProper` must see the RAW string to find the
     separator, which is the trap its own header records. */
  const spellings = [...new Set([normaliseName(book.title), titleProper(book.title)])].filter(
    (one) => one !== '',
  )
  return {
    ids: key ? [digest(key.key)] : [],
    titles: spellings.map(digest),
    /* ABSENT STAYS ABSENT. Hashing the empty name gave every authorless book
       one author, and two books with the same title and no author then met
       on the weak key as though they agreed about who wrote them. */
    author: normaliseName(book.author) === '' ? '' : digest(normaliseName(book.author)),
    language: primaryLanguage(book.languages?.[0]),
  }
}

/**
 * How two claims met.
 *
 * ⚠️ **A WEAK MATCH REQUIRES A LANGUAGE, and an empty one never matches.** A
 * book declaring no language is not "the same language as another book that
 * declares none" — it is a book that has told us nothing, and treating two
 * silences as agreement is how an English log and a Chinese one merge into a
 * list of passages that cannot resolve. The strong key still works for such a
 * book; only the fallback is withheld.
 */
export function matchWork(a: WorkClaim, b: WorkClaim): WorkMatch {
  /* ⚠️ **A SHARED IDENTIFIER DOES NOT BRIDGE TWO LANGUAGES.** The header
     names the case: *Moby-Dick* and its Chinese translation share a title, an
     author and often an identifier, and share no passages at all. A strong
     match needs the languages to agree — or one of them to be silent, which
     is a book that has said nothing, not a book that disagrees. */
  if (a.language !== '' && b.language !== '' && a.language !== b.language) return 'none'
  for (const id of a.ids) if (b.ids.includes(id)) return 'strong'
  if (a.language === '' || a.language !== b.language || a.author === '' || a.author !== b.author) return 'none'
  return a.titles.some((title) => b.titles.includes(title)) ? 'weak' : 'none'
}

/**
 * Every string a claim can be indexed by, so a recipient looks up rather than
 * scanning every log it holds.
 *
 * The strong keys are the ids; the weak key is one composite string. A lookup
 * that hits any of them is a candidate, and `matchWork` then decides — the
 * index is allowed to be generous because it is not the answer.
 */
export function indexKeys(claim: WorkClaim): readonly string[] {
  const weak =
    claim.language === ''
      ? []
      : claim.titles.map((title) => `w:${claim.language}:${title}:${claim.author}`)
  return [...claim.ids.map((id) => `s:${id}`), ...weak]
}

/**
 * The claim the SHELF log is served under — WI-23.C1.
 *
 * ⚠️ **A RESERVED CLAIM, NOT A WORK.** The shelf is one log per person rather
 * than per work, but a page carries a claim and is signed over it; this is
 * the one claim `circle.shelf` answers under and `takePages` files a shelf
 * page against. It can meet no real book: a book's ids are digests, sixty-four
 * hex characters, and this one is a word — so `bookVia` never lands a shelf
 * page in a book's folder, and a per-work page can never be passed off as
 * the shelf.
 */
export const SHELF_WORK: WorkClaim = { ids: ['paper.circle.shelf'], titles: [], author: '', language: '' }

/** The prefix a list's reserved claim carries — see `listWork`. */
const LIST_CLAIM = 'paper.circle.list:'

/**
 * The claim a LIST's log is served under — WI-23.E1. Reserved like
 * `SHELF_WORK`, and for its reasons; one per list, so `circle.lists` can
 * answer pages for several lists in one call and the recipient files each
 * under the id its claim names.
 */
export function listWork(listId: string): WorkClaim {
  /* The same rule `listIdOf` reads by, so the two are a round trip: a claim
     built from a name no file should have is refused here, not served. */
  if (!LIST_ID.test(listId)) throw new Error(`list id ${JSON.stringify(listId)} is not a list id`)
  return { ids: [`${LIST_CLAIM}${listId}`], titles: [], author: '', language: '' }
}

/** The list id a claim names, or `null` for a claim that is not a list's. */
export function listIdOf(claim: WorkClaim): string | null {
  const id = claim.ids.length === 1 ? claim.ids[0] : undefined
  if (id === undefined || !id.startsWith(LIST_CLAIM)) return null
  const listId = id.slice(LIST_CLAIM.length)
  /* The same shape a lists request accepts: a minted `pub`, hex, bounded —
     so a claim from a page cannot name a list a request could not ask for,
     nor one whose id is a path. */
  return LIST_ID.test(listId) ? listId : null
}

/** A list id as `mintPub` spells one — and as `parseListsRequest` accepts one. */
export const LIST_ID = /^[0-9a-f]{1,64}$/u
