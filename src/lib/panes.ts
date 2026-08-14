import type { PaneId, Theme } from './state'

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
  /**
   * False for a panel the command palette should not list.
   *
   * Only "Add books" sets it. The palette already carries "Add books…", which
   * opens the picker, and an "Open Add books" beside it — one letter apart,
   * doing something else — is a choice no reader can make correctly.
   */
  readonly inPalette?: false
}

export const PANES: readonly PaneEntry[] = [
  { id: 'toc', label: 'Contents', combo: '⌘1' },
  { id: 'notes', label: 'Notes', combo: '⌘2' },
  { id: 'search', label: 'Search', combo: '⌘3' },
  { id: 'cards', label: 'Cards', combo: '⌘4' },
  { id: 'companion', label: 'Companion' },
  { id: 'stats', label: 'Reading', combo: '⌘5' },
  { id: 'import', label: 'Add books', inPalette: false },
  { id: 'settings', label: 'Settings' },
]

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
