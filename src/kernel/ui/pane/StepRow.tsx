import { Minus, Plus } from 'lucide-react'
import { ICON, stepAt, type SpacingScale } from '../../core/metrics'
import styles from './SidePane.module.css'

/**
 * A setting that moves through a closed set of steps.
 *
 * A STEPPER AND NOT A SLIDER, for the reason `READING_STEPS` gives: a value
 * between two steps is not a decision anybody made, and a slider invites
 * hunting for one. These also have ends that are typographic facts — letters
 * touch below the first tracking step — and a stepper is where an end can be
 * shown by a control going dead rather than by nothing happening.
 *
 * WHAT IT REPORTS IS A POSITION, NOT A NUMBER. "0.04em" is true and useless: a
 * reader adjusting their word spacing is looking at the page, not at the units,
 * and the only question the control has to answer is how much room is left in
 * each direction. Pips do that at a glance and take less width than the number
 * would, which matters in a 400px pane holding four of these.
 */
export interface StepRowProps {
  readonly label: string
  /** The scale this row steps through — see `SPACING`, `BRIGHTNESS`, `CONTRAST`. */
  readonly scale: SpacingScale
  readonly value: number
  readonly onChange: (idx: number) => void
}

/* ONE ROW FOR EVERY STEPPED SETTING. It was written for the four spacings and
 * brightness and contrast want exactly the same control — a label, two ends
 * that go dead, and a report of where in the scale you are. Two copies would
 * have drifted on the disabled state or the pips within a week. */
export function StepRow({ label, scale, value, onChange }: StepRowProps) {
  const last = scale.steps.length - 1
  const at = Math.min(last, Math.max(0, value))
  const amount = stepAt(scale, at)
  /* `x` is a bare multiplier with no unit, and "1.15" alone reads as a length —
     so it is reported with a times sign. Every other unit is a real CSS one and
     is written as it is. */
  const title = `${label}: ${amount}${scale.unit === 'x' ? '×' : scale.unit}`

  return (
    <div className={`${styles.settingRow} ${styles.settingStatic}`}>
      <span style={{ flex: 1 }}>{label}</span>
      <div className={styles.stepper} title={title}>
        <button
          type="button"
          className={styles.stepperButton}
          disabled={at <= 0}
          aria-label={`Less ${label.toLowerCase()}`}
          onClick={() => onChange(at - 1)}
        >
          <Minus size={ICON.control} strokeWidth={ICON.stroke} />
        </button>
        {/* The position in the scale, as pips. A reader needs to know how much
            room is left, which a number does not say without them also knowing
            where the ends are. */}
        <span className={styles.pips} role="img" aria-label={`Step ${at + 1} of ${last + 1}`}>
          {scale.steps.map((_, i) => (
            <span key={i} className={styles.pip} data-on={i <= at} />
          ))}
        </span>
        <button
          type="button"
          className={styles.stepperButton}
          disabled={at >= last}
          aria-label={`More ${label.toLowerCase()}`}
          onClick={() => onChange(at + 1)}
        >
          <Plus size={ICON.control} strokeWidth={ICON.stroke} />
        </button>
      </div>
    </div>
  )
}
