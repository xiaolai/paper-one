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
 * **IT NAMES ITS COMPOSITION, AND DOES NOT ASK `virtual:paper-composition` AS THE
 * OTHER TWO ENTRIES DO.** That module looks a composition up per platform, and a
 * browser build has one, so the lookup buys nothing here. What it costs is that
 * no import graph can follow it: whatever a test loads through it is out of the
 * mutation gate's sight (`unseenAtBase` in `scripts/check-mutants.mjs`). Named
 * directly, this file is an ordinary module with an ordinary test,
 * `main.web.test.ts`, and `assert-bundle` judges the bundle as it always did:
 * `dev-docs/decisions/2026-11-02-composition-route.md`.
 *
 * The client itself, 700 lines of it until 2026-11-02, is `app/web/client.tsx`.
 *
 * Four older comments still point here for the client — in `app/web/Reader.tsx`,
 * `ReadingSettings.tsx`, `remotePositions.ts` and `app/shell/TabBar.tsx`. They mean
 * `app/web/client.tsx`.
 */
import { mountWebClient } from './app/web/client'
import { capabilities } from './app/composition.web'

mountWebClient(capabilities)
