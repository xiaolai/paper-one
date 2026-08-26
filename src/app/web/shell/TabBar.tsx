import { BookOpen, CircleUser, Layers, LibraryBig } from 'lucide-react'
import { ICON } from '../../../kernel/core/metrics'
import styles from './TabBar.module.css'

/**
 * The four tabs — Library · Reading · Cards · You — from the mobile mockup.
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
 * Library's search pill, not from a tab; Settings is under You. So four, not
 * five, and no tab is ever disabled — a tab that cannot be visited is not drawn.
 */
export type Tab = 'library' | 'reading' | 'cards' | 'you'

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
  { id: 'you', label: 'You', Icon: CircleUser },
]

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
