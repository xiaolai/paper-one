import { describe, expect, it } from 'vitest'
import { canonicalJson, chainHash, checkPage, signedBytes, type Page } from '../../../kernel'
import { pageCrypto, unhex } from './crypto'

/**
 * The platform bindings `page.ts` was written against and never had.
 *
 * ⚠️ **EVERY PROPERTY `page.test.ts` PROVES WAS PROVED AGAINST A STUB.** Its
 * `PageCrypto` returns whatever the test asked for — which is right for testing
 * the ORDER of the checks and says nothing about whether a real signature ever
 * verifies. This file is the other half.
 */

/* ── the cross-language vector ─────────────────────────────────────────────
 *
 * ⚠️ **ED25519 IS DETERMINISTIC: one seed and one message give one signature,
 * byte for byte.** So the same three constants are pinned in Rust
 * (`person.rs::the_golden_vector_the_typescript_pins`), and a divergence in
 * EITHER implementation fails on one side or the other. `wire.md` asks for
 * exactly this — *"a signature that verifies on one machine and fails on
 * another would look like corruption rather than like a bug"* — and without a
 * shared vector the two sides are only ever tested against themselves.
 */
const SEED = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const PUBLIC_KEY = '207a067892821e25d770f1fba0c47c11ff4b813e54162ece9eb839e076231ab6'
const MESSAGE = 'paper.circle.1.page\n{"v":1}'
const SIGNATURE =
  'ad0030e977f97ebc1ce1a26cb7f82be5b6ce8825055c34b3205cd9836362482e' +
  '32c1ac229f64eec6fdf18288908cf27913e4e0c847b70268b4b9e5f94dd2310c'

describe('the golden vector both languages pin', () => {
  it('verifies the signature Rust produces from the same seed', () => {
    expect(pageCrypto.verify(PUBLIC_KEY, MESSAGE, SIGNATURE)).toBe(true)
  })

  it('refuses it over any other message', () => {
    /* One byte of the message, changed. The whole point of a signature. */
    expect(pageCrypto.verify(PUBLIC_KEY, `${MESSAGE} `, SIGNATURE)).toBe(false)
    expect(pageCrypto.verify(PUBLIC_KEY, 'paper.circle.1.page\n{"v":2}', SIGNATURE)).toBe(false)
  })

  it('refuses it under any other key', () => {
    const other = `1${PUBLIC_KEY.slice(1)}`
    expect(pageCrypto.verify(other, MESSAGE, SIGNATURE)).toBe(false)
  })

  it('refuses a signature with one bit turned over', () => {
    const bent = `${SIGNATURE.slice(0, 127)}d`
    expect(bent).not.toBe(SIGNATURE)
    expect(pageCrypto.verify(PUBLIC_KEY, MESSAGE, bent)).toBe(false)
  })

  it('keeps the seed out of the public key, which is the whole asymmetry', () => {
    /* A seed that could be read off the public key would make every device's
       delegation forgeable by anyone who has seen it. */
    expect(PUBLIC_KEY).not.toBe(SEED)
  })
})

describe('what a peer can put in a signature field', () => {
  /**
   * ⚠️ **THE LIBRARY'S OWN HEX DECODER THROWS, AND EVERY ARGUMENT HERE IS WIRE
   * DATA.** `checkPage`'s contract is to turn a bad page into a REFUSAL; a
   * decoder that throws turns each of these into an unhandled rejection in the
   * middle of a receive loop instead. Each case below was a crash.
   */
  const bad: readonly (readonly [string, string, string])[] = [
    ['an empty signature', PUBLIC_KEY, ''],
    ['a short signature', PUBLIC_KEY, 'ab'],
    ['an odd-length signature', PUBLIC_KEY, SIGNATURE.slice(0, 127)],
    ['a long signature', PUBLIC_KEY, `${SIGNATURE}00`],
    ['a non-hex signature', PUBLIC_KEY, 'z'.repeat(128)],
    ['an upper-case signature', PUBLIC_KEY, SIGNATURE.toUpperCase()],
    ['a multi-byte character', PUBLIC_KEY, 'é'.repeat(128)],
    ['an empty key', '', SIGNATURE],
    ['a short key', 'ab', SIGNATURE],
    ['a non-hex key', 'z'.repeat(64), SIGNATURE],
    ['an upper-case key', PUBLIC_KEY.toUpperCase(), SIGNATURE],
    /* Right length, right alphabet, not a point on the curve — which a hostile
       peer can produce at will, and which the library throws on. */
    ['a key that is not a curve point', 'f'.repeat(64), SIGNATURE],
    ['a signature that is not a curve point', PUBLIC_KEY, 'f'.repeat(128)],
  ]

  for (const [what, key, sig] of bad) {
    it(`answers false rather than throwing for ${what}`, () => {
      expect(() => pageCrypto.verify(key, MESSAGE, sig)).not.toThrow()
      expect(pageCrypto.verify(key, MESSAGE, sig)).toBe(false)
    })
  }

  it('refuses four megabytes of it without reading four megabytes', () => {
    /* The length check comes first, so a hostile field costs a comparison. */
    expect(pageCrypto.verify(PUBLIC_KEY, MESSAGE, 'a'.repeat(4 * 1024 * 1024))).toBe(false)
  })
})

describe('the hash the chain is built from', () => {
  it('is SHA-256, against the vector everybody publishes', () => {
    expect(pageCrypto.hash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('hashes the empty string rather than refusing it', () => {
    /* `chainHash` is called on the FIRST page, whose `prevPageHash` is `''`. */
    expect(pageCrypto.hash('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('hashes the UTF-8 bytes of the text, not its UTF-16 units', () => {
    /* ⚠️ **A PAGE'S ENTRIES CARRY QUOTES FROM REAL BOOKS.** A hash taken over
       UTF-16 code units agrees with a Rust one for ASCII and diverges the
       moment somebody shares a sentence with an accent in it — the worst
       possible failure schedule, because every test written in English passes.
       Pinned to the value, not to itself: the first spelling of this assertion
       compared `hash('é')` against `'' + hash('é')` and could not fail. */
    expect(pageCrypto.hash('é')).toBe(
      '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
    )
    expect(new TextEncoder().encode('é')).toHaveLength(2)
    expect(pageCrypto.hash('e')).toBe(
      '3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea',
    )
  })

  it('gives a different chain for a different page', () => {
    expect(chainHash(pageCrypto, '{"a":1}')).not.toBe(chainHash(pageCrypto, '{"a":2}'))
    expect(chainHash(pageCrypto, '{"a":1}')).toHaveLength(64)
  })
})

describe('a whole page, checked with the real crypto', () => {
  /* The two halves meeting. Everything above tests one primitive; this is the
     kernel's own check running against bindings that actually compute. */
  const page: Page = {
    v: 1,
    person: PUBLIC_KEY,
    work: { ids: [], titles: ['aa'], author: 'bb', language: 'en' },
    device: PUBLIC_KEY,
    from: 1,
    to: 1,
    prevPageHash: '',
    entries: [],
    roster: [PUBLIC_KEY],
    revocations: 0,
    delegation: 'd',
    sig: SIGNATURE,
  }

  it('refuses a page whose signature is over other bytes', () => {
    /* ⚠️ **`received` IS THE PAGE AS IT ARRIVED, `sig` INCLUDED.** `signedBytes`
       drops `sig` before canonicalising because that is what a signature covers;
       `isCanonical` compares against the WHOLE page. Passing the signed bytes
       here answers `not-canonical` and never reaches the signature — which is
       what the first version of this test did, and it looked like it was
       testing the signature. */
    const received = canonicalJson(page)
    expect(checkPage(page, received, pageCrypto, PUBLIC_KEY, '', () => true)).toBe('bad-signature')
    /* And the signed bytes really are a different string, or the note above
       would be describing nothing. */
    expect(signedBytes('page', 1, page)).not.toContain(SIGNATURE)
  })

  it('reaches the signature only after the cheap checks', () => {
    /* ⚠️ **THE ORDER IS THE SECURITY PROPERTY, and it is why the crypto had to
       be synchronous.** A peer that can make us verify a signature on
       malformed input has found a cheap way to spend our CPU. A page with the
       wrong version costs a comparison, not an Ed25519 verify. */
    expect(checkPage({ ...page, v: 2 }, '', pageCrypto, PUBLIC_KEY, '', () => true)).toBe('version')
  })
})

describe('a key nobody can hold the secret half of', () => {
  /**
   * ⚠️ **MEASURED: `verify(0…0, anything, 0…0)` ANSWERS TRUE.** The all-zero
   * public key is Ed25519's identity point, and the verification equation is
   * satisfied trivially by it — so a page claiming device `0…0` with signature
   * `0…0` passes the signature check outright. `checkPage` verifies with
   * `page.device`, which comes from a peer.
   *
   * What stops it going further today is that `canSpeak` also requires the
   * device to be on the roster this side holds. A check whose safety depends on
   * an unrelated check elsewhere is one refactor away from being the whole
   * story, so this refuses small-order keys itself.
   */
  it('refuses the identity point, which would otherwise verify anything', () => {
    expect(pageCrypto.verify('0'.repeat(64), 'any message at all', '0'.repeat(128))).toBe(false)
    expect(pageCrypto.verify('0'.repeat(64), MESSAGE, '0'.repeat(128))).toBe(false)
  })

  it('refuses a key that is not a point on the curve at all', () => {
    /* ⚠️ **THE LIBRARY THROWS FOR THESE, AND A THROW IS NOT A REFUSAL** — it is
       an unhandled rejection in the middle of a receive loop. `ff…ff` is out of
       the field's range; `02 00…00` is in range and is not a `y` with a square
       root. A hostile peer can write either into a device id. */
    expect(pageCrypto.verify('f'.repeat(64), MESSAGE, SIGNATURE)).toBe(false)
    expect(pageCrypto.verify(`02${'00'.repeat(31)}`, MESSAGE, SIGNATURE)).toBe(false)
    expect(() => pageCrypto.verify('f'.repeat(64), MESSAGE, SIGNATURE)).not.toThrow()
  })

  it('still accepts a real key, so the refusal is not blanket', () => {
    expect(pageCrypto.verify(PUBLIC_KEY, MESSAGE, SIGNATURE)).toBe(true)
  })
})

describe('decoding a hex field from the wire', () => {
  /**
   * ⚠️ **TESTED DIRECTLY, BECAUSE `verify` CANNOT SEE THE DIFFERENCE.** A byte
   * decoded wrongly makes a signature that does not verify; so does refusing to
   * decode. Both answer `false`, so every one of these cases is invisible from
   * outside — and the cheap-first ordering depends on the refusal happening
   * here rather than in the curve arithmetic.
   */
  it('decodes lower-case hex to the bytes it names', () => {
    expect(unhex('000fa0ff', 8)).toEqual(new Uint8Array([0x00, 0x0f, 0xa0, 0xff]))
    expect(unhex('deadbeef', 8)).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
  })

  it('refuses a bad digit in either half of a byte', () => {
    /* ⚠️ **BOTH NIBBLES, ONE AT A TIME.** A fixture whose characters are all
       invalid exercises the first check and leaves the second untested — and a
       decoder that only looked at the high nibble would read `az` as `a0`. */
    expect(unhex('za', 2)).toBeNull()
    expect(unhex('az', 2)).toBeNull()
    expect(unhex('a0zf', 4)).toBeNull()
    expect(unhex('0aфf', 4)).toBeNull()
  })

  it('refuses a digit below the digits and above the letters', () => {
    /* `/` is one below `0`, `:` one above `9`, `` ` `` one below `a`, `g` one
       above `f` — the four boundaries the two ranges have. */
    for (const bad of ['/a', ':a', '`a', 'ga', 'a/', 'a:', 'a`', 'ag']) {
      expect(unhex(bad, 2), bad).toBeNull()
    }
  })

  it('accepts every digit at the edge of each range', () => {
    expect(unhex('09', 2)).toEqual(new Uint8Array([0x09]))
    expect(unhex('af', 2)).toEqual(new Uint8Array([0xaf]))
    expect(unhex('f0', 2)).toEqual(new Uint8Array([0xf0]))
  })

  it('refuses upper case rather than folding it', () => {
    /* Canonical form is the basis of every signature check here, and a value
       with two spellings is a value two peers can disagree about. */
    expect(unhex('AB', 2)).toBeNull()
  })

  it('refuses any length but the one asked for', () => {
    expect(unhex('', 2)).toBeNull()
    expect(unhex('a', 2)).toBeNull()
    expect(unhex('abc', 2)).toBeNull()
    expect(unhex('ab', 2)).not.toBeNull()
  })
})
