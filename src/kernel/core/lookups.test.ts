import { describe, expect, it } from 'vitest'
import { hlcOf, makeHlc } from './hlc'
import {
  LOOKUPS_STORAGE_KEY,
  MAX_LOOKUP_TERMS,
  MAX_OCCURRENCES,
  byRecent,
  cardFromLookup,
  compareTerms,
  liveLookups,
  lookupStamp,
  mergeLookups,
  normalizeTerm,
  parseLookups,
  placeKey,
  recordLookup,
  refusesLookup,
  removeLookup,
  type Lookup,
  type LookupEntry,
} from './lookups'

/**
 * The lookup record (WI-17.1) — a term with the places it was met.
 *
 * Every rule here is one a READER would notice going wrong: a word filed twice,
 * a removed word coming back with the sentences they removed, a history that
 * silently grows past what the view says it keeps.
 */

const entry = (over: Partial<LookupEntry> = {}): LookupEntry => ({
  bookId: 'moby',
  cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:7)',
  chapter: 'Loomings',
  spelled: 'wharves',
  sentence: 'There now is your insular city of the Manhattoes, belted round by wharves.',
  gloss: 'The structures along a shore where ships dock.',
  language: 'en',
  at: 1_000,
  ...over,
})

const at = (ms: number) => hlcOf(ms)

/* THE KEY IS THE STORED FORMAT'S NAME. Tests that read it through the constant
   cannot notice it change — and a changed key orphans every reader's history. */
describe('the storage key', () => {
  it('is paper.lookups.v1', () => {
    expect(LOOKUPS_STORAGE_KEY).toBe('paper.lookups.v1')
  })
})

describe('normalizeTerm', () => {
  it('folds case, collapses whitespace and trims', () => {
    expect(normalizeTerm('  Kept his\n\n own   Counsel ')).toBe('kept his own counsel')
  })

  /* A term typed as a precomposed é and one spelled e + combining acute are the
     same word, and must not become two records. */
  it('composes to NFC', () => {
    expect(normalizeTerm('café')).toBe(normalizeTerm('café'))
  })

  /* The key must be the same on every device: a locale-aware fold turns `I`
     into a dotless `ı` under Turkish, which would split one word into two. */
  it('folds without the host locale', () => {
    expect(normalizeTerm('ISHMAEL')).toBe('ishmael')
  })

  it('is empty for whitespace alone', () => {
    expect(normalizeTerm(' \n\t ')).toBe('')
  })

  /* ITS OWN NORMAL FORM, which it was not. `J` + caron has no precomposed
     capital, so NFC left it apart, and folding it made `j` + caron — which DOES
     compose, to `ǰ`. A key that is not its own normal form is refused by the
     next launch's read, and removing the term by that key found nothing.
     Measured 2026-09-13: 35 such inputs in the first three planes. */
  it.each([
    ['J', 0x30c],
    ['T', 0x308],
    ['W', 0x30a],
    ['Y', 0x30a],
  ])('is its own normal form for %s with the combining mark %i', (letter, mark) => {
    const once = normalizeTerm(`${letter}${String.fromCharCode(mark)}`)

    expect(normalizeTerm(once)).toBe(once)
  })
})

describe('recordLookup', () => {
  it('files a first lookup as a new term with one place', () => {
    const lookups = recordLookup([], entry(), at(1_000))

    expect(lookups).toEqual([
      {
        term: 'wharves',
        occurrences: [entry()],
        firstAt: 1_000,
        lastAt: 1_000,
        updatedAt: at(1_000),
      },
    ])
  })

  /* THE NOTEBOOK'S POINT: the sentence-initial spelling and the inner one are
     one entry with two places, each keeping its own spelling. */
  it('files two spellings of one word under one term, newest place first', () => {
    const first = recordLookup([], entry({ spelled: 'Counsel', cfi: 'a', at: 1_000 }), at(1_000))
    const both = recordLookup(first, entry({ spelled: 'counsel', cfi: 'b', at: 2_000 }), at(2_000))

    expect(both).toHaveLength(1)
    expect(both[0]?.term).toBe('counsel')
    expect(both[0]?.occurrences.map((one) => [one.spelled, one.cfi])).toEqual([
      ['counsel', 'b'],
      ['Counsel', 'a'],
    ])
    expect(both[0]?.firstAt).toBe(1_000)
    expect(both[0]?.lastAt).toBe(2_000)
    expect(both[0]?.updatedAt).toBe(at(2_000))
  })

  /* Re-reading a page and asking again is the same place, not a second one. */
  it('replaces the place it was met at rather than filing it twice', () => {
    const first = recordLookup([], entry({ gloss: 'old', at: 1_000 }), at(1_000))
    const again = recordLookup(first, entry({ gloss: 'new', at: 2_000 }), at(2_000))

    expect(again[0]?.occurrences).toHaveLength(1)
    expect(again[0]?.occurrences[0]?.gloss).toBe('new')
  })

  /* Same anchor in ANOTHER book is another place — the identity of a place is
     the pair, not the CFI alone. */
  it('keeps the same anchor in two books as two places', () => {
    const first = recordLookup([], entry({ bookId: 'a' }), at(1))
    const both = recordLookup(first, entry({ bookId: 'b', at: 2_000 }), at(2))

    expect(both[0]?.occurrences.map((one) => one.bookId)).toEqual(['b', 'a'])
  })

  it(`keeps the newest ${MAX_OCCURRENCES} places and no more`, () => {
    let lookups: readonly Lookup[] = []
    for (let i = 0; i < MAX_OCCURRENCES + 2; i++) {
      lookups = recordLookup(lookups, entry({ cfi: `c${i}`, at: i }), at(i + 1))
    }

    expect(lookups[0]?.occurrences.map((one) => one.cfi)).toEqual(['c4', 'c3', 'c2'])
    /* The first place is gone from the list and still counts for when the
       term was first met. */
    expect(lookups[0]?.firstAt).toBe(0)
  })

  /* A NEW TERM IS ITS OWN RECORD: nothing of a term already held — its places,
     its first time — may leak into it. */
  it('files a new term apart from the terms already held', () => {
    const one = recordLookup([], entry({ spelled: 'gam', cfi: 'g', at: 1_000 }), at(1))
    const two = recordLookup(one, entry({ spelled: 'wharves', cfi: 'w', at: 5_000 }), at(2))
    const wharves = two.find((lookup) => lookup.term === 'wharves')

    expect(wharves?.occurrences.map((place) => place.cfi)).toEqual(['w'])
    expect(wharves?.firstAt).toBe(5_000)
    expect(two.find((lookup) => lookup.term === 'gam')?.occurrences.map((place) => place.cfi)).toEqual(['g'])
  })

  it('moves the term it touched to the front', () => {
    const two = recordLookup(recordLookup([], entry({ spelled: 'gam' }), at(1)), entry({ spelled: 'wharves' }), at(2))
    const touched = recordLookup(two, entry({ spelled: 'gam', cfi: 'other', at: 3_000 }), at(3))

    expect(two.map((one) => one.term)).toEqual(['wharves', 'gam'])
    expect(touched.map((one) => one.term)).toEqual(['gam', 'wharves'])
  })

  it('collapses the spelling it stores', () => {
    const lookups = recordLookup([], entry({ spelled: '  kept his\n own  counsel ' }), at(1))

    expect(lookups[0]?.occurrences[0]?.spelled).toBe('kept his own counsel')
  })

  /* Nothing to file — and BY IDENTITY, which the store reads as "no change"
     and so writes nothing. */
  it.each([
    ['an empty term', { spelled: '  ' }],
    ['an empty definition', { gloss: ' \n ' }],
  ])('returns its input for %s, and the history does not refuse it', (_name, over) => {
    const before = recordLookup([], entry({ spelled: 'gam' }), at(1))

    expect(recordLookup(before, entry(over), at(2))).toBe(before)
    expect(refusesLookup(entry(over))).toBe(false)
  })

  /* A REMOVED WORD LOOKED UP AGAIN starts over: the places the reader removed
     do not come back with it, and the tombstone is gone. */
  it('revives a removed term with only the new place', () => {
    const removed = removeLookup(recordLookup([], entry({ cfi: 'old' }), at(1)), 'wharves', at(2))
    const revived = recordLookup(removed, entry({ cfi: 'new', at: 5_000 }), at(3))

    expect(revived).toHaveLength(1)
    expect(revived[0]?.deletedAt).toBeUndefined()
    expect(revived[0]?.occurrences.map((one) => one.cfi)).toEqual(['new'])
    expect(revived[0]?.firstAt).toBe(5_000)
    expect(liveLookups(revived)).toHaveLength(1)
  })

  /* WHAT IS FILED MUST READ BACK — found by the 2026-09-13 audit. The write
     held a place to three rules and the read to eleven, so a negative time, or a
     chapter label past the stored bound — which comes straight from a book's own
     metadata — was reported saved and dropped by the next launch, taking the
     term with it when it was the only place. The last row is a term: `İ` is one
     code unit and folds to two, so four hundred of them fit as a spelling and
     not as a key.

     AND THE HISTORY SAYS SO (2026-09-13 verify): by identity alone the store read
     the refusal as "no change" and reported the lookup saved. */
  it.each([
    ['a time that is not a number', { at: Number.NaN }],
    ['a time before the epoch', { at: -1 }],
    ['an anchor past its bound', { cfi: 'x'.repeat(4_001) }],
    ['no book', { bookId: '' }],
    ['a term that folds past its bound', { spelled: String.fromCharCode(0x130).repeat(400) }],
  ])('returns its input for %s, which the next launch would refuse, and says the history refuses it', (_name, over) => {
    const before = recordLookup([], entry({ spelled: 'gam' }), at(1))

    expect(recordLookup(before, entry(over), at(2))).toBe(before)
    expect(refusesLookup(entry(over))).toBe(true)
  })

  /* A CHAPTER LABEL IS CUT, NOT REFUSED (2026-09-13 verify). It comes from the
     book's own metadata, and one past its bound cost the reader every lookup met
     in that chapter. A cut through a surrogate pair drops the half. */
  it('files a chapter label past its bound cut to the bound, never through a character', () => {
    const face = String.fromCodePoint(0x1f600)
    const long = recordLookup([], entry({ chapter: 'x'.repeat(4_001) }), at(1))
    const astral = recordLookup([], entry({ chapter: `${'x'.repeat(3_999)}${face}tail` }), at(1))

    expect(long[0]?.occurrences[0]?.chapter).toBe('x'.repeat(4_000))
    expect(astral[0]?.occurrences[0]?.chapter).toBe('x'.repeat(3_999))
    expect(refusesLookup(entry({ chapter: 'x'.repeat(4_001) }))).toBe(false)
  })

  /* AND THE KEY IT FILES UNDER IS ONE THE READ ACCEPTS AND A REMOVAL FINDS —
     see `normalizeTerm`'s own case for why this one was not. */
  it('files a term whose folded form composes so that it reads back, and removes it by its key', () => {
    const lookups = recordLookup([], entry({ spelled: `J${String.fromCharCode(0x30c)}` }), at(1))
    const term = lookups[0]?.term ?? ''

    expect(parseLookups(JSON.stringify(lookups))).toEqual(lookups)
    expect(liveLookups(removeLookup(lookups, term, at(2)))).toEqual([])
  })

  /* NEWEST BY TIME, NOT BY ARRIVAL — the read's rule, and now the write's. A
     clock that stepped back filed the late place first and evicted a newer one,
     and the next launch, which sorts by time, showed the three in another order. */
  it('keeps the newest places by time when one arrives out of order, as the read does', () => {
    let lookups: readonly Lookup[] = []
    for (const ms of [100, 200, 300, 50]) lookups = recordLookup(lookups, entry({ cfi: `c${ms}`, at: ms }), at(ms))

    expect(lookups[0]?.occurrences.map((one) => one.at)).toEqual([300, 200, 100])
    expect(parseLookups(JSON.stringify(lookups))[0]?.occurrences).toEqual(lookups[0]?.occurrences)
  })

  /* AN UNANCHORED PLACE IS TOLD APART BY ITS SENTENCE. With no CFI every place
     in one book compared equal, so looking `bank` up by the river erased the
     place it was met at the counting house — the two senses this record exists
     to keep. */
  it('keeps two unanchored places in one book as two, and one unanchored sentence as one', () => {
    const river = entry({ spelled: 'bank', cfi: '', sentence: 'They sat on the bank.', gloss: 'The edge of a river.', at: 1 })
    const money = entry({ spelled: 'bank', cfi: '', sentence: 'He went to the bank.', gloss: 'A place that keeps money.', at: 2 })
    const both = recordLookup(recordLookup([], river, at(1)), money, at(2))

    expect(both[0]?.occurrences.map((one) => one.gloss)).toEqual(['A place that keeps money.', 'The edge of a river.'])

    const again = recordLookup(both, { ...river, gloss: 'Where a river meets the land.', at: 3 }, at(3))

    expect(again[0]?.occurrences.map((one) => one.gloss)).toEqual(['Where a river meets the land.', 'A place that keeps money.'])
  })

  /* AN ANCHORED ONE IS STILL ITS ANCHOR: the same CFI sent with its sentence
     extracted differently is the same place, not a second. */
  it('keeps one anchored place as one whatever sentence it was sent with', () => {
    const first = recordLookup([], entry({ sentence: 'Belted round by wharves.', at: 1 }), at(1))
    const again = recordLookup(first, entry({ sentence: 'belted round by wharves', at: 2 }), at(2))

    expect(again[0]?.occurrences.map((one) => one.sentence)).toEqual(['belted round by wharves'])
  })

  /* AN UNANCHORED PLACE IS ITS CHAPTER AS WELL AS ITS SENTENCE: a refrain met in
     two chapters was one place on the sentence alone (2026-09-13 verify). */
  it('keeps one unanchored sentence met in two chapters as two places', () => {
    const early = entry({ spelled: 'bank', cfi: '', chapter: 'One', sentence: 'They sat on the bank.', at: 1 })
    const late = entry({ spelled: 'bank', cfi: '', chapter: 'Nine', sentence: 'They sat on the bank.', at: 2 })
    const both = recordLookup(recordLookup([], early, at(1)), late, at(2))

    expect(both[0]?.occurrences.map((one) => one.chapter)).toEqual(['Nine', 'One'])
  })

  /* ONE IDENTITY, TWO READERS: the Look up list keys its rows by `placeKey`, and
     a key that disagreed with the rule the record keeps places by gave two kept
     places one React key (2026-09-13 verify). The last two variants are one
     key under a `|` delimiter. */
  it('gives two places one key exactly when the record keeps them as one', () => {
    const base = entry({ spelled: 'bank', cfi: '', chapter: 'One', sentence: 'They sat on the bank.', at: 1 })
    const variants = [
      base,
      { ...base, sentence: 'He went to the bank.' },
      { ...base, chapter: 'Nine' },
      { ...base, bookId: 'other' },
      { ...base, cfi: 'epubcfi(/6/4!/4/2)' },
      { ...base, cfi: 'epubcfi(/6/4!/4/2)', chapter: 'Nine', sentence: 'Something else.' },
      { ...base, chapter: 'One|They sat', sentence: 'on the bank.' },
      { ...base, chapter: 'One', sentence: 'They sat|on the bank.' },
    ]
    for (const a of variants) {
      for (const b of variants) {
        const kept = recordLookup(recordLookup([], a, at(1)), { ...b, at: 5 }, at(2))[0]?.occurrences ?? []
        expect(placeKey(a) === placeKey(b), `${placeKey(a)} against ${placeKey(b)}`).toBe(kept.length === 1)
      }
    }
  })
})

describe('the caps', () => {
  const terms = (count: number): readonly Lookup[] => {
    let lookups: readonly Lookup[] = []
    for (let i = 0; i < count; i++) {
      lookups = recordLookup(lookups, entry({ spelled: `word${i}`, at: i }), at(i + 1))
    }
    return lookups
  }

  it(`holds ${MAX_LOOKUP_TERMS} terms, evicting the one met longest ago`, () => {
    const lookups = terms(MAX_LOOKUP_TERMS + 1)

    expect(lookups).toHaveLength(MAX_LOOKUP_TERMS)
    expect(lookups.some((one) => one.term === 'word0')).toBe(false)
    expect(lookups.some((one) => one.term === `word${MAX_LOOKUP_TERMS}`)).toBe(true)
  })

  /* EVICTION IS NOT REMOVAL. A tombstone would travel as a removal nobody
     asked for the day lookups sync. */
  it('drops an evicted term outright rather than tombstoning it', () => {
    const lookups = terms(MAX_LOOKUP_TERMS + 1)

    expect(lookups.every((one) => one.deletedAt === undefined)).toBe(true)
  })

  it('does not evict at exactly the cap', () => {
    expect(terms(MAX_LOOKUP_TERMS)).toHaveLength(MAX_LOOKUP_TERMS)
  })

  /** A row whose `lastAt` counts every read of it — which is what sorting a list does. */
  const counted = (term: string, lastAt: number, reads: { of: number }): Lookup => ({
    term,
    occurrences: [entry({ spelled: term })],
    firstAt: 1,
    get lastAt() {
      reads.of += 1
      return lastAt
    },
  })

  /* ⚠️ **A LIST UNDER BOTH CAPS IS RETURNED UNTOUCHED, AND THAT IS A BRANCH A
     TEST CAN SEE.** It was deleted on 2026-09-14 as unobservable, on the
     grounds that the rows and their order are the same whichever way the answer
     is reached — and a review counted the reads: capping sorts, and a sort reads
     a stamp on every row the early return never looks at. The rows a store holds
     are plain JSON, so nothing in the app can count this; a test can, and that is
     what holds the branch. */
  it('reads no row’s stamp when the history is under its caps', () => {
    const reads = { of: 0 }
    const held = [counted('wharves', 9_000, reads), counted('coral', 5_000, reads)]

    const after = recordLookup(held, entry({ spelled: 'gam' }), at(3))

    expect(after.map((one) => one.term)).toEqual(['gam', 'wharves', 'coral'])
    expect(reads.of).toBe(0)
  })

  /* AT EACH CAP EXACTLY, where `<` and `<=` differ by one row and the answer
     does not: the reads are what say which of the two ran. */
  it('reads no row’s stamp with the live terms, or the removals, at the cap exactly', () => {
    const reads = { of: 0 }
    /* The re-recorded term's OWN row is read by `recordLookup`, for its first and
       last times, so that one row is the one here that does not count. */
    const full: Lookup[] = Array.from({ length: MAX_LOOKUP_TERMS }, (_, i) =>
      i === 0
        ? { term: 'word0', occurrences: [entry({ spelled: 'word0' })], firstAt: 1, lastAt: 1 }
        : counted(`word${i}`, i, reads),
    )

    /* Re-recording a term the list holds leaves it at exactly the cap. */
    recordLookup(full, entry({ spelled: 'word0' }), at(1))

    expect(reads.of).toBe(0)

    const tombstones: Lookup[] = Array.from({ length: MAX_LOOKUP_TERMS }, (_, i) => ({
      term: `dead${i}`,
      occurrences: [],
      firstAt: 1,
      lastAt: 1,
      deletedAt: at(1_000 + i),
    }))
    const beside = [...tombstones, counted('wharves', 2, reads), counted('coral', 1, reads)]

    recordLookup(beside, entry({ spelled: 'gam' }), at(2))

    expect(reads.of).toBe(0)
  })

  /* A REMOVAL DOES NOT COUNT AGAINST THE LIVE CAP: five hundred live terms and
     one removed one is under both caps, and every live term stays. */
  it('evicts no live term because a removed one is held beside them', () => {
    const full = [
      ...terms(MAX_LOOKUP_TERMS),
      { term: 'gone', occurrences: [entry({ spelled: 'gone' })], firstAt: 1, lastAt: 9_999_999, updatedAt: at(1) },
    ]

    const removed = removeLookup(full, 'gone', at(10_000_000))

    expect(liveLookups(removed)).toHaveLength(MAX_LOOKUP_TERMS)
    expect(removed.filter((one) => one.deletedAt !== undefined).map((one) => one.term)).toEqual(['gone'])
  })

  /* THE OLDEST REMOVAL GOES, by its stamp — not by where it happens to sit in
     the list, which here is the opposite order. */
  it('prunes the oldest removal by stamp, whatever order the list holds them in', () => {
    const tombstones: Lookup[] = Array.from({ length: MAX_LOOKUP_TERMS }, (_, i) => ({
      term: `dead${i}`,
      occurrences: [],
      firstAt: 1,
      lastAt: 1,
      deletedAt: at(1_000 + i),
    }))
    const list = [
      ...tombstones,
      { term: 'kept', occurrences: [entry({ spelled: 'kept' })], firstAt: 1, lastAt: 1, updatedAt: at(1) },
      { term: 'last', occurrences: [entry({ spelled: 'last' })], firstAt: 1, lastAt: 1, updatedAt: at(1) },
    ]

    const pruned = removeLookup(list, 'last', at(9_000_000))
    const dead = pruned.filter((one) => one.deletedAt !== undefined).map((one) => one.term)

    expect(dead).toHaveLength(MAX_LOOKUP_TERMS)
    expect(dead).toContain('last')
    expect(dead).not.toContain('dead0')
    expect(dead).toContain('dead1')
    expect(liveLookups(pruned).map((one) => one.term)).toEqual(['kept'])
  })

  it('holds tombstones to the same number, keeping the newest removals', () => {
    let lookups = terms(MAX_LOOKUP_TERMS)
    for (let i = 0; i < MAX_LOOKUP_TERMS; i++) lookups = removeLookup(lookups, `word${i}`, at(10_000 + i))
    /* One more live term, then one more removal: the oldest removal goes. */
    lookups = recordLookup(lookups, entry({ spelled: 'extra', at: 20_000 }), at(20_000))
    lookups = removeLookup(lookups, 'extra', at(30_000))

    const dead = lookups.filter((one) => one.deletedAt !== undefined).map((one) => one.term)
    expect(dead).toHaveLength(MAX_LOOKUP_TERMS)
    expect(dead).toContain('extra')
    expect(dead).not.toContain('word0')
    expect(dead).toContain('word1')
  })
})

describe('removeLookup', () => {
  it('tombstones the term and drops its places', () => {
    const removed = removeLookup(recordLookup([], entry(), at(1)), 'wharves', at(9))

    expect(removed).toEqual([
      { term: 'wharves', occurrences: [], firstAt: 1_000, lastAt: 1_000, updatedAt: at(1), deletedAt: at(9) },
    ])
    expect(liveLookups(removed)).toEqual([])
  })

  it('removes the one term it names and leaves every other term alone', () => {
    const both = recordLookup(recordLookup([], entry({ spelled: 'gam' }), at(1)), entry({ spelled: 'wharves' }), at(2))

    const removed = removeLookup(both, 'gam', at(9))

    expect(liveLookups(removed).map((one) => one.term)).toEqual(['wharves'])
    expect(removed.find((one) => one.term === 'wharves')?.occurrences).toHaveLength(1)
  })

  it('finds the term by any spelling of it', () => {
    const removed = removeLookup(recordLookup([], entry(), at(1)), '  WHARVES ', at(9))

    expect(removed[0]?.deletedAt).toBe(at(9))
  })

  it('returns its input for a term that is not there, or already removed', () => {
    const one = recordLookup([], entry(), at(1))
    const removed = removeLookup(one, 'wharves', at(2))

    expect(removeLookup(one, 'gam', at(3))).toBe(one)
    expect(removeLookup(removed, 'wharves', at(3))).toBe(removed)
  })
})

describe('compareTerms', () => {
  /* THE TIE RULE, ASKED DIRECTLY. Every list `byRecent` and the Dictionary view
     sort has unique terms, so `<` and `<=` cannot disagree there — and the
     directives that said so disabled the REVERSAL beside them, which no list
     could then pin. Two of the same term is a case the comparator itself
     answers for. */
  it('orders two terms by code unit, and answers zero for one term', () => {
    expect(compareTerms('coral', 'wharves')).toBe(-1)
    expect(compareTerms('wharves', 'coral')).toBe(1)
    expect(compareTerms('gam', 'gam')).toBe(0)
  })
})

describe('liveLookups and byRecent', () => {
  it('is its input by identity when nothing is removed', () => {
    const one = recordLookup([], entry(), at(1))

    expect(liveLookups(one)).toBe(one)
  })

  it('keeps the live terms and drops the removed ones from a mixed list', () => {
    const live = { term: 'gam', occurrences: [], firstAt: 0, lastAt: 1 }
    const dead = { term: 'wharves', occurrences: [], firstAt: 0, lastAt: 2, deletedAt: at(3) }

    expect(liveLookups([dead, live])).toEqual([live])
  })

  /* A tie is broken by term WHICHEVER ORDER THE ROWS ARRIVE IN — a comparator
     that always answers "before" happens to pass one order and fails the other. */
  it('breaks a tie by term whichever order the rows arrive in', () => {
    const row = (term: string) => ({ term, occurrences: [], firstAt: 0, lastAt: 5 })
    const terms = ['delta', 'alpha', 'charlie', 'bravo']

    expect(byRecent(terms.map(row)).map((one) => one.term)).toEqual(['alpha', 'bravo', 'charlie', 'delta'])
    expect(byRecent([...terms].reverse().map(row)).map((one) => one.term)).toEqual(['alpha', 'bravo', 'charlie', 'delta'])
  })

  it('orders by the last time met, then by term', () => {
    const rows = [
      { term: 'b', occurrences: [], firstAt: 0, lastAt: 5 },
      { term: 'a', occurrences: [], firstAt: 0, lastAt: 5 },
      { term: 'c', occurrences: [], firstAt: 0, lastAt: 9 },
    ]

    expect(byRecent(rows).map((one) => one.term)).toEqual(['c', 'a', 'b'])
  })
})

describe('lookupStamp', () => {
  it('is the later of the edit and the removal, else the last time met', () => {
    expect(lookupStamp({ term: 'a', occurrences: [], firstAt: 0, lastAt: 7 })).toBe(hlcOf(7))
    expect(lookupStamp({ term: 'a', occurrences: [], firstAt: 0, lastAt: 7, updatedAt: at(3), deletedAt: at(4) })).toBe(at(4))
    expect(lookupStamp({ term: 'a', occurrences: [], firstAt: 0, lastAt: 7, updatedAt: at(5), deletedAt: at(4) })).toBe(at(5))
  })
})

describe('mergeLookups', () => {
  const row = (term: string, stamp: number, gloss = 'x'): Lookup => ({
    term,
    occurrences: [entry({ spelled: term, gloss })],
    firstAt: 1,
    lastAt: 1,
    updatedAt: makeHlc(stamp, 0, '0000000000000001'),
  })

  it('takes the later action per term', () => {
    const merged = mergeLookups([row('gam', 1, 'old')], [row('gam', 2, 'new')])

    expect(merged.map((one) => one.occurrences[0]?.gloss)).toEqual(['new'])
  })

  it('keeps the held row when it is the later one, by identity', () => {
    const held = [row('gam', 5, 'held')]

    expect(mergeLookups(held, [row('gam', 2, 'older')])).toBe(held)
  })

  /* THE TIE RULE, AS A DIRECTION: on equal stamps the row that serialises later
     wins, from either side — commutativity alone would pass a rule that always
     picked the earlier one. */
  it('breaks a tie toward the row that serialises later, from either side', () => {
    expect(mergeLookups([row('gam', 1, 'a')], [row('gam', 1, 'b')])[0]?.occurrences[0]?.gloss).toBe('b')
    expect(mergeLookups([row('gam', 1, 'b')], [row('gam', 1, 'a')])[0]?.occurrences[0]?.gloss).toBe('b')
  })

  /* AN EQUAL ROW ARRIVING FROM ELSEWHERE IS NOT A CHANGE — the identity
     convention, and what decides which of two rows that serialise alike is kept:
     the held one. Keeping the incoming copy instead answers the same rows in a
     new list, which every caller reads as "something moved". */
  it('answers its first list by identity when the other holds an equal row', () => {
    const held = [row('gam', 1)]

    expect(mergeLookups(held, [row('gam', 1)])).toBe(held)
  })

  it('adds a term only one side has', () => {
    expect(mergeLookups([row('gam', 1)], [row('wharves', 1)]).map((one) => one.term).sort()).toEqual(['gam', 'wharves'])
  })

  /* A removal newer than the other side's lookup wins, and travels. */
  it('lets a newer tombstone win', () => {
    const removed: Lookup = { ...row('gam', 1), occurrences: [], deletedAt: makeHlc(9, 0, '0000000000000001') }

    expect(liveLookups(mergeLookups([row('gam', 3)], [removed]))).toEqual([])
  })

  /* THE SEMILATTICE. Order and repetition must not change the answer, or two
     replicas that saw the same rows in a different order would disagree. */
  it('is commutative, associative and idempotent — including a tie', () => {
    const a = [row('gam', 1, 'a'), row('wharves', 4)]
    const b = [row('gam', 1, 'b')]
    const c = [row('gam', 3, 'c'), { ...row('wharves', 2), occurrences: [], deletedAt: makeHlc(2, 0, '0000000000000001') }]
    const sorted = (rows: readonly Lookup[]) => [...rows].sort((x, y) => (x.term < y.term ? -1 : 1))

    expect(sorted(mergeLookups(a, b))).toEqual(sorted(mergeLookups(b, a)))
    expect(sorted(mergeLookups(mergeLookups(a, b), c))).toEqual(sorted(mergeLookups(a, mergeLookups(b, c))))
    expect(mergeLookups(a, a)).toBe(a)
  })
})

describe('parseLookups', () => {
  const stored = (rows: unknown): string => JSON.stringify(rows)
  const good = (): Lookup => recordLookup([], entry(), at(1))[0] as Lookup

  it('reads nothing from nothing', () => {
    expect(parseLookups(null)).toEqual([])
  })

  /* UNREADABLE IS NOT EMPTY — found by the 2026-09-13 audit. Answering [] for
     bytes that would not parse told the store the history was healthy and
     empty, and the next lookup wrote over it. Thrown, the store goes
     session-only and leaves the bytes where they were. Each clause is asserted
     in its own words, because the two share a prefix. */
  it.each([
    ['rubbish', '{not json', /is not JSON/u],
    ['an empty string', '', /is not JSON/u],
    ['a non-list', JSON.stringify({ term: 'gam' }), /is not a list/u],
    ['JSON null', 'null', /is not a list/u],
  ])('refuses %s rather than reading it as an empty history', (_name, raw, clause) => {
    const cause = (() => {
      try {
        parseLookups(raw)
        return null
      } catch (error: unknown) {
        return error
      }
    })()

    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(clause)
  })

  /* AND THE PARSER'S OWN ERROR IS CARRIED AS THE CAUSE. The store reports why a
     history would not load, and "the stored lookup history is not JSON" says
     nothing about which byte stopped it. */
  it('carries the JSON parser’s own error as the cause of its refusal', () => {
    const refusal = (() => {
      try {
        parseLookups('{not json')
        return null
      } catch (error: unknown) {
        return error
      }
    })()

    expect(refusal).toBeInstanceOf(Error)
    expect((refusal as Error).cause).toBeInstanceOf(SyntaxError)
  })

  /* THE CAPS HOLD ON THE WAY IN TOO — found by the 2026-09-13 audit. A file
     holding more than the view says it keeps, written by hand or by a build that
     capped nothing, loaded whole. */
  it(`holds a stored list to ${MAX_LOOKUP_TERMS} terms, evicting the one met longest ago`, () => {
    const rows = Array.from({ length: MAX_LOOKUP_TERMS + 1 }, (_, i) => ({
      term: `word${i}`,
      occurrences: [entry({ spelled: `word${i}` })],
      firstAt: i,
      lastAt: i,
    }))

    const read = parseLookups(stored(rows))

    expect(read).toHaveLength(MAX_LOOKUP_TERMS)
    expect(read.some((one) => one.term === 'word0')).toBe(false)
  })

  it(`holds stored removals to ${MAX_LOOKUP_TERMS}, keeping the newest`, () => {
    const rows = Array.from({ length: MAX_LOOKUP_TERMS + 1 }, (_, i) => ({
      term: `dead${i}`,
      occurrences: [],
      firstAt: 1,
      lastAt: 1,
      deletedAt: at(1_000 + i),
    }))

    const read = parseLookups(stored(rows))

    expect(read).toHaveLength(MAX_LOOKUP_TERMS)
    expect(read.some((one) => one.term === 'dead0')).toBe(false)
  })

  /* A PLACE IS REBUILT FROM ITS FIELDS, NOT KEPT WHOLE — found by the
     2026-09-13 audit. Checking the eight it declares and keeping the object let
     a ninth through, unbounded, and back out to disk on the next write. */
  it('keeps only the fields a place declares', () => {
    const row = { ...good(), occurrences: [{ ...entry(), smuggled: 'x'.repeat(1_000_000) }] }

    expect(Object.keys(parseLookups(stored([row]))[0]?.occurrences[0] ?? {}).sort()).toEqual(Object.keys(entry()).sort())
  })

  /* ONE ANCHOR IS ONE PLACE ON THE WAY IN, as it is when a lookup files one —
     found by the 2026-09-13 audit. Three copies of one anchor held every slot,
     so the distinct place beside them was dropped, and the view drew three rows
     under one key. */
  it('reads one anchor stored three times as one place, the newest, beside the others', () => {
    const places = [
      entry({ cfi: 'same', gloss: 'old', at: 1 }),
      entry({ cfi: 'same', gloss: 'newest', at: 3 }),
      entry({ cfi: 'same', gloss: 'middle', at: 2 }),
      entry({ cfi: 'other', gloss: 'elsewhere', at: 0 }),
    ]

    const read = parseLookups(stored([{ ...good(), occurrences: places }]))[0]

    expect(read?.occurrences.map((one) => [one.cfi, one.gloss])).toEqual([
      ['same', 'newest'],
      ['other', 'elsewhere'],
    ])
  })

  it('reads back what was written', () => {
    expect(parseLookups(stored([good()]))).toEqual([good()])
  })

  it('drops a bad place alone, keeping the good one beside it', () => {
    const row = { ...good(), occurrences: [entry({ cfi: 'kept' }), { ...entry(), gloss: '' }, { ...entry(), at: -1 }] }

    expect(parseLookups(stored([row]))[0]?.occurrences.map((one) => one.cfi)).toEqual(['kept'])
  })

  it('drops a record left with no places, unless it is a removal', () => {
    const empty = { ...good(), occurrences: [] }
    const tombstone = { ...good(), occurrences: [], deletedAt: at(5) }

    expect(parseLookups(stored([empty]))).toEqual([])
    expect(parseLookups(stored([tombstone]))).toEqual([tombstone])
  })

  /* A tombstone has no places by construction; one carrying some — a
     hand-edit — must not put the removed sentences back in memory. */
  it('reads a removal without whatever places it was carrying', () => {
    const tombstone = { ...good(), deletedAt: at(5) }

    expect(parseLookups(stored([tombstone]))[0]?.occurrences).toEqual([])
  })

  it('drops a place filed under another term', () => {
    const row = { ...good(), occurrences: [entry(), entry({ spelled: 'gam', cfi: 'wrong' })] }

    expect(parseLookups(stored([row]))[0]?.occurrences.map((one) => one.spelled)).toEqual(['wharves'])
  })

  it('drops a row whose term is not in its normal form, or is empty', () => {
    expect(parseLookups(stored([{ ...good(), term: 'Wharves' }]))).toEqual([])
    expect(parseLookups(stored([{ ...good(), term: '' }]))).toEqual([])
  })

  it('drops a row whose times are not times', () => {
    expect(parseLookups(stored([{ ...good(), firstAt: 'yesterday' }]))).toEqual([])
    expect(parseLookups(stored([{ ...good(), lastAt: -5 }]))).toEqual([])
  })

  /* LATEST ACTION WINS ON THE ROW: a lookup newer than the removal is alive. */
  it('clears a tombstone older than the row’s own edit', () => {
    const row = { ...good(), updatedAt: at(9), deletedAt: at(5) }
    const read = parseLookups(stored([row]))[0]

    expect(read?.deletedAt).toBeUndefined()
    expect(read?.occurrences).toHaveLength(1)
  })

  /* AND A TIE KEEPS THE REMOVAL: an edit stamped with the removal is not later
     than it, so the row stays removed. */
  it('keeps a tombstone stamped with the row’s own edit', () => {
    const row = { ...good(), updatedAt: at(5), deletedAt: at(5) }

    expect(parseLookups(stored([row]))[0]?.deletedAt).toBe(at(5))
  })

  it('drops a malformed stamp alone, keeping the row', () => {
    const read = parseLookups(stored([{ ...good(), updatedAt: 'tuesday' }]))[0]

    expect(read?.term).toBe('wharves')
    expect(read?.updatedAt).toBeUndefined()
  })

  it('keeps one row per term, the later one', () => {
    const older = { ...good(), updatedAt: at(1), occurrences: [entry({ gloss: 'older' })] }
    const newer = { ...good(), updatedAt: at(2), occurrences: [entry({ gloss: 'newer' })] }

    expect(parseLookups(stored([newer, older]))[0]?.occurrences[0]?.gloss).toBe('newer')
    expect(parseLookups(stored([older, newer]))[0]?.occurrences[0]?.gloss).toBe('newer')
  })

  it(`holds a stored row to its newest ${MAX_OCCURRENCES} places`, () => {
    const places = [1, 5, 3, 4, 2].map((ms) => entry({ cfi: `c${ms}`, at: ms }))
    const read = parseLookups(stored([{ ...good(), occurrences: places }]))[0]

    expect(read?.occurrences.map((one) => one.cfi)).toEqual(['c5', 'c4', 'c3'])
  })

  it('refuses a field past its bound', () => {
    const huge = { ...good(), occurrences: [entry({ gloss: 'x'.repeat(8_001) })] }
    const fits = { ...good(), occurrences: [entry({ gloss: 'x'.repeat(8_000) })] }

    expect(parseLookups(stored([huge]))).toEqual([])
    expect(parseLookups(stored([fits]))).toHaveLength(1)
  })

  /* Every field of a place, at the trust boundary, one wrong value at a time —
     a check that is never tried is a check that can be deleted unnoticed. */
  it.each([
    ['bookId', 7],
    ['bookId', ''],
    ['bookId', ['moby']],
    ['cfi', 7],
    ['chapter', 7],
    ['spelled', 7],
    ['sentence', 7],
    ['gloss', 7],
    ['gloss', '   '],
    ['language', 7],
    ['at', '5'],
  ])('drops a place whose %s is %j', (field, value) => {
    const row = { ...good(), occurrences: [{ ...entry(), [field]: value }] }

    expect(parseLookups(stored([row]))).toEqual([])
  })

  /* Each field's bound, at the limit and one past it. The spelling is padded
     rather than lengthened, so it still normalises to its term and only the
     bound can refuse it. */
  it.each([
    ['bookId', 400],
    ['cfi', 4_000],
    ['chapter', 4_000],
    ['sentence', 4_000],
    ['language', 400],
    ['spelled', 400],
  ])('holds a place’s %s to %i characters', (field, max) => {
    const valued = (length: number) =>
      field === 'spelled'
        ? { term: 'w'.repeat(400), spelled: `${' '.repeat(length - 400)}${'w'.repeat(400)}` }
        : { term: 'wharves', [field]: 'x'.repeat(length) }
    const row = (length: number) => {
      const { term, ...place } = valued(length)
      return { ...good(), term, occurrences: [{ ...entry(), ...place }] }
    }

    expect(parseLookups(stored([row(max)]))).toHaveLength(1)
    expect(parseLookups(stored([row(max + 1)]))).toEqual([])
  })

  it('reads a place at time zero, and a row whose times are zero', () => {
    const zero = { ...good(), firstAt: 0, lastAt: 0, occurrences: [entry({ at: 0 })] }

    expect(parseLookups(stored([zero]))[0]?.occurrences).toHaveLength(1)
    expect(parseLookups(stored([{ ...good(), firstAt: '5' }]))).toEqual([])
  })

  it('reads a row whose places are not a list as having none', () => {
    expect(parseLookups(stored([{ ...good(), occurrences: 'nope' }]))).toEqual([])
    expect(parseLookups(stored([{ ...good(), occurrences: 'nope', deletedAt: at(5) }]))[0]?.occurrences).toEqual([])
  })

  /* A REMOVAL has no places to reject it, so the term checks are all that stand
     between a hand-edit and a row filed under nothing. */
  it('drops a removal filed under an empty or unnormalised term', () => {
    const tombstone = (term: string) => ({ term, occurrences: [], firstAt: 1, lastAt: 1, deletedAt: at(5) })

    expect(parseLookups(stored([tombstone('')]))).toEqual([])
    expect(parseLookups(stored([tombstone('Wharves')]))).toEqual([])
  })

  it('drops a place that is not an object, without throwing', () => {
    expect(parseLookups(stored([{ ...good(), occurrences: ['wharves', 7, entry()] }]))[0]?.occurrences).toEqual([entry()])
  })

  /* NO `typeof` GUARD STANDS BETWEEN THESE AND THE CHECKS THAT REFUSE THEM — a
     primitive has no fields, so the term check drops a row and the field checks
     drop a place. Only `null` has a guard, because destructuring one throws. */
  it('drops a row that is not an object, without throwing', () => {
    expect(parseLookups(stored([7, 'wharves', true, good()]))).toEqual([good()])
  })

  it('skips a null row and a null place without throwing', () => {
    expect(parseLookups(stored([null, good()]))).toEqual([good()])
    expect(parseLookups(stored([{ ...good(), occurrences: [null, entry()] }]))[0]?.occurrences).toEqual([entry()])
  })

  /* NO STAMP, NO KEY — an `updatedAt: undefined` is a different row to every
     serialiser, and the merge compares serialisations. */
  it('reads a row without stamps as a row without stamp keys', () => {
    const plain = { term: 'wharves', occurrences: [entry()], firstAt: 1, lastAt: 1 }

    expect(Object.keys(parseLookups(stored([plain]))[0] ?? {})).toEqual(['term', 'occurrences', 'firstAt', 'lastAt'])
  })

  it('returns the list most recently met first', () => {
    const older = { ...good(), term: 'gam', occurrences: [entry({ spelled: 'gam' })], lastAt: 1 }
    const newer = { ...good(), lastAt: 9 }

    expect(parseLookups(stored([older, newer])).map((one) => one.term)).toEqual(['wharves', 'gam'])
  })
})

describe('cardFromLookup', () => {
  it('makes a Recall card: the word in its sentence, and the definition behind it', () => {
    expect(cardFromLookup(entry())).toEqual({
      bookId: 'moby',
      kind: 'Recall',
      body: 'wharves\n\n“There now is your insular city of the Manhattoes, belted round by wharves.”',
      answer: 'The structures along a shore where ships dock.',
      source: 'Loomings',
      cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:7)',
    })
  })

  it('trims the sentence it quotes', () => {
    expect(cardFromLookup(entry({ sentence: '  Belted round by wharves.  ' })).body).toBe(
      'wharves\n\n“Belted round by wharves.”',
    )
  })

  it('is the word alone when there is no sentence, and unanchored with no CFI', () => {
    const card = cardFromLookup(entry({ sentence: '  ', cfi: '' }))

    expect(card.body).toBe('wharves')
    expect(card.cfi).toBeNull()
  })
})
