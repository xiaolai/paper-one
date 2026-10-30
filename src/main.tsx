import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

/* Fonts are bundled, never fetched. The design handoff is explicit: the
 * prototypes load these from a CDN for previewing only, and the app embeds
 * them. Literata is the default reading face (design system §14); the picker
 * offers the other two BUNDLED faces (Instrument Sans, IBM Plex Mono) plus
 * whatever the machine already has, probed at runtime. Crimson Pro is imported
 * for the app's own chrome rather than as a reading face, which is why the
 * count here and `typefaces.ts`'s `BUNDLED` differ by one — a count that
 * disagreed with the file it described said "five". */
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/crimson-pro'
import '@fontsource-variable/literata'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'

/* THE DESKTOP COMPOSITION ROOT — now only the part that is about the desktop.
 *
 * The launch sequence this file used to hold moved to `app/bootApp.ts` when
 * the mobile shell arrived: none of it was desktop-specific, and a second copy
 * of an order whose every step records an incident would have drifted. What is
 * left here is the one thing that genuinely belongs to THIS root — which shell
 * gets rendered, and which door it comes through.
 *
 * `./kernel/ui` is the UI entry only a composition root may import (it brings
 * the stylesheets with it). `bootApp` reaches the kernel through the narrower
 * `./kernel/ui/boot`, so the mobile root can share it without also loading
 * `App`. `.dependency-cruiser.cjs` holds this file to exactly these imports. */
import { App, installFatalHandlers } from './kernel/ui'
import { bootApp, reportFirstFrame } from './app/bootApp'

installFatalHandlers()

const host = document.getElementById('root')
if (!host) throw new Error('#root is missing from index.html')

/* An async function rather than a top-level await: TLA needs a build target
 * that supports it, and raising the target for the whole bundle to avoid four
 * lines here would be the wrong trade. */
async function main(root: HTMLElement): Promise<void> {
  const booted = await bootApp()

  createRoot(root).render(
    <StrictMode>
      <App
        services={booted.services}
        /* ONLY WHEN SOMETHING IS ACTUALLY RECORDING. The Developer panel draws
           a different surface for "nothing to show" than for "this build
           records nothing", and it can only tell them apart if absence means
           the second. `bootApp` has already folded the build's diagnostics
           switch into this field, so null here means the second. */
        {...(booted.diagnosticLog ? { diagnosticLog: booted.diagnosticLog } : {})}
        /* THE FILE IS A PROJECTION OF THE WINDOW — see `diagnosticsLog.ts` — so
           clearing one must rewrite the other, or a harness reading
           `diagnostics.jsonl` over ssh reads entries the app has thrown away. */
        {...(booted.onDiagnosticsCleared ? { onDiagnosticsCleared: booted.onDiagnosticsCleared } : {})}
        fs={booted.fs}
        shelfUnread={booted.shelfUnread}
        bootNotice={booted.bootNotice}
        composition={booted.composition}
        beforeWindowClose={booted.beforeWindowClose}
        openRequests={booted.openRequests}
      />
    </StrictMode>,
  )

  /* AFTER THE FIRST PAINT, and after that whenever the filesystem moves. A
   * shelf that comes up quickly and then reads a thousand covers is slow in a
   * way no boot measurement can see. */
  reportFirstFrame(booted)
}

void main(host)
