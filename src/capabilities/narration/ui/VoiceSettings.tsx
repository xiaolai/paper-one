import { useSyncExternalStore } from 'react'
import { CAPABILITY_UI as ui, stepAt, stepIndexOf, type SettingsStore, type VoicePack } from '../../../kernel'
import { engineVoiceFor, installedPacksFor, packVoiceOf, qualify, unqualify } from '../lib/engineVoice'
import {
  chooseVoice,
  NOTES_ALOUD_SETTING,
  PARAGRAPH_GAP,
  PARAGRAPH_GAP_SETTING,
  RATE_SETTING,
  READING_RATE,
  READING_VOLUME_MAX,
  READING_VOLUME_MIN,
  SENTENCE_GAP,
  SENTENCE_GAP_SETTING,
  setParagraphGap,
  setRate,
  setSentenceGap,
  setVolume,
  toggleNotesAloud,
  VOICE_SETTING,
  VOLUME_SETTING,
} from '../lib/settings'
import { bestVoice, chosenVoice, voiceFor, voiceGroups, voiceKey, type ReadableTier, type VoiceFacts } from '../lib/voiceChoice'
import { useReading, whole, type ReadingStore } from './reading'
import { StepRow } from './StepRow'

export interface VoiceSettingsProps {
  readonly store: ReadingStore
  /** Narration's own settings, which this section reads and writes. */
  readonly settings: SettingsStore
}

/**
 * What the Voice picker answers from: the facts about the machine and the book
 * that the reading published, and the reader's stored choice.
 *
 * The language a voice has to answer for is the BOOK's, not the interface's
 * (`lib/voiceChoice.ts` argues it).
 */
export interface VoicePicking {
  /** The open book's declared language — `documentLang` of the section shown. */
  readonly lang: string | null
  /** Everything the engine offers, unfiltered; the picker narrows it. */
  readonly voices: readonly VoiceFacts[]
  /**
   * The catalogue, so the picker can offer a DOWNLOADED voice.
   *
   * ⚠️ **WITHOUT THIS THE ROW SAID "None" WHILE A PACK WAS READING THE
   * BOOK.** Measured in the running app on 2026-09-23 with the English
   * pack installed: `engineVoiceFor` had already resolved Heart and the
   * reading used it, while this picker — which knew only about the
   * platform's voices, every one of them below the floor on a Mac — told
   * the reader no high-quality voice was available. A settings row that
   * contradicts what is being heard is worse than no row.
   */
  readonly packs: readonly VoicePack[]
  readonly chosen: Readonly<Record<string, string>>
}

/**
 * Read aloud's voice, speed, volume, pauses and notes — narration's section of
 * Settings.
 *
 * ⚠️ **IN "THE APP", AND SO DRAWN WITH NO BOOK OPEN.** Until step 5.5 this was
 * the kernel's own Voice group, drawn only while a book was open. A
 * contributed section is drawn whatever is on screen, and every row but one is
 * the reader's whatever the book: so those rows are always here, and the one
 * that is not — the voice, which answers for a language — waits for a book to
 * name one. A picker offering every voice on the machine with nothing open
 * would be asking the reader to choose a voice for a language nothing has
 * named, and the choice would be filed under the books that name none.
 *
 * NOTHING UNTIL THE READING HAS PUBLISHED, for the reason `ListenControl`
 * gives: the voice list and the packs are the reading's, and a section that
 * drew a guess before them would offer choices with nothing behind them.
 */
export function VoiceSettings({ store, settings }: VoiceSettingsProps) {
  const reading = useReading(store, whole)
  /* SUBSCRIBED FOR THE RE-RENDER; THE VALUES ARE READ THROUGH THEIR SETTINGS
     below, so each arrives parsed and clamped rather than as stored. */
  useSyncExternalStore(settings.subscribe, settings.getSnapshot)
  if (reading === null) return null
  const picking: VoicePicking = {
    lang: reading.lang,
    voices: reading.voices,
    packs: reading.packs,
    chosen: settings.get(VOICE_SETTING),
  }
  const volume = settings.get(VOLUME_SETTING)
  const notesAloud = settings.get(NOTES_ALOUD_SETTING)
  return (
    <div className={ui.section}>
      {reading.hasBook ? (
        <SelectRow
          label="Voice"
          /* THE VOICE THE READING WILL USE, SAID EXPLICITLY RATHER THAN LEFT
             TO THE DOM. This was `chosen[voiceKey(lang)]`, and an audit said a
             stored choice the machine no longer has would make the control draw
             BLANK. Measured on 2026-09-21, it does not: a single `<select>` whose
             value matches no option selects its FIRST option, and the first is
             the Automatic lead — so the raw string and this rendered the same
             row in every case. Nor can a listed voice be one the reading
             refuses, because the options are `voiceOptions` and `chosenVoice`
             applies the same two tests.

             It is kept because the old binding was correct only by that
             coincidence: it relied on Automatic being first. `chosenVoice` is
             the speech path's own answer, so the picker now shows what the
             reader will hear however the options are ordered. */
          value={voicePickerValue(picking)}
          /* NAMES WHAT AUTOMATIC CURRENTLY MEANS, rather than saying
             "Automatic" and leaving the reader to guess. It is the same answer
             the reading will reach, because both ask the packs and then the
             floor, in that order — and where neither has anything it says so,
             which is the one case where the reader needs to be told to go and
             get a voice. */
          lead={{ value: '', label: voicePickerLead(picking) }}
          groups={voicePickerGroups(picking)}
          onChange={(voice) => chooseVoice(settings, voiceKey(picking.lang), voice)}
        />
      ) : (
        <p className={ui.hint}>The voice is chosen for each book’s language. Open a book to choose its voice.</p>
      )}
      <StepRow
        label="Speed"
        scale={READING_RATE}
        value={stepIndexOf(READING_RATE, settings.get(RATE_SETTING))}
        onChange={(idx) => setRate(settings, stepAt(READING_RATE, idx))}
      />
      {/* ⚠️ **A SLIDER, WHERE EVERY ROW AROUND IT STEPS.** `StepRow`'s argument is
          that a value between two steps is not a decision anybody made, which is
          true of a pause and not of how loud: this is set by ear, against a
          voice that is already speaking. The 5s are only so that the keyboard
          moves it by something audible. */}
      <div className={ui.row}>
        <span className={ui.grow}>Volume</span>
        <input
          type="range"
          className={ui.volume}
          min={READING_VOLUME_MIN}
          max={READING_VOLUME_MAX}
          step={5}
          value={volume}
          aria-label="Reading volume"
          aria-valuetext={`${volume}%`}
          onChange={(event) => setVolume(settings, Number(event.target.value))}
        />
        <span className={ui.value}>{volume}%</span>
      </div>
      {/* ⚠️ **THE PAUSES ARE ADDITIVE TO WHATEVER THE ENGINE ALREADY LEAVES**,
          and how much that is has not been measured — see `SENTENCE_GAP`. So
          the labels say what the reader is adding, not what they will hear in
          total, which is the only claim that is true. */}
      <StepRow
        label="Pause between sentences"
        scale={SENTENCE_GAP}
        value={stepIndexOf(SENTENCE_GAP, settings.get(SENTENCE_GAP_SETTING))}
        onChange={(idx) => setSentenceGap(settings, stepAt(SENTENCE_GAP, idx))}
      />
      <StepRow
        label="Pause between paragraphs"
        scale={PARAGRAPH_GAP}
        value={stepIndexOf(PARAGRAPH_GAP, settings.get(PARAGRAPH_GAP_SETTING))}
        onChange={(idx) => setParagraphGap(settings, stepAt(PARAGRAPH_GAP, idx))}
      />
      {/* ⚠️ **OFF IS THE QUIETER DEFAULT, AND IT IS A CHOICE RATHER THAN A
          POLICY.** EPUB calls a note body SKIPPABLE — content a reading system
          offers to leave out — and this app used to drop it with no way to ask
          for it. Most are hidden and never reach the voice; the ones that are
          not are a print-style block at the foot of a section, so ON means a
          run of citations arriving mid-chapter. The label names what is added,
          like the pauses above.

          A SWITCH, as the kernel's on-or-off rows are (#140): a button, so
          Enter turns it as well as Space; the state is `aria-checked`, and the
          name is the label alone, so it does not change under the reader's
          finger. */}
      <div className={ui.row}>
        <span className={ui.grow}>Read footnotes</span>
        <button
          type="button"
          role="switch"
          aria-checked={notesAloud}
          aria-label="Read footnotes"
          className={ui.button}
          onClick={() => toggleNotesAloud(settings)}
        >
          {notesAloud ? 'On' : 'Off'}
        </button>
      </div>
    </div>
  )
}

/**
 * What the tiers are called. `Other` is a machine whose identifiers say nothing
 * about quality — Windows, Linux, a browser on either — where the floor cannot
 * be applied and every voice is offered.
 */
const TIER_LABELS: Readonly<Record<ReadableTier, string>> = {
  premium: 'Premium',
  enhanced: 'Enhanced',
  unknown: 'Other',
}

/** One `<optgroup>` in a [`SelectRow`], with the rows inside it. */
interface SelectGroup {
  readonly label: string
  readonly options: readonly { readonly value: string; readonly label: string }[]
}

/**
 * The groups the Voice picker offers: the downloaded packs first, then the
 * platform's own tiers.
 *
 * ⚠️ **THE PACKS COME FIRST BECAUSE THE READING ASKS THEM FIRST.**
 * `engineVoiceFor` runs in front of `voiceFor` — a pack is not subject to the
 * floor, since its voices are in the catalogue because the owner listened to
 * them — so a list that put the platform's voices above them would name a
 * second-choice voice in its first row. The same drift `voiceGroups` records
 * for the tiers, one level up.
 *
 * A PACK IS ITS OWN GROUP, labelled with the pack's name, because that is what
 * a reader is choosing between: Heart and Bella are the English pack's, and
 * saying so is how the row explains where the voice came from.
 */
function voicePickerGroups(picking: VoicePicking): readonly SelectGroup[] {
  const packs = installedPacksFor(picking.packs, picking.lang).map((pack) => ({
    label: pack.name,
    options: pack.voices.map((voice) => ({ value: qualify(pack.family, voice.id), label: voice.name })),
  }))
  const platform = voiceGroups(picking.voices, picking.lang).map((group) => ({
    label: TIER_LABELS[group.tier],
    options: group.voices.map((voice) => ({ value: voice.voiceURI, label: voice.name })),
  }))
  return [...packs, ...platform]
}

/**
 * The value the Voice row shows — the reader's OWN choice, or `''` for the
 * Automatic row.
 *
 * A stored engine choice is read back through the same two steps the reading
 * takes, so a preference naming a pack that has since been removed falls
 * through to Automatic here exactly as it does there, rather than selecting an
 * option the list no longer carries.
 *
 * ⚠️ **EXPORTED BECAUSE THE DOM CANNOT TELL ITS ANSWERS APART.** A
 * `<select>` handed a value no `<option>` carries reports the EMPTY STRING and
 * shows its first row — measured, not assumed — which is exactly what the
 * fall-through produces. So three of the four decisions below render
 * identically, and a case driving the section can only ever see one of them.
 * The function is pure; it is asserted directly.
 */
export function voicePickerValue(picking: VoicePicking): string {
  /* ABSENT AND `''` ALIKE, which is the rule `chosenVoice` states for its own
     side: `''` is what the Automatic row stores, and `unqualify` refuses it.
     Asked as "is there one", rather than with a `?? ''` in front of it: the
     two are the same answer here, so substituting one for the other was a
     value no test could tell from any other. */
  const stored = picking.chosen[voiceKey(picking.lang)]
  if (stored !== undefined) {
    const named = unqualify(stored)
    if (named) {
      const pack = installedPacksFor(picking.packs, picking.lang).find(
        (candidate) => candidate.family === named.family,
      )
      if (pack?.voices.some((voice) => voice.id === named.voiceId)) return stored
    }
  }
  /* Stryker disable next-line StringLiteral: a `<select>` handed a value
     no `<option>` carries reports the empty string anyway, so the
     fallback and any other absent value render alike. */
  return chosenVoice(picking.voices, picking.lang, picking.chosen)?.voiceURI ?? ''
}

/**
 * What Automatic currently means, named rather than left to the reader to
 * guess.
 *
 * ⚠️ **IT ASKS THE PACKS FIRST, AND THAT IS THE DEFECT THIS EXISTS FOR.**
 * Measured in the running app on 2026-09-23: with the English pack installed
 * this row said *"None — no high-quality voice is available here"* while the
 * reading was being read by Heart. The floor refuses every voice a Mac's
 * WebView offers, so asking only `voiceFor` answers `none` on a Mac forever,
 * however many packs are downloaded.
 */
function voicePickerLead(picking: VoicePicking): string {
  /* ⚠️ **ASKED WITH NO STORED CHOICE, BECAUSE THAT IS WHAT THIS ROW OFFERS.**
     `engineVoiceFor` honours a stored voice, so passing `picking.chosen` made
     the label say "Automatic (Bella)" to a reader who had explicitly CHOSEN
     Bella — naming the choice back as though it were the automatic pick, and
     promising the wrong voice to anybody who then selected this row. Selecting
     it stores `''`, which is the empty record this asks with. `bestVoice`, one
     branch below, has always been asked this way. */
  const engine = engineVoiceFor(picking.packs, picking.lang, {})
  const detail = engine ? packVoiceOf(picking.packs, engine) : null
  if (detail) return `Automatic (${detail.voice.name})`
  if (voiceFor(picking.voices, picking.lang, picking.chosen).kind === 'none') {
    return 'None — no high-quality voice is available here'
  }
  const best = bestVoice(picking.voices, picking.lang)
  return best ? `Automatic (${best.name})` : 'Automatic (system default)'
}

/**
 * A row whose setting is one of MANY, chosen from a list.
 *
 * ⚠️ **A NATIVE `<select>`, AND THE REASON IS THE LIST.** A voice list is
 * proper nouns; there is nothing to render, so the kernel's typeface menu —
 * which has to draw each face IN the face — has nothing to offer it. What is
 * left is a long, machine-dependent list that wants grouping, keyboard walking
 * and type-ahead, all of which the platform control has and a hand-built menu
 * would have to grow.
 */
function SelectRow({
  label,
  value,
  lead,
  groups,
  onChange,
}: {
  readonly label: string
  readonly value: string
  /**
   * One option ABOVE the groups, for the choice that is not one of them.
   *
   * Ungrouped on purpose: "let the app decide" is not a member of any tier, and
   * an `<optgroup>` holding one row states a category that does not exist.
   */
  readonly lead: { readonly value: string; readonly label: string }
  /** Rendered as `<optgroup>`s in order; a group with no rows is dropped. */
  readonly groups: readonly SelectGroup[]
  readonly onChange: (value: string) => void
}) {
  return (
    <div className={ui.row}>
      <span className={ui.grow}>{label}</span>
      <select
        className={ui.select}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <option value={lead.value}>{lead.label}</option>
        {groups.map((group, at) =>
          /* ⚠️ **A PACK CAN BE EMPTY, SO THIS IS REACHABLE.** `VoicePack.voices`
             is data from a manifest, and a pack with none would draw a heading
             with nothing under it. */
          group.options.length === 0 ? null : (
            /* KEYED BY POSITION AS WELL AS LABEL. `voiceGroups` deliberately
               emits non-contiguous groups from one tier — the same label twice —
               so a label alone gave two siblings one key, and React reconciled
               the second into the first whenever the installed voices changed. */
            /* Stryker disable next-line StringLiteral: a React key is not in
               the DOM, so no rendered output can tell one spelling from
               another — what it prevents is a reconciliation, and the comment
               above records the case. */
            <optgroup key={`${group.label}-${at}`} label={group.label}>
              {group.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ),
        )}
      </select>
    </div>
  )
}
