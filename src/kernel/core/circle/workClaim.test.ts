import { describe, expect, it } from 'vitest'
import { CORPUS_BUILDS, BUILD_IDS } from '../markCorpus.testkit'
import { SHELF_WORK, claimFor, indexKeys, listIdOf, listWork, matchWork, normaliseName, primaryLanguage, titleProper } from './workClaim'

/**
 * WI-22.C1 — the log key.
 *
 * The item exists because `workKey` cannot identify one work across builds, and
 * `workKey.test.ts` says so about itself. This file's central test is that
 * claim's inverse: the three corpus builds must reach ONE log.
 */

/* A digest that is deterministic and readable in a failure. The real one is
   SHA-256; nothing here depends on which, only that both sides use the same —
   which is why `claimFor` takes it rather than importing one. */
const digest = (value: string): string => {
  let h = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `#${(h >>> 0).toString(16)}`
}

describe('primaryLanguage', () => {
  it('keeps one English population together', () => {
    /* `en-GB` and `en-US` are one set of passages. Splitting them would
       partition every English work by the OPF's spelling convention. */
    expect(primaryLanguage('en-GB')).toBe('en')
    expect(primaryLanguage('en_US')).toBe('en')
    expect(primaryLanguage('EN')).toBe('en')
  })

  it('answers empty for a book that declares nothing usable', () => {
    expect(primaryLanguage(undefined)).toBe('')
    expect(primaryLanguage('')).toBe('')
    expect(primaryLanguage('x')).toBe('')
    expect(primaryLanguage('1234')).toBe('')
  })
})

describe('normaliseName', () => {
  it('drops a leading article, which cataloguing conventions disagree about', () => {
    expect(normaliseName('The Whale')).toBe('whale')
    expect(normaliseName('A Tale of Two Cities')).toBe('tale of two cities')
  })

  it('folds punctuation and case, which is what differs between builds', () => {
    expect(normaliseName('Moby-Dick; or, The Whale')).toBe('moby dick or the whale')
    expect(normaliseName('MOBY DICK')).toBe(normaliseName('Moby Dick'))
  })

  it('turns punctuation into a space rather than nothing', () => {
    /* Deleting it would make "rock'n'roll" one word while "rock 'n' roll"
       stayed three — two spellings of one title that stop matching. */
    expect(normaliseName("rock'n'roll")).toBe('rock n roll')
    expect(normaliseName("rock 'n' roll")).toBe('rock n roll')
  })

  it('keeps an article-only title rather than emptying it', () => {
    /* ⚠️ Emptying it would make every such book match every other one on the
       weak key — a silent merge of unrelated logs. */
    expect(normaliseName('The')).toBe('the')
    expect(normaliseName('A')).toBe('a')
  })

  it('answers empty only for genuinely empty input', () => {
    expect(normaliseName(undefined)).toBe('')
    expect(normaliseName('   ')).toBe('')
  })
})

describe('matchWork', () => {
  const claim = (over: Partial<Parameters<typeof matchWork>[0]> = {}) => ({
    ids: [] as readonly string[],
    titles: ['#whale'],
    author: '#melville',
    language: 'en',
    ...over,
  })

  it('does not match weakly across languages, however alike the rest', () => {
    const en = claim({ ids: [], titles: ['dune'], author: 'frank herbert', language: 'en' })
    const de = claim({ ids: [], titles: ['dune'], author: 'frank herbert', language: 'de' })
    expect(matchWork(en, de)).toBe('none')
    /* A book that has said nothing about its language is not matched weakly either: the fallback needs both to speak. */
    expect(matchWork(en, claim({ ids: [], titles: ['dune'], author: 'frank herbert', language: '' }))).toBe('none')
    expect(matchWork(en, claim({ ids: [], titles: ['dune'], author: 'frank herbert', language: 'en' }))).toBe('weak')
  })

  it('matches strongly when the builds share one identifier', () => {
    expect(matchWork(claim({ ids: ['#a', '#b'] }), claim({ ids: ['#b', '#c'] }))).toBe('strong')
  })

  it('bridges two populations through a build that declares both', () => {
    /* ⚠️ **THE PROPERTY A SCALAR CANNOT HAVE.** Gutenberg readers and ISBN
       readers never meet directly; a build declaring both reaches each.

       The three titles differ deliberately, so the weak key cannot rescue any
       of these — this test is about the STRONG one and would otherwise pass
       without exercising it. */
    const gutenberg = claim({ ids: ['#gut'], titles: ['#one'] })
    const commercial = claim({ ids: ['#isbn'], titles: ['#two'] })
    const both = claim({ ids: ['#gut', '#isbn'], titles: ['#three'] })

    expect(matchWork(gutenberg, commercial)).toBe('none')
    expect(matchWork(gutenberg, both)).toBe('strong')
    expect(matchWork(commercial, both)).toBe('strong')
  })

  it('falls back to title, author and language when no identifier is shared', () => {
    /* The 33 books on the measured shelf that declare no identifier at all.
       `workKey` answers null for every one of them, so a scalar key left them
       unable to have a log. */
    expect(matchWork(claim(), claim())).toBe('weak')
  })

  it('refuses a weak match across languages', () => {
    /* ⚠️ **THE FIELD `wire.md` DROPPED, and its absence is a correctness bug.**
       Moby-Dick in English and in Chinese translation share a title, an author
       and often an identifier — and share no passages at all. Merging their
       logs produces a list of quotes guaranteed not to resolve. */
    expect(matchWork(claim({ language: 'en' }), claim({ language: 'zh' }))).toBe('none')
  })

  it('never weak-matches two books that declare no language', () => {
    /* Two silences are not agreement. The strong key still serves such a book;
       only the fallback is withheld. */
    expect(matchWork(claim({ language: '' }), claim({ language: '' }))).toBe('none')
  })

  it('still matches strongly when neither declares a language', () => {
    expect(
      matchWork(claim({ language: '', ids: ['#x'] }), claim({ language: '', ids: ['#x'] })),
    ).toBe('strong')
  })

  it('refuses when title or author differ', () => {
    expect(matchWork(claim(), claim({ titles: ['#other'] }))).toBe('none')
    expect(matchWork(claim(), claim({ author: '#other' }))).toBe('none')
  })
})

describe('the corpus — the case the scalar key got wrong', () => {
  it('reaches ONE log for all three builds of Moby-Dick', () => {
    /* ⚠️ **THIS IS WI-22.C1's WHOLE POINT, and it is the exact inverse of
       `workKey.test.ts`'s "keeps the corpus's three builds three different
       works" — a test whose own comment says the answer "is WRONG".**

       The three builds declare a Gutenberg URL, a Standard Ebooks URL and an
       ISBN: no two share an identifier, so every strong match fails and the
       weak key is what has to carry them. */
    const claims = BUILD_IDS.map((id) =>
      claimFor(
        {
          title: CORPUS_BUILDS[id].title,
          author: CORPUS_BUILDS[id].author,
          identifier: CORPUS_BUILDS[id].identifier,
          languages: ['en'],
        },
        digest,
      ),
    )

    for (let i = 0; i < claims.length; i += 1) {
      for (let j = i + 1; j < claims.length; j += 1) {
        expect(matchWork(claims[i]!, claims[j]!), `${BUILD_IDS[i]} ↔ ${BUILD_IDS[j]}`).not.toBe('none')
      }
    }
  })

  it('gives every build the same weak index key, so a lookup finds them', () => {
    /* Matching is the answer; the index is how a recipient avoids scanning
       every log it holds to find the candidates. */
    const weakOf = (id: (typeof BUILD_IDS)[number]) =>
      indexKeys(
        claimFor(
          {
            title: CORPUS_BUILDS[id].title,
            author: CORPUS_BUILDS[id].author,
            identifier: CORPUS_BUILDS[id].identifier,
            languages: ['en'],
          },
          digest,
        ),
      ).filter((k) => k.startsWith('w:'))

    /* ⚠️ **THEY INTERSECT; THEY ARE NOT EQUAL — and asserting equality is what
       this test did first.** A build titling the book *Moby-Dick; or, The
       Whale* offers TWO weak keys (the whole title and the title proper); the
       one titling it *Moby-Dick* offers one. Demanding an identical set would
       have forced the subtitle rule back out, which is the rule that makes the
       corpus meet at all. What a lookup needs is a shared key, not a shared
       set. */
    const sets = BUILD_IDS.map((id) => weakOf(id))
    expect(sets.some((one) => one.length === 2)).toBe(true)
    expect(sets.some((one) => one.length === 1)).toBe(true)
    for (const set of sets) {
      for (const other of sets) {
        expect(set.some((key) => other.includes(key)), `${set} ∩ ${other}`).toBe(true)
      }
    }
  })
})

describe('claimFor', () => {
  it('hashes everything except the language', () => {
    /* ⚠️ A licence URL carrying an email, a library barcode, a purchase id —
       none of them cross the wire, and two peers holding the same identifier
       still match on it, because equality survives hashing. */
    const claim = claimFor(
      {
        title: 'The Whale',
        author: 'Melville',
        identifier: 'urn:isbn:9780142437247',
        languages: ['en-GB'],
      },
      digest,
    )
    expect(claim.titles.every((t) => t.startsWith('#'))).toBe(true)
    expect(claim.author.startsWith('#')).toBe(true)
    expect(claim.ids.every((id) => id.startsWith('#'))).toBe(true)
    expect(claim.language).toBe('en')
    /* The raw values are nowhere in the claim. */
    expect(JSON.stringify(claim)).not.toContain('9780142437247')
    expect(JSON.stringify(claim)).not.toContain('Whale')
  })

  it('reuses workKey, so an ISBN still normalises across spellings', () => {
    /* Ten-digit hyphenated and thirteen-digit prefixed are one book, and
       `workKey` already knew that. A second normaliser here could drift. */
    const ten = claimFor({ identifier: 'ISBN 0-14-243724-7' }, digest)
    const thirteen = claimFor({ identifier: 'urn:isbn:9780142437247' }, digest)
    expect(ten.ids).toEqual(thirteen.ids)
    expect(matchWork(ten, thirteen)).toBe('strong')
  })

  it('claims no id at all for a book that declares none', () => {
    const claim = claimFor({ title: 'Untitled', author: 'Nobody', languages: ['en'] }, digest)
    expect(claim.ids).toEqual([])
    /* And is still usable — this is the 33-book case. */
    expect(indexKeys(claim)).toHaveLength(1)
  })
})

describe('a list’s reserved claim — WI-23.E1', () => {
  it('names the list in its one id, in clear, and reads it back', () => {
    expect(listWork('aa11')).toEqual({ ids: ['paper.circle.list:aa11'], titles: [], author: '', language: '' })
    expect(listIdOf(listWork('aa11'))).toBe('aa11')
    expect(listIdOf(listWork('a'))).toBe('a')
  })

  it('is not a work, a shelf, or a list with no id', () => {
    expect(listIdOf(SHELF_WORK)).toBeNull()
    expect(listIdOf({ ids: [], titles: [], author: '', language: '' })).toBeNull()
    expect(listIdOf({ ids: ['paper.circle.list:'], titles: [], author: '', language: '' })).toBeNull()
    expect(listIdOf({ ids: ['paper.circle.list:aa11', 'paper.circle.list:bb22'], titles: [], author: '', language: '' })).toBeNull()
    expect(listIdOf({ ids: ['aa11'], titles: [], author: '', language: '' })).toBeNull()
    expect(listIdOf({ ids: ['xpaper.circle.list:aa11'], titles: [], author: '', language: '' })).toBeNull()
    /* Two lists never meet, and a list never meets the shelf or a book. */
    expect(matchWork(listWork('aa11'), listWork('bb22'))).toBe('none')
    expect(matchWork(listWork('aa11'), SHELF_WORK)).toBe('none')
    expect(SHELF_WORK).toEqual({ ids: ['paper.circle.shelf'], titles: [], author: '', language: '' })
  })
})

describe('the rest of the claim’s clauses — one row each', () => {
  it('takes the primary subtag from a padded, mixed-case tag and refuses one that is not two or three letters', () => {
    expect(primaryLanguage('  EN-gb ')).toBe('en')
    expect(primaryLanguage('zh_Hans')).toBe('zh')
    expect(primaryLanguage('e')).toBe('')
    expect(primaryLanguage('engl')).toBe('')
    expect(primaryLanguage('1en')).toBe('')
    expect(primaryLanguage('en1')).toBe('')
    expect(primaryLanguage('-en')).toBe('')
  })

  it('drops an article only before a space, and keeps an article-only name', () => {
    expect(normaliseName('The Whale')).toBe('whale')
    expect(normaliseName('Theodore')).toBe('theodore')
    expect(normaliseName('The')).toBe('the')
    expect(normaliseName('A')).toBe('a')
  })

  it('cuts the title proper at the first separator, keeps a title that starts with one, and falls back to the whole', () => {
    expect(titleProper('Moby-Dick; or, The Whale')).toBe('moby dick')
    expect(titleProper(': Untitled')).toBe('untitled')
    expect(titleProper(';')).toBe('')
    expect(titleProper('')).toBe('')
    expect(titleProper(undefined)).toBe('')
  })

  it('claims no title spelling for a book with no title, and no weak key without a language', () => {
    const digest = (value: string) => `h(${value})`
    const claim = claimFor({ author: 'A', languages: ['en'] }, digest)
    expect(claim.titles).toEqual([])
    expect(indexKeys({ ids: ['x'], titles: ['t'], author: 'a', language: '' })).toEqual(['s:x'])
    expect(indexKeys({ ids: ['x'], titles: ['t'], author: 'a', language: 'en' })).toEqual(['s:x', 'w:en:t:a'])
  })
})

describe('a list claim', () => {
  it('is built only from a list id, so listIdOf reads back what listWork wrote', () => {
    expect(listIdOf(listWork('ab12'))).toBe('ab12')
    for (const bad of ['', 'nope', 'AB12', 'a'.repeat(65), '../x']) {
      expect(() => listWork(bad), bad).toThrow(/is not a list id/u)
    }
  })
})

describe('the language clause of a match, every way round', () => {
  const claim = (language: string, ids: string[] = ['id1']) => ({ ids, titles: ['t'], author: 'a', language })
  it('refuses a shared identifier across two named, different languages, and allows it when either side is silent', () => {
    expect(matchWork(claim('en'), claim('fr'))).toBe('none')
    expect(matchWork(claim('fr'), claim('en'))).toBe('none')
    expect(matchWork(claim('en'), claim(''))).toBe('strong')
    expect(matchWork(claim(''), claim('en'))).toBe('strong')
    expect(matchWork(claim(''), claim(''))).toBe('strong')
    expect(matchWork(claim('en'), claim('en'))).toBe('strong')
  })
})

describe('two books that name no author', () => {
  it('do not meet on the weak key, however alike their titles', () => {
    const digest = (value: string) => `h(${value})`
    const one = claimFor({ title: 'Dune', languages: ['en'] }, digest)
    const two = claimFor({ title: 'Dune', languages: ['en'] }, digest)
    expect(one.author).toBe('')
    expect(matchWork(one, two)).toBe('none')
    const named = claimFor({ title: 'Dune', author: 'Herbert', languages: ['en'] }, digest)
    expect(matchWork(named, claimFor({ title: 'Dune', author: 'Herbert', languages: ['en'] }, digest))).toBe('weak')
  })
})

describe('two languages, one title, one author', () => {
  it('do not meet on the weak key', () => {
    const digest = (value: string) => `h(${value})`
    expect(matchWork(claimFor({ title: 'Dune', author: 'Herbert', languages: ['en'] }, digest), claimFor({ title: 'Dune', author: 'Herbert', languages: ['fr'] }, digest))).toBe('none')
  })
})
