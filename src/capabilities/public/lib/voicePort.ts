import {
  NO_DECISIONS,
  VOICE_DECISIONS_PATH,
  atomicWrite,
  bind,
  blockPerson,
  blockVoice,
  isWellFormed,
  notifyAll,
  personOf,
  standingOf,
  unbind,
  unblockPerson,
  unblockVoice,
  voicesOf,
  type BindingRefusal,
  type IndexFs,
  type VoiceBinding,
  type VoiceDecisions,
  type VoiceStanding,
  type WriteQueue,
} from '../../../kernel'

/**
 * What this reader has decided about other people's voices — WI-26.5, given a
 * place to live.
 *
 * ⚠️ **THIS EXISTS BECAUSE `NO_DECISIONS` WAS THE ONLY THING THE OVERLAY EVER
 * SAW.** `binding.ts` had the whole lifecycle, tested, and nothing could record
 * a binding or a block — so every voice was a stranger for ever, which is the
 * safe direction and not a feature.
 *
 * ## What is stored, and what is not
 *
 * ⚠️ **LOCAL, AND NEVER PUBLISHED.** A binding says *"this pseudonym is my
 * friend"* — the one fact the whole phase exists to keep off the wire. It has
 * no publisher and no wire type, and it lives outside `circle/` so that
 * `peopleFor` cannot read a voice as a person.
 *
 * ## Absent and unreadable are not the same answer
 *
 * A reader who has decided nothing and a file that would not read look
 * identical to a caller that collapses both — and the next write would then
 * put that nothing on disk over every decision they had made. Absent is empty;
 * anything else THROWS. `readMarks` names this as the most destructive line it
 * ever had.
 */

/** The most decisions this device will hold. */
export const MAX_DECISIONS = 4_096

export interface VoiceDecisionsPort {
  /** Everything the reader has decided. Empty for a reader who has decided nothing. */
  decisions(): Promise<VoiceDecisions>
  /** What this device thinks of one voice. */
  standing(voice: string): Promise<VoiceStanding>
  /** The person a voice belongs to, or `null`. Never a guess. */
  person(voice: string): Promise<string | null>
  /** Every voice this device knows belongs to a person. */
  voicesOf(person: string): Promise<readonly string[]>
  /**
   * Record that a voice belongs to a person, because that person said so.
   *
   * ⚠️ **`assertedBy` MUST BE THE SUBJECT**, and the refusal is the point: a
   * binding asserted by somebody else is one friend telling the reader who a
   * THIRD party's pseudonym is, which they cannot know.
   */
  bind(binding: VoiceBinding): Promise<BindingRefusal | null>
  /** Forget one binding. The voice becomes a stranger again. */
  unbind(voice: string): Promise<void>
  /** Stop hearing one voice, whoever it belongs to. */
  blockVoice(voice: string): Promise<void>
  unblockVoice(voice: string): Promise<void>
  /** Stop hearing a person — which silences every voice bound to them. */
  blockPerson(person: string): Promise<void>
  unblockPerson(person: string): Promise<void>
  /** Told when a decision changed. Returns its own unsubscribe. */
  subscribe(listener: () => void): () => void
}

/** The lane every decision write queues on. One file, one key. */
const LANE = 'public:voices'

/** What the file holds. `v` first, so a future shape can be told from this one. */
interface Stored {
  readonly v: number
  readonly bindings: readonly VoiceBinding[]
  readonly blockedVoices: readonly string[]
  readonly blockedPeople: readonly string[]
}

const VERSION = 1

export function voiceDecisionsPortOver(
  fs: IndexFs,
  queue: WriteQueue,
  changed: () => void,
): VoiceDecisionsPort {
  const listeners = new Set<() => void>()
  const tell = (): void => {
    /* ⚠️ **EACH ON ITS OWN, AND THE CHANGE HAS ALREADY LANDED.** A throwing
       callback stopped every later subscriber and travelled back out of an
       operation that had already been written — so the caller's `await`
       rejected and the reader was told a change failed that is on disk. See
       `notifyAll`, which is where that class is written down. */
    notifyAll([changed, ...listeners], 'voice decisions')
  }

  const read = async (): Promise<VoiceDecisions> => {
    let text: string
    try {
      text = new TextDecoder().decode(await fs.readFile(VOICE_DECISIONS_PATH))
    } catch (cause) {
      if (isMissing(cause)) return NO_DECISIONS
      throw cause
    }
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`public: ${VOICE_DECISIONS_PATH} is not a record of decisions`)
    }
    const held = parsed as Partial<Stored>
    if (held.v !== VERSION) {
      throw new Error(`public: ${VOICE_DECISIONS_PATH} is version ${String(held.v)}, not ${VERSION}`)
    }
    /* ⚠️ **A MALFORMED BINDING IS DROPPED, NOT TRUSTED, AND NOT FATAL.** It
       cannot change an answer — `standingOf` filters by `isWellFormed` too —
       so refusing the whole file over one would lose every decision beside it.
       The file is this device's own, so a bad row is a bug of ours rather than
       somebody else's input, which is why the malformed VERSION above is fatal
       and this is not. */
    const bindings = (Array.isArray(held.bindings) ? held.bindings : []).filter(isWellFormed)
    /* ⚠️ **A COLLECTION THAT IS NOT A LIST IS DAMAGE, NOT AN EMPTY LIST.** A
       missing or mistyped `blockedVoices` read as `[]`, which silently stops
       every silence applying — and the next change writes that emptiness over
       the original, so the reader's blocks are gone for good and nothing ever
       said so. Dropping one malformed ROW is deliberate and stays (see above);
       losing a whole collection is the file being damaged, and this file is
       this device's own. Found by audit. */
    const listOf = (value: unknown, name: string): readonly string[] => {
      if (value === undefined) return []
      if (!Array.isArray(value)) {
        throw new Error(`public: ${VOICE_DECISIONS_PATH} has a ${name} list that will not read`)
      }
      return value.filter((one): one is string => typeof one === 'string')
    }
    const blockedVoices = listOf(held.blockedVoices, 'blocked voices')
    const blockedPeople = listOf(held.blockedPeople, 'blocked people')
    /* ⚠️ **OVER THE CAP IS ALSO DAMAGE.** `change` refuses to WRITE more than
       `MAX_DECISIONS`, so a file holding more was not written by this build.
       Silently truncating it stopped the dropped blocks applying and then made
       the truncation permanent on the next change — the same shape as the
       collection above, one bound further out. */
    if (
      bindings.length > MAX_DECISIONS ||
      blockedVoices.length > MAX_DECISIONS ||
      blockedPeople.length > MAX_DECISIONS
    ) {
      throw new Error(`public: ${VOICE_DECISIONS_PATH} holds more decisions than this build will keep`)
    }
    return { bindings, blockedVoices, blockedPeople }
  }

  /**
   * Read, change and write as ONE queued transaction.
   *
   * ⚠️ **THE READ IS INSIDE THE LANE.** Two callers folding from the same
   * snapshot and then writing in turn is how the second erases the first — the
   * defect the public store had until the audit found it, and there is no
   * reason to reintroduce it here.
   */
  const change = async (apply: (held: VoiceDecisions) => VoiceDecisions | BindingRefusal): Promise<BindingRefusal | null> => {
    let refusal: BindingRefusal | null = null
    await queue.append(LANE, async () => {
      const held = await read()
      const next = apply(held)
      if (typeof next === 'string') {
        refusal = next
        return
      }
      if (
        next.bindings.length > MAX_DECISIONS ||
        next.blockedVoices.length > MAX_DECISIONS ||
        next.blockedPeople.length > MAX_DECISIONS
      ) {
        throw new Error(`public: this device already holds the ${MAX_DECISIONS} decisions it will keep`)
      }
      const bytes = new TextEncoder().encode(
        `${JSON.stringify({ v: VERSION, ...next } satisfies Stored, null, 2)}\n`,
      )
      /* `IndexFs extends VaultFs`, so no cast: one was written here and it was
         both dead and harmful — `capability-fs-footprint` reads the receiver as
         a bare identifier, so `fs as VaultFs` made this write INVISIBLE to the
         gate that exists to enumerate exactly this. */
      await atomicWrite(fs, VOICE_DECISIONS_PATH, bytes)
    })
    if (refusal === null) tell()
    return refusal
  }

  return {
    decisions: read,
    standing: async (voice) => standingOf(voice, await read()),
    person: async (voice) => personOf(voice, await read()),
    voicesOf: async (person) => voicesOf(person, await read()),
    bind: (binding) =>
      change((held) => {
        const outcome = bind(held, binding)
        return typeof outcome === 'string' ? outcome : outcome.decisions
      }),
    unbind: async (voice) => {
      await change((held) => unbind(held, voice))
    },
    blockVoice: async (voice) => {
      await change((held) => blockVoice(held, voice))
    },
    unblockVoice: async (voice) => {
      await change((held) => unblockVoice(held, voice))
    },
    blockPerson: async (person) => {
      await change((held) => blockPerson(held, person))
    },
    unblockPerson: async (person) => {
      await change((held) => unblockPerson(held, person))
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Whether a filesystem failure is "there is no such file". */
function isMissing(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /not found|no such file|ENOENT/iu.test(message)
}
