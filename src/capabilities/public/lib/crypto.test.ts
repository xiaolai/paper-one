import { describe, expect, it } from 'vitest'
import { publicCrypto } from './crypto'

/**
 * The public verifier, against a signature nothing in this repository made.
 *
 * ⚠️ **THIS FILE DID NOT EXIST, AND THE ONLY CHECK ON THE SHA-512 BINDING WAS
 * ONE THAT COULD NOT FAIL.** `hashes.sha512 = sha512` followed by
 * `if (hashes.sha512 !== sha512) throw` compares a writable property with what
 * was just assigned to it — true by construction — while the failure it named,
 * a version bump that RENAMES the slot, leaves the comparison passing and every
 * verify throwing at the first envelope from a real stranger. A known answer is
 * the only thing that catches that, and it catches it at build time.
 *
 * ⚠️ **AND IT IS THE SAME VECTOR THE CIRCLE PINS**, which is the same one Rust
 * pins in `person.rs::the_golden_vector_the_typescript_pins`. `unhex`, `digit`
 * and `unusable` are byte-identical in the two capabilities and cannot be
 * shared — a capability may not import another's internals, and the kernel
 * deliberately carries no crypto dependency — so what makes the duplication
 * safe is that both are held to one answer. An edit to either that changes its
 * answer fails a test rather than drifting.
 */

const PUBLIC_KEY = '207a067892821e25d770f1fba0c47c11ff4b813e54162ece9eb839e076231ab6'
const MESSAGE = 'paper.circle.1.page\n{"v":1}'
const SIGNATURE =
  'ad0030e977f97ebc1ce1a26cb7f82be5b6ce8825055c34b3205cd9836362482e' +
  '32c1ac229f64eec6fdf18288908cf27913e4e0c847b70268b4b9e5f94dd2310c'

describe('the golden vector, verified by the public binding too', () => {
  it('verifies a signature made outside this process', () => {
    expect(publicCrypto.verify(PUBLIC_KEY, MESSAGE, SIGNATURE)).toBe(true)
  })

  it('refuses it over any other message, under any other key, one bit bent', () => {
    expect(publicCrypto.verify(PUBLIC_KEY, `${MESSAGE} `, SIGNATURE)).toBe(false)
    expect(publicCrypto.verify(`1${PUBLIC_KEY.slice(1)}`, MESSAGE, SIGNATURE)).toBe(false)
    const bent = `${SIGNATURE.slice(0, 127)}d`
    expect(bent).not.toBe(SIGNATURE)
    expect(publicCrypto.verify(PUBLIC_KEY, MESSAGE, bent)).toBe(false)
  })
})

describe('a key nobody holds the secret half of', () => {
  it('refuses the all-zero key, which is order four and not the identity', () => {
    /* ⚠️ **AN ALL-ZERO KEY VERIFIES AN ALL-ZERO SIGNATURE OVER ANY MESSAGE.**
       Here that check is the whole defence rather than half of it: the public
       layer has no roster, so a voice is whoever signed. */
    expect(publicCrypto.verify('0'.repeat(64), 'anything at all', '0'.repeat(128))).toBe(false)
  })

  it('refuses the identity itself, which encodes differently', () => {
    /* `01` and thirty-one zero bytes — the value the comment used to name for
       the line above. Both are small-order and both are refused; what the code
       tests is the ORDER, which is why it was right while the comment was
       not. */
    const identity = `01${'00'.repeat(31)}`
    expect(publicCrypto.verify(identity, 'anything at all', '0'.repeat(128))).toBe(false)
  })

  it('refuses hex that is not hex, and lengths that are not the lengths', () => {
    expect(publicCrypto.verify('zz'.repeat(32), MESSAGE, SIGNATURE)).toBe(false)
    expect(publicCrypto.verify(PUBLIC_KEY.toUpperCase(), MESSAGE, SIGNATURE)).toBe(false)
    expect(publicCrypto.verify(PUBLIC_KEY.slice(2), MESSAGE, SIGNATURE)).toBe(false)
    expect(publicCrypto.verify(PUBLIC_KEY, MESSAGE, SIGNATURE.slice(2))).toBe(false)
  })
})
