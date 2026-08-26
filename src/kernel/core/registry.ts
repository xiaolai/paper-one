import type {
  BookStatus,
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
/**
 * PRIVATE, and a function is published instead of it.
 *
 * A `RegExp` is a mutable object. Exported, any module loaded before
 * composition could replace its `.test` or call `.compile()` and widen what
 * counts as a capability id — admitting path or namespace syntax the
 * validator exists to reject, and doing it from outside the kernel with no
 * trace at the call site. `isCapabilityId` closes over this one and cannot be
 * redefined by a consumer.
 */
const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** Whether `value` is a well-formed capability id. */
export function isCapabilityId(value: unknown): value is string {
  return typeof value === 'string' && CAPABILITY_ID_PATTERN.test(value)
}
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
  readonly bookStatuses: readonly BookStatus[]
  /** By service name. */
  readonly services: ReadonlyMap<string, ServiceContribution>
  readonly clients: readonly ClientContribution[]
}

/** A capability that did not compose — see `Composition.failures`. */
export interface CapabilityFailure {
  readonly id: string
  /** `start-failed`, or `requires-failed` when a dependency did not compose. */
  readonly kind: 'start-failed' | 'requires-failed'
  readonly error: unknown
  /** The dependency at fault, for `requires-failed`. */
  readonly because?: string
}

export interface Composition extends Contributions, Disposable {
  /** Capability ids in registration order — those that STARTED. */
  readonly order: readonly string[]
  /**
   * What did not compose, and why. Empty is the ordinary case.
   *
   * A capability's `start` does I/O — the sync journal opens a file — so it
   * can fail for reasons that are not build defects: a damaged file, a full
   * disk, a permission that changed. Those no longer take the app down (ADR
   * 0001, Decision 9); the capability is left out, everything else composes,
   * and this is the record the UI reads to say so. `reason` is the id it
   * depended on when a capability was skipped because a dependency failed.
   */
  readonly failures: readonly CapabilityFailure[]
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
    /* PASSED THROUGH, not re-derived: whether the next launch keeps anything is
     * a property of the one storage underneath, and a capability drawing "not
     * saved on this device" should say it exactly when the kernel's own pane
     * does. A getter rather than a captured value, because it changes the first
     * time a write is refused. */
    get persistent() {
      return store.persistent
    },
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
    if (!isCapabilityId(id)) {
      throw invalid('invalid-id', null, `capability id ${JSON.stringify(id)} does not match ${CAPABILITY_ID_PATTERN}`)
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
function checkNamespaces(
  caps: readonly Capability[],
  kernelServices: readonly ServiceContribution[] = [],
  kernelClients: readonly ClientContribution[] = [],
): void {
  const panes = new Set<string>()
  const sections = new Set<string>()
  const actions = new Set<string>()
  /* ITS OWN SET. Statuses used to claim into `actions`, so a capability whose
     action and status shared one natural name — `sync:download` for the verb
     and for the progress it reports — was refused as a duplicate
     contribution. They are different contributions in different lists, read
     by different code; only the namespace prefix is shared. */
  const statuses = new Set<string>()
  const services = new Set<string>()
  const clients = new Set<string>()

  /* THE KERNEL'S OWN SERVICES CLAIM THEIR NAMES FIRST (phase 11). The service
   * table publishes `<noun>.<verb>` — `book.list`, `shelf.status` — which is
   * NOT a capability's `<id>.<op>` and so is not subject to the prefix rule
   * below. What it is subject to is uniqueness: two handlers under one name
   * is exactly the collision the router refuses at construction, and finding
   * it here means finding it BEFORE a single capability has started rather
   * than after all of them have. */
  for (const service of kernelServices) {
    if (services.has(service.name)) {
      throw invalid('duplicate-contribution', null, `service "${service.name}" is registered twice by the kernel`)
    }
    services.add(service.name)
  }
  /* The same for the CLIENT stubs the kernel declares — the satchel side of
   * the same table. A capability's client name must be `<id>.<op>` and the
   * table's is `<noun>.<verb>`, so the two sets cannot collide by accident;
   * what this refuses is the kernel declaring one name twice. */
  for (const client of kernelClients) {
    if (clients.has(client.name)) {
      throw invalid('duplicate-contribution', null, `client "${client.name}" is registered twice by the kernel`)
    }
    clients.add(client.name)
  }

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
    for (const status of cap.bookStatuses ?? []) {
      prefixed('book status id', status.id, colon, cap.id)
      claim(statuses, 'book status', status.id, cap.id)
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
const EMPTY_STATUSES: readonly BookStatus[] = Object.freeze([])
const EMPTY_CLIENTS: readonly ClientContribution[] = Object.freeze([])
const EMPTY_SERVICES: ReadonlyMap<string, ServiceContribution> = new Map()

/**
 * A contributed list, arranged: by `order` (unset last), then registration.
 *
 * ONE HELPER FOR EVERY SUCH LIST. It was `sortPanes`, and the settings
 * sections went unsorted beside it — so the panel's running order fell out of
 * the start order, which is TOPOLOGICAL BY `requires`. Devices sat above
 * Storage because sync depends on peer, and for no other reason: a capability
 * gaining a dependency would have reordered a panel nobody had touched.
 *
 * Stability is load-bearing rather than incidental. `sort` is stable in every
 * engine this runs on, and the index tiebreak makes it so regardless — an
 * unordered contribution has to stay exactly where registration put it, or
 * declaring nothing would mean something different on each build.
 */
function byOrder<T extends { readonly order?: number }>(all: readonly T[]): readonly T[] {
  return Object.freeze(
    all
      .map((one, at) => ({ one, at }))
      .sort(
        (a, b) =>
          (a.one.order ?? Number.MAX_SAFE_INTEGER) - (b.one.order ?? Number.MAX_SAFE_INTEGER) ||
          a.at - b.at,
      )
      .map(({ one }) => one),
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

/** What a composition root may hand the registry beside the capabilities. */
export interface CompositionOptions {
  /**
   * The KERNEL'S OWN services — the service table's handlers (phase 11).
   *
   * They are served through the same host, under the same grant check and in
   * the same map as a capability's, because a caller must not be able to tell
   * which side of the line a service came from. They are not a capability's
   * contribution, so they carry no `<id>.` prefix and answer to no `requires`;
   * what they do carry is a name that must be unique across both sets, which
   * `checkNamespaces` settles before anything starts.
   *
   * Absent, the composition serves exactly what the capabilities contributed
   * — which is what every composition did before this existed, and what a
   * test composing one capability still wants.
   */
  readonly services?: readonly ServiceContribution[]
  /**
   * The kernel's CLIENT stubs — the satchel side of the same table, derived
   * from it by `serviceClients()`.
   *
   * `ClientContribution`'s own comment called itself "a stub shape until a
   * consumer lands", and phase 11 is that consumer: `paper --shelf <key>`
   * calls exactly these names on a shelf. They cannot be a capability's,
   * because a capability's client name must be `<id>.<op>` and the table's
   * is `<noun>.<verb>` — so they arrive here, beside the services, or not at
   * all.
   *
   * NOTHING READS `Composition.clients` TODAY, and that is worth saying
   * rather than leaving to be discovered: the list is a DECLARATION of what
   * this composition may call on a shelf, checked for duplicates and
   * otherwise inert. It becomes load-bearing the day something narrows a
   * connection to what its side actually calls.
   */
  readonly clients?: readonly ClientContribution[]
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
  options: CompositionOptions = {},
): Promise<Composition> {
  /* COPIED AND FROZEN on entry, like every capability's own contribution
   * arrays below. `checkNamespaces` validates these and the registries are
   * built from them, so a caller that kept a reference and pushed into it
   * during an awaited `start` would otherwise land a name nothing checked. */
  const kernelServices: readonly ServiceContribution[] = Object.freeze([...(options.services ?? [])])
  const kernelClients: readonly ClientContribution[] = Object.freeze([...(options.clients ?? [])])
  checkIds(caps)
  checkRequires(caps)
  checkNamespaces(caps, kernelServices, kernelClients)
  const order = registrationOrder(caps)
  const byId = new Map(caps.map((cap) => [cap.id, cap] as const))
  const ordered = order.map((id) => byId.get(id) as Capability)

  if (signal.aborted) throw invalid('aborted', null, 'composition aborted before any capability started')

  /* Snapshot every contribution BEFORE a single capability starts, from the
   * arrays `checkNamespaces` just validated. A `start` that mutates its own
   * `panes`/`services`/… array — pushing an unnamespaced or another
   * capability's name — therefore cannot reach the composition's registries:
   * they are frozen copies of the validated state, not live references.
   *
   * KEPT PER CAPABILITY, because a capability that fails to start contributes
   * nothing (Decision 9) and the registries are filtered to what started —
   * filtered from THESE copies, so taking the snapshot early still holds. */
  const snapshot = ordered.map((cap) =>
    Object.freeze({
      id: cap.id,
      panes: Object.freeze([...(cap.panes ?? [])]),
      settings: Object.freeze([...(cap.settings ?? [])]),
      bookActions: Object.freeze([...(cap.bookActions ?? [])]),
      bookStatuses: Object.freeze([...(cap.bookStatuses ?? [])]),
      clients: Object.freeze([...(cap.clients ?? [])]),
      services: Object.freeze([...(cap.services ?? [])]),
    }),
  )
  let disposed = false
  const failures: CapabilityFailure[] = []
  const failed = new Set<string>()

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

  /**
   * Leave one capability out, keeping the rest — ADR 0001 Decision 9.
   *
   * A `start` that throws has already been unwound by `unwind()`, so nothing
   * it acquired is still held. The composition continues without it: the
   * kernel's ports keep their no-op defaults, which is the same shape a build
   * that never composed the capability has — and that shape is exercised by
   * `pnpm verify:without`. Dying instead put the app in a state nothing tests.
   */
  const skip = (id: string, kind: CapabilityFailure['kind'], error: unknown, because?: string): void => {
    failed.add(id)
    failures.push(Object.freeze({ id, kind, error, ...(because === undefined ? {} : { because }) }))
    api.diagnostics.error('composition.capability-failed', {
      capability: id,
      kind,
      ...(because === undefined ? {} : { because }),
      message: error instanceof Error ? error.message : String(error),
    })
  }

  for (const cap of ordered) {
    if (signal.aborted) rollback(undefined, cap.id, 'was not started: the composition was aborted')
    /* A DEPENDENCY THAT DID NOT COMPOSE TAKES ITS DEPENDANTS WITH IT. `requires`
     * is a declared need, not a preference: `sync` reaches the peer transport
     * through `peer`, so starting it without one would fail later, further from
     * the cause. Registration order is topological, so a dependency has always
     * been decided by the time this runs. */
    const missing = (cap.requires ?? []).find((id) => failed.has(id))
    if (missing !== undefined) {
      skip(cap.id, 'requires-failed', new Error(`capability "${cap.id}" requires "${missing}", which did not compose`), missing)
      continue
    }
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
      /* The teardown errors are folded into the recorded failure rather than
       * dropped: a `start` that failed AND could not clean up after itself is
       * two facts, and the second one is how a leak gets noticed. */
      const errors = unwind()
      skip(cap.id, 'start-failed', errors.length === 0 ? cause : new AggregateError([cause, ...errors], `capability "${cap.id}" failed to start`))
      continue
    }
    /* The property READ is inside the guard too: `dispose` could be a
     * getter, and a getter that throws here must be treated like any other
     * misbehaving start, not escape past the started list.
     *
     * A MISSING OR UNREADABLE `Disposable` IS STILL A BUILD DEFECT — it is
     * the capability's shape being wrong, not its environment — but it is
     * reported the same way rather than killing the app, because the reader
     * cannot act on either and a dead window says less than a working app
     * with one capability missing. `pnpm verify` is where this stays fatal. */
    let disposeFn: unknown
    try {
      disposeFn = disposable?.dispose
    } catch (cause) {
      const errors = unwind()
      skip(cap.id, 'start-failed', errors.length === 0 ? cause : new AggregateError([cause, ...errors], `capability "${cap.id}" has a Disposable whose dispose cannot be read`))
      continue
    }
    if (typeof disposeFn !== 'function') {
      const errors = unwind()
      const cause = new Error(`capability "${cap.id}" returned no Disposable from start`)
      skip(cap.id, 'start-failed', errors.length === 0 ? cause : new AggregateError([cause, ...errors], cause.message))
      continue
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

  /* THE REGISTRIES ARE WHAT STARTED, from the pre-start snapshot. A capability
   * that did not compose contributes nothing — no pane, no settings section,
   * no service, no book action — so the reader is never offered a surface
   * backed by something that is not running. `order` is the started set too,
   * because it is what "registration order" now means. */
  const live = new Set(started.map((one) => one.id))
  const startedOrdered = ordered.filter((cap) => live.has(cap.id))
  const kept = snapshot.filter((one) => live.has(one.id))
  const panes = byOrder(kept.flatMap((one) => [...one.panes]))
  const settings = byOrder(kept.flatMap((one) => [...one.settings]))
  const bookActions = Object.freeze(kept.flatMap((one) => [...one.bookActions]))
  const bookStatuses = Object.freeze(kept.flatMap((one) => [...one.bookStatuses]))
  const clients = Object.freeze([...kernelClients, ...kept.flatMap((one) => [...one.clients])])
  /* The kernel's own services first, then the capabilities' — one map, one
   * router registration, one grant check. `checkNamespaces` already refused a
   * collision between the two, so neither can quietly overwrite the other
   * here. */
  const services: ReadonlyMap<string, ServiceContribution> = new Map([
    ...kernelServices.map((service) => [service.name, service] as const),
    ...kept.flatMap((one) => one.services.map((service) => [service.name, service] as const)),
  ])
  const frozenOrder = Object.freeze(startedOrdered.map((cap) => cap.id))
  const frozenFailures = Object.freeze([...failures])

  /* Every capability that composed has started, so every delegating service
   * handler's target is ready: serve the composed services through the bound host (the peer
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
    failures: frozenFailures,
    get panes() {
      return disposed ? EMPTY_PANES : panes
    },
    commands(ctx) {
      if (disposed) return []
      const out: Command[] = []
      const seen = new Set<string>()
      for (const cap of startedOrdered) {
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
    get bookStatuses() {
      return disposed ? EMPTY_STATUSES : bookStatuses
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
