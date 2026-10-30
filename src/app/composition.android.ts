import type { Capability } from '../kernel'
import { peer } from '../capabilities/peer'
import { publicSharing } from '../capabilities/public'
import { sync } from '../capabilities/sync'

/**
 * The Android composition: the capabilities composed onto the kernel in an
 * Android build, in manifest order — which is registration order among
 * capabilities with no `requires` between them (ADR decision 4).
 *
 * STATIC, and its own list: this file imports exactly the capabilities whose
 * manifest `platforms` name `android`, so nothing else can enter the Android
 * bundle through it.
 *
 * ⚠️ **THE ENTRY NAMED HERE WAS `src/main.tsx`, WHICH IS THE DESKTOP ONE.**
 * A phone build enters at `index.mobile.html` → `src/main.mobile.tsx` →
 * `app/bootApp.ts` — `vite.config.ts` picks between the two entries from
 * `TAURI_ENV_PLATFORM`, and it has since the mobile shell landed. And there
 * are FOUR compositions now, not three. Found by audit.
 *
 * Whichever entry a build uses reaches its composition through
 * `virtual:paper-composition`, which `vite.config.ts` resolves from
 * `TAURI_ENV_PLATFORM` at build time; the other platform compositions are
 * never in that build's module graph, and `assert-bundle` fails the build if
 * one is. `pnpm compositions:check` holds this list to the manifest;
 * `capability:remove <id>` edits it.
 */
export const capabilities: readonly Capability[] = [peer, sync, publicSharing]
