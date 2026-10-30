import { afterEach, describe, expect, it, vi } from 'vitest'
import { WEB_SETTINGS, browserSettings, browserStorage } from './settings'

/**
 * The reader's preferences, kept in this browser.
 *
 * THE CASE THAT MATTERS is storage that THROWS. `localStorage` is a getter, not
 * a method — reading the property is what raises in a private window or with
 * storage disabled — so `typeof localStorage` is not a guard, it is the
 * dereference. A reader in a locked-down browser must get defaults and a
 * working app, not a blank screen.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browserStorage', () => {
  it('hands back the browser’s own storage when there is one', () => {
    const fake = { getItem: () => null, setItem: () => {} }
    vi.stubGlobal('localStorage', fake)
    expect(browserStorage()).toBe(fake)
  })

  it('answers null when there is none', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(browserStorage()).toBeNull()
  })

  /* THE GETTER THROWS, not the call. This is the shape of the real failure. */
  it('answers null when reading the property throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage is disabled')
      },
    })
    expect(browserStorage()).toBeNull()
    // @ts-expect-error — remove the hostile property again
    delete globalThis.localStorage
  })
})

describe('browserSettings', () => {
  it('reads a stored value back through the setting’s own validator', () => {
    const store: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v
      },
    })
    const settings = browserSettings()
    settings.set(WEB_SETTINGS.theme, 'night')
    expect(browserSettings().get(WEB_SETTINGS.theme)).toBe('night')
  })

  /**
   * A VALUE HAND-EDITED INTO STORAGE DOES NOT REACH THE RENDERER.
   *
   * This is why the reader reads through `get` rather than out of the snapshot:
   * `get` applies each setting's validator, so `localStorage` — which anyone
   * can edit in a browser's devtools — cannot put an unknown theme into the
   * page and break the palette.
   */
  it('refuses a stored value the setting does not allow', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ version: 1, values: { 'kernel.theme': 'chartreuse' } }),
      setItem: () => {},
    })
    expect(browserSettings().get(WEB_SETTINGS.theme)).toBe(WEB_SETTINGS.theme.fallback)
  })

  /**
   * ⚠️ **A BROWSER'S QUOTA IS SMALL AND SHARED**, and `setItem` throwing is the
   * ordinary way it says so — a Safari private window refuses every write.
   * `set` used to let that escape into the `onClick` that made it, so the rest
   * of a two-field handler (theme, then "stop following the system") never ran
   * and the reader was told nothing at all.
   */
  it('degrades to session-only when the browser refuses a write', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError')
      },
    })
    const settings = browserSettings()
    expect(settings.persistent, 'a fresh store over a storage is persistent until proven otherwise').toBe(true)
    expect(() => settings.set(WEB_SETTINGS.theme, 'night')).not.toThrow()
    expect(settings.get(WEB_SETTINGS.theme), 'the choice must still apply for this session').toBe('night')
    expect(settings.persistent, 'the panel needs a state to draw, not an exception').toBe(false)
    /* AND THE SECOND FIELD OF THE SAME HANDLER STILL LANDS. This is the
       finding: a throw here abandoned it, so a reader who picked Night was left
       following the system anyway. */
    settings.set(WEB_SETTINGS.themeFollowsOs, false)
    expect(settings.get(WEB_SETTINGS.themeFollowsOs)).toBe(false)
    vi.restoreAllMocks()
  })

  it('reports a store with no storage as not persistent', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(browserSettings().persistent).toBe(false)
  })

  it('still opens with no storage at all, on the defaults', () => {
    vi.stubGlobal('localStorage', undefined)
    const settings = browserSettings()
    expect(settings.get(WEB_SETTINGS.theme)).toBe(WEB_SETTINGS.theme.fallback)
    /* AND IT STAYS USABLE: a set that cannot persist must not throw, or a
       private window turns every preference control into a crash. */
    expect(() => settings.set(WEB_SETTINGS.theme, 'sepia')).not.toThrow()
    expect(settings.get(WEB_SETTINGS.theme)).toBe('sepia')
  })

  /* The list is what this client APPLIES. A setting offered but never read
     would be a control that does nothing — the failure this whole phase keeps
     tripping over. */
  it('offers only settings the reader actually applies', () => {
    expect(Object.keys(WEB_SETTINGS).sort()).toEqual(
      ['align', 'readingStyle', 'spacing', 'textSize', 'theme', 'themeFollowsOs', 'typeface'].sort(),
    )
  })
})

/**
 * ⚠️ **TWO SCREENS USED TO HOLD TWO STORES OVER ONE `localStorage`.**
 *
 * A settings store keeps the WHOLE envelope in memory and writes all of it back
 * on every change, so two of them diverge the moment either writes. The reader
 * stays mounted while its tab is hidden: changing the theme in **You** left the
 * reader's copy holding what it read at mount, and the reader's next write — a
 * typeface, a text size — persisted that stale envelope over the new theme. A
 * preference changed on one screen was invisible on the other, then undone.
 */
describe('one store per storage', () => {
  it('hands the same store to both screens', () => {
    const held: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => held[k] ?? null,
      setItem: (k: string, v: string) => void (held[k] = v),
    })
    expect(browserSettings()).toBe(browserSettings())
  })

  it('does not let one screen’s write erase another’s', () => {
    const held: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => held[k] ?? null,
      setItem: (k: string, v: string) => void (held[k] = v),
    })
    /* Two screens, asking separately — as `ShelfList` and `Reader` do. */
    const shelf = browserSettings()
    const reader = browserSettings()

    shelf.set(WEB_SETTINGS.theme, 'night')
    /* THE READER WRITES SOMETHING ELSE. With two stores this is where the
       theme went: the reader's envelope predates the change and is written
       back whole. */
    reader.set(WEB_SETTINGS.typeface, 'crimson')

    expect(reader.get(WEB_SETTINGS.theme), 'the reader never saw the shelf’s change').toBe('night')
    const stored = JSON.parse(held['paper.settings.v1'] ?? '{}') as { values?: Record<string, unknown> }
    expect(stored.values?.['kernel.theme'], 'the reader’s write erased the shelf’s').toBe('night')
    expect(stored.values?.['kernel.typeface']).toBe('crimson')
  })

  /* AND A FRESH STORAGE IS A FRESH STORE. A bare module singleton would hand
     the next test the previous one's values — the same defect, wearing a
     different hat. */
  it('gives a different storage its own store', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    const first = browserSettings()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    expect(browserSettings()).not.toBe(first)
  })
})
