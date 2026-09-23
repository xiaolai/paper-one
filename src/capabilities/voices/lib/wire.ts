/**
 * The voices plugin's wire: every command this capability may call, in one
 * file.
 *
 * ⚠️ **THE ONLY FILE IN THIS CAPABILITY THAT MAY NAME `@tauri-apps`**, which is
 * a boundary rule rather than a convention — `PLUGIN_WIRES` in
 * `.dependency-cruiser.cjs`, alongside `peer/lib/wire.ts` and
 * `webhost/lib/wire.ts`. One file per plugin, so the set of command names a
 * capability can reach is auditable by reading one screen.
 *
 * Everything decidable is in `rows.ts`, and the port built on this is
 * `port.ts`. That split is what `pnpm browser:check` exists for: a pure value
 * sharing a module with a platform binding takes the whole subtree out of a
 * browser build, and that has happened four times in this tree.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** What `voices_render` answers with, before it is read. */
export interface SpokenRow {
  readonly pcm: number[]
  readonly sampleRate: number
  readonly words: readonly { start: number; length: number; startMs: number; endMs: number }[]
  readonly skipped: readonly { text: string; why: string }[]
}

/** Every command, and nothing else. */
export interface VoicesWire {
  catalogue(): Promise<unknown[]>
  install(pack: string): Promise<void>
  stop(pack: string): Promise<void>
  remove(pack: string): Promise<void>
  render(pack: string, voice: string, text: string, rate: number | null): Promise<SpokenRow>
  release(): Promise<void>
  onProgress(handler: (payload: unknown) => void): Promise<UnlistenFn>
}

/** The wire over the running plugin. */
export function voicesWire(): VoicesWire {
  return {
    catalogue: () => invoke<unknown[]>('plugin:voices|voices_catalogue'),
    install: (pack) => invoke('plugin:voices|voices_install', { pack }),
    stop: (pack) => invoke('plugin:voices|voices_stop', { pack }),
    remove: (pack) => invoke('plugin:voices|voices_remove', { pack }),
    render: (pack, voice, text, rate) =>
      invoke<SpokenRow>('plugin:voices|voices_render', { pack, voice, text, rate }),
    release: () => invoke('plugin:voices|voices_release'),
    onProgress: (handler) =>
      listen<unknown>('voices://progress', (event) => handler(event.payload)),
  }
}
