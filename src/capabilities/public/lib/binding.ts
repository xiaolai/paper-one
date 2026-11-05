/**
 * Saying that a voice belongs to somebody you know — WI-26.5.
 *
 * ## Friend-of-friend weighting is CUT, and this is what is left
 *
 * ⚠️ **THE MACHINE CANNOT DISTINGUISH A FRIEND'S-FRIEND'S VOICE FROM A
 * STRANGER'S, AND WEIGHTING LOCALLY DOES NOT CREATE THE EVIDENCE.** A voice
 * deliberately unlinked to a person supplies nothing that identifies it as a
 * friend's, and the held person record is a DEVICE ROSTER, not a friend list.
 * Any additive weighting over voices is a count of keys, and keys are free.
 *
 * What survives is smaller and real: a LOCAL record that a voice belongs to a
 * known person, because that person told the reader so over the circle. It is
 * evidence the reader received from somebody they already trust, held on this
 * device, and asserted by nobody else.
 *
 * ## Its lifecycle, stated
 *
 * | Question | Answer |
 * |---|---|
 * | Who may assert it | the person themselves, over the circle — `assertedBy` is their id, and a binding whose asserter is not its subject is refused |
 * | Several voices, one person | yes: a reader rotates a voice (WI-26.3) and both may be live at once |
 * | One voice, several people | no: the second assertion is refused, because two people claiming one key is a claim at most one of them can support |
 * | Removal | the reader's own act, and it takes only that binding |
 * | Blocking the person | KEEPS every binding, and silences the voices they name |
 *
 * PURE. No storage and no clock: the caller supplies the records and the time.
 */

/** One local record that a voice belongs to a person. */
export interface VoiceBinding {
  /** The public voice, 64 lower-case hex. */
  readonly voice: string
  /** The person id it belongs to — a circle person, 64 lower-case hex. */
  readonly person: string
  /**
   * Who said so.
   *
   * ⚠️ **MUST EQUAL `person`, AND THE CHECK IS NOT DECORATION.** A binding
   * asserted by somebody else is one friend telling the reader who a THIRD
   * party's pseudonym is — which they cannot know, and which would let one
   * person in a circle attribute a stranger's words to another member.
   */
  readonly assertedBy: string
  /** When this device recorded it, in epoch milliseconds. */
  readonly at: number
}

/** What this device thinks of a voice. */
export type VoiceStanding =
  /** Nobody here has said whose this is. The ordinary state. */
  | 'stranger'
  /** A person in the reader's circle said it is theirs. */
  | 'bound'
  /** The reader has stopped hearing it — by voice, or by blocking its person. */
  | 'blocked'

/** What the reader has decided, as `standingOf` reads it. */
export interface VoiceDecisions {
  readonly bindings: readonly VoiceBinding[]
  /** Voices the reader silenced one at a time. */
  readonly blockedVoices: readonly string[]
  /** People the reader blocked — which silences every voice bound to them. */
  readonly blockedPeople: readonly string[]
}

export const NO_DECISIONS: VoiceDecisions = { bindings: [], blockedVoices: [], blockedPeople: [] }

/**
 * Whether a binding is one this device may hold at all.
 *
 * ⚠️ **TOTAL, BECAUSE IT JUDGES DATA FROM A FILE.** The parameter is typed, and
 * what actually arrives is whatever JSON held — so `null` in the array made
 * this THROW on `binding.voice`, and a validator that throws on the input it
 * exists to judge takes down every caller that was relying on it to say "no".
 * `voicePort`'s documented promise to drop a malformed row and keep the rest
 * failed exactly there: one `null` and the reader could not read any of their
 * decisions. Found by audit.
 */
export function isWellFormed(binding: VoiceBinding): boolean {
  if (typeof binding !== 'object' || binding === null) return false
  const hex = /^[0-9a-f]{64}$/u
  return (
    typeof binding.voice === 'string' &&
    typeof binding.person === 'string' &&
    typeof binding.assertedBy === 'string' &&
    hex.test(binding.voice) &&
    hex.test(binding.person) &&
    /* The one substantive check. See `assertedBy`. */
    binding.assertedBy === binding.person &&
    Number.isSafeInteger(binding.at) &&
    binding.at >= 0
  )
}

/**
 * What this device thinks of a voice.
 *
 * ⚠️ **BLOCKING WINS OVER BINDING, ALWAYS.** A reader who blocked somebody and
 * then learned that a voice is theirs has not un-blocked them; the binding is
 * exactly the evidence that the block should apply.
 */
export function standingOf(voice: string, decisions: VoiceDecisions): VoiceStanding {
  if (decisions.blockedVoices.includes(voice)) return 'blocked'
  const bound = claimOn(voice, decisions)
  if (bound === undefined) return 'stranger'
  return decisions.blockedPeople.includes(bound.person) ? 'blocked' : 'bound'
}

/** The person a voice is bound to, or `null`. Never a guess. */
export function personOf(voice: string, decisions: VoiceDecisions): string | null {
  const bound = claimOn(voice, decisions)
  return bound === undefined || decisions.blockedPeople.includes(bound.person) ? null : bound.person
}

/**
 * The WELL-FORMED binding on a voice, if there is one.
 *
 * ⚠️ **ONE DEFINITION OF "IS THIS VOICE CLAIMED?", AND THERE WERE THREE.**
 * `standingOf` and `personOf` each spelled out `filter(isWellFormed).find(…)`,
 * allocating a copy of every binding to find one — and `bind` did not filter
 * at all, which is worse than duplication: a malformed record that every
 * lookup ignores was still treated as a CLAIM, so a voice reported as
 * `stranger` refused a valid binding as `already-claimed` and nothing could
 * clear it. Found by audit.
 */
function claimOn(voice: string, decisions: VoiceDecisions): VoiceBinding | undefined {
  return decisions.bindings.find((one) => one.voice === voice && isWellFormed(one))
}

/** Why a binding was not recorded. `null` when it was. */
export type BindingRefusal =
  | 'malformed'
  /** Somebody other than the subject asserted it. */
  | 'not-theirs'
  /** Another person already claims this voice. */
  | 'already-claimed'

/**
 * Record a binding, or say why not.
 *
 * Re-asserting an existing binding replaces it — a person may say so again,
 * and the newer `at` is what a surface shows.
 */
export function bind(
  decisions: VoiceDecisions,
  binding: VoiceBinding,
): { readonly decisions: VoiceDecisions } | BindingRefusal {
  if (!isWellFormed(binding)) {
    return binding.assertedBy !== binding.person ? 'not-theirs' : 'malformed'
  }
  /* ⚠️ **A MALFORMED RECORD IS NOT A CLAIM**, and this asked `find` directly.
     Every lookup filters by `isWellFormed`, so a damaged row made a voice
     `stranger` everywhere AND `already-claimed` here — a binding the reader
     could not make and could not see the reason for. `claimOn` is the one
     definition. Found by audit. */
  const held = claimOn(binding.voice, decisions)
  const claimed = held !== undefined && held.person !== binding.person ? held : undefined
  /* ⚠️ **ONE VOICE, ONE PERSON.** Two people claiming one key is a claim at
     most one of them can support, and taking the newer would let anybody
     overwrite a true binding by asserting a false one later. */
  if (claimed !== undefined) return 'already-claimed'
  return {
    decisions: {
      ...decisions,
      bindings: [...decisions.bindings.filter((one) => one.voice !== binding.voice), binding],
    },
  }
}

/** Forget one binding. The voice becomes a stranger again. */
export function unbind(decisions: VoiceDecisions, voice: string): VoiceDecisions {
  return { ...decisions, bindings: decisions.bindings.filter((one) => one.voice !== voice) }
}

/** Stop hearing one voice, whoever it belongs to. */
export function blockVoice(decisions: VoiceDecisions, voice: string): VoiceDecisions {
  return decisions.blockedVoices.includes(voice)
    ? decisions
    : { ...decisions, blockedVoices: [...decisions.blockedVoices, voice] }
}

/** Hear it again. */
export function unblockVoice(decisions: VoiceDecisions, voice: string): VoiceDecisions {
  return { ...decisions, blockedVoices: decisions.blockedVoices.filter((one) => one !== voice) }
}

/**
 * Stop hearing a person — which silences every voice bound to them.
 *
 * ⚠️ **THE BINDINGS ARE KEPT, NOT DELETED.** Deleting them would turn the
 * person's voices back into strangers, which is louder than blocking them, not
 * quieter: the block would silently stop applying to the one voice the reader
 * blocked them over. `standingOf` reads both, so the block holds.
 */
export function blockPerson(decisions: VoiceDecisions, person: string): VoiceDecisions {
  return decisions.blockedPeople.includes(person)
    ? decisions
    : { ...decisions, blockedPeople: [...decisions.blockedPeople, person] }
}

export function unblockPerson(decisions: VoiceDecisions, person: string): VoiceDecisions {
  return { ...decisions, blockedPeople: decisions.blockedPeople.filter((one) => one !== person) }
}

/** Every voice this device knows belongs to a person. */
export function voicesOf(person: string, decisions: VoiceDecisions): readonly string[] {
  return decisions.bindings
    .filter(isWellFormed)
    .filter((one) => one.person === person)
    .map((one) => one.voice)
}
