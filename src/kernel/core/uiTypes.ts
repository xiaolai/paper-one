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
 * `marginalia` is everything the reader put in a book — marks, the notes on
 * them, the companion's claims, and the places they kept. It was `notes`, and
 * that stopped being true when bookmarks joined it: §15 owns the words mark and
 * note precisely, so a panel holding four things could not name itself after
 * one of them. "Annotations" is the obvious replacement and is the one word §15
 * rules out here.
 *
 * `library` is the collection panel — what the pane holds when the shelf
 * is the screen; it replaced an `import` panel that was one paragraph and a
 * button the toolbar already had.
 *
 * There is no `bookmarks` panel. Places were briefly one, and they belong with
 * the rest of a reader's marginalia instead: the same list, one more filter
 * chip, and a scope chip that says whether it is this book or all of them.
 * Contents stays separate for the reason that pairing fails — it is the BOOK's
 * structure, the same for every reader and editable by none, so a panel with it
 * on top and a reader's own places below would have had a top half that cannot
 * be changed and a bottom half that can.
 *
 * A VALUE as well as a type, because the registry (`registry.ts`) has to
 * answer "is this id one of the kernel's" at runtime — for a remembered pane
 * that names a capability no longer composed — and a union alone cannot be
 * asked. The type is derived from the array so the two cannot drift.
 */
export const KERNEL_PANE_IDS = [
  'toc',
  'companion',
  'marginalia',
  'cards',
  'search',
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

/** Which step each spacing is on — see `SPACING` in `metrics.ts`. */
export interface SpacingIndices {
  readonly letter: number
  readonly word: number
  readonly line: number
  readonly paragraph: number
}

/** The four, named, so a caller cannot pass a key the scale does not have. */
export type SpacingKey = keyof SpacingIndices

/**
 * How a line of prose fills its measure.
 *
 * NOT "left" AND "right", which is the obvious pair and the wrong one: a line
 * set flush to the reading edge is on the LEFT in English, on the RIGHT in
 * Arabic, and at the TOP in vertical Japanese. There is one behaviour and three
 * appearances, and naming it by one of them would be wrong in the other two.
 * `ragged` names what the far edge does, which is the same in all three.
 *
 * THREE STATES, NOT AN ALIGNMENT AND A HYPHENATION SWITCH. The two axes have
 * four combinations and only three of them are worth offering, so this enum
 * lists the three rather than letting a reader assemble the fourth by accident:
 *
 *   justified            both edges flush, long words broken to fit
 *   justified-no-hyphens both edges flush, the word spaces stretched instead
 *   ragged               reading edge flush, the far edge left uneven
 *
 * Ragged carries no hyphenation, deliberately. It is the one combination of the
 * four that is a matter of taste rather than of mechanics — hyphens do measure
 * shorter in a rag, 15px mean against 29px on a real page at the 660px measure,
 * but a rag is what a reader picking this asked for and breaking words to even
 * it out is answering a question they did not put.
 *
 * The order is the cycle the Settings row walks, most-worked to least.
 */
export const ALIGNS = ['justified', 'justified-no-hyphens', 'ragged'] as const
export type Align = (typeof ALIGNS)[number]
