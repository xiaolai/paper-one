import type { Capability } from '../kernel'
import { circle } from '../capabilities/circle'
import { peer } from '../capabilities/peer'
import { publicSharing } from '../capabilities/public'
import { sync } from '../capabilities/sync'
import { webhost } from '../capabilities/webhost'

/**
 * The DESKTOP composition: the capabilities composed onto the kernel in a
 * desktop build, in manifest order — which is registration order among
 * capabilities with no `requires` between them (ADR decision 4).
 *
 * STATIC, and its own list: this file imports exactly the capabilities whose
 * manifest `platforms` name `desktop`; there is no runtime filtering of a
 * longer one. `.ios.ts` and `.android.ts` sit beside it with their own lists.
 * ⚠️ **`app/bootApp.ts` IS WHAT IMPORTS IT, NOT AN ENTRY** (2026-09-19 audit;
 * this said `src/main.tsx`, and `vite.config.ts` said the same). There are
 * THREE entries — `main.tsx` (desktop), `main.mobile.tsx` (phones) and
 * `main.web.tsx` (browser) — and the first two reach a composition only through
 * `bootApp()`, which holds the one `virtual:paper-composition` import between
 * them. `main.web.tsx` imports it directly, because the browser client boots
 * without `bootApp`. Naming one entry made the sentence wrong for the other two.
 *
 * `vite.config.ts` resolves that module from `TAURI_ENV_PLATFORM` at build time
 * (unset, `darwin`, `windows`, `linux` → this file); the other compositions are
 * never in that build's module graph, and `assert-bundle` fails the build if one
 * is.
 *
 * ⚠️ **THERE ARE FOUR, AND THIS SAID "the other two".** `composition.web.ts`
 * joined `.ios.ts` and `.android.ts` and `scripts/lib/compositions.mjs` handles
 * all four; `composition.android.ts` already carries the same correction.
 * `pnpm compositions:check` holds this list to the manifest;
 * `capability:remove <id>` (WI-5.12) edits it.
 *
 * A composition root is the one place allowed to import every capability's
 * `index.ts` and both kernel entries (`.dependency-cruiser.cjs`).
 */
/* `webhost` last, and after `peer`, which it declares in `requires`.
 *
 * ⚠️ **THE REASON HERE HAS NOW BEEN WRONG TWICE.** It first said *"it needs
 * peer's envelope"*, and the envelope moved to the kernel in phase 19. It was
 * then corrected to *"peer binds the service host the shelf serves through"* —
 * also untrue: `webhost` binds its OWN service host, and `composeCapabilities`
 * serves every bound host once, AFTER every capability has started. Neither
 * capability can start too early for the other. Found by audit.
 *
 * ⚠️ **AND THE THIRD ANSWER WAS WRONG TOO** (2026-09-19 audit). It said *"what
 * the `requires` buys is the ORDER OF THE LIST"* and that *"a build that drops
 * `peer` drops `webhost` with it"*. Neither is what the code does, and both are
 * checkable:
 *
 *   - THE LIST'S ORDER IS THE MANIFEST'S, not a consequence of `requires`.
 *     `compositions:check` builds the expected order as
 *     `manifest.capabilities.filter(imported)` and compares this array to it
 *     (`scripts/lib/compositions.mjs`), so reordering this line fails there
 *     whatever any `requires` says.
 *   - DROPPING `peer` DOES NOT DROP `webhost` — it REFUSES the composition.
 *     `composeCapabilities` throws `missing-requires` for a capability whose
 *     dependency is not composed (`core/registry.ts`), which is a louder and
 *     more useful guarantee than the silent pruning this claimed.
 *
 * What `requires` actually buys: registration order is topological by it (ties
 * by list position, ADR decision 4), a missing dependency is refused by name, a
 * cycle is refused, and a dependency that fails to start propagates as
 * `requires-failed`. Written out because this comment has now been wrong three
 * times about one field, each time in a way that reads as authoritative.
 *
 * DESKTOP ONLY: a phone is a satchel, never a shelf, and has nothing to
 * serve. */
export const capabilities: readonly Capability[] = [peer, sync, circle, publicSharing, webhost]
