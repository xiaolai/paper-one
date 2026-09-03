import { Point, hashes, verify as edVerify } from '@noble/ed25519'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { PageCrypto } from '../../../kernel'

/**
 * The platform bindings `checkPage` and `chainHash` are injected with.
 *
 * ⚠️ **`PageCrypto` HAD NO PRODUCTION IMPLEMENTATION AT ALL.** `page.ts` was
 * written, tested and pure, and the only thing that ever satisfied its crypto
 * interface was a stub inside its own test file. Every property the module
 * proves — canonical bytes, integers only, the chain, the signature — was
 * proved against a `verify` that returned whatever the test wanted.
 *
 * ## Why these are synchronous, and why that decided the library
 *
 * `checkPage` runs its checks in the order that costs least to refuse, and the
 * signature is deliberately last: *"a peer that can make us do it for free on
 * malformed input has found a cheap way to spend our CPU."* That ordering only
 * exists if the whole check is one function, which means the crypto has to be
 * synchronous. `crypto.subtle` is not, and BLAKE3 already goes to Rust over an
 * async IPC — so neither of the mechanisms this repository already had could
 * supply it without splitting `checkPage` in two and moving its guarantee from
 * the compiler to a convention.
 *
 * ## This module is NOT browser-safe, and `page.ts` still is
 *
 * The kernel module keeps no dependency on anything here — that is the whole
 * reason the crypto is a parameter. `check-browser-safe.mjs` holds `page.ts`
 * to that; this file is a capability's, where a platform binding belongs.
 */

/**
 * Ed25519 signing is defined over SHA-512, and the library does not choose one.
 *
 * ⚠️ **UNWIRED, EVERY VERIFY THROWS `hashes.sha512 not set`** — at the first
 * page from a real peer, in a receive path whose job is to turn a bad page into
 * a refusal. A throw there is not a refusal; it is an unhandled rejection in
 * the middle of a transfer. Wired at module scope so it cannot be forgotten by
 * a caller, and asserted below so it cannot be silently undone by a version
 * bump that renames the slot.
 */
hashes.sha512 = sha512

/* A build in which the line above stopped taking is a build where every
   signature check throws. Cheap, once, at load.

   The branch cannot be reached from a test: reaching it means the library has
   renamed the slot, which is the version bump this exists to catch and not
   something a fixture can arrange. The cost of keeping it is one comparison at
   import; the cost of not having it is every page refused, at run time, with a
   message about SHA-512. */
// Stryker disable all
if (hashes.sha512 !== sha512) {
  throw new Error('Paper: @noble/ed25519 did not accept the SHA-512 binding')
}
// Stryker restore all

/** 64 lower-case hex characters, and nothing else. */
const KEY_HEX = 64
/** 128 lower-case hex characters, and nothing else. */
const SIG_HEX = 128

/**
 * Whether a public key is one nobody can hold the secret half of.
 *
 * ⚠️ **AN ALL-ZERO PUBLIC KEY VERIFIES AN ALL-ZERO SIGNATURE OVER ANY MESSAGE
 * — MEASURED, not theorised.** It is the identity point, and Ed25519's
 * verification equation is satisfied trivially by it: `verify(0…0, anything,
 * 0…0)` answers TRUE. Every small-order point has the same shape of problem.
 *
 * `checkPage` verifies with `page.device`, which arrives from a peer, so
 * without this a page claiming device `0…0` and signature `0…0` passes the
 * signature check outright. What stops it going further today is that
 * `canSpeak` also requires the device to be on the roster this side HOLDS —
 * so the hole needs a second mistake to be reachable. That is not a reason to
 * leave it: a check whose safety depends on an unrelated check elsewhere is
 * one refactor away from being the whole story.
 *
 * Ed25519 verifiers are expected to refuse these, and most do.
 */
function unusable(key: Uint8Array): boolean {
  /* Not a point at all — `ff…ff` is out of the field's range, `02 00…00` is a
     `y` with no square root. Refused for a different reason, by the same
     answer: `edVerify` throws on the same input into the outer catch and also
     answers `false`. What this buys is that the refusal is named where it is
     understood, one step earlier. */
  // Stryker disable BlockStatement,BooleanLiteral
  try {
    return Point.fromBytes(key).isSmallOrder()
  } catch {
    return true
  }
  // Stryker restore BlockStatement,BooleanLiteral
}

/**
 * Hex to bytes, or `null` — exported so it can be tested for its own contract.
 *
 * ⚠️ **EVERY WRONG ANSWER THIS COULD GIVE IS INVISIBLE FROM `verify`**, which
 * answers `false` either way: a byte decoded wrongly makes a signature that
 * does not verify, and so does refusing to decode at all. Testing it through
 * `verify` therefore proves nothing about it — and the cheap-first ordering
 * `checkPage` depends on runs through here, so it is worth its own tests.
 *
 * ⚠️ **THE LIBRARY'S OWN DECODER THROWS, AND EVERYTHING HERE IS WIRE DATA.**
 * A key or a signature arrives from a peer who may have written anything in
 * that field — an odd length, a `Z`, an emoji, four megabytes of it. Every one
 * of those is a page to refuse, and a decoder that throws turns each into a
 * crash in the receive loop instead. Upper-case is refused too rather than
 * folded: canonical form is the whole basis of the signature check, and a value
 * with two spellings is a value two peers can disagree about.
 */
export function unhex(text: string, chars: number): Uint8Array | null {
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

/** One lower-case hex digit's value, or `-1`. */
function digit(code: number): number {
  /* Stryker disable next-line ConditionalExpression: the lower bound cannot be
     observed. Every code below `0` yields a NEGATIVE value from the
     subtraction, which `unhex` refuses on the next line — so dropping the
     bound moves where the answer comes from and not what it is. */
  if (code >= 48 && code <= 57) return code - 48
  if (code >= 97 && code <= 102) return code - 87
  return -1
}

/**
 * Ed25519 and SHA-256, for `checkPage` and `chainHash`.
 *
 * ⚠️ **`verify` RETURNS `false` AND NEVER THROWS.** It is called on values a
 * peer chose, inside a function whose whole contract is to answer with a
 * refusal — see `unhex` above, and note that the library also throws on a
 * structurally invalid point, which a hostile peer can produce at will.
 */
export const pageCrypto: PageCrypto = {
  verify: (key, message, sig) => {
    const publicKey = unhex(key, KEY_HEX)
    const signature = unhex(sig, SIG_HEX)
    /* Stryker disable next-line ConditionalExpression,LogicalOperator: not
       reachable from any edit TypeScript would accept — `unusable` and `edVerify` both take a
       `Uint8Array`, so a version of this line that let `null` through does not
       compile. Stryker mutates the JAVASCRIPT, where the types are gone, and
       `Point.fromBytes(null)` then throws into `unusable`'s own catch. */
    if (publicKey === null || signature === null) return false
    if (unusable(publicKey)) return false
    /* No input is currently known to reach the catch: `unusable` takes every
       key that throws, and no signature of the right LENGTH makes this library
       throw (measured across out-of-range, all-zero and non-canonical values).
       It stays because a throw here is not a refusal but an unhandled
       rejection in the middle of a receive loop, and the thing that would
       introduce one is a library upgrade — exactly when nobody is looking. */
    // Stryker disable BlockStatement,BooleanLiteral
    try {
      return edVerify(signature, utf8ToBytes(message), publicKey)
    } catch {
      return false
    }
    // Stryker restore BlockStatement,BooleanLiteral
  },
  hash: (value) => bytesToHex(sha256(utf8ToBytes(value))),
}
