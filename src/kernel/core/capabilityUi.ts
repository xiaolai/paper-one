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
  /**
   * A recovery phrase, numbered, laid out to be written down.
   *
   * ⚠️ **NOT `code`.** That one is `user-select: all` so a pairing link can be
   * taken in a click; a phrase rendered in it means one stray click selects the
   * reader's root key. See the stylesheet.
   */
  phrase: 'paper-cap-phrase',
  /** The root of a pane that lists things: the kernel's own panel margins. */
  panel: 'paper-cap-panel',
  /** A quiet line at the top of a panel: a count, a warning. */
  panelMeta: 'paper-cap-panel-meta',
  /** A panel with nothing in it yet, saying so. */
  empty: 'paper-cap-empty',
  /** `empty`'s heading. */
  emptyTitle: 'paper-cap-empty-title',
  /** `empty`'s explanation, or the one line of a filter that found nothing. */
  emptyBody: 'paper-cap-empty-body',
  /** A wrapping row of filter chips. */
  filters: 'paper-cap-filters',
  /** One filter chip. `data-on` says it is the chosen one. */
  filter: 'paper-cap-filter',
  /**
   * A made thing in a list, with a coloured bar down its edge. Set `--card-hue`
   * on it: without one the bar draws nothing and says nothing about it.
   */
  card: 'paper-cap-card',
  /** A card's small capitals: what kind it is. */
  cardKind: 'paper-cap-card-kind',
  /** A card's text as the button that goes to where it came from. */
  cardJump: 'paper-cap-card-jump',
  /** The words inside `cardJump`, muted when the button is disabled. */
  cardBody: 'paper-cap-card-body',
  /** A card's second line. */
  cardAnswer: 'paper-cap-card-answer',
  /** A card's foot: its source on one side, its action on the other. */
  cardFoot: 'paper-cap-card-foot',
  /** A small button holding only an icon. Give it an `aria-label`. */
  iconButton: 'paper-cap-icon-button',
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
  /**
   * A multi-line field — a paragraph the reader edits.
   *
   * ⚠️ **NOT `field` ON A `<textarea>`.** That one is a fixed-height pill, so it
   * shows one line of whatever it is given and rounds the ends off the first and
   * last. This is the kernel's own note editor's shape. See the stylesheet.
   */
  textarea: 'paper-cap-textarea',
  /** A checkbox, in the reader's accent. */
  toggle: 'paper-cap-toggle',
  /** A long unbreakable string meant to be selected rather than read. */
  code: 'paper-cap-code',
  /** A picture and its caption — a pairing QR, say. */
  figure: 'paper-cap-figure',
  /**
   * A QR the theme reaches. Wraps an INLINE `<svg>`, never an `<img>`: a data
   * URI is opaque to CSS, so the renderer's white card and black modules
   * survive every theme. See `.paper-cap-qr` in `capability.css`.
   */
  qr: 'paper-cap-qr',
  /**
   * A control in the title bar, beside the reading controls: an icon the bar's
   * height, as the kernel's own title-bar actions are. `data-disabled="true"`
   * dims it and takes the pointer away; say why in its `title`.
   */
  barButton: 'paper-cap-bar-button',
  /** A row of `barButton`s that are one activity — a reading's transport — on one wash. */
  transport: 'paper-cap-transport',
  /** With `barButton`, inside a `transport`: a step narrow enough for nine to fit. */
  transportButton: 'paper-cap-transport-button',
  /** With `barButton`: a value that cycles when pressed, in figures that do not shift. */
  rate: 'paper-cap-rate',
  /** A state that replaces a `transport` while there is nothing yet to act on. */
  preparing: 'paper-cap-preparing',
  /** A position slider in the title bar — a native `range`. */
  scrub: 'paper-cap-scrub',
  /** A native `<select>` at a row's end. Give it an `aria-label`. */
  select: 'paper-cap-select',
  /** A native `range` at a row's end, set by ear or by eye rather than by step. */
  volume: 'paper-cap-volume',
  /** A less button, `pips`, and a more button: a setting with a closed set of steps. */
  stepper: 'paper-cap-stepper',
  /** One of a `stepper`'s two ends. Disabled, not hidden, at the end of the scale. */
  stepperButton: 'paper-cap-stepper-button',
  /** Where in its scale a `stepper` is. Give it `role="img"` and an `aria-label`. */
  pips: 'paper-cap-pips',
  /** One step of `pips`. `data-on` says it is at or below the value. */
  pip: 'paper-cap-pip',
} as const)

/** One of the kernel's capability class names. */
export type CapabilityUiClass = (typeof CAPABILITY_UI)[keyof typeof CAPABILITY_UI]
