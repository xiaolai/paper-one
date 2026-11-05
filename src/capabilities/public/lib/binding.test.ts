import { describe, expect, it } from 'vitest'
import {
  NO_DECISIONS,
  bind,
  blockPerson,
  blockVoice,
  isWellFormed,
  personOf,
  standingOf,
  unbind,
  unblockPerson,
  unblockVoice,
  voicesOf,
  type VoiceBinding,
} from './binding'

const VOICE = 'a'.repeat(64)
const OTHER_VOICE = 'b'.repeat(64)
const PERSON = 'c'.repeat(64)
const OTHER_PERSON = 'd'.repeat(64)

const binding = (over: Partial<VoiceBinding> = {}): VoiceBinding => ({
  voice: VOICE,
  person: PERSON,
  assertedBy: PERSON,
  at: 1,
  ...over,
})

const took = (result: ReturnType<typeof bind>) => {
  if (typeof result === 'string') throw new Error(`refused: ${result}`)
  return result.decisions
}

describe('isWellFormed', () => {
  it('requires the asserter to be the subject', () => {
    /* ⚠️ **A BINDING ASSERTED BY SOMEBODY ELSE IS ONE FRIEND TELLING THE
       READER WHO A THIRD PARTY'S PSEUDONYM IS** — which they cannot know, and
       which would let one circle member attribute a stranger's words to
       another. */
    expect(isWellFormed(binding())).toBe(true)
    expect(isWellFormed(binding({ assertedBy: OTHER_PERSON }))).toBe(false)
  })

  it('requires both ids to be 64 lower-case hex, and a sane time', () => {
    for (const bad of ['', VOICE.toUpperCase(), VOICE.slice(0, 63)]) {
      expect(isWellFormed(binding({ voice: bad })), bad).toBe(false)
      expect(isWellFormed(binding({ person: bad, assertedBy: bad })), bad).toBe(false)
    }
    expect(isWellFormed(binding({ at: -1 }))).toBe(false)
    expect(isWellFormed(binding({ at: 1.5 }))).toBe(false)
  })
})

describe('standingOf — and a classifier answering "stranger" for everything must fail', () => {
  it('is stranger before anybody says otherwise', () => {
    expect(standingOf(VOICE, NO_DECISIONS)).toBe('stranger')
  })

  it('becomes bound when the person says it is theirs, and reverts when removed', () => {
    /* ⚠️ **THE TRANSITIONS ARE THE TEST.** WI-26.5's acceptance says the
       indistinguishability fixture alone is passed by a classifier that
       answers "stranger" for everything. */
    const bound = took(bind(NO_DECISIONS, binding()))
    expect(standingOf(VOICE, bound)).toBe('bound')
    expect(standingOf(VOICE, unbind(bound, VOICE))).toBe('stranger')
  })

  it('becomes blocked when the person is blocked, and stays bound to nobody else', () => {
    const bound = took(bind(NO_DECISIONS, binding()))
    const blocked = blockPerson(bound, PERSON)
    expect(standingOf(VOICE, blocked)).toBe('blocked')
    expect(standingOf(OTHER_VOICE, blocked)).toBe('stranger')
    expect(standingOf(VOICE, unblockPerson(blocked, PERSON))).toBe('bound')
  })

  it('becomes blocked when the voice alone is blocked', () => {
    const blocked = blockVoice(NO_DECISIONS, VOICE)
    expect(standingOf(VOICE, blocked)).toBe('blocked')
    expect(standingOf(VOICE, unblockVoice(blocked, VOICE))).toBe('stranger')
  })

  it('blocking wins over binding, whichever came first', () => {
    /* A reader who blocked somebody and then learned that a voice is theirs
       has not un-blocked them; the binding is exactly the evidence that the
       block should apply. */
    const first = blockPerson(took(bind(NO_DECISIONS, binding())), PERSON)
    const second = took(bind(blockPerson(NO_DECISIONS, PERSON), binding()))
    expect(standingOf(VOICE, first)).toBe('blocked')
    expect(standingOf(VOICE, second)).toBe('blocked')
  })

  it('ignores a malformed binding rather than trusting it', () => {
    const forged = { ...NO_DECISIONS, bindings: [binding({ assertedBy: OTHER_PERSON })] }
    expect(standingOf(VOICE, forged)).toBe('stranger')
    expect(personOf(VOICE, forged)).toBeNull()
  })
})

describe('bind', () => {
  it('refuses an assertion by anybody but the subject', () => {
    expect(bind(NO_DECISIONS, binding({ assertedBy: OTHER_PERSON }))).toBe('not-theirs')
  })

  it('refuses a malformed binding', () => {
    expect(bind(NO_DECISIONS, binding({ voice: 'nope', person: 'nope', assertedBy: 'nope' }))).toBe('malformed')
  })

  it('lets one person hold several voices, because rotation exists', () => {
    /* WI-26.3 rotates a voice, and both may be live at once. */
    const two = took(bind(took(bind(NO_DECISIONS, binding())), binding({ voice: OTHER_VOICE, at: 2 })))
    expect(voicesOf(PERSON, two)).toEqual([VOICE, OTHER_VOICE])
  })

  it('refuses a second person claiming one voice', () => {
    /* ⚠️ **TAKING THE NEWER WOULD LET ANYBODY OVERWRITE A TRUE BINDING BY
       ASSERTING A FALSE ONE LATER.** */
    const held = took(bind(NO_DECISIONS, binding()))
    expect(bind(held, binding({ person: OTHER_PERSON, assertedBy: OTHER_PERSON, at: 9 }))).toBe('already-claimed')
    expect(personOf(VOICE, held)).toBe(PERSON)
  })

  it('lets the same person re-assert, replacing rather than duplicating', () => {
    const again = took(bind(took(bind(NO_DECISIONS, binding())), binding({ at: 5 })))
    expect(again.bindings).toHaveLength(1)
    expect(again.bindings[0]?.at).toBe(5)
  })
})

describe('blockPerson keeps the bindings', () => {
  it('so that unbinding does not quietly un-block', () => {
    /* ⚠️ **DELETING THE BINDINGS WOULD BE LOUDER, NOT QUIETER**: the person's
       voices would become strangers again and the block would stop applying to
       the one voice the reader blocked them over. */
    const blocked = blockPerson(took(bind(NO_DECISIONS, binding())), PERSON)
    expect(blocked.bindings).toHaveLength(1)
    expect(standingOf(VOICE, blocked)).toBe('blocked')
  })
})

describe('persistence is the caller’s, and the shape survives a round trip', () => {
  it('survives JSON, which is how a restart reaches it', () => {
    const held = blockVoice(blockPerson(took(bind(NO_DECISIONS, binding())), OTHER_PERSON), OTHER_VOICE)
    const back = JSON.parse(JSON.stringify(held)) as typeof held
    expect(standingOf(VOICE, back)).toBe('bound')
    expect(standingOf(OTHER_VOICE, back)).toBe('blocked')
  })

  it('does not let a MALFORMED record claim a voice nothing else thinks is claimed', async () => {
    /* ⚠️ **`bind` ASKED `find` DIRECTLY WHILE EVERY LOOKUP FILTERED.** A
       damaged row made the voice a `stranger` everywhere and `already-claimed`
       here — a binding the reader could not make, could not see the reason
       for, and could not clear, because `unbind` removes by voice and the row
       was still there afterwards to refuse the next attempt. */
    const damaged = { voice: VOICE, person: OTHER_PERSON, assertedBy: PERSON, at: 1 } as VoiceBinding
    const decisions = { bindings: [damaged], blockedVoices: [], blockedPeople: [] }
    /* Every lookup already ignores it. */
    expect(standingOf(VOICE, decisions)).toBe('stranger')
    expect(personOf(VOICE, decisions)).toBeNull()
    /* So it cannot be a claim against a valid binding either. */
    const outcome = bind(decisions, { voice: VOICE, person: PERSON, assertedBy: PERSON, at: 2 })
    expect(typeof outcome, 'a record no lookup trusts refused a valid binding').not.toBe('string')
  })
})
