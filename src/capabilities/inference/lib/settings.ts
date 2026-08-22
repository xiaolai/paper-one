import { defineSetting, type Setting } from '../../../kernel'

/* `LOOK_UP_SETTING` is the KERNEL's (`kernel.lookUp`), not this capability's,
 * and re-exported here so the pane reads one object rather than two that could
 * drift. The value decides what `ui/lookUp.ts` does when the reader asks to
 * look something up, and that file is the kernel's — `inference` binds the
 * provider and draws the row; it does not own the question. */
export { LOOK_UP_SETTING } from '../../../kernel'

/**
 * The `inference` capability's durable preferences.
 *
 * IN `lib/`, NOT IN `index.ts`, and the reason is a cycle rather than tidiness:
 * the settings section imports these, and `index.ts` imports the settings
 * section, so defining them in the entry made `index → ui → index` — which
 * `no-circular` refuses, and rightly: a module that is half-initialised when
 * another reads it is a class of bug that only shows up under a particular
 * import order.
 */

/** Whether to keep the model resident between questions. */
export const KEEP_LOADED_SETTING: Setting<boolean> = defineSetting('inference.keepLoaded', false, (raw) =>
  typeof raw === 'boolean' ? raw : undefined,
)
