// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { resolvePlatform, usePrefersDark, usePrefersReducedMotion } from './platform'
import type { Platform } from '../core/metrics'

/**
 * WHICH DEVICE THIS IS, and the alternation that got it wrong for every phone.
 *
 * `detect()` read `/Mac|iPhone|iPad|iPod/ -> 'macos'` — one branch covering a
 * desktop and three handsets — so the iOS build reported itself as macOS. The
 * six `platform === 'macos'` comparisons downstream then drew a 52px overlay
 * titlebar and three traffic lights on an iPhone. Every one of them was
 * answering correctly; the question was wrong.
 *
 * These cases are real user-agent strings rather than shapes, because the trap
 * is entirely in what the strings actually say: iPadOS 13+ reports
 * `Macintosh; Intel Mac OS X` and is distinguishable from a Mac only by
 * `maxTouchPoints`. A test written from memory of what an iPad "should" send
 * would have passed against the broken code.
 */

const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
/* THE ONE THAT LOOKS LIKE A MAC. Verbatim from iPadOS 17 Safari — no `iPad`
   anywhere in it. This is the case the discriminator exists for. */
const IPAD_DESKTOP_UA = MAC
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function pretend(ua: string, maxTouchPoints: number): void {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })
  Object.defineProperty(window.navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true })
}

afterEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
})

describe('which device this is', () => {
  const cases: readonly { device: string; ua: string; touch: number; is: Platform }[] = [
    { device: 'an iPhone', ua: IPHONE, touch: 5, is: 'ios' },
    { device: 'an iPad, which sends a desktop user agent', ua: IPAD_DESKTOP_UA, touch: 5, is: 'ios' },
    { device: 'a Mac, which sends the same one', ua: MAC, touch: 0, is: 'macos' },
    { device: 'a Mac with a touch-capable trackpad', ua: MAC, touch: 1, is: 'macos' },
    { device: 'an Android phone', ua: ANDROID, touch: 5, is: 'android' },
    { device: 'Windows', ua: WINDOWS, touch: 0, is: 'windows' },
    { device: 'Linux', ua: LINUX, touch: 0, is: 'linux' },
  ]

  it.each(cases)('$device resolves to $is', ({ ua, touch, is }) => {
    pretend(ua, touch)
    expect(resolvePlatform()).toBe(is)
  })

  /* THE REGRESSION, stated as its own case rather than left implicit in the
     table above: no handset may resolve to a desktop platform, because that is
     precisely what put traffic lights on a phone. */
  it.each([
    { device: 'an iPhone', ua: IPHONE, touch: 5 },
    { device: 'an iPad', ua: IPAD_DESKTOP_UA, touch: 5 },
    { device: 'an Android phone', ua: ANDROID, touch: 5 },
  ])('$device is never a desktop platform', ({ ua, touch }) => {
    pretend(ua, touch)
    expect(['macos', 'windows', 'linux']).not.toContain(resolvePlatform())
  })
})

describe('the design-review override', () => {
  /* The mobile chrome has to be checkable from a Mac, or it is checkable only
     by launching a simulator — which is how it went unchecked in the first
     place. */
  it.each(['ios', 'android'] as const)('pins %s from the query string', (platform: Platform) => {
    pretend(MAC, 0)
    window.history.replaceState(null, '', `/?platform=${platform}`)
    expect(resolvePlatform()).toBe(platform)
  })

  /* ⚠️ **A RELOAD IS A FRESH MODULE, and this case has to be one too.**
   *
   * The pin is written down ONCE, when the module is evaluated — that is the
   * page load the query parameter belongs to, and it is what keeps
   * `resolvePlatform` pure enough to be called from a `useState` initialiser.
   * An earlier version of this case mutated `window.history` and called
   * `resolvePlatform()` again in the same module instance, which exercised the
   * write-during-resolve that no longer happens; it went red the moment the
   * write moved, over a capability that was never broken. Re-importing is what
   * a reload actually is. */
  async function load(url: string): Promise<typeof import('./platform')> {
    window.history.replaceState(null, '', url)
    vi.resetModules()
    return import('./platform')
  }

  it('keeps the pin across a reload, and `auto` clears it', async () => {
    pretend(MAC, 0)
    expect((await load('/?platform=ios')).resolvePlatform()).toBe('ios')
    /* A second load with no parameter at all: the pin is remembered. */
    expect((await load('/')).resolvePlatform()).toBe('ios')
    /* And `auto` forgets it, for this load and the next. */
    expect((await load('/?platform=auto')).resolvePlatform()).toBe('macos')
    expect((await load('/')).resolvePlatform()).toBe('macos')
  })

  /* A STORE THAT THROWS MUST NOT TAKE THE RENDER DOWN. `resolvePlatform` runs
     inside a `useState` initialiser, so this is the difference between wrong
     chrome and a white window. */
  /* A `getItem` THAT THROWS, which is not the same as a store you cannot
     reach — see `remembered()`. The first version of the storage guard covered
     only the reach, and an independent verify pass caught the half. */
  it('still resolves when localStorage.getItem throws', async () => {
    pretend(MAC, 0)
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem() {
          throw new Error('blocked by policy')
        },
        setItem() {},
        removeItem() {},
        clear() {},
      },
    })
    try {
      expect((await load('/')).resolvePlatform()).toBe('macos')
    } finally {
      if (real) Object.defineProperty(window, 'localStorage', real)
    }
  })

  it('still resolves when localStorage is unavailable', async () => {
    pretend(MAC, 0)
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage is disabled')
      },
    })
    try {
      /* The query parameter still governs THIS load; only remembering it is
         lost — and, crucially, nothing throws out of a render. */
      expect((await load('/?platform=ios')).resolvePlatform()).toBe('ios')
      expect((await load('/')).resolvePlatform()).toBe('macos')
    } finally {
      /* ⚠️ RESTORED IN `finally`, not after the assertions. A throwing store
         left in place takes out this file's own `afterEach`, which calls
         `localStorage.clear()` — the first version of this case failed five
         unrelated tests that way, all reporting "storage is disabled". */
      if (real) Object.defineProperty(window, 'localStorage', real)
    }
  })
})

/**
 * THE COLOUR SCHEME, AND THE CHANGE THAT ARRIVES DURING MOUNT.
 *
 * `usePrefersDark` and `usePrefersReducedMotion` were written out separately
 * and drifted: only the second re-read after subscribing, so a change landing
 * between the lazy initialiser (render) and the subscription (after commit) was
 * missed by both — and, since nothing else reads the value, missed for the rest
 * of the session. A reader who flipped their Mac to dark while the window was
 * opening got a light book until they flipped it back and forth again.
 *
 * Both hooks come from one `useMediaQuery` now. These cases run against BOTH,
 * so a future copy that re-introduces the split fails here.
 */
type Listener = (event: MediaQueryListEvent) => void

function fakeMatchMedia() {
  const state = { matches: false, listeners: [] as Listener[] }
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return state.matches
    },
    addEventListener: (_: string, fn: Listener) => state.listeners.push(fn),
    removeEventListener: (_: string, fn: Listener) => {
      state.listeners = state.listeners.filter((l) => l !== fn)
    },
  }))
  return state
}

describe.each([
  { name: 'usePrefersDark', hook: usePrefersDark },
  { name: 'usePrefersReducedMotion', hook: usePrefersReducedMotion },
])('$name', ({ hook }) => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('reports what the query says at mount', () => {
    const media = fakeMatchMedia()
    media.matches = true
    expect(renderHook(() => hook()).result.current).toBe(true)
  })

  it('follows a later change', () => {
    const media = fakeMatchMedia()
    const { result } = renderHook(() => hook())
    expect(result.current).toBe(false)
    act(() => {
      media.matches = true
      for (const fn of media.listeners) fn({ matches: true } as MediaQueryListEvent)
    })
    expect(result.current).toBe(true)
  })

  /* ⚠️ THE CASE THE DRIFT COST. The value flips after the render that read it
     and before the effect that subscribes — no `change` event is ever
     delivered to this hook, so only a re-read at subscription time catches
     it. */
  it('catches a change that lands between the first render and the subscription', () => {
    const media = fakeMatchMedia()
    const { result } = renderHook(() => {
      const value = hook()
      /* Flip it DURING render, after the initialiser has already read false. */
      media.matches = true
      return value
    })
    expect(result.current).toBe(true)
  })

  it('answers the fallback where there is no matchMedia at all', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(renderHook(() => hook()).result.current).toBe(false)
  })
})
