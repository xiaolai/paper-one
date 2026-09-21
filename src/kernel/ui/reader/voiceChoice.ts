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
 * ⚠️ **NO VOICE RATHER THAN A BAD ONE — the owner's rule, 2026-09-21.** Where
 * the identifier names the tier, only `enhanced` and `premium` may read a book;
 * `compact`, `super-compact` and the old `com.apple.speech.synthesis` family —
 * Fred and Kathy as much as Boing and Zarvox — are below the floor, and are
 * EXCLUDED rather than ranked low, because ranking low still selects them when
 * they are all there is. When nothing passes, `voiceFor` answers `none` and the
 * reading does not start, instead of handing the book to the platform default,
 * which on a Mac is exactly the compact voice the floor refused.
 *
 * ⚠️ **ON macOS THAT MEANS READ ALOUD IS OFF, AND IT WAS MEASURED, NOT
 * ASSUMED.** On 2026-09-21 four good voices were installed on a macOS 27 machine
 * that already had six Siri neural ones: the WebView went on offering the same
 * 70 compact, super-compact and novelty voices, and a compact voice rendered
 * byte-identically with or without its Enhanced asset installed. See AGENTS.md,
 * "No good voice ever reaches the WebView". A good voice there needs the native
 * engine, which is a separate decision.
 *
 * ⚠️ **AND `unknown` STAYS ABOVE THE FLOOR.** Only Apple spells identifiers this
 * way. On Linux, on Windows, and in a browser on either, every `voiceURI` is
 * something else — so a floor that refused what it could not read would take
 * read aloud away everywhere but Apple's platforms, on no evidence about any of
 * those voices. The rule is applied where the tier is legible, and only there.
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
  | 'unknown'

/**
 * The tiers at or above the floor — the only ones a book is read in.
 *
 * A TYPE OF ITS OWN, so every map over tiers a reader can meet — the ranking
 * here, the labels in Settings — is typed over what can actually be offered,
 * and a below-floor tier cannot be given a rank or a heading by mistake.
 */
export type ReadableTier = 'premium' | 'enhanced' | 'unknown'

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
   * ⚠️ **REFUSING TO PICK ONE DID NOT CLOSE THE HOLE; REFUSING TO SPEAK DOES.**
   * Leaving `utterance.voice` unset used the platform's default, which on a
   * machine with only remote voices IS remote, so the text went out anyway. That
   * was a product decision this module could not make, and it has been made —
   * no voice rather than a bad one — so a book whose language only a remote
   * voice speaks is answered `none` by `voiceFor`, and is not read.
   */
  readonly localService?: boolean | undefined
  /**
   * Whether the engine calls this its own default for the app's language.
   *
   * ⚠️ **THIS IS THE ONLY QUALITY SIGNAL THAT EXISTS OFF APPLE'S PLATFORMS, AND
   * THE FIRST VERSION OF THIS MODULE THREW IT AWAY.** `tierOf` answers `unknown`
   * for every voice on Windows, Linux, Android and a browser on any of them —
   * so every same-language voice there scores IDENTICALLY, and the tie went to
   * whichever the engine happened to list first. That is not a choice, it is an
   * array index; and before this module existed the platform's own default was
   * what a reader got. Ranking by array order can therefore be WORSE than doing
   * nothing, on exactly the platforms where the ranking knows least.
   *
   * It is a TIEBREAK and never a score, because the two signals answer
   * different questions: the tier says how good a voice is, and this says which
   * one the vendor points at. Where the tier is legible it should win — a
   * downloaded premium voice beats the compact one macOS still calls default.
   */
  readonly default?: boolean | undefined
}

/**
 * How much better one readable tier is than another. Higher wins.
 *
 * Only the readable ones, because nothing below the floor is ever compared —
 * every path refuses it before ranking anything. `unknown` ranks last: it is
 * only ever beside another `unknown`, since no engine mixes Apple's identifiers
 * with anyone else's, and there the engine's own default breaks the tie.
 */
const TIER_RANK: Record<ReadableTier, number> = {
  premium: 2,
  enhanced: 1,
  unknown: 0,
}

/**
 * How much one step of language match is worth, in tier ranks.
 *
 * ⚠️ **IT WAS A LITERAL `10`, WHICH ENCODED THE POLICY WITHOUT STATING IT.** The
 * invariant is that LANGUAGE OUTRANKS TIER — a premium voice for the wrong script
 * must never beat a compact one that can read the characters — and a literal
 * leaves that true only while nobody adds a tier. Add a rank of 10 and the policy
 * silently inverts, with no type error and no failing test until somebody notices
 * a book being read in the wrong language.
 *
 * Derived from the table it has to exceed, so the invariant holds by construction
 * rather than by the number happening to be big enough.
 */
const LANGUAGE_WEIGHT = Math.max(...Object.values(TIER_RANK)) + 1

/** The `com.apple.voice.<tier>.<lang>.<Name>` families, by the tier they name. */
const APPLE_TIERS: readonly VoiceTier[] = ['premium', 'enhanced', 'compact', 'super-compact']

/**
 * Apple's oldest family — Fred, Kathy, Ralph, Junior — and its sound effects.
 *
 * ⚠️ **ONE TIER NOW, AND THE LIST THAT SPLIT IT IS GONE.** This family used to
 * be divided by a hand-kept list of fifteen sound effects (Boing, Zarvox…), so
 * that Fred and Kathy stayed choosable while Boing did not. The floor takes the
 * whole family, so the split decided nothing any more — and a denylist that
 * fails open, letting any effect it did not name through as a voice, was an
 * audit finding of its own. Below the floor, a new effect Apple adds is refused
 * with the rest, whatever it is called.
 */
const LEGACY_PREFIX = 'com.apple.speech.synthesis.'

/**
 * The tier a `voiceURI` names, or `unknown` when it is not Apple's.
 *
 * The old family is checked FIRST, and the order matters: both families begin
 * `com.apple.`, and `com.apple.speech.synthesis.voice.Boing` contains no tier
 * word, so a tier scan that ran first would answer `unknown` for it — which is
 * above the floor. Boing would then read books.
 */
export function tierOf(voiceURI: string): VoiceTier {
  if (voiceURI.startsWith(LEGACY_PREFIX)) return 'legacy'
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
  /* THROUGH `normalize`, not a copy of it. This repeated its trim, lower-case and
     underscore rule inline, so a change to how a tag is normalised — a second
     separator, a different case rule — would have reached one path and not the
     other, and the key a choice is STORED under would stop matching the tag it
     is LOOKED UP by. Function declarations hoist, so the order below is fine. */
  const tag = normalize(lang)
  const cut = tag.indexOf('-')
  return cut === -1 ? tag : tag.slice(0, cut)
}

/** `lang`, folded so two spellings of one language compare equal. */
function normalize(lang: string): string {
  return lang.trim().toLowerCase().replace(/_/gu, '-')
}

/**
 * The script a tag is written in — `Hans` for `zh-CN`, `Hant` for `zh-TW`.
 *
 * ⚠️ **SCRIPT IS WHAT DECIDES WHETHER A VOICE CAN READ THE TEXT AT ALL, AND
 * `languageScore` WAS BLIND TO IT.** Every tag sharing a primary subtag scored
 * the same, so a Traditional-Chinese voice was as good an answer as a Simplified
 * one for a Simplified book — which this module's own header calls out as the
 * wrong answer in as many words: *"a Traditional-Chinese voice reading a
 * Simplified book is a worse answer than a smaller voice reading it correctly."*
 * The intent was written down and the code did not implement it. The same
 * blindness pairs `sr-Latn` with `sr-Cyrl`.
 *
 * `maximize()` is what supplies a script nobody wrote down: `zh-CN` carries no
 * script subtag and means Hans. It THROWS on a tag it cannot parse, and a book's
 * `dc:language` is whatever its author typed — so a malformed tag answers null
 * and the caller falls back to comparing primary subtags, which is what this
 * module did for every tag before.
 */
function scriptOf(lang: string): string | null {
  try {
    return new Intl.Locale(normalize(lang)).maximize().script ?? null
  } catch {
    return null
  }
}

/**
 * How well a voice's language answers the document's: 3 exact, 2 same language
 * in the same script, 1 same language in another or an unknown script, 0 a
 * different language.
 *
 * ⚠️ **THIS SAID "2 exact, 1 same language, 0 no" FOR A FUNCTION THAT HAS FOUR
 * ANSWERS.** The script level was added in `b8b5e02`, which is what stops a
 * Simplified voice outranking a Traditional one for a Taiwanese book, and the
 * sentence describing the scale was left describing the old one — so the only
 * summary of what these numbers mean had one of them missing.
 *
 * A same-language match is kept rather than refused — an `en-GB` voice reading
 * an `en-US` book is a reader hearing the book in an accent, where refusing it
 * is a reader hearing the platform's default, which may be a different
 * language entirely. The region is preferred where it is offered, which is what
 * the two weights are for.
 */
function languageScore(voice: string, wanted: string): number {
  if (normalize(voice) === normalize(wanted)) return 3
  const primary = primaryOf(wanted)
  if (primary === '' || primaryOf(voice) !== primary) return 0

  /**
   * ⚠️ **THE SCRIPT IS A MIDDLE RANK, NOT A GATE — AND MAKING IT A GATE WAS A
   * REGRESSION I ALMOST SHIPPED.** Scoring a wrong-script voice 0 made
   * `bestVoice` answer null for a Simplified book on a machine whose only Chinese
   * voice is Traditional — and null means the PLATFORM's default, which on an
   * English system is an English voice reading Chinese characters. Two existing
   * cases caught it.
   *
   * A `zh-TW` voice reading Simplified text is a wrong ACCENT, not an inability:
   * it says the words. This module's header calls a Traditional voice for a
   * Simplified book "a worse answer than a smaller voice reading it correctly" —
   * worse than the right script, which is what this ranks. It does not say worse
   * than no voice at all, and that is the distinction the first version lost.
   *
   * Unknown script on either side ranks with the wrong one rather than below it:
   * a tag this runtime cannot parse should be no worse off than before the script
   * was consulted at all.
   */
  const wantedScript = scriptOf(wanted)
  const voiceScript = scriptOf(voice)
  /* ONE TEST, NOT A GUARD AND A COMPARISON. Two nulls would compare equal, so
     an unknown book script has to be ruled out before the scripts are matched;
     written as a separate early return for either side, half of it could never
     change an answer, since a known script never equals an unknown one. */
  return wantedScript !== null && wantedScript === voiceScript ? 2 : 1
}

/**
 * The tier this voice reads at, or null when it may never be chosen — before
 * any question about language.
 *
 * ONE PREDICATE, because three callers ask it and two of them had drifted: a
 * stored choice was once checked for language and not for novelty, and the
 * no-language list would have been a third place to forget. A voice below the
 * floor and a voice the engine synthesises on a server (see
 * `VoiceFacts.localService`) are both refused everywhere, always.
 *
 * ANSWERS THE TIER rather than a yes, so a caller that ranks what passed has
 * nothing left to narrow: the type says a readable tier, and there is no second
 * check to write that could never fail.
 */
function readableTier(voice: VoiceFacts): ReadableTier | null {
  if (voice.localService === false) return null
  const tier = tierOf(voice.voiceURI)
  return tier === 'premium' || tier === 'enhanced' || tier === 'unknown' ? tier : null
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
function scoreOf(voice: VoiceFacts, tier: ReadableTier, lang: string): number {
  /* THE TIER IS PASSED IN, not asked again: `offered`, the only caller, has
     already refused every voice below the floor, so a second `readableTier`
     here had a null branch no voice could reach. */
  const language = languageScore(voice.lang, lang)
  if (language === 0) return 0
  /* ⚠️ **THERE WAS A `+ 1` HERE AND ITS REASON WAS FALSE.** It claimed to keep
   * the worst selectable combination above zero; the worst is already
   * `1 * LANGUAGE_WEIGHT + 0`, so it never did anything. */
  return language * LANGUAGE_WEIGHT + TIER_RANK[tier]
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
 * ⚠️ **IT IS `voiceOptions`' FIRST ROW NOW, NOT A SECOND SEARCH THAT AGREES WITH
 * IT.** `scoreOf`'s comment warns that written out twice the picker's order and
 * the automatic choice drift apart — and they were written out twice, so the
 * drift arrived with the very first change to either: a tiebreak that reached
 * one of them and not the other. One being the other's first element is the
 * only arrangement in which they cannot disagree.
 *
 * Ties the tiebreak does not settle still go to the FIRST voice the engine
 * listed, because `sort` is stable. The engine's order holds within a session,
 * so the same book gets the same voice twice, which matters more than which of
 * two equals wins.
 */
export function bestVoice<T extends VoiceFacts>(voices: readonly T[], lang: string | null): T | null {
  if (lang === null || lang.trim() === '') return null
  return voiceOptions(voices, lang)[0] ?? null
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
  /* ABSENT AND `''` ALIKE: `''` is what the picker's Automatic row stores, so it
     must never match a voice — not even an engine's voice whose `voiceURI`
     happens to be empty. */
  if (!wanted) return null
  /* ⚠️ **A BOOK WITH NO DECLARED LANGUAGE HAS NO LANGUAGE TO CHECK, AND USED TO
   * HAVE NO CHOICE EITHER.** `bestVoice` still refuses to guess one — that is
   * the rule, not an omission — so without a stored choice the reader was left
   * with whatever the platform picked and nothing to say about it. The choice
   * is honoured here under the `''` key; only the language test is skipped,
   * never the floor. */
  const declared = lang !== null && lang.trim() !== '' ? lang : null
  /* ⚠️ **THE FLOOR APPLIES HERE TOO.** `bestVoice` and `voiceOptions` both
   * promise never to choose a voice below it; a stored preference naming Boing —
   * or, since the floor, a compact voice chosen before there was one — would
   * walk straight past both, because a choice was once only checked for
   * language. A hand-edited or older settings file is exactly where such a value
   * comes from. Falls through to the automatic pick, which is what an absent
   * choice does. */
  return (
    voices.find(
      (voice) =>
        voice.voiceURI === wanted &&
        readableTier(voice) !== null &&
        (declared === null ||
          (languageScore(voice.lang, declared) > 0 && !otherScript(voice.lang, declared))),
    ) ?? null
  )
}

/**
 * Whether a voice is for the same language in a DIFFERENT, KNOWN script.
 *
 * ⚠️ **A CHOICE IS STORED PER PRIMARY LANGUAGE, SO `zh-CN` AND `zh-TW` SHARE
 * ONE — AND A SIMPLIFIED-CHINESE VOICE THEN READ TRADITIONAL BOOKS.** The key is
 * deliberately coarse: a reader should not have to choose again for every
 * regional variant of a language they read. But the automatic pick already
 * refuses to cross a script (`languageScore`, since `b8b5e02`), and the stored
 * choice walked straight past that rule, because `languageScore > 0` is true for
 * a same-language voice in either script. So the check is tightened here instead
 * of the key: a stored voice is not used where its script and the book's are
 * both known and differ, and the automatic pick — which is script-aware — answers
 * instead. Changing the KEY would have lost every Chinese reader's saved choice.
 *
 * An UNKNOWN script on either side is not a difference: most voices and most
 * books do not say, and refusing on silence would discard ordinary choices.
 */
function otherScript(voiceLang: string, bookLang: string): boolean {
  const voice = knownScriptOf(voiceLang)
  const book = knownScriptOf(bookLang)
  return voice !== null && book !== null && voice !== book
}

/**
 * The script a tag SAYS, or implies through its region — never a guess.
 *
 * ⚠️ **NOT `scriptOf`, WHICH MAXIMIZES.** `Intl.Locale('zh').maximize()` answers
 * Hans for a tag that names no script and no region, because Hans is the likelier
 * one — which is right for RANKING, where a guess only reorders, and wrong for
 * REFUSING, where it would throw away a voice the reader explicitly chose for a
 * book that never said which script it is written in. So a script counts as known
 * here only when the tag carries one (`zh-Hant`) or names a region that settles it
 * (`zh-TW`); a bare language is unknown, and unknown is not a difference.
 */
function knownScriptOf(lang: string): string | null {
  try {
    const locale = new Intl.Locale(normalize(lang))
    if (locale.script) return locale.script
    return locale.region ? (locale.maximize().script ?? null) : null
  } catch {
    return null
  }
}

/**
 * What the reader is told when no voice clears the floor — see `voiceFor`.
 *
 * NOT "install a voice", although that is the obvious advice: on a Mac it is
 * false. Measured 2026-09-21, installed Enhanced and neural voices never reach
 * the WebView this app speaks through, so a reader sent to System Settings
 * would come back to the same refusal. It says what is true — nothing good
 * enough is available HERE — and why the export stopped.
 */
export const NO_GOOD_VOICE = 'No high-quality voice can read this book here, so it is not read in a low-quality one.'

/**
 * What to speak a document in `lang` with — see `voiceFor`.
 *
 * - `voice`: this one.
 * - `platform`: leave the utterance's voice unset, because there is nothing
 *   here to judge — the engine has listed no voices yet, or the book declares
 *   no language and good voices exist for the platform to choose among.
 * - `none`: no voice good enough can read it, so it is not read.
 */
export type VoiceAnswer<T> =
  | { readonly kind: 'voice'; readonly voice: T }
  | { readonly kind: 'platform' }
  | { readonly kind: 'none' }

/**
 * The voice to speak a document in `lang` with: the reader's, else the best
 * one — else the platform's where nothing here can judge it, else none.
 *
 * The one function the reading and the audiobook export call. `chosenVoice` and
 * `bestVoice` stay separate halves because each has its own rule worth testing
 * on its own — that a stale choice falls through, and that the automatic pick
 * holds the floor.
 *
 * ⚠️ **NULL USED TO MEAN "THE PLATFORM'S DEFAULT", AND THAT WAS THE HOLE.** A
 * null from here left `utterance.voice` unset, so a book the floor refused every
 * voice for was read anyway, in whatever the platform chose — on a Mac, compact
 * Samantha, the exact voice refused. So `none` is its own answer now, and only
 * the two cases where nothing can be judged fall to the platform:
 *
 * - AN EMPTY LIST is an engine that has not loaded its voices yet (`useVoices`),
 *   or has none; refusing on it would refuse on silence. The window on a Mac is
 *   the first moment after launch, before `voiceschanged`.
 * - A BOOK WITH NO DECLARED LANGUAGE on a list that holds good voices: choosing
 *   one would be choosing the book's language for it — `bestVoice`'s rule — so
 *   the platform's own pick stands, and the reader can name one in Settings.
 *   The platform's pick cannot be judged in advance: WebKit flags EVERY voice
 *   `default`, measured 2026-09-21, so no flag says which it will take.
 *
 * A book that DECLARES a language and has no good voice for it is `none`: a
 * voice for another language is not a worse reading of it, it is not a reading.
 */
export function voiceFor<T extends VoiceFacts>(
  voices: readonly T[],
  lang: string | null,
  chosen: Readonly<Record<string, string>> = {},
): VoiceAnswer<T> {
  const voice = chosenVoice(voices, lang, chosen) ?? bestVoice(voices, lang)
  if (voice) return { kind: 'voice', voice }
  if (voices.length === 0) return { kind: 'platform' }
  if (lang !== null && lang.trim() !== '') return { kind: 'none' }
  return offered(voices, null).length > 0 ? { kind: 'platform' } : { kind: 'none' }
}

/**
 * The voices above the floor for a document in `lang`, best first, each with
 * the tier it earned — `voiceOptions` and `voiceGroups` are this, seen two ways.
 */
function offered<T extends VoiceFacts>(
  voices: readonly T[],
  lang: string | null,
): readonly { readonly voice: T; readonly tier: ReadableTier }[] {
  const rows = voices.flatMap((voice) => {
    const tier = readableTier(voice)
    return tier === null ? [] : [{ voice, tier }]
  })
  if (lang === null || lang.trim() === '') {
    /* EVERY READABLE VOICE, BY TIER, because there is no language to rank
     * against — and an empty list was what left a language-less book with no
     * voice control at all. `sort` is stable, so voices of one tier keep the
     * engine's own order, exactly as the language path relies on. */
    return [...rows].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])
  }
  const language = lang
  return rows
    .map((row) => ({ ...row, score: scoreOf(row.voice, row.tier, language) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || defaultRank(b.voice) - defaultRank(a.voice))
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
  return offered(voices, lang).map((row) => row.voice)
}

/**
 * The engine's own default, as a tiebreak between voices that scored equally.
 *
 * ⚠️ **IT DECIDES ALMOST NOTHING ON macOS AND ALMOST EVERYTHING OFF IT.** Where
 * `voiceURI` names a tier, two voices rarely tie; where it does not — Windows,
 * Linux, Android, any browser — EVERY same-language voice is `unknown`, so the
 * tie is the normal case and this is the whole of the decision. Picking the one
 * the vendor points at is strictly more information than picking index 0, which
 * is what the first version of this module did.
 */
/* ⚠️ **AND ON WebKit IT DECIDES NOTHING AT ALL:** every voice the WebView lists
 * is flagged `default` — all 70 on a macOS 27 machine, measured 2026-09-21. */
function defaultRank(voice: VoiceFacts): number {
  return voice.default === true ? 1 : 0
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
): readonly { readonly tier: ReadableTier; readonly voices: readonly T[] }[] {
  /* ⚠️ **ORDERED BY WHAT IS IN THEM, NOT BY TIER — AND IT WAS BY TIER.** Sorting
   * the groups by rank alone contradicted `bestVoice` exactly where the two most
   * needed to agree: with an `en-GB` Premium and an `en-US` Compact installed,
   * `bestVoice` takes the Compact one (language outranks tier) while the picker
   * put Premium first. The reader was then shown a first row that was not the
   * default, which is the drift `scoreOf` exists to prevent. Built in the order
   * `voiceOptions` already sorted them into, so first-seen IS best-scoring. */
  const groups: { tier: ReadableTier; voices: T[] }[] = []
  for (const { voice, tier } of offered(voices, lang)) {    /* ⚠️ **ONLY THE RUN THAT IS STILL OPEN, NEVER AN EARLIER GROUP OF THE SAME
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
