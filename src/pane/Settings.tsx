import type { PageLayout, Side, Theme } from '../lib/state'
import styles from './SidePane.module.css'

/** §05 theme chips — the page colour of each theme, as a literal, because a
 *  swatch has to show the theme it offers rather than the one in use. */
const THEME_CHIPS: readonly { id: Theme; label: string; fill: string }[] = [
  { id: 'paper', label: 'Paper', fill: '#FFFFFF' },
  { id: 'slate', label: 'Slate', fill: '#DFE1DE' },
  { id: 'sepia', label: 'Sepia', fill: '#F8F0E1' },
  { id: 'sage', label: 'Sage', fill: '#DDE6D8' },
  { id: 'night', label: 'Night', fill: '#16191C' },
]

/**
 * Only what this panel reads and changes.
 *
 * Taking the whole AppState and dispatch would leave it coupled to every
 * unrelated field — extracting it into its own file without narrowing the
 * surface just relocates the coupling.
 */
export interface SettingsProps {
  theme: Theme
  themeFollowsOs: boolean
  pageLayout: PageLayout
  rulerOn: boolean
  side: Side
  onTheme: (theme: Theme) => void
  onFollowOs: (follows: boolean) => void
  onPageLayout: (layout: PageLayout) => void
  onToggleRuler: () => void
  onSide: (side: Side) => void
}

export function Settings({
  theme,
  themeFollowsOs,
  pageLayout,
  rulerOn,
  side,
  onTheme,
  onFollowOs,
  onPageLayout,
  onToggleRuler,
  onSide,
}: SettingsProps) {
  return (
    <div className={styles.panel}>
      <div className={styles.groupTitle}>Appearance</div>
      <div className={styles.themeGrid}>
        {THEME_CHIPS.map(({ id, label, fill }) => (
          <button
            key={id}
            type="button"
            className={styles.themeSwatch}
            data-on={theme === id}
            onClick={() => onTheme(id)}
          >
            <span className={styles.themeChip} style={{ background: fill }} />
            {label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className={styles.settingRow}
        onClick={() => onFollowOs(!themeFollowsOs)}
      >
        <span style={{ flex: 1 }}>Follow system appearance</span>
        <span className={styles.settingValue}>{themeFollowsOs ? 'On' : 'Off'}</span>
      </button>

      <div className={styles.groupTitle}>Reading</div>
      <button
        type="button"
        className={styles.settingRow}
        onClick={() => onPageLayout(pageLayout === 'scrolled' ? 'paginated' : 'scrolled')}
      >
        <span style={{ flex: 1 }}>Flow</span>
        <span className={styles.settingValue}>
          {pageLayout === 'scrolled' ? 'Scrolled' : 'Paged'}
        </span>
      </button>

      {/* §06: the ruler row appears only in scrolled flow — hidden, not
          disabled, because paged has no lines to advance. */}
      {pageLayout === 'scrolled' && (
        <button
          type="button"
          className={styles.settingRow}
          onClick={onToggleRuler}
        >
          <span style={{ flex: 1 }}>Reading ruler</span>
          <span className={styles.settingValue}>{rulerOn ? 'On' : 'Off'}</span>
        </button>
      )}

      <div className={styles.groupTitle}>Side pane</div>
      <button
        type="button"
        className={styles.settingRow}
        onClick={() => onSide(side === 'left' ? 'right' : 'left')}
      >
        <span style={{ flex: 1 }}>Position</span>
        <span className={styles.settingValue}>{side === 'left' ? 'Left' : 'Right'}</span>
      </button>
    </div>
  )
}
