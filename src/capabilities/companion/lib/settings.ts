import { defineSetting, type Setting } from '../../../kernel'

/**
 * The `companion` capability's durable preferences.
 *
 * In `lib/` rather than in `index.ts` for the same reason `inference`'s are:
 * the settings section imports them and the entry imports the section, so
 * defining them in the entry is a cycle `no-circular` refuses.
 */

/**
 * Which route answers. A route id the probe minted (`local:…`, `agent:…`,
 * `endpoint:…`), or `''` for "not chosen yet".
 *
 * `''` rather than a default route id, because a default would be a choice
 * Paper made on the reader's behalf that survives the thing it named being
 * uninstalled. Empty means "pick the best usable one", which `resolveRoute`
 * does freshly every time — and which is also what makes the fall-back
 * visible rather than silent when a chosen route disappears.
 */
export const ROUTE_SETTING: Setting<string> = defineSetting('companion.route', '', (raw) =>
  typeof raw === 'string' ? raw : undefined,
)

/**
 * Whether the companion may reach beyond the book.
 *
 * OFF by default and off in this phase: §13's rule is that the companion
 * answers from the book and says when it is drawing on outside knowledge, and
 * nothing here yet has a tool to offer. The setting exists so the surface is
 * declared rather than retrofitted, and the row says what it would mean.
 */
export const TOOLS_SETTING: Setting<boolean> = defineSetting('companion.tools', false, (raw) =>
  typeof raw === 'boolean' ? raw : undefined,
)

/**
 * How much of the reader's subscription one answer may spend.
 *
 * THREE STATES, NOT TWO, and the third is the default: `'default'` sends no
 * flag at all and lets the account decide. A two-state toggle would have had
 * to pick one of them as "off", and both would have been Paper overriding a
 * choice the reader already made with their money.
 *
 * The two adapters spend it on different axes — Codex on reasoning effort,
 * Claude on a model alias — because those are the axes their CLIs expose. The
 * setting names the reader's INTENT; `agentask.rs` owns the translation, which
 * is why this value is a closed set and never a model id.
 */
export const DEPTH_SETTING: Setting<'default' | 'faster' | 'thorough'> = defineSetting(
  'companion.depth',
  'default',
  (raw) => (raw === 'default' || raw === 'faster' || raw === 'thorough' ? raw : undefined),
)
