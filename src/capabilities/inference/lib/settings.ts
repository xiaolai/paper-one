import { defineSetting, type Setting } from '../../../kernel'

/* ⚠️ `LOOK_UP_SETTING` USED TO BE RE-EXPORTED HERE — the kernel's
 * `kernel.lookUp`, forwarded so the pane read one object rather than two that
 * could drift. The setting is deleted along with the mode it held: there is no
 * longer a choice between the system dictionary and the gloss, because the
 * hand-off is gone and the gloss is the whole of Look up. */

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
