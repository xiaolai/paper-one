// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CAPABILITY_UI as ui, type SteppedScale } from '../../../kernel'
import { StepRow } from './StepRow'

afterEach(cleanup)

const SPEED: SteppedScale = { steps: [0.5, 1, 1.5, 2], def: 1, unit: 'x' }
const PAUSE: SteppedScale = { steps: [0, 150, 300], def: 1, unit: 'ms' }

function row(value: number, scale: SteppedScale = SPEED, label = 'Speed') {
  const asked: number[] = []
  const view = render(<StepRow label={label} scale={scale} value={value} onChange={(at) => asked.push(at)} />)
  return {
    asked,
    view,
    less: () => screen.getByRole('button', { name: `Less ${label.toLowerCase()}` }) as HTMLButtonElement,
    more: () => screen.getByRole('button', { name: `More ${label.toLowerCase()}` }) as HTMLButtonElement,
    pips: () => screen.getByRole('img'),
  }
}

describe('a stepped setting', () => {
  it('names the amount it stands at, with a times sign for a bare multiplier', () => {
    const { view } = row(2)
    expect(view.container.querySelector(`.${ui.stepper}`)?.getAttribute('title')).toBe('Speed: 1.5×')
  })

  it('writes any other unit as it is', () => {
    const { view } = row(2, PAUSE, 'Pause between sentences')
    expect(view.container.querySelector(`.${ui.stepper}`)?.getAttribute('title')).toBe('Pause between sentences: 300ms')
  })

  it('shows its position as pips, lit up to the step it stands at', () => {
    const { pips } = row(1)
    expect(pips().getAttribute('aria-label')).toBe('Step 2 of 4')
    expect(pips().className).toBe(ui.pips)
    expect([...pips().children].map((pip) => [pip.className, pip.getAttribute('data-on')])).toEqual([
      [ui.pip, 'true'],
      [ui.pip, 'true'],
      [ui.pip, 'false'],
      [ui.pip, 'false'],
    ])
  })

  it('asks for the step either side of where it stands', () => {
    const { asked, less, more } = row(1)
    fireEvent.click(less())
    fireEvent.click(more())
    expect(asked).toEqual([0, 2])
  })

  it('goes dead at each end rather than doing nothing there', () => {
    const bottom = row(0)
    expect(bottom.less().disabled).toBe(true)
    expect(bottom.more().disabled).toBe(false)
    cleanup()
    const top = row(3)
    expect(top.less().disabled).toBe(false)
    expect(top.more().disabled).toBe(true)
  })

  it('clamps a position from outside the scale, which a stale index can be', () => {
    /* Below the scale it stands at the first step, and above it at the last —
       and a press asks from there, not from the number it was handed. */
    const under = row(-3)
    expect(under.pips().getAttribute('aria-label')).toBe('Step 1 of 4')
    expect(under.less().disabled).toBe(true)
    fireEvent.click(under.more())
    expect(under.asked).toEqual([1])
    cleanup()
    const over = row(9)
    expect(over.pips().getAttribute('aria-label')).toBe('Step 4 of 4')
    expect(over.more().disabled).toBe(true)
    fireEvent.click(over.less())
    expect(over.asked).toEqual([2])
    expect(screen.getByTitle('Speed: 2×')).toBeTruthy()
  })

  it('is a row built from the shared classes', () => {
    const { view, less, more } = row(1)
    const root = view.container.firstElementChild!
    expect(root.className).toBe(ui.row)
    expect(root.firstElementChild?.className).toBe(ui.grow)
    expect(root.firstElementChild?.textContent).toBe('Speed')
    expect([less().className, more().className]).toEqual([ui.stepperButton, ui.stepperButton])
    expect(less().type).toBe('button')
  })
})
