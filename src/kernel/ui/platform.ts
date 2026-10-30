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
/**
 * `localStorage`, or nothing.
 *
 * ⚠️ **EVERY ACCESS WAS BARE, AND THIS ONE CANNOT AFFORD TO THROW.** Reading or
 * writing `localStorage` raises in a browser where storage is disabled, in
 * Safari's private mode past its quota, and behind some enterprise policies.
 * `resolvePlatform` runs as a `useState` initialiser — inside render — so a
 * throw there does not degrade the chrome, it takes the whole app down before
 * anything is drawn. The rest of this file already refuses to let an OPTIONAL
 * system preference kill a render (`match()` above); a design-review
 * convenience has even less claim to.
 */
function store(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * What was written down last time, or null if it cannot be read.
 *
 * ⚠️ **THE READ NEEDS ITS OWN GUARD, not just the reach for the object.**
 * `store()` catches a `window.localStorage` that throws on ACCESS, which is
 * what a disabled-storage browser does — but `getItem` can throw on its own
 * behind some enterprise policies and in a corrupted profile, and that throw
 * lands in `resolvePlatform`, which runs inside a `useState` initialiser. The
 * first version of this fix guarded only the access, and an independent verify
 * pass caught the half.
 */
function remembered(): string | null {
  try {
    return store()?.getItem(OVERRIDE_KEY) ?? null
  } catch {
    return null
  }
}

/**
 * The pinned override, if one was asked for or remembered.
 *
 * PURE — it only reads. The WRITE that used to live here happens once at module
 * load (`rememberOverride` below), because this is called from a `useState`
 * initialiser and from `useMemo`: React may run a render calculation twice or
 * throw its result away, and a function that persists on the way past is not
 * one you can call during render.
 */
function override(): Platform | null {
  const requested = new URLSearchParams(window.location.search).get('platform')
  if (requested === 'auto') return null
  if (isPlatform(requested)) return requested
  const stored = remembered()
  return isPlatform(stored) ? stored : null
}

/**
 * Persist what the URL asked for, once, at module load.
 *
 * The comment above `override` says the override is read from the URL that
 * loaded the page — so the moment to write it down is when that page loads,
 * not on whichever render happens to ask first. Failing to persist is not
 * fatal: the query parameter still governs THIS load through `override()`, and
 * only the survive-a-reload part is lost.
 */
function rememberOverride(): void {
  const requested = new URLSearchParams(window.location.search).get('platform')
  const keep = store()
  if (keep === null) return
  try {
    if (requested === 'auto') keep.removeItem(OVERRIDE_KEY)
    else if (isPlatform(requested)) keep.setItem(OVERRIDE_KEY, requested)
  } catch {
    /* A full or refused store still leaves the override honoured for this
       load. Nothing to report: the reader asked for a chrome, not for it to
       be remembered. */
  }
}

rememberOverride()

export function resolvePlatform(): Platform {
  return override() ?? detect()
}

export function usePlatform(): Platform {
  // Resolved once at mount: the platform cannot change under a running window,
  // and the override is read from the URL that loaded it.
  const [platform] = useState<Platform>(resolvePlatform)
  return platform
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
/**
 * Whether a media query matches now, and whenever it changes.
 *
 * ⚠️ **ONE HOOK, BECAUSE TWO COPIES HAD ALREADY DRIFTED.** This was written out
 * twice — once for reduced motion, once for the colour scheme — and only the
 * first copy re-read after subscribing. The second therefore had exactly the
 * bug the first one carries a paragraph explaining: the lazy initialiser runs
 * during render, the subscription lands after commit, and a change in between
 * is missed by both — and, since nothing else ever reads it, missed for the
 * rest of the session. A reader who flipped their Mac to dark while the window
 * was opening got a light book until they flipped it again.
 *
 * `match` returns null where there is no `matchMedia` (jsdom has none), and the
 * honest answer where the question cannot be asked is the fallback.
 */
function useMediaQuery(query: string, fallback = false): boolean {
  const [matches, setMatches] = useState(() => match(query)?.matches ?? fallback)
  useEffect(() => {
    const media = match(query)
    if (media === null) return
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    media.addEventListener('change', onChange)
    /* Re-read after subscribing, not only before — see the note above. */
    setMatches(media.matches)
    return () => media.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)')
}

/**
 * Follow the OS colour scheme. Design system §05: the system follows the OS by
 * default, with an explicit override in Settings.
 */
export function usePrefersDark(): boolean {
  return useMediaQuery(DARK)
}
