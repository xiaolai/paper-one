import { messageOf } from '../../kernel'
import { createElement } from 'react'
import type { Capability, Disposable } from '../../kernel'
import { BrowsersPane } from './ui/BrowsersPane'
import { tauriWire, type WebHostWire } from './lib/wire'
import { servePipe, type Pump } from './lib/pump'

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
 * ## Serving the router
 *
 * `start()` runs the pump, which is the webview's half of the frame pipe. The
 * Rust side puts a browser's frames in a session inbox; without something
 * taking them out, a browser signs in, opens its channel, calls `book.list` and
 * waits for ever — which is exactly what it did until this was wired.
 *
 * Same shape as `peer`: the capability holds the transport and serves the
 * kernel's own services over it. The difference is what a peer is. `peer`
 * carries per-peer grants from `peers.json`; a browser has one grant, "signed
 * in", enforced at the socket by a credential the shelf issued.
 */
/* One wire for the capability's lifetime. Built lazily so that merely importing
 * this module does not call into a plugin — a composition imports every
 * capability's index before anything starts. */
let wire: WebHostWire | null = null
const wireOf = (): WebHostWire => (wire ??= tauriWire())

let pump: Pump | null = null

export const webhost: Capability = {
  id: 'webhost',
  requires: ['peer'],

  start(api, signal): Disposable {
    /* TEARDOWN REGISTERED BEFORE ANYTHING IS ACQUIRED, the order `peer`'s own
     * `start` uses: a failure part-way through leaves nothing running. */
    const stop = () => {
      pump?.stop()
      pump = null
      host?.dispose()
      host = null
    }
    let host: Disposable | null = null
    if (signal.aborted) return { dispose: stop }

    /* THE KERNEL HANDS THE SERVICES BACK. A capability does not know the
     * composed set — `registry.ts` calls every bound host once, after every
     * capability has started, with the whole of it. `peer` binds one too; the
     * slot became a SET in phase 18 so both transports can carry the same
     * services, which is what a transport is for. */
    host = api.services.bindServiceHost(async (services) => {
      if (signal.aborted || services.length === 0) return { dispose: () => {} }
      pump = servePipe({
        wire: wireOf(),
        services,
        onError: (thrown) =>
          api.diagnostics.warn('webhost.pump', {
            error: messageOf(thrown),
          }),
      })
      const running = pump
      return {
        dispose: () => {
          running.stop()
          if (pump === running) pump = null
        },
      }
    })

    signal.addEventListener('abort', stop, { once: true })
    return { dispose: stop }
  },

  settings: [
    {
      id: 'webhost:browsers',
      /* NOT "Devices". `peer` already contributes that, and the two hold
       * different things: a device is trusted BY KEY, pairs once and syncs; a
       * browser is signed in BY CODE, streams everything and keeps nothing.
       * One word for both would make the first mis-revocation inevitable. */
      title: 'Browsers',
      /* After Devices (20), which is the pane a reader looking for this will
       * try first. A declared number rather than a default, so neither moves
       * when the other changes its mind. */
      order: 24,
      render: () => createElement(BrowsersPane, { wire: wireOf() }),
    },
  ],
}
