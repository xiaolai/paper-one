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
     * `start` uses: a failure part-way through leaves nothing running.
     *
     * ⚠️ **IT STOPPED WHATEVER `pump` HELD, NOT ITS OWN.** `pump` is module
     * state and this closure ran on teardown, so with two live compositions —
     * two `start`s with no `stop` between them, which the registry permits and
     * a test does routinely — the second overwrote the first, and then stopping
     * the SECOND reached into the FIRST's pump and stopped it. Every connected
     * browser had its frames drained by nothing, with no error anywhere,
     * because a stopped pump is exactly as quiet as an idle one.
     *
     * The inner disposer twenty lines below already guarded this
     * (`if (pump === running)`); this one did not, which is why the defect
     * survived. `index.test.ts` measures it by the LEAK rather than by the
     * stop, for the reason its own header gives.
     *
     * ⚠️ **A `core/renderSlot.ts` HELD THE GENERAL ANSWER — A STACK, so
     * releasing any holder restores the most recent one still live — AND IT IS
     * DELETED.** Its only two callers were `inference` and `companion`, which
     * went with every other AI feature; `webhost` was the one capability never
     * converted to it. The ownership check here is the hand-rolled version and
     * is what actually ships. If a third capability meets this, rebuild the
     * stack from this paragraph rather than looking for the module. */
    let mine: Pump | null = null
    const stop = () => {
      mine?.stop()
      if (pump === mine) pump = null
      mine = null
      host?.dispose()
      host = null
      signal.removeEventListener('abort', stop)
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
      /* ⚠️ **ONE PUMP ON THE WIRE, AND THE SECOND USED TO JOIN THE FIRST.**
       * `wire` is a module singleton, and this assigned over `pump` without
       * stopping what it replaced — so two live compositions (two `start`s with
       * no `stop` between them, which the registry permits and this file's own
       * tests do) left TWO pumps polling one session inbox, each with its own
       * router and `openedBy`. Related frames of one browser could then be
       * answered by different pumps, and only the newer was reachable to stop.
       * The disposers below were already ownership-checked; what was missing is
       * that taking the wire has to RELEASE it first. Found by the 2026-09-19
       * audit.
       *
       * `stop()` is idempotent (`pump.ts` returns early once stopped), so this
       * is safe when the previous holder has already gone. */
      pump?.stop()
      pump = servePipe({
        wire: wireOf(),
        services,
        onError: (thrown) =>
          api.diagnostics.warn('webhost.pump', {
            error: messageOf(thrown),
          }),
      })
      const running = pump
      mine = running
      return {
        dispose: () => {
          running.stop()
          if (pump === running) pump = null
          if (mine === running) mine = null
        },
      }
    })

    /* ⚠️ **`api.onCleanup(stop)` WAS ADDED HERE AND TAKEN OUT AGAIN**, on the
     * 2026-09-19 audit's suggestion that the teardown was never registered with
     * the kernel. It is: `registry.ts` folds the RETURNED `Disposable` into
     * teardown and runs it before the `onCleanup` stack ("Both run on normal
     * dispose"), and `stop` is that disposer. Registering it twice would only
     * call an idempotent function twice. Written down because the suggestion is
     * a reasonable reading of the comment above, and the next reader deserves
     * the answer rather than the round trip.
     *
     * THE ABORT LISTENER IS REMOVED BY `stop` ITSELF, so a manual dispose does
     * not leave this closure retained until the signal is collected — that half
     * of the finding was real. */
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
