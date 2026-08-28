import { messageOf } from './messageOf'
import { Channel, invoke } from '@tauri-apps/api/core'

/**
 * The typed surface over `tauri-plugin-inference` — every command this
 * capability may reach, and nothing else.
 *
 * ONE PLACE THAT NAMES A COMMAND. Everything above this file calls a
 * function; nothing above it calls `invoke`. That is what makes the plugin's
 * command list auditable from the TypeScript side too: the set of names in
 * this file should equal `COMMANDS` in the crate's `build.rs`, and a command
 * that appears in one and not the other is a mistake somebody can see.
 *
 * NOTE WHAT IS ABSENT. There is no `setBaseUrl`, no `request(url)`, no
 * `readKey`. Untrusted book HTML renders in this webview and the daemon
 * behind these commands installs and executes backend binaries — so the
 * closed surface is the boundary, not a convenience.
 *
 * Every call returns a rejected promise carrying `{ kind, message }` from the
 * Rust side (`error.rs`), so a caller branches on `kind` and never parses
 * `message`. `errorKind` below is the one place that reads the shape.
 */

/* ─────────────────────────────── the shapes ─────────────────────────────── */

export type RuntimeStatus =
  | { readonly state: 'absent'; readonly reason: string }
  | { readonly state: 'stopped' }
  | { readonly state: 'ready'; readonly version: string; readonly port: number }

export type Modality = 'text' | 'speech'

/**
 * How much the reader is willing to spend on one answer.
 *
 * A CLOSED SET matching the crate's `Depth`, and closed for the same reason:
 * both CLIs take a model id or a reasoning effort as a free string, and this
 * file's contract is that nothing above it names one. `'default'` sends no
 * flag at all — the reader's own account default, which is what they are
 * already paying for.
 */
export const DEPTHS = ['default', 'faster', 'thorough'] as const
export type Depth = (typeof DEPTHS)[number]

export interface ModelRow {
  readonly id: string
  readonly label: string
  readonly modality: Modality
  readonly license: string
  readonly bytes: number
  readonly installed: boolean
  readonly parameters?: string
  readonly quantization?: string
}

export type InstallProgress =
  | { readonly kind: 'downloading'; readonly received: number; readonly total: number }
  | { readonly kind: 'verifying' }
  | { readonly kind: 'installed' }

export type RouteKind = 'local' | 'agent' | 'endpoint'

/**
 * Why a route cannot answer, as a code rather than a sentence.
 *
 * ⚠️ **THE SENTENCE USED TO BE THE STATE.** `rowFor` decided which button to
 * draw by comparing `unusable` against the exact English strings
 * `'Not installed'` and `'Signed out'` — so rephrasing a reason in `probe.rs`,
 * or translating one, silently turned an `[Install]` button into a dead row
 * with nothing anywhere to catch it. Two different situations even shared a
 * sentence: a local model Paper can download and an agent CLI the reader has
 * to install both read "Not installed", and the local rows borrowed an
 * agent-facing constant because of it.
 *
 * `probe.rs` emits both halves from one place, so they cannot disagree.
 */
export const UNUSABLE_REASONS = [
  'notInstalled',
  'runtimeMissing',
  'agentMissing',
  'signedOut',
  'versionUnsupported',
  'noKey',
  'keyUnreadable',
  'notRegistered',
] as const
export type UnusableReason = (typeof UNUSABLE_REASONS)[number]

export interface Route {
  readonly id: string
  readonly kind: RouteKind
  readonly label: string
  readonly detail: string | null
  /**
   * Why this route cannot answer, in the words the pane shows.
   *
   * DISPLAY ONLY. Anything deciding what to DO reads `reason`.
   */
  readonly unusable: string | null
  /** The same fact as `unusable`, as a code. Absent means usable. */
  readonly reason?: { readonly [K in UnusableReason]?: unknown } | UnusableReason
  readonly installed: boolean
  readonly bytes?: number
  readonly modality: Modality
}

/**
 * The code on a route, whichever shape serde used for it.
 *
 * `versionUnsupported` carries a payload and the rest do not, so serde's
 * externally-tagged encoding writes a bare string for the unit variants and a
 * one-key object for the other. Both are read here rather than at each call
 * site, because a call site that handled only one would be right until the
 * first reason gained a field.
 */
export function reasonOf(route: Route): UnusableReason | null {
  const { reason } = route
  if (reason === undefined) return null
  /* CHECKED AGAINST THE SET, not cast: a code this build does not know —
   * a newer crate, a malformed answer — used to be handed on as if it were
   * one of ours and could pick the wrong action. Unknown reads as "unusable,
   * reason unknown", which is what `unusable`'s sentence still says. */
  const key = typeof reason === 'string' ? reason : Object.keys(reason)[0]
  return key !== undefined && (UNUSABLE_REASONS as readonly string[]).includes(key) ? (key as UnusableReason) : null
}

export interface Probe {
  readonly routes: readonly Route[]
  readonly runtimeVersion: string | null
}

/**
 * Whether an endpoint's key is there — THREE answers, because the keychain
 * gives three, as `endpoints.rs`'s `KeyState` says.
 *
 * `unreadable` is the one a boolean used to hide: the keychain refused to
 * say (a denied prompt, a rebuilt binary the entry's ACL no longer trusts).
 * The key is probably there, so "no key" — go and add one — was the wrong
 * advice, and re-entering it would be refused again on the next read.
 */
export type KeyState = 'set' | 'missing' | 'unreadable'

export interface Endpoint {
  readonly id: string
  readonly label: string
  readonly baseUrl: string
  /** A STATE, never the key. */
  readonly keyState: KeyState
}

export interface ResourceUsage {
  /** `null`, never `0`, when the figure is unavailable. */
  readonly residentBytes: number | null
  /**
   * Which model is resident, as a MANIFEST ID.
   *
   * Never the daemon's own string: its model fields carry absolute artifact
   * paths, and this crosses into a webview that renders untrusted book HTML.
   * `commands.rs` matches the daemon's answer against the catalogue and sends
   * the catalogue's id, or null when nothing matches.
   */
  readonly modelLoaded: string | null
}

/* ────────────────────────────── the commands ────────────────────────────── */

/**
 * A plugin command's FULL name.
 *
 * `plugin:<name>|<command>` is how Tauri 2 registers a plugin's commands, and
 * a bare name resolves against the app's own — which is not an error the
 * caller can see coming. Every command in this file was invoked bare, so every
 * call rejected with the string `Command inference_status not found`, and
 * because that string carries no `kind`, `detailFor` mapped it to the one
 * sentence that says nothing: **Something went wrong**. The runtime read
 * degraded, the models folder and the memory figure read `—`, and the daemon
 * was up and healthy the whole time.
 *
 * `tauri-plugin-peer` has had this helper since phase 7 (`wire.ts`); this file
 * did not. `plugin.contract.test.ts` now holds both halves to it.
 */
/**
 * Every command this plugin exposes.
 *
 * A UNION, NOT `string`. `command` took any string, so a typo — or a name
 * changed on the Rust side and not here — produced a perfectly well-formed
 * `plugin:inference|inference_statuss` that failed at runtime with "command
 * not found", which is exactly the failure the prefix bug already cost an
 * afternoon to find once. `plugin.contract.test.ts` checks this list against
 * the three Rust surfaces; the type is what makes a mistake in the list itself
 * a compile error rather than a fourth place to check.
 */
export type InferenceCommand =
  | 'inference_status'
  | 'inference_start'
  | 'inference_stop'
  | 'inference_models'
  | 'inference_install_model'
  | 'inference_remove_model'
  | 'inference_resource_usage'
  | 'inference_reveal_models_dir'
  | 'inference_probe'
  | 'inference_generate'
  | 'inference_gloss'
  | 'inference_speak'
  | 'inference_endpoints'
  | 'inference_add_endpoint'
  | 'inference_remove_endpoint'
  | 'inference_set_endpoint_key'
  | 'agent_ask'
  | 'agent_sign_in'
  | 'inference_cancel'

const command = (name: InferenceCommand) => `plugin:inference|${name}`

/**
 * A `Channel` wired to `onMessage`, for the three commands that stream.
 *
 * The same four lines were written out in `installModel`, `generate` and
 * `agentAsk`; a fourth streaming command would have been a fourth copy, and
 * one of them forgetting to assign `onmessage` is a command that runs to
 * completion having delivered nothing.
 */
function streamTo<T>(onMessage: (value: T) => void): Channel<T> {
  const channel = new Channel<T>()
  channel.onmessage = onMessage
  return channel
}

export const inferencePlugin = {
  status: () => invoke<RuntimeStatus>(command('inference_status')),
  start: () => invoke<number>(command('inference_start')),
  stop: () => invoke<void>(command('inference_stop')),

  models: () => invoke<readonly ModelRow[]>(command('inference_models')),
  installModel: (requestId: string, model: string, onProgress: (p: InstallProgress) => void) =>
    invoke<void>(command('inference_install_model'), {
      requestId,
      model,
      progress: streamTo(onProgress),
    }),
  removeModel: (model: string) => invoke<void>(command('inference_remove_model'), { model }),
  resourceUsage: () => invoke<ResourceUsage>(command('inference_resource_usage')),
  revealModelsDir: () => invoke<string>(command('inference_reveal_models_dir')),

  probe: () => invoke<Probe>(command('inference_probe')),

  generate: (
    requestId: string,
    model: string,
    system: string,
    question: string,
    onChunk: (text: string) => void,
  ) =>
    invoke<string>(command('inference_generate'), {
      requestId,
      model,
      system,
      question,
      chunks: streamTo(onChunk),
    }),
  gloss: (requestId: string, model: string, system: string, question: string) =>
    invoke<string>(command('inference_gloss'), { requestId, model, system, question }),
  speak: (requestId: string, model: string, text: string, voice: string | null) =>
    invoke<number[]>(command('inference_speak'), { requestId, model, text, voice }),

  endpoints: () => invoke<readonly Endpoint[]>(command('inference_endpoints')),
  addEndpoint: (id: string, label: string, baseUrl: string) =>
    invoke<void>(command('inference_add_endpoint'), { id, label, baseUrl }),
  removeEndpoint: (id: string) => invoke<void>(command('inference_remove_endpoint'), { id }),
  /** WRITE-ONLY. There is deliberately no `getEndpointKey`. */
  setEndpointKey: (id: string, key: string) => invoke<void>(command('inference_set_endpoint_key'), { id, key }),

  agentAsk: (requestId: string, route: string, prompt: string, depth: Depth, onChunk: (text: string) => void) =>
    invoke<string>(command('agent_ask'), {
      requestId,
      route,
      prompt,
      depth,
      chunks: streamTo(onChunk),
    }),
  agentSignIn: (route: string) => invoke<void>(command('agent_sign_in'), { route }),

  cancel: (requestId: string) => invoke<void>(command('inference_cancel'), { requestId }),
} as const

/** The plugin's surface, so a test can stand in for it. */
export type InferencePlugin = typeof inferencePlugin

/* ──────────────────────────────── errors ───────────────────────────────── */

/**
 * The `kind` of a rejected plugin call, or `null` when the rejection did not
 * come from the plugin.
 *
 * `null` rather than a guess: a rejection with no `kind` is a Tauri or
 * webview failure, and treating it as one of the plugin's own would put the
 * wrong sentence in front of the reader.
 */
export function errorKind(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const kind = (error as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : null
}

/** Whether a rejection is the reader's own cancellation rather than a fault. */
export function isCancelled(error: unknown): boolean {
  return errorKind(error) === 'cancelled'
}

/**
 * Cancel a request, and say so when the cancel itself fails for a real reason.
 *
 * ⚠️ **THIS WAS `\.catch(() => {})` IN TWO PLACES**, and that is the whole
 * argument for it existing. `glossProvider` and `inferencePort`'s `withCancel`
 * each wired the reader's abort to `plugin.cancel` and each swallowed every
 * failure — so when an audit found the swallow, fixing it in one copy left the
 * other exactly as it was. Two call sites of one shape is a class, not two
 * bugs.
 *
 * EXACTLY ONE FAILURE IS EXPECTED: `requestUnknown`, the race where the
 * request finished before the cancel arrived. Anything else means the daemon
 * is still generating for a reader who has gone — a GPU and a model held for
 * an answer nobody will read — and that is worth a line in the log.
 *
 * Never rethrows: it runs from an `abort` listener, where there is nobody to
 * catch and the reader has already moved on.
 */
export function cancelRequest(
  plugin: Pick<InferencePlugin, 'cancel'>,
  requestId: string,
  report?: ((event: string, fields: Record<string, unknown>) => void) | undefined,
): void {
  void plugin.cancel(requestId).catch((cause: unknown) => {
    if (errorKind(cause) === 'requestUnknown') return
    report?.('inference.cancel-failed', {
      requestId,
      kind: errorKind(cause),
      message: messageOf(cause),
    })
  })
}

/**
 * A request id, unique per call.
 *
 * MINTED BY THE CALLER, which is what lets a cancel that arrives before the
 * request does still be meaningful — see the crate's `requests.rs`. It is a
 * correlation id and nothing more: it is never a filename, never a key, and
 * never shown.
 *
 * # Unique across webviews and across reloads, not just within one
 *
 * ⚠️ This was a bare module-level counter, so it restarted at 1 on every
 * webview reload and ran independently in every webview — while `Registry` in
 * Rust holds ONE map for the whole process and refuses a duplicate id with
 * `RequestBusy`. So a reload during a long answer, or a second window, minted
 * `ask-1` against a request the daemon still had open, and the reader's next
 * question was refused as "already in flight" — a state they could not see and
 * could not clear.
 *
 * The counter still runs, because an ordered id is far easier to follow in a
 * log than a bare UUID; a per-load random component is what makes it unique.
 */
const SESSION = (() => {
  /* `Math.random().toString(36).slice(2, 10)` could be EMPTY (a random of
   * exactly 0) and carried ~41 bits; the UUID is the platform's own source
   * and never empty. The base-36 fallback is for a runtime with no
   * `crypto` — none this app ships to, kept for the type. */
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid !== undefined ? uuid.replace(/-/g, '').slice(0, 12) : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10) || '0'}`
})()
let counter = 0
export function mintRequestId(prefix: string): string {
  counter += 1
  return `${prefix}-${SESSION}-${counter}`
}
