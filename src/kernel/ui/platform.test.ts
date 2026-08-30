// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePlatform } from './platform'
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

  it('keeps the pin across a reload, and `auto` clears it', () => {
    pretend(MAC, 0)
    window.history.replaceState(null, '', '/?platform=ios')
    expect(resolvePlatform()).toBe('ios')

    window.history.replaceState(null, '', '/')
    expect(resolvePlatform()).toBe('ios')

    window.history.replaceState(null, '', '/?platform=auto')
    expect(resolvePlatform()).toBe('macos')
  })
})
