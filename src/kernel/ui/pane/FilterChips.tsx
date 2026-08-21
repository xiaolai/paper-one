import type { Search } from 'lucide-react'
import { ICON } from '../../core/metrics'
import styles from './SidePane.module.css'

/**
 * The row of filter chips above a list — Marginalia's and Cards' both.
 *
 * They were the same eleven lines of JSX twice, differing only in the type of
 * the label. Which is fine right up to the first change that has to be made in
 * both: §07 asks for selected state to be ANNOUNCED as well as drawn, and
 * neither copy did it. One component means one place to fix that, and it is
 * fixed here.
 *
 * TWO SHAPES, ONE COMPONENT, for the same reason. Marginalia filters on two
 * axes and got to seven chips, which wrapped to three lines of chrome above the
 * list at the pane's 400px; as icons they are one line. Cards' four keep their
 * words, because four words fit and a word needs no tooltip to be read. The
 * variant is a prop rather than a second component so that the `aria-pressed`
 * rule above cannot be implemented once and forgotten once.
 */
export interface FilterChipsProps<T extends string> {
  options: readonly T[]
  active: T
  onSelect: (option: T) => void
  /** Named for assistive technology, since the chips are unlabelled buttons. */
  label: string
  /**
   * Draw each option as its icon instead of its text.
   *
   * A TOTAL RECORD, so an option with no icon fails to compile rather than
   * rendering an empty button — which is what an icon-only chip with nothing in
   * it is. The option's own text becomes the tooltip AND the accessible name,
   * so the word is still reachable by pointer and by screen reader; it is the
   * visual that gets shorter, not the information.
   */
  icons?: Readonly<Record<T, typeof Search>>
}

export function FilterChips<T extends string>({
  options,
  active,
  onSelect,
  label,
  icons,
}: FilterChipsProps<T>) {
  return (
    <div className={styles.filters} role="group" aria-label={label}>
      {options.map((option) => {
        /* Annotated rather than inferred: read straight off a `Record<T, …>`
           through the generic, the element type comes back as an indexed access
           TSX will not accept as a component. */
        const Icon: typeof Search | undefined = icons?.[option]
        return (
          <button
            key={option}
            type="button"
            className={styles.filter}
            data-icon={Icon ? 'true' : undefined}
            /* The word, for the pointer and for assistive technology, when the
               button itself no longer shows one. */
            {...(Icon ? { title: option, 'aria-label': option } : {})}
            /* `data-on` draws it; `aria-pressed` says it. Without the second, a
               screen reader announces four identical buttons and no way to tell
               which list is currently on screen. */
            aria-pressed={active === option}
            data-on={active === option}
            onClick={() => onSelect(option)}
          >
            {Icon ? <Icon size={ICON.inline} strokeWidth={ICON.stroke} /> : option}
          </button>
        )
      })}
    </div>
  )
}
