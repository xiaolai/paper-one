import { defineSetting, type Setting } from '../../../kernel'
import { DEPTHS, type Depth } from '../../inference'

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

/* ⚠️ NO `TOOLS_SETTING`, AND IT IS A REMOVAL RATHER THAN AN OMISSION.
 *
 * There was one — persisted, and drawn as a checkbox reading "Tools let it
 * reach further; it will say when it does." **Nothing on any answer path ever
 * read it.** The agent turns disable tools unconditionally (`agentask.rs`
 * passes `--disallowed-tools "*"`, which is the whole of that sandbox) and the
 * local route has no tools to enable, so the toggle moved a stored boolean and
 * changed nothing whatsoever.
 *
 * That is worse than having no control. A reader who left it OFF was told they
 * had restricted something, and a reader who turned it ON was told the
 * companion could now reach further and would say so — neither statement was
 * true, and both are about the one property §13 makes a promise on. An inert
 * privacy control does not fail safe; it fails *convincingly*.
 *
 * The same argument this file's own voice-picker removal makes, and the same
 * remedy: it comes back with the feature that needs it, and with an enforcement
 * point on the request path rather than a field beside one.
 */

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
export const DEPTH_SETTING: Setting<Depth> = defineSetting('companion.depth', 'default', (raw) =>
  /* VALIDATED AGAINST THE CANONICAL LIST, not a union repeated here. Spelling
     the three states again would compile happily after `Depth` gained a
     fourth, and the setting would then silently refuse a value the rest of
     the system considers legal. */
  (DEPTHS as readonly string[]).includes(raw as string) ? (raw as Depth) : undefined,
)
