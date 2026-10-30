import { describe, expect, it } from 'vitest'
import { isContentHash } from './bookFolder'
import {
  adopts,
  folderForFetch,
  mayAdoptIdentity,
  planShareImport,
  mayPublishNotes,
  offerAbsentBecause,
  offerabilityOf,
  type PublicOfferability,
} from './publicShare'

const HASH = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

describe('isContentHash', () => {
  it('takes 64 lowercase hex and nothing else', () => {
    expect(isContentHash(HASH)).toBe(true)
    expect(isContentHash('0123456789abcdef'.repeat(4))).toBe(true)
  })

  it('refuses upper case, because one digest with two spellings is two keys', () => {
    /* ⚠️ A book offered as `AB…` and asked for as `ab…` is a book offered and
       refused at the same time. Folding the case would hide it; refusing names
       it at the edge. */
    expect(isContentHash(HASH.toUpperCase())).toBe(false)
  })

  it('refuses the wrong length, non-hex, and everything that is not a string', () => {
    for (const refused of [
      '',
      HASH.slice(0, 63),
      `${HASH}0`,
      'g'.repeat(64),
      '../../etc/passwd',
      undefined,
      null,
      42,
      { toString: () => HASH },
      [HASH],
    ]) {
      expect(isContentHash(refused)).toBe(false)
    }
  })
})

describe('offerabilityOf — WI-25.2', () => {
  it('offers a book that has bytes and a digest', () => {
    expect(offerabilityOf({ hasContent: true, contentHash: HASH })).toBe('offerable')
  })

  it('says the digest is missing when the bytes are here and it is not', () => {
    /* ⚠️ **THE WHOLE OF WI-25.2's GAP.** `contentHash` is OPTIONAL — stamped by
       sync's backfill, so a build composed without `sync` has none at all — and
       a surface that just hid the control would look broken. */
    expect(offerabilityOf({ hasContent: true })).toBe('no-content-hash')
    expect(offerabilityOf({ hasContent: true, contentHash: '' })).toBe('no-content-hash')
    expect(offerabilityOf({ hasContent: true, contentHash: HASH.toUpperCase() })).toBe('no-content-hash')
  })

  it('says the content is missing when there are no bytes, whatever the digest', () => {
    /* Content first: a book whose bytes are on another device cannot be served
       from here, and telling the reader about a fingerprint would send them
       looking for a backfill that could not have run. */
    expect(offerabilityOf({ hasContent: false, contentHash: HASH })).toBe('no-content')
    expect(offerabilityOf({})).toBe('no-content')
    expect(offerabilityOf({ contentHash: HASH })).toBe('no-content')
  })

  it('treats an unknown hasContent as no content rather than as content', () => {
    /* `hasContent` is `boolean | undefined` on `IndexedBook`, and `undefined`
       means the scan has not answered. Failing closed is the direction that
       cannot offer a book this device does not hold. */
    expect(offerabilityOf({ hasContent: undefined, contentHash: HASH })).toBe('no-content')
  })
})

describe('offerAbsentBecause', () => {
  it('is null exactly when the control is offered', () => {
    expect(offerAbsentBecause('offerable')).toBeNull()
  })

  it('gives a sentence for every state that is not offerable', () => {
    /* ⚠️ **A CALLER RENDERS THE CONTROL OR THE SENTENCE, NEVER NEITHER.** The
       same contract `shareAbsentBecause` carries in `circle/foreign.ts`, and
       the reason WI-25.2's acceptance says "and says why". */
    const states: readonly PublicOfferability[] = ['offerable', 'no-content', 'no-content-hash']
    for (const state of states) {
      const sentence = offerAbsentBecause(state)
      if (state === 'offerable') continue
      expect(sentence, state).not.toBeNull()
      expect(sentence!.length, state).toBeGreaterThan(0)
      expect(sentence!.endsWith('.'), state).toBe(true)
    }
  })

  it('never names an identifier a reader has no use for', () => {
    /* A sentence that says `contentHash` is a sentence written for the person
       who wrote the code. */
    for (const state of ['no-content', 'no-content-hash'] as const) {
      expect(offerAbsentBecause(state)).not.toMatch(/contentHash|BLAKE3|hash/u)
    }
  })
})

describe('mayPublishNotes — WI-25.9', () => {
  it('needs the name and not the bytes', () => {
    /* ⚠️ **A READER MAY PUBLISH NOTES ON A BOOK THEY MAY NOT REDISTRIBUTE**,
       and that is the common case. A version of this that required
       `hasContent` would look more careful and would implement the exact
       conflation WI-25.9 exists to prevent. */
    expect(mayPublishNotes({ contentHash: HASH, hasContent: false })).toBe(true)
    expect(mayPublishNotes({ contentHash: HASH })).toBe(true)
  })

  it('refuses a book with no digest, because there is no name to publish under', () => {
    expect(mayPublishNotes({ hasContent: true })).toBe(false)
    expect(mayPublishNotes({})).toBe(false)
  })

  it('differs from offerability for a book whose bytes are elsewhere', () => {
    /* The property the two functions exist to keep apart, stated as one
       assertion so a refactor that fused them fails here. */
    const elsewhere = { contentHash: HASH, hasContent: false }
    expect(mayPublishNotes(elsewhere)).toBe(true)
    expect(offerabilityOf(elsewhere)).not.toBe('offerable')
  })
})

describe('mayAdoptIdentity — WI-25.4, which blocks release', () => {
  it('adopts only when the whole-file digests agree', () => {
    expect(mayAdoptIdentity(HASH, HASH)).toBe('same-book')
    expect(adopts(mayAdoptIdentity(HASH, HASH))).toBe(true)
  })

  it('refuses when the digests disagree, however the ids matched', () => {
    /* ⚠️ **THE COLLISION IS REAL AND ALREADY FIXTURED.** `marks.test.ts` builds
       two unequal 65 MiB files with one `contentId`, and positions key on
       `bookId` alone — so without this a downloaded file takes an annotated
       book's anchors and its saved position. */
    expect(mayAdoptIdentity(HASH, OTHER)).toBe('different-book')
    expect(adopts(mayAdoptIdentity(HASH, OTHER))).toBe(false)
  })

  it('refuses when either side has no digest', () => {
    /* ⚠️ **THE OPPOSITE OF `marksArchive.ts`, DELIBERATELY.** That path leaves
       an id match alone on a missing hash, because refusing on absence would
       break every import on a build that computes no digest. Here the file came
       from a STRANGER over a content-addressed transport whose premise is that
       the hash is known, so a fetch with nothing to compare is a fetch that
       should not have happened. */
    expect(mayAdoptIdentity(undefined, HASH)).toBe('unverifiable')
    expect(mayAdoptIdentity(HASH, undefined)).toBe('unverifiable')
    expect(mayAdoptIdentity(undefined, undefined)).toBe('unverifiable')
    for (const verdict of ['unverifiable'] as const) expect(adopts(verdict)).toBe(false)
  })

  it('refuses a malformed digest rather than comparing it as a string', () => {
    /* ⚠️ **TWO EQUAL NON-HASHES WOULD OTHERWISE ADOPT.** `'' === ''` and
       `'nope' === 'nope'` are both true, and a comparison that ran before the
       shape check would answer `same-book` for either — which is exactly the
       adoption this rule exists to refuse. */
    expect(mayAdoptIdentity('', '')).toBe('unverifiable')
    expect(mayAdoptIdentity('nope', 'nope')).toBe('unverifiable')
    expect(mayAdoptIdentity(HASH.toUpperCase(), HASH)).toBe('unverifiable')
  })

  it('is symmetric, because "the same file" has no direction', () => {
    expect(mayAdoptIdentity(HASH, OTHER)).toBe(mayAdoptIdentity(OTHER, HASH))
    expect(mayAdoptIdentity(undefined, HASH)).toBe(mayAdoptIdentity(HASH, undefined))
  })
})

describe('the identity verdict is diagnostic about SIZE and never authorized by it', () => {
  it('refuses two different digests whatever the file size', () => {
    /* ⚠️ **SIZE PERMITS THE COLLISION; IT DOES NOT PRODUCE ONE** — phase 25's
       own draft got this wrong and said the disagreement "happens for any file
       over 64 MiB". `mayAdoptIdentity` takes no size and must not grow one: a
       small file with two different digests is still two different files.

       (`identityIsSampled(size)` used to state the same thing as an exported
       predicate with no caller anywhere. What it answered — whether the exact
       check is load-bearing at this size — changed no verdict, which is what
       this asserts directly.) */
    expect(mayAdoptIdentity(HASH, OTHER)).toBe('different-book')
    expect(mayAdoptIdentity(HASH, HASH)).toBe('same-book')
  })
})

describe('planShareImport — the guard, as the decision that acts on it', () => {
  it('sends a book nobody here has to a folder of its own', () => {
    const plan = planShareImport(HASH, undefined)
    expect(plan).toEqual({ kind: 'into-new', folder: folderForFetch(HASH), why: 'no-candidate' })
  })

  it('fetches into a held row that has the same digest and no bytes', () => {
    /* The useful case, and the ONLY one where a fetch may write into an
       existing book's folder: the held record names this exact whole-file
       digest, so the destination is safe by construction rather than by care. */
    expect(planShareImport(HASH, { bookId: 'book:1', contentHash: HASH, hasContent: false })).toEqual({
      kind: 'into-held',
      bookId: 'book:1',
    })
  })

  it('fetches nothing when the exact bytes are already here', () => {
    expect(planShareImport(HASH, { bookId: 'book:1', contentHash: HASH, hasContent: true })).toEqual({
      kind: 'already-held',
      bookId: 'book:1',
    })
  })

  it('never writes over a held book whose digest disagrees', () => {
    /* ⚠️ **WI-25.4, AS THE ONE ASSERTION THAT MATTERS.** A candidate that
       matched by a SAMPLED id and disagrees on the whole file must not get the
       held book's folder — that is how a download takes an annotated book's
       anchors and its saved position. */
    const plan = planShareImport(HASH, { bookId: 'book:1', contentHash: OTHER, hasContent: false })
    expect(plan).toEqual({ kind: 'into-new', folder: folderForFetch(HASH), why: 'different-book' })
    expect(plan).not.toHaveProperty('bookId')
  })

  it('never writes over a held book whose digest is unknown', () => {
    /* A held row with no `contentHash` settles nothing, and the transport this
       arrived over has no excuse for not knowing — see `mayAdoptIdentity`. */
    expect(planShareImport(HASH, { bookId: 'book:1', hasContent: false })).toEqual({
      kind: 'into-new',
      folder: folderForFetch(HASH),
      why: 'unverifiable',
    })
  })

  it('refuses a wanted hash that is not a hash, rather than planning around it', () => {
    /* A folder name is derived from it. A caller that passed a path fragment
       would otherwise be handed one back. */
    for (const bad of ['', '../..', HASH.toUpperCase(), `${HASH}0`]) {
      expect(() => planShareImport(bad, undefined)).toThrow(/not a content hash/u)
      expect(() => folderForFetch(bad)).toThrow(/not a content hash/u)
    }
  })
})

describe('folderForFetch', () => {
  it('is a folder name the vault will accept', () => {
    /* `validate_folder` in `paths.rs`: alphanumeric and underscore, 1..=80. */
    const folder = folderForFetch(HASH)
    expect(folder).toMatch(/^[A-Za-z0-9_]{1,80}$/u)
  })

  it('is the same for the same book, so a retry resumes rather than littering', () => {
    expect(folderForFetch(HASH)).toBe(folderForFetch(HASH))
    expect(folderForFetch(HASH)).not.toBe(folderForFetch(OTHER))
  })
})
