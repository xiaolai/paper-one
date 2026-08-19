/**
 * The class names a capability draws with — the public half of
 * `ui/styles/capability.css`.
 *
 * A capability contributes React to the kernel's panes, but it may import the
 * kernel only through `src/kernel/index.ts` (`kernel-public-entry-only`), and
 * the kernel's own controls are a CSS Module whose names are hashed at build
 * time. So there was no way to ask for a Paper button from the other side of
 * the boundary, and both capabilities that shipped drew in the browser's
 * default chrome.
 *
 * STRINGS, which is what makes this work at all: a global class name is data,
 * so it crosses the boundary as data. The React-free public entry re-exports
 * this module and stays React-free AND stylesheet-free; the stylesheet ships
 * with the UI entry, beside `tokens.css` and `global.css`, which is where
 * every other stylesheet in the app lives.
 *
 * The names are NOT free-form. `capabilityUi.test.ts` reads the stylesheet and
 * holds these two in step in both directions — a name here that no rule
 * defines renders silently unstyled (the failure this replaced), and a rule
 * there that nothing exports is a control no capability can reach.
 *
 * @example
 * import { CAPABILITY_UI as ui } from '../../kernel'
 *
 * <div className={ui.row}>
 *   <span className={ui.grow}>This device</span>
 *   <span className={ui.value}>shelf · 8e20a13e…</span>
 * </div>
 */
export const CAPABILITY_UI = Object.freeze({
  /** The root of a contributed pane or settings section: a vertical stack. */
  section: 'paper-cap-section',
  /** One line of a section — a label, and a value or a control. */
  row: 'paper-cap-row',
  /** The half of a row that takes the slack and truncates. */
  grow: 'paper-cap-grow',
  /** A row's quiet right-hand side. */
  value: 'paper-cap-value',
  /** A wrapping sentence under a row, explaining the control above it. */
  hint: 'paper-cap-hint',
  /** A row of buttons offered together. */
  actions: 'paper-cap-actions',
  /**
   * An action. The DEFAULT IS QUIET — see the stylesheet: nearly everything a
   * capability offers is secondary, and a pane of filled accent buttons reads
   * as a form rather than as settings.
   */
  button: 'paper-cap-button',
  /** With `button`: the one action a surface is actually for. */
  buttonPrimary: 'paper-cap-button-primary',
  /** With `button`: destructive. Coloured, not filled. */
  buttonDanger: 'paper-cap-button-danger',
  /** A text field. Takes the row's slack. */
  field: 'paper-cap-field',
  /** With `field`: holds a number, sized to the number. */
  fieldNarrow: 'paper-cap-field-narrow',
  /** A checkbox, in the reader's accent. */
  toggle: 'paper-cap-toggle',
  /** A long unbreakable string meant to be selected rather than read. */
  code: 'paper-cap-code',
  /** A picture and its caption — a pairing QR, say. */
  figure: 'paper-cap-figure',
} as const)

/** One of the kernel's capability class names. */
export type CapabilityUiClass = (typeof CAPABILITY_UI)[keyof typeof CAPABILITY_UI]
