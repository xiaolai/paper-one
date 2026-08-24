import type { Capability } from '../../kernel'

/**
 * The `webhost` capability — the shelf's browser client (phase 18).
 *
 * The Rust side is `tauri-plugin-webhost`: an HTTP server on loopback that
 * serves the SPA, takes six typed digits, and carries frames. This is the
 * webview's half.
 *
 * ## Why this is a capability rather than app plumbing
 *
 * The question is worth answering here because it looks like plumbing: it
 * serves a phone, not the person at the keyboard, so it adds nothing the local
 * reader can see.
 *
 * `peer` settles it. That is the existing transport capability and it has the
 * same shape in every respect that decides this one — it serves other devices,
 * carries a Rust crate, exposes commands to the webview, needs a permissions
 * file, has a small Settings surface, and the reader still works without it.
 * Calling one plumbing and the other a capability would be a split with nothing
 * behind it.
 *
 * The concrete reason to be on the list rather than beside it: nothing outside
 * `capabilities.manifest.json` is watched. No `verify:without`, no platform
 * check, no permissions audit, and `capability:remove` cannot cut it out. This
 * repository's whole discipline is that unwatched things drift.
 *
 * ## Why it declares `requires: ['peer']` when it uses no peer-to-peer anything
 *
 * It needs the ENVELOPE — the code that turns a service call into bytes and
 * back — and that currently lives in `src/capabilities/peer/lib/envelope.ts`.
 * Nothing about the envelope is peer-to-peer; it was simply written where its
 * first caller was.
 *
 * So this dependency is honest but misshapen, and the fix is not to fake it
 * here. **The envelope's home is the real question**, and now that two
 * transports need it, the kernel is the defensible answer. Revisit when a third
 * caller appears or when `peer` is next opened; until then this declaration
 * says what is true.
 *
 * ## What is NOT here yet
 *
 * Everything the webview does with the wire: the `Channel` over the frame
 * commands, the remote stores, and the six-digit pane. This registration comes
 * first deliberately, so the checks are watching the capability before it has
 * anything to get wrong.
 */
export const webhost: Capability = {
  id: 'webhost',
  requires: ['peer'],
}
