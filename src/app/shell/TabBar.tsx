import { BookOpen, Layers, LibraryBig, Settings as SettingsIcon } from 'lucide-react'
import { ICON } from '../../kernel/core/metrics'
import { isKernelPaneId, paneOffered } from '../../kernel/core/uiTypes'
import styles from './TabBar.module.css'

/**
 * The four tabs — Library · Reading · Cards · Settings.
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
 * Library's search pill, not from a tab. So four, not five, and no tab is ever
 * disabled — a tab that cannot be visited is not drawn.
 *
 * ## The fourth tab is Settings, and the mockup called it You
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
export type Tab = 'library' | 'reading' | 'cards' | 'settings'

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
  { id: 'cards', label: 'Cards', Icon: Layers },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon },
]

/**
 * The tabs this build actually offers.
 *
 * ⚠️ **THIS LIST WAS A LITERAL FOUR, AND `cards` IS IN `UNFINISHED_PANE_IDS`.**
 * The desktop hides that panel from the rail, the palette and the digit
 * accelerators; this bar is mounted by BOTH other shells — `MobileApp` and
 * `main.web.tsx` — and neither root names `paneOffered` anywhere, so the one
 * deck the desktop refuses to show was a permanent top-level tab on every
 * phone and in every browser, with no chord to hide it and nothing to find.
 * The section above already states the rule this breaks: *"no tab is ever
 * disabled — a tab that cannot be visited is not drawn."*
 *
 * ASKED, NOT RESTATED. Filtering on `UNFINISHED_PANE_IDS` here would be a
 * second copy of the question; `paneOffered` is the answer the other four
 * surfaces take. `reading` is this bar's own id and no panel, so it is passed
 * through untouched — `isKernelPaneId` is what tells them apart.
 *
 * `developer` is `false` and not a parameter: the chord is a desktop surface
 * and these shells have no way to reach it, so an unfinished panel is simply
 * absent here rather than hidden behind something unreachable. Removing an id
 * from `UNFINISHED_PANE_IDS` ships it on all three shells at once, which is
 * what that list promises and did not deliver.
 */
const OFFERED_TABS = TABS.filter(({ id }) => !isKernelPaneId(id) || paneOffered(id, false))

export function TabBar({ active, onSelect, hasBook }: TabBarProps) {
  return (
    <nav className={styles.bar} aria-label="Sections">
      {OFFERED_TABS.map(({ id, label, Icon }) => (
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
