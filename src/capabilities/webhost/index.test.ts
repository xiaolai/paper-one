import { describe, expect, it, vi } from 'vitest'
import type { CapabilityContext, Disposable, ServiceContribution } from '../../kernel'

/**
 * ⚠️ **THE ONE CAPABILITY OF THE THREE WITH NO TEST AT ALL, AND THE ONE THAT
 * STILL HAD THE DEFECT THE OTHER TWO WERE CONVERTED TO AVOID.**
 *
 * `renderSlot.test.ts` records the shape: with two live compositions "the
 * second overwrote the first, and then stopping the SECOND…". `inference` and
 * `companion` were moved onto `createRenderSlot` because of it; `webhost` was
 * not, and its `stop` closure read the module-level `pump` rather than the one
 * its own lifetime created. Tearing down an outgoing composition therefore
 * stopped the INCOMING one's pump — after which every connected browser had its
 * frames drained by nothing, silently, because a stopped pump is exactly as
 * quiet as an idle one — and left its own pump running for ever, because
 * nothing else held a reference to it.
 *
 * **What makes it observable is the leak, not the stop.** Both pumps poll the
 * same wire, so counting polls cannot say WHICH is polling. Starting two,
 * stopping both, and then asking whether anything is still polling can: with
 * the defect, A's teardown stops B and clears the slot, so B's teardown finds
 * nothing and A's own pump polls for ever.
 *
 * `tauriWire` is replaced because it is the PLATFORM BINDING — the one thing
 * here that cannot exist in a test — and `wireOf` memoises it in module state,
 * so there is no seam to inject through. Everything else is the real capability.
 */
const probe = vi.hoisted(() => ({ polls: 0 }))

vi.mock('./lib/wire', async (importActual) => {
  const actual = await importActual<typeof import('./lib/wire')>()
  return {
    ...actual,
    tauriWire: () =>
      actual.fakeWire({
        /* Counted, and never answers a session: the pump idles rather than
           driving a protocol this test is not about. */
        sessions: async () => {
          probe.polls += 1
          return []
        },
      }),
  }
})

const { webhost } = await import('./index')

const PING = {
  name: 'shelf.status',
  grant: 'shelf:read',
  handler: async () => ({}),
} as unknown as ServiceContribution

/** One composition's worth of `api`, with the service host driven by hand. */
function composition() {
  const api = {
    services: {
      bindServiceHost: (bind: (list: readonly ServiceContribution[]) => Promise<Disposable>) => {
        void bind([PING])
        return { dispose: () => {} }
      },
    },
    diagnostics: { warn: () => {}, info: () => {} },
  } as unknown as CapabilityContext
  return { api, controller: new AbortController() }
}

/* 700 ms, because `SESSIONS_MS` is 500 and this capability constructs its pump
   with the default — there is no seam to shorten it through, which is the same
   absence of a seam that kept this file from existing. Real timers, and the
   assertion is a COUNT rather than a duration: it asks whether polling stopped,
   not how fast anything was. */
const settle = (ms = 700) => new Promise((done) => setTimeout(done, ms))

describe('two live compositions of the webhost', () => {
  it('each teardown stops its own pump, so stopping both leaves nothing polling', async () => {
    const first = composition()
    const firstStop = await webhost.start!(first.api, first.controller.signal)
    await settle()
    const second = composition()
    const secondStop = await webhost.start!(second.api, second.controller.signal)
    await settle()

    /* NON-VACUOUS: the pumps really are running, so "nothing polls" below is a
       fact about the teardown and not about the harness. */
    const whileRunning = probe.polls
    await settle()
    expect(probe.polls, 'two live pumps are polling').toBeGreaterThan(whileRunning)

    firstStop.dispose()
    secondStop.dispose()
    await settle()

    const afterBothStopped = probe.polls
    await settle(900)
    expect(probe.polls, 'both pumps stopped, so nothing is left polling').toBe(afterBothStopped)
  })
})
