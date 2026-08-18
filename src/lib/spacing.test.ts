import { describe, expect, it } from 'vitest'
import { SPACING, spacingAt } from './metrics'
import { initialState, reducer, type SpacingKey } from './state'

const KEYS: readonly SpacingKey[] = ['letter', 'word', 'line', 'paragraph']

describe('the spacing scales', () => {
  it('has a default that is a real step of every scale', () => {
    for (const key of KEYS) {
      const scale = SPACING[key]
      expect(scale.def, key).toBeGreaterThanOrEqual(0)
      expect(scale.def, key).toBeLessThan(scale.steps.length)
    }
  })

  /* A reader who never opens these must get exactly the book they have now:
   * no tracking, no word spacing, the step's own line, one line between
   * paragraphs. */
  it('defaults to the typography that was there before it was adjustable', () => {
    expect(spacingAt('letter', SPACING.letter.def)).toBe(0)
    expect(spacingAt('word', SPACING.word.def)).toBe(0)
    expect(spacingAt('line', SPACING.line.def)).toBe(1)
    expect(spacingAt('paragraph', SPACING.paragraph.def)).toBe(1)
  })

  it('starts every reader on those defaults', () => {
    for (const key of KEYS) expect(initialState.spacing[key], key).toBe(SPACING[key].def)
  })

  it('runs each scale in one direction, with no repeated step', () => {
    for (const key of KEYS) {
      const steps = SPACING[key].steps
      expect(new Set(steps).size, key).toBe(steps.length)
      expect([...steps].sort((a, b) => a - b), key).toEqual([...steps])
    }
  })

  /* Line and paragraph are MULTIPLES of the line box, so zero or negative
   * leading is not a thing the scale may contain. */
  it('never offers a multiplier that would collapse the line', () => {
    for (const value of SPACING.line.steps) expect(value).toBeGreaterThan(0)
    for (const value of SPACING.paragraph.steps) expect(value).toBeGreaterThanOrEqual(0)
  })
})

describe('spacingAt', () => {
  it('reads a step', () => {
    expect(spacingAt('line', 0)).toBe(SPACING.line.steps[0])
    expect(spacingAt('line', SPACING.line.steps.length - 1)).toBe(
      SPACING.line.steps[SPACING.line.steps.length - 1],
    )
  })

  /* An index reaches this from state that a newer build may have written, so
   * it is clamped rather than trusted — `undefined` from an array lookup would
   * reach the stylesheet as the string "undefined". */
  it('clamps an index from outside the scale', () => {
    expect(spacingAt('word', -5)).toBe(SPACING.word.steps[0])
    expect(spacingAt('word', 99)).toBe(SPACING.word.steps[SPACING.word.steps.length - 1])
  })

  it('never returns a value that is not a number', () => {
    for (const key of KEYS) {
      for (const idx of [-1, 0, 1.4, 99, NaN]) {
        expect(Number.isFinite(spacingAt(key, idx)), `${key} @ ${idx}`).toBe(true)
      }
    }
  })
})

describe('setSpacing', () => {
  it('moves one spacing and leaves the other three', () => {
    const next = reducer(initialState, { type: 'setSpacing', key: 'word', idx: 2 })
    expect(next.spacing.word).toBe(2)
    expect(next.spacing.letter).toBe(initialState.spacing.letter)
    expect(next.spacing.line).toBe(initialState.spacing.line)
    expect(next.spacing.paragraph).toBe(initialState.spacing.paragraph)
  })

  it('clamps to the ends of the scale', () => {
    expect(reducer(initialState, { type: 'setSpacing', key: 'line', idx: -3 }).spacing.line).toBe(0)
    const top = SPACING.line.steps.length - 1
    expect(reducer(initialState, { type: 'setSpacing', key: 'line', idx: 99 }).spacing.line).toBe(top)
  })

  /* NaN survives `Math.min`/`Math.max` untouched and would reach the array —
   * the same trap `setStepIdx` documents. */
  it('drops a value that is not a number rather than storing it', () => {
    expect(reducer(initialState, { type: 'setSpacing', key: 'letter', idx: NaN })).toBe(initialState)
    expect(reducer(initialState, { type: 'setSpacing', key: 'letter', idx: Infinity })).toBe(
      initialState,
    )
  })

  it('returns the same state when nothing moved, so nothing re-renders', () => {
    const at = initialState.spacing.paragraph
    expect(reducer(initialState, { type: 'setSpacing', key: 'paragraph', idx: at })).toBe(
      initialState,
    )
  })
})
