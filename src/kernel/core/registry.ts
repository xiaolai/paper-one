import type {
  BookAction,
  Capability,
  ClientContribution,
  Command,
  CommandContext,
  Disposable,
  KernelApi,
  PaneContribution,
  ServiceContribution,
  SettingsSection,
} from './capability'
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
    for (const client of cap.clients ?? []) prefixed('client name', client.name, dot, cap.id)
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

  const started: { id: string; disposable: Disposable }[] = []
  const rollback = (cause: unknown, id: string, why: string): never => {
    const failures = disposeAll(started)
    started.length = 0
    const message = `capability "${id}" ${why}; ${failures.length === 0 ? 'nothing stays registered' : `and ${failures.length} dispose(s) failed during rollback`}`
    throw new CapabilityError('start-failed', id, message, {
      cause: failures.length === 0 ? cause : new AggregateError([cause, ...failures.map((f) => f.error)], message),
    })
  }

  for (const cap of ordered) {
    if (signal.aborted) rollback(undefined, cap.id, 'was not started: the composition was aborted')
    let disposable: Disposable | undefined
    try {
      disposable = cap.start ? await cap.start({ ...api, diagnostics: api.diagnostics.child(cap.id) }, signal) : NOTHING
    } catch (cause) {
      rollback(cause, cap.id, 'failed to start')
    }
    if (typeof disposable?.dispose !== 'function') {
      rollback(undefined, cap.id, 'returned no Disposable from start')
    }
    started.push({ id: cap.id, disposable: disposable as Disposable })
  }

  const panes = sortPanes(ordered)
  const settings = Object.freeze(ordered.flatMap((cap) => cap.settings ?? []))
  const bookActions = Object.freeze(ordered.flatMap((cap) => cap.bookActions ?? []))
  const clients = Object.freeze(ordered.flatMap((cap) => cap.clients ?? []))
  const services: ReadonlyMap<string, ServiceContribution> = new Map(
    ordered.flatMap((cap) => (cap.services ?? []).map((service) => [service.name, service] as const)),
  )
  const frozenOrder = Object.freeze([...order])
  let disposed = false

  const composition: Composition = {
    order: frozenOrder,
    get panes() {
      return disposed ? EMPTY_PANES : panes
    },
    commands(ctx) {
      if (disposed) return []
      const out: Command[] = []
      for (const cap of ordered) {
        for (const command of cap.commands?.(ctx) ?? []) {
          if (!command.id.startsWith(`${cap.id}:`) || command.id.length === cap.id.length + 1) {
            throw invalid('namespace', cap.id, `command id ${JSON.stringify(command.id)} of capability "${cap.id}" must be "${cap.id}:<name>"`)
          }
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
   * is reported rather than raised. `dispose()` called directly still throws. */
  signal.addEventListener(
    'abort',
    () => {
      try {
        composition.dispose()
      } catch (error) {
        api.diagnostics.error('composition.dispose-failed', { message: error instanceof Error ? error.message : String(error) })
      }
    },
    { once: true },
  )
  api.diagnostics.info('composition.started', { order: frozenOrder })
  return composition
}
