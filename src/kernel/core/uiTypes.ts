/**
 * The vocabulary of the interface's SHAPE, as types — which screen, which
 * panel, which theme — held here so that code with no React in it can name
 * them: a durable setting under `kernel.theme`, a pane a capability
 * contributes, a service handler answering "which screen is the reader on".
 *
 * `ui/state.ts` re-exports every one of these, so nothing that imported them
 * from there has moved. The doc comments moved with the types, because they
 * are about the types.
 */

/**
 * The two screens there are.
 *
 * `pdf` and `cards` were here and unreachable: a PDF is opened by the reader
 * like any other book — that is the whole point of `makePdf` — and cards are a
 * panel of the side pane, not a screen. They cost more than a dead branch,
 * because a predicate that names one drifts from a predicate that does not:
 * the titlebar counted `pdf` as a reading screen while the chrome fade beside
 * it did not, so the two disagreed about what the reader was looking at.
 */
export type Screen = 'library' | 'reader'

/** The themes, in §05's order. `ui/panes.ts` gives each its label. */
export const THEME_IDS = ['paper', 'slate', 'sepia', 'sage', 'night'] as const
export type Theme = (typeof THEME_IDS)[number]

/**
 * A face id, from the registry in `typefaces.ts`.
 *
 * A STRING rather than a union, because the set is no longer fixed at compile
 * time: which faces exist depends on what the reader's machine has, and a union
 * would have to name every face on every platform in order to describe one.
 * `faceById` resolves an unknown id to the default, so nothing downstream has
 * to handle a face that is not there — a setting carried to a machine without
 * that font falls back rather than failing.
 */
export type Typeface = string

/**
 * The panels of the single side pane — see `ui/panes.ts` for their metadata.
 *
 * Contents and Companion used to live in a separate 340px leading card, which
 * meant two surfaces competing for the same job. One pane holds every tool;
 * the reader stays the only permanent full-width surface.
 *
 * `notes` rather than "annotation": §15's lexicon is explicit that the word is
 * Note. `library` is the collection panel — what the pane holds when the shelf
 * is the screen; it replaced an `import` panel that was one paragraph and a
 * button the toolbar already had.
 *
 * A VALUE as well as a type, because the registry (`registry.ts`) has to
 * answer "is this id one of the kernel's" at runtime — for a remembered pane
 * that names a capability no longer composed — and a union alone cannot be
 * asked. The type is derived from the array so the two cannot drift.
 */
export const KERNEL_PANE_IDS = [
  'toc',
  'companion',
  'notes',
  'cards',
  'search',
  'stats',
  'library',
  'settings',
] as const
export type KernelPaneId = (typeof KERNEL_PANE_IDS)[number]

/**
 * A pane a capability contributes: `<capability>:<name>`. The colon is what
 * tells the two apart at runtime — no kernel pane has one — and it is what
 * makes the id say who owns the pane.
 */
export type ContributedPaneId = `${string}:${string}`

/** Any pane the side pane can show: the kernel's own, or a contributed one. */
export type PaneId = KernelPaneId | ContributedPaneId

/** Whether an id names a contributed pane (see `ContributedPaneId`). */
export function isContributedPaneId(id: PaneId): id is ContributedPaneId {
  return id.includes(':')
}

/** Whether an id — from anywhere, typed or not — names one of the kernel's own panes. */
export function isKernelPaneId(id: unknown): id is KernelPaneId {
  return typeof id === 'string' && (KERNEL_PANE_IDS as readonly string[]).includes(id)
}

export const SIDES = ['left', 'right'] as const
export type Side = (typeof SIDES)[number]

/**
 * §06: the reading ruler is scrolled-flow only. In paginated mode there are no
 * lines to advance, so Space is next page and the ruler control is hidden —
 * hidden, not disabled.
 */
export const PAGE_LAYOUTS = ['scrolled', 'paginated'] as const
export type PageLayout = (typeof PAGE_LAYOUTS)[number]
