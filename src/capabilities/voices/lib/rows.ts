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

import type { InstallProgress, VoicePack } from '../../../kernel'

/** A pack as the plugin serialises it. */
export interface PackRow {
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly family: string
  readonly languages: readonly string[]
  readonly bytes: number
  readonly minimumMemoryGb: number
  readonly voices: readonly {
    readonly id: string
    readonly name: string
    readonly language: string
    readonly note: string
  }[]
  readonly installed: boolean
}

/** A download's progress, as the plugin emits it. */
export interface ProgressEvent {
  readonly pack: string
  readonly kind: 'downloading' | 'verifying' | 'installed'
  readonly received?: number
  readonly total?: number
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
  if (typeof row.received !== 'number' || typeof row.total !== 'number') return null
  if (!Number.isFinite(row.received) || !Number.isFinite(row.total)) return null
  return { pack: row.pack, kind, received: row.received, total: row.total }
}

/** Turn a progress event into what the kernel's port promises. */
export function asProgress(event: ProgressEvent): InstallProgress {
  if (event.kind === 'downloading') {
    return { kind: 'downloading', received: event.received ?? 0, total: event.total ?? 0 }
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
  if (typeof row.bytes !== 'number' || !Number.isFinite(row.bytes)) return null
  if (typeof row.minimumMemoryGb !== 'number' || !Number.isFinite(row.minimumMemoryGb)) return null
  if (typeof row.installed !== 'boolean') return null
  if (!Array.isArray(row.languages) || !row.languages.every((l) => typeof l === 'string')) return null
  if (!Array.isArray(row.voices)) return null
  const voices = row.voices.map((v) => {
    if (typeof v !== 'object' || v === null) return null
    const voice = v as Record<string, unknown>
    if (typeof voice.id !== 'string' || voice.id === '') return null
    if (typeof voice.name !== 'string') return null
    if (typeof voice.language !== 'string') return null
    return { id: voice.id, name: voice.name, language: voice.language, note: String(voice.note ?? '') }
  })
  if (voices.some((v) => v === null)) return null
  return {
    id: row.id as string,
    name: row.name as string,
    summary: row.summary as string,
    family: row.family as string,
    languages: row.languages as readonly string[],
    bytes: row.bytes,
    minimumMemoryGb: row.minimumMemoryGb,
    voices: voices as readonly { id: string; name: string; language: string; note: string }[],
    installed: row.installed,
  }
}

/**
 * How a voice is named where the reader's choice is stored.
 *
 * ENGINE-QUALIFIED, because two packs may ship a voice of the same name and a
 * bare id would silently resolve to whichever was listed first. A stored
 * WebView `voiceURI` has no colon in this shape and still reads, which is what
 * keeps an existing preference working.
 */
export function qualify(family: string, voiceId: string): string {
  return `${family}:${voiceId}`
}

/** Read an engine-qualified name back, or null for one of another shape. */
export function unqualify(stored: string): { family: string; voiceId: string } | null {
  const at = stored.indexOf(':')
  if (at <= 0 || at === stored.length - 1) return null
  const family = stored.slice(0, at)
  const voiceId = stored.slice(at + 1)
  // A WebView identifier is `com.apple.voice.compact.en-US.Samantha`, which has
  // no colon at all; anything with a dot before the first colon is a URI rather
  // than one of ours.
  if (family.includes('.') || family.includes('/')) return null
  return { family, voiceId }
}

/**
 * Whether this machine may be offered a pack.
 *
 * A Mac under the pack's floor is not offered it, rather than being allowed to
 * download 2.5 GB and then be killed by the system on the first sentence.
 */
export function offered(pack: VoicePack, machineMemoryGb: number): boolean {
  return machineMemoryGb >= pack.minimumMemoryGb
}

/** The packs that can read a book in this language. */
export function packsFor(packs: readonly VoicePack[], language: string): readonly VoicePack[] {
  const primary = language.toLowerCase().split('-')[0]
  return packs.filter((pack) => pack.languages.some((l) => l.toLowerCase().split('-')[0] === primary))
}
