/**
 * Which voice says the book.
 *
 * Read aloud used to set no voice at all — it handed `speechSynthesis` an
 * utterance and took whatever the platform chose. On this Mac that is
 * `com.apple.voice.super-compact.en-US.Samantha`: the most compressed voice
 * Apple ships, for every book, in every language the platform could match
 * better. The ledger said as much in its own row — *"Voice, rate, pitch
 * control | Absent | Whatever the platform picks"* — and the picking is what
 * this module does instead.
 *
 * ⚠️ **THE TIER IS LEGIBLE FROM `voiceURI`, WHICH IS WHY THIS IS POSSIBLE AT
 * ALL.** `SpeechSynthesisVoice` has no quality field — `name`, `lang`,
 * `localService`, `default`, `voiceURI` and nothing else — so the obvious
 * reading is that a web app cannot tell a premium voice from a novelty one.
 * It can: WebKit puts Apple's own identifier in `voiceURI`, and the identifier
 * names the tier. Measured on macOS 27 on 2026-09-20, every one of the 73
 * voices the WebView offers falls in exactly three families:
 *
 * | family | n | what it is |
 * |---|---|---|
 * | `com.apple.voice.super-compact.<lang>.<Name>` | 46 | the smallest voices |
 * | `com.apple.speech.synthesis.voice.<Name>` | 19 | Bad News, Boing, Zarvox |
 * | `com.apple.voice.compact.<lang>.<Name>` | 8 | Samantha, Tingting, Meijia |
 *
 * 46 + 19 + 8 = 73, so the accounting is complete rather than a sample.
 * `enhanced` and `premium` follow the same shape and are what a reader gets by
 * downloading a voice; this machine had none installed when that was measured,
 * which is the real reason read aloud sounded the way it did.
 *
 * ⚠️ **A NOVELTY VOICE IS EXCLUDED, NOT RANKED LAST.** Ranking it last still
 * selects it when it is the only match, and a book read by Zarvox is not a
 * degraded experience — it is a joke at the reader's expense. Excluded means
 * no voice is chosen, which leaves the utterance's own voice unset, and the
 * platform's default is never a novelty voice. The whole family goes, on the
 * strength of the table above: the boundary is Apple's own, so it needs no list
 * of names to be maintained as the set changes.
 *
 * ⚠️ **AND `unknown` MUST STAY SELECTABLE.** Only Apple spells identifiers this
 * way. On Linux, on Windows, and in a browser on either, every `voiceURI` is
 * something else — so a tier check that refused what it could not parse would
 * pick no voice anywhere but macOS and iOS, which is a regression dressed as a
 * feature. Unparseable ranks below `compact` and above `super-compact`: a voice
 * from an engine this module knows nothing about is still a real voice, where
 * `super-compact` is explicitly the most compressed thing Apple ships.
 */

/**
 * The quality tiers, spelled the way `voiceURI` spells them.
 *
 * `'super-compact'` keeps its hyphen on purpose. The alternative is a
 * camelCase name and a mapping between the two, and a mapping is a place for
 * the two spellings to disagree — see `tierOf`, which would then need a table
 * instead of the identifier's own word.
 */
export type VoiceTier =
  | 'premium'
  | 'enhanced'
  | 'compact'
  | 'super-compact'
  | 'legacy'
  | 'novelty'
  | 'unknown'

/**
 * A voice, in the only terms choosing one needs.
 *
 * `SpeechSynthesisVoice` satisfies this structurally, so the browser's own
 * objects pass unchanged — and every function here is testable under the `node`
 * environment `kernel-unit` runs in, which a real `SpeechSynthesisVoice` is
 * not. That is the same reason `speech.test.ts` keeps its DOM-free half
 * separate.
 */
export interface VoiceFacts {
  readonly name: string
  readonly lang: string
  readonly voiceURI: string
  /**
   * Whether the engine speaks this voice on THIS machine.
   *
   * ⚠️ **WEB SPEECH MAY SEND THE TEXT TO A SERVER, AND THIS FILE'S HEADER USED TO
   * PROMISE IT DOES NOT.** `speech.ts` opens with "no network, no credentials" —
   * true of every voice macOS installs, and not true of the API. The
   * specification allows a voice, INCLUDING THE DEFAULT, to be synthesised
   * remotely; Chrome's default voices are. Paper reads whole sections aloud, so
   * that would be a book's text leaving the machine without anyone asking.
   *
   * `false` is therefore excluded from every automatic choice and from the
   * picker, exactly as a sound effect is. Absent means the engine did not say,
   * which is not the same as saying no — a fixture and an older engine both
   * land there, and refusing on silence would take read-aloud away from
   * machines that are fine.
   *
   * ⚠️ **THIS DOES NOT CLOSE THE HOLE, AND SAYING SO IS THE POINT.** Leaving
   * `utterance.voice` unset uses the platform's default, which on a machine with
   * only remote voices IS remote — so refusing to pick one does not stop the
   * text going out. Closing it means refusing to speak at all there, which is a
   * product decision and not this module's to make.
   */
  readonly localService?: boolean | undefined
}

/**
 * How much better one tier is than another. Higher wins.
 *
 * `novelty` has no rank because it is never compared — every path drops it
 * before ranking anything. It is in `VoiceTier` so that a picker can say what
 * it left out.
 */
const TIER_RANK: Record<Exclude<VoiceTier, 'novelty'>, number> = {
  premium: 5,
  enhanced: 4,
  compact: 3,
  unknown: 2,
  legacy: 1,
  'super-compact': 0,
}

/** `TIER_RANK` for any tier, with the one that is never ranked answering lowest. */
function rankOf(tier: VoiceTier): number {
  return tier === 'novelty' ? -1 : TIER_RANK[tier]
}

/** The `com.apple.voice.<tier>.<lang>.<Name>` families, by the tier they name. */
const APPLE_TIERS: readonly VoiceTier[] = ['premium', 'enhanced', 'compact', 'super-compact']

/** The family that holds both the sound effects and the oldest real voices. */
const LEGACY_PREFIX = 'com.apple.speech.synthesis.'

/**
 * The SOUND EFFECTS, by IDENTIFIER.
 *
 * ⚠️ **THE WHOLE FAMILY USED TO COUNT AS NOVELTY, AND THAT LOST REAL VOICES.**
 * This module argued the prefix was the boundary so no name list had to be kept.
 * The family is not homogeneous: Fred, Junior, Kathy and Ralph share it with
 * Boing and Zarvox, and excluding them took working voices out of both the
 * automatic pick and the picker.
 *
 * ⚠️ **AND THE FIRST REPLACEMENT LIST WAS WRONG TWICE.** It was written from the
 * names a reader sees, and `tierOf` reads the IDENTIFIER — where three of them
 * differ: `Deranged` is shown as Wobble, `Hysterical` as Jester, `Princess` as
 * Superstar. It also missed Albert and Princess, which are novelty. Both errors
 * were found by the audit and then settled by MEASURING rather than by guessing
 * again: `AVSpeechSynthesisVoice.voiceTraits.isNoveltyVoice` is the platform's
 * own answer, and on macOS 27 it splits this family 15 / 4 exactly as below.
 *
 * ⚠️ **THE WEB SIDE CANNOT ASK FOR THAT TRAIT**, which is why the list exists at
 * all. `narrate_voices` can — so the day the native list feeds the picker, this
 * becomes a fallback rather than the rule. Until then a name not on it is a
 * VOICE, which is the safe direction: the cost of missing one is a silly entry
 * in a list, and the cost of the old rule was losing four.
 */
const SOUND_EFFECTS: ReadonlySet<string> = new Set([
  'Albert',
  'BadNews',
  'Bahh',
  'Bells',
  'Boing',
  'Bubbles',
  'Cellos',
  'Deranged',
  'GoodNews',
  'Hysterical',
  'Organ',
  'Princess',
  'Trinoids',
  'Whisper',
  'Zarvox',
])

/**
 * The tier a `voiceURI` names, or `unknown` when it is not Apple's.
 *
 * The novelty family is checked FIRST, and the order matters: both families
 * begin `com.apple.`, and `com.apple.speech.synthesis.voice.Boing` contains no
 * tier word, so a tier scan that ran first would answer `unknown` for it —
 * which is a selectable rank. Boing would then read books on a machine whose
 * only English voices were novelty ones.
 */
export function tierOf(voiceURI: string): VoiceTier {
  if (voiceURI.startsWith(LEGACY_PREFIX)) {
    const name = voiceURI.slice(voiceURI.lastIndexOf('.') + 1)
    return SOUND_EFFECTS.has(name) ? 'novelty' : 'legacy'
  }
  for (const tier of APPLE_TIERS) {
    if (voiceURI.startsWith(`com.apple.voice.${tier}.`)) return tier
  }
  return 'unknown'
}

/**
 * The primary language subtag, lowercased — `zh` for `zh-CN`, `zh_TW` and
 * `zh-Hans` alike.
 *
 * `_` is folded to `-` because a book declares whatever its author typed:
 * BCP 47 says `zh-TW`, and EPUBs in the wild carry `zh_TW`. Splitting on both
 * costs one character here and saves a class of book being read in the wrong
 * language for no reason a reader could ever diagnose.
 */
export function primaryOf(lang: string): string {
  const normalized = lang.trim().toLowerCase().replace(/_/gu, '-')
  const [primary = ''] = normalized.split('-')
  return primary
}

/** `lang`, folded so two spellings of one language compare equal. */
function normalize(lang: string): string {
  return lang.trim().toLowerCase().replace(/_/gu, '-')
}

/**
 * How well a voice's language answers the document's: 2 exact, 1 same
 * language, 0 no.
 *
 * A same-language match is kept rather than refused — an `en-GB` voice reading
 * an `en-US` book is a reader hearing the book in an accent, where refusing it
 * is a reader hearing the platform's default, which may be a different
 * language entirely. The region is preferred where it is offered, which is what
 * the two weights are for.
 */
function languageScore(voice: string, wanted: string): number {
  if (normalize(voice) === normalize(wanted)) return 2
  const primary = primaryOf(wanted)
  return primary !== '' && primaryOf(voice) === primary ? 1 : 0
}

/**
 * Whether this voice may ever be chosen, before any question about language.
 *
 * ONE PREDICATE, because three callers ask it and two of them had drifted: a
 * stored choice was once checked for language and not for novelty, and the
 * no-language list would have been a third place to forget. A sound effect
 * (see `SOUND_EFFECTS`) and a voice the engine synthesises on a server (see
 * `VoiceFacts.localService`) are both refused everywhere, always.
 */
function selectable(voice: VoiceFacts): boolean {
  return voice.localService !== false && tierOf(voice.voiceURI) !== 'novelty'
}

/**
 * The key a reader's voice choice is stored under.
 *
 * `''` IS A REAL KEY AND MEANS "the book declares no language". It is not a
 * missing value: such books exist, `bestVoice` deliberately refuses to guess a
 * language for one, and without somewhere to record a choice the reader had no
 * way to correct whatever the platform picked. `primaryOf('')` is also `''`, so
 * a blank declaration and an absent one land in the same place, which is what
 * they mean.
 */
export function voiceKey(lang: string | null): string {
  return lang === null ? '' : primaryOf(lang)
}

/**
 * How good a voice is for a document in `lang`. Zero means *never this one*.
 *
 * ONE FORMULA, IN ONE PLACE, because two callers maximise it: `bestVoice` takes
 * the top and `voiceOptions` sorts by it. Written out twice, the picker's order
 * and the automatic choice drift apart, and the first symptom is a picker whose
 * first row is not the voice the app actually uses — which reads as the default
 * being a mistake.
 *
 * ⚠️ **LANGUAGE OUTRANKS TIER, AND NOT BY A LITTLE.** A premium voice for the
 * wrong region beats nothing, but an exact-region compact voice beats a premium
 * one from another region: a Traditional-Chinese voice reading a Simplified book
 * is a worse answer than a smaller voice reading it correctly. The multiplier
 * only has to exceed the tier range, and is checked by a test that pits the two
 * against each other rather than by inspection.
 */
function scoreOf(voice: VoiceFacts, lang: string): number {
  if (!selectable(voice)) return 0
  const tier = tierOf(voice.voiceURI)
  if (tier === 'novelty') return 0
  const language = languageScore(voice.lang, lang)
  if (language === 0) return 0
  /* ⚠️ **THERE WAS A `+ 1` HERE AND ITS REASON WAS FALSE.** It claimed to keep
   * the worst selectable combination above zero; the worst is already
   * `1 * 10 + 0`, so it never did anything. What keeps the scale honest is that
   * the language multiplier exceeds the tier range — which a test asserts
   * directly rather than a constant implying it. */
  return language * 10 + TIER_RANK[tier]
}

/**
 * The best voice for a document in `lang`, or null to leave the platform's own.
 *
 * Null for a null language, which is `documentLang`'s answer for a section that
 * declares none. That is deliberate and matches what `Speaker.speak` already
 * does with `utterance.lang`: a book that has not said what language it is in
 * is a book whose reader's own default voice is the best guess there is, and
 * choosing one on its behalf would be picking a language for it.
 *
 * Ties break toward the FIRST voice the engine listed, because only a strictly
 * better score replaces the incumbent. The engine's order is stable within a
 * session, so the same book gets the same voice twice — which matters more than
 * which of two equals wins.
 */
export function bestVoice<T extends VoiceFacts>(voices: readonly T[], lang: string | null): T | null {
  if (lang === null || lang.trim() === '') return null

  let best: T | null = null
  let bestScore = 0
  for (const voice of voices) {
    const score = scoreOf(voice, lang)
    if (score > bestScore) {
      bestScore = score
      best = voice
    }
  }
  return best
}

/**
 * The voice the reader chose for this language, if it is still here and still
 * answers for the book in hand.
 *
 * ⚠️ **A CHOICE IS PER LANGUAGE, AND THE LANGUAGE IS CHECKED.** One stored
 * voice for the whole app is the shape that fails: a reader who picks a voice
 * they like for English then opens a Chinese book and hears it read in English,
 * which is the `canSay` argument the deleted `core/voice.ts` made — a wrong
 * answer the reader cannot check. Keyed on the primary subtag, so a choice made
 * on a `zh-CN` book serves a `zh-TW` one, and never an English one.
 *
 * ⚠️ **AND A STORED CHOICE THAT IS GONE IS NOT AN ERROR.** Voices arrive and
 * leave with what the machine has installed, and a preference naming one that
 * is no longer there must fall through to the automatic pick rather than
 * leaving the reader with no voice. Same rule as `faceById` mapping a typeface
 * this machine lacks to the default.
 */
export function chosenVoice<T extends VoiceFacts>(
  voices: readonly T[],
  lang: string | null,
  chosen: Readonly<Record<string, string>>,
): T | null {
  const wanted = chosen[voiceKey(lang)]
  if (wanted === undefined || wanted === '') return null
  /* ⚠️ **A BOOK WITH NO DECLARED LANGUAGE HAS NO LANGUAGE TO CHECK, AND USED TO
   * HAVE NO CHOICE EITHER.** `bestVoice` still refuses to guess one — that is
   * the rule, not an omission — so without a stored choice the reader was left
   * with whatever the platform picked and nothing to say about it. The choice
   * is honoured here under the `''` key; only the language test is skipped,
   * never `selectable`. */
  const declared = lang !== null && lang.trim() !== ''
  /* ⚠️ **THE NOVELTY RULE APPLIES HERE TOO, AND IT DID NOT.** `bestVoice` and
   * `voiceOptions` both promise never to choose a sound effect; a stored
   * preference naming Boing walked straight past both of them, because a
   * choice was only ever checked for language. A hand-edited settings file is
   * exactly where such a value comes from. Falls through to the automatic
   * pick, which is what an absent choice does. */
  return (
    voices.find(
      (voice) =>
        voice.voiceURI === wanted &&
        selectable(voice) &&
        (!declared || languageScore(voice.lang, lang) > 0),
    ) ?? null
  )
}

/**
 * The voice to speak a document in `lang` with: the reader's, else the best
 * one, else none.
 *
 * The one function `Speaker` calls. Kept as a composition of the two halves
 * rather than one function with a branch in it, because each half has its own
 * rule worth testing on its own — that a stale choice falls through, and that
 * the automatic pick refuses novelty.
 */
export function voiceFor<T extends VoiceFacts>(
  voices: readonly T[],
  lang: string | null,
  chosen: Readonly<Record<string, string>> = {},
): T | null {
  return chosenVoice(voices, lang, chosen) ?? bestVoice(voices, lang)
}

/**
 * The voices worth offering a reader for a document in `lang`, best first.
 *
 * Novelty voices are left out here too. A picker is a list of things somebody
 * might want, and nineteen sound effects in front of the eight voices that can
 * read a book is how a reader concludes the feature is unserious. A reader who
 * genuinely wants Zarvox has the platform's own Spoken Content settings.
 *
 * SORTED BY THE SAME SCORE `bestVoice` MAXIMISES, so the top of the list is
 * what the app would have chosen by itself. A picker whose first row is not the
 * default is a picker that makes the default look like a mistake.
 */
export function voiceOptions<T extends VoiceFacts>(voices: readonly T[], lang: string | null): readonly T[] {
  if (lang === null || lang.trim() === '') {
    /* EVERY SELECTABLE VOICE, BY TIER, because there is no language to rank
     * against — and an empty list was what left a language-less book with no
     * voice control at all. `sort` is stable, so voices of one tier keep the
     * engine's own order, exactly as the language path relies on. */
    return voices
      .filter(selectable)
      .map((voice) => ({ voice, tier: tierOf(voice.voiceURI) }))
      .sort((a, b) => rankOf(b.tier) - rankOf(a.tier))
      .map((row) => row.voice)
  }
  const language = lang
  return voices
    .map((voice) => ({ voice, score: scoreOf(voice, language) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.voice)
}

/**
 * The offered voices, split into the tiers a reader is choosing between.
 *
 * ⚠️ **THE TIERS STAY APART BECAUSE THE NAMES COLLIDE.** Merging `compact` and
 * `super-compact` into one "Standard" group reads better right up until the
 * list is drawn: this Mac offers two voices called Samantha and two called
 * Tingting, differing only in tier, so a merged group shows the same name twice
 * with no way to tell which is which. The group heading is the disambiguation.
 *
 * ORDER IS `TIER_RANK`'s, not the view's. A picker that ordered its own groups
 * would be a second copy of the ranking, and the first symptom of the two
 * disagreeing is a list whose first row is not what the app chose — the same
 * drift `scoreOf` exists to prevent. Empty tiers are dropped, so a machine with
 * nothing installed but compact voices shows one group rather than five.
 */
export function voiceGroups<T extends VoiceFacts>(
  voices: readonly T[],
  lang: string | null,
): readonly { readonly tier: Exclude<VoiceTier, 'novelty'>; readonly voices: readonly T[] }[] {
  /* ⚠️ **ORDERED BY WHAT IS IN THEM, NOT BY TIER — AND IT WAS BY TIER.** Sorting
   * the groups by rank alone contradicted `bestVoice` exactly where the two most
   * needed to agree: with an `en-GB` Premium and an `en-US` Compact installed,
   * `bestVoice` takes the Compact one (language outranks tier) while the picker
   * put Premium first. The reader was then shown a first row that was not the
   * default, which is the drift `scoreOf` exists to prevent. Built in the order
   * `voiceOptions` already sorted them into, so first-seen IS best-scoring. */
  const offered = voiceOptions(voices, lang)
  const groups: { tier: Exclude<VoiceTier, 'novelty'>; voices: T[] }[] = []
  for (const voice of offered) {
    const tier = tierOf(voice.voiceURI)
    /* `voiceOptions` has already dropped both, so this is a narrowing for the
     * type rather than a second filter. */
    if (tier === 'novelty') continue
    /* ⚠️ **ONLY THE RUN THAT IS STILL OPEN, NEVER AN EARLIER GROUP OF THE SAME
     * TIER.** Merging by tier across the whole list looked right and quietly
     * undid the ordering again: with an exact-language compact, an exact
     * super-compact and an other-region compact, searching for an existing
     * `compact` group pulled the other-region voice up past the exact
     * super-compact one. The list arrives in score order, so the groups are its
     * consecutive runs — and a tier that appears twice appears twice. */
    const open = groups[groups.length - 1]
    if (open && open.tier === tier) open.voices.push(voice)
    else groups.push({ tier, voices: [voice] })
  }
  return groups
}
