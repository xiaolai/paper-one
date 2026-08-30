import { ReadingSettings } from './ReadingSettings'
import type { SettingsStore } from '../../kernel'

/**
 * THE **YOU** TAB — this device's reading preferences, and the way off it.
 *
 * ## Why this is its own component
 *
 * `ShelfList` was two hundred and sixty lines holding navigation state, remote
 * mutation adaptation, store lifecycles, settings and four screens. This screen
 * shares nothing with the other three: it reads no book, no mark and no card.
 *
 * The panel itself is `ReadingSettings`, which the reader's tools sheet mounts
 * too — the seventeen setters used to be written out in both places, over the
 * same store, and two copies of one wiring is one of them keeping a rule the
 * other drops.
 */
export function YouScreen({
  settings,
  onSignOut,
}: {
  readonly settings: SettingsStore
  readonly onSignOut: () => void
}) {
  return (
    <div className="web-stage web-screen">
      <h1 className="web-screen-title">You</h1>
      <ReadingSettings settings={settings} />
      {/* DISCONNECT lives under You — it is about this device, which is what
          the tab is for. */}
      <button type="button" className="shelf-signout web-signout" onClick={onSignOut}>
        Disconnect this browser
      </button>
    </div>
  )
}
