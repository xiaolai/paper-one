import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown } from 'lucide-react'
import { ICON } from '../../core/metrics'
import { useRowMenu } from '../hooks/useRowMenu'
import { opticalScale, useFontsReady } from '../fontProbe'
import { GROUP_LABEL, faceById, type Face } from '../../core/typefaces'
import styles from './SidePane.module.css'

/**
 * The face a book is set in, as one control.
 *
 * It was a list of every face, open on the settings panel — eight rows for a
 * decision a reader makes once and then leaves alone, above the size control
 * that they change often. A menu puts the two on one line and gives the size
 * back the room the list was taking.
 *
 * THE BUTTON IS SET IN THE FACE IT NAMES, and so is every row in the menu. A
 * list of proper nouns in the interface font tells a reader nothing about what
 * their book will look like; the sample IS the description, which is why there
 * is no note beside it.
 *
 * AND EVERY SAMPLE IS OPTICALLY THE SAME SIZE. Set at one nominal size they are
 * not: measured here, the x-heights of the eight faces this machine offers
 * spanned 8.0 to 9.3 pixels at a flat 17px, so the list read as a list of
 * sizes rather than of shapes — which is the wrong question to ask a reader
 * choosing a typeface. Each sample carries `--face-scale`, the same correction
 * the book gets, so what differs between rows is only the letterforms.
 */
export interface FacePickerProps {
  readonly value: string
  readonly offered: readonly Face[]
  readonly onChange: (id: string) => void
  readonly open: boolean
  readonly setOpen: (open: boolean) => void
}

/** The sample's own size, corrected — see the note above. */
function sample(face: Face): CSSProperties {
  return { fontFamily: face.stack, '--face-scale': opticalScale(face) } as CSSProperties
}

export function FacePicker({ value, offered, onChange, open, setOpen }: FacePickerProps) {
  /* Re-renders the samples once webfonts land: before that a bundled face
     measures as its own fallback, and the list would keep those sizes. */
  useFontsReady()
  const anchorRef = useRef<HTMLDivElement | null>(null)

  /* THE MENU IS THE FIELD'S WIDTH. This control is drawn as a field — a pill
     with a border and a chevron — so it should open like one: a `<select>`
     drops a list the width of itself, and a narrower or wider box would read as
     a menu that happens to be near the field rather than as the field opening.
     Measured rather than guessed, because the field takes the row's slack and
     that depends on the pane's width. Observed rather than read once, so it
     stays right while the pane animates open. */
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const node = anchorRef.current
    if (!node) return
    const measure = () => setWidth(node.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const { moreRef, menuRef, menuStyle, close } = useRowMenu(open, anchorRef, () => setOpen(false), {
    side: 'bottom',
    align: 'start',
  })
  const current = faceById(value)

  return (
    <div className={styles.facePicker} ref={anchorRef}>
      <button
        ref={moreRef as unknown as React.RefObject<HTMLButtonElement>}
        type="button"
        className={styles.faceButton}
        aria-haspopup="menu"
        aria-expanded={open}
        data-open={open}
        aria-label={`Typeface: ${current.label}`}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.faceName} style={sample(current)}>
          {current.label}
        </span>
        <ChevronDown size={ICON.control} strokeWidth={ICON.stroke} aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={menuRef}
          className={styles.faceMenu}
          role="menu"
          aria-label="Typeface"
          style={{ ...menuStyle, width: width || undefined }}
        >
          {(['serif', 'sans', 'mono'] as const).map((group) => {
            const faces = offered.filter((face) => face.group === group)
            if (faces.length === 0) return null
            return (
              <div key={group}>
                {/* The only thing a reader is choosing between: a serif to read
                    in, a sans, a monospace. Nothing says where a face came
                    from — see `typefaces.ts`. */}
                <div className={styles.faceGroup}>{GROUP_LABEL[group]}</div>
                {faces.map((face) => (
                  <button
                    key={face.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={face.id === value}
                    className={styles.faceItem}
                    data-on={face.id === value}
                    style={sample(face)}
                    onClick={() => {
                      onChange(face.id)
                      close()
                    }}
                  >
                    {/* The size lives on a SPAN, not on the button. The button
                        composes `menuItem`, which sets its own `font-size`, and
                        at equal specificity the winner is whichever stylesheet
                        the bundler emitted last — so the scaled size lost
                        silently and every sample came out at the menu's 13px.
                        `controls.module.css` carries the same warning about
                        `.primary` and `.iconOnly`. A child has nothing to
                        argue with. */}
                    <span className={styles.faceItemLabel}>{face.label}</span>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
