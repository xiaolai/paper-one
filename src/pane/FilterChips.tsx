import styles from './SidePane.module.css'

/**
 * The row of filter chips above a list — Notes' and Cards' both.
 *
 * They were the same eleven lines of JSX twice, differing only in the type of
 * the label. Which is fine right up to the first change that has to be made in
 * both: §07 asks for selected state to be ANNOUNCED as well as drawn, and
 * neither copy did it. One component means one place to fix that, and it is
 * fixed here.
 */
export interface FilterChipsProps<T extends string> {
  options: readonly T[]
  active: T
  onSelect: (option: T) => void
  /** Named for assistive technology, since the chips are unlabelled buttons. */
  label: string
}

export function FilterChips<T extends string>({
  options,
  active,
  onSelect,
  label,
}: FilterChipsProps<T>) {
  return (
    <div className={styles.filters} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={styles.filter}
          /* `data-on` draws it; `aria-pressed` says it. Without the second, a
             screen reader announces four identical buttons and no way to tell
             which list is currently on screen. */
          aria-pressed={active === option}
          data-on={active === option}
          onClick={() => onSelect(option)}
        >
          {option}
        </button>
      ))}
    </div>
  )
}
