import { describe, expect, it } from 'vitest'
import { NO_DECISIONS, bind, blockPerson, blockVoice, type VoiceBinding } from './binding'
import { PUBLIC_WEIGHT, reconcile, type Contributor } from './presentation'

const PERSON = 'c'.repeat(64)
const VOICE_A = 'a'.repeat(64)
const VOICE_B = 'b'.repeat(64)
const STRANGER = 'e'.repeat(64)
const AT = 'section-1#/2/4'

const bound = (voice: string, person = PERSON): VoiceBinding => ({ voice, person, assertedBy: person, at: 1 })
const decide = (...bindings: readonly VoiceBinding[]) =>
  bindings.reduce((held, one) => {
    const result = bind(held, one)
    if (typeof result === 'string') throw new Error(result)
    return result.decisions
  }, NO_DECISIONS)

describe('no public aggregate', () => {
  it('exports nothing that could carry a total, and the export list is the check', async () => {
    /* ⚠️ **THIS REPLACED `offersPublicTotal()`, WHICH RETURNED `false` AND
       PROVED NOTHING.** A function that always answers `false` cannot forbid
       an aggregate: the aggregate would be built beside it, and it would go
       on answering `false`. What can actually be held is this module's own
       surface — a constant weight, and a reconciler whose number is a count
       of PEOPLE. A third export is somebody adding one deliberately, and
       this refuses until they name it here. */
    const surface: Record<string, unknown> = await import('./presentation')
    expect(Object.keys(surface).sort()).toEqual(['PUBLIC_WEIGHT', 'reconcile'])
  })

  it('draws every public mark at one weight, whatever its voice', () => {
    /* `FOREIGN_WEIGHTS` ramps because the circle can count readers. Nothing
       here can, so there is one weight and it does not move. */
    expect(PUBLIC_WEIGHT).toBe(1)
  })

  it('reports unbound voices as a flag, never as a number', () => {
    /* ⚠️ **"4 OF 11 READERS MARKED THIS" IS A SENTENCE AN ATTACKER WRITES.**
       One free key and a thousand must produce the same answer. */
    const one = reconcile([{ anchor: AT, voice: STRANGER }], NO_DECISIONS)
    const many = reconcile(
      Array.from({ length: 1000 }, (_, i) => ({ anchor: AT, voice: `${i}`.padStart(64, '0') }) as Contributor),
      NO_DECISIONS,
    )
    expect(one).toEqual([{ anchor: AT, readers: [], anonymous: true }])
    expect(many).toEqual([{ anchor: AT, readers: [], anonymous: true }])
  })
})

describe('reconciliation runs before any weight', () => {
  it('folds a bound voice into the person it belongs to', () => {
    /* ⚠️ **COUNTING CIRCLE MEMBERS AND BOUND VOICES SEPARATELY DOES NOT
       IMPLEMENT "PEOPLE".** `drawable` dedupes within its own input and the
       overlay host flattens contributions; nothing reconciles across them. */
    const marks: readonly Contributor[] = [
      { anchor: AT, person: PERSON },
      { anchor: AT, voice: VOICE_A },
    ]
    expect(reconcile(marks, decide(bound(VOICE_A)))).toEqual([{ anchor: AT, readers: [PERSON], anonymous: false }])
  })

  it('counts one person once however many of their voices marked it', () => {
    /* WI-26.6's acceptance: one person, one circle mark, TWO bound voices. */
    const marks: readonly Contributor[] = [
      { anchor: AT, person: PERSON },
      { anchor: AT, voice: VOICE_A },
      { anchor: AT, voice: VOICE_B },
    ]
    expect(reconcile(marks, decide(bound(VOICE_A), bound(VOICE_B)))).toEqual([
      { anchor: AT, readers: [PERSON], anonymous: false },
    ])
  })

  it('counts an unbound voice as nobody, beside the people who are somebody', () => {
    const marks: readonly Contributor[] = [
      { anchor: AT, person: PERSON },
      { anchor: AT, voice: STRANGER },
    ]
    expect(reconcile(marks, NO_DECISIONS)).toEqual([{ anchor: AT, readers: [PERSON], anonymous: true }])
  })

  it('moves the count when a binding is added and back when it is removed', () => {
    /* The transitions WI-26.5's acceptance asks for, at the place they change
       a number. */
    const marks: readonly Contributor[] = [
      { anchor: AT, person: PERSON },
      { anchor: AT, voice: VOICE_A },
    ]
    expect(reconcile(marks, NO_DECISIONS)).toEqual([{ anchor: AT, readers: [PERSON], anonymous: true }])
    const withBinding = decide(bound(VOICE_A))
    expect(reconcile(marks, withBinding)).toEqual([{ anchor: AT, readers: [PERSON], anonymous: false }])
    expect(reconcile(marks, blockPerson(withBinding, PERSON))).toEqual([{ anchor: AT, readers: [PERSON], anonymous: false }])
  })

  it('drops a blocked voice entirely', () => {
    const marks: readonly Contributor[] = [{ anchor: AT, voice: STRANGER }]
    expect(reconcile(marks, blockVoice(NO_DECISIONS, STRANGER))).toEqual([])
  })

  it('counts two different people twice', () => {
    const other = 'f'.repeat(64)
    const marks: readonly Contributor[] = [
      { anchor: AT, person: PERSON },
      { anchor: AT, person: other },
    ]
    expect(reconcile(marks, NO_DECISIONS)).toEqual([{ anchor: AT, readers: [PERSON, other], anonymous: false }])
  })

  it('keeps anchors apart', () => {
    const elsewhere = 'section-2#/2/6'
    const marks: readonly Contributor[] = [
      { anchor: AT, person: PERSON },
      { anchor: elsewhere, voice: STRANGER },
    ]
    expect(reconcile(marks, NO_DECISIONS)).toEqual([
      { anchor: AT, readers: [PERSON], anonymous: false },
      { anchor: elsewhere, readers: [], anonymous: true },
    ])
  })
})

describe('individual opinions stay visible', () => {
  it('keeps every anchor its own row rather than summarising them', () => {
    /* ⚠️ **RENDERING NOTHING WOULD PASS "NO AGGREGATE"**, which is why
       WI-26.6's acceptance requires the sample to survive. Twenty voices on
       twenty passages come back as twenty rows in the order they arrived —
       not one row, not a ranking, and not a shorter list of the busiest
       passages, all of which would satisfy "no total" and show nothing. */
    const marks = Array.from(
      { length: 20 },
      (_, i) => ({ anchor: `section-${i}#/2/4`, voice: `${i}`.padStart(64, '0') }) as Contributor,
    )
    const drawn = reconcile(marks, NO_DECISIONS)
    expect(drawn).toHaveLength(20)
    expect(drawn.map((one) => one.anchor)).toEqual(marks.map((one) => one.anchor))
  })

  it('draws a stranger at the same weight as a bound voice, which is the whole sample', () => {
    /* The acceptance asked for one pseudonym's own STARS too. A public
       envelope has no rating field, so there is no number to draw and
       `voiceStarsText` formatted one that could not arrive; the note in
       `presentation.ts` records why it went. What remains showable is that
       an unbound voice is still drawn, at `PUBLIC_WEIGHT`, beside a bound
       one — the sample, not the sum. */
    const drawn = reconcile(
      [
        { anchor: AT, voice: STRANGER },
        { anchor: AT, voice: VOICE_A },
      ],
      decide(bound(VOICE_A)),
    )
    expect(drawn).toEqual([{ anchor: AT, readers: [PERSON], anonymous: true }])
    expect(PUBLIC_WEIGHT).toBe(1)
  })
})
