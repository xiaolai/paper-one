import { invoke } from '@tauri-apps/api/core'

/**
 * The wire — the webhost capability's ONE window onto its Tauri plugin.
 *
 * THIS FILE IS THE ONLY MODULE IN THIS CAPABILITY ALLOWED TO IMPORT
 * `@tauri-apps/api` (`.dependency-cruiser.cjs`, `PLUGIN_WIRES`), for the reason
 * that list states: one file per plugin, so the set of `invoke` names is
 * auditable in one place and can be read against the crate's own `build.rs`.
 * Everything above this calls a function; nothing above it calls `invoke`.
 *
 * The names below must match `COMMANDS` in
 * `src-tauri/crates/tauri-plugin-webhost/build.rs`. That crate's `lists_agree`
 * test holds four Rust-side lists to each other; this is the fifth and it is
 * held by nothing automatic, so a mismatch surfaces as a refused command at
 * runtime. Adding one here means adding it there.
 */

/** What `webhost_status` returns. */
export interface WebHostStatus {
  readonly pluginVersion: string
  /** The loopback port the client is served on, or `null` if it never bound. */
  readonly port: number | null
  /** Whether the webview has told the plugin it is serving the router. */
  readonly ready: boolean
}

/** The six digits, and how long they last. */
export interface CodeOffer {
  /** ⚠️ SENSITIVE for its ninety seconds — anyone who reads this can pair a
   *  browser. Returned because the shelf has to draw it; never logged, and
   *  never put anywhere a diagnostic would collect it. */
  readonly code: string
  readonly expiresInMs: number
}

/** One browser holding a credential. */
export interface BrowserSession {
  readonly id: number
}

export interface WebHostWire {
  status(): Promise<WebHostStatus>
  beginCode(): Promise<CodeOffer>
  cancelCode(): Promise<void>
  sessions(): Promise<readonly BrowserSession[]>
  revoke(id: number): Promise<void>
}

export function tauriWire(): WebHostWire {
  return {
    status: () => invoke<WebHostStatus>('plugin:webhost|webhost_status'),
    beginCode: () => invoke<CodeOffer>('plugin:webhost|webhost_begin_code'),
    cancelCode: () => invoke<void>('plugin:webhost|webhost_cancel_code'),
    sessions: () => invoke<readonly BrowserSession[]>('plugin:webhost|webhost_sessions'),
    revoke: (id) => invoke<void>('plugin:webhost|webhost_revoke', { id }),
  }
}

/** An in-memory wire, for driving the pane with no plugin and no app. */
export function fakeWire(overrides: Partial<WebHostWire> = {}): WebHostWire {
  let live: BrowserSession[] = []
  let issued = 0
  return {
    status: async () => ({ pluginVersion: '0.0.0-fake', port: 27182, ready: true }),
    beginCode: async () => {
      issued += 1
      return { code: String(100000 + issued).slice(0, 6), expiresInMs: 90_000 }
    },
    cancelCode: async () => {},
    sessions: async () => live,
    revoke: async (id) => {
      live = live.filter((session) => session.id !== id)
    },
    ...overrides,
  }
}
