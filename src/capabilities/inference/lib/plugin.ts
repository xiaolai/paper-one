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

export interface Route {
  readonly id: string
  readonly kind: RouteKind
  readonly label: string
  readonly detail: string | null
  /** Why this route cannot answer, in the words the pane shows. */
  readonly unusable: string | null
  readonly installed: boolean
  readonly bytes?: number
  readonly modality: Modality
}

export interface Probe {
  readonly routes: readonly Route[]
  readonly runtimeVersion: string | null
}

export interface Endpoint {
  readonly id: string
  readonly label: string
  readonly baseUrl: string
  readonly hasKey: boolean
}

export interface ResourceUsage {
  /** `null`, never `0`, when the figure is unavailable. */
  readonly residentBytes: number | null
  readonly modelLoaded: string | null
}

/* ────────────────────────────── the commands ────────────────────────────── */

export const inferencePlugin = {
  status: () => invoke<RuntimeStatus>('inference_status'),
  start: () => invoke<number>('inference_start'),
  stop: () => invoke<void>('inference_stop'),

  models: () => invoke<readonly ModelRow[]>('inference_models'),
  installModel: (requestId: string, model: string, onProgress: (p: InstallProgress) => void) => {
    const progress = new Channel<InstallProgress>()
    progress.onmessage = onProgress
    return invoke<void>('inference_install_model', { requestId, model, progress })
  },
  removeModel: (model: string) => invoke<void>('inference_remove_model', { model }),
  resourceUsage: () => invoke<ResourceUsage>('inference_resource_usage'),
  revealModelsDir: () => invoke<string>('inference_reveal_models_dir'),

  probe: () => invoke<Probe>('inference_probe'),

  generate: (
    requestId: string,
    model: string,
    system: string,
    question: string,
    onChunk: (text: string) => void,
  ) => {
    const chunks = new Channel<string>()
    chunks.onmessage = onChunk
    return invoke<string>('inference_generate', { requestId, model, system, question, chunks })
  },
  gloss: (requestId: string, model: string, system: string, question: string) =>
    invoke<string>('inference_gloss', { requestId, model, system, question }),
  speak: (requestId: string, model: string, text: string, voice: string | null) =>
    invoke<number[]>('inference_speak', { requestId, model, text, voice }),

  endpoints: () => invoke<readonly Endpoint[]>('inference_endpoints'),
  addEndpoint: (id: string, label: string, baseUrl: string) =>
    invoke<void>('inference_add_endpoint', { id, label, baseUrl }),
  removeEndpoint: (id: string) => invoke<void>('inference_remove_endpoint', { id }),
  /** WRITE-ONLY. There is deliberately no `getEndpointKey`. */
  setEndpointKey: (id: string, key: string) => invoke<void>('inference_set_endpoint_key', { id, key }),

  agentAsk: (requestId: string, route: string, prompt: string, onChunk: (text: string) => void) => {
    const chunks = new Channel<string>()
    chunks.onmessage = onChunk
    return invoke<string>('agent_ask', { requestId, route, prompt, chunks })
  },
  agentSignIn: (route: string) => invoke<void>('agent_sign_in', { route }),

  cancel: (requestId: string) => invoke<void>('inference_cancel', { requestId }),
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
 * A request id, unique per call.
 *
 * MINTED BY THE CALLER, which is what lets a cancel that arrives before the
 * request does still be meaningful — see the crate's `requests.rs`. It is a
 * correlation id and nothing more: it is never a filename, never a key, and
 * never shown.
 */
let counter = 0
export function mintRequestId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}`
}
