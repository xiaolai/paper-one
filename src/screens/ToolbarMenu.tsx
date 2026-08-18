import { useRef } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ICON } from '../lib/metrics'
import { useRowMenu } from '../lib/useRowMenu'
import styles from './Library.module.css'

/**
 * A toolbar button that is also a choice.
 *
 * The shelf offers two of these — which way to look at it, and which way to
 * order it — and both were rows of bare icons sitting in the header, one lit.
 * Six controls permanently on screen to express two decisions, next to a
 * 38px title saying "Library" on the library screen.
 *
 * THE BUTTON SHOWS THE ANSWER, not the question: it wears the icon of whatever
 * is currently chosen, so the toolbar still reports the state it used to spell
 * out, in a sixth of the space. The alternatives are one click away instead of
 * permanently present, which is the trade a toolbar of two thousand books
 * should make — these are set once and then left alone.
 *
 * Placement and dismissal are `useRowMenu`'s, the same as a book's `⋯`: click
 * outside, Escape, or the row scrolling away all close it, and there is one way
 * to close so no caller can invent a second.
 */
export interface ToolbarOption<T extends string> {
  readonly id: T
  readonly label: string
  readonly Icon: LucideIcon
}

export interface ToolbarMenuProps<T extends string> {
  /** What the button says, and what the menu ticks. */
  readonly value: T
  readonly options: readonly ToolbarOption<T>[]
  readonly onChange: (id: T) => void
  /** Names the decision, for the tooltip and for a screen reader: "View", "Sort". */
  readonly name: string
  /** Open state lives with the caller, so only one toolbar menu is ever open. */
  readonly open: boolean
  readonly setOpen: (open: boolean) => void
}

export function ToolbarMenu<T extends string>({
  value,
  options,
  onChange,
  name,
  open,
  setOpen,
}: ToolbarMenuProps<T>) {
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const { moreRef, menuRef, menuStyle, close } = useRowMenu(
    open,
    anchorRef,
    () => setOpen(false),
    /* Under the button and aligned to its trailing edge, which puts the menu
       inside the window on the right-hand end of a toolbar; `usePlacement`
       flips or slides it if that is not true at some window size. */
    { side: 'bottom', align: 'end' },
  )

  const current = options.find((one) => one.id === value) ?? options[0]
  if (!current) return null
  const { Icon } = current

  return (
    <div className={styles.toolMenu} ref={anchorRef}>
      <button
        ref={moreRef}
        type="button"
        className={styles.tool}
        aria-haspopup="menu"
        aria-expanded={open}
        data-open={open}
        aria-label={`${name}: ${current.label}`}
        title={`${name}: ${current.label}`}
        onClick={() => setOpen(!open)}
      >
        <Icon size={ICON.control} strokeWidth={ICON.stroke} />
      </button>

      {open && (
        <div
          ref={menuRef}
          className={styles.menu}
          role="menu"
          aria-label={name}
          style={menuStyle}
        >
          {options.map(({ id, label, Icon: OptionIcon }) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={id === value}
              className={styles.menuItem}
              data-on={id === value}
              onClick={() => {
                onChange(id)
                close()
              }}
            >
              <OptionIcon size={ICON.control} strokeWidth={ICON.stroke} />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
