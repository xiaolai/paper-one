import type { Capability } from '../kernel'
import { peer } from '../capabilities/peer'
import { publicSharing } from '../capabilities/public'
import { sync } from '../capabilities/sync'

/**
 * The iOS composition: the capabilities composed onto the kernel in an iOS
 * build, in manifest order — which is registration order among capabilities
 * with no `requires` between them (ADR decision 4).
 *
 * STATIC, and its own list: this file imports exactly the capabilities whose
 * manifest `platforms` name `ios`, so nothing else can enter the iOS bundle
 * through it. `src/main.tsx` reaches whichever composition its build is for
 * through `virtual:paper-composition`, which `vite.config.ts` resolves from
 * `TAURI_ENV_PLATFORM` at build time; the other compositions are never in that
 * build's module graph, and `assert-bundle` fails the build if one is.
 *
 * ⚠️ **TWO CORRECTIONS IN ONE SENTENCE.** It said "the other two compositions",
 * and there are four — `composition.web.ts` joined them, as
 * `composition.android.ts` already records. And it named `src/main.tsx` as the
 * entry that reaches this file: the phone's entry is `src/main.mobile.tsx`
 * (`index.mobile.html`), which is the whole point of the mobile build having its
 * own root. `main.tsx` mounts the DESKTOP shell.
 * `pnpm compositions:check` holds this list to the manifest;
 * `capability:remove <id>` edits it.
 */
export const capabilities: readonly Capability[] = [peer, sync, publicSharing]
