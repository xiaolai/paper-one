import { Minus, Plus } from 'lucide-react'
import { SPACING, spacingAt, type SpacingScale } from '../lib/metrics'
import { ICON } from '../lib/metrics'
import type { SpacingKey } from '../lib/state'
import styles from './SidePane.module.css'

/**
 * One of the four spacings, as a stepper.
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
export interface SpacingRowProps {
  readonly label: string
  readonly settingKey: SpacingKey
  readonly value: number
  readonly onChange: (key: SpacingKey, idx: number) => void
}

export function SpacingRow({ label, settingKey, value, onChange }: SpacingRowProps) {
  const scale: SpacingScale = SPACING[settingKey]
  const last = scale.steps.length - 1
  const at = Math.min(last, Math.max(0, value))
  /* Named for what it does to the page, not for its own units — see above. */
  const amount = spacingAt(settingKey, at)
  const title = `${label}: ${amount}${scale.unit === 'em' ? 'em' : '×'}`

  return (
    <div className={`${styles.settingRow} ${styles.settingStatic}`}>
      <span style={{ flex: 1 }}>{label}</span>
      <div className={styles.stepper} title={title}>
        <button
          type="button"
          className={styles.stepperButton}
          disabled={at <= 0}
          aria-label={`Less ${label.toLowerCase()}`}
          onClick={() => onChange(settingKey, at - 1)}
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
          onClick={() => onChange(settingKey, at + 1)}
        >
          <Plus size={ICON.control} strokeWidth={ICON.stroke} />
        </button>
      </div>
    </div>
  )
}
