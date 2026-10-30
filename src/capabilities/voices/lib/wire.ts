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
 *
 * ⚠️ **`voices_render` IS GONE FROM HERE, AND IT WAS A MEASUREMENT THAT REMOVED
 * IT.** It answered the samples as a byte array across the IPC. WI-34.0 measured
 * one real section of one real book at **139 924 800 bytes** of audio — which is
 * exactly the objection `voices_render_file` was written for, one level up. A
 * section is a CLIP now: the plugin writes a file under the app's own data
 * directory and answers its name, and [`VoicesWire.readClip`] reads the samples
 * back through a command of the plugin's own.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** What names one rendered section on the wire. */
export interface ClipQuery {
  readonly book: string
  /** Absent where the reader's place cannot say — see `ClipKey.section`. */
  readonly section: number | null
  readonly pack: string
  readonly voice: string
  readonly rate: number | null
  readonly textDigest: string
  readonly spokenDigest: string
}

/** Every command, and nothing else. */
export interface VoicesWire {
  catalogue(): Promise<unknown[]>
  install(pack: string): Promise<void>
  stop(pack: string): Promise<void>
  remove(pack: string): Promise<void>
  /** The rendered section already on disk, or `null` the first time. */
  clipFind(query: ClipQuery): Promise<unknown>
  /** Render a section and keep it. Minutes, on a blocking thread. */
  clipRender(query: ClipQuery, text: string): Promise<unknown>
  /**
   * Hold clips open while something reads them, or let them go.
   *
   * The audiobook export takes this over every clip it hands the packer — see
   * `SpeechEnginePort.holdClips`, which records what a clip evicted under a
   * running muxer costs.
   */
  clipHold(stems: readonly string[], hold: boolean): Promise<unknown>
  clipUsage(): Promise<unknown>
  clipForget(book: string | null): Promise<unknown>
  /**
   * A clip's samples, by the name the plugin answered.
   *
   * ⚠️ **THE PLUGIN'S OWN COMMAND AND NOT `@tauri-apps/plugin-fs`.**
   * `no-direct-fs-plugin-outside-storage` says a capability never reaches the fs
   * plugin, and the reason survives here rather than needing an exemption: the fs
   * scope grants the whole of `$APPDATA`, where this grants **one clip the store
   * already holds a row for**. Narrower, and auditable as a voices command.
   *
   * It answers an `ArrayBuffer` because the Rust side answers
   * `tauri::ipc::Response` — a `Vec<u8>` would cross as a JSON array of decimal
   * numbers, which for a real section is 140 MB of samples written out as text.
   */
  readClip(stem: string): Promise<Uint8Array>
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
    /* ⚠️ **ONE `ask` OBJECT AND NOT SEVEN FLAT ARGUMENTS.** A `#[tauri::command]`
       reads its arguments by name out of one JSON object either way; spelling the
       key flat made two commands take eight and nine parameters, which clippy
       refuses and is right to — the shape is a VALUE on both sides. */
    clipFind: (ask) => invoke<unknown>('plugin:voices|voices_clip_find', { ask }),
    clipRender: (ask, text) => invoke<unknown>('plugin:voices|voices_clip_render', { ask, text }),
    clipHold: (stems, hold) => invoke<unknown>('plugin:voices|voices_clip_hold', { stems, hold }),
    clipUsage: () => invoke<unknown>('plugin:voices|voices_clip_usage'),
    clipForget: (book) => invoke<unknown>('plugin:voices|voices_clip_forget', { book }),
    readClip: async (stem) =>
      new Uint8Array(await invoke<ArrayBuffer>('plugin:voices|voices_clip_read', { stem })),
    release: () => invoke('plugin:voices|voices_release'),
    onProgress: (handler) =>
      listen<unknown>('voices://progress', (event) => handler(event.payload)),
  }
}
