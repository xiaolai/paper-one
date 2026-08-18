import { createElement } from 'react'
import type { Capability, Disposable, KernelApi } from '../../kernel'
import { ExamplePane } from './ui/ExamplePane'

/**
 * The `example` capability — a no-op that exercises EVERY registration
 * surface, so that removing it (WI-5.12, `pnpm capability:remove example`)
 * proves something: one pane, one command, one service, and a `start` that
 * begins a timer its `Disposable` ends. It exists to be deleted.
 *
 * Its ids are namespaced the way the registry demands — `example:` for the
 * pane and the command, `example.` for the service, `example:` for the
 * grant — and it imports the kernel through its public entry only.
 */

/** How often the heartbeat says it is alive. Slow: it proves the lifecycle, not a clock. */
export const HEARTBEAT_MS = 5 * 60_000

export const example: Capability = {
  id: 'example',
  requires: [],

  panes: [
    {
      id: 'example:pane',
      label: 'Example',
      screens: ['library', 'reader'],
      render: () => createElement(ExamplePane),
    },
  ],

  commands: (ctx) => [
    {
      id: 'example:hello',
      label: 'Say hello',
      group: 'Example',
      keywords: 'example capability demo',
      on: ctx.pane === 'example:pane',
      run: () => ctx.openPane('example:pane'),
    },
  ],

  services: [
    {
      name: 'example.ping',
      grant: 'example:ping',
      /* Echoes the request body: the smallest honest service. */
      handler: async (req) => req,
    },
  ],

  start(api: KernelApi, signal: AbortSignal): Disposable {
    let ticks = 0
    const timer = setInterval(() => {
      ticks++
      api.diagnostics.info('example.heartbeat', { ticks })
    }, HEARTBEAT_MS)
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      signal.removeEventListener('abort', stop)
    }
    /* Both roads lead here: the composition's `dispose()`, and its lifetime
     * signal aborting. `stop` is idempotent so the second arrival is nothing. */
    signal.addEventListener('abort', stop, { once: true })
    api.diagnostics.info('example.started')
    return { dispose: stop }
  },
}
