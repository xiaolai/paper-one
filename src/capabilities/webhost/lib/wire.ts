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
   *  reach the client.
   *
   *  `command` is the exact line that fixes it — or NULL, on a tailnet that
   *  cannot issue certificates at all. `tailscale serve` needs Tailscale's own
   *  certificate infrastructure; against a self-hosted control server it fails
   *  with an error about the reader's account, which they do not have. */
  | { readonly kind: 'not-served'; readonly host: string; readonly command: string | null }
  /** No tailnet, so no name a browser will trust. Carries NO url on purpose:
   *  a plain-HTTP address loads and then cannot hold a sign-in, which is a
   *  wrong answer to "where do I point my browser" rather than a lesser one. */
  | { readonly kind: 'no-https'; readonly port: number }
  /** The listener has not answered yet.
   *
   *  ⚠️ **ASK AGAIN.** This is the ONE address state that resolves itself, and
   *  it used to be reported as `unavailable` — which the pane draws as a
   *  permanent failure telling the reader to quit whatever is holding the port
   *  and restart Paper. The listener binds on a spawned task, so every launch
   *  passes through here, and a pane opened during that window said a working
   *  browser client was broken and never took it back. */
  | { readonly kind: 'binding' }
  /** The bind was REFUSED; there is nothing to reach and there will not be. */
  | { readonly kind: 'unavailable' }

/**
 * One live SOCKET, for the pump.
 *
 * ⚠️ NOT what the Browsers pane lists — see [`Browser`]. These ids address
 * `sessionRecv` and `send`, and they exist only while a tab is open.
 */
export interface BrowserSession {
  readonly id: number
}

/**
 * One browser holding a credential, connected or not.
 *
 * DISTINCT FROM `BrowserSession`, and the distinction is why this exists. The
 * pane used to list live sockets, so a browser that signed in and closed its
 * tab vanished from it — while its credential stayed good for ninety days, and
 * the reader had no way to cut it off before it came back. What a reader means
 * by "that phone" is the authorization, not the socket it happens to hold.
 */
export interface Browser {
  readonly id: number
  /** Whether it is connected right now. Shown, not enforced. */
  readonly connected: boolean
  /** The device, as described when it paired — "Safari on iPhone". What a
   *  reader tells their phone from their laptop by. */
  readonly label: string
  /** Epoch milliseconds: when the six digits were typed. */
  readonly createdMs: number
  /** Epoch milliseconds, to the minute: the last handshake or client boot. */
  readonly lastSeenMs: number
  /** Epoch milliseconds: when the credential stops being good on its own. */
  readonly expiresAtMs: number
}

/**
 * The one refusal a revocation can answer with that is NOT a failure to
 * revoke. `unsaved` means the browser IS cut off — the in-memory half never
 * fails — and `webhost/sessions.json` could not be written, so after a restart
 * it may be back. A pane that showed the bare code would read as "nothing
 * happened", which is the wrong half of the truth; the sentence carries both.
 */
function explained(thrown: unknown): never {
  if (thrown === 'unsaved') {
    throw new Error(
      'Signed out for now, but the change could not be saved — after Paper restarts this browser may be back. Check that Paper can write to its data folder.',
    )
  }
  throw thrown
}

export interface WebHostWire {
  status(): Promise<WebHostStatus>
  /** Tell the plugin the webview is serving the router, so frames may flow. */
  ready(): Promise<void>
  /** Every frame waiting from one browser. Never waits; empty means nothing. */
  sessionRecv(session: number): Promise<readonly Uint8Array[]>
  /**
   * One frame back to a browser. **Resolves when the frame is queued, which
   * may be a while**: the plugin waits for the browser to make room (up to
   * a minute) rather than refusing, so a pending promise here is backpressure
   * working, not a session going away.
   *
   * ⚠️ It used to reject with `backpressure` the instant a budget was full,
   * and the pump — which treats a rejected send as a dead session — closed
   * the router connection. Every book larger than the 8 MiB session budget
   * aborted mid-stream on the phone. A rejection now means the browser
   * drained nothing for the whole wait and its socket has been closed.
   */
  send(session: number, frame: Uint8Array): Promise<void>
  address(): Promise<WebHostAddress>
  beginCode(): Promise<CodeOffer>
  cancelCode(): Promise<void>
  /** The live sockets — the pump's list. */
  sessions(): Promise<readonly BrowserSession[]>
  /** Every browser holding a credential — the pane's list. */
  browsers(): Promise<readonly Browser[]>
  /** Cut one off, by its DURABLE id from `browsers` — not a socket id. */
  revoke(id: number): Promise<void>
  /**
   * Sign out every browser: forgets every credential, closes every socket,
   * retires the code on screen. Resolves to how many went.
   */
  revokeAll(): Promise<number>
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
    browsers: () => invoke<readonly Browser[]>('plugin:webhost|webhost_browsers'),
    revoke: (id) => invoke<void>('plugin:webhost|webhost_revoke', { id }).catch(explained),
    revokeAll: () => invoke<number>('plugin:webhost|webhost_revoke_all').catch(explained),
  }
}

/** An in-memory wire, for driving the pane with no plugin and no app. */
export function fakeWire(overrides: Partial<WebHostWire> = {}): WebHostWire {
  let live: BrowserSession[] = []
  let paired: Browser[] = []
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
    browsers: async () => paired,
    revoke: async (id) => {
      /* BOTH LISTS, because that is what the real one does: the credential is
         forgotten and every socket it holds is closed. A fake that dropped only
         the socket would let a test pass over the exact gap this pair exists to
         close. */
      paired = paired.filter((browser) => browser.id !== id)
      live = live.filter((session) => session.id !== id)
    },
    revokeAll: async () => {
      const count = paired.length
      paired = []
      live = []
      return count
    },
    ...overrides,
  }
}
