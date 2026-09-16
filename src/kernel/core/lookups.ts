/**
 * Lookups — the words a reader asked Paper to define (phase 17, WI-17.1).
 *
 * NOT A MARK, and that is the decision this file exists to keep. A mark is
 * CFI-anchored, per-occurrence, per-book, drawn, and carried in the sync feed.
 * A lookup is a TERM: a reader looks up `counsel` once and means it across
 * every book they read. As a `MarkKind` it would write an undrawable row into
 * each book's marks file per press, and every one of them would travel.
 *
 * NOT A CARD EITHER. §15 draws the line — a note is what you wrote, a card is
 * what you made — and it applies here unchanged: history is what you looked up,
 * a card is what you decided to keep. History accrues by itself and is
 * disposable; `cardFromLookup` is the gesture that turns one into the other.
 *
 * ## Keyed by term, holding occurrences
 *
 * The same word in two sentences is two senses, and a vocabulary notebook keeps
 * both — so a record is one term with the places it was met, newest first.
 *
 * ## The stamps are in before anything merges
 *
 * `cards.ts` shows the shape and the reason: a deletion that leaves no row
 * cannot travel, and a replica still holding the term would put it back.
 * Adding stamps later means migrating every reader's history. `mergeLookups` is
 * written and tested; NOTHING CALLS IT — whether lookups sync is the lexicon's
 * phase, and this makes the merge possible rather than deciding it.
 */

import type { NewCard } from './cards'
import { compareHlc, hlcOf, isHlc, laterHlc, type Hlc } from './hlc'

export const LOOKUPS_STORAGE_KEY = 'paper.lookups.v1'

/**
 * How many terms are kept, and how many places each.
 *
 * STATED TO THE READER beside the list rather than silently truncating — the
 * Dictionary view prints both numbers. Sized against WHERE THIS LIVES: the flat
 * store is one JSON file (`fileStore.ts`) that also holds the cards and the
 * settings, rewritten whole on every flush. A place is a sentence (bounded at a
 * thousand characters by `sentenceOf`) and a one-or-two-sentence definition, so
 * five hundred terms at three places each is a file measured in hundreds of
 * kilobytes at its very worst, and far less for ordinary words in ordinary
 * sentences.
 *
 * OLDEST-TOUCHED OUT FIRST: a reader moving through a book returns to the words
 * they looked up recently, not to chapter one's.
 */
export const MAX_LOOKUP_TERMS = 500
export const MAX_OCCURRENCES = 3

/**
 * Bounds a STORED row is held to on the way in — a trust boundary, not a
 * product limit. Generous, because what the app writes is already bounded
 * tighter upstream (`termVerdict`, `sentenceOf`, `MAX_GLOSS_TOKENS`); these
 * exist so a hand-edited or damaged file cannot carry a megabyte in one field.
 *
 * ⚠️ **AND ON THE WAY OUT, SINCE THE 2026-09-13 AUDIT.** `recordLookup` held a
 * place to three of these rules and the read to all of them, so a place the
 * write accepted — a negative time, or a chapter label past its bound, which
 * comes straight out of a book's own metadata — was reported saved and dropped
 * by the next launch. Both doors now go through `readPlace` and `isTerm`.
 */
const MAX_TERM_CHARS = 400
const MAX_SENTENCE_CHARS = 4_000
const MAX_GLOSS_CHARS = 8_000

/** One place a term was met, and what it meant there. */
export interface LookupOccurrence {
  readonly bookId: string
  readonly cfi: string
  /** The chapter label at the time, for the line under the row. */
  readonly chapter: string
  /** The term AS THE SENTENCE SPELLS IT — `Counsel` at a sentence's start. */
  readonly spelled: string
  readonly sentence: string
  /** The definition the model gave for this sentence. Never empty. */
  readonly gloss: string
  /** The language(s) the definition was asked in — `answerLabel`'s tags, or ''. */
  readonly language: string
  readonly at: number
}

export interface Lookup {
  /** The NORMALISED term — see `normalizeTerm`. The record's identity. */
  readonly term: string
  /** Newest first, at most `MAX_OCCURRENCES`. Empty only on a tombstone. */
  readonly occurrences: readonly LookupOccurrence[]
  readonly firstAt: number
  readonly lastAt: number
  readonly updatedAt?: Hlc
  /** The tombstone. A removed term keeps its row so the removal can travel. */
  readonly deletedAt?: Hlc
}

/**
 * The identity of a term: NFC, whitespace collapsed, lower-cased — and NFC
 * again.
 *
 * CASE IS FOLDED HERE AND DELIBERATELY NOT IN THE GLOSS CACHE, and the two are
 * not in tension. The cache's key is the QUESTION the model is sent, where
 * `March` and `march` are different questions (`glossProvider.ts` records the
 * bug that folding caused there). This is a notebook: `Counsel` opening a
 * sentence and `counsel` inside one are the same entry with two places, and each
 * place keeps its own spelling and its own definition, so nothing is lost by
 * filing them together.
 *
 * `toLowerCase`, NOT `toLocaleLowerCase`. The key has to be the same on every
 * device whatever its locale; a Turkish locale folds `I` to `ı`, and one term
 * would become two records depending on which machine looked it up.
 *
 * ⚠️ **COMPOSED AGAIN AFTER THE FOLD, because folding can make a pair that
 * composes.** `J` + caron has no precomposed capital, so the first NFC leaves it
 * apart; lower-cased it is `j` + caron, which composes to `ǰ`. Without the
 * second pass the key was not its own normal form: `parseLookups` refused the
 * row on the next launch, and `removeLookup` could not find it by the key it was
 * filed under. Measured 2026-09-13 over the first three planes, each code point
 * alone and followed by eighteen combining sequences: 35 inputs broke without
 * it, none with it.
 */
export function normalizeTerm(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase().normalize('NFC')
}

/** What a caller records: an occurrence, before it is filed under a term. */
export type LookupEntry = LookupOccurrence

/** When a record was last acted on — `cardStamp`'s rule. */
export function lookupStamp(lookup: Lookup): Hlc {
  return laterHlc(lookup.updatedAt, lookup.deletedAt) ?? hlcOf(lookup.lastAt)
}

/** The terms that are THERE — every read model filters through this. Input by
 *  identity when nothing is deleted. */
export function liveLookups(lookups: readonly Lookup[]): readonly Lookup[] {
  return lookups.some((lookup) => lookup.deletedAt !== undefined)
    ? lookups.filter((lookup) => lookup.deletedAt === undefined)
    : lookups
}

/**
 * Two terms in the order a tie is settled by — code-unit order, and `0` for one
 * term.
 *
 * ⚠️ **THE TIE RULE WAS WRITTEN TWICE AND PINNED BY NEITHER COPY.** `byRecent`
 * and the Dictionary view each spelled it `a.term < b.term ? -1 : 1` and each
 * carried a `Stryker disable` beside it saying `<=` could not disagree with `<`.
 * That is true — terms are unique in every list either sorts — but a `next-line`
 * directive disables EVERY mutant of the mutator it names on that line, so `>=`,
 * which reverses the tie, was disabled with it and the direction nothing held
 * (2026-09-14). Two of the same term is a case a comparator can be asked about
 * directly, so the rule is one function with a test of its own instead.
 */
export function compareTerms(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Most recently met first; ties by term so the order is a function of the data. */
export function byRecent(lookups: readonly Lookup[]): Lookup[] {
  return [...lookups].sort((a, b) => b.lastAt - a.lastAt || compareTerms(a.term, b.term))
}

/**
 * File an answered lookup.
 *
 * THE SAME PLACE TWICE IS ONE PLACE. A reader who looks a word up again at the
 * same anchor — re-reading a page — replaces that occurrence rather than
 * filling the three slots with copies of one sentence. `samePlace` says what
 * "the same place" is when there is no anchor.
 *
 * NEWEST BY TIME, NOT BY ARRIVAL — `newestPlaces`, the rule the read files by
 * too. Prepending the new place assumed the clock only moves forward. So a place
 * looked up again with an earlier `at` than the one it replaces loses to it:
 * one rule, applied the same way at both doors.
 *
 * A TOMBSTONED TERM COMES BACK EMPTY-HANDED. Looking a removed word up again is
 * a new decision to keep it, stamped after the removal; the places the reader
 * removed do not return with it — the tombstone already dropped them.
 *
 * An entry that is not recordable is the input by identity, which the store's
 * guard reads as "nothing changed" — both kinds of it, which `filing` tells
 * apart: nothing to file, and an entry the stored file would refuse on the next
 * launch, which `refusesLookup` names so the store can refuse it out loud. The
 * rules are `readPlace`'s and `isTerm`'s, the two the read applies, so what is
 * filed is what reads back.
 */
export function recordLookup(lookups: readonly Lookup[], entry: LookupEntry, at: Hlc): readonly Lookup[] {
  const filed = filing(entry)
  if (typeof filed === 'string') return lookups
  const { term, occurrence } = filed
  const held = lookups.find((lookup) => lookup.term === term)
  const record: Lookup =
    held === undefined || held.deletedAt !== undefined
      ? { term, occurrences: [occurrence], firstAt: occurrence.at, lastAt: occurrence.at, updatedAt: at }
      : {
          term,
          occurrences: newestPlaces([occurrence, ...held.occurrences]),
          firstAt: Math.min(held.firstAt, occurrence.at),
          lastAt: Math.max(held.lastAt, occurrence.at),
          updatedAt: at,
        }
  return bounded([record, ...lookups.filter((lookup) => lookup.term !== term)])
}

/**
 * An entry as a record files it — its term and its place — or which of two kinds
 * of nothing it is.
 *
 * ⚠️ **NOTHING TO FILE IS NOT REFUSED, AND THE TWO LOOKED THE SAME.** An empty
 * term or definition is nothing to file, and saying nothing is right. An entry
 * the stored file would refuse on the next launch — an anchor past its bound, no
 * book, a time that is not one — was ALSO the input by identity, so the store
 * resolved, wrote nothing and still reported the history persistent: a lookup
 * the reader was shown and would not find again (2026-09-13 verify).
 *
 * A CHAPTER LABEL IS CUT, NOT REFUSED. It comes straight from the book's own
 * metadata, and one past its bound cost the reader every lookup met in that
 * chapter; a label cut short still says where the word was met.
 */
function filing(entry: LookupEntry): { readonly term: string; readonly occurrence: LookupOccurrence } | 'nothing' | 'refused' {
  const spelled = entry.spelled.trim().replace(/\s+/gu, ' ')
  if (spelled === '' || entry.gloss.trim() === '') {
    /* Stryker disable next-line StringLiteral: `recordLookup` asks only whether
       the answer is a string and `refusesLookup` only whether it is 'refused',
       so no other spelling of nothing can be told from this one. */
    return 'nothing'
  }
  const term = normalizeTerm(entry.spelled)
  const occurrence = readPlace({ ...entry, spelled, chapter: cutToBound(entry.chapter, MAX_SENTENCE_CHARS) })
  return occurrence === null || !isTerm(term) ? 'refused' : { term, occurrence }
}

/** Whether the stored history would refuse this entry on the next launch — which an entry that is merely nothing to file is not. See `filing`. */
export function refusesLookup(entry: LookupEntry): boolean {
  return filing(entry) === 'refused'
}

/** Text held to `max` code units, never cut through a surrogate pair. */
function cutToBound(text: string, max: number): string {
  const cut = text.slice(0, max)
  /* Where the cut splits a pair, the whole text still reads one character at the
     last position kept, and the cut reads half of one there. */
  return text.codePointAt(max - 1) === cut.codePointAt(max - 1) ? cut : cut.slice(0, -1)
}

/**
 * A place's identity as one string: the same anchor, in the same book.
 *
 * ⚠️ **AN UNANCHORED PLACE IS ITS CHAPTER AND ITS SENTENCE.** A place may have no
 * CFI — the read has always accepted `''`, and `cardFromLookup` has a branch for
 * it — and on the pair alone every unanchored place in a book was ONE place, so
 * looking `bank` up by a river erased where it had been met in a counting house:
 * the two senses a record keeps places for (2026-09-13 audit). The sentence
 * alone still made one place of a refrain met in two chapters (2026-09-13
 * verify). With an anchor, the anchor alone decides, so a sentence extracted
 * differently on a second visit is still the same place.
 *
 * ⚠️ **ONE IDENTITY, AND THERE WERE TWO.** The Look up list keyed its rows by
 * `bookId|cfi` while the record kept unanchored places apart by sentence, so two
 * places the record kept shared one React key. Anything that keys places reads
 * this. JSON rather than a delimiter, so a `|` in a chapter title cannot make
 * two places one key.
 */
export function placeKey(place: Pick<LookupOccurrence, 'bookId' | 'cfi' | 'chapter' | 'sentence'>): string {
  /* `place.cfi` where it is known to be `''`, rather than the constant: the two
     cannot differ, and a constant no reading can tell from another is a line
     nothing holds. */
  return JSON.stringify(place.cfi === '' ? [place.bookId, place.cfi, place.chapter, place.sentence] : [place.bookId, place.cfi])
}

function samePlace(a: LookupOccurrence, b: LookupOccurrence): boolean {
  return placeKey(a) === placeKey(b)
}

/**
 * A record's places as it keeps them: newest first by `at`, one per place — the
 * newest of each — and at most `MAX_OCCURRENCES`.
 *
 * ⚠️ **THE ONE RULE BOTH DOORS FILE BY, AND THERE WERE TWO.** The write
 * prepended and never compared times; the read sorted by time and never compared
 * places. So a clock that stepped back filed a late place first and evicted a
 * newer one, a relaunch showed the survivors in another order, and three stored
 * copies of one anchor held every slot while a distinct place beside them was
 * dropped (2026-09-13 audit).
 *
 * STABLE ON A TIE, which `Array.prototype.sort` is: the earlier place in the
 * input wins, and both callers put the one to prefer first — the new place, or
 * the stored order, which is newest-filed first.
 */
function newestPlaces(places: readonly LookupOccurrence[]): LookupOccurrence[] {
  const kept: LookupOccurrence[] = []
  for (const place of [...places].sort((x, y) => y.at - x.at)) {
    if (kept.length === MAX_OCCURRENCES) break
    if (!kept.some((one) => samePlace(one, place))) kept.push(place)
  }
  return kept
}

/**
 * Remove a term — a TOMBSTONE, exactly as `removeCard` does, and for the same
 * reason.
 *
 * THE PLACES GO WITH IT, which `removeCard` does not do and should not: a card
 * is a thing the reader made and the row IS the card, whereas the sentences
 * here are text copied out of their books. A reader removing a word from their
 * history expects those sentences gone from disk, not kept in a row nothing
 * shows. The term itself has to stay — it is the identity the removal travels
 * under.
 */
export function removeLookup(lookups: readonly Lookup[], term: string, at: Hlc): readonly Lookup[] {
  const key = normalizeTerm(term)
  if (!lookups.some((lookup) => lookup.term === key && lookup.deletedAt === undefined)) return lookups
  /* BOUNDED HERE TOO. The cap was applied only when a lookup was recorded, so a
     reader clearing their history word by word grew the tombstones past it with
     nothing to stop them — the removal is the write that adds one. */
  /* THE TERM ALONE: the guard above found this term live, and terms are unique,
     so a second test of its tombstone here could only ever agree with it. */
  return bounded(lookups.map((lookup) => (lookup.term === key ? { ...lookup, occurrences: [], deletedAt: at } : lookup)))
}

/** A removed term, typed as one — its stamp is present by definition. */
const isTombstone = (lookup: Lookup): lookup is Lookup & { readonly deletedAt: Hlc } => lookup.deletedAt !== undefined

/**
 * Hold the list to its caps.
 *
 * LIVE TERMS past `MAX_LOOKUP_TERMS` are EVICTED — dropped outright, not
 * tombstoned. Eviction is this device bounding its own file; it is not the
 * reader removing a word, and a tombstone would carry a removal nobody asked
 * for to every replica the day lookups sync.
 *
 * TOMBSTONES are held to the same number, newest removals kept. That bounds a
 * file a reader clears word by word, at a cost stated plainly: once the merge is
 * wired, a replica still holding a term whose tombstone was pruned here could
 * put it back. Nothing merges yet, so nothing can.
 *
 * EVERY DOOR THAT PRODUCES A LIST, the read included — which it did not, so a
 * stored file of 501 terms loaded all 501 (2026-09-13 audit).
 */
function bounded(lookups: readonly Lookup[]): readonly Lookup[] {
  const live = lookups.filter((lookup) => !isTombstone(lookup))
  const dead = lookups.filter(isTombstone)
  /* UNDER BOTH CAPS THE LIST IS RETURNED UNTOUCHED: the filter below would keep
     every row in the order it has, so what the early return saves is the two
     sorts — and the READS they make.

     ⚠️ **THAT IS WHAT TELLS THE TWO BRANCHES APART, AND THIS LINE WAS DELETED
     FOR WANT OF IT.** A `Stryker disable` here had hidden "cap nothing, ever"
     beside the equivalent it named, and the line went on 2026-09-14 on the
     grounds that nothing could see which branch answered — true of the ROWS,
     false of the work: sorting reads a stamp on every row this return never
     looks at, 1 495 of them on a list at the cap. So neither mutant of it is
     equivalent, and `reads no row's stamp when the history is under its caps`
     holds both without disabling anything. */
  if (live.length <= MAX_LOOKUP_TERMS && dead.length <= MAX_LOOKUP_TERMS) return lookups
  const keptLive = new Set(byRecent(live).slice(0, MAX_LOOKUP_TERMS))
  /* NEWEST REMOVAL FIRST, by the stamp's own order — `compareHlc`, not a
     comparison written here with fallbacks for a stamp every row in `dead` has. */
  const keptDead = new Set<Lookup>([...dead].sort((a, b) => compareHlc(b.deletedAt, a.deletedAt)).slice(0, MAX_LOOKUP_TERMS))
  return lookups.filter((lookup) => keptLive.has(lookup) || keptDead.has(lookup))
}

/**
 * The later of two rows for one term — newest stamp, ties to the serialised row.
 *
 * TWO ROWS THAT SERIALISE ALIKE ARE ONE ROW, and the row HELD is the one kept:
 * which object is returned is `mergeLookups`' identity convention, not a
 * preference — an equal row arriving from elsewhere must not read as a change.
 */
function winner(held: Lookup, incoming: Lookup): Lookup {
  const mine = lookupStamp(held)
  const theirs = lookupStamp(incoming)
  if (mine < theirs) return incoming
  if (mine > theirs) return held
  return JSON.stringify(held) < JSON.stringify(incoming) ? incoming : held
}

/**
 * Fold two lookup lists — LATEST ACTION WINS, per term; the semilattice
 * `mergeCards` is, with its tie rule and its identity convention.
 *
 * WHOLE ROWS, NOT A UNION OF PLACES, and that is a stated limit rather than an
 * oversight: two devices that each met a word in a different book keep the
 * later device's places. A union would be kinder and has to answer what a
 * tombstone does to places recorded after it on another device — which is the
 * lexicon phase's question to decide, with sync in front of it. What this
 * guarantees is the property every merge here has: commutative, associative,
 * idempotent.
 *
 * WRITTEN AND NOT CALLED. See the header.
 */
export function mergeLookups(a: readonly Lookup[], b: readonly Lookup[]): readonly Lookup[] {
  const byTerm = new Map(a.map((lookup) => [lookup.term, lookup] as const))
  let changed = false
  for (const incoming of b) {
    const held = byTerm.get(incoming.term)
    if (!held) {
      byTerm.set(incoming.term, incoming)
      changed = true
      continue
    }
    const won = winner(held, incoming)
    /* A DIFFERENT WINNER IS A DIFFERENT ROW: `winner` returns the incoming row
       only for a later stamp or a later serialisation, and either is in the row
       itself — a second, JSON check here could only ever agree. */
    if (won !== held) {
      byTerm.set(incoming.term, won)
      changed = true
    }
  }
  return changed ? [...byTerm.values()] : a
}

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
/* `Number.isFinite` refuses every non-number itself, so no `typeof` beside it. */
const isTime = (value: unknown): value is number => Number.isFinite(value) && (value as number) >= 0

/** A term as a record is keyed by it: bounded, not empty, and its own normal form. */
function isTerm(value: unknown): value is string {
  return isText(value, MAX_TERM_CHARS) && value !== '' && normalizeTerm(value) === value
}

/**
 * One place, at the trust boundary — a fresh object, or null.
 *
 * ⚠️ **REBUILT FROM ITS FIELDS, NOT PASSED THROUGH.** This was a type guard, and
 * the read kept the object it had checked — so a place carrying a field it does
 * not declare kept that field too, unbounded, and wrote it back out on the next
 * save (2026-09-13 audit: a million characters, through both).
 *
 * NO CHECK THAT THE SPELLING NORMALISES TO SOMETHING: both callers test the term
 * the spelling files under, and a term is never empty, so an empty spelling is
 * refused there.
 *
 * ⚠️ **AND NO `typeof` GUARD BESIDE THE `null` ONE.** Only `null` throws when it
 * is destructured; a primitive has no fields, so every check below refuses it
 * where it stands. The guard that said so in code could not be told from its
 * absence, and the directive saying THAT disabled "refuse everything" with it
 * (2026-09-14).
 */
function readPlace(value: unknown): LookupOccurrence | null {
  if (value === null) return null
  const { bookId, cfi, chapter, spelled, sentence, gloss, language, at } = value as Record<string, unknown>
  if (
    !(
      isText(bookId, MAX_TERM_CHARS) &&
      bookId !== '' &&
      isText(cfi, MAX_SENTENCE_CHARS) &&
      isText(chapter, MAX_SENTENCE_CHARS) &&
      isText(spelled, MAX_TERM_CHARS) &&
      isText(sentence, MAX_SENTENCE_CHARS) &&
      isText(gloss, MAX_GLOSS_CHARS) &&
      gloss.trim() !== '' &&
      isText(language, MAX_TERM_CHARS) &&
      isTime(at)
    )
  ) {
    return null
  }
  return { bookId, cfi, chapter, spelled, sentence, gloss, language, at }
}

/**
 * One stored row — a fresh record, or null — with `parseCards`' rules.
 *
 * A BAD PLACE IS DROPPED ALONE, and a record left with none is dropped unless it
 * is a tombstone, which has none by construction. A place filed under the wrong
 * term — a hand-edit — is dropped too: the record's identity is the term, and a
 * place that normalises to another word is not a place of this one.
 *
 * NO `typeof` GUARD — `readPlace`'s reason, and the same date.
 */
function readRow(row: unknown): Lookup | null {
  if (row === null) return null
  const { term, occurrences, firstAt, lastAt, updatedAt, deletedAt } = row as Record<string, unknown>
  if (!isTerm(term) || !isTime(firstAt) || !isTime(lastAt)) return null
  const updated = isHlc(updatedAt) ? updatedAt : undefined
  const deleted = isHlc(deletedAt) ? deletedAt : undefined
  /* LATEST ACTION WINS ON THE ROW ITSELF — `parseCards`' rule, and its spelling:
     the removal stands when it is the row's own latest action. A tie keeps the
     tombstone, because `laterHlc` answers either of two equal stamps and both of
     them are this one. Written as two presence checks and a `>` until
     2026-09-14, where neither check could be told from its absence — a relational
     test against an absent stamp is false in JS — and the directive saying so
     disabled five mutants that tests kill. */
  const tombstone = laterHlc(updated, deleted) === deleted ? deleted : undefined
  const places = Array.isArray(occurrences)
    ? newestPlaces(
        occurrences
          .map(readPlace)
          .filter((one): one is LookupOccurrence => one !== null && normalizeTerm(one.spelled) === term),
      )
    : []
  if (tombstone === undefined && places.length === 0) return null
  return {
    term,
    occurrences: tombstone === undefined ? places : [],
    firstAt,
    lastAt,
    ...(updated !== undefined ? { updatedAt: updated } : {}),
    ...(tombstone !== undefined ? { deletedAt: tombstone } : {}),
  }
}

/**
 * Read the stored list — the trust boundary: `readRow` for each row, one row per
 * term, and the caps `recordLookup` holds a list to.
 *
 * ⚠️ **UNREADABLE THROWS, AND IT USED TO READ AS EMPTY.** Bytes that were not
 * JSON, or JSON that was not a list, answered `[]` — so `createLookups` came up
 * healthy with an empty history, and the next lookup wrote "nothing plus this"
 * over the reader's own (2026-09-13 audit). Thrown, the store takes the
 * load-failure path it already had for a storage that throws: session-only,
 * `persistent` false, and the bytes left where they are. ONLY `null` — nothing
 * stored — is an empty history.
 */
export function parseLookups(raw: string | null): Lookup[] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error('the stored lookup history is not JSON', { cause })
  }
  if (!Array.isArray(parsed)) throw new Error('the stored lookup history is not a list')
  const byTerm = new Map<string, Lookup>()
  for (const row of parsed) {
    const lookup = readRow(row)
    if (lookup === null) continue
    /* ONE ROW PER TERM, decided the way the merge decides — see `parseCards`. */
    const held = byTerm.get(lookup.term)
    byTerm.set(lookup.term, held === undefined ? lookup : winner(held, lookup))
  }
  return byRecent(bounded([...byTerm.values()]))
}

/**
 * A lookup, made into a card (WI-17.6).
 *
 * RECALL, because that is what a word you looked up is: a question with an
 * answer, to be met again. The face is the word AS IT WAS SPELLED, then the
 * sentence it was met in — the sense is the sentence's, so a card of the bare
 * word would ask a question with several right answers. The back is the
 * definition that sentence was given.
 */
export function cardFromLookup(occurrence: LookupOccurrence): NewCard {
  return {
    bookId: occurrence.bookId,
    kind: 'Recall',
    body: occurrence.sentence.trim() === '' ? occurrence.spelled : `${occurrence.spelled}\n\n“${occurrence.sentence.trim()}”`,
    answer: occurrence.gloss,
    source: occurrence.chapter,
    cfi: occurrence.cfi === '' ? null : occurrence.cfi,
  }
}
