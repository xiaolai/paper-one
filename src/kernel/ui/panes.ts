import { isValidElement, type ReactNode } from 'react'
import type { PaneContribution, PaneRenderer } from '../core/capability'
import { resolvePaneId } from '../core/registry'
import { paneFits, type KernelPaneId, type PaneId, type Screen, type Theme } from './state'

/**
 * The side pane's panels — one registry, for everyone who names them.
 *
 * There were three: the command palette's list, the pane's own rail, and the
 * titlebar's two shortcuts, each with its own copy of the ids, the labels and
 * the accelerators. Each carried a comment explaining that it was derived from
 * something else so the two could not drift, and they had drifted anyway — the
 * prose around them said "seven panels" while all three listed eight.
 *
 * Icons are NOT here. They are components from an icon package, and a module
 * this low has no business importing one; `SidePane` maps them by id, which is
 * checked because the map is typed by `KernelPaneId`.
 *
 * The kernel's panes are the registry below. A capability's panes arrive
 * through the composition (`PaneContribution`), and the helpers at the foot of
 * this file are how the UI reads them beside the kernel's own.
 */
export interface PaneEntry {
  readonly id: KernelPaneId
  readonly label: string
  /**
   * The §11 accelerator, written the way the design system writes it.
   *
   * ⌘ is the notation, not the key: the handler binds Ctrl on Windows and
   * Linux, so anything DISPLAYING this has to translate — see `comboFor`.
   */
  readonly combo?: string
}

export const PANES: readonly PaneEntry[] = [
  { id: 'toc', label: 'Contents', combo: '⌘1' },
  { id: 'notes', label: 'Notes', combo: '⌘2' },
  { id: 'search', label: 'Search', combo: '⌘3' },
  { id: 'cards', label: 'Cards', combo: '⌘4' },
  { id: 'companion', label: 'Companion' },
  { id: 'stats', label: 'Reading', combo: '⌘5' },
  { id: 'library', label: 'Library' },
  { id: 'settings', label: 'Settings' },
]

/**
 * The panels that mean something on a given screen, in registry order.
 *
 * ONE SIDE PANE, FITTED — rather than a second one for the library. The rail is
 * the same rail and the panels are the same panels; the library simply does not
 * offer the three that would open onto an apology. Which three is `state`'s to
 * say, because that is where the ids are declared and the reducer needs the
 * same answer; asking here as well is how two lists of one thing begin.
 */
export function panesFor(screen: Screen): readonly PaneEntry[] {
  return PANES.filter((pane) => paneFits(screen, pane.id))
}

/** §11 binds ⌘1…5 to "Contents, notes, search, cards, stats" — kernel panes
 *  only; a contributed pane gets no digit. */
export const PANE_SHORTCUTS: readonly { combo: string; digit: string; pane: KernelPaneId }[] =
  PANES.filter((pane) => pane.combo).map((pane) => ({
    combo: pane.combo ?? '',
    digit: (pane.combo ?? '').slice(-1),
    pane: pane.id,
  }))

/**
 * The themes, in §05's order — the other registry that was written twice.
 *
 * The palette had one copy and the Settings panel another, with the same ids
 * and the same labels. Here for the same reason the panes are: two lists of the
 * same thing drift the moment one is edited alone.
 */
export const THEMES: readonly { id: Theme; label: string }[] = [
  { id: 'paper', label: 'Paper' },
  { id: 'slate', label: 'Slate' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'sage', label: 'Sage' },
  { id: 'night', label: 'Night' },
]

/* THE TYPEFACE TABLE MOVED to `typefaces.ts`, which is where the faces, their
 * stacks and their optical sizes now live together. It was three tables in
 * three files — this one, a preview table in the settings panel and a reading
 * table in `bookCss` — so a face could be listed here, previewed in a second
 * stack and read in a third, and nothing compared them. */

/** Labels by id, for the pane header and anywhere else that names one. */
export const PANE_TITLES = Object.fromEntries(
  PANES.map(({ id, label }) => [id, label]),
) as Record<KernelPaneId, string>

/**
 * The panel the side pane shows for what the state asks, and its title —
 * against THIS composition. The kernel's panes are always there; a
 * contributed id is looked up in `contributed`; anything else (a pane from a
 * capability no longer composed) resolves to the screen's default, so the
 * pane never opens onto nothing under a title nobody can place.
 */
export function shownPane(
  wanted: PaneId,
  contributed: readonly PaneContribution[],
  fallback: PaneId,
): { id: PaneId; title: string; contribution: PaneContribution | null } {
  const id = resolvePaneId(wanted, contributed.map((pane) => pane.id), fallback)
  const contribution = contributed.find((pane) => pane.id === id) ?? null
  if (contribution) return { id, title: contribution.label, contribution }
  return { id, title: PANE_TITLES[id as KernelPaneId], contribution: null }
}

/**
 * The value a contributed pane's `render` returned, as something React can
 * draw — the narrowing the opaque `PaneRenderer` defers to here. Refuses, by
 * pane id, a value that is not a node: React would refuse it too, but with
 * "Objects are not valid as a React child" and no word about which
 * capability sent it.
 */
export function renderContribution(id: string, render: PaneRenderer): ReactNode {
  const value = render()
  if (isReactNode(value)) return value
  throw new Error(`pane "${id}" rendered ${describe(value)}, which React cannot show`)
}

function isReactNode(value: unknown): value is ReactNode {
  if (value == null) return true
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
      return true
    case 'object':
      return isValidElement(value) || (Array.isArray(value) && value.every(isReactNode))
    default:
      return false
  }
}

function describe(value: unknown): string {
  if (typeof value === 'function') return 'a function'
  if (typeof value === 'symbol') return 'a symbol'
  if (typeof value === 'object' && value !== null) return `an object of ${value.constructor?.name ?? 'unknown'}`
  return typeof value
}

/**
 * A combo as this platform writes it.
 *
 * The registry stores ⌘ because the design system is written for macOS.
 * Printed verbatim on Windows and Linux it names a key those keyboards do not
 * have, for a shortcut the app binds to Ctrl — so the palette and every
 * tooltip were telling some readers to press something that does not exist.
 */
export function comboFor(combo: string, platform: 'macos' | 'windows' | 'linux'): string {
  return platform === 'macos' ? combo : combo.replace('⌘', 'Ctrl+')
}
