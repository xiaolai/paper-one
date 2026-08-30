import { ReadingSettings } from './ReadingSettings'
import type { SettingsStore } from '../../kernel'
import styles from '../shell/shell.module.css'

/**
 * THE **SETTINGS** TAB — this device's reading preferences, and the way off it.
 *
 * The mockup called this tab You, with a person icon. It was renamed to say
 * what it opens; `shell/TabBar.tsx` carries the reasoning, and the list there
 * is the only one, so both clients moved together.
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
export function SettingsScreen({
  settings,
  onSignOut,
}: {
  readonly settings: SettingsStore
  readonly onSignOut: () => void
}) {
  return (
    <div className={`${styles.stage} ${styles.screen}`}>
      <h1 className={styles.screenTitle}>Settings</h1>
      <ReadingSettings settings={settings} />
      {/* DISCONNECT lives here — it is about this device, which is what the
          tab is for. Still true under the new name: signing this browser out
          is a thing you set about it, not a preference about reading. */}
      <button type="button" className="shelf-signout web-signout" onClick={onSignOut}>
        Disconnect this browser
      </button>
    </div>
  )
}
