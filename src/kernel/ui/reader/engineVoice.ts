/**
 * Which downloaded voice reads a book, and how a reader's choice is written
 * down.
 *
 * ⚠️ **NOTHING HERE CHANGES THE FLOOR, AND THAT IS THE WHOLE POINT.**
 * `voiceChoice.ts` refuses every platform voice below Enhanced wherever the
 * tier is legible, because on a Mac the platform's own pick is the most
 * compressed voice Apple ships. A downloaded pack is not subject to that rule
 * and does not need to be: its voices are in the catalogue because the owner
 * put them there, having listened. So this is a SEPARATE question asked FIRST
 * — is there a pack for this book's language — and `voiceFor` is unchanged
 * behind it.
 *
 * The reading therefore has three answers rather than two: a pack's voice, a
 * platform voice the floor admits, or nothing.
 */

import type { VoiceChoice, VoicePack } from '../../core/ports'
import { primaryOf } from './voiceChoice'

/** A voice inside an installed pack. */
export interface EngineVoice {
  readonly packId: string
  readonly voiceId: string
}

/**
 * How a chosen voice is stored, so two packs may ship a voice of one name.
 *
 * ⚠️ **ENGINE-QUALIFIED BECAUSE A BARE ID IS AMBIGUOUS.** `af_heart` says
 * nothing about which pack it belongs to, and a bare name would resolve to
 * whichever pack happened to be listed first — which changes when a reader
 * installs another. The prefix is the pack's FAMILY, not its id, because that
 * is what a voice belongs to: the same voice from a re-cut pack is the same
 * voice.
 */
export function qualify(family: string, voiceId: string): string {
  return `${family}:${voiceId}`
}

/**
 * Read a stored choice back, or `null` for one written some other way.
 *
 * ⚠️ **A STORED WEB SPEECH IDENTIFIER MUST STILL READ.** A reader who picked a
 * system voice before any of this existed has
 * `com.apple.voice.compact.en-US.Samantha` in their settings, and a Windows
 * one has `Microsoft David Desktop - English (United States)`. The dot, slash
 * and space guards below turn away both.
 *
 * ⚠️ **AND THEY DO NOT TURN AWAY EVERYTHING, WHICH IS WORTH STATING RATHER
 * THAN PRETENDING.** Firefox spells a `voiceURI` `urn:moz-tts:sapi:...`, which
 * splits here as the family `urn` — syntactically indistinguishable from ours,
 * because it IS the same syntax. What makes that harmless is downstream and
 * not here: [`engineVoiceFor`] only accepts a family that matches an INSTALLED
 * PACK, and no pack is called `urn`. So read this as a split that rejects the
 * two common shapes, not as a test of whose identifier it is.
 */
export function unqualify(stored: string): { family: string; voiceId: string } | null {
  const at = stored.indexOf(':')
  if (at <= 0 || at === stored.length - 1) return null
  const family = stored.slice(0, at)
  const voiceId = stored.slice(at + 1)
  if (family.includes('.') || family.includes('/') || family.includes(' ')) return null
  return { family, voiceId }
}

/** The packs that can read a language, installed or not. */
export function packsFor(packs: readonly VoicePack[], lang: string | null): readonly VoicePack[] {
  /* ⚠️ **NO EMPTY TEST IN FRONT OF THIS, AND IT HAD TWO.** `primaryOf` goes
     through `normalize`, which trims and folds case — so a language of nothing
     but spaces already answers a primary tag no pack declares, and the filter
     already answers none for it. The only thing that has to be caught here is
     `null`, which `normalize` would throw on. A guard for the rest was three
     branches repeating the answer the filter gives. */
  if (lang === null) return []
  const primary = primaryOf(lang)
  return packs.filter((pack) => pack.languages.some((l) => primaryOf(l) === primary))
}

/**
 * The packs that can read a language AND are here.
 *
 * ONE RULE, because two callers ask it: the reading, through [`engineVoiceFor`],
 * and the Voice picker, which must offer exactly the voices the reading would
 * accept. A picker with its own filter is a second copy of this rule, and the
 * first symptom of the two disagreeing is a list whose selected row is not the
 * voice being heard — the drift `voiceGroups` records for the platform's side.
 */
export function installedPacksFor(packs: readonly VoicePack[], lang: string | null): readonly VoicePack[] {
  return packsFor(packs, lang).filter((pack) => pack.installed)
}

/* ⚠️ **`withinMemory` WAS HERE AND IT WAS A SECOND COPY OF A RULE NOBODY RAN.**
 * It answered "may this machine be offered this pack" and had no caller at all
 * — while `manifest::offered` in the plugin answered the same question, with a
 * test, and was itself never called by `voices_catalogue`. So the floor was
 * written twice and applied nowhere, and every pack was offered to every
 * machine. The rule now lives in ONE place, the only place that can read the
 * machine's memory: the plugin filters the catalogue before it is sent, so
 * what arrives here is already what this device may have. Found by the
 * 2026-09-23 audit. */

/**
 * The downloaded voice that reads this book, or `null` for none.
 *
 * The reader's own choice first, then the first installed pack that speaks the
 * language. A stored choice that names a pack which is not installed — removed
 * since, or never here — FALLS THROUGH rather than refusing: it is the same
 * rule `chosenVoice` follows for a platform voice that has gone, and the
 * alternative is a book that stops being readable because of a preference.
 */
export function engineVoiceFor(
  packs: readonly VoicePack[],
  lang: string | null,
  chosen: Readonly<Record<string, string>> = {},
): EngineVoice | null {
  const usable = installedPacksFor(packs, lang)
  /* No `if (usable.length === 0) return null` in front of this: with no usable
     pack neither loop below runs and the answer is already `null`, so the
     guard could only ever repeat it — and it hid the case where `lang` is
     null, which is the one that has to reach the line below. */
  const stored = lang === null ? undefined : chosen[primaryOf(lang)]
  const named = stored === undefined ? null : unqualify(stored)
  if (named) {
    for (const pack of usable) {
      if (pack.family !== named.family) continue
      if (pack.voices.some((voice) => voice.id === named.voiceId)) {
        return { packId: pack.id, voiceId: named.voiceId }
      }
    }
  }

  /* The first pack, and its first voice. The catalogue's order is the owner's
   * — the packs are listed the way they should be offered — so "first" is a
   * decision that was already made rather than an accident of sorting. */
  for (const pack of usable) {
    const voice = pack.voices[0]
    if (voice) return { packId: pack.id, voiceId: voice.id }
  }
  return null
}

/**
 * The catalogue rows an [`EngineVoice`] names, or `null` when it names none.
 *
 * ⚠️ **A READER HAS TO BE TOLD THE VOICE'S NAME, AND AN `EngineVoice` IS TWO
 * IDS.** `engineVoiceFor` answers what the RENDER PORT needs — a pack id and a
 * voice id — which is the right shape to send and the wrong one to show. This
 * is the lookup back, kept beside it so the picker names the voice the reading
 * resolved rather than resolving a second time and possibly differently.
 */
export function packVoiceOf(
  packs: readonly VoicePack[],
  engine: EngineVoice,
): { readonly pack: VoicePack; readonly voice: VoiceChoice } | null {
  const pack = packs.find((candidate) => candidate.id === engine.packId)
  if (!pack) return null
  const voice = pack.voices.find((candidate) => candidate.id === engine.voiceId)
  return voice ? { pack, voice } : null
}

/**
 * What to tell a reader whose book has no voice, when a pack would give it
 * one.
 *
 * ⚠️ **TRUE IN A WAY PHASE 29's MESSAGE WOULD NOT HAVE BEEN.** Before this
 * there was nothing a reader could do: the good voices exist on the machine
 * and macOS withholds them from any caller Apple did not sign, so *"install a
 * system voice"* would have been advice that does not work. A pack is a thing
 * they can actually get, so the sentence names it and its size.
 */
export function missingPackNotice(packs: readonly VoicePack[], lang: string | null): string | null {
  const candidates = packsFor(packs, lang).filter((pack) => !pack.installed)
  const pack = candidates[0]
  if (!pack) return null
  return `Download the ${pack.name} voice (${packSize(pack.bytes)}) in Settings → Voices`
}

/**
 * Bytes in the unit a person reads them in.
 *
 * ⚠️ **ONE FORMATTER, BECAUSE TWO OF THEM HAD ALREADY DISAGREED.** This
 * sentence and the Voices pane both spell a pack's size, and they rounded in
 * different orders: at 1 023.6 MiB the notice said `1.0 GB` — it rounded to
 * whole megabytes FIRST, reaching exactly 1 024 — while the pane said
 * `1024 MB`. Nobody would have found that by reading either one.
 */
function inUnits(bytes: number): string {
  const mb = bytes / 1_048_576
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/**
 * A pack's SIZE, where a value that is not one is refused rather than drawn.
 *
 * ⚠️ **NOT `sizeOf`** — the kernel already exports one of those, from
 * `core/public/bounds.ts`, and it reads a Content-Length STRING into a number.
 * Two exports of that name is a compile error, and two FUNCTIONS of that name
 * answering different questions would have been worse than one.
 *
 * A row with no size would otherwise be offered as `NaN MB`, which is the
 * failure this exists for — a download of an unknown amount, described
 * confidently.
 */
export function packSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown size'
  return inUnits(bytes)
}

/**
 * How much has ARRIVED — where zero is a real answer and not a missing one.
 *
 * ⚠️ **`sizeOf` SAID "unknown size" FOR IT, AND A READER SAW THAT SENTENCE.**
 * Measured in the running app on 2026-09-23, pressing Download on the 2.3 GB
 * Chinese pack: the first line was *"Downloading · unknown size of 2.3 GB"*,
 * which reads as though the app has lost track of the download it has just
 * begun. `sizeOf` refuses zero deliberately — a catalogue row with no size
 * must not be offered as `NaN MB` — but a COUNT of bytes received starts at
 * zero every time, so it is the wrong function for this side of the sentence.
 */
export function packArrived(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size'
  return inUnits(bytes)
}
