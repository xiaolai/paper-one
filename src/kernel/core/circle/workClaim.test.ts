import { describe, expect, it } from 'vitest'
import { CORPUS_BUILDS, BUILD_IDS } from '../markCorpus.testkit'
import { claimFor, indexKeys, matchWork, normaliseName, primaryLanguage } from './workClaim'

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
