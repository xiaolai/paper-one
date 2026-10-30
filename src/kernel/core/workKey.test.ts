import { describe, expect, it } from 'vitest'
import { BUILD_IDS, CORPUS_BUILDS } from './markCorpus.testkit'
import { sameWork, workKey } from './workKey'

/**
 * The work key (WI-21.3).
 *
 * `identifier` is only worth persisting if two devices holding two builds can
 * be asked whether they are holding the same work — and *"derives the same work
 * key"* was an acceptance criterion with no callable surface behind it until
 * this module existed. These are the oracle.
 */

describe('workKey', () => {
  it('says nothing when the book declares nothing', () => {
    /* ⚠️ NULL, NOT A KEY OVER THE EMPTY STRING. Most books on a shelf declare
       no identifier; one shared key for all of them would make the entire
       library one work, which is the worst answer this can give. */
    expect(workKey(undefined)).toBeNull()
    expect(workKey('')).toBeNull()
    expect(workKey('   ')).toBeNull()
    expect(sameWork(undefined, undefined)).toBe(false)
    expect(sameWork('', '')).toBe(false)
  })

  it('gives one key to an ISBN spelled four ways', () => {
    /* THE WHOLE POINT. A commercial EPUB writes `urn:isbn:` and thirteen
       digits; a library record of the same edition writes ten, hyphenated.
       As strings they disagree about a book they both name. */
    const expected = 'isbn:9780142437247'
    expect(workKey('urn:isbn:9780142437247')?.key).toBe(expected)
    expect(workKey('ISBN 978-0-14-243724-7')?.key).toBe(expected)
    expect(workKey('9780142437247')?.key).toBe(expected)
    /* The ten-digit form of the SAME edition — `978` prepended, check digit
       recomputed, because the ten-digit check digit does not carry over. */
    expect(workKey('0142437247')?.key).toBe(expected)
    expect(workKey('isbn:0-14-243724-7')?.key).toBe(expected)
    expect(sameWork('urn:isbn:9780142437247', '0-14-243724-7')).toBe(true)
  })

  it('handles the X check digit, which is the one a digit-only rule drops', () => {
    /* An ISBN-10's check digit can be `X` for ten. A shape test written as
       ten digits refuses every such book — roughly one in eleven of them. */
    const key = workKey('080442957X')
    expect(key?.kind).toBe('isbn')
    expect(key?.key).toBe('isbn:9780804429573')
  })

  it('refuses a number that fails its own check digit rather than believing it', () => {
    /* ⚠️ AN EQUAL KEY IS THE STRONG SIGNAL, so a wrong one merges two unrelated
       works. A mistyped ISBN falls through to `opaque`, where it is still
       compared and simply not believed. */
    expect(workKey('9780142437248')?.kind).toBe('opaque')
    expect(workKey('0142437248')?.kind).toBe('opaque')
    /* And it is still a key, so a book with a typo'd ISBN still matches
       ITSELF on the other device. */
    expect(sameWork('9780142437248', '9780142437248')).toBe(true)
  })

  it('refuses a valid EAN-13 that is not in an ISBN prefix', () => {
    /* ⚠️ EVERY ISBN-13 IS `978` OR `979`. A thirteen-digit barcode outside those
       two GS1 prefixes is a tin of beans with a perfectly valid check digit,
       and minting an `isbn:` key for it — the strongest signal here — would
       merge it with a book. Found by an adversarial audit of this file. */
    const beans = '5000112637922'
    expect(workKey(beans)?.kind).toBe('opaque')
    /* 979 IS an ISBN prefix and must still be accepted — musicland and the
       newer publisher ranges live there. */
    expect(workKey('9791234567896')?.kind).toBe('isbn')
  })

  it('does not fold the case of an identifier it does not understand', () => {
    /* ⚠️ A `dc:identifier` IS OFTEN A URI, AND A URI'S PATH IS CASE-SENSITIVE.
       `…/Moby-Dick` and `…/moby-dick` can be two different documents, so
       lowercasing the opaque branch merged identifiers that name different
       things — in the branch that exists precisely because nothing here knows
       what the value means. The UUID and ISBN branches DO normalise, because
       their specs say the case is not significant. */
    expect(workKey('https://example.org/Moby-Dick')?.key).toBe('id:https://example.org/Moby-Dick')
    expect(sameWork('https://example.org/Moby-Dick', 'https://example.org/moby-dick')).toBe(false)
    /* ⚠️ AND INTERNAL WHITESPACE IS NOT FOLDED EITHER. The XML-indent argument
       for squeezing it is wrong: pretty-printing puts whitespace at the ENDS of
       the element text, which `trim` removes. A double space INSIDE an
       identifier is a character in a scheme this branch does not understand,
       and the file's own asymmetry decides the case — a false merge costs far
       more than a false split. */
    expect(sameWork('urn:x:a b', 'urn:x:a\n  b')).toBe(false)
    expect(sameWork('catalog:A  B', 'catalog:A B')).toBe(false)
    /* Surrounding whitespace IS still trimmed — that one really is the
       serialisation, and it is what `<dc:identifier>\n  urn:x:a\n</…>` produces. */
    expect(sameWork('  urn:x:a  ', 'urn:x:a')).toBe(true)
  })

  it('does not go hunting for digits inside a URL', () => {
    /* `https://www.gutenberg.org/ebooks/2701` holds a digit run and is not an
       ISBN. Reading one out of arbitrary text is how two unrelated works end
       up sharing a key. */
    const key = workKey('https://www.gutenberg.org/ebooks/2701')
    expect(key?.kind).toBe('opaque')
    expect(key?.key).toBe('id:https://www.gutenberg.org/ebooks/2701')
  })

  it('folds a UUID’s case and its urn prefix, and nothing else', () => {
    expect(workKey('urn:uuid:1B2C3D4E-5F60-7182-93A4-B5C6D7E8F901')?.key).toBe(
      'uuid:1b2c3d4e-5f60-7182-93a4-b5c6d7e8f901',
    )
    expect(workKey('1b2c3d4e-5f60-7182-93a4-b5c6d7e8f901')?.kind).toBe('uuid')
    expect(sameWork('urn:uuid:1B2C3D4E-5F60-7182-93A4-B5C6D7E8F901', '1b2c3d4e-5f60-7182-93a4-b5c6d7e8f901')).toBe(true)
  })

  it('is idempotent and symmetric, which is what "the same key on both devices" means', () => {
    /* The acceptance criterion, as a property. Two replicas run the same code
       over the same string and must agree — so the function may not depend on
       anything but its argument, and it must be stable under being asked
       twice. */
    for (const declared of [
      'urn:isbn:9780142437247',
      'urn:uuid:1b2c3d4e-5f60-7182-93a4-b5c6d7e8f901',
      'https://standardebooks.org/ebooks/herman-melville/moby-dick',
      '  Spaced   Out  ',
      'catalog:A  B',
    ]) {
      expect(workKey(declared)).toEqual(workKey(declared))
      expect(sameWork(declared, declared)).toBe(true)
    }
  })

  it('keeps the corpus’s three builds three different works', () => {
    /* HONESTY ABOUT WHAT THIS CANNOT DO. Three real builds of Moby-Dick
       declare three unrelated identifiers — a Gutenberg URL, a Standard
       Ebooks URL and an ISBN — so the key says they are different works, and
       it is WRONG. That is the documented limitation stated as a test rather
       than as a comment: an unequal key is almost no evidence, and anything
       built on this must not read one as "these are not the same book". */
    const keys = BUILD_IDS.map((id) => workKey(CORPUS_BUILDS[id].identifier)?.key)
    expect(new Set(keys).size).toBe(3)
    expect(sameWork(CORPUS_BUILDS.gutenberg.identifier, CORPUS_BUILDS['standard-ebooks'].identifier)).toBe(false)
  })
})
