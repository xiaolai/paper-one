import { BookOpen, LibraryBig, Settings as SettingsIcon } from 'lucide-react'
import { ICON } from '../../kernel/core/metrics'
import styles from './TabBar.module.css'

/**
 * The three tabs — Library · Reading · Settings.
 *
 * "The titlebar chip becomes a tab": on the desktop the open book is a chip in
 * the titlebar and the library is a screen you go back to. On a phone they are
 * peers, and the tab bar is what makes them so. 76px tall with 14px of it
 * below the icons for the home indicator; icons at 19px — §08's "Prominent"
 * step, "mobile tab bar and empty states".
 *
 * ## What is NOT a tab
 *
 * The mockup's Search is "its own screen, not an overlay" and reached from the
 * Library's search pill, not from a tab. So no tab for it, and no tab is ever
 * disabled — a tab that cannot be visited is not drawn.
 *
 * ## The last tab is Settings, and the mockup called it You
 *
 * `dev-docs/design/Paper Mobile.dc.html` names it **You**, with a person icon,
 * and files the preferences under it. That framing was overruled: the screen
 * behind it is the reading settings and nothing else, so the tab says what it
 * opens. The icon moved with the label — a gear, not a person — because a
 * person icon over the word Settings is the drift, not the fix.
 *
 * BOTH CLIENTS FOLLOW, because this list is the only one. The browser client
 * mounts the same bar, and one shell saying You while the other says Settings
 * would be two vocabularies for one design. The browser's screen carries a
 * "Disconnect this browser" button as well as the settings, which is still a
 * thing about this device rather than about a person.
 */
export type Tab = 'library' | 'reading' | 'settings'

export interface TabBarProps {
  readonly active: Tab
  readonly onSelect: (tab: Tab) => void
  /** Whether there is a book to return to. Without one, Reading goes to the
   *  shelf — a tab that opens an empty reader is a tab that does nothing. */
  readonly hasBook: boolean
}

const TABS: readonly { readonly id: Tab; readonly label: string; readonly Icon: typeof BookOpen }[] = [
  { id: 'library', label: 'Library', Icon: LibraryBig },
  { id: 'reading', label: 'Reading', Icon: BookOpen },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon },
]

/* ⚠️ **THERE WAS A CARDS TAB, FILTERED OUT OF EVERY BUILD, AND IT IS GONE.** This
 * bar asked `paneOffered` with `developer` fixed at false, because these shells
 * have no chord, and said that finishing the panel would "ship it on all three
 * shells at once". The owner withdrew that on 2026-10-31
 * (`dev-docs/decisions/2026-10-31-plugin-boundary.md`, D3): a panel reaches a
 * phone or a browser when someone decides it should and builds it, and nothing
 * here happens by itself. The card protocol stays, so a later client can read
 * the deck. */

export function TabBar({ active, onSelect, hasBook }: TabBarProps) {
  return (
    <nav className={styles.bar} aria-label="Sections">
      {TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          className={styles.tab}
          aria-current={active === id ? 'page' : undefined}
          onClick={() => onSelect(id === 'reading' && !hasBook ? 'library' : id)}
        >
          <Icon size={ICON.prominent} strokeWidth={ICON.stroke} />
          <span className={styles.label}>{label}</span>
        </button>
      ))}
    </nav>
  )
}
