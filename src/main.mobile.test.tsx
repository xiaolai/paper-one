// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The mobile composition root — what it hands the shell, and what it refuses.
 *
 * ⚠️ **IT DROPPED THE STORE'S NOTICE AND NOTHING SAID SO.** The desktop root has
 * always forwarded `bootNotice`; this one did not, so a phone whose store was
 * damaged and moved aside drew an ordinary empty library with nothing anywhere
 * explaining where the books went. No test imported this file at all, which is
 * how a missing prop on the one line that mounts the shell went unseen.
 *
 * The launch itself (`bootApp`) and the shell (`MobileApp`) have tests of their
 * own and are replaced here; what is left is exactly this file's job — the root
 * element, the geometry published before the first render, and the wiring
 * between the two. The module is imported INSIDE each case rather than at the
 * top, because its work is done at import time: a throw there would fail the
 * suite's loading rather than a test, and a suite that fails to load is not a
 * test that failed.
 */

const launch = vi.hoisted(() => ({
  booted: null as unknown,
  drawn: [] as { props: Record<string, unknown>; titlebar: string }[],
  firstFrames: [] as unknown[],
  fatalHandlers: 0,
}))

vi.mock('./app/bootApp', () => ({
  bootApp: async () => launch.booted,
  reportFirstFrame: (booted: unknown) => {
    launch.firstFrames.push(booted)
  },
}))

vi.mock('./app/mobile/MobileApp', () => ({
  MobileApp: (props: Record<string, unknown>) => {
    /* What the geometry was AT THE MOMENT THE SHELL DREW — the root publishes it
       before anything reads it, and a shell drawn first has controls with no
       dimensions. */
    launch.drawn.push({
      props,
      titlebar: document.documentElement.style.getPropertyValue('--titlebar-h'),
    })
    return <p data-shell="mobile">the mobile shell</p>
  },
}))

vi.mock('./kernel/ui/boot', () => ({
  installFatalHandlers: () => {
    launch.fatalHandlers += 1
  },
}))

const SERVICES = { name: 'services' }
const COMPOSITION = { name: 'composition' }
const NOTICE = 'Your library could not be read, so it was moved aside and a new one started.'

beforeEach(() => {
  vi.resetModules()
  launch.booted = { services: SERVICES, shelfUnread: true, composition: COMPOSITION, bootNotice: NOTICE }
  launch.drawn = []
  launch.firstFrames = []
  launch.fatalHandlers = 0
  /* A PHONE, as the page asks for one — `platform.ts` honours `?platform=` so the
     phone chrome can be checked without a simulator. */
  window.history.replaceState({}, '', '/?platform=ios')
  document.documentElement.removeAttribute('style')
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

describe('the mobile root', () => {
  it('draws the mobile shell with everything the launch produced — the store’s notice included', async () => {
    const host = rootElement()
    await import('./main.mobile')
    await vi.waitFor(() => expect(host.querySelector('[data-shell="mobile"]')).not.toBeNull())
    expect(launch.drawn.at(-1)?.props).toEqual({
      services: SERVICES,
      shelfUnread: true,
      composition: COMPOSITION,
      bootNotice: NOTICE,
    })
    expect(launch.fatalHandlers, 'a failure before the shell drew would reach nobody').toBe(1)
    expect(launch.firstFrames, 'the first frame was not reported, or not for this launch').toEqual([launch.booted])
  })

  it('publishes a phone’s geometry before the shell draws — no titlebar on a phone', async () => {
    /* A phone has no window, so no titlebar; before `Platform` knew about phones
       this root reserved a 52px band for one. */
    rootElement()
    await import('./main.mobile')
    await vi.waitFor(() => expect(launch.drawn.length).toBeGreaterThan(0))
    expect(launch.drawn[0]?.titlebar).toBe('0px')
  })

  it('refuses to start without its root element, and names the page that should hold it', async () => {
    const cause = await import('./main.mobile').then(
      () => null,
      (error: unknown) => error,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe('#root is missing from index.mobile.html')
    expect(launch.drawn, 'a shell was drawn with nowhere to draw it').toEqual([])
  })
})
