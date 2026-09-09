import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIFETIME_MS,
  EMPTY_PUBLIC_FILE,
  NO_DECISIONS,
  PUBLIC_VERSION,
  bind,
  blockVoice,
  canonicalJson,
  overlayKeyOf,
  type PublicEnvelope,
  type PublicFile,
  type ResolveResult,
  type VoiceBinding,
  type VoiceDecisions,
} from '../../../kernel'
/* ⚠️ **THE MINT, NOT A CAST.** `reanchor.test.ts` walks `src/` for
   `as ResolvedCfi` and holds the set to exactly two files — the resolver and
   this testkit — because *"if a second minting site exists, the type is
   decoration"*. A test fixture writing the cast itself is precisely the
   experiment-left-behind case that walk exists to fail on. */
import { resolvedCfiForTesting } from '../../../kernel/testkit'
import { publicAnnotationsFor } from './overlay'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const PERSON = 'c'.repeat(64)
const BOOK = 'd'.repeat(64)
const SIG = 'e'.repeat(128)
const NOW = 1_700_000_000_000

function line(over: Partial<PublicEnvelope> = {}): string {
  return canonicalJson({
    v: PUBLIC_VERSION,
    voice: A,
    book: BOOK,
    seq: 1,
    at: NOW,
    expires: NOW + DEFAULT_LIFETIME_MS,
    pub: 'p1',
    op: 'note',
    passage: { quote: 'a sentence', prefix: 'before ', suffix: ' after', chapter: '' },
    sig: SIG,
    ...over,
  } as PublicEnvelope)
}

const fileOf = (...lines: readonly string[]): PublicFile => ({
  ...EMPTY_PUBLIC_FILE,
  held: lines.map((received, i) => {
    const parsed = JSON.parse(received) as PublicEnvelope
    return { received, voice: parsed.voice, pub: parsed.pub, seq: i + 1, at: NOW + i, expires: NOW + DEFAULT_LIFETIME_MS }
  }),
})

/** A resolver that places everything it is given, one section apart or not. */
const placesAll = (sameAnchor = false) => {
  const asked: string[] = []
  return {
    asked,
    resolve: (pending: readonly { id: string }[]): Promise<ResolveResult> => {
      asked.push(...pending.map((one) => one.id))
      return Promise.resolve({
        found: pending.map((one, i) => ({
          id: one.id,
          cfi: resolvedCfiForTesting(`/6/${sameAnchor ? 4 : 4 + i * 2}`),
          sectionIndex: 0,
        })),
        missed: [],
        complete: true,
      })
    },
  }
}

const decide = (...bindings: readonly VoiceBinding[]): VoiceDecisions =>
  bindings.reduce((held, one) => {
    const result = bind(held, one)
    if (typeof result === 'string') throw new Error(result)
    return result.decisions
  }, NO_DECISIONS)

describe('a public annotation is tagged as one', () => {
  it('says so in a FIELD the painter reads, not in a prefix only it read', async () => {
    /* ⚠️ **`attachForeign` LABELLED EVERYTHING WITH THE CIRCLE'S PAINTER
       KIND.** This capability said "stranger" by prefixing the person id with
       `public:`, `useOverlays` dropped everything but the key and the count,
       and a stranger's mark was drawn in a friend's hue. The audience is on
       the opinion now, and the painter branches on it. */
    const drawn = await publicAnnotationsFor(fileOf(line()), NO_DECISIONS, {
      bookId: 'book:1',
      resolve: placesAll().resolve,
    })
    expect(drawn[0]?.opinions[0]?.audience).toBe('public')
  })

  it('keys apart from a circle mark with the same publication id', () => {
    /* A voice id and a person id are both 64 hex, so the audience segment is
       what keeps them apart — and there is now ONE definition of it. */
    expect(overlayKeyOf('public', A, 'p1')).not.toBe(overlayKeyOf('circle', PERSON, 'p1'))
  })
})

describe('publicAnnotationsFor', () => {
  it('anchors what is held and hands it over', async () => {
    const resolver = placesAll()
    const drawn = await publicAnnotationsFor(fileOf(line()), NO_DECISIONS, { bookId: 'book:1', resolve: resolver.resolve })
    expect(drawn).toHaveLength(1)
    expect(drawn[0]).toMatchObject({ person: A, quote: 'a sentence' })
    expect(drawn[0]?.opinions).toEqual([{ pub: 'p1', audience: 'public', author: A }])
  })

  it('does not anchor a blocked voice at all', async () => {
    /* ⚠️ **ANCHORING IS THE EXPENSIVE STEP.** Filtering after it would let a
       blocked voice keep spending the reader's main thread. */
    const resolver = placesAll()
    const drawn = await publicAnnotationsFor(fileOf(line()), blockVoice(NO_DECISIONS, A), {
      bookId: 'book:1',
      resolve: resolver.resolve,
    })
    expect(drawn).toEqual([])
    expect(resolver.asked, 'a blocked voice was walked anyway').toEqual([])
  })

  it('draws an unbound voice at the constant weight, however many there are', async () => {
    /* ⚠️ **"4 OF 11 READERS" IS A SENTENCE AN ATTACKER WRITES.** One free key
       and a hundred must draw the same. */
    const many = Array.from({ length: 100 }, (_, i) =>
      line({ voice: `${i}`.padStart(64, '0'), pub: `p${i}` }),
    )
    const drawn = await publicAnnotationsFor(fileOf(...many), NO_DECISIONS, {
      bookId: 'book:1',
      resolve: placesAll(true).resolve,
    })
    expect(drawn).toHaveLength(1)
    /* ⚠️ **NOBODY IDENTIFIABLE, WHICH IS NOT ZERO READERS AND NOT A HUNDRED.**
       `readersAmong` floors an empty set at one, so the mark is drawn and the
       hundred keys buy nothing. */
    expect(drawn[0]?.people).toEqual([])
  })

  it('keeps every voice’s own words at one anchor, not just the first', async () => {
    /* ⚠️ **GROUPING IS FOR THE WEIGHT, NOT FOR THE WORDS.** `byAnchor.has`
       dropped every publication after the first at a passage, so a second
       stranger's note was parsed, verified, anchored and then discarded along
       with who wrote it. */
    const drawn = await publicAnnotationsFor(
      fileOf(
        line({ passage: { quote: 'a sentence', prefix: 'before ', suffix: ' after', chapter: '', note: 'mine' } }),
        line({ voice: B, pub: 'p2', passage: { quote: 'a sentence', prefix: 'before ', suffix: ' after', chapter: '', note: 'and mine' } }),
      ),
      NO_DECISIONS,
      { bookId: 'book:1', resolve: placesAll(true).resolve },
    )
    expect(drawn).toHaveLength(1)
    expect(drawn[0]?.opinions.map((one) => one.note)).toEqual(['mine', 'and mine'])
    expect(drawn[0]?.opinions.map((one) => one.author)).toEqual([A, B])
  })

  it('counts a bound voice as the person it belongs to, once', async () => {
    const bound = decide(
      { voice: A, person: PERSON, assertedBy: PERSON, at: 1 },
      { voice: B, person: PERSON, assertedBy: PERSON, at: 1 },
    )
    const drawn = await publicAnnotationsFor(fileOf(line(), line({ voice: B, pub: 'p2' })), bound, {
      bookId: 'book:1',
      resolve: placesAll(true).resolve,
    })
    /* Two voices, one person, one anchor: one mark naming one person. */
    expect(drawn).toHaveLength(1)
    expect(drawn[0]?.people).toEqual([PERSON])
  })

  it('drops a line that will not parse rather than failing the book', async () => {
    const drawn = await publicAnnotationsFor(
      { ...EMPTY_PUBLIC_FILE, held: [{ received: '{ not json', voice: A, pub: 'p', seq: 1, at: NOW, expires: NOW + 1 }] },
      NO_DECISIONS,
      { bookId: 'book:1', resolve: placesAll().resolve },
    )
    expect(drawn).toEqual([])
  })

  it('draws nothing for a withdrawal, which carries no passage', async () => {
    const withdrawal = canonicalJson({
      v: PUBLIC_VERSION,
      voice: A,
      book: BOOK,
      seq: 2,
      at: NOW,
      expires: NOW + DEFAULT_LIFETIME_MS,
      pub: 'p1',
      op: 'unnote',
      sig: SIG,
    })
    const drawn = await publicAnnotationsFor(fileOf(withdrawal), NO_DECISIONS, {
      bookId: 'book:1',
      resolve: placesAll().resolve,
    })
    expect(drawn).toEqual([])
  })

  it('walks nothing when nothing is held', async () => {
    const resolver = placesAll()
    expect(await publicAnnotationsFor(EMPTY_PUBLIC_FILE, NO_DECISIONS, { bookId: 'book:1', resolve: resolver.resolve })).toEqual(
      [],
    )
    expect(resolver.asked).toEqual([])
  })

  it('drops a passage the book does not contain, which is a legitimate state', async () => {
    const drawn = await publicAnnotationsFor(fileOf(line()), NO_DECISIONS, {
      bookId: 'book:1',
      resolve: () => Promise.resolve({ found: [], missed: [overlayKeyOf('public', A, 'p1')], complete: true }),
    })
    expect(drawn).toEqual([])
  })
})
