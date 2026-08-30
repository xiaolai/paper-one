import { useMemo, useSyncExternalStore } from 'react'
import { Settings, offeredFaces, presentFaces } from '../../kernel/ui/mobile'
import { readingStep, stepIndexForSize } from '../../kernel/core/metrics'
import { KERNEL_SETTINGS, type SettingsSection, type SettingsStore } from '../../kernel'

/**
 * THE READING PANEL, wired to this device's own settings store.
 *
 * The same shape as the browser client's `app/web/ReadingSettings.tsx`, over a
 * different table: that one reads `WEB_SETTINGS` — a browser's own, smaller
 * set — and this one reads `KERNEL_SETTINGS`, because a native shell holds the
 * real store the launch built and every kernel setting is genuinely available
 * to it.
 *
 * Not shared with that file for exactly that reason. The two differ in which
 * table they name and in whether a composition can contribute sections, and a
 * single component taking a table as a parameter would be a seam that exists
 * only to have one file — while making the settings a phone actually offers
 * depend on a value passed in from somewhere else.
 */
export interface ReadingSettingsProps {
  readonly settings: SettingsStore
  /** What the composed capabilities contribute — see `sections` on `Settings`. */
  readonly sections: readonly SettingsSection[]
}

export function ReadingSettings({ settings, sections }: ReadingSettingsProps) {
  useSyncExternalStore(settings.subscribe, settings.getSnapshot)
  /* ⚠️ **THE PERSISTENCE FLAG NEEDS ITS OWN SUBSCRIPTION.** The snapshot above
   * is unchanged by a REFUSED write — `set` updates the values and publishes
   * before the storage is asked — so subscribing to it alone shows the "not
   * being saved" notice one change late. The browser client carries the same
   * note, and `App.tsx` is where it was first written down. */
  const persistent = useSyncExternalStore(
    settings.subscribe,
    () => settings.persistent,
    () => settings.persistent,
  )
  /* Probed once — it measures text, and which faces a device has cannot change
     while it is running. */
  const faces = useMemo(() => offeredFaces(presentFaces()), [])

  const themeFollowsOs = settings.get(KERNEL_SETTINGS.themeFollowsOs)

  return (
    <Settings
      theme={settings.get(KERNEL_SETTINGS.theme)}
      themeFollowsOs={themeFollowsOs}
      typeface={settings.get(KERNEL_SETTINGS.typeface)}
      stepIdx={stepIndexForSize(settings.get(KERNEL_SETTINGS.textSize))}
      spacing={settings.get(KERNEL_SETTINGS.spacing)}
      align={settings.get(KERNEL_SETTINGS.align)}
      style={settings.get(KERNEL_SETTINGS.readingStyle)}
      offered={faces}
      sections={sections}
      persistent={persistent}
      onTheme={(next) => {
        settings.set(KERNEL_SETTINGS.theme, next)
        /* AN EXPLICIT PICK TURNS OFF OS FOLLOWING — `state.ts` states the rule
           for the desktop, and without it the chosen theme is overridden on the
           next render and the control does nothing you can see. */
        settings.set(KERNEL_SETTINGS.themeFollowsOs, false)
      }}
      /* ⚠️ **TAKES THE VALUE IT IS GIVEN.** This read
         `() => set(themeFollowsOs, !themeFollowsOs)`, ignoring the argument and
         negating a value captured at render. `Settings` declares
         `onFollowOs: (follows: boolean) => void` and passes the toggle's own
         next state, so the two agreed only for as long as the captured value
         and the control's state agreed — and the callback was a lie about its
         own signature either way. Both wrappers had it; both are fixed. */
      onFollowOs={(next) => settings.set(KERNEL_SETTINGS.themeFollowsOs, next)}
      onTypeface={(next) => settings.set(KERNEL_SETTINGS.typeface, next)}
      onStepIdx={(next) => settings.set(KERNEL_SETTINGS.textSize, readingStep(next).size)}
      onSpacing={(key, idx) =>
        settings.set(KERNEL_SETTINGS.spacing, { ...settings.get(KERNEL_SETTINGS.spacing), [key]: idx })
      }
      onAlign={(next) => settings.set(KERNEL_SETTINGS.align, next)}
      onStyle={(key, value) =>
        settings.set(KERNEL_SETTINGS.readingStyle, { ...settings.get(KERNEL_SETTINGS.readingStyle), [key]: value })
      }
    />
  )
}
