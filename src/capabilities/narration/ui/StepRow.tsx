import { Minus, Plus } from 'lucide-react'
import { CAPABILITY_UI as ui, ICON, stepAt, type SteppedScale } from '../../../kernel'

/**
 * A setting that moves through a closed set of steps.
 *
 * A STEPPER AND NOT A SLIDER, for the reason `READING_STEPS` gives: a value
 * between two steps is not a decision anybody made, and a slider invites
 * hunting for one. These also have ends — no pause at all, the fastest speed —
 * and a stepper is where an end can be shown by a control going dead rather
 * than by nothing happening.
 *
 * WHAT IT REPORTS IS A POSITION, NOT A NUMBER. "300ms" is true and useless: a
 * reader adjusting a pause is listening, not reading units, and the only
 * question the control has to answer is how much room is left in each
 * direction. Pips do that at a glance and take less width than the number
 * would, which matters in a 400px pane holding three of these.
 *
 * ⚠️ **THE KERNEL'S `StepRow`, DRAWN FROM THE SHARED CLASSES.** Until step 5.5
 * the Voice rows were the kernel's own Settings rows; they are narration's now,
 * and a capability builds from `CAPABILITY_UI` rather than from the side pane's
 * stylesheet. So this is the kernel row's markup over `paper-cap-stepper` and
 * its neighbours, and `capabilityUi.test.ts` holds those classes to the side
 * pane's — the two rows cannot drift apart unnoticed.
 */
export interface StepRowProps {
  readonly label: string
  /** The scale this row steps through — see `READING_RATE`, `SENTENCE_GAP`, `PARAGRAPH_GAP`. */
  readonly scale: SteppedScale
  /** A position in the scale, clamped — an index from anywhere may be stale. */
  readonly value: number
  readonly onChange: (idx: number) => void
}

export function StepRow({ label, scale, value, onChange }: StepRowProps) {
  const last = scale.steps.length - 1
  const at = Math.min(last, Math.max(0, value))
  const amount = stepAt(scale, at)
  /* `x` is a bare multiplier with no unit, and "1.25" alone reads as a length —
     so it is reported with a times sign. Every other unit is written as it is. */
  const title = `${label}: ${amount}${scale.unit === 'x' ? '×' : scale.unit}`

  return (
    <div className={ui.row}>
      <span className={ui.grow}>{label}</span>
      <div className={ui.stepper} title={title}>
        <button
          type="button"
          className={ui.stepperButton}
          disabled={at <= 0}
          aria-label={`Less ${label.toLowerCase()}`}
          onClick={() => onChange(at - 1)}
        >
          <Minus size={ICON.control} strokeWidth={ICON.stroke} />
        </button>
        {/* The position in the scale, as pips. A reader needs to know how much
            room is left, which a number does not say without them also knowing
            where the ends are. */}
        <span className={ui.pips} role="img" aria-label={`Step ${at + 1} of ${last + 1}`}>
          {scale.steps.map((_, i) => (
            <span key={i} className={ui.pip} data-on={i <= at} />
          ))}
        </span>
        <button
          type="button"
          className={ui.stepperButton}
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
