import type { CSSProperties } from 'react'
import { ICON, MARK_SWATCH } from '../../core/metrics'
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

/**
 * The drawing box.
 *
 * ⚠️ **THE WIDTH IS NOT A RUNG OF THE ICON RAMP, AND THIS SAID IT WAS** —
 * "sized to the icon ramp so a specimen sits with the glyphs", above a 16 that
 * the ramp has no rung for at all: `ICON` runs 12, 13, 15, 17, 19, 32. What 16
 * IS is the wave's own width — four half-periods of four units each, which is
 * the path below — and it cannot be moved to `ICON.control`'s 15 without the
 * last crest stopping a unit short of the box it is supposed to fill. So the
 * comment is corrected rather than the number: this is a drawing, and a drawing
 * is sized to what it has to draw.
 *
 * THE HEIGHT IS `MARK_SWATCH`, which is the constant this box does share with
 * its neighbours — the tint discs one divider away in the same face are drawn
 * at it, one under the ramp's 15 for the reason `MARK_SWATCH` gives: ink reads
 * heavier than an outline of the same diameter, and a specimen's band is ink.
 * Two marks-of-a-size in one row, at one height. It was a 14 written out beside
 * the 14 that says so.
 */
const W = 16
const H = MARK_SWATCH
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
           four sets of coordinates that could disagree.

           ⚠️ THE STROKE WAS `1.6` AND HAD DRIFTED FROM `ICON.stroke`, which is
           1.75 and which every other glyph in this bar passes. §08 says one
           stroke weight everywhere, and a specimen drawn in a row of lucide
           icons at a lighter weight than all of them is the one place where
           the drift is visible side by side. */
        <path
          d={`M0 ${RULE_Y + 1} q2 -3 4 0 t4 0 t4 0 t4 0`}
          fill="none"
          stroke="var(--spec-rule)"
          strokeWidth={ICON.stroke}
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}
