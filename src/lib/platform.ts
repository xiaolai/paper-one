import { useEffect, useState } from 'react'
import type { Platform } from './metrics'

/**
 * Which chrome to draw.
 *
 * Design system §06 splits the window chrome three ways: macOS gets a 52px
 * overlay titlebar with the traffic lights floating over full-height cards,
 * Windows and Linux keep a real 44px titlebar row with drawn window buttons.
 * Only that choice depends on the platform, so a user-agent sniff is enough
 * and avoids pulling in the OS plugin, its capability grant and its async
 * boot path for a single three-way branch.
 */
function detect(): Platform {
  const ua = navigator.userAgent
  if (/Mac|iPhone|iPad|iPod/.test(ua)) return 'macos'
  if (/Win/.test(ua)) return 'windows'
  return 'linux'
}

const OVERRIDE_KEY = 'paper.platform-override'
const PLATFORMS: readonly Platform[] = ['macos', 'windows', 'linux']

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

/**
 * Follow the OS colour scheme. Design system §05: the system follows the OS by
 * default, with an explicit override in Settings.
 */
export function usePrefersDark(): boolean {
  const [dark, setDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return dark
}
