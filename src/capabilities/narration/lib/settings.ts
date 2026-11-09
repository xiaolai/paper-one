import { defineSetting, type Setting, type SettingsStore, type SteppedScale } from '../../../kernel'
import type { SpeakPrefs } from './speaker'

/**
 * Read aloud's settings: the voice per language, the speed, the volume, the
 * pauses and whether a note's body is read.
 *
 * ⚠️ **THEY WERE THE KERNEL'S UNTIL STEP 5.5, STORED AS `kernel.<name>`.** The
 * names are unchanged under `narration.`, and the kernel's settings store
 * copies each stored value across on every load (`carryNarrationSettings`), so
 * a reader's voice and speed survive the move without a version bump. The
 * defaults and the clamps are the ones the kernel had.
 */

/**
 * How fast the book is read aloud, as a multiplier on the engine's own speed.
 *
 * A SCALE RATHER THAN A SLIDER, for the reason every other scale here gives: a
 * value between two steps is not a decision anybody made. These particular
 * numbers are the ones listeners already know from every audiobook player, which
 * matters more than an even distribution — 1.25× and 1.5× are what somebody
 * reaches for by name.
 *
 * 1 IS THE ENGINE'S OWN DEFAULT and is therefore the default here, and `def`
 * is its INDEX, as on every scale in this file. The clamp the stored value is
 * validated against is derived from the two ends, so the range a reader can
 * store and the range this offers cannot disagree.
 */
// Stryker disable next-line ObjectLiteral: emptying this scale leaves `READING_RATE_MIN` below reading `.steps` off a missing array, at module scope — so the mutant throws while this module is being imported, every covering suite fails to LOAD, no test fails, and Stryker's vitest runner reports it Survived with nothing able to kill it (the shape `metrics.ts` measured 2026-09-14)
export const READING_RATE: SteppedScale = {
  steps: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5],
  def: 2,
  unit: 'x',
}

/**
 * The silence read aloud leaves at a sentence end and at a paragraph end.
 *
 * ⚠️ **ONLY EXPRESSIBLE BECAUSE THE READING IS SENTENCE-AT-A-TIME.** With a whole
 * section queued as one utterance there is nowhere to put a pause: Web Speech
 * exposes no break, no SSML and no inter-utterance delay. One utterance per
 * sentence turns it into a timer between two of them, and the block index
 * `collectText` records is what tells the two boundaries apart.
 *
 * ⚠️ **IN MILLISECONDS, AND NOT SCALED BY THE READING RATE.** Scaling was the
 * other candidate and the argument for it is real — at 2.5× the words are shorter
 * so a fixed gap is proportionally more prominent, and the rhythm changes. It is
 * not taken because a SETTING must mean what it says: a reader who asks for 300ms
 * and hears 120ms at speed has been overruled by the app. The engine's own
 * sentence-final prosody already shortens with rate, so part of the total pause
 * scales anyway, and a reader who wants less at speed can ask for less.
 *
 * ⚠️ **THE DEFAULTS ARE ADDITIVE AND THE ENGINE'S OWN GAP IS UNMEASURED.** Web
 * Speech inserts some silence of its own between two utterances, engine by
 * engine, and nothing here knows how much — the app was not running when these
 * were chosen. So these are a judgement, not a measurement: a breath at a
 * sentence, a clear beat at a paragraph. Measure the engine's contribution in the
 * running app before defending either number.
 *
 * A paragraph boundary uses the paragraph value ALONE, not both added: the label
 * says "between paragraphs", and a reader setting it to zero means no pause there.
 */
/**
 * ⚠️ **THE DEFAULT IS UNMEASURED AGAINST THE ENGINE'S OWN PAUSE, AND ZERO IS NOT
 * THE FIX.** An audit asked for neutral zero defaults, or for the feature to be
 * marked experimental, because Web Speech engines add different intrinsic pauses
 * and 150ms therefore sounds different on each. The premise is right and the
 * remedy is not: what is unmeasured is the ENGINE's baseline, not this value, and
 * zero would not make the rhythm consistent — it would leave whatever each
 * engine already does, unchanged and equally unmeasured, while removing the one
 * control a listener has over it.
 *
 * So the value stays and the CLAIM is narrow: every label says what the reader is
 * ADDING, never what they will hear in total, which is the only sentence that is
 * true on every platform. Measuring the baseline needs the app driven against
 * each engine and is worth doing; until then a stepper that starts at a short
 * pause is better than one that starts at none.
 */
// Stryker disable next-line ObjectLiteral: emptying this scale leaves `SENTENCE_GAP_MIN` below reading `.steps` off a missing array, at module scope — `READING_RATE`'s mutant, one scale along, and unkillable for its reason
export const SENTENCE_GAP: SteppedScale = {
  steps: [0, 150, 300, 500, 750, 1000],
  def: 1,
  unit: 'ms',
}

/** The silence at a paragraph end — see `SENTENCE_GAP`. */
// Stryker disable next-line ObjectLiteral: emptying this scale leaves `PARAGRAPH_GAP_MIN` below reading `.steps` off a missing array, at module scope — `READING_RATE`'s mutant, one scale along, and unkillable for its reason
export const PARAGRAPH_GAP: SteppedScale = {
  steps: [0, 300, 600, 900, 1400, 2000],
  def: 2,
  unit: 'ms',
}

/**
 * The ends of the rate scale, as the stored value's clamp.
 *
 * DERIVED FROM THE SCALE, never typed out again: the range a reader can store
 * and the range the stepper offers are the same range, and two literals is how
 * they stop being. See `READING_RATE` above for the steps themselves.
 *
 * CLAMPED, NOT REJECTED, for the kernel's `textSize` reason one step along: a
 * file written by a build offering a wider range is not corrupt, it is a reader
 * who chose "as fast as it goes" on another build, and the nearest speed this
 * build offers honours that where falling back to 1 would throw it away.
 *
 * A MULTIPLIER RATHER THAN AN INDEX, also for `textSize`'s reason: an index
 * means nothing across a change to the ramp the UI offers, and this one is
 * likely to change — 1 is the engine's default for ever, where `steps[4]` is
 * whatever the fifth entry happens to be that month.
 */
/* READ OFF THE ENDS, and ASSERTED rather than defaulted. `steps[0] ?? 1` and
   `steps[length - 1] ?? 0` each carried a fallback for a scale with no steps —
   which `settings.test.ts` refuses for every scale in the file, so the fallback
   is unreachable, and for a gap scale whose first step IS 0 it could not even
   be told from the value it stood in for. `.at(-1)` says "the last one" without
   arithmetic to get wrong. */
export const READING_RATE_MIN = READING_RATE.steps.at(0)!
export const READING_RATE_MAX = READING_RATE.steps.at(-1)!

/**
 * The ends of a gap scale, as the stored value's clamp — `READING_RATE_MIN`'s
 * reasoning, one scale along, and derived for the same reason: the range a
 * reader can store and the range the stepper offers must be one range.
 */
export const SENTENCE_GAP_MIN = SENTENCE_GAP.steps.at(0)!
export const SENTENCE_GAP_MAX = SENTENCE_GAP.steps.at(-1)!
export const PARAGRAPH_GAP_MIN = PARAGRAPH_GAP.steps.at(0)!
export const PARAGRAPH_GAP_MAX = PARAGRAPH_GAP.steps.at(-1)!

/**
 * How loud Paper reads aloud, in percent of what the voice produces.
 *
 * ONE SCALE FROM THE DISK TO THE CONTROL, and a fraction only at the speakers:
 * both Web Audio and Web Speech take 0 to 1, and `prefsOf` makes that one
 * division. The system volume is never read or changed; this sits underneath it.
 */
export const READING_VOLUME_MIN = 0
export const READING_VOLUME_MAX = 100

/** A number held to `[min, max]`. Only a finite number is handed to it. */
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

/**
 * A stored number on a continuous range — a gap in milliseconds, a speaking
 * rate, a volume — CLAMPED to it rather than rejected.
 *
 * As every other scale here is: a file written by a build offering a longer
 * pause, or a faster voice, is not corrupt. It is a reader who chose "as far as
 * it goes", and the nearest this build offers honours that where falling back
 * to the default would throw it away. Non-finite is refused, because `Infinity`
 * as a timer duration is a reading that never continues, and as a rate it is a
 * voice that never speaks.
 *
 * ⚠️ **THIS WAS TWO FUNCTIONS WITH ONE BODY.** `withinRange(min, max)` and a separate
 * `rate` differed only in where the bounds came from — the second had
 * `READING_RATE_MIN`/`MAX` written into it instead of taking them — so the
 * clamping rule for the reader's speaking rate could be changed without
 * touching the rule for the pauses around it, and neither would look wrong.
 */
const withinRange =
  (min: number, max: number) =>
  (raw: unknown): number | undefined =>
    /* `Number.isFinite` IS THE WHOLE CHECK: it does not coerce, so it answers
       false for a string, an object and a null as surely as for a NaN — and a
       `typeof raw === 'number'` beside it could change no outcome. */
    Number.isFinite(raw) ? clamp(raw as number, min, max) : undefined

const boolean = (raw: unknown): boolean | undefined => (typeof raw === 'boolean' ? raw : undefined)

/**
 * The voice the reader chose, per primary language subtag — `{ en: '…', zh: '…' }`.
 *
 * ONE VOICE PER LANGUAGE, not one for the app: a single stored voice is the
 * shape where a reader who picks an English voice they like then opens a Chinese
 * book and hears it read in English. `voiceChoice.ts` holds the matching rule
 * and the argument.
 *
 * A BAD ENTRY COSTS ITSELF: a junk value for one language must not take the
 * reader's other choices with it. A non-object is rejected, because that is a
 * value of the wrong shape rather than a map with a bad member.
 *
 * ⚠️ **THE KEYS ARE NOT NORMALISED HERE, DELIBERATELY.** The picker only ever
 * writes a primary subtag (`voiceKey`), and a hand-written `en-US` key simply
 * never matches, which falls through to the automatic pick. A key that does
 * nothing is a safe outcome; folding it here would be the matching rule
 * spelled out in two modules.
 */
const voiceChoices = (raw: unknown): Readonly<Record<string, string>> | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  const kept: Record<string, string> = {}
  for (const [lang, voice] of Object.entries(row)) {
    if (typeof voice === 'string' && voice !== '') kept[lang] = voice
  }
  return kept
}

/* ⚠️ **EACH KEY IS ON A LINE OF ITS OWN** because a `next-line` directive covers
   every mutant of its mutator on the line it names, and the key is the one
   string here that no test can be wrong about: `defineSetting` refuses an
   unnamespaced key, and it is called at module scope. The same reasoning
   `sync.clockFloor` records. */

/**
 * The voice per language. The value is a `voiceURI`, which is the only stable
 * identity a `SpeechSynthesisVoice` has — `name` collides (a Mac offers two
 * voices called Samantha, differing only in tier) and the object itself does
 * not survive a relaunch — or a downloaded voice written by `qualify`.
 */
export const VOICE_SETTING: Setting<Readonly<Record<string, string>>> = defineSetting(
  // Stryker disable next-line StringLiteral: `defineSetting` refuses an unnamespaced key, and it is called HERE, at module scope — so the empty-string mutant throws while this module is being imported, every covering suite fails to LOAD, no test fails, and Stryker's vitest runner reports it Survived with nothing able to kill it (measured 2026-09-14)
  'narration.readingVoice',
  {},
  voiceChoices,
)

/** The speaking rate, a multiplier — see `READING_RATE`. */
export const RATE_SETTING: Setting<number> = defineSetting(
  // Stryker disable next-line StringLiteral: `defineSetting` refuses an unnamespaced key, and it is called HERE, at module scope — so the empty-string mutant throws while this module is being imported, every covering suite fails to LOAD, no test fails, and Stryker's vitest runner reports it Survived with nothing able to kill it (measured 2026-09-14)
  'narration.readingRate',
  1,
  withinRange(READING_RATE_MIN, READING_RATE_MAX),
)

/** How loud, 0 to 100 — see `READING_VOLUME_MAX` and `dev-docs/decisions/2026-11-01-reading-volume.md`. */
export const VOLUME_SETTING: Setting<number> = defineSetting(
  // Stryker disable next-line StringLiteral: `defineSetting` refuses an unnamespaced key, and it is called HERE, at module scope — so the empty-string mutant throws while this module is being imported, every covering suite fails to LOAD, no test fails, and Stryker's vitest runner reports it Survived with nothing able to kill it (measured 2026-09-14)
  'narration.readingVolume',
  READING_VOLUME_MAX,
  withinRange(READING_VOLUME_MIN, READING_VOLUME_MAX),
)

/**
 * WHETHER A NOTE'S BODY IS READ. Off, which is the quieter of the two: most
 * note bodies are hidden and never reach the voice, and the ones that are not
 * are a print-style block at the foot of a section — so on by default means a
 * run of citations arriving mid-chapter, unannounced. See `NOTE_BODIES` in the
 * kernel's `speechSkip.ts` for why this is the reader's choice at all.
 */
export const NOTES_ALOUD_SETTING: Setting<boolean> = defineSetting(
  // Stryker disable next-line StringLiteral: `defineSetting` refuses an unnamespaced key, and it is called HERE, at module scope — so the empty-string mutant throws while this module is being imported, every covering suite fails to LOAD, no test fails, and Stryker's vitest runner reports it Survived with nothing able to kill it (measured 2026-09-14)
  'narration.readingNotesAloud',
  false,
  boolean,
)

/** Silence after a sentence, in ms — see `SENTENCE_GAP` for why it is not scaled by the rate. */
export const SENTENCE_GAP_SETTING: Setting<number> = defineSetting(
  // Stryker disable next-line StringLiteral: `defineSetting` refuses an unnamespaced key, and it is called HERE, at module scope — so the empty-string mutant throws while this module is being imported, every covering suite fails to LOAD, no test fails, and Stryker's vitest runner reports it Survived with nothing able to kill it (measured 2026-09-14)
  'narration.sentenceGapMs',
  SENTENCE_GAP.steps[SENTENCE_GAP.def]!,
  withinRange(SENTENCE_GAP_MIN, SENTENCE_GAP_MAX),
)

/**
 * Silence after a paragraph, in ms. Used ALONE at a paragraph end, not added
 * to the sentence gap: the label says "between paragraphs", so a reader who
 * sets it to zero means no pause there.
 */
export const PARAGRAPH_GAP_SETTING: Setting<number> = defineSetting(
  // Stryker disable next-line StringLiteral: `defineSetting` refuses an unnamespaced key, and it is called HERE, at module scope — so the empty-string mutant throws while this module is being imported, every covering suite fails to LOAD, no test fails, and Stryker's vitest runner reports it Survived with nothing able to kill it (measured 2026-09-14)
  'narration.paragraphGapMs',
  PARAGRAPH_GAP.steps[PARAGRAPH_GAP.def]!,
  withinRange(PARAGRAPH_GAP_MIN, PARAGRAPH_GAP_MAX),
)

/**
 * Store the voice for ONE language.
 *
 * MERGED INTO THE MAP, never replacing it, so choosing a Chinese voice leaves
 * the English one alone — and per language rather than as the whole map, so a
 * stale render cannot overwrite a choice made for another language. An empty
 * voice REMOVES the entry rather than storing `''`, which is how a reader goes
 * back to letting the app choose: `chosenVoice` treats an empty string as no
 * choice, but leaving one behind would mean the map grew a dead key per
 * language visited.
 */
export function chooseVoice(settings: SettingsStore, lang: string, voice: string): void {
  const { [lang]: had, ...rest } = settings.get(VOICE_SETTING)
  /* UNCHANGED IS NOT A WRITE. The store already skips a value equal to what it
     holds, but the spread below moves this language's key to the end, which
     serialises differently and would be written as a change. */
  if (had === (voice === '' ? undefined : voice)) return
  settings.set(VOICE_SETTING, voice === '' ? rest : { ...rest, [lang]: voice })
}

/**
 * The four numbers a control can send, CLAMPED before they are stored.
 *
 * CLAMPED HERE TOO, not only in the setting's parser. The parser guards what
 * arrives from disk; this guards what arrives from a control, and the two are
 * different doors into the same value — so what is on disk is always what the
 * reader is shown.
 *
 * ⚠️ **A NON-FINITE VALUE IS NOT CLAMPED, IT IS PASSED ON TO BE REFUSED.**
 * `Math.min(max, Infinity)` is the maximum, so clamping it would store an end
 * the reader never chose; 5.4's reducer refused every non-finite value for that
 * reason. Handed on unchanged, NaN and ±Infinity meet the setting's parser,
 * which reads none of them, and the store refuses what its parser cannot read
 * back, with a line in the log — so a broken control changes nothing and says
 * so.
 */
const fromControl = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? clamp(value, min, max) : value

export const setRate = (settings: SettingsStore, rate: number): void =>
  settings.set(RATE_SETTING, fromControl(rate, READING_RATE_MIN, READING_RATE_MAX))

export const setVolume = (settings: SettingsStore, volume: number): void =>
  settings.set(VOLUME_SETTING, fromControl(volume, READING_VOLUME_MIN, READING_VOLUME_MAX))

export const setSentenceGap = (settings: SettingsStore, ms: number): void =>
  settings.set(SENTENCE_GAP_SETTING, fromControl(ms, SENTENCE_GAP_MIN, SENTENCE_GAP_MAX))

export const setParagraphGap = (settings: SettingsStore, ms: number): void =>
  settings.set(PARAGRAPH_GAP_SETTING, fromControl(ms, PARAGRAPH_GAP_MIN, PARAGRAPH_GAP_MAX))

/** Read a note's body, or stop reading it. */
export const toggleNotesAloud = (settings: SettingsStore): void =>
  settings.set(NOTES_ALOUD_SETTING, !settings.get(NOTES_ALOUD_SETTING))

/**
 * The reader's choices, as the speaker takes them — every one of them answered,
 * since each setting has its default, so a reader of this never needs a second.
 */
export function prefsOf(settings: SettingsStore): Required<SpeakPrefs> {
  return {
    voices: settings.get(VOICE_SETTING),
    rate: settings.get(RATE_SETTING),
    volume: settings.get(VOLUME_SETTING) / READING_VOLUME_MAX,
    sentenceGapMs: settings.get(SENTENCE_GAP_SETTING),
    paragraphGapMs: settings.get(PARAGRAPH_GAP_SETTING),
    notesAloud: settings.get(NOTES_ALOUD_SETTING),
  }
}
