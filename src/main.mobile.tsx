import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

/* Fonts are bundled, never fetched — the same rule both other entries follow.
 * A phone is the case where it matters most: a reader on a train has no
 * network, and a reading face that arrives late reflows the page they are
 * reading. */
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/crimson-pro'
import '@fontsource-variable/literata'
import '@fontsource/ibm-plex-mono/400.css'

/* THE DESIGN SYSTEM'S VALUES, taken directly rather than through a UI barrel.
 * `kernel/ui/index.ts` imports these three as a side effect so a DESKTOP root's
 * reader arrives dressed; this root may not import that barrel at all (it names
 * `App`), so it takes the stylesheets itself — exactly as `main.web.tsx` does,
 * and for the same reason the browser client does not take them through
 * `ui/browser.ts`: a side-effect import inside a door would make the order of
 * two stylesheet systems depend on which module was reached first. */
import './kernel/ui/styles/tokens.css'
import './kernel/ui/styles/global.css'
import './kernel/ui/styles/capability.css'

/* THE MOBILE COMPOSITION ROOT.
 *
 * The launch is `app/bootApp.ts` — the same sequence the desktop runs, because
 * none of it is desktop-specific and a second copy of an order whose every step
 * records an incident would drift. What differs is the shell at the end.
 *
 * `installFatalHandlers` comes through `ui/boot.ts` rather than `ui/index.ts`:
 * this root may not name the desktop barrel, which would bring the whole pane
 * tree, titlebar and palette into a bundle that draws none of them.
 * `.dependency-cruiser.cjs` refuses it (`native-boot-not-desktop-ui-entry`). */
import { installFatalHandlers } from './kernel/ui/boot'
import { applyMetrics } from './kernel/core/metrics'
import { resolvePlatform } from './kernel/ui/mobile'
import { bootApp, reportFirstFrame } from './app/bootApp'
import { MobileApp } from './app/mobile/MobileApp'

installFatalHandlers()

const host = document.getElementById('root')
if (!host) throw new Error('#root is missing from index.mobile.html')

/* THE DESIGN SYSTEM'S GEOMETRY, published onto the root element before
 * anything reads it. `capability.css` resolves every control's size and shape
 * from these custom properties, so a shell that skips this draws controls with
 * no dimensions at all. `App.tsx` calls it for the desktop from inside
 * `kernel/ui`; a root that does not mount `App` has to call it itself.
 *
 * Told which platform this is rather than assuming: on `ios` and `android` the
 * titlebar height and system zone are 0, because a phone has no window. Before
 * `Platform` knew about them, `resolvePlatform` answered `macos` here and the
 * shell reserved a 52px band for a titlebar that does not exist. */
applyMetrics(document.documentElement, resolvePlatform())

/* An async function rather than a top-level await: TLA needs a build target
 * that supports it, and raising the target for the whole bundle to avoid four
 * lines here would be the wrong trade. */
async function main(root: HTMLElement): Promise<void> {
  const booted = await bootApp()

  createRoot(root).render(
    <StrictMode>
      <MobileApp
        services={booted.services}
        shelfUnread={booted.shelfUnread}
        composition={booted.composition}
        /* WHAT OPENING THE STORE HAD TO SAY. The desktop root has always
           forwarded this; mobile dropped it, so a phone whose store was
           damaged and moved aside drew an ordinary empty library with nothing
           anywhere explaining where the books went. */
        bootNotice={booted.bootNotice}
      />
    </StrictMode>,
  )

  /* AFTER THE FIRST PAINT, and after that whenever the filesystem moves. A
   * shelf that comes up quickly and then reads a thousand covers is slow in a
   * way no boot measurement can see. */
  reportFirstFrame(booted)
}

void main(host)
