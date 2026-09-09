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
 *
 * ⚠️ **`unhex`, `digit` AND `unusable` ARE BYTE-IDENTICAL TO THE CIRCLE'S, AND
 * THEY CANNOT BE SHARED FROM ANYWHERE.** A capability may import another
 * capability's `index.ts` only when its manifest declares it, and never a
 * capability's internals; the kernel is the only place both could reach and
 * the kernel deliberately carries no crypto dependency — which is the entire
 * reason `PageCrypto` and `PublicCrypto` are parameters. So the duplication
 * stays, and what is added is the thing that makes duplication safe: BOTH
 * files are held to the same golden vector, the same one Rust pins, so an
 * edit to one that changes its answer fails a test rather than drifting.
 * Found by audit; the remedy is the test, not a shared module the rules
 * forbid.
 */

/**
 * Ed25519 signing is defined over SHA-512, and the library does not choose one.
 *
 * Wired at module scope so a caller cannot forget. What holds the binding is
 * the known-answer test in `crypto.test.ts`, not the comparison that used to
 * stand below — see the note there.
 */
hashes.sha512 = sha512

/* ⚠️ **A GUARD STOOD HERE AND IT COULD NOT DETECT THE THING IT NAMED.**
   `if (hashes.sha512 !== sha512) throw` compares a WRITABLE property with the
   value assigned to it on the line above, so it is true by construction. The
   failure it claimed to catch — a version bump that RENAMES the slot — makes
   the assignment create an unused property and leaves the comparison passing,
   while every verify throws `hashes.sha512 not set` at the first real
   envelope. A check that cannot fail for its own stated reason is worse than
   none: it reads as coverage. Found by audit.

   What replaces it is a KNOWN-ANSWER test — a real signature, verified
   against a pinned public key and message, in `crypto.test.ts`. A renamed
   slot fails it at build time, which is when a version bump is looked at,
   and it costs nothing at import. */

const KEY_HEX = 64
const SIG_HEX = 128

/**
 * Whether a public key is one nobody can hold the secret half of.
 *
 * ⚠️ **AN ALL-ZERO PUBLIC KEY VERIFIES AN ALL-ZERO SIGNATURE OVER ANY MESSAGE**
 * — measured in `circle/lib/crypto.ts`, not theorised.
 *
 * ⚠️ **IT IS NOT THE IDENTITY POINT, AND THIS SAID IT WAS.** The identity
 * encodes as `01` followed by thirty-one zero bytes; thirty-two zero bytes is
 * `y = 0`, which is a point of ORDER FOUR. Both are in the small-order
 * subgroup and `isSmallOrder` refuses both, so the CODE was right — but a
 * comment that misnames the value is a comment somebody will check the code
 * against and "correct". The property that matters is smallness of order, not
 * identity. Found by audit.
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
