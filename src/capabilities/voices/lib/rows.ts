/**
 * What the voices plugin answers with, and the pure part of reading it.
 *
 * ⚠️ **NOTHING HERE IMPORTS TAURI**, deliberately — `browser:check` is a
 * `pnpm verify` step and the defect it exists for has happened four times: a
 * pure value sharing a module with a platform binding takes the whole subtree
 * down with it. The binding is `wire.ts`, which is the only file in this
 * capability allowed to name `@tauri-apps` at all (`PLUGIN_WIRES` in
 * `.dependency-cruiser.cjs`, one file per plugin so the command names are
 * auditable in one place).
 */

import type { InstallProgress, SpokenAudio, VoicePack } from '../../../kernel'

/**
 * A download's progress, as the plugin emits it.
 *
 * ⚠️ **A UNION, BECAUSE THE COUNTS BELONG TO ONE KIND AND NOT THE OTHERS.** It
 * was one shape with `received?` and `total?`, which made `asProgress` carry a
 * `?? 0` for a case `progressOf` had already made impossible — an unreachable
 * default, which is the shape this repository records as an unkillable mutant.
 * Making it unrepresentable is the fix; a fallback for it was never one.
 */
export type ProgressEvent =
  | {
      readonly pack: string
      readonly kind: 'downloading'
      readonly received: number
      readonly total: number
    }
  | { readonly pack: string; readonly kind: 'verifying' | 'installed' }

/**
 * A count of bytes: whole, and not negative.
 *
 * ⚠️ **`Number.isFinite` ALONE LET `-1` AND `1.5` THROUGH**, and this file
 * exists to refuse what crosses from Rust rather than render it: a negative
 * size reaches the reader as *"unknown size"* on a row that is still offered
 * for download, and a fractional byte count is not a count of bytes.
 */
function counted(value: unknown): value is number {
  /* ⚠️ **A `typeof value === 'number'` IN FRONT OF THIS DECIDED NOTHING**, and
     it was here. `Number.isInteger` answers false for every value that is not a
     number, so that clause could never be the one that refused — an unkillable
     mutant, which this repository removes rather than disables. The cast is
     what `tsc` needs for the comparison below, and it is sound precisely
     because `Number.isInteger` has already answered. */
  return Number.isInteger(value) && (value as number) >= 0
}

/**
 * Read a progress event, refusing one that is not the shape it claims.
 *
 * An event arrives from outside TypeScript's reach, so it is CHECKED rather
 * than cast: a `received` that is absent where the kind says downloading would
 * otherwise render as `NaN MB of NaN MB` on the reader's screen.
 */
export function progressOf(raw: unknown): ProgressEvent | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  if (typeof row.pack !== 'string' || row.pack === '') return null
  const kind = row.kind
  if (kind === 'verifying' || kind === 'installed') return { pack: row.pack, kind }
  if (kind !== 'downloading') return null
  if (!counted(row.received) || !counted(row.total)) return null
  return { pack: row.pack, kind, received: row.received, total: row.total }
}

/** Turn a progress event into what the kernel's port promises. */
export function asProgress(event: ProgressEvent): InstallProgress {
  if (event.kind === 'downloading') {
    return { kind: 'downloading', received: event.received, total: event.total }
  }
  return { kind: event.kind }
}

/**
 * Read a pack row, refusing one that is not what it claims.
 *
 * The same reason as `progressOf`: this crosses from Rust, and a pack with no
 * `bytes` would be offered to a reader as a download of `undefined`.
 */
export function packOf(raw: unknown): VoicePack | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  const strings = ['id', 'name', 'summary', 'family'] as const
  for (const key of strings) {
    if (typeof row[key] !== 'string' || row[key] === '') return null
  }
  if (!counted(row.bytes)) return null
  /* The same shape as `counted` above, for the same reason: `Number.isFinite`
     is false for every value that is not a number, so a narrowing test in
     front of it refuses nothing it would not refuse anyway. A floor of zero is
     a real floor — a pack that asks for no memory at all. */
  if (!Number.isFinite(row.minimumMemoryGb) || (row.minimumMemoryGb as number) < 0) return null
  if (typeof row.installed !== 'boolean') return null
  if (!Array.isArray(row.languages) || !row.languages.every((l) => typeof l === 'string')) return null
  if (!Array.isArray(row.voices)) return null
  const voices = row.voices.map((v) => {
    if (typeof v !== 'object' || v === null) return null
    const voice = v as Record<string, unknown>
    if (typeof voice.id !== 'string' || voice.id === '') return null
    if (typeof voice.name !== 'string') return null
    if (typeof voice.language !== 'string') return null
    /* ⚠️ **CHECKED, NOT COERCED.** It was `String(voice.note ?? '')`, which is
       the one field in this row that was converted rather than validated — and
       `String` THROWS on an object with a non-callable `toString`, which is
       valid JSON. That throw leaves `packOf`, leaves `catalogue`, and takes the
       whole pane to its error state over one row. */
    if (voice.note !== undefined && typeof voice.note !== 'string') return null
    return { id: voice.id, name: voice.name, language: voice.language, note: voice.note ?? '' }
  })
  if (voices.some((v) => v === null)) return null
  return {
    id: row.id as string,
    name: row.name as string,
    summary: row.summary as string,
    family: row.family as string,
    languages: row.languages as readonly string[],
    bytes: row.bytes,
    minimumMemoryGb: row.minimumMemoryGb as number,
    voices: voices as readonly { id: string; name: string; language: string; note: string }[],
    installed: row.installed,
  }
}

/**
 * Read a rendered passage, refusing one that is not what it claims.
 *
 * ⚠️ **THIS SIDE OF THE WIRE WAS THE ONE PLACE THAT DID NOT CHECK**, and the
 * reason is instructive: `Uint8Array.from` never fails. Handed `[256, -1, 1.5]`
 * it answers `[0, 255, 1]` — three wrong samples, silently, which is a click or
 * a burst of noise in the middle of a sentence with nothing anywhere saying a
 * byte was wrong. A sample rate of zero divides to `Infinity` in every duration
 * this feeds. Same rule as `packOf` and `progressOf`: what crosses from Rust is
 * CHECKED, because the alternative is not an error, it is a wrong reading.
 *
 * @throws when the row is not a rendered passage.
 */
export function spokenOf(row: unknown): SpokenAudio {
  if (typeof row !== 'object' || row === null) throw new Error('the render answered with no passage')
  const raw = row as Record<string, unknown>
  if (!Array.isArray(raw.pcm) || !raw.pcm.every((b) => counted(b) && b <= 255)) {
    throw new Error('the render answered with samples that are not bytes')
  }
  if (raw.pcm.length % 2 !== 0) {
    /* An odd byte count is not a whole number of 16-bit samples — the same
       refusal `narrate/wav.rs` makes of a malformed WAV, for the same reason. */
    throw new Error('the render answered with half a sample')
  }
  /* `counted` already refuses a rate that is not a whole, non-negative number,
     so the only rate left to refuse is zero — which divides to `Infinity` in
     every duration this feeds. Written as `<= 0` the lower bound would be a
     comparison nothing could ever make true. */
  if (!counted(raw.sampleRate) || raw.sampleRate === 0) {
    throw new Error('the render answered with no sample rate')
  }
  if (!Array.isArray(raw.words) || !raw.words.every(isTiming)) {
    throw new Error('the render answered with word timings that are not timings')
  }
  if (!Array.isArray(raw.skipped) || !raw.skipped.every(isSkip)) {
    throw new Error('the render answered with a skip list that is not one')
  }
  return {
    pcm: Uint8Array.from(raw.pcm),
    sampleRate: raw.sampleRate,
    words: raw.words as SpokenAudio['words'],
    skipped: raw.skipped as SpokenAudio['skipped'],
  }
}

function isTiming(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return counted(row.start) && counted(row.length) && counted(row.startMs) && counted(row.endMs)
}

function isSkip(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.text === 'string' && typeof row.why === 'string'
}
