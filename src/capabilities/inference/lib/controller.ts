import { createGenerations } from '../../../kernel'
import { messageOf } from './messageOf'
import type { InferencePlugin, InstallProgress, ModelRow, RuntimeStatus } from './plugin'
import { errorKind, isCancelled, mintRequestId } from './plugin'

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
  /** The model a removal is in flight for — one at a time, see `uninstall`. */
  readonly removing: string | null
  /**
   * What went wrong with the last download or removal, in the reader's words.
   *
   * Here because the only callers are `void model.install(id)` and
   * `void model.uninstall(id)` in `ModelsPane` — a rejection from either is an
   * unhandled promise and a reader who is told nothing at all. Every other
   * operation on this controller already absorbs its failure into state
   * (`refresh` into `degraded`, `ensureReady` into `false`); these two were the
   * exceptions, and being the exception is what made them silent.
   *
   * Cleared when the next download or removal starts, so it describes the last
   * thing the reader did rather than accumulating.
   */
  readonly failure: string | null
}

export interface InferenceStore {
  getSnapshot(): InferenceSnapshot
  subscribe(listener: () => void): () => void
}

export interface Controller extends InferenceStore {
  /** Read the runtime's status and the model list. Safe to call repeatedly. */
  refresh(): Promise<void>
  /**
   * Download a model. **Resolves; never rejects.**
   *
   * False means it did not end up installed — refused because another download
   * owns the slot, cancelled by the reader, or failed. A failure also lands in
   * `snapshot.failure`; the three are distinguishable there and in the log,
   * and none of them reaches a caller as a rejection.
   */
  install(model: string): Promise<boolean>
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
  uninstall(model: string): Promise<boolean>
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
  removing: null,
  failure: null,
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
    /* WI-20.24: the staged runtime is checked file by file against its
     * manifest before every spawn, and a byte that differs refuses the
     * launch. The plugin's message names the file; this is the sentence. */
    case 'runtimeUnverified':
      return 'The runtime did not verify — nothing was started'
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
    /* ── REACHABLE FROM THE GLOSS, and added because they were not ──────
     *
     * Audit finding. The five below all reach a reader through
     * `glossProvider`'s translation and every one of them landed on the
     * default, which says nothing anybody can act on. The gloss is the only
     * lookup Paper has, so "Something went wrong" there is the end of the
     * road rather than a nudge toward the other mode.
     *
     * `cancelled` is here for the case `glossProvider` cannot treat as the
     * reader's own abort: the daemon cancels in-flight requests when it stops,
     * and that arrives with a signal that was never aborted. */
    case 'modelUnknown':
      return 'That model is not available'
    /* ⚠️ WORDED FOR EVERY CALLER, NOT FOR THE GLOSS. These two said "That
     * lookup is already running" and "That passage is too long to look up",
     * which is right at a Look up and wrong everywhere else — `detailFor` is
     * also what a failed download or removal reports, and both kinds are
     * reachable there: `Registry::begin` refuses a duplicate request id, and
     * `inference_install_model` bounds its own `request id` field. So an
     * install collision told the reader their lookup was busy. Caught by the
     * verify pass, one round after the fix that introduced it. */
    case 'requestBusy':
      return 'That request is already running'
    case 'fieldTooLarge':
      return 'That request was too large'
    case 'runtimeHttp':
      return 'The runtime refused the request'
    case 'runtimeMalformed':
      return 'The runtime’s answer could not be read'
    /* THE GLOSS'S OWN, and the only caller that can raise it: `inference_gloss`
     * refuses an answer the model was cut off in the middle of, because it is
     * delivered whole and would otherwise be drawn in amber as a finished
     * definition. Worded for the reader — what happened, not the token bound,
     * which is in the crate's own message for whoever reads the log. */
    case 'answerTruncated':
      return 'The answer was cut off before it finished'
    case 'cancelled':
      return 'The runtime stopped before it answered'
    /* ── REACHABLE FROM THE COMPANION, and added because they were not ──
     *
     * WI-20.18. An agent route rejects with the four `agent*` kinds and a
     * cloud endpoint's key read with `keychain`, and every one of them landed
     * on the default — so a reader signed out of Codex was told "Something
     * went wrong" by a thread that knew exactly what was wrong. "That agent"
     * rather than its name, for the reason the two above say "That request":
     * this is worded for every caller, and the crate's own message names the
     * agent in the maintainer's half. */
    case 'agentSignedOut':
      return 'That agent is not signed in'
    case 'agentMissing':
      return 'That agent is not installed'
    case 'agentUnsupportedVersion':
      return 'That agent’s version is not supported'
    case 'agentMalformed':
      return 'That agent’s answer could not be read'
    case 'keychain':
      return 'The keychain refused'
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

/**
 * The download that currently owns the runtime slot.
 *
 * ONE OBJECT, because the three fields were three variables — `snapshot
 * .installing`, a separate `installRequest`, and a closure-local `before` —
 * and every path had to remember to move all three together. Two did not: an
 * explicit cancel restored `installed` rather than the state the reader
 * started from, and `ensureReady` wrote `starting` over a download in flight
 * while `installing` still said it was downloading. Both are the same mistake,
 * which is what makes them one variable now.
 */
interface Install {
  readonly requestId: string
  readonly model: string
  /** Where to put the runtime back if the reader cancels. */
  readonly before: RuntimeState
}


/**
 * The six commands this controller actually uses, of the plugin's nineteen.
 *
 * NARROWED ON PURPOSE. Taking the whole `InferencePlugin` meant a test double
 * had to be cast through `unknown` to stand in for it, and once one cast is
 * there the compiler stops checking any of the signatures — which is precisely
 * how a plugin API change would reach production past a green suite. Naming
 * the six lets a fake be written with no cast at all, so drift in any of them
 * is a type error in the test.
 */
export type ControllerPlugin = Pick<
  InferencePlugin,
  'status' | 'models' | 'start' | 'installModel' | 'removeModel' | 'cancel'
>

export function createController(plugin: ControllerPlugin, reportTo?: ReportFailure): Controller {
  let snapshot: InferenceSnapshot = INITIAL
  const listeners = new Set<() => void>()
  let disposed = false
  let install_: Install | null = null
  /* LAST ISSUED WINS. Two refreshes overlap whenever the reader opens the pane
     while one is already out, and `status()` and `models()` are two IPC round
     trips that need not return in the order they were asked. Without this the
     older one lands last and puts back the catalogue it read. */
  const generations = createGenerations()
  /* A REPORTER THAT CANNOT TURN A RECOVERY INTO A REJECTION. `refresh`,
     `install` and `uninstall` promise to absorb their failures; a reporter
     that threw inside their catch blocks broke that promise and, in
     `install`, left the slot owned with the state stuck on "installing". */
  const report = (event: string, fields: Record<string, unknown>): void => {
    try {
      reportTo?.(event, fields)
    } catch (thrown) {
      console.error('inference controller: the failure reporter itself threw', thrown, 'while reporting', event)
    }
  }

  const set = (next: Partial<InferenceSnapshot>): void => {
    if (disposed) return
    snapshot = { ...snapshot, ...next }
    for (const listener of [...listeners]) listener()
  }

  /**
   * Whether a download owns the runtime slot.
   *
   * ⚠️ **NOTHING ELSE WRITES `runtime` WHILE THIS IS TRUE.** A download is the
   * only operation whose state the reader is actively watching — it carries the
   * byte counts and it is what puts Cancel on screen. `refresh` already
   * followed this rule; `ensureReady` did not, so asking a question mid-download
   * replaced `installing` with `starting` and the Cancel button vanished until
   * the next progress event arrived.
   */
  const owned = (): boolean => install_ !== null

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

  /**
   * The catalogue with one row's installed flag corrected.
   *
   * Applied from the command's OWN result rather than waiting for the refresh
   * that follows it: `refresh` swallows its failure by design, so an install
   * or a removal that relied on it alone reported success over a row still
   * saying the opposite. The refresh still runs and still wins when it works —
   * this only keeps the row honest when it does not.
   */
  const withInstalled = (id: string, installed: boolean): ModelRow[] =>
    snapshot.models.map((row) => (row.id === id ? { ...row, installed } : row))

  const refresh = async (): Promise<void> => {
    const mine = generations.claim()
    try {
      const [status, models] = await Promise.all([plugin.status(), plugin.models()])
      /* Superseded by a later refresh — its answer is the current one. */
      if (!mine()) return
      /* A refresh must not stamp over a download in flight: the reader opened
       * the pane, the list reloaded, and `installing` would become `installed`
       * with the bytes still arriving.
       *
       * ⚠️ OWNERSHIP IS READ AFTER THE AWAIT, NOT BEFORE IT. Snapshotting it
       * first left a race the reader can hit: a refresh starts while nothing is
       * downloading, the reader presses Install, and the refresh lands with a
       * stale answer and stamps `installed` over a download whose bytes are
       * still arriving. Found by audit. Reading it on the far side asks the
       * question at the moment the answer is used. */
      set(owned() ? { models } : { runtime: runtimeFrom(status), models })
    } catch (error) {
      const detail = detailFor(error)
      /* ⚠️ REPORTED WHATEVER ELSE IS HAPPENING. This used to be inside the
         install guard, so every refresh that failed during a download was
         discarded entirely — diagnostic included. Suppressing the STATE write
         is the requirement; suppressing the record of the failure is how a
         degraded runtime goes back to being silent, which is the one thing
         this reporter exists to prevent.

         BOTH HALVES. `detail` is what the reader is shown; `message` is the
         maintainer's, and they are deliberately different sentences — see
         `detailFor`. Reporting only the first would have said "Something went
         wrong" to the log as well. */
      report('inference.refresh-failed', { detail, message: messageOf(error) })
      if (mine() && !owned()) set({ runtime: { kind: 'degraded', detail } })
    }
  }

  const install = async (model: string): Promise<boolean> => {
    /* REFUSED, AND IT SAYS SO. Returning nothing here made a refusal
       indistinguishable from a finished download to every caller. */
    if (install_ !== null) return false
    const requestId = mintRequestId('install')
    /* What to go back to if the reader cancels. `installed` was assumed, which
     * is wrong for the common case — a reader cancelling their FIRST download
     * had nothing installed and the row claimed otherwise. */
    const session: Install = { requestId, model, before: snapshot.runtime }
    install_ = session
    set({ installing: model, failure: null, runtime: { kind: 'installing', model, received: 0, total: 0 } })
    /* ⚠️ OWNERSHIP ON EVERY COMPLETION PATH. A cancelled install's promise
     * still runs to completion, and without this check its handler cleared the
     * slot and stamped state belonging to the install that had REPLACED it —
     * so the second download's progress vanished and its row went back to
     * Install while the bytes kept arriving. Found by audit. The rule is the
     * one `sync`'s teardown follows: an older lifetime never writes over a
     * newer one. */
    const mine = (): boolean => install_?.requestId === requestId
    try {
      await plugin.installModel(requestId, model, (progress: InstallProgress) => {
        if (!mine()) return
        if (progress.kind === 'downloading') {
          set({ runtime: { kind: 'installing', model, received: progress.received, total: progress.total } })
        } else if (progress.kind === 'verifying') {
          set({ runtime: { kind: 'verifying', model } })
        }
      })
      if (!mine()) return false
      install_ = null
      /* WHAT WAS RUNNING IS STILL RUNNING. Stamping `installed` here over a
         `ready` runtime meant that if the refresh below then failed, a live
         daemon was reported stopped until the next successful read. The
         model row is corrected locally; the runtime keeps `before` — a
         download changes what is on disk, not whether the daemon is up —
         and the refresh is the authority when it answers. */
      set({ installing: null, runtime: session.before, models: withInstalled(model, true) })
      await refresh()
      return true
    } catch (error) {
      if (!mine()) return false
      install_ = null
      /* A cancellation is the reader's own doing and is not a fault: the state
       * returns to what it was, and nothing is said about it. Restoring the
       * PRE-INSTALL runtime rather than assuming `installed` — the reader may
       * have had nothing installed when they started. */
      if (isCancelled(error)) {
        set({ installing: null, runtime: session.before })
        return false
      }
      const detail = detailFor(error)
      report('inference.install-failed', { model, detail, message: messageOf(error) })
      /* THE OPERATION FAILED; THE RUNTIME DID NOT. A digest mismatch or a
         refused download said nothing about the daemon, yet marked it
         degraded — `failure` is the operation's field, and the runtime goes
         back to what it was. */
      set({ installing: null, failure: detail, runtime: session.before })
      return false
    }
  }

  const cancelInstall = (): void => {
    const requestId = install_?.requestId ?? null
    if (requestId === null) return
    /* OWNERSHIP IS NOT RELEASED HERE, and that is the fix.
     *
     * This used to clear the slot on the spot, so a new install could start the
     * instant Cancel was pressed — while the cancelled one was still unwinding
     * in Rust, against the same staging path derived from the same model id.
     * Two writers, one file.
     *
     * The install's own settle is the only conclusive signal that the first one
     * has finished, and it already restores the pre-install runtime on a
     * cancellation. Releasing ownership there rather than here means there is
     * exactly one place that decides an install is over, and `install`'s
     * own guard keeps the next one out until it is.
     *
     * `requestUnknown` is the ordinary race — the request finished between the
     * press and this landing — and is not worth showing. Anything else is a
     * cancel that did not happen, which the reader is about to notice, so it is
     * reported rather than swallowed. */
    void plugin.cancel(requestId).catch((cause: unknown) => {
      if (errorKind(cause) === 'requestUnknown') return
      report('inference.cancel-failed', { message: messageOf(cause) })
    })
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
      /* ONE REMOVAL AT A TIME. A double-click started two; the second was
         refused `requestBusy` by the daemon and its failure was shown over a
         first that had succeeded. The pane disables Remove on `removing`. */
      if (snapshot.removing !== null) return false
      set({ failure: null, removing: model })
      try {
        await plugin.removeModel(model)
      } catch (error) {
        /* RESOLVES FALSE, DOES NOT REJECT — the caller is `void
           model.uninstall(id)`, so a rejection here is an unhandled promise
           and a Remove button that appears to have done nothing. */
        const detail = detailFor(error)
        report('inference.remove-failed', { model, detail, message: messageOf(error) })
        set({ failure: detail, removing: null })
        return false
      }
      set({ models: withInstalled(model, false), removing: null })
      /* The re-read is still the authority when it works: the daemon knows what
         is on disk. The local correction above is what stops a swallowed
         refresh failure leaving a deleted model reading Installed. */
      await refresh()
      return true
    },
    ensureReady: async () => {
      /* ⚠️ NO CACHED `ready`. Trusting the last known state meant a daemon
       * that had since crashed was never restarted: every later question saw
       * `ready`, skipped the start, and failed at the request instead. The
       * plugin's own `start` is idempotent and cheap when the daemon is up —
       * it health-checks and returns the same port — so asking every time
       * costs one loopback round trip and buys a runtime that recovers.
       * Found by audit. */
      /* THE SAME GENERATION `refresh` CLAIMS. Two `ensureReady`s, or one and
         a refresh, used to settle in either order with the older one writing
         last; whichever asked LAST now owns the next state write, as every
         refresh already did among refreshes. The answer is still returned
         either way — a caller waiting to generate needs it. */
      const mine = generations.claim()
      if (!owned() && snapshot.runtime.kind !== 'ready') set({ runtime: { kind: 'starting' } })
      try {
        await plugin.start()
        const status = await plugin.status()
        /* Asked and answered either way; only the STATE write waits for the
           download to finish owning the slot. */
        if (mine() && !owned()) set({ runtime: runtimeFrom(status) })
        return status.state === 'ready'
      } catch (error) {
        if (mine() && !owned()) set({ runtime: { kind: 'degraded', detail: detailFor(error) } })
        return false
      }
    },
    textModel: () => snapshot.models.find((m) => m.modality === 'text' && m.installed)?.id ?? null,
    dispose: () => {
      disposed = true
      /* Release the slot and retire every refresh in flight, so a late settle
         cannot write through a torn-down controller. */
      install_ = null
      generations.claim()
      listeners.clear()
    },
  }
}
