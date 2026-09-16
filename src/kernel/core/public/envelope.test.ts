import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../canonicalJson'
import {
  DEFAULT_LIFETIME_MS,
  MAX_CHAPTER,
  MAX_CLOCK_SKEW_MS,
  MAX_ENVELOPE_BYTES,
  MAX_LIFETIME_MS,
  MAX_NOTE,
  MAX_PUB,
  MAX_QUOTE,
  PUBLIC_OPS,
  PUBLIC_VERSION,
  byteLengthOf,
  integersOnlyEnvelope,
  isPublicEnvelopeShape,
  mintNote,
  mintPublicationId,
  mintUnnote,
  publicSignedBytes,
  readPublicEnvelope,
  sealPublic,
  type PublicCrypto,
  type PublicEnvelope,
  type PublicRefusal,
} from './envelope'

const VOICE = 'a'.repeat(64)
const BOOK = 'b'.repeat(64)
const SIG = 'c'.repeat(128)
const NOW = 1_700_000_000_000

/** Accepts exactly one message under one key — a stand-in for Ed25519. */
function crypto(accepts: readonly string[] = []): PublicCrypto & { readonly asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    verify: (key, message, sig) => {
      asked.push(message)
      return key === VOICE && sig === SIG && accepts.includes(message)
    },
  }
}

function note(over: Partial<PublicEnvelope> = {}): PublicEnvelope {
  return {
    v: PUBLIC_VERSION,
    voice: VOICE,
    book: BOOK,
    seq: 1,
    at: NOW - 1000,
    expires: NOW + DEFAULT_LIFETIME_MS,
    pub: 'p1',
    op: 'note',
    passage: { quote: 'a sentence', prefix: 'before ', suffix: ' after', chapter: 'One' },
    sig: SIG,
    ...over,
  } as PublicEnvelope
}

const signed = (envelope: PublicEnvelope): string => publicSignedBytes(envelope.v, envelope)
const never = () => false

/** A withdrawal of `note()`'s publication. */
function withdrawal(over: Partial<PublicEnvelope> = {}): PublicEnvelope {
  const { passage: _gone, ...rest } = note() as unknown as Record<string, unknown>
  return { ...rest, op: 'unnote', seq: 2, ...over } as PublicEnvelope
}

describe('publicSignedBytes', () => {
  it('uses the public domain and never the circle’s', () => {
    /* ⚠️ **DOMAIN SEPARATION IS WHAT STOPS A CIRCLE PAGE'S SIGNATURE BEING
       REPLAYED AS A PUBLIC ANNOTATION**, and the other way round. */
    const bytes = signed(note())
    expect(bytes.startsWith(`paper.public.${PUBLIC_VERSION}.envelope\n`)).toBe(true)
    expect(bytes).not.toMatch(/paper\.circle/u)
  })

  it('drops the signature and nothing else', () => {
    const envelope = note()
    const { sig: _dropped, ...rest } = envelope
    expect(signed(envelope).endsWith(canonicalJson(rest))).toBe(true)
    expect(signed(envelope)).not.toContain(SIG)
  })

  it('carries the version, so a v1 signature cannot be replayed as a v2', () => {
    expect(publicSignedBytes(1, note())).not.toBe(publicSignedBytes(2, note()))
  })
})

describe('isPublicEnvelopeShape', () => {
  it('takes a well-formed note and a well-formed withdrawal', () => {
    expect(isPublicEnvelopeShape(note())).toBe(true)
    const { passage: _gone, ...rest } = note() as unknown as Record<string, unknown>
    expect(isPublicEnvelopeShape({ ...rest, op: 'unnote' })).toBe(true)
  })

  it('refuses a withdrawal that carries a passage', () => {
    /* ⚠️ **THE DISCLOSURE RULE, ENFORCED BY THE SHAPE.** A tombstone repeating
       what it retracts discloses the withdrawn passage to somebody who never
       saw the publication. `log.ts` states it for `unshare`; here the field set
       is what refuses it, rather than a reviewer noticing. */
    expect(isPublicEnvelopeShape({ ...note(), op: 'unnote' })).toBe(false)
  })

  it('refuses a field no op names', () => {
    expect(isPublicEnvelopeShape({ ...note(), person: 'somebody' })).toBe(false)
    expect(isPublicEnvelopeShape({ ...note(), device: VOICE })).toBe(false)
    expect(isPublicEnvelopeShape({ ...note(), epoch: 1 })).toBe(false)
  })

  it('refuses a passage field no passage names', () => {
    expect(isPublicEnvelopeShape(note({ passage: { quote: 'q', prefix: '', suffix: '', chapter: '', tint: 'green' } } as never))).toBe(
      false,
    )
  })

  it('refuses a voice, book or signature of the wrong shape', () => {
    for (const bad of ['', VOICE.slice(0, 63), VOICE.toUpperCase(), `${VOICE}0`, 'g'.repeat(64)]) {
      expect(isPublicEnvelopeShape(note({ voice: bad })), `voice ${bad}`).toBe(false)
      expect(isPublicEnvelopeShape(note({ book: bad })), `book ${bad}`).toBe(false)
    }
    expect(isPublicEnvelopeShape(note({ sig: SIG.slice(0, 127) }))).toBe(false)
    expect(isPublicEnvelopeShape(note({ sig: SIG.toUpperCase() }))).toBe(false)
  })

  it('refuses an empty or oversized publication id', () => {
    expect(isPublicEnvelopeShape(note({ pub: '' }))).toBe(false)
    expect(isPublicEnvelopeShape(note({ pub: 'p'.repeat(129) }))).toBe(false)
  })

  it('bounds the quote, its neighbours and the note', () => {
    const long = (n: number) => 'x'.repeat(n)
    expect(isPublicEnvelopeShape(note({ passage: { quote: long(MAX_QUOTE), prefix: '', suffix: '', chapter: '' } }))).toBe(true)
    expect(isPublicEnvelopeShape(note({ passage: { quote: long(MAX_QUOTE + 1), prefix: '', suffix: '', chapter: '' } }))).toBe(false)
    expect(
      isPublicEnvelopeShape(note({ passage: { quote: 'q', prefix: '', suffix: '', chapter: '', note: long(MAX_NOTE + 1) } })),
    ).toBe(false)
  })

  it('refuses anything that is not an object with a known op', () => {
    for (const bad of [null, undefined, 42, 'note', [note()], { ...note(), op: 'rate' }]) {
      expect(isPublicEnvelopeShape(bad)).toBe(false)
    }
  })

  it('takes its operation names from PUBLIC_OPS, which nothing used to read', () => {
    /* ⚠️ **THE LIST AND THE VALIDATOR WERE TWO DEFINITIONS OF ONE THING.**
       `PUBLIC_OPS` was declared, re-exported and read by nothing while this
       validator spelled the two names out again — so the list could have
       gained a third entry with the validator never hearing about it. The
       length assertion is what makes that loud: a new operation has to arrive
       here and say what its envelope looks like. */
    expect(PUBLIC_OPS).toEqual(['note', 'unnote'])
    for (const op of PUBLIC_OPS) {
      const { passage: _passage, ...bare } = note() as PublicEnvelope & { passage?: unknown }
      const envelope = op === 'note' ? note() : { ...bare, op }
      expect(isPublicEnvelopeShape(envelope), op).toBe(true)
    }
  })
})

/**
 * The refusal one line earns, or `null` when it is accepted.
 *
 * ⚠️ **THROUGH THE ONE DOOR.** These asserted against `checkPublicEnvelope`,
 * which takes an ALREADY-SHAPE-CHECKED envelope beside its bytes and does not
 * re-check the shape — so a test could hand it a pair that no reader will ever
 * see, and a correctly signed `unnote` carrying a passage passed it while
 * `readPublicEnvelope` refused the same thing. The checker is private now and
 * this is how the same questions are asked. */
const refusalFor = (
  line: string,
  crypto: Parameters<typeof readPublicEnvelope>[1],
  now: number,
  blocked: (voice: string) => boolean,
): PublicRefusal | null => {
  const read = readPublicEnvelope(line, crypto, now, blocked)
  return typeof read === 'string' ? read : null
}

describe('the public envelope reader', () => {
  it('accepts a canonical, unexpired, correctly signed envelope', () => {
    const envelope = note()
    const received = canonicalJson(envelope)
    expect(refusalFor(received, crypto([signed(envelope)]), NOW, never)).toBeNull()
  })

  it('refuses bytes that are not their own canonical spelling', () => {
    /* ⚠️ **THIS IS WHAT MAKES "NO DUPLICATE KEYS" AND "INTEGERS ONLY"
       ENFORCEABLE.** `JSON.parse` destroys the evidence of a duplicate member
       before any parser of ours runs; re-serialising and comparing catches the
       whole family with one comparison. */
    const envelope = note()
    const received = `${canonicalJson(envelope)} `
    expect(refusalFor(received, crypto([signed(envelope)]), NOW, never)).toBe('not-canonical')
  })

  it('refuses a float, because canonical form is not its own', () => {
    const envelope = note({ at: NOW + 0.5 })
    expect(refusalFor(canonicalJson(envelope), crypto([signed(envelope)]), NOW, never)).toBe('non-integer')
  })

  it('refuses an unknown version before doing anything else', () => {
    const envelope = note({ v: 99 })
    const asked = crypto()
    expect(refusalFor(canonicalJson(envelope), asked, NOW, never)).toBe('version')
    expect(asked.asked, 'a version this build cannot read cost a signature check').toEqual([])
  })

  it('refuses an envelope past its own expiry without verifying it', () => {
    /* ⚠️ **THE EXPIRY IS THE REPLAY HORIZON.** A replayed old copy costs no
       verification at all, which is what makes suppression state boundable. */
    const envelope = note({ expires: NOW - 1 })
    const asked = crypto([signed(envelope)])
    expect(refusalFor(canonicalJson(envelope), asked, NOW, never)).toBe('expired')
    expect(asked.asked).toEqual([])
  })

  it('refuses a note whose expiry is this very moment', () => {
    const envelope = note({ expires: NOW })
    expect(refusalFor(canonicalJson(envelope), crypto([signed(envelope)]), NOW, never)).toBe('expired')
  })

  /* ⚠️ **A WITHDRAWAL PAST ITS OWN EXPIRY WAS REFUSED HERE, AND THE NOTE IT TOOK
     BACK CAME BACK.** `order.ts` keeps a withdrawal for as long as the note it
     suppresses could still be drawn, and this door refused the withdrawal first
     — so a 180-day note taken back by a two-hour withdrawal was drawn again on
     the first reload three hours later (2026-09-14). Its own expiry is the
     fold's to judge; this door still verifies it, and a note is refused here as
     it always was. */
  it('leaves a withdrawal past its own expiry to the fold, and still verifies it', () => {
    const late = withdrawal({ at: NOW - 1000, expires: NOW - 1 })
    const asked = crypto([signed(late)])
    expect(refusalFor(canonicalJson(late), asked, NOW, never), 'a withdrawal was refused for its own expiry').toBeNull()
    expect(asked.asked, 'a withdrawal the fold may keep was not verified').toEqual([signed(late)])
    expect(refusalFor(canonicalJson(late), crypto(['something else']), NOW, never)).toBe('bad-signature')
  })

  it('still refuses a withdrawal dated ahead of this clock, or claiming a lifetime this build will not keep', () => {
    const ahead = withdrawal({ at: NOW + MAX_CLOCK_SKEW_MS + 1, expires: NOW + MAX_CLOCK_SKEW_MS + 1000 })
    expect(refusalFor(canonicalJson(ahead), crypto([signed(ahead)]), NOW, never)).toBe('expired')
    const long = withdrawal({ at: NOW, expires: NOW + MAX_LIFETIME_MS + 1 })
    expect(refusalFor(canonicalJson(long), crypto([signed(long)]), NOW, never)).toBe('expired')
    const far = withdrawal({ at: NOW + MAX_CLOCK_SKEW_MS, expires: NOW + MAX_CLOCK_SKEW_MS + MAX_LIFETIME_MS + 10_000 })
    expect(refusalFor(canonicalJson(far), crypto([signed(far)]), NOW, never)).toBe('expired')
  })

  it('refuses a lifetime longer than this build accepts', () => {
    /* Without this a voice mints an envelope that expires in the year 3000 and
       the suppression record for it is unbounded by another road. */
    const envelope = note({ at: NOW, expires: NOW + MAX_LIFETIME_MS + 1 })
    expect(refusalFor(canonicalJson(envelope), crypto([signed(envelope)]), NOW, never)).toBe('expired')
    const atTheLimit = note({ at: NOW, expires: NOW + MAX_LIFETIME_MS })
    expect(refusalFor(canonicalJson(atTheLimit), crypto([signed(atTheLimit)]), NOW, never)).toBeNull()
  })

  it('refuses an expiry at or before the moment of publication', () => {
    for (const expires of [NOW - 1000, NOW - 1001]) {
      const envelope = note({ at: NOW - 1000, expires })
      expect(refusalFor(canonicalJson(envelope), crypto([signed(envelope)]), NOW, never)).toBe('malformed')
    }
  })

  it('refuses a blocked voice before verifying it', () => {
    /* ⚠️ **THE PUBLIC LAYER'S ONE IDENTITY QUESTION.** There is no roster and
       nobody to be admitted by; the only thing a reader decides about a voice
       is whether to stop hearing it. */
    const envelope = note()
    const asked = crypto([signed(envelope)])
    expect(refusalFor(canonicalJson(envelope), asked, NOW, (v: string) => v === VOICE)).toBe('blocked')
    expect(asked.asked).toEqual([])
  })

  it('hears a blocked voice take something back — silencing is a decision to hear LESS', () => {
    /* ⚠️ **THIS REFUSED A WITHDRAWAL TOO, WHICH IS THE ONE DIRECTION THE RULE
       MUST NEVER FAIL IN.** Suppression is keyed `<voice>#<pub>` and
       equivocation `<voice>#<seq>`, so an `unnote` can only ever take back a
       publication of its OWN voice and can never hide anybody else's. Refusing
       one because the reader silenced its author therefore dropped that
       author's "take it back" and left the note it took back standing — the
       reader hearing MORE of a voice for having silenced them. */
    const publication = note()
    const { passage: _gone, ...rest } = publication as unknown as Record<string, unknown>
    const withdrawal = { ...rest, op: 'unnote', seq: 2 } as PublicEnvelope
    const asked = crypto([signed(withdrawal)])
    expect(refusalFor(canonicalJson(withdrawal), asked, NOW, (v: string) => v === VOICE)).toBeNull()
    /* NON-VACUOUS: the same voice, the same predicate, and a PUBLICATION from
       it is still refused — so this is the op deciding, not a dead predicate. */
    expect(
      refusalFor(canonicalJson(publication), crypto([signed(publication)]), NOW, (v: string) => v === VOICE),
    ).toBe('blocked')
  })

  it('refuses a signature over different bytes', () => {
    const envelope = note()
    expect(refusalFor(canonicalJson(envelope), crypto(['something else']), NOW, never)).toBe('bad-signature')
  })

  it('refuses an envelope larger than the cap before canonicalising it', () => {
    const envelope = note()
    const received = canonicalJson(envelope) + ' '.repeat(MAX_ENVELOPE_BYTES)
    expect(refusalFor(received, crypto([signed(envelope)]), NOW, never)).toBe('too-large')
  })

  it('refuses a sequence below one', () => {
    for (const seq of [0, -1]) {
      const envelope = note({ seq })
      expect(refusalFor(canonicalJson(envelope), crypto([signed(envelope)]), NOW, never)).toBe('malformed')
    }
  })
})

describe('readPublicEnvelope', () => {
  it('answers the envelope and the exact bytes it verified', () => {
    const envelope = note()
    const line = canonicalJson(envelope)
    const read = readPublicEnvelope(line, crypto([signed(envelope)]), NOW, never)
    expect(read).toEqual({ envelope, received: line })
  })

  it('refuses a line that is not JSON, and one that is not an envelope', () => {
    expect(readPublicEnvelope('{ not json', crypto(), NOW, never)).toBe('malformed')
    expect(readPublicEnvelope('{"a":1}', crypto(), NOW, never)).toBe('malformed')
    expect(readPublicEnvelope('null', crypto(), NOW, never)).toBe('malformed')
  })

  it('mutating any signed field refuses the line', () => {
    /* ⚠️ **THE MUTATION TEST WI-26.2 ASKS FOR, AT DISK RELOAD.** Each variant
       is a real re-serialisation, so the bytes the verifier is handed really
       are the mutated ones — which is what makes this different from asserting
       that a comparison exists. */
    const envelope = note()
    const good = canonicalJson(envelope)
    const accepts = crypto([signed(envelope)])
    expect(readPublicEnvelope(good, accepts, NOW, never)).toHaveProperty('envelope')
    for (const mutated of [
      note({ book: 'd'.repeat(64) }),
      note({ seq: 2 }),
      note({ at: NOW - 999 }),
      note({ pub: 'p2' }),
      note({ expires: NOW + DEFAULT_LIFETIME_MS + 1 }),
      note({ passage: { quote: 'another sentence', prefix: 'before ', suffix: ' after', chapter: 'One' } }),
    ]) {
      expect(readPublicEnvelope(canonicalJson(mutated), accepts, NOW, never), canonicalJson(mutated)).toBe('bad-signature')
    }
  })

  it('a signature transplanted from a publication to a withdrawal does not verify', () => {
    /* WI-26.2's acceptance names this one specifically. */
    const publication = note()
    const { passage: _gone, ...rest } = publication as unknown as Record<string, unknown>
    const withdrawal = { ...rest, op: 'unnote' } as PublicEnvelope
    const accepts = crypto([signed(publication)])
    expect(readPublicEnvelope(canonicalJson(withdrawal), accepts, NOW, never)).toBe('bad-signature')
  })

  it('a circle page replayed as a public envelope is not even a shape', () => {
    const page = {
      v: 1,
      person: VOICE,
      work: { language: 'en', ids: [], titles: [] },
      device: VOICE,
      from: 1,
      to: 1,
      prevPageHash: '',
      entries: [],
      roster: [VOICE],
      revocations: 0,
      delegation: '{}',
      sig: SIG,
    }
    expect(readPublicEnvelope(canonicalJson(page), crypto(), NOW, never)).toBe('malformed')
  })
})

describe('bounds are counted in UTF-8 bytes', () => {
  it('refuses a multibyte quote that fits the character count but not the byte one', () => {
    /* ⚠️ **MEASURED BY AUDIT: A 10,416-CHARACTER CHINESE ENVELOPE OCCUPIES
       30,416 BYTES**, passed a character check here and was refused by Rust's
       16 KiB. A publisher could write something this build calls fine and no
       provider will store, with no error anywhere naming the disagreement. */
    const three = '文'.repeat(MAX_QUOTE - 1)
    expect(three.length).toBeLessThan(MAX_QUOTE)
    expect(new TextEncoder().encode(three).length).toBeGreaterThan(MAX_QUOTE)
    expect(isPublicEnvelopeShape(note({ passage: { quote: three, prefix: '', suffix: '', chapter: '' } }))).toBe(false)
  })

  it('refuses an envelope whose CANONICAL BYTES are over the cap, though every field is inside its own', () => {
    /* ⚠️ **THE FIELD BOUNDS DO NOT ADD UP TO THE ENVELOPE BOUND.** A note of
       four thousand NULs is exactly `MAX_NOTE` bytes of note and six bytes of
       JSON each — `\u0000` — so every field check passes and the serialised
       envelope is over 16 KiB.

       (This test used to append raw characters AFTER the closing brace and
       assert `too-large`. That line is not JSON at all, and now that the
       reader is the only door it is refused as `malformed` one step earlier —
       correctly. The property worth holding is this one, which is reachable
       with a well-formed envelope.) */
    const envelope = note({
      passage: { quote: 'q', prefix: '', suffix: '', chapter: '', note: '\u0000'.repeat(MAX_NOTE) },
    })
    expect(isPublicEnvelopeShape(envelope)).toBe(true)
    const received = canonicalJson(envelope)
    expect(byteLengthOf(received)).toBeGreaterThan(MAX_ENVELOPE_BYTES)
    expect(refusalFor(received, crypto([signed(envelope)]), NOW, never)).toBe('too-large')
  })

  it('refuses to MINT one, rather than signing something no reader will take', () => {
    /* ⚠️ **THE MINT CHECKED EVERY FIELD AND NOT THE ENVELOPE.** The same note
       minted happily, was signed, was written to the reader's own file and was
       refused by every recipient as `too-large` — including this device on its
       next read. A mint that reports success over an envelope nobody will
       accept is the exact failure the mint's own header forbids: *"it refuses
       rather than clamps"*. */
    expect(() =>
      mintNote(
        { voice: VOICE, book: BOOK, seq: 1, at: NOW, pub: 'p1' },
        { quote: 'q', prefix: '', suffix: '', chapter: '', note: '\u0000'.repeat(MAX_NOTE) },
      ),
    ).toThrow(/past the 16384 a reader accepts/u)
  })

  it('refuses to mint an expiry past a safe integer, rather than one no reader will take', () => {
    /* Two safe integers can add up to one that is not, and the reader refuses
       the result as `non-integer` — a mint that reports success and an
       envelope nobody will take. */
    expect(() =>
      mintNote(
        { voice: VOICE, book: BOOK, seq: 1, at: Number.MAX_SAFE_INTEGER, pub: 'p1' },
        { quote: 'q', prefix: '', suffix: '', chapter: '' },
      ),
    ).toThrow(/past a safe integer/u)
  })

  it('copies the caller’s passage, so mutating it cannot break the signature', () => {
    /* ⚠️ **SIGNING IS ASYNCHRONOUS AND THE PASSAGE WAS HELD BY REFERENCE.** A
       caller that reused its passage object while the signature was computed
       produced a sealed line that no longer matched the bytes that were
       signed — which arrives at the recipient as `bad-signature` and names the
       wrong cause entirely. Frozen as well as copied, so the same mistake made
       later fails at the mutation instead. */
    const passage = { quote: 'as minted', prefix: '', suffix: '', chapter: '' }
    const unsigned = mintNote({ voice: VOICE, book: BOOK, seq: 1, at: NOW, pub: 'p1' }, passage)
    ;(passage as { quote: string }).quote = 'changed underneath'
    const minted = unsigned.envelope
    if (minted.op !== 'note') throw new Error('mintNote must mint a note')
    expect(minted.passage.quote).toBe('as minted')
    expect(unsigned.signedBytes).toBe(publicSignedBytes(minted.v, minted))
    expect(() => {
      ;(minted.passage as { quote: string }).quote = 'changed after'
    }).toThrow()
  })
})

describe('the replay horizon is anchored to this device’s clock', () => {
  it('refuses a publication dated absurdly far ahead', () => {
    /* ⚠️ **MEASURED BY AUDIT: AN ENVELOPE DATED IN THE YEAR 3000 WITH A
       ONE-SECOND LIFETIME WAS ACCEPTED TODAY**, because `expires - at` was one
       second — and it would go on being accepted for a thousand years. The
       bounded replay horizon defeated by arithmetic. */
    const future = NOW + 1000 * 365 * 24 * 60 * 60 * 1000
    const envelope = note({ at: future, expires: future + 1000 })
    expect(refusalFor(canonicalJson(envelope), crypto([signed(envelope)]), NOW, never)).toBe('expired')
  })

  it('refuses an expiry further out than this build accepts from now', () => {
    const envelope = note({ at: NOW + MAX_CLOCK_SKEW_MS, expires: NOW + MAX_CLOCK_SKEW_MS + MAX_LIFETIME_MS + 10_000 })
    expect(refusalFor(canonicalJson(envelope), crypto([signed(envelope)]), NOW, never)).toBe('expired')
  })

  it('allows a clock a little ahead, because two machines routinely disagree', () => {
    /* Refusing on a one-second difference would drop honest annotations from a
       laptop whose clock had not synced. */
    const skewed = note({ at: NOW + MAX_CLOCK_SKEW_MS - 1, expires: NOW + DEFAULT_LIFETIME_MS })
    expect(refusalFor(canonicalJson(skewed), crypto([signed(skewed)]), NOW, never)).toBeNull()
  })
})

describe('minting — the writing side of the same module', () => {
  const minting = { voice: VOICE, book: BOOK, seq: 1, at: NOW, pub: 'p1' }
  const passage = { quote: 'a sentence', prefix: 'before ', suffix: ' after', chapter: 'One' }

  it('mints a note that its own verifier accepts', () => {
    /* ⚠️ **THE MINT AND THE CHECK ARE ONE MODULE SO THEY CANNOT DRIFT.** A
       builder elsewhere could canonicalise differently from the signer's input
       and produce a publication that fails its own verifier — the failure
       `isCanonical` exists to catch, arriving from the writing side. */
    const unsigned = mintNote(minting, passage)
    const line = sealPublic(unsigned, SIG)
    const parsed: unknown = JSON.parse(line)
    expect(isPublicEnvelopeShape(parsed)).toBe(true)
    expect(refusalFor(line, crypto([unsigned.signedBytes]), NOW, never)).toBeNull()
  })

  it('mints a withdrawal that carries no passage', () => {
    const unsigned = mintUnnote({ ...minting, seq: 2 })
    const line = sealPublic(unsigned, SIG)
    expect(line).not.toContain('passage')
    const parsed = JSON.parse(line) as PublicEnvelope
    expect(parsed.op).toBe('unnote')
    expect(refusalFor(line, crypto([unsigned.signedBytes]), NOW, never)).toBeNull()
  })

  it('signs exactly the bytes the verifier will recompute', () => {
    const unsigned = mintNote(minting, passage)
    const line = sealPublic(unsigned, SIG)
    const parsed = JSON.parse(line) as PublicEnvelope
    expect(publicSignedBytes(parsed.v, parsed)).toBe(unsigned.signedBytes)
  })

  it('defaults the lifetime and honours one that is given', () => {
    expect(mintNote(minting, passage).envelope.expires).toBe(NOW + DEFAULT_LIFETIME_MS)
    expect(mintNote({ ...minting, lifetimeMs: 5_000 }, passage).envelope.expires).toBe(NOW + 5_000)
  })

  it('refuses rather than clamps a lifetime past the cap', () => {
    /* Silently shortening one produces an envelope the reader did not write. */
    for (const bad of [0, -1, MAX_LIFETIME_MS + 1, 1.5]) {
      expect(() => mintNote({ ...minting, lifetimeMs: bad }, passage), String(bad)).toThrow(/lifetime/u)
    }
  })

  it('refuses a sequence below one and a time that is not one', () => {
    expect(() => mintNote({ ...minting, seq: 0 }, passage)).toThrow(/not a sequence/u)
    expect(() => mintNote({ ...minting, at: -1 }, passage)).toThrow(/not a time/u)
  })

  it('refuses a passage the shape would refuse, at the mint', () => {
    /* ⚠️ **A MALFORMED ENVELOPE THAT REACHES A SIGNER IS A SIGNATURE OVER
       SOMETHING NO RECIPIENT WILL ACCEPT** — and the reader is told it
       published. */
    const huge = { ...passage, quote: 'x'.repeat(MAX_QUOTE + 1) }
    expect(() => mintNote(minting, huge)).toThrow(/not a publishable envelope/u)
    expect(() => mintNote({ ...minting, voice: 'nope' }, passage)).toThrow(/not a publishable envelope/u)
    expect(() => mintNote({ ...minting, pub: '' }, passage)).toThrow(/not a publishable envelope/u)
  })
})

/** A note whose canonical line is exactly `bytes` long — control characters JSON spells in six bytes each fill it past the field bounds' reach. */
function noteOfBytes(bytes: number, over: Partial<PublicEnvelope> = {}): PublicEnvelope {
  const wide = { quote: 'q'.repeat(MAX_QUOTE), prefix: 'p'.repeat(MAX_QUOTE), suffix: 's'.repeat(MAX_QUOTE), chapter: 'c'.repeat(MAX_CHAPTER) }
  const rest = bytes - byteLengthOf(canonicalJson(note({ ...over, passage: { ...wide, note: '' } })))
  const sixes = Math.floor(rest / 6)
  const text = String.fromCharCode(1).repeat(sixes) + 'n'.repeat(rest - 6 * sixes)
  const made = note({ ...over, passage: { ...wide, note: text } })
  if (byteLengthOf(canonicalJson(made)) !== bytes || byteLengthOf(text) > MAX_NOTE) {
    throw new Error(`the fixture cannot make an envelope of ${bytes} bytes`)
  }
  return made
}

/**
 * What the 2026-09-15 sweep found the shape and the reader did not hold: each
 * guard asked of a test that no test put to it.
 */
describe('every field the shape names, held to its own type and bound', () => {
  /* ⚠️ **A ONE-ELEMENT ARRAY SPELLS THE STRING INSIDE IT.** A regex test, a byte
     count and a `Set` of names each turn `['aaa…']` into `'aaa…'` or refuse it
     for a different reason, so every `typeof` guard in front of them looked
     redundant — and without it an array stood where the signed field was. */
  it.each([
    ['voice', { voice: [VOICE] }],
    ['book', { book: [BOOK] }],
    ['signature', { sig: [SIG] }],
    ['publication id', { pub: ['p1'] }],
  ])('refuses a %s that is an array holding a valid one', (_name, over) => {
    expect(isPublicEnvelopeShape(note(over as never))).toBe(false)
  })

  it.each(['quote', 'prefix', 'suffix', 'chapter', 'note'])('refuses a passage %s that is an array holding a valid one', (field) => {
    const passage = { quote: 'q', prefix: '', suffix: '', chapter: '', [field]: ['x'] }
    expect(isPublicEnvelopeShape(note({ passage } as never))).toBe(false)
  })

  it.each(['v', 'seq', 'at', 'expires'])('refuses a %s that is not a number', (field) => {
    expect(isPublicEnvelopeShape(note({ [field]: '1' } as never))).toBe(false)
    expect(readPublicEnvelope(canonicalJson(note({ [field]: '1' } as never)), crypto(), NOW, never)).toBe('malformed')
  })

  it('refuses an operation that is not one of its own names, however it is spelled', () => {
    for (const op of [['note'], 'toString', 'constructor', 'rate', 42]) {
      expect(isPublicEnvelopeShape({ ...note(), op }), String(op)).toBe(false)
      const { passage: _gone, ...bare } = note() as unknown as Record<string, unknown>
      expect(isPublicEnvelopeShape({ ...bare, op }), `${String(op)} without a passage`).toBe(false)
    }
  })

  it('refuses a signature with anything before or after its 128 hex characters', () => {
    expect(isPublicEnvelopeShape(note({ sig: `${SIG}0` }))).toBe(false)
    expect(isPublicEnvelopeShape(note({ sig: `0${SIG}` }))).toBe(false)
  })

  it('takes every text field at exactly its bound, and refuses one byte past it', () => {
    const at = (field: string, bytes: number) => {
      const passage = { quote: 'q', prefix: '', suffix: '', chapter: '', [field]: 'x'.repeat(bytes) }
      return isPublicEnvelopeShape(note({ passage } as never))
    }
    for (const [field, bound] of [['prefix', MAX_QUOTE], ['suffix', MAX_QUOTE], ['chapter', MAX_CHAPTER]] as const) {
      expect(at(field, bound), `${field} at its bound`).toBe(true)
      expect(at(field, bound + 1), `${field} past its bound`).toBe(false)
    }
    expect(isPublicEnvelopeShape(note({ pub: 'p'.repeat(MAX_PUB) })), 'a publication id at its bound').toBe(true)
  })

  it('reads an envelope of exactly the size a reader accepts, and refuses one byte more', () => {
    const exact = noteOfBytes(MAX_ENVELOPE_BYTES)
    expect(refusalFor(canonicalJson(exact), crypto([signed(exact)]), NOW, never)).toBeNull()
    const over = noteOfBytes(MAX_ENVELOPE_BYTES + 1)
    expect(refusalFor(canonicalJson(over), crypto([signed(over)]), NOW, never)).toBe('too-large')
  })

  it('refuses a publication dated before the epoch, and takes one dated at it', () => {
    const before = withdrawal({ at: -1, expires: 1000 })
    expect(refusalFor(canonicalJson(before), crypto([signed(before)]), NOW, never)).toBe('malformed')
    const atZero = withdrawal({ at: 0, expires: 1000 })
    expect(refusalFor(canonicalJson(atZero), crypto([signed(atZero)]), NOW, never)).toBeNull()
  })

  it('takes the latest publication this clock allows, with the longest lifetime it allows', () => {
    /* Both bounds at once, to the millisecond: dated a whole skew ahead, and
       living the whole lifetime from there. */
    const latest = note({ at: NOW + MAX_CLOCK_SKEW_MS, expires: NOW + MAX_CLOCK_SKEW_MS + MAX_LIFETIME_MS })
    expect(refusalFor(canonicalJson(latest), crypto([signed(latest)]), NOW, never)).toBeNull()
  })

  it('allows a clock a day ahead of this one, and not more', () => {
    /* In hours rather than through the constant, so the constant is held to
       what its comment says it is. */
    const HOUR = 60 * 60 * 1000
    const ahead = note({ at: NOW + 23 * HOUR })
    expect(refusalFor(canonicalJson(ahead), crypto([signed(ahead)]), NOW, never)).toBeNull()
    const beyond = note({ at: NOW + 25 * HOUR })
    expect(refusalFor(canonicalJson(beyond), crypto([signed(beyond)]), NOW, never)).toBe('expired')
  })

  it('counts every number, and nothing that is not one, including nulls', () => {
    expect(integersOnlyEnvelope({ a: null, b: [1, 2], c: { d: 'three' } })).toBe(true)
    expect(integersOnlyEnvelope({ a: null, b: [1, 2.5] })).toBe(false)
  })
})

describe('minting at the edges of what a reader takes', () => {
  const minting = { voice: VOICE, book: BOOK, seq: 1, at: NOW, pub: 'p1' }

  it('mints the longest lifetime a reader accepts, and at the epoch', () => {
    expect(mintNote({ ...minting, lifetimeMs: MAX_LIFETIME_MS }, { quote: 'q', prefix: '', suffix: '', chapter: '' }).envelope.expires).toBe(
      NOW + MAX_LIFETIME_MS,
    )
    expect(mintUnnote({ ...minting, at: 0 }).envelope.at).toBe(0)
  })

  it('mints an envelope of exactly the size a reader accepts, and refuses one byte more', () => {
    const passageOf = (bytes: number) => {
      const made = noteOfBytes(bytes, { at: NOW, expires: NOW + DEFAULT_LIFETIME_MS })
      if (made.op !== 'note') throw new Error('the fixture must be a note')
      return made.passage
    }
    expect(() => mintNote(minting, passageOf(MAX_ENVELOPE_BYTES))).not.toThrow()
    const cause = (() => {
      try {
        mintNote(minting, passageOf(MAX_ENVELOPE_BYTES + 1))
      } catch (error) {
        return error
      }
      return null
    })()
    expect(cause).toBeInstanceOf(RangeError)
    expect((cause as Error).message).toBe(
      `public: that envelope is ${MAX_ENVELOPE_BYTES + 1} bytes, past the ${MAX_ENVELOPE_BYTES} a reader accepts`,
    )
  })
})

describe('mintPublicationId', () => {
  it('writes a byte below sixteen as two hex digits, not one', () => {
    expect(mintPublicationId((bytes) => bytes.fill(0x01))).toBe('01'.repeat(16))
  })

  it('draws from the platform’s random source when it is given none', () => {
    const one = mintPublicationId()
    expect(one).toMatch(/^[0-9a-f]{32}$/u)
    expect(mintPublicationId(), 'two ids drawn at random were the same').not.toBe(one)
  })

  it('is sixteen random bytes as lower-case hex', () => {
    const id = mintPublicationId((bytes) => bytes.fill(0xab))
    expect(id).toBe('ab'.repeat(16))
    expect(id).toMatch(/^[0-9a-f]{32}$/u)
  })

  it('is random rather than derived, so one passage twice is two publications', () => {
    /* `mintPub` in the circle carries the reasoning: a withdrawal names exactly
       one of them, and deriving the id would make taking one back take both. */
    let n = 0
    const counted = () => mintPublicationId((bytes) => bytes.fill(n++))
    expect(counted()).not.toBe(counted())
  })
})
