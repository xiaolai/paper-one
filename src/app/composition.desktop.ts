import type { Capability } from '../kernel'
import { circle } from '../capabilities/circle'
import { companion } from '../capabilities/companion'
import { inference } from '../capabilities/inference'
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
 * `src/main.tsx` reaches whichever composition its build is for through
 * `virtual:paper-composition`, which `vite.config.ts` resolves from
 * `TAURI_ENV_PLATFORM` at build time (unset, `darwin`, `windows`, `linux` →
 * this file); the other compositions are never in that build's module graph, and
 * `assert-bundle` fails the build if one is.
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
/* `inference` before `companion`, which the registry would work out anyway
 * from `requires` — stated here because the pair is the phase-15 split and
 * reading them adjacent is how the split stays legible. Both are DESKTOP
 * ONLY: the runtime Paper stages, llama.cpp's `llama-server`, is staged for
 * the desktop platforms alone, and the plugin that supervises it compiles only
 * under the `desktop` feature — so the mobile compositions do not list them. */
/* `webhost` last, and after `peer`, which it declares in `requires`.
 *
 * ⚠️ **THE REASON HERE HAS NOW BEEN WRONG TWICE.** It first said *"it needs
 * peer's envelope"*, and the envelope moved to the kernel in phase 19. It was
 * then corrected to *"peer binds the service host the shelf serves through"* —
 * also untrue: `webhost` binds its OWN service host, and `composeCapabilities`
 * serves every bound host once, AFTER every capability has started. Neither
 * capability can start too early for the other. Found by audit.
 *
 * What the `requires` buys is the ORDER OF THE LIST, which is what a reader of
 * this file is looking at: the transport that carries the circle comes before
 * the transport that carries a browser, and a build that drops `peer` drops
 * `webhost` with it rather than leaving a shelf serving a library nothing
 * replicates. That is a composition decision and not a startup dependency, and
 * saying so is the difference between a coupling somebody can evaluate and one
 * they have to take on trust.
 *
 * DESKTOP ONLY: a phone is a satchel, never a shelf, and has nothing to
 * serve. */
export const capabilities: readonly Capability[] = [peer, sync, inference, companion, circle, publicSharing, webhost]
