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
 * The client half of the wire — a `Channel` over the frame socket, the remote
 * stores, the six-digit screen — will be a capability of its own and will list
 * `web` in the manifest. This file exists first, empty and checked, so that the
 * machinery is watching before there is anything to get wrong. That is the same
 * order `webhost` was registered in, for the same reason.
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
