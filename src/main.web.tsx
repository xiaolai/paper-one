/**
 * THE BROWSER CLIENT'S COMPOSITION ROOT.
 *
 * A second entry rather than a branch inside `src/main.tsx`, for two reasons
 * that are both structural:
 *
 *   - **`main.tsx` is the Tauri webview's root.** It arms a shutdown handshake
 *     with the Rust shell, tears the sync journal down on `pagehide`, and
 *     migrates a legacy `localStorage` library. A browser has no shell, no
 *     journal and no legacy, so every one of those is dead code here — and the
 *     imports that carry them pull `@tauri-apps` into the bundle.
 *   - **`index.html` carries an inline script** for the first-paint hint, which
 *     would need `script-src 'unsafe-inline'`. That is precisely what the web
 *     host's policy refuses, so the web entry needs its own HTML anyway.
 *
 * ⚠️ **THIS FILE IS ONE CALL AND MUST STAY ONE CALL.** It imports
 * `virtual:paper-composition`, which `vite.config.ts` resolves per platform and
 * no import graph can follow, so whatever a test loads through here is out of
 * the mutation gate's sight (`unseenAtBase` in `scripts/check-mutants.mjs`). It
 * held 700 lines of client, and its test loaded it, so a pull request that
 * changed them could be authorised nothing: see
 * `dev-docs/decisions/2026-11-02-composition-route.md`. The client is
 * `app/web/client.tsx` now, and nothing loads this file but the build. Anything
 * added here that gives it a new mutant fails the sweep as `no-test-found`, and
 * belongs in the client; `app/web/client.entry.test.ts` reads this file and refuses
 * anything but the one call.
 *
 * Four older comments still point here for the client — in `app/web/Reader.tsx`,
 * `ReadingSettings.tsx`, `remotePositions.ts` and `app/shell/TabBar.tsx`. They mean
 * `app/web/client.tsx`.
 */
import { mountWebClient } from './app/web/client'
import { capabilities } from 'virtual:paper-composition'

// Stryker disable next-line CallExpression: only loading this module could see the call go, and a test that loads it is on the hidden route this file was emptied to end, so `app/web/client.entry.test.ts` holds this line as text instead.
mountWebClient(capabilities)
