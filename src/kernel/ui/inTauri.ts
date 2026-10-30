/**
 * Is the Tauri IPC layer present?
 *
 * ## Why two lines get their own module
 *
 * This lived in `appStorage.ts`, whose first statement imports six symbols from
 * `@tauri-apps/plugin-fs`. Four modules — `lookUp`, `marksFiles`, `tagFiles`
 * and `openExternal` — import **only this function** from it, and every one of
 * them dragged the filesystem plugin in behind a `window` check that needs no
 * filesystem at all.
 *
 * That is the same defect as `extensionFor` in `bookVault.ts` and
 * `sizePortOver` in `bookSizes.ts`, and it is the reason
 * `scripts/check-browser-safe.mjs` exists:
 *
 * > **A pure value sharing a module with a platform binding takes the whole
 * > subtree down with it.** The import graph does not care that nobody calls
 * > the binding.
 *
 * ## It is a question, not a binding
 *
 * Nothing here imports `@tauri-apps`, and nothing should. Asking whether the
 * IPC layer is present is exactly what a module that CANNOT use it needs to do,
 * so this has to remain answerable from a browser — which is the whole point of
 * moving it. `__TAURI_INTERNALS__` is injected onto `window` by the shell; its
 * absence is the answer, not an error.
 */

/** True when the Tauri IPC layer is present — false in a plain browser tab. */
export function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
