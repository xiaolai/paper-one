import { THEMES } from '../lib/panes'
import type { PageLayout, Side, Theme } from '../lib/state'
import styles from './SidePane.module.css'

/**
 * §05 theme chips — the page colour of each theme, as a literal, because a
 * swatch has to show the theme it offers rather than the one in use.
 *
 * The fills are this panel's own business and stay here. The ids and labels do
 * not: they came from a second copy of the theme table that the command palette
 * also carried, so renaming a theme meant editing two files and noticing. They
 * now come from `lib/panes`, and the fill map is typed as a total Record so a
 * new theme without a swatch fails to compile.
 */
const THEME_FILLS: Record<Theme, string> = {
  paper: '#FFFFFF',
  slate: '#DFE1DE',
  sepia: '#F8F0E1',
  sage: '#DDE6D8',
  night: '#16191C',
}

const THEME_CHIPS = THEMES.map(({ id, label }) => ({ id, label, fill: THEME_FILLS[id] }))

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
