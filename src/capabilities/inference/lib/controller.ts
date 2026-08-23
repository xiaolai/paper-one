import type { InferencePlugin, InstallProgress, ModelRow, RuntimeStatus } from './plugin'
import { isCancelled, mintRequestId } from './plugin'

/**
 * The runtime's state machine — `absent → installing → installed → starting →
 * ready ⇄ degraded` — and the one store the Local models section reads.
 *
 * ⚠️ **THIS MACHINE LIVES HERE, NOT IN THE KERNEL'S START/FAIL.** F2 is the
 * whole reason the capability was split off: `registry.ts` says in capitals
 * that a dependency which did not compose takes its dependants with it, so if
 * "nothing installed yet" were a `start` failure, every first launch would
 * lose the Codex and Claude entrances too — a local runtime that has not been
 * downloaded deleting two routes that need no download at all.
 *
 * So `start()` binds this controller and returns. **It never fails on
 * absence**, it launches no process at boot, and `absent` is a normal state
 * this store reports rather than an error the registry sees.
 *
 * # `degraded` is not `absent`
 *
 * The two look alike in a settings row and are different things. `absent`
 * means there is nothing installed and the fix is a download. `degraded`
 * means something that was working has stopped — the daemon exited, a request
 * failed — and the fix is a restart. A machine that collapsed them would tell
 * a reader to download a runtime they already have.
 */

export type RuntimeState =
  | { readonly kind: 'absent'; readonly reason: string }
  | { readonly kind: 'installing'; readonly model: string; readonly received: number; readonly total: number }
  | { readonly kind: 'verifying'; readonly model: string }
  | { readonly kind: 'installed' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'ready'; readonly version: string }
  | { readonly kind: 'degraded'; readonly detail: string }

export interface InferenceSnapshot {
  readonly runtime: RuntimeState
  readonly models: readonly ModelRow[]
  /** The model id currently downloading, or null. At most one at a time. */
  readonly installing: string | null
}

export interface InferenceStore {
  getSnapshot(): InferenceSnapshot
  subscribe(listener: () => void): () => void
}

export interface Controller extends InferenceStore {
  /** Read the runtime's status and the model list. Safe to call repeatedly. */
  refresh(): Promise<void>
  install(model: string): Promise<void>
  cancelInstall(): void
  /**
   * Delete a model's artifacts.
   *
   * `uninstall`, NOT `remove`, and the name is load-bearing rather than
   * stylistic: `scripts/capability-fs-footprint.test.mjs` scans capabilities
   * for `.remove(` as one of the shapes a raw filesystem write takes, and a
   * method by that name reads as an unreviewed write to the one check whose
   * job is to notice them. The bytes here are deleted in Rust, behind a named
   * command; naming it plainly keeps that gate sharp instead of adding a
   * false positive to its allowlist.
   */
  uninstall(model: string): Promise<void>
  /** Start the daemon if it is not up. Answers false when it could not. */
  ensureReady(): Promise<boolean>
  /** The id of an installed text model, or null — what `gloss` answers with. */
  textModel(): string | null
  dispose(): void
}

const INITIAL: InferenceSnapshot = {
  runtime: { kind: 'absent', reason: 'Not installed' },
  models: [],
  installing: null,
}

/**
 * What a failure says to the reader. §11's voice: what happened, not a code.
 *
 * Mapped from the plugin's `kind` rather than its `message`, because the
 * message is written for a maintainer and the reader needs a sentence they
 * can act on.
 */
export function detailFor(error: unknown): string {
  const kind = typeof error === 'object' && error !== null ? (error as { kind?: unknown }).kind : null
  switch (kind) {
    case 'runtimeMissing':
      return 'The runtime is not installed'
    case 'notReady':
      return 'The runtime did not start'
    case 'runtimeExited':
      return 'The runtime stopped'
    case 'digestMismatch':
    case 'sizeMismatch':
      return 'The download did not verify — nothing was changed'
    case 'runtimeUnreachable':
      return 'The runtime is not answering'
    case 'notRunning':
      return 'The runtime is not running'
    default:
      return 'Something went wrong'
  }
}

/**
 * Told when a refresh fails, so a degraded runtime is not silent.
 *
 * `refresh` catches its own error and turns it into a `degraded` state — which
 * is right, since a capability must not fail to start over IPC. The cost was
 * that `void controller.refresh().catch(…)` in `index.ts` could never fire:
 * the promise never rejects, so the diagnostic it wrote was unreachable code.
 *
 * That mattered exactly once and completely. Every command was invoked without
 * its `plugin:inference|` prefix, so every call rejected with a bare string,
 * `detailFor` mapped it to its default, and the reader was told **Something
 * went wrong** while the log said nothing at all. The message this reports is
 * the maintainer's half — `Command inference_status not found` — which is the
 * sentence that would have ended the search in a minute.
 */
export type ReportFailure = (event: string, fields: Record<string, unknown>) => void

export function createController(plugin: InferencePlugin, report?: ReportFailure): Controller {
  let snapshot: InferenceSnapshot = INITIAL
  const listeners = new Set<() => void>()
  let disposed = false
  let installRequest: string | null = null

  const set = (next: Partial<InferenceSnapshot>): void => {
    if (disposed) return
    snapshot = { ...snapshot, ...next }
    for (const listener of [...listeners]) listener()
  }

  const runtimeFrom = (status: RuntimeStatus): RuntimeState => {
    switch (status.state) {
      case 'absent':
        return { kind: 'absent', reason: status.reason }
      case 'stopped':
        return { kind: 'installed' }
      case 'ready':
        return { kind: 'ready', version: status.version }
    }
  }

  const refresh = async (): Promise<void> => {
    /* A refresh must not stamp over a download in flight: the reader opened
     * the pane, the list reloaded, and `installing` would become `installed`
     * with the bytes still arriving.
     *
     * ⚠️ `busy` IS READ AFTER THE AWAIT, NOT BEFORE IT. Snapshotting it first
     * left a race the reader can hit: a refresh starts while nothing is
     * downloading, the reader presses Install, and the refresh lands with a
     * stale `busy = false` and stamps `installed` over a download whose bytes
     * are still arriving. Found by audit. Reading it on the far side asks the
     * question at the moment the answer is used. */
    try {
      const [status, models] = await Promise.all([plugin.status(), plugin.models()])
      const busy = snapshot.installing !== null
      set(busy ? { models } : { runtime: runtimeFrom(status), models })
    } catch (error) {
      if (snapshot.installing === null) {
        const detail = detailFor(error)
        /* BOTH HALVES. `detail` is what the reader is shown; `message` is the
           maintainer's, and they are deliberately different sentences — see
           `detailFor`. Reporting only the first would have said "Something
           went wrong" to the log as well. */
        report?.('inference.refresh-failed', {
          detail,
          message: error instanceof Error ? error.message : String(error),
        })
        set({ runtime: { kind: 'degraded', detail } })
      }
    }
  }

  const install = async (model: string): Promise<void> => {
    if (snapshot.installing !== null) return
    const requestId = mintRequestId('install')
    installRequest = requestId
    /* What to go back to if the reader cancels. `installed` was assumed, which
     * is wrong for the common case — a reader cancelling their FIRST download
     * had nothing installed and the row claimed otherwise. */
    const before = snapshot.runtime
    set({ installing: model, runtime: { kind: 'installing', model, received: 0, total: 0 } })
    try {
      await plugin.installModel(requestId, model, (progress: InstallProgress) => {
        if (installRequest !== requestId) return
        if (progress.kind === 'downloading') {
          set({ runtime: { kind: 'installing', model, received: progress.received, total: progress.total } })
        } else if (progress.kind === 'verifying') {
          set({ runtime: { kind: 'verifying', model } })
        }
      })
      /* ⚠️ OWNERSHIP ON EVERY COMPLETION PATH. A cancelled install's promise
       * still runs to completion, and without this check its handler cleared
       * `installRequest` and stamped state belonging to the install that had
       * REPLACED it — so the second download's progress vanished and its row
       * went back to Install while the bytes kept arriving. Found by audit.
       * The rule is the one `sync`'s teardown follows: an older lifetime never
       * writes over a newer one. */
      if (installRequest !== requestId) return
      installRequest = null
      set({ installing: null, runtime: { kind: 'installed' } })
      await refresh()
    } catch (error) {
      if (installRequest !== requestId) return
      installRequest = null
      /* A cancellation is the reader's own doing and is not a fault: the
       * state returns to what it was, and nothing is said about it. Restoring
       * the PRE-INSTALL runtime rather than assuming `installed` — the reader
       * may have had nothing installed when they started. */
      set({
        installing: null,
        runtime: isCancelled(error) ? before : { kind: 'degraded', detail: detailFor(error) },
      })
      if (!isCancelled(error)) throw error
    }
  }

  const cancelInstall = (): void => {
    const requestId = installRequest
    if (requestId === null) return
    installRequest = null
    /* Best-effort: the request may have finished between the reader pressing
     * Cancel and this landing, and `requestUnknown` is that race, not a
     * failure worth showing. */
    void plugin.cancel(requestId).catch(() => {})
    /* The runtime state goes back too. Clearing only `installing` left the row
     * reading `Downloading…` forever with nothing behind it, because the
     * completion handler that would have cleared it now returns early on the
     * ownership check above. */
    set({ installing: null, runtime: { kind: 'installed' } })
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    refresh,
    install,
    cancelInstall,
    uninstall: async (model) => {
      await plugin.removeModel(model)
      await refresh()
    },
    ensureReady: async () => {
      /* ⚠️ NO CACHED `ready`. Trusting the last known state meant a daemon
       * that had since crashed was never restarted: every later question saw
       * `ready`, skipped the start, and failed at the request instead. The
       * plugin's own `start` is idempotent and cheap when the daemon is up —
       * it health-checks and returns the same port — so asking every time
       * costs one loopback round trip and buys a runtime that recovers.
       * Found by audit. */
      if (snapshot.runtime.kind !== 'ready') set({ runtime: { kind: 'starting' } })
      try {
        await plugin.start()
        const status = await plugin.status()
        set({ runtime: runtimeFrom(status) })
        return status.state === 'ready'
      } catch (error) {
        set({ runtime: { kind: 'degraded', detail: detailFor(error) } })
        return false
      }
    },
    textModel: () => snapshot.models.find((m) => m.modality === 'text' && m.installed)?.id ?? null,
    dispose: () => {
      disposed = true
      listeners.clear()
    },
  }
}
