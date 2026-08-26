import type { Capability } from '../kernel'

/**
 * The WEB composition: the capabilities composed onto the kernel in a browser
 * build — the SPA the shelf serves to a phone.
 *
 * **It is empty, and that is the answer rather than a gap.** Every capability
 * that exists is Tauri-bound: `peer` reaches an iroh endpoint through a plugin,
 * `sync` requires `peer`, `inference` supervises a local process, `companion`
 * requires `inference`, and `webhost` IS the shelf's server — the thing this
 * build talks to, not something it runs. A browser can compose none of them, so
 * this build is the kernel and the reader, and `assert-bundle` fails it if any
 * capability module reaches the bundle.
 *
 * ⚠️ THE CLIENT HALF OF THE WIRE IS NOT FUTURE WORK. This said a `Channel`
 * over the frame socket, the remote stores and the six-digit screen "will be a
 * capability of its own"; they were written directly under `src/app/web/`
 * instead, and have been since phase 18. Nothing here composes them, because
 * they are not a capability — they are this build's own client, reached by
 * `src/main.web.tsx`.
 *
 * That may still be worth changing: a capability would give them a manifest
 * entry, a declared platform and the bundle assertion that goes with one. It is
 * a decision nobody has taken, which is different from a plan already made —
 * and this file existing empty and checked, so the machinery watches before
 * there is anything to get wrong, remains true either way.
 *
 * ## `web` is a platform here and NOT a Tauri target
 *
 * The other three compositions are the same application compiled for three
 * operating systems. This one is a different program: no Rust, no `src-tauri`,
 * served over HTTP to somebody else's browser. It is a platform of the manifest
 * — it has a composition, the bundle assertion holds it to the manifest, and
 * `capability:remove` understands it — and it has no Cargo feature, because a
 * feature that compiles nothing is one somebody will later try to use.
 * `NATIVE_PLATFORMS` in `scripts/lib/architecture.mjs` is that distinction.
 *
 * `TAURI_ENV_PLATFORM=web` is set by `pnpm build:web` by hand, exactly as
 * `build:ios` sets its own. The Tauri CLI never sets it, because Tauri never
 * builds this.
 */
export const capabilities: readonly Capability[] = []
