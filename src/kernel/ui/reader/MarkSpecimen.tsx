import type { CSSProperties } from 'react'
import type { MarkStyle, MarkTint } from '../../core/marks'
import styles from './SelectionTools.module.css'

/**
 * What a mark looks like, drawn small.
 *
 * A SPECIMEN RATHER THAN AN ICON, which is the difference between showing and
 * naming. The band, the rule and the wave are three marks; a row of three of
 * these is the answer to "what will this do" without a word or a tooltip, and
 * without three icon metaphors that each have to be decoded first.
 *
 * The same principle as the theme tiles in Settings, which are drawn in the
 * theme they offer rather than labelled with its name.
 *
 * ONE SVG FOR ALL THREE. The wave needs a path, and mixing an SVG for it with
 * box-shadows for the other two would leave them subtly unlike each
 * other — different anti-aliasing, different sub-pixel rounding — in the one
 * place where a reader is comparing them side by side.
 */

export interface MarkSpecimenProps {
  readonly tint: MarkTint
  readonly style: MarkStyle
}

/** The drawing box. Sized to the icon ramp so a specimen sits with the glyphs. */
const W = 16
const H = 14
/** Where a rule sits, and how thick — in the specimen's own coordinates. */
const RULE_Y = 10
const RULE_H = 2

export function MarkSpecimen({ tint, style }: MarkSpecimenProps) {
  /* Resolved from the theme's own custom properties rather than passed as hex:
     a specimen that did not re-value with the theme would offer a colour the
     book will not draw. */
  const vars = {
    '--spec-fill': `var(--mark-${tint})`,
    '--spec-rule': `var(--mark-${tint}-rule)`,
  } as CSSProperties

  return (
    <svg
      className={styles.specimen}
      style={vars}
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      aria-hidden="true"
      focusable="false"
    >
      {style === 'fill' && (
        /* A band behind words, which is what a fill is — so it fills the box
           rather than sitting at the foot of it like the rules do. */
        <rect x="0" y="2" width={W} height="10" rx="2" fill="var(--spec-fill)" />
      )}
      {style === 'underline' && (
        <rect x="0" y={RULE_Y} width={W} height={RULE_H} rx="1" fill="var(--spec-rule)" />
      )}
      {style === 'wave' && (
        /* Four half-periods across the box. `q` then three `t`s: each `t`
           mirrors the previous control point, so the crests stay even without
           four sets of coordinates that could disagree. */
        <path
          d={`M0 ${RULE_Y + 1} q2 -3 4 0 t4 0 t4 0 t4 0`}
          fill="none"
          stroke="var(--spec-rule)"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}
