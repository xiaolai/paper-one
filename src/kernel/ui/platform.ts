import { useEffect, useState } from 'react'
import type { Platform } from '../core/metrics'

/**
 * Which chrome to draw.
 *
 * Design system §06 splits the window chrome three ways: macOS gets a 52px
 * overlay titlebar with the traffic lights floating over full-height cards,
 * Windows and Linux keep a real 44px titlebar row with drawn window buttons.
 * Only that choice depends on the platform, so a user-agent sniff is enough
 * and avoids pulling in the OS plugin, its capability grant and its async
 * boot path for a single branch.
 *
 * ⚠️ **THE MOBILE TESTS COME FIRST, AND THAT ORDER IS THE FIX.** This function
 * used to read `/Mac|iPhone|iPad|iPod/ -> 'macos'` — one alternation covering
 * a desktop and three handsets — so the iOS build reported itself as macOS and
 * drew a 52px overlay titlebar with three traffic lights on an iPhone. Nothing
 * downstream was wrong; they were all answering the question they were asked.
 *
 * iPadOS 13 and later report a DESKTOP user agent — `Macintosh; Intel Mac OS
 * X` — so the string alone genuinely cannot tell an iPad from a Mac, which is
 * why the old alternation looked reasonable. `maxTouchPoints` is the
 * discriminator Apple left behind: an iPad reports 5, a Mac reports 0 or 1.
 * It is checked BEFORE the Mac branch because the Mac branch would otherwise
 * claim every iPad.
 */
function detect(): Platform {
  const ua = navigator.userAgent
  if (/Android/.test(ua)) return 'android'
  if (/iPhone|iPod|iPad/.test(ua)) return 'ios'
  if (/Mac/.test(ua)) return navigator.maxTouchPoints > 1 ? 'ios' : 'macos'
  if (/Win/.test(ua)) return 'windows'
  return 'linux'
}

const OVERRIDE_KEY = 'paper.platform-override'
/* THE OVERRIDE ACCEPTS THE MOBILE ONES TOO, so `?platform=ios` pins the phone
   chrome in the desktop dev server and the mobile shell can be checked against
   the design without a simulator. `web` stays out: it is what the browser
   client resolves to on its own, and pinning it inside a Tauri window would
   claim there is no titlebar when there is one. */
const PLATFORMS: readonly Platform[] = ['macos', 'windows', 'linux', 'ios', 'android']

function isPlatform(value: string | null): value is Platform {
  return value !== null && (PLATFORMS as readonly string[]).includes(value)
}

/**
 * Read a design-review override: `?platform=windows` pins the chrome so the
 * Windows and Linux titlebars can be checked against the design from a Mac.
 * The query parameter persists into localStorage so a reload keeps it; pass
 * `?platform=auto` to clear.
 */
function override(): Platform | null {
  const requested = new URLSearchParams(window.location.search).get('platform')
  if (requested === 'auto') {
    window.localStorage.removeItem(OVERRIDE_KEY)
    return null
  }
  if (isPlatform(requested)) {
    window.localStorage.setItem(OVERRIDE_KEY, requested)
    return requested
  }
  const stored = window.localStorage.getItem(OVERRIDE_KEY)
  return isPlatform(stored) ? stored : null
}

export function resolvePlatform(): Platform {
  return override() ?? detect()
}

export function usePlatform(): Platform {
  // Resolved once at mount: the platform cannot change under a running window,
  // and the override is read from the URL that loaded it.
  const [platform] = useState<Platform>(resolvePlatform)
  return platform
}

/** True when running inside the Tauri webview rather than a plain browser. */
export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window
}

const DARK = '(prefers-color-scheme: dark)'

/**
 * A media query, or null where there is no `matchMedia` to ask.
 *
 * ⚠️ THESE HOOKS THREW during render in any environment without it, which is
 * not a hypothetical: jsdom has no `matchMedia`, so the first component test to
 * mount something using one failed with `window.matchMedia is not a function`
 * — at the `useState` initialiser, before anything could catch it. A hook that
 * reports an OPTIONAL system preference must not be able to take a render down;
 * the honest answer where the question cannot be asked is "no preference
 * stated", which is what both defaults below say.
 */
function match(query: string): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(query) : null
}

/**
 * Whether the reader has asked their system for less movement.
 *
 * Not a setting this app offers. The page turn animates, always, and there is
 * deliberately no control for it — one behaviour is simpler to hold in the head
 * than three. This is the single exception, and it is not an option in any
 * meaningful sense: animation-induced discomfort is a health matter, the person
 * affected has already said so once at the system level, and asking them to say
 * it again in every application is the thing the system preference exists to
 * stop. There is no UI for it, and no way to switch it on from inside Paper.
 */
export function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduce, setReduce] = useState(() => match(query)?.matches ?? false)
  useEffect(() => {
    const media = match(query)
    if (media === null) return
    const onChange = (e: MediaQueryListEvent) => setReduce(e.matches)
    media.addEventListener('change', onChange)
    /* Re-read after subscribing, not only before. The lazy initialiser runs
     * during render and the subscription lands after commit; a preference that
     * changed in between would be missed by both, and — since nothing else ever
     * reads it — missed for the rest of the session. */
    setReduce(media.matches)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return reduce
}

/**
 * Follow the OS colour scheme. Design system §05: the system follows the OS by
 * default, with an explicit override in Settings.
 */
export function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() => match(DARK)?.matches ?? false)
  useEffect(() => {
    const query = match(DARK)
    if (query === null) return
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return dark
}
