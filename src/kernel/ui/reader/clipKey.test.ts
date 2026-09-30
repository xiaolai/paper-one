import { describe, expect, it } from 'vitest'
import { fnv1a64, textDigest } from './clipKey'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('fnv1a64', () => {
  it('answers the published vectors, which is what makes it one function with the Rust half', () => {
    /* ⚠️ PINNED, NOT TRUSTED. These three are FNV-1a 64's own published test
       vectors, and `clips.rs` asserts the same three. The digest is in every
       clip's filename, so a change here renames every clip a reader has — and a
       missing file reads as a section that was never rendered, which is silent. */
    expect(fnv1a64(bytes('')).toString(16)).toBe('cbf29ce484222325')
    expect(fnv1a64(bytes('a')).toString(16)).toBe('af63dc4c8601ec8c')
    expect(fnv1a64(bytes('foobar')).toString(16)).toBe('85944171f73967e8')
  })

  it('wraps at 64 bits rather than growing without bound', () => {
    /* A BigInt has no width, so the mask is the only thing making this the
       64-bit function. Without it the value keeps growing and agrees with
       nothing. */
    const long = fnv1a64(bytes('x'.repeat(200)))
    expect(long).toBeLessThanOrEqual(0xffff_ffff_ffff_ffffn)
    expect(long).toBeGreaterThanOrEqual(0n)
  })

  it('reads every byte, so a change anywhere in the text is seen', () => {
    const base = fnv1a64(bytes('the quick brown fox'))
    expect(fnv1a64(bytes('the quick brown box'))).not.toBe(base)
    /* The LAST byte too: a loop that stopped one short would pass every test
       above and miss a typo at the end of a chapter. */
    expect(fnv1a64(bytes('the quick brown fox.'))).not.toBe(base)
    /* And the first. */
    expect(fnv1a64(bytes('The quick brown fox'))).not.toBe(base)
  })

  it('hashes bytes and not code units, so an astral character counts as its bytes', () => {
    /* 🜁 is one code point, two UTF-16 units and four UTF-8 bytes. Hashing code
       units would give a different answer from the Rust half for every book with
       an emoji or a CJK character in it — which here is most of them. */
    const astral = '\u{1f600}'
    expect(bytes(astral)).toHaveLength(4)
    expect(fnv1a64(bytes(astral))).not.toBe(fnv1a64(new Uint8Array([0xd8, 0x3d, 0xde, 0x00])))
  })
})

describe('textDigest', () => {
  it('names the algorithm, the length and the hash', () => {
    expect(textDigest('foobar')).toBe('fnv1a64:6:85944171f73967e8')
    expect(textDigest('')).toBe('fnv1a64:0:cbf29ce484222325')
  })

  it('pads the hash to sixteen digits, so two digests are the same width', () => {
    /* A hash whose top bits are zero prints short, and a comparison against a
       padded one would then miss. Every digest is sixteen hex digits. */
    for (const text of ['', 'a', 'a book', '春天', 'x'.repeat(1000)]) {
      const [, , hash] = textDigest(text).split(':')
      expect(hash).toHaveLength(16)
    }
  })

  it('counts the length in CHARACTERS and hashes the BYTES', () => {
    /* Two units, deliberately: the characters are what the rest of the reader
       counts in, and the bytes are what agrees with Rust. A CJK section shows
       the difference — 2 characters, 6 bytes. */
    const text = '春天'
    expect(text).toHaveLength(2)
    expect(bytes(text)).toHaveLength(6)
    expect(textDigest(text).startsWith('fnv1a64:2:')).toBe(true)
  })

  it('separates two texts of one length and two lengths of one text', () => {
    expect(textDigest('ab')).not.toBe(textDigest('ba'))
    /* The length is what makes a collision need two coincidences. Two strings
       cannot be built that collide on FNV by hand, so what is checked is that
       the length is genuinely in the value. */
    expect(textDigest('a').split(':')[1]).toBe('1')
    expect(textDigest('aa').split(':')[1]).toBe('2')
  })

  it('is the same answer every time, which is the whole of what a key needs', () => {
    const text = 'Chapter Eight The Power of Illusions'
    expect(textDigest(text)).toBe(textDigest(text))
  })

  it('costs milliseconds on a real section, not seconds', () => {
    /* The character-weighted median section of this shelf is 48 043 characters —
       WI-34.0's measurement — and the digest is computed once before a render
       that takes minutes. Measured at 3.8 ms in Node 24; the bound here is loose
       enough to survive a loaded machine and tight enough to catch an
       accidentally quadratic rewrite. */
    const section = 'The quick brown fox jumps over the lazy dog. '.repeat(1068)
    expect(section.length).toBeGreaterThan(48_000)
    const started = performance.now()
    textDigest(section)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
