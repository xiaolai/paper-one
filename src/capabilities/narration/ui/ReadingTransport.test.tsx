// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_UI as ui } from '../../../kernel'
import { clockOf, formatRate, fractionOf, nextRate, ReadingTransport } from './ReadingTransport'
import type { Speech } from './useSpeech'

afterEach(cleanup)

/**
 * A reading under way, spelled out in full.
 *
 * ⚠️ **NOT A CAST, AND THAT IS THE POINT.** `as unknown as Speech` would have
 * type-checked while missing every new member, and the transport would then have
 * read `undefined` at runtime. Adding a member to `Speech` should break this line.
 */
const SPEAKING: Speech = {
  available: true,
  speaking: true,
  paused: false,
  followsWords: false,
  chapters: { back: false, forward: false },
  at: null,
  preparing: false,
  refusal: null,
  start: () => {},
  stop: () => {},
  pause: () => {},
  resume: () => {},
  seekToFraction: () => false,
  seekToOffset: () => false,
  stepSentence: () => {},
  stepParagraph: () => {},
  stepChapter: () => {},
}

/** The transport over a reading that records what it was asked to do. */
function listening(over: Partial<Speech> = {}, rate = 1) {
  const asked: string[] = []
  const speech: Speech = {
    ...SPEAKING,
    stop: () => asked.push('stop'),
    pause: () => asked.push('pause'),
    resume: () => asked.push('resume'),
    stepSentence: (by) => asked.push(`sentence ${by}`),
    stepParagraph: (by) => asked.push(`paragraph ${by}`),
    stepChapter: (by) => asked.push(`chapter ${by}`),
    seekToFraction: (fraction) => {
      asked.push(`seek ${fraction}`)
      return true
    },
    ...over,
  }
  const onRate = vi.fn<(rate: number) => void>()
  render(<ReadingTransport speech={speech} rate={rate} onRate={onRate} />)
  return { asked, onRate }
}

/**
 * Every control here is a verb the reader presses while a book is being read
 * aloud, and each one is a different verb: a label on the wrong button, or a
 * step of the wrong size, is a control that does something other than what it
 * says.
 */
describe('the reading transport', () => {
  it.each([
    ['Previous sentence', 'sentence -1'],
    ['Next sentence', 'sentence 1'],
    ['Previous paragraph', 'paragraph -1'],
    ['Next paragraph', 'paragraph 1'],
    ['Stop reading aloud', 'stop'],
  ])('%s asks for %s', (name, expected) => {
    const { asked } = listening()
    fireEvent.click(screen.getByRole('button', { name }))
    expect(asked).toEqual([expected])
  })

  it('offers a chapter step only where there is a chapter to step to', () => {
    /* ⚠️ **ABSENT, NOT DISABLED.** A reader in a book whose contents does not
       name the section they are in has genuinely no next chapter — "not here"
       rather than "not now", which is what an absent control says. */
    listening({ chapters: { back: false, forward: false } })
    expect(screen.queryByRole('button', { name: 'Previous chapter' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Next chapter' })).toBeNull()

    cleanup()
    const { asked } = listening({ chapters: { back: true, forward: true } })
    fireEvent.click(screen.getByRole('button', { name: 'Previous chapter' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next chapter' }))
    expect(asked).toEqual(['chapter -1', 'chapter 1'])
  })

  it('offers each direction on its own answer', () => {
    listening({ chapters: { back: true, forward: false } })
    expect(screen.getByRole('button', { name: 'Previous chapter' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Next chapter' })).toBeNull()
    cleanup()
    listening({ chapters: { back: false, forward: true } })
    expect(screen.queryByRole('button', { name: 'Previous chapter' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Next chapter' })).toBeTruthy()
  })

  it('pauses a reading that is speaking', () => {
    const { asked } = listening({ paused: false })
    const button = screen.getByRole('button', { name: 'Pause' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.getAttribute('title')).toBe('Pause')
    expect(button.getAttribute('aria-label'), 'named by its own label, not only its title').toBe('Pause')
    fireEvent.click(button)
    expect(asked).toEqual(['pause'])
  })

  it('goes on with one that is paused, and says so on the same control', () => {
    const { asked } = listening({ paused: true })
    expect(screen.queryByRole('button', { name: 'Pause' }), 'a paused reading offered Pause').toBeNull()
    const button = screen.getByRole('button', { name: 'Go on reading' })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.getAttribute('title')).toBe('Go on reading')
    expect(button.getAttribute('aria-label')).toBe('Go on reading')
    fireEvent.click(button)
    expect(asked).toEqual(['resume'])
  })

  it('draws a play glyph while paused and a pause glyph while reading', () => {
    listening({ paused: true })
    expect(screen.getByRole('button', { name: 'Go on reading' }).querySelector('.lucide-play')).toBeTruthy()
    cleanup()
    listening({ paused: false })
    expect(screen.getByRole('button', { name: 'Pause' }).querySelector('.lucide-pause')).toBeTruthy()
  })

  it('titles each step with the step it takes', () => {
    listening({ chapters: { back: true, forward: true } })
    for (const name of [
      'Previous chapter',
      'Previous paragraph',
      'Previous sentence',
      'Next sentence',
      'Next paragraph',
      'Next chapter',
      'Stop reading aloud',
    ]) {
      expect(screen.getByRole('button', { name }).getAttribute('title'), name).toBe(name)
    }
  })

  it('is one group, built from the shared classes', () => {
    /* §07's controls are one geometry and one hit area, and the transport's own
       class is what makes its row narrower than the chrome's. */
    listening()
    expect(screen.getByRole('group', { name: 'Reading aloud' }).className).toBe(ui.transport)
    for (const name of ['Previous sentence', 'Pause', 'Stop reading aloud']) {
      const classes = screen.getByRole('button', { name }).className.split(' ')
      expect(classes, name).toEqual([ui.barButton, ui.transportButton])
    }
    expect(screen.getByRole('button', { name: /^Reading speed/u }).className.split(' ')).toEqual([
      ui.barButton,
      ui.transportButton,
      ui.rate,
    ])
  })

  it.each([
    [1, '1×'],
    [1.25, '1.25×'],
    [1.5, '1.5×'],
    [2, '2×'],
  ])('reads %s back as %s — no trailing zero, which would read as a measurement', (rate, shown) => {
    listening({}, rate)
    const button = screen.getByRole('button', { name: `Reading speed ${shown}` })
    expect(button.textContent).toBe(shown)
    expect(button.getAttribute('title')).toBe(`Reading speed — ${shown}, tap for the next`)
  })

  it('asks for the next speed when the speed is tapped', () => {
    const { onRate } = listening({}, 1.25)
    fireEvent.click(screen.getByRole('button', { name: /^Reading speed/u }))
    expect(onRate.mock.calls).toEqual([[1.5]])
  })
})

/**
 * ⚠️ **"FASTER" SKIPPED SPEEDS AND WENT SLOWER.** It advanced one step past the
 * NEAREST step, which is right on the ramp and wrong off it — and off it is the
 * case the nearest-match existed for, a rate stored by a build with another
 * ramp. `1.4` went to `1.75` over `1.5`, and `2.4` wrapped to `0.5` over `2.5`.
 */
describe('the next speed', () => {
  it.each([
    [1, 1.25, 'on the ramp, the next step'],
    [1.4, 1.5, 'off the ramp, the first faster step — not one past the nearest'],
    [2.4, 2.5, 'near the top, the top — not a wrap to the slowest'],
    [2.5, 0.5, 'at the top, round to the slowest'],
    [9, 0.5, 'above the ramp entirely, round to the slowest'],
  ])('from %s goes to %s: %s', (from, to) => {
    expect(nextRate(from)).toBe(to)
  })

  it('writes a speed with no trailing zero', () => {
    expect(formatRate(1)).toBe('1×')
    expect(formatRate(1.25)).toBe('1.25×')
    expect(formatRate(1.2500001)).toBe('1.25×')
  })
})

describe('a section being made into audio', () => {
  it('says so, and offers a pause and a stop and nothing else', () => {
    /* ⚠️ **"MAKING" AND NOT "LOADING" — WI-34.5's ONE NEW SENTENCE.** WI-34.0
       measured a real section at 315 s on an idle M4 Max. Nothing is arriving
       over a wire, so calling it buffering would be a lie about a five-minute
       wait — and a wait a reader cannot leave is worse than one they can. */
    const { asked } = listening({ preparing: true, chapters: { back: true, forward: true } })
    expect(screen.getByRole('group', { name: 'Reading aloud' }).className).toBe(ui.transport)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Making this chapter’s audio…')
    expect(status.className).toBe(ui.preparing)
    /* Nothing else is drawn, because there is nothing yet to step or scrub. */
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Pause',
      'Stop reading aloud',
    ])
    expect(screen.queryByRole('slider')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop reading aloud' }))
    expect(asked).toEqual(['pause', 'stop'])
  })

  it('keeps Pause while the next chapter is prepared, and Go on once paused', () => {
    /* ⚠️ **THE PAUSE CONTROL VANISHED AT EVERY CHAPTER CROSSING.** A clip the store
       already holds is prepared for 25–270 ms, and this view drew only Stop, so a
       press in that window found nothing (`2026-11-01-d4-pause-closed.md`). */
    const { asked } = listening({ preparing: true, paused: true })
    const goOn = screen.getByRole('button', { name: 'Go on reading' })
    expect(goOn.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(goOn)
    expect(asked).toEqual(['resume'])
  })

  it('gives the ordinary transport back once there is something to hear', () => {
    listening({ preparing: false, at: { positionMs: 0, durationMs: 1000 } })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()
  })
})

describe('how far through the chapter', () => {
  it('is absent where the voice cannot say — which is Web Speech', () => {
    /* ⚠️ ABSENT, NOT DISABLED, for the reason the chapter buttons are: a disabled
       scrubber says "not now", and the true statement is "not on this voice". */
    listening({ at: null })
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('shows the position and the length, with hours where a chapter has them', () => {
    listening({ at: { positionMs: 247_000, durationMs: 2_915_100 } })
    const slider = screen.getByRole('slider', { name: 'How far through the chapter' }) as HTMLInputElement
    expect(slider.getAttribute('aria-valuetext')).toBe('4:07 of 48:35')
    expect(slider.getAttribute('title')).toBe('4:07 of 48:35')
    expect(slider.className).toBe(ui.scrub)
    expect([slider.min, slider.max]).toEqual(['0', '1000'])
    /* 247 000 of 2 915 100 is 0.0847, which at a thousand steps is 85. */
    expect(slider.value).toBe('85')
  })

  it('asks for a fraction when it is dragged', () => {
    const { asked } = listening({ at: { positionMs: 0, durationMs: 2_915_100 } })
    fireEvent.change(screen.getByRole('slider'), { target: { value: '250' } })
    expect(asked).toEqual(['seek 0.25'])
  })
})

describe('the clock and the fraction the scrubber is built on', () => {
  it('writes minutes and seconds, and hours only where there are some', () => {
    /* ⚠️ HOURS ARE NOT OPTIONAL: WI-34.0 measured the character-weighted median
       section of this shelf at 48.6 minutes and its p95 past an hour, so `m:ss`
       would show `68:12` for a real chapter. */
    expect(clockOf(0)).toBe('0:00')
    expect(clockOf(999)).toBe('0:00')
    expect(clockOf(1000)).toBe('0:01')
    expect(clockOf(61_000)).toBe('1:01')
    expect(clockOf(247_000)).toBe('4:07')
    expect(clockOf(2_915_100)).toBe('48:35')
    expect(clockOf(3_600_000)).toBe('1:00:00')
    expect(clockOf(3_750_000)).toBe('1:02:30')
    expect(clockOf(4_092_000)).toBe('1:08:12')
  })

  it('takes a nonsense duration as nothing rather than showing NaN', () => {
    expect(clockOf(-1)).toBe('0:00')
    expect(clockOf(Number.NaN)).toBe('0:00')
    expect(clockOf(Number.POSITIVE_INFINITY)).toBe('0:00')
  })

  it('never divides by a zero duration', () => {
    /* A section of one sample rounds to 0 ms, and `0 / 0` is `NaN`, which a
       `range` takes as its minimum silently. */
    expect(fractionOf({ positionMs: 0, durationMs: 0 })).toBe(0)
    expect(fractionOf({ positionMs: 500, durationMs: 0 })).toBe(0)
    expect(fractionOf({ positionMs: 500, durationMs: -1 })).toBe(0)
  })

  it('clamps rather than reporting past either end', () => {
    expect(fractionOf({ positionMs: 0, durationMs: 1000 })).toBe(0)
    expect(fractionOf({ positionMs: 500, durationMs: 1000 })).toBe(0.5)
    expect(fractionOf({ positionMs: 1000, durationMs: 1000 })).toBe(1)
    /* The player's own position can sit a frame past the buffer's length. */
    expect(fractionOf({ positionMs: 1200, durationMs: 1000 })).toBe(1)
    expect(fractionOf({ positionMs: -5, durationMs: 1000 })).toBe(0)
  })
})
