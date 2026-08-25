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

/**
 * Where a phone should point its browser, and whether it can get there.
 *
 * FOUR STATES, not a string, because the difference between them is what a
 * reader has to act on. The session cookie is `Secure`, so a plain-HTTP address
 * is not a worse answer than an HTTPS one — it is a broken one: the browser
 * takes the six digits, refuses to store the credential, and returns to the
 * code screen saying nothing. A single `url` field would make that failure
 * indistinguishable from success until it happened.
 */
export type WebHostAddress =
  /** Reachable from anywhere on the tailnet, over TLS. The working case. */
  | { readonly kind: 'https'; readonly url: string }
  /** A tailnet exists and nothing proxies to this port, so a phone cannot
   *  reach the client. `command` is the exact line that fixes it. */
  | { readonly kind: 'not-served'; readonly host: string; readonly command: string }
  /** No tailnet, so no name a browser will trust. Carries NO url on purpose:
   *  a plain-HTTP address loads and then cannot hold a sign-in, which is a
   *  wrong answer to "where do I point my browser" rather than a lesser one. */
  | { readonly kind: 'no-https'; readonly port: number }
  /** The server never bound; there is nothing to reach. */
  | { readonly kind: 'unavailable' }

/** One browser holding a credential. */
export interface BrowserSession {
  readonly id: number
}

export interface WebHostWire {
  status(): Promise<WebHostStatus>
  /** Tell the plugin the webview is serving the router, so frames may flow. */
  ready(): Promise<void>
  /** Every frame waiting from one browser. Never waits; empty means nothing. */
  sessionRecv(session: number): Promise<readonly Uint8Array[]>
  /** One frame back to a browser. */
  send(session: number, frame: Uint8Array): Promise<void>
  address(): Promise<WebHostAddress>
  beginCode(): Promise<CodeOffer>
  cancelCode(): Promise<void>
  sessions(): Promise<readonly BrowserSession[]>
  revoke(id: number): Promise<void>
}

export function tauriWire(): WebHostWire {
  return {
    status: () => invoke<WebHostStatus>('plugin:webhost|webhost_status'),
    ready: () => invoke<void>('plugin:webhost|webhost_ready'),
    sessionRecv: async (session) => {
      /* Tauri gives these back as number arrays over the IPC boundary; the
       * envelope wants bytes, and `decodeFrame` on a plain array is a length
       * check that passes and a header read that does not. */
      const frames = await invoke<number[][]>('plugin:webhost|webhost_session_recv', { session })
      return frames.map((frame) => Uint8Array.from(frame))
    },
    send: (session, frame) =>
      invoke<void>('plugin:webhost|webhost_send', { session, frame: Array.from(frame) }),
    address: () => invoke<WebHostAddress>('plugin:webhost|webhost_address'),
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
    ready: async () => {},
    sessionRecv: async () => [],
    send: async () => {},
    address: async () => ({ kind: 'https', url: 'https://studio.tail1234.ts.net/' }),
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
