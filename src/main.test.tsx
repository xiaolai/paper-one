// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The desktop composition root — what it hands the launch and the window, and
 * what it refuses.
 *
 * No test imported this file until 2026-11-02, when it took on importing this
 * build's composition: a change to it then had nothing a sweep could mutate
 * against (`no-test-found` in `scripts/check-mutants.mjs`), and the wiring below
 * was held by the type check alone, which cannot tell `diagnosticLog` left out
 * from `diagnosticLog` passed.
 *
 * The launch (`bootApp`) and the window (`App`) have tests of their own and are
 * replaced here. The module is imported INSIDE each case rather than at the top,
 * because its work is done at import time, exactly as in `main.mobile.test.tsx`.
 *
 * ⚠️ **THE `vi.mock` OF THE COMPOSITION IS THE ONE THIS FILE CANNOT DROP**, because
 * handing it on is this entry's job. It puts this file and `main.tsx` on a route
 * the mutation gate cannot see down, so a change to either leaves nothing in a
 * sweep authorised (`unseenAtBase`). That is why the entry holds no more than it
 * must: `dev-docs/decisions/2026-11-02-composition-route.md`.
 */

const launch = vi.hoisted(() => ({
  booted: null as unknown,
  /* What the build composes, and each list the launch was then handed. */
  composed: [{ id: 'one capability of this build' }],
  handed: [] as unknown[],
  drawn: [] as Record<string, unknown>[],
  firstFrames: [] as unknown[],
  fatalHandlers: 0,
}))

vi.mock('./app/bootApp', () => ({
  bootApp: async (capabilities: unknown) => {
    launch.handed.push(capabilities)
    return launch.booted
  },
  reportFirstFrame: (booted: unknown) => {
    launch.firstFrames.push(booted)
  },
}))

vi.mock('virtual:paper-composition', () => ({ capabilities: launch.composed }))

vi.mock('./kernel/ui', () => ({
  App: (props: Record<string, unknown>) => {
    launch.drawn.push(props)
    return <p data-shell="desktop">the window</p>
  },
  installFatalHandlers: () => {
    launch.fatalHandlers += 1
  },
}))

const LAUNCHED = {
  services: { name: 'services' },
  fs: { name: 'fs' },
  shelfUnread: true,
  bootNotice: 'Your library could not be read, so it was moved aside and a new one started.',
  composition: { name: 'composition' },
  beforeWindowClose: { name: 'beforeWindowClose' },
  openRequests: { name: 'openRequests' },
}
const LOG = { name: 'diagnosticLog' }
const CLEARED = { name: 'onDiagnosticsCleared' }

beforeEach(() => {
  vi.resetModules()
  launch.handed = []
  launch.drawn = []
  launch.firstFrames = []
  launch.fatalHandlers = 0
})

afterEach(() => {
  document.body.replaceChildren()
})

function rootElement(): HTMLElement {
  const host = document.createElement('div')
  host.id = 'root'
  document.body.append(host)
  return host
}

describe('the desktop root', () => {
  /* ABSENCE MEANS "THIS BUILD RECORDS NOTHING": the Developer panel draws a
     different surface for that than for "nothing to show", so a null must not
     reach the window as a prop at all. Each of the two is spread on its own. */
  it.each([
    { recording: 'a log and a file', log: LOG, cleared: CLEARED, extra: { diagnosticLog: LOG, onDiagnosticsCleared: CLEARED } },
    { recording: 'a log and no file', log: LOG, cleared: null, extra: { diagnosticLog: LOG } },
    { recording: 'neither', log: null, cleared: null, extra: {} },
  ])('draws the window with everything the launch produced, when it is recording $recording', async ({ log, cleared, extra }) => {
    launch.booted = { ...LAUNCHED, diagnosticLog: log, onDiagnosticsCleared: cleared }
    const host = rootElement()
    await import('./main')
    await vi.waitFor(() => expect(host.querySelector('[data-shell="desktop"]')).not.toBeNull())

    expect(launch.drawn.at(-1)).toEqual({ ...LAUNCHED, ...extra })
    expect(launch.handed, 'the launch was not handed this build’s composition').toEqual([launch.composed])
    expect(launch.fatalHandlers, 'a failure before the window drew would reach nobody').toBe(1)
    expect(launch.firstFrames, 'the first frame was not reported, or not for this launch').toEqual([launch.booted])
  })

  it('refuses to start without its root element, and names the page that should hold it', async () => {
    const cause = await import('./main').then(
      () => null,
      (error: unknown) => error,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe('#root is missing from index.html')
    expect(launch.handed, 'a launch began with nowhere to draw it').toEqual([])
  })
})
