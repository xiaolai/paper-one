import { useMemo, useSyncExternalStore } from 'react'
import { Settings, offeredFaces, presentFaces } from '../../kernel/ui/browser'
/* `metrics` DIRECTLY, as `main.web.tsx` reaches it: the browser barrel grows
   one export at a time, in the change that mounts it. */
import { readingStep, stepIndexForSize } from '../../kernel/core/metrics'
import { WEB_SETTINGS } from './settings'
import type { SettingsStore } from '../../kernel'

/**
 * THE READING PANEL, wired to this browser's settings store.
 *
 * ## Why this exists
 *
 * ⚠️ **THE SAME SEVENTEEN SETTERS WERE WRITTEN OUT TWICE** — once in the **You**
 * tab and once in the reader's tools sheet — over the same store, doing the same
 * thing. Two copies of one wiring is one of them keeping a rule the other drops:
 * "an explicit theme turns off following the system" is a line in each, and a
 * setting added to `WEB_SETTINGS` needs a control added in both or it silently
 * has one only on the shelf.
 *
 * ## Why it subscribes rather than taking values
 *
 * The values are read through `get` rather than out of the snapshot so each
 * setting's own validator runs — `localStorage` is something anyone can edit in
 * a browser's devtools, and an unknown theme reaching the page would break the
 * palette. Handing this component fifteen already-read values would mean
 * reading them in a parent that does not otherwise care, on every render.
 */
export function ReadingSettings({ settings }: { readonly settings: SettingsStore }) {
  useSyncExternalStore(settings.subscribe, settings.getSnapshot)
  /* ⚠️ **THE PERSISTENCE FLAG NEEDS ITS OWN SUBSCRIPTION.** The snapshot above
   * is unchanged by a REFUSED write — `set` updates the values and publishes
   * before the storage is asked — so subscribing to it alone shows the "not
   * being saved" notice one change late. See `App.tsx`. */
  const persistent = useSyncExternalStore(
    settings.subscribe,
    () => settings.persistent,
    () => settings.persistent,
  )
  /* Probed once — it measures text. */
  const faces = useMemo(() => offeredFaces(presentFaces()), [])

  const themeFollowsOs = settings.get(WEB_SETTINGS.themeFollowsOs)

  return (
    <Settings
      theme={settings.get(WEB_SETTINGS.theme)}
      themeFollowsOs={themeFollowsOs}
      typeface={settings.get(WEB_SETTINGS.typeface)}
      stepIdx={stepIndexForSize(settings.get(WEB_SETTINGS.textSize))}
      spacing={settings.get(WEB_SETTINGS.spacing)}
      align={settings.get(WEB_SETTINGS.align)}
      style={settings.get(WEB_SETTINGS.readingStyle)}
      offered={faces}
      /* NO CONTRIBUTED SECTIONS. A browser composes no capability — see
         `composition.web.ts` — so there is nothing to contribute one. */
      sections={[]}
      persistent={persistent}
      onTheme={(next) => {
        settings.set(WEB_SETTINGS.theme, next)
        /* AN EXPLICIT PICK TURNS OFF OS FOLLOWING — `state.ts` states the rule
           for the desktop, and without it the chosen theme is overridden on the
           next render and the control does nothing you can see. */
        settings.set(WEB_SETTINGS.themeFollowsOs, false)
      }}
      /* ⚠️ **TAKES THE VALUE IT IS GIVEN.** This read
         `() => set(themeFollowsOs, !themeFollowsOs)`, ignoring the argument and
         negating a value captured at render. `Settings` declares
         `onFollowOs: (follows: boolean) => void` and passes the toggle's own
         next state, so the two agreed only for as long as the captured value
         and the control's state agreed — and the callback was a lie about its
         own signature either way. Both wrappers had it; both are fixed. */
      onFollowOs={(next) => settings.set(WEB_SETTINGS.themeFollowsOs, next)}
      onTypeface={(next) => settings.set(WEB_SETTINGS.typeface, next)}
      onStepIdx={(next) => settings.set(WEB_SETTINGS.textSize, readingStep(next).size)}
      onSpacing={(key, idx) =>
        settings.set(WEB_SETTINGS.spacing, { ...settings.get(WEB_SETTINGS.spacing), [key]: idx })
      }
      onAlign={(next) => settings.set(WEB_SETTINGS.align, next)}
      onStyle={(key, value) =>
        settings.set(WEB_SETTINGS.readingStyle, { ...settings.get(WEB_SETTINGS.readingStyle), [key]: value })
      }
    />
  )
}
