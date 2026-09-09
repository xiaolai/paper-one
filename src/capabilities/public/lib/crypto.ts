import { Point, hashes, verify as edVerify } from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { PublicCrypto } from '../../../kernel'

/**
 * Ed25519, for the public envelope — phase 26.
 *
 * ⚠️ **A SECOND BINDING RATHER THAN A SHARED ONE, AND THE DUPLICATION IS THE
 * POINT.** `circle/lib/crypto.ts` supplies `PageCrypto`, which is `verify` plus
 * `hash`; this supplies `PublicCrypto`, which is `verify` alone. Importing the
 * circle's would make a capability reach into another capability's internals —
 * which the boundary rules refuse — and, worse, would put one object behind two
 * verifiers with opposite defaults. The primitive is the same and the contract
 * is not.
 *
 * Everything below is the reasoning `circle/lib/crypto.ts` records at length,
 * and it applies here for the same reasons and with sharper stakes: the keys
 * arrive from strangers rather than from admitted people.
 */

/**
 * Ed25519 signing is defined over SHA-512, and the library does not choose one.
 *
 * Wired at module scope so a caller cannot forget, and asserted below so a
 * version bump that renames the slot fails at load rather than at the first
 * envelope from a real stranger.
 */
hashes.sha512 = sha512

// Stryker disable all
if (hashes.sha512 !== sha512) {
  throw new Error('Paper: @noble/ed25519 did not accept the SHA-512 binding')
}
// Stryker restore all

const KEY_HEX = 64
const SIG_HEX = 128

/**
 * Whether a public key is one nobody can hold the secret half of.
 *
 * ⚠️ **AN ALL-ZERO PUBLIC KEY VERIFIES AN ALL-ZERO SIGNATURE OVER ANY MESSAGE**
 * — measured in `circle/lib/crypto.ts`, not theorised. It is the identity
 * point, and Ed25519's verification equation is satisfied trivially by it.
 *
 * ⚠️ **AND HERE THERE IS NO SECOND CHECK BEHIND IT.** The circle survives the
 * hole because `canSpeak` also requires the device to be on a roster this side
 * holds, so it needs two mistakes to be reachable. The public layer has no
 * roster and no admission by design — a voice is whoever signed — so this check
 * is the whole of the defence rather than half of it.
 */
function unusable(key: Uint8Array): boolean {
  // Stryker disable BlockStatement,BooleanLiteral
  try {
    return Point.fromBytes(key).isSmallOrder()
  } catch {
    return true
  }
  // Stryker restore BlockStatement,BooleanLiteral
}

/** Hex to bytes, or `null`. Never throws: every input here is wire data. */
function unhex(text: string, chars: number): Uint8Array | null {
  if (text.length !== chars) return null
  const out = new Uint8Array(chars / 2)
  for (let i = 0; i < chars; i += 2) {
    const hi = digit(text.charCodeAt(i))
    const lo = digit(text.charCodeAt(i + 1))
    if (hi < 0 || lo < 0) return null
    out[i / 2] = hi * 16 + lo
  }
  return out
}

/** One lower-case hex digit's value, or `-1`. Upper case is refused, not folded. */
function digit(code: number): number {
  /* Stryker disable next-line ConditionalExpression: every code below `0`
     yields a negative value the caller refuses on the next line. */
  if (code >= 48 && code <= 57) return code - 48
  if (code >= 97 && code <= 102) return code - 87
  return -1
}

/**
 * ⚠️ **RETURNS `false` AND NEVER THROWS.** It is called on values a stranger
 * chose, inside a function whose whole contract is to answer with a refusal —
 * and a throw in a receive loop is an unhandled rejection rather than a
 * refusal.
 */
export const publicCrypto: PublicCrypto = {
  verify: (key, message, sig) => {
    const publicKey = unhex(key, KEY_HEX)
    const signature = unhex(sig, SIG_HEX)
    if (publicKey === null || signature === null) return false
    if (unusable(publicKey)) return false
    // Stryker disable BlockStatement,BooleanLiteral
    try {
      return edVerify(signature, utf8ToBytes(message), publicKey)
    } catch {
      return false
    }
    // Stryker restore BlockStatement,BooleanLiteral
  },
}
