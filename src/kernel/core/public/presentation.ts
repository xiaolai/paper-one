import { isWellFormed, type VoiceDecisions } from './binding'

/**
 * How a stranger's annotation is drawn, and what may never be counted —
 * WI-26.6.
 *
 * ## Not a mean, and NOT A COUNT
 *
 * ⚠️ **"4 OF 11 READERS MARKED THIS" IS A SENTENCE AN ATTACKER WRITES.** The
 * circle can say it because its readers are PEOPLE who had to be admitted:
 * `drawable` dedupes by person, and rating sentences count people. Here keys
 * are free, so every additive weighting over voices — a mean, a count, a
 * heat map, a "popular passage" list — is a count of keys wearing a count of
 * readers' clothes. A mean was refused during the review; a count is refused
 * here for the same reason and by the same argument.
 *
 * ## And "render nothing" would pass that, which is why it is not the rule
 *
 * ⚠️ WI-26.6's acceptance says so: rendering nothing satisfies "no aggregate".
 * **Individual opinions must remain visible** — one pseudonym's own words,
 * drawn individually by the overlay. What is refused is the SUM, not the
 * sample.
 *
 * ⚠️ **AND THE ACCEPTANCE ALSO ASKED FOR ONE PSEUDONYM'S OWN STARS, WHICH THIS
 * PHASE CANNOT DRAW.** A public envelope carries an anchor, a body and a
 * signature; it has no rating field anywhere, so there is no number here to
 * render. `voiceStarsText` existed against that clause and formatted a number
 * nothing produced — see the note below it went.
 *
 * ## Binding re-opens multiplicity, which is why it is settled here
 *
 * ⚠️ **ONCE BOUND VOICES EXIST, MULTIPLICITY IS AN IDENTITY QUESTION.** Do
 * several voices bound to one person count once, and does that person's circle
 * mark count again? `drawable` dedupes by person WITHIN its own input, and the
 * overlay host merely flattens contributions — it reconciles nothing across
 * them. Counting circle members and bound voices separately does not implement
 * "people".
 *
 * **The decision: reconciliation first, and only then a weight.** A voice bound
 * to a person IS that person, so it folds into their circle mark and the pair
 * counts once. A voice nobody has bound is not a person at all and gets a
 * CONSTANT presentation, kept entirely apart from the count — because there is
 * no honest number to add it to.
 *
 * PURE.
 */

/** One mark on one anchor, as this stage takes it. */
export interface Contributor {
  /** Where it landed, as the painter keys it. */
  readonly anchor: string
  /** The circle person who made it, when it came from the circle. */
  readonly person?: string
  /** The voice that published it, when it came from the public layer. */
  readonly voice?: string
}

/** What one anchor amounts to after reconciliation. */
export interface AnchorWeight {
  readonly anchor: string
  /**
   * WHICH PEOPLE marked it — circle members, plus bound voices folded into the
   * person they belong to, each appearing once.
   *
   * ⚠️ **NEVER INCLUDES AN UNBOUND VOICE.** That is the whole rule.
   *
   * ⚠️ **AND IT IS A SET RATHER THAN A COUNT BECAUSE A COUNT CANNOT BE
   * RECONCILED FURTHER.** This stage sees one contribution's rows; the overlay
   * host sees every contribution's, and has to union them before it takes a
   * number — otherwise one person who marked a passage in the circle AND
   * published a bound voice at it is counted twice, which is the exact defect
   * this function was written to prevent, one layer up. Found by audit.
   */
  readonly readers: readonly string[]
  /**
   * How many unbound voices also marked it.
   *
   * ⚠️ **REPORTED SEPARATELY AND NEVER ADDED.** A surface may say "and others"
   * or draw a constant mark; it may not turn this into a number beside
   * `readers`, because the two are not the same kind of thing and adding them
   * is the count this module exists to refuse. It is here so a surface can
   * tell "nobody else" from "somebody else" — which is not an aggregate,
   * because one free key produces the same answer as a thousand.
   */
  readonly anonymous: boolean
}

/**
 * The weight every public mark is drawn at, whatever its voice.
 *
 * ⚠️ **CONSTANT, AND THAT IS THE DECISION.** `FOREIGN_WEIGHTS` ramps with the
 * number of readers because the circle can count readers. Nothing here can, so
 * there is one weight and it does not move.
 */
/* ⚠️ **TWO FUNCTIONS WERE REMOVED FROM HERE, AND WHAT THEY STOOD FOR IS
   WRITTEN DOWN INSTEAD.** Both were exported, tested, re-exported from the
   kernel barrel and called by nothing.

   `offersPublicTotal()` returned `false` unconditionally and nobody called it.
   It was standing in for WI-26.6's guarantee — that no aggregate is computed
   across voices — and a function that always answers `false` cannot enforce
   that: the aggregate it forbids would be built somewhere else entirely, and
   this would go on answering `false` beside it. The guarantee is that
   `reconcile` returns a COUNT OF DISTINCT PEOPLE and a boolean, and that
   nothing in this module sums ratings, averages them, or returns a number a
   surface could present as a score. That is enforceable by reading the file.

   `voiceStarsText` formatted one voice's own stars, and **a public annotation
   has no stars**: the envelope carries an anchor, a body and a signature, so
   the number it clamped could not come from anywhere. Its clamp took `number`
   rather than the kernel's `Stars` (`1 | 2 | 3 | 4 | 5`), which is what let
   `NaN` through to an empty string and an infinity through to five stars —
   the illegal states were representable only because the argument was widened
   past the type that already forbids them. If public ratings are ever
   published, the renderer is written then, against `Stars`, with a test that
   shows one on screen. */
export const PUBLIC_WEIGHT = 1

/**
 * Reconcile who marked each anchor, then count.
 *
 * ⚠️ **RECONCILIATION FIRST, WEIGHT SECOND, AND THE ORDER IS THE WORK ITEM.**
 * Weighing before reconciling is what counts one person twice — once as a
 * circle member and once as their own bound voice — and the two inputs arrive
 * from different contributors that flatten rather than merge.
 */
export function reconcile(
  contributors: readonly Contributor[],
  decisions: VoiceDecisions,
): readonly AnchorWeight[] {
  /* ⚠️ **THE DECISIONS ARE INDEXED ONCE, NOT RE-WALKED PER CONTRIBUTOR.**
     `standingOf` and `personOf` each filter every binding by `isWellFormed` and
     then scan for a match, and both were called for every contributor — so this
     was O(contributors × bindings), twice over, synchronously, over two lists a
     stranger chooses the length of (`MAX_DECISIONS` is 4 096 each). One pass
     builds what both questions need. */
  const blockedVoices = new Set(decisions.blockedVoices)
  const blockedPeople = new Set(decisions.blockedPeople)
  const personOfVoice = new Map<string, string>()
  for (const one of decisions.bindings) {
    if (isWellFormed(one) && !personOfVoice.has(one.voice)) personOfVoice.set(one.voice, one.person)
  }

  /* ⚠️ **ONE MAP, NOT THREE.** `people`, `anonymous` and `order` tracked the
     same anchors and had to be initialised together, which is what the
     non-null assertions below were compensating for. A `Map` already keeps
     insertion order, so the third was never needed at all. */
  const at = new Map<string, { readers: Set<string>; anonymous: boolean }>()
  const seen = (anchor: string): { readers: Set<string>; anonymous: boolean } => {
    const held = at.get(anchor)
    if (held !== undefined) return held
    const fresh = { readers: new Set<string>(), anonymous: false }
    at.set(anchor, fresh)
    return fresh
  }

  for (const one of contributors) {
    if (one.voice !== undefined) {
      /* A blocked voice is not drawn and not counted — the reader said so.
         Blocking a PERSON silences every voice bound to them, which is
         `standingOf`'s rule expressed over the index above. */
      const boundTo = personOfVoice.get(one.voice)
      if (blockedVoices.has(one.voice) || (boundTo !== undefined && blockedPeople.has(boundTo))) continue
      const row = seen(one.anchor)
      const person = boundTo === undefined || blockedPeople.has(boundTo) ? null : boundTo
      if (person === null) {
        /* ⚠️ **A FLAG, NOT A COUNTER.** `anonymous += 1` is the sentence an
           attacker writes; `anonymous = true` is the same answer for one free
           key and for a thousand. */
        row.anonymous = true
      } else {
        row.readers.add(person)
      }
      continue
    }
    if (one.person !== undefined) {
      /* A blocked person's circle mark is the circle's own decision, not this
         module's — `drawsEntry` decides it before anything reaches here. What
         IS this module's is that their bound voice folds into them. */
      seen(one.anchor).readers.add(one.person)
      continue
    }
    /* ⚠️ **NEITHER FIELD IS A CONTRIBUTOR WITH NO IDENTITY, AND IT USED TO BE
       DROPPED IN SILENCE.** The type permits it, so a caller that built one by
       mistake — a missing voice on a public row, an unset person on a circle
       one — simply vanished from the count. A weight that is quietly one lower
       than the truth is the kind of wrong nobody reports. */
    throw new Error('public: a contributor names neither a voice nor a person')
  }

  return [...at].map(([anchor, held]) => ({
    anchor,
    readers: [...held.readers],
    anonymous: held.anonymous,
  }))
}
