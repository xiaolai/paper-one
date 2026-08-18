import { useLayoutEffect } from 'react'
import { BRIGHTNESS, CONTRAST, stepAt } from './metrics'
import { adjustPalette, type Palette } from './palette'
import type { Theme } from './state'

/**
 * Apply the reader's brightness and contrast to the whole app.
 *
 * THE BASE COLOURS ARE READ FROM THE THEME, not restated here. Every theme in
 * `tokens.css` is an attribute selector, so an off-screen element carrying
 * `data-theme` resolves that theme's palette and can be measured — the same
 * trick the Appearance swatches use to draw themselves. A table of hexes in
 * TypeScript would be a second copy of the colour system, which is exactly what
 * the swatches stopped being.
 *
 * Written as INLINE custom properties on the element that carries `data-theme`.
 * An inline declaration beats the attribute rule on the same element, so the
 * override lands without touching the cascade anywhere else, and clearing it
 * restores the theme exactly.
 *
 * A LAYOUT EFFECT, so the adjusted palette is in place before the browser
 * paints. In a plain effect the app paints once at full brightness and then
 * dims, which at night is precisely the flash the setting exists to avoid.
 */
const KEYS = [
  /* The background, which `brightness` moves — the rules included, or a dimmed
     page ends up lighter than its own borders. */
  '--surface',
  '--bg',
  '--wash',
  '--line',
  '--line-2',
  '--line-3',
  /* The font, which `contrast` moves. */
  '--ink',
  '--ink-2',
  '--muted',
] as const

/** Read a theme's own palette, uninfluenced by any override in force. */
function baseFor(theme: Theme): Palette | null {
  if (typeof document === 'undefined') return null
  const probe = document.createElement('div')
  probe.setAttribute('data-theme', theme)
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
  document.body.appendChild(probe)
  const cs = getComputedStyle(probe)
  const read = (key: string) => cs.getPropertyValue(key).trim()
  const base: Palette = {
    surface: read('--surface'),
    bg: read('--bg'),
    wash: read('--wash'),
    line: read('--line'),
    line2: read('--line-2'),
    line3: read('--line-3'),
    ink: read('--ink'),
    ink2: read('--ink-2'),
    muted: read('--muted'),
  }
  probe.remove()
  return base.surface && base.ink ? base : null
}

export function useAppPalette(
  host: HTMLElement | null,
  theme: Theme,
  brightness: number,
  contrast: number,
): void {
  useLayoutEffect(() => {
    if (!host) return
    const base = baseFor(theme)
    if (!base) return
    const next = adjustPalette(base, stepAt(BRIGHTNESS, brightness), stepAt(CONTRAST, contrast))
    const values: Record<(typeof KEYS)[number], string> = {
      '--surface': next.surface,
      '--bg': next.bg,
      '--wash': next.wash,
      '--line': next.line,
      '--line-2': next.line2,
      '--line-3': next.line3,
      '--ink': next.ink,
      '--ink-2': next.ink2,
      '--muted': next.muted,
    }
    for (const key of KEYS) host.style.setProperty(key, values[key])
    return () => {
      /* Cleared rather than left at the last value: the theme's own colours are
       * the truth, and a stale override on a theme the reader has since changed
       * would be a palette from the previous one. */
      for (const key of KEYS) host.style.removeProperty(key)
    }
  }, [host, theme, brightness, contrast])
}
