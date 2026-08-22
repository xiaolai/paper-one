import type { Capability } from '../kernel'
import { companion } from '../capabilities/companion'
import { inference } from '../capabilities/inference'
import { peer } from '../capabilities/peer'
import { sync } from '../capabilities/sync'

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
 * this file); the other two compositions are never in that build's module
 * graph, and `assert-bundle` fails the build if one is.
 * `pnpm compositions:check` holds this list to the manifest;
 * `capability:remove <id>` (WI-5.12) edits it.
 *
 * A composition root is the one place allowed to import every capability's
 * `index.ts` and both kernel entries (`.dependency-cruiser.cjs`).
 */
/* `inference` before `companion`, which the registry would work out anyway
 * from `requires` — stated here because the pair is the phase-15 split and
 * reading them adjacent is how the split stays legible. Both are DESKTOP
 * ONLY: `lemond` ships for macOS, Windows and Linux and there is no mobile
 * build of it, so the mobile compositions do not list them. */
export const capabilities: readonly Capability[] = [peer, sync, inference, companion]
