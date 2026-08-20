import type { Capability } from '../kernel'
import { peer } from '../capabilities/peer'
import { sync } from '../capabilities/sync'

/**
 * The Android composition: the capabilities composed onto the kernel in an
 * Android build, in manifest order — which is registration order among
 * capabilities with no `requires` between them (ADR decision 4).
 *
 * STATIC, and its own list: this file imports exactly the capabilities whose
 * manifest `platforms` name `android`, so nothing else can enter the Android
 * bundle through it. `src/main.tsx` reaches whichever composition its build
 * is for through `virtual:paper-composition`, which `vite.config.ts` resolves
 * from `TAURI_ENV_PLATFORM` at build time; the other two compositions are
 * never in that build's module graph, and `assert-bundle` fails the build if
 * one is. `pnpm compositions:check` holds this list to the manifest;
 * `capability:remove <id>` edits it.
 */
export const capabilities: readonly Capability[] = [peer, sync]
