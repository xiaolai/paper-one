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

import type { VoicePack } from '../../core/ports'
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
  if (lang === null || lang.trim() === '') return []
  const primary = primaryOf(lang)
  return packs.filter((pack) => pack.languages.some((l) => primaryOf(l) === primary))
}

/**
 * Whether this Mac may be offered a pack at all.
 *
 * A machine under the pack's floor is not offered it, rather than allowed to
 * download 2.5 GB and then be killed by the system on the first sentence.
 */
export function withinMemory(pack: VoicePack, machineMemoryGb: number): boolean {
  if (!Number.isFinite(machineMemoryGb) || machineMemoryGb <= 0) return true
  return machineMemoryGb >= pack.minimumMemoryGb
}

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
  const usable = packsFor(packs, lang).filter((pack) => pack.installed)
  if (usable.length === 0) return null

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
  const mb = Math.round(pack.bytes / 1_048_576)
  const size = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
  return `Download the ${pack.name} voice (${size}) in Settings → Voices`
}
