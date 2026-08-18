import { paneFits, type PaneId, type Screen, type Theme } from './state'

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
 * checked because the map is typed by `PaneId`.
 */
export interface PaneEntry {
  readonly id: PaneId
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

/** §11 binds ⌘1…5 to "Contents, notes, search, cards, stats". */
export const PANE_SHORTCUTS: readonly { combo: string; digit: string; pane: PaneId }[] =
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
) as Record<PaneId, string>

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
