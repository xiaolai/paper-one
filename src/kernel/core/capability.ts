import type { IndexedBook } from './bookIndex'
import type { Diagnostics, SettingsStore } from './ports'
import type { KernelServices } from './services'
import type { ContributedPaneId, PaneId, Screen } from './uiTypes'

/**
 * The contribution API — what a capability IS to the kernel.
 *
 * A capability is a value of `Capability`: an id, the ids of the capabilities
 * it needs, and the things it puts into the kernel's registries — panes,
 * commands, settings sections, book actions, services on the peer envelope,
 * clients of them — plus one `start`, run once when the composition boots,
 * whose `Disposable` is how everything it began is taken down again. The
 * registry (`registry.ts`) validates a set of these, orders them, starts them
 * and hands the UI what they contributed; nothing here runs on its own.
 *
 * Deliberately small (mobile-sync plan I.2): a field enters when the first
 * real consumer needs it. Mark layers, file kinds, journal kinds and reader
 * event hooks are not here yet.
 *
 * NOTHING REACT. This file is reached through the kernel's public entry,
 * which is the only kernel surface a capability may import and which carries
 * no React (see `../index.ts`). A pane's `render` therefore returns an OPAQUE
 * value — see `PaneRenderer` — and the kernel's UI is what interprets it.
 */

/** Something that can be taken down. `dispose` must be safe to call twice. */
export interface Disposable {
  dispose(): void
}

/**
 * What a capability's `start` receives: the kernel's services, the settings
 * store and a `Diagnostics` ALREADY SCOPED to the capability's id (its lines
 * carry `<id>`; the kernel's carry `kernel`). Everything a capability does to
 * the reader's data goes through `services`.
 */
export interface KernelApi {
  readonly services: KernelServices
  readonly settings: SettingsStore
  readonly diagnostics: Diagnostics
}

/**
 * What a capability's `start` actually receives: the `KernelApi` plus
 * `onCleanup`, the kernel's disposer stack for THIS capability.
 *
 * A resource acquired during `start` — a listener, a timer, a bound port —
 * is registered with `onCleanup` the moment it is taken. If `start` then
 * throws, the kernel runs the stack in reverse (most recent first) so a
 * half-finished `start` leaves nothing behind; on a `start` that succeeds
 * the same cleanups run at dispose, after the returned `Disposable`. This is
 * what MAKES the atomicity guarantee below real, rather than a promise every
 * capability has to keep by hand and the kernel cannot enforce.
 */
export interface CapabilityContext extends KernelApi {
  onCleanup(dispose: () => void): void
}

/**
 * The opaque render handle for a pane or a settings section.
 *
 * `() => unknown` and not `() => ReactNode`, on purpose: this type has to be
 * importable through the React-free public entry, because a capability
 * writes its `panes` against it, and it is the least a React-free type can
 * say about a value React will draw. The UI layer narrows it
 * (`ui/panes.ts`, `renderContribution`) — and refuses, by name, a value that
 * is not something React can show — so the loss of typing here is paid back
 * at the one place the value is used.
 */
export type PaneRenderer = () => unknown

/**
 * A pane in the side pane, contributed by a capability.
 *
 * `id` is `<capability>:<name>` — the registry refuses anything else, so a
 * pane's id says who owns it and cannot collide with a kernel pane, none of
 * which has a colon. `screens` says where the pane fits (the kernel's own
 * fitting rule, `paneFits`, reads it); ⌘1…5 stay on kernel panes. `order`
 * sorts contributed panes among themselves — lower first, unset last, ties by
 * registration order.
 */
export interface PaneContribution {
  readonly id: ContributedPaneId
  readonly label: string
  readonly screens: readonly Screen[]
  readonly order?: number
  readonly render: PaneRenderer
}

/**
 * Everything the command palette can do, as data — the kernel's own commands
 * are the same shape (`ui/commands.ts` builds them, and re-exports this).
 */
export interface Command {
  /** Stable across renders — the palette keys and remembers rows by it. */
  readonly id: string
  readonly label: string
  /** The group heading in the palette. */
  readonly group: string
  /** §11 combo, displayed as written in the design's keyboard map. */
  readonly combo?: string
  /** Extra words to match on that are not in the label. */
  readonly keywords?: string
  /** True when this command names a state that is currently on. */
  readonly on?: boolean
  readonly run: () => void
}

/**
 * What a capability's `commands` may read and do — the part of the kernel's
 * own command context that is not React and not the kernel's business alone.
 * Built by the kernel from the same state its own commands are built from,
 * every time the palette is rebuilt, so `on` and labels reflect what is true.
 */
export interface CommandContext {
  readonly screen: Screen
  /** The open panel, or null when the pane is shut. */
  readonly pane: PaneId | null
  /** False when the reader has no book open. */
  readonly hasBook: boolean
  /** Open the side pane on a panel — a capability's own, usually. */
  openPane(pane: PaneId): void
}

/**
 * A section the kernel's Settings pane renders under the capability's title.
 * Values live in the typed `SettingsStore` under `<capability>.<name>`.
 */
export interface SettingsSection {
  readonly id: `${string}:${string}`
  readonly title: string
  /**
   * Where this section sits in the panel. Lower first; unset last; ties keep
   * registration order. The same rule and the same field as
   * `PaneContribution.order`, arranged by the same helper, because two ways to
   * order a contributed list is one way too many.
   *
   * IT HAS TO BE DECLARED, and the reason is not preference. Without it the
   * panel's running order fell out of `composeCapabilities`, which is
   * TOPOLOGICAL BY `requires` — so Devices came before Storage because sync
   * depends on peer, and nothing else. A capability that gained a dependency
   * would have silently moved somebody else's settings section, and no test
   * anywhere would have said so.
   */
  readonly order?: number
  readonly render: PaneRenderer
}

/** An action on one book — Download, Evict, Ask, Share… */
/**
 * The icons a contributed action may ask for.
 *
 * Named for the DRAWING, not for the deed — `circle-minus`, not `evict` — so
 * the vocabulary belongs to the design system rather than to whichever
 * capability asked first. The UI layer holds a `Record<ActionIcon, …>`, so a
 * name with no artwork is a compile error and artwork with no name is
 * unreachable: one list, checked, in the way `HANDLERS` is checked against
 * the service table.
 */
export const ACTION_ICONS = ['download', 'circle-minus'] as const

export type ActionIcon = (typeof ACTION_ICONS)[number]

/**
 * A capability's transient word about ONE book, drawn on its shelf row.
 *
 * THE SIBLING OF `BookAction`, and it exists for the half that one cannot do.
 * A capability can already put "Download" in a book's menu; it had no way to
 * say that the download is HAPPENING. Sync's answer was a list of rows in
 * Settings reading "Transfer 1 — done": history, in the wrong place, naming a
 * counter no reader can attribute to a book. Progress belongs where the action
 * was taken, and the kernel owns that row.
 *
 * PULLED, NOT PUSHED, and subscribed rather than polled. The kernel asks `of`
 * during render and re-asks when `subscribe` fires — so the capability keeps
 * its own state in its own store and the kernel keeps no per-book cache to go
 * stale. `of` must be cheap and synchronous: it runs once per visible row.
 *
 * NULL IS THE COMMON ANSWER and must stay cheap — a shelf of 1,962 books asks
 * this for every row it draws, and all but the one downloading say no.
 *
 * The kernel draws it, so a capability cannot invent a colour or a shape here
 * any more than `BookAction` can supply artwork. `fraction` is offered when
 * the work has a known size; without it the row shows the label alone, which
 * is what an indeterminate wait honestly looks like.
 */
export interface BookStatus {
  readonly id: `${string}:${string}`
  /** Fires when any book's answer may have changed. */
  subscribe(listener: () => void): () => void
  /** What to say about this book right now, or null for the usual nothing. */
  of(book: IndexedBook): { readonly label: string; readonly fraction?: number } | null
}

export interface BookAction {
  readonly id: `${string}:${string}`
  readonly label: string
  /**
   * Whether the action applies to THIS book — "Download" on a book whose
   * bytes are here would be a lie in a menu. Absent means always. Judged at
   * render, against the shelf row, by the kernel's book menu.
   */
  readonly when?: (book: IndexedBook) => boolean
  /**
   * Whether running this would bring the book's CONTENT to this device.
   *
   * Declared for the same reason `icon` is named rather than supplied: only
   * the capability knows that Download brings bytes here and Evict frees
   * them. The kernel needs the fact for one sentence it has to get right —
   * the tooltip on a book it cannot open, which prescribes a remedy. That
   * message said "add the file again" unconditionally, so a satchel showed a
   * reader the wrong instruction on every metadata-only row while offering
   * the right one, Download, in the same row's menu.
   *
   * NOT INFERRED FROM `icon: 'download'`. Artwork is a rendering choice and
   * a future action could wear that glyph without fetching anything; a fact
   * the kernel makes decisions on has to be stated.
   */
  readonly fetchesContent?: boolean
  /**
   * The icon drawn before the label — NAMED, not supplied.
   *
   * THE CAPABILITY CHOOSES WHICH, THE KERNEL OWNS THE ARTWORK. That split is
   * the answer to the reasoning this field replaced ("a contribution carries
   * a label, not artwork, and a wrong icon says more than none"): the wrong
   * icon is what the kernel would have to GUESS, because only the capability
   * knows that Download brings bytes here and Evict frees them without
   * touching the shelf. Naming moves the choice to the side that can make it
   * while leaving the drawing — and §08's one stroke weight, never filled —
   * with the side that owns the design system.
   *
   * A NAME AND NOT A COMPONENT, for a reason measured rather than assumed: a
   * capability's index is imported by `paper`, a Node process with no DOM, and
   * a React icon at the top of that module put `lucide-react` into the CLI
   * bundle. `build-cli.test.mjs` caught it — the bundle must import `node:`
   * builtins and nothing else.
   *
   * Optional, and a row without one still aligns: the kernel draws an
   * icon-sized gap in its place.
   */
  readonly icon?: ActionIcon
  /**
   * The kernel's menu does NOT await this and attaches no rejection
   * handler: an async action owns its own failures — catch, and speak
   * through your capability's own surface (a status store, a pane), or the
   * rejection is unhandled. The sync actions are the pattern.
   */
  run(bookId: string): void | Promise<void>
}

/**
 * What a service handler receives beside the request body: which peer is
 * asking, a signal that aborts on `cancel`, timeout or disconnect, and the
 * frames the peer streams in after the request (`stream` … `end`).
 */
export interface ServiceContext {
  readonly peer: string
  readonly signal: AbortSignal
  readonly input: AsyncIterable<unknown>
}

/**
 * The shape a service answers in: one value (`Promise`) or many (`AsyncIterable`,
 * sent as `stream` frames then `end`). A thrown `ServiceError` reaches the
 * peer as an `err` frame; anything else thrown reaches it as `internal`.
 */
export type ServiceHandler = (req: unknown, ctx: ServiceContext) => Promise<unknown> | AsyncIterable<unknown>

/**
 * A shelf-side handler on the peer envelope. `name` is `<capability>.<op>`
 * and `grant` starts with `<capability>:` — the registry refuses both
 * otherwise (ADR decision 5). The grant is checked against the peer's
 * persisted grants BEFORE the handler sees a byte.
 */
export interface ServiceContribution {
  readonly name: `${string}.${string}`
  readonly grant: string
  readonly handler: ServiceHandler
}

/** A satchel-side client of a service. A stub shape until a consumer lands. */
export interface ClientContribution {
  readonly name: `${string}.${string}`
}

export interface Capability {
  /** `^[a-z][a-z0-9-]*$`, unique across the composition, never `kernel`. */
  readonly id: string
  /** Ids of the capabilities this one needs; absent means none. */
  readonly requires?: readonly string[]
  readonly panes?: readonly PaneContribution[]
  readonly commands?: (ctx: CommandContext) => Command[]
  readonly settings?: readonly SettingsSection[]
  readonly bookActions?: readonly BookAction[]
  /** Transient per-book state drawn on the shelf row — see `BookStatus`. */
  readonly bookStatuses?: readonly BookStatus[]
  readonly services?: readonly ServiceContribution[]
  readonly clients?: readonly ClientContribution[]
  /**
   * Run once, in registration order, after every capability has been
   * validated. Whatever it begins — timers, listeners, connections — its
   * `Disposable` ends. Registration is ATOMIC: a `start` that throws leaves
   * no registry entry, listener or timer, of this capability or any other.
   */
  start?(ctx: CapabilityContext, signal: AbortSignal): Disposable | Promise<Disposable>
}
