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
export type VoiceTier = 'premium' | 'enhanced' | 'compact' | 'super-compact' | 'novelty' | 'unknown'

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
}

/**
 * How much better one tier is than another. Higher wins.
 *
 * `novelty` has no rank because it is never compared — `bestVoice` drops it
 * before ranking anything. It is in `VoiceTier` so that a picker can say what
 * it left out.
 */
const TIER_RANK: Record<Exclude<VoiceTier, 'novelty'>, number> = {
  premium: 4,
  enhanced: 3,
  compact: 2,
  unknown: 1,
  'super-compact': 0,
}

/** The `com.apple.voice.<tier>.<lang>.<Name>` families, by the tier they name. */
const APPLE_TIERS: readonly VoiceTier[] = ['premium', 'enhanced', 'compact', 'super-compact']

/** Apple's novelty and legacy family — Bad News, Boing, Zarvox, Albert. */
const NOVELTY_PREFIX = 'com.apple.speech.synthesis.'

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
  if (voiceURI.startsWith(NOVELTY_PREFIX)) return 'novelty'
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
  const tier = tierOf(voice.voiceURI)
  if (tier === 'novelty') return 0
  const language = languageScore(voice.lang, lang)
  if (language === 0) return 0
  /* The `+ 1` keeps the WORST selectable combination above zero. Without it a
   * `super-compact` voice whose language merely shares a primary subtag scores
   * 1 * 10 + 0, which is fine — but the lowest tier at the lowest match must
   * never be able to reach the value that means "excluded", and stating that
   * here is cheaper than re-deriving it whenever a tier is added. */
  return language * 10 + TIER_RANK[tier] + 1
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
  if (lang === null || lang.trim() === '') return null
  const wanted = chosen[primaryOf(lang)]
  if (wanted === undefined || wanted === '') return null
  return voices.find((voice) => voice.voiceURI === wanted && languageScore(voice.lang, lang) > 0) ?? null
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
  if (lang === null || lang.trim() === '') return []
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
  const offered = voiceOptions(voices, lang)
  const order = (Object.keys(TIER_RANK) as Exclude<VoiceTier, 'novelty'>[]).sort(
    (a, b) => TIER_RANK[b] - TIER_RANK[a],
  )
  return order
    .map((tier) => ({ tier, voices: offered.filter((voice) => tierOf(voice.voiceURI) === tier) }))
    .filter((group) => group.voices.length > 0)
}
