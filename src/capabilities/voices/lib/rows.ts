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
 * A rendered section as the plugin describes it: where the samples are, not the
 * samples.
 */
export interface ClipRow {
  /** The clip's own name, which is what `voices_clip_read` takes. */
  readonly stem: string
  /** Absolute — what the audiobook packer takes. */
  readonly path: string
  readonly bytes: number
  readonly sampleRate: number
  readonly durationMs: number
  readonly words: SpokenAudio['words']
  readonly skipped: SpokenAudio['skipped']
  readonly evicted: ClipsForgotten
}

/**
 * Read a rendered section's description, refusing one that is not what it
 * claims.
 *
 * ⚠️ **WHAT CROSSES FROM RUST IS CHECKED, BECAUSE THE ALTERNATIVE IS NOT AN
 * ERROR — IT IS A WRONG READING.** That lesson was learned on the samples
 * themselves: `Uint8Array.from` never fails, so handed `[256, -1, 1.5]` it
 * answered `[0, 255, 1]` — three wrong samples, silently, which is a click in
 * the middle of a sentence with nothing saying a byte was wrong. The samples do
 * not cross the IPC any more, and the same rule applies to the row that says
 * where they are: a `sampleRate` of zero divides to `Infinity` in every duration
 * this feeds, and a `relative` that is not a string is a path nothing can read.
 *
 * @throws when the row is not a rendered section.
 */
export function clipOf(row: unknown): ClipRow {
  if (typeof row !== 'object' || row === null) {
    throw new Error('the render answered with no section')
  }
  const raw = row as Record<string, unknown>
  if (typeof raw.stem !== 'string' || raw.stem === '') {
    throw new Error('the render answered with no name for the audio')
  }
  if (typeof raw.path !== 'string' || raw.path === '') {
    throw new Error('the render answered with no absolute path to the audio')
  }
  if (!counted(raw.bytes) || raw.bytes === 0) {
    throw new Error('the render answered with an empty file')
  }
  /* `counted` already refuses a rate that is not a whole, non-negative number,
     so the only rate left to refuse is zero — which divides to `Infinity` in
     every duration this feeds. Written as `<= 0` the lower bound would be a
     comparison nothing could ever make true. */
  if (!counted(raw.sampleRate) || raw.sampleRate === 0) {
    throw new Error('the render answered with no sample rate')
  }
  if (!counted(raw.durationMs)) {
    throw new Error('the render answered with no duration')
  }
  if (!Array.isArray(raw.words) || !raw.words.every(isTiming)) {
    throw new Error('the render answered with word timings that are not timings')
  }
  /* ⚠️ **ORDER IS A PRECONDITION OF THE SEEK, AND NOTHING CHECKED IT — FOUND BY
     AN INDEPENDENT AUDIT, 2026-09-30.** `firstWordFrom` and `wordAtOffset` are
     BINARY SEARCHES, on `startMs` and on `start` respectively, so an unordered
     list does not merely skip a word: it answers an arbitrary index, silently,
     for every seek in the section. A list whose numbers are each a number is not
     a list of timings — the same distinction as a store whose collection parses
     and is the wrong shape, which this repository refuses rather than accepts. */
  if (!inOrder(raw.words as SpokenAudio['words'])) {
    throw new Error('the render answered with word timings that are out of order')
  }
  if (!Array.isArray(raw.skipped) || !raw.skipped.every(isSkip)) {
    throw new Error('the render answered with a skip list that is not one')
  }
  return {
    stem: raw.stem,
    path: raw.path,
    bytes: raw.bytes,
    sampleRate: raw.sampleRate,
    durationMs: raw.durationMs,
    words: raw.words as SpokenAudio['words'],
    skipped: raw.skipped as SpokenAudio['skipped'],
    evicted: forgottenOf(raw.evicted),
  }
}

/** What the rendered reading holds, and what it may. */
export interface ClipUsage {
  readonly bytes: number
  readonly budget: number
  readonly clips: number
}

/**
 * Read the usage row.
 *
 * @throws when the row is not one.
 */
export function usageOf(row: unknown): ClipUsage {
  if (typeof row !== 'object' || row === null) {
    throw new Error('the rendered reading answered with no usage')
  }
  const raw = row as Record<string, unknown>
  if (!counted(raw.bytes) || !counted(raw.budget) || !counted(raw.clips)) {
    throw new Error('the rendered reading answered with a usage that is not counts')
  }
  return { bytes: raw.bytes, budget: raw.budget, clips: raw.clips }
}

/** How much rendered reading was removed, and how many sections that was. */
export interface ClipsForgotten {
  readonly clips: number
  readonly bytes: number
}

/**
 * Read what an eviction took away.
 *
 * ⚠️ **AN ABSENT ROW IS NOTHING FORGOTTEN, AND A MALFORMED ONE IS REFUSED.** The
 * two are different answers: a plugin that says nothing about eviction has
 * evicted nothing, and a plugin that answers a shape this cannot read is a
 * plugin whose numbers must not be shown to a reader as though they were counts.
 * This is `settings.ts`'s rule — absent is empty, present-and-wrong is refused —
 * on the smallest possible value.
 *
 * @throws when there is a row and it is not counts.
 */
export function forgottenOf(row: unknown): ClipsForgotten {
  if (row === undefined || row === null) return NOTHING_FORGOTTEN
  if (typeof row !== 'object') {
    throw new Error('the rendered reading answered with an eviction that is not counts')
  }
  const raw = row as Record<string, unknown>
  if (!counted(raw.clips) || !counted(raw.bytes)) {
    throw new Error('the rendered reading answered with an eviction that is not counts')
  }
  return { clips: raw.clips, bytes: raw.bytes }
}

/** A MODULE CONSTANT, so the identity is stable and nothing rebuilds on it. */
export const NOTHING_FORGOTTEN: ClipsForgotten = { clips: 0, bytes: 0 }

/**
 * A clip's samples, from the file the plugin wrote.
 *
 * ⚠️ **THE HEADER IS CHECKED AND NOT SKIPPED BY LENGTH.** `narrate/wav.rs`
 * records what a tolerant reader costs: `afconvert`'s own WAV puts an `FLLR`
 * padding chunk where `data` belongs, and a reader that took the first 44 bytes
 * on faith would hand the player 4 044 bytes of padding and call it a chapter —
 * a book of silence with no error anywhere. This reads only the shape
 * `tauri-plugin-voices`'s `wav::bytes` writes and refuses everything else by
 * name, which is the same posture on the same bytes.
 *
 * @throws when the bytes are not that shape, or say a different rate.
 */
export function pcmOfWav(bytes: Uint8Array, sampleRate: number): Uint8Array {
  if (bytes.length < WAV_HEADER) {
    throw new Error('the rendered reading is shorter than a WAV header')
  }
  const ascii = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE' || ascii(12) !== 'fmt ') {
    throw new Error('the rendered reading is not the WAV shape Paper writes')
  }
  if (ascii(36) !== 'data') {
    /* The `FLLR` case, named rather than tolerated. */
    throw new Error(
      `the rendered reading has ${ascii(36)} where its samples belong, not data`,
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  /* ⚠️ **THE `fmt ` CHUNK'S OWN SIZE IS READ, AND WAS NOT — FOUND BY AN
     INDEPENDENT AUDIT, 2026-09-30.** Every offset below is a constant that holds
     only for the canonical 16-byte chunk, and `data` was looked for at 36 without
     ever asking whether the chunk ended there. A file declaring 32 and carrying
     the bytes `data` at 36 passed every check, and the eight bytes returned as
     samples were its own format extension. Refusing anything but 16 is what makes
     the constants below assertions rather than assumptions. */
  if (view.getUint32(16, true) !== 16) {
    throw new Error(
      `the rendered reading states a ${view.getUint32(16, true)}-byte format chunk, not the 16 Paper writes`,
    )
  }
  /* ⚠️ **THE ENCODING IS CHECKED, AND IT WAS NOT — FOUND BY AN INDEPENDENT
     AUDIT, 2026-09-30.** The channel count and the bit depth were read and the
     FORMAT CODE at offset 20 was not, so a file declaring IEEE float (3), A-law
     (6) or the extensible tag (0xfffe) passed every test and its samples were
     then read as signed 16-bit PCM — audible as noise for a whole chapter, with
     nothing anywhere saying a byte was wrong. `narrate/wav.rs` checks all three,
     and this is the reader for the same bytes. */
  if (view.getUint16(20, true) !== 1) {
    throw new Error(
      `the rendered reading is encoded as ${view.getUint16(20, true)}, not as plain PCM`,
    )
  }
  if (view.getUint16(22, true) !== 1 || view.getUint16(34, true) !== 16) {
    throw new Error('the rendered reading is not mono 16-bit')
  }
  const stated = view.getUint32(24, true)
  if (stated !== sampleRate) {
    throw new Error(
      `the rendered reading says ${stated} Hz where the section says ${sampleRate} Hz`,
    )
  }
  const declared = view.getUint32(40, true)
  const present = bytes.length - WAV_HEADER
  if (declared !== present) {
    /* A short file reads as a short chapter, which is the failure `narrate`
       records as the worst available: complete-looking and wrong. */
    throw new Error(
      `the rendered reading says ${declared} bytes of audio and holds ${present}`,
    )
  }
  if (present % 2 !== 0) {
    throw new Error('the rendered reading ends on half a sample')
  }
  return bytes.subarray(WAV_HEADER)
}

/** `RIFF`, `fmt ` and `data`, canonical and in order — `wav.rs`'s own constant. */
const WAV_HEADER = 44

/**
 * Whether a list of timings is non-decreasing on BOTH axes the seek searches.
 *
 * Both, because they are searched separately: a seek by time bisects `startMs`
 * and a tap on a word bisects `start + length`. A list sorted on one and not the
 * other answers one direction correctly and the other arbitrarily, which is the
 * harder half to notice.
 */
function inOrder(words: SpokenAudio['words']): boolean {
  for (let i = 1; i < words.length; i += 1) {
    const before = words[i - 1]!
    const word = words[i]!
    if (word.startMs < before.startMs) return false
    if (word.start < before.start) return false
  }
  return true
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
