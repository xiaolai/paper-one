import type {
  BookAction,
  Capability,
  CapabilityContext,
  ClientContribution,
  Command,
  CommandContext,
  Disposable,
  KernelApi,
  PaneContribution,
  ServiceContribution,
  SettingsSection,
} from './capability'
import type { SettingsStore } from './ports'
import type { KernelServices } from './services'
import { isKernelPaneId, type ContributedPaneId, type PaneId } from './uiTypes'

/**
 * The registry: a set of capabilities becomes ONE composition.
 *
 * `composeCapabilities` validates the set (ids, `requires`, namespacing),
 * orders it, starts each capability in that order and returns what they
 * contributed — or throws, having started nothing that stays started. The
 * order is the ADR's (decision 4): topological by `requires`, ties by the
 * order the composition root listed them, which is manifest order; so it is
 * a pure function of the list and the same in every build and every test.
 *
 * ATOMIC. Every check runs before the first `start`, and a `start` that
 * throws disposes the ones already started, in reverse, and leaves NO
 * registry entry of any capability — the composition object does not exist
 * until every start has returned. Half a composition would be a reader with
 * a pane whose service is missing, and there is no honest UI for that.
 */

export type CapabilityErrorCode =
  | 'invalid-id'
  | 'reserved-id'
  | 'duplicate-id'
  | 'missing-requires'
  | 'cyclic-requires'
  | 'namespace'
  | 'duplicate-contribution'
  | 'start-failed'
  | 'aborted'

export class CapabilityError extends Error {
  readonly code: CapabilityErrorCode
  /** The capability at fault, when there is one. */
  readonly capability: string | null

  constructor(code: CapabilityErrorCode, capability: string | null, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CapabilityError'
    this.code = code
    this.capability = capability
  }
}

/** The manifest's id rule, so the registry and the validator agree. */
export const CAPABILITY_ID = /^[a-z][a-z0-9-]*$/
/** The one id no capability may take: its namespaces would be the kernel's. */
export const RESERVED_ID = 'kernel'

/** The registered surfaces, read by the UI. */
export interface Contributions {
  /** Every contributed pane, sorted (`PaneContribution.order`, then registration). */
  readonly panes: readonly PaneContribution[]
  /** Every contributed command for this context, in registration order. */
  commands(ctx: CommandContext): Command[]
  readonly settings: readonly SettingsSection[]
  readonly bookActions: readonly BookAction[]
  /** By service name. */
  readonly services: ReadonlyMap<string, ServiceContribution>
  readonly clients: readonly ClientContribution[]
}

export interface Composition extends Contributions, Disposable {
  /** Capability ids in registration order. */
  readonly order: readonly string[]
  /**
   * Take everything down: every capability's `Disposable`, in reverse
   * registration order, and every registry emptied. Idempotent. Throws an
   * `AggregateError` after disposing all of them if any dispose threw.
   */
  dispose(): void
}

/** The `KernelApi` for a set of services — the same store and diagnostics they hold. */
export function kernelApi(services: KernelServices): KernelApi {
  return { services, settings: services.settings, diagnostics: services.diagnostics }
}

/**
 * A capability's own view of the settings store: reads and writes must name a
 * key in its `<id>.` namespace, and `getSnapshot` shows only that namespace.
 *
 * Namespacing was a naming convention the boundaries could not enforce — a
 * capability could `defineSetting('other.secret')` and read or overwrite it,
 * or `getSnapshot()` the lot. This makes the convention an invariant at the
 * one seam a capability reaches the store through, the same way its
 * `Diagnostics` is already scoped to its id. The kernel's own settings pane
 * reads the unscoped store, so nothing it draws changes.
 */
export function scopeSettings(store: SettingsStore, capId: string): SettingsStore {
  const prefix = `${capId}.`
  const guard = (key: string): void => {
    if (!key.startsWith(prefix)) {
      throw invalid('namespace', capId, `capability "${capId}" may only touch settings under "${prefix}", not ${JSON.stringify(key)}`)
    }
  }
  /* The filtered snapshot is CACHED on the underlying snapshot's identity:
   * `getSnapshot` is the `useSyncExternalStore` read, and that contract is
   * "the same object until the store changed" — a fresh object per call is
   * an every-render change, which is a render loop. */
  let seen: Readonly<Record<string, unknown>> | null = null
  let mine: Readonly<Record<string, unknown>> = {}
  return {
    get: (setting) => {
      guard(setting.key)
      return store.get(setting)
    },
    set: (setting, value) => {
      guard(setting.key)
      store.set(setting, value)
    },
    subscribe: (listener) => store.subscribe(listener),
    getSnapshot: () => {
      const all = store.getSnapshot()
      if (all !== seen) {
        const filtered: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(all)) if (key.startsWith(prefix)) filtered[key] = value
        seen = all
        mine = filtered
      }
      return mine
    },
  }
}

/**
 * Resolve a webview-relative path to its canonical form, or null for one
 * that cannot be trusted: empty, absolute (POSIX or drive-lettered),
 * backslashed, or climbing above the data root. `a/b/../c` resolves to
 * `a/c`; a `..` with nothing left to pop is an escape and refuses.
 */
function normalizeRelative(path: string): string | null {
  if (typeof path !== 'string' || path === '') return null
  if (path.includes('\\')) return null
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join('/')
}

/**
 * A capability's own view of the filesystem: every WRITE — writeFile,
 * remove, removeDir, rename, mkdir, appendFile — must resolve under
 * `<id>/**` (or name the `<id>` directory itself, which `mkdir` needs),
 * path-normalized first so `<id>/../books/x` is refused. Reads stay open:
 * the finding this closes is integrity — a buggy capability deleting or
 * overwriting kernel-owned files — and the one real consumer legitimately
 * reads `books/**` to digest it (phase 10, WI-10.3; the read tightening is
 * deferred, deliberately).
 *
 * Same enforcement class as `scopeSettings`: a wrapper the capability
 * cannot see behind. The kernel's own stores keep the raw handle; the only
 * `books/<id>/` delete a capability can still trigger is the closed-name
 * `removeBlob` primitive (WI-10.2). Wrappers are async so a refusal is a
 * REJECTION — the shape every fs caller already handles — not a sync throw.
 */
export function scopeFs(fs: KernelServices['fs'], capId: string): KernelServices['fs'] {
  if (fs === null) return null
  const prefix = `${capId}/`
  const guard = (op: string, path: string): string => {
    const normal = normalizeRelative(path)
    if (normal === null || (normal !== capId && !normal.startsWith(prefix))) {
      throw invalid('namespace', capId, `capability "${capId}" may only ${op} under "${prefix}", not ${JSON.stringify(path)}`)
    }
    return path
  }
  const scoped: NonNullable<KernelServices['fs']> = {
    readFile: async (path) => fs.readFile(path),
    readDir: async (path) => fs.readDir(path),
    exists: async (path) => fs.exists(path),
    writeFile: async (path, bytes) => fs.writeFile(guard('writeFile', path), bytes),
    mkdir: async (path) => fs.mkdir(guard('mkdir', path)),
    remove: async (path) => fs.remove(guard('remove', path)),
    removeDir: async (path) => fs.removeDir(guard('removeDir', path)),
    rename: async (from, to) => fs.rename(guard('rename', from), guard('rename', to)),
  }
  /* `appendFile` is a capability's cue that the platform appends natively
   * (the journal falls back to read-then-rewrite without it) — so it exists
   * on the wrapper exactly when it exists behind it. */
  const append = fs.appendFile
  return append ? { ...scoped, appendFile: async (path, bytes) => append.call(fs, guard('appendFile', path), bytes) } : scoped
}

/**
 * A capability's own view of the flat store: reads AND writes must name a
 * key under `<id>.` — strict on both sides, because no capability needs a
 * foreign key any more: the one read that did (the sync journal digesting
 * the kernel's cards) rides `services.cards.stored()` instead (WI-10.4).
 * `flush` passes through — it is "are the bytes down", not a key.
 */
export function scopeStorage(storage: KernelServices['storage'], capId: string): KernelServices['storage'] {
  if (storage === null) return null
  const prefix = `${capId}.`
  const guard = (op: string, key: string): string => {
    if (typeof key !== 'string' || !key.startsWith(prefix)) {
      throw invalid('namespace', capId, `capability "${capId}" may only ${op} keys under "${prefix}", not ${JSON.stringify(key)}`)
    }
    return key
  }
  const flush = storage.flush
  return {
    getItem: (key) => storage.getItem(guard('read', key)),
    setItem: (key, value) => storage.setItem(guard('write', key), value),
    ...(flush ? { flush: () => flush.call(storage) } : {}),
  }
}

/* ------------------------------------------------------------- pane ids */

/** The pane the kernel opens on when nothing better is known: `ui/state.ts`'s initial. */
export const KERNEL_DEFAULT_PANE: PaneId = 'companion'

/**
 * A pane id from anywhere — a remembered `lastPane`, a URL, a message —
 * resolved against what this composition has. The kernel's own panes are
 * always known; a contributed id is known when `known` lists it; anything
 * else, including an id from a capability that is no longer composed, is
 * `fallback`. So a persisted pane never opens the side pane onto nothing.
 */
export function resolvePaneId(id: unknown, known: Iterable<string>, fallback: PaneId = KERNEL_DEFAULT_PANE): PaneId {
  if (isKernelPaneId(id)) return id
  if (typeof id === 'string' && id.includes(':')) {
    for (const candidate of known) if (candidate === id) return id as ContributedPaneId
  }
  return fallback
}

/* ---------------------------------------------------------- validation */

function invalid(code: CapabilityErrorCode, capability: string | null, message: string): CapabilityError {
  return new CapabilityError(code, capability, message)
}

/** Ids: well-formed, not `kernel`, unique. First failure throws. */
function checkIds(caps: readonly Capability[]): void {
  const seen = new Set<string>()
  for (const cap of caps) {
    const id: unknown = cap.id
    if (typeof id !== 'string' || !CAPABILITY_ID.test(id)) {
      throw invalid('invalid-id', null, `capability id ${JSON.stringify(id)} does not match ${CAPABILITY_ID}`)
    }
    if (id === RESERVED_ID) throw invalid('reserved-id', id, `"${RESERVED_ID}" is not a capability id`)
    if (seen.has(id)) throw invalid('duplicate-id', id, `capability "${id}" is listed twice`)
    seen.add(id)
  }
}

/** `requires`: every id resolvable, and the graph acyclic (a self-reference is a cycle). */
function checkRequires(caps: readonly Capability[]): void {
  const ids = new Set(caps.map((cap) => cap.id))
  const edges = new Map<string, string[]>()
  for (const cap of caps) {
    const targets: string[] = []
    for (const need of cap.requires ?? []) {
      if (typeof need !== 'string' || !ids.has(need)) {
        throw invalid('missing-requires', cap.id, `capability "${cap.id}" requires ${JSON.stringify(need)}, which is not composed`)
      }
      targets.push(need)
    }
    edges.set(cap.id, targets)
  }
  for (const component of stronglyConnectedComponents([...ids], edges)) {
    const self = component.length === 1 && (edges.get(component[0] ?? '') ?? []).includes(component[0] ?? '')
    if (component.length < 2 && !self) continue
    throw invalid('cyclic-requires', null, `requires cycle among: ${[...component].sort().join(', ')}`)
  }
}

/**
 * Tarjan's algorithm, iterative — the same shape as the manifest validator's
 * (`scripts/lib/architecture.mjs`), for the same reason: recursion would
 * overflow on a long chain, and a registry that crashes on a legal set is
 * worse than one with a bug.
 */
function stronglyConnectedComponents(nodes: readonly string[], edges: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  const visit = (node: string) => {
    index.set(node, counter)
    low.set(node, counter)
    counter++
    stack.push(node)
    onStack.add(node)
  }

  for (const root of nodes) {
    if (index.has(root)) continue
    visit(root)
    const work: { node: string; next: number }[] = [{ node: root, next: 0 }]
    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: string; next: number }
      const successors = edges.get(frame.node) ?? []
      if (frame.next < successors.length) {
        const next = successors[frame.next++] as string
        if (!index.has(next)) {
          visit(next)
          work.push({ node: next, next: 0 })
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(next) ?? 0))
        }
        continue
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = []
        let member: string
        do {
          member = stack.pop() as string
          onStack.delete(member)
          component.push(member)
        } while (member !== frame.node)
        components.push(component)
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0))
    }
  }
  return components
}

/**
 * Registration order: topological by `requires`, ties by list position.
 * Kahn's algorithm, always taking the READY capability that comes first in
 * the list — which is what makes the answer deterministic and what makes a
 * reorder of the manifest a behaviour change. Assumes `checkRequires` ran.
 */
export function registrationOrder(caps: readonly Capability[]): string[] {
  const position = new Map(caps.map((cap, i) => [cap.id, i] as const))
  const pending = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const cap of caps) {
    const needs = [...new Set(cap.requires ?? [])]
    pending.set(cap.id, needs.length)
    for (const need of needs) {
      const list = dependents.get(need) ?? []
      list.push(cap.id)
      dependents.set(need, list)
    }
  }
  const order: string[] = []
  const ready = caps.filter((cap) => pending.get(cap.id) === 0).map((cap) => cap.id)
  while (ready.length > 0) {
    ready.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0))
    const next = ready.shift() as string
    order.push(next)
    for (const dependent of dependents.get(next) ?? []) {
      const left = (pending.get(dependent) ?? 0) - 1
      pending.set(dependent, left)
      if (left === 0) ready.push(dependent)
    }
  }
  if (order.length !== caps.length) throw invalid('cyclic-requires', null, 'requires graph has a cycle')
  return order
}

/**
 * Namespacing (ADR decision 5, widened to every registry): a pane, settings
 * section or book action id is `<id>:<name>`, a service or client name is
 * `<id>.<op>`, a grant starts with `<id>:`. And no two capabilities — nor one
 * capability twice — may register the same pane, section, action or service.
 * Commands are checked when they are built (`Composition.commands`), because
 * they are a function of the palette's context.
 */
function checkNamespaces(caps: readonly Capability[]): void {
  const panes = new Set<string>()
  const sections = new Set<string>()
  const actions = new Set<string>()
  const services = new Set<string>()
  const clients = new Set<string>()

  const claim = (set: Set<string>, kind: string, key: string, cap: string) => {
    if (set.has(key)) throw invalid('duplicate-contribution', cap, `${kind} "${key}" is registered twice`)
    set.add(key)
  }
  const prefixed = (kind: string, value: string, prefix: string, cap: string) => {
    if (typeof value !== 'string' || !value.startsWith(prefix) || value.length === prefix.length) {
      throw invalid('namespace', cap, `${kind} ${JSON.stringify(value)} of capability "${cap}" must be "${prefix}<name>"`)
    }
  }

  for (const cap of caps) {
    const colon = `${cap.id}:`
    const dot = `${cap.id}.`
    for (const pane of cap.panes ?? []) {
      prefixed('pane id', pane.id, colon, cap.id)
      if (!Array.isArray(pane.screens) || pane.screens.length === 0) {
        throw invalid('namespace', cap.id, `pane "${pane.id}" names no screen it fits`)
      }
      claim(panes, 'pane', pane.id, cap.id)
    }
    for (const section of cap.settings ?? []) {
      prefixed('settings section id', section.id, colon, cap.id)
      claim(sections, 'settings section', section.id, cap.id)
    }
    for (const action of cap.bookActions ?? []) {
      prefixed('book action id', action.id, colon, cap.id)
      claim(actions, 'book action', action.id, cap.id)
    }
    for (const service of cap.services ?? []) {
      prefixed('service name', service.name, dot, cap.id)
      prefixed('grant', service.grant, colon, cap.id)
      claim(services, 'service', service.name, cap.id)
    }
    for (const client of cap.clients ?? []) {
      prefixed('client name', client.name, dot, cap.id)
      claim(clients, 'client', client.name, cap.id)
    }
  }
}

/* --------------------------------------------------------- composition */

const NOTHING: Disposable = { dispose: () => {} }
const EMPTY_PANES: readonly PaneContribution[] = Object.freeze([])
const EMPTY_SECTIONS: readonly SettingsSection[] = Object.freeze([])
const EMPTY_ACTIONS: readonly BookAction[] = Object.freeze([])
const EMPTY_CLIENTS: readonly ClientContribution[] = Object.freeze([])
const EMPTY_SERVICES: ReadonlyMap<string, ServiceContribution> = new Map()

/** Panes across the composition: by `order` (unset last), then registration. */
function sortPanes(ordered: readonly Capability[]): readonly PaneContribution[] {
  const all = ordered.flatMap((cap) => cap.panes ?? [])
  return Object.freeze(
    all
      .map((pane, i) => ({ pane, i }))
      .sort((a, b) => (a.pane.order ?? Number.MAX_SAFE_INTEGER) - (b.pane.order ?? Number.MAX_SAFE_INTEGER) || a.i - b.i)
      .map(({ pane }) => pane),
  )
}

/** Dispose in reverse. Every one is tried; the errors come back. */
function disposeAll(started: readonly { id: string; disposable: Disposable }[]): { id: string; error: unknown }[] {
  const errors: { id: string; error: unknown }[] = []
  for (let i = started.length - 1; i >= 0; i--) {
    const { id, disposable } = started[i] as { id: string; disposable: Disposable }
    try {
      disposable.dispose()
    } catch (error) {
      errors.push({ id, error })
    }
  }
  return errors
}

/**
 * Validate, order, start, and hand back what was contributed.
 *
 * `signal` is the composition's lifetime: it is passed to every `start`, and
 * when it aborts the composition disposes itself. A signal already aborted
 * on entry starts nothing.
 */
export async function composeCapabilities(
  caps: readonly Capability[],
  api: KernelApi,
  signal: AbortSignal,
): Promise<Composition> {
  checkIds(caps)
  checkRequires(caps)
  checkNamespaces(caps)
  const order = registrationOrder(caps)
  const byId = new Map(caps.map((cap) => [cap.id, cap] as const))
  const ordered = order.map((id) => byId.get(id) as Capability)

  if (signal.aborted) throw invalid('aborted', null, 'composition aborted before any capability started')

  /* Snapshot every contribution BEFORE a single capability starts, from the
   * arrays `checkNamespaces` just validated. A `start` that mutates its own
   * `panes`/`services`/… array — pushing an unnamespaced or another
   * capability's name — therefore cannot reach the composition's registries:
   * they are frozen copies of the validated state, not live references. */
  const panes = sortPanes(ordered)
  const settings = Object.freeze(ordered.flatMap((cap) => [...(cap.settings ?? [])]))
  const bookActions = Object.freeze(ordered.flatMap((cap) => [...(cap.bookActions ?? [])]))
  const clients = Object.freeze(ordered.flatMap((cap) => [...(cap.clients ?? [])]))
  const services: ReadonlyMap<string, ServiceContribution> = new Map(
    ordered.flatMap((cap) => (cap.services ?? []).map((service) => [service.name, service] as const)),
  )
  const frozenOrder = Object.freeze([...order])
  let disposed = false

  const started: { id: string; disposable: Disposable }[] = []
  const rollback = (cause: unknown, id: string, why: string, extra: readonly unknown[] = []): never => {
    const failures = disposeAll(started)
    started.length = 0
    const errors = [...extra, ...failures.map((f) => f.error)]
    const message = `capability "${id}" ${why}; ${errors.length === 0 ? 'nothing stays registered' : `${errors.length} teardown(s) failed during rollback`}`
    throw new CapabilityError('start-failed', id, message, {
      cause: errors.length === 0 ? cause : new AggregateError(cause === undefined ? errors : [cause, ...errors], message),
    })
  }

  for (const cap of ordered) {
    if (signal.aborted) rollback(undefined, cap.id, 'was not started: the composition was aborted')
    /* This capability's disposer stack: each resource it acquires registers
     * its own teardown through `onCleanup`. Run in reverse, it undoes a
     * half-finished `start` (so a throw leaves nothing) and, harmlessly
     * again, folds into normal dispose. This is what makes `start` atomic. */
    const cleanups: (() => void)[] = []
    const unwind = (): unknown[] => {
      const errors: unknown[] = []
      for (let i = cleanups.length - 1; i >= 0; i--) {
        try {
          ;(cleanups[i] as () => void)()
        } catch (error) {
          errors.push(error)
        }
      }
      cleanups.length = 0
      return errors
    }
    const ctx: CapabilityContext = {
      ...api,
      /* The services A CAPABILITY sees: the kernel's own stores, with every
       * tree-wide handle swapped for a namespace-confined wrapper — the
       * filesystem (WI-10.3), the flat store (WI-10.4), and the settings
       * store, which `ctx.settings` already scoped but which also rides the
       * services and must not arrive raw by that door. The kernel keeps the
       * raw handles; only what is HANDED OUT is confined. */
      services: {
        ...api.services,
        settings: scopeSettings(api.services.settings, cap.id),
        fs: scopeFs(api.services.fs, cap.id),
        storage: scopeStorage(api.services.storage, cap.id),
      },
      settings: scopeSettings(api.settings, cap.id),
      diagnostics: api.diagnostics.child(cap.id),
      onCleanup: (dispose) => {
        cleanups.push(dispose)
      },
    }
    let disposable: Disposable | undefined
    try {
      disposable = cap.start ? await cap.start(ctx, signal) : NOTHING
    } catch (cause) {
      rollback(cause, cap.id, 'failed to start', unwind())
    }
    /* The property READ is inside the guard too: `dispose` could be a
     * getter, and a getter that throws here must roll back like any other
     * misbehaving start, not escape past the started list. */
    let disposeFn: unknown
    try {
      disposeFn = disposable?.dispose
    } catch (cause) {
      rollback(cause, cap.id, 'has a Disposable whose dispose cannot be read', unwind())
    }
    if (typeof disposeFn !== 'function') {
      rollback(undefined, cap.id, 'returned no Disposable from start', unwind())
    }
    /* Fold the disposer stack into teardown: the returned `Disposable`, then
     * the registered cleanups in reverse. Both run on normal dispose. */
    const returned = disposable as Disposable
    /* Wrapped even when the stack is empty NOW: `onCleanup` may legally be
     * called later (a resource acquired lazily after start), and the wrapper
     * is what guarantees those registrations still run at dispose. */
    const disposeCap: Disposable = {
            dispose: () => {
              /* Every failure is REPORTED, not just the first: the returned
               * Disposable's throw must not eat the cleanups' errors, nor
               * the other way round — `dispose` documents an AggregateError
               * carrying all of them. */
              const errors: unknown[] = []
              try {
                returned.dispose()
              } catch (error) {
                errors.push(error)
              }
              errors.push(...unwind())
              if (errors.length === 1) throw errors[0]
              if (errors.length > 1) throw new AggregateError(errors, `capability "${cap.id}" teardown failed`)
            },
          }
    started.push({ id: cap.id, disposable: disposeCap })
    /* The signal may have aborted WHILE this `start` was awaiting. This
     * capability is fully started, but the composition's lifetime is over —
     * unwind everything (including this one) rather than hand back a
     * live-looking composition whose abort has already fired. */
    if (signal.aborted) rollback(undefined, cap.id, 'was aborted while starting')
  }

  /* Every capability has started, so every delegating service handler's target
   * is ready: serve the composed services through the bound host (the peer
   * transport on a shelf; a no-op with no host bound — a satchel, a browser
   * tab, a test). Best-effort — replication is the spine, services enhance it,
   * so a serve that fails degrades visibly rather than failing the boot. */
  let servingDisposer: Disposable = NOTHING
  try {
    servingDisposer = await api.services.serveServices([...services.values()])
  } catch (error) {
    api.diagnostics.error('composition.serve-failed', { message: error instanceof Error ? error.message : String(error) })
  }

  const composition: Composition = {
    order: frozenOrder,
    get panes() {
      return disposed ? EMPTY_PANES : panes
    },
    commands(ctx) {
      if (disposed) return []
      const out: Command[] = []
      const seen = new Set<string>()
      for (const cap of ordered) {
        for (const command of cap.commands?.(ctx) ?? []) {
          if (!command.id.startsWith(`${cap.id}:`) || command.id.length === cap.id.length + 1) {
            throw invalid('namespace', cap.id, `command id ${JSON.stringify(command.id)} of capability "${cap.id}" must be "${cap.id}:<name>"`)
          }
          if (seen.has(command.id)) {
            throw invalid('duplicate-contribution', cap.id, `command id ${JSON.stringify(command.id)} is registered twice`)
          }
          seen.add(command.id)
          out.push(command)
        }
      }
      return out
    },
    get settings() {
      return disposed ? EMPTY_SECTIONS : settings
    },
    get bookActions() {
      return disposed ? EMPTY_ACTIONS : bookActions
    },
    get services() {
      return disposed ? EMPTY_SERVICES : services
    },
    get clients() {
      return disposed ? EMPTY_CLIENTS : clients
    },
    dispose() {
      if (disposed) return
      disposed = true
      /* Direct dispose retires the lifetime listener too, so a long-lived
       * signal stops retaining this composition and its capabilities. */
      signal.removeEventListener('abort', onAbort)
      /* Unserve the composed services before the capabilities behind their
       * handlers tear down, so no request lands on a half-disposed handler. */
      try {
        servingDisposer.dispose()
      } catch (error) {
        api.diagnostics.error('composition.unserve-failed', { message: error instanceof Error ? error.message : String(error) })
      }
      const failures = disposeAll(started)
      started.length = 0
      api.diagnostics.info('composition.disposed', { order: frozenOrder })
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((f) => f.error),
          `${failures.length} capability dispose(s) failed: ${failures.map((f) => f.id).join(', ')}`,
        )
      }
    },
  }

  /* An abort listener has nobody to throw to, so a dispose that fails here
   * is reported rather than raised. `dispose()` called directly still throws
   * — and detaches this listener, so it is named rather than anonymous. */
  const onAbort = (): void => {
    try {
      composition.dispose()
    } catch (error) {
      api.diagnostics.error('composition.dispose-failed', { message: error instanceof Error ? error.message : String(error) })
    }
  }
  signal.addEventListener('abort', onAbort, { once: true })
  /* The signal may have aborted WHILE the services were being served — after
   * the start-loop's last check, before this listener existed. An 'abort'
   * that has already fired never reaches a newly added listener, so ask once,
   * now: a composition whose lifetime is over is disposed and refused, never
   * returned looking alive. */
  if (signal.aborted) {
    onAbort()
    throw invalid('aborted', null, 'composition aborted while its services were being served')
  }
  api.diagnostics.info('composition.started', { order: frozenOrder })
  return composition
}
