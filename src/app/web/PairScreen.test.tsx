// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PairScreen } from './PairScreen'
import type { SubmitOutcome } from './session'

/**
 * The six digits, from the side that types them.
 *
 * The shelf half of WI-18.9 has `BrowsersPane.test.tsx`; this half had nothing,
 * and it is the half a reader actually touches. Everything asserted here is a
 * decision the component's own header argues for — so if one is reversed, this
 * file is where the argument is met.
 *
 * The refusals matter more than they look. The shelf answers `401` for both a
 * wrong code and a stale one, so a guess cannot learn which it was; the CLIENT
 * separates the cases whose FIX differs, because "no code is showing" and "that
 * was not the code" send a person to two different places.
 */

afterEach(cleanup)

const outcome = (kind: SubmitOutcome['kind']) => vi.fn(async () => ({ kind }) as SubmitOutcome)

const field = () => screen.getByLabelText('The six-digit code shown on your computer') as HTMLInputElement
const button = () => screen.getByRole('button') as HTMLButtonElement

const type = (value: string) => fireEvent.change(field(), { target: { value } })

/**
 * A submission the test decides the end of.
 *
 * Written as a helper rather than a `let` the promise's callback assigns,
 * because TypeScript cannot see that the callback runs before the release and
 * narrows the variable to `never` — so calling it is a compile error even
 * though the code is correct.
 */
function held() {
  let release!: (outcome: SubmitOutcome) => void
  const submit = vi.fn<(code: string) => Promise<SubmitOutcome>>(
    () => new Promise<SubmitOutcome>((resolve) => { release = resolve }),
  )
  return { submit, release: (outcome: SubmitOutcome = { kind: 'connected' }) => release(outcome) }
}

describe('PairScreen', () => {
  it('accepts six digits and reports the connection', async () => {
    const submit = outcome('connected')
    const onConnected = vi.fn()
    render(<PairScreen onConnected={onConnected} submit={submit} />)
    type('123456')
    fireEvent.click(button())
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce())
    expect(submit).toHaveBeenCalledWith('123456')
  })

  /* A PASTED CODE IS THE COMMON CASE on a phone, and it arrives with whatever
     formatting it was copied with. `normalizeCode` strips it; this is the
     assertion that the field is actually wired to it. */
  it('takes a pasted code with spaces or dashes in it', () => {
    render(<PairScreen onConnected={vi.fn()} submit={outcome('connected')} />)
    type('12 34-56')
    expect(field().value).toBe('123456')
    expect(button().disabled).toBe(false)
  })

  it('ignores letters and stops at six digits', () => {
    render(<PairScreen onConnected={vi.fn()} submit={outcome('connected')} />)
    type('9a8b7c6d5e4f321')
    expect(field().value).toBe('987654')
  })

  /* THE SHELF MUST NOT BE ASKED about a code that cannot be one. Every
     submission spends one of five attempts, and a five-digit guess would spend
     one to be told what the client already knows. */
  it('cannot be submitted with fewer than six digits', () => {
    const submit = outcome('connected')
    render(<PairScreen onConnected={vi.fn()} submit={submit} />)
    type('12345')
    expect(button().disabled).toBe(true)
    fireEvent.click(button())
    expect(submit).not.toHaveBeenCalled()
  })

  it('tells a reader which problem they have, not that something went wrong', async () => {
    for (const [kind, expected] of [
      ['wrong', /not the code/],
      ['no-code-showing', /No code is showing/],
      ['expired', /has expired/],
      ['no-attempts-left', /Too many tries/],
      ['unreachable', /not answering/],
    ] as const) {
      cleanup()
      render(<PairScreen onConnected={vi.fn()} submit={outcome(kind)} />)
      type('123456')
      fireEvent.click(button())
      const alert = await screen.findByRole('alert')
      expect(alert.textContent, kind).toMatch(expected)
    }
  })

  /* ANNOUNCED, because the reader may be looking at the keyboard rather than
     the screen — and tied to the field, so a screen reader reaching the input
     reads the reason it was refused. */
  it('ties the problem to the field for a screen reader', async () => {
    render(<PairScreen onConnected={vi.fn()} submit={outcome('wrong')} />)
    type('123456')
    fireEvent.click(button())
    const alert = await screen.findByRole('alert')
    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(field().getAttribute('aria-describedby')).toBe(alert.id)
  })

  it('is not marked invalid before anything has been refused', () => {
    render(<PairScreen onConnected={vi.fn()} submit={outcome('wrong')} />)
    expect(field().getAttribute('aria-invalid')).toBe('false')
    expect(field().getAttribute('aria-describedby')).toBeNull()
  })

  /* CLEARED, so the next attempt starts clean. Six digits is little enough to
     retype, and editing a wrong one in place is how a second wrong attempt gets
     spent on a code that was never going to work. */
  it('empties the field after a refusal', async () => {
    render(<PairScreen onConnected={vi.fn()} submit={outcome('wrong')} />)
    type('123456')
    fireEvent.click(button())
    await screen.findByRole('alert')
    expect(field().value).toBe('')
  })

  /**
   * THE STALE VERDICT. The previous problem is cleared BEFORE the request, not
   * after it — left up, it reads as the verdict on the attempt now in flight,
   * so a reader retyping a correct code watches "that was not the code" sit
   * there while it succeeds.
   */
  it('takes the old problem down while the next attempt is in flight', async () => {
    let release!: (outcome: SubmitOutcome) => void
    const submit = vi
      .fn<(code: string) => Promise<SubmitOutcome>>()
      .mockResolvedValueOnce({ kind: 'wrong' })
      .mockImplementationOnce(() => new Promise<SubmitOutcome>((resolve) => { release = resolve }))
    render(<PairScreen onConnected={vi.fn()} submit={submit} />)

    type('123456')
    fireEvent.click(button())
    await screen.findByRole('alert')

    type('654321')
    fireEvent.click(button())
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

    release({ kind: 'connected' })
  })

  /* ONE ATTEMPT PER PRESS. Five is the whole budget, so a double tap that spent
     two of them would cost a reader nearly half their tries for one gesture. */
  it('spends one attempt however many times the button is pressed', async () => {
    const { submit, release } = held()
    render(<PairScreen onConnected={vi.fn()} submit={submit} />)
    type('123456')
    fireEvent.click(button())
    await waitFor(() => expect(button().disabled).toBe(true))
    fireEvent.click(button())
    fireEvent.click(button())
    expect(submit).toHaveBeenCalledOnce()
    expect(button().textContent).toBe('Connecting…')
    release()
  })

  /**
   * THE SAME GUARD, THROUGH THE DOOR THE DISABLED BUTTON DOES NOT COVER.
   *
   * The test above passes on the button's `disabled` attribute alone: a click
   * on a disabled button never reaches the handler, so removing the handler's
   * own `|| busy` guard leaves it green. Measured — that mutation survived.
   *
   * A form does not only submit by clicking its button. Enter in the field
   * submits it too, and on a phone that is the ordinary way, where the keyboard
   * shows a "go" key and the button may be under it. That path reaches the
   * handler whatever the button's state, so this is what actually holds the
   * guard in place.
   */
  it('spends one attempt when the form is submitted directly, not through the button', async () => {
    const { submit, release } = held()
    const { container } = render(<PairScreen onConnected={vi.fn()} submit={submit} />)
    const form = container.querySelector('form')
    expect(form, 'the screen must still be a form — Enter is how a phone submits it').toBeTruthy()

    type('123456')
    fireEvent.submit(form!)
    await waitFor(() => expect(submit).toHaveBeenCalledOnce())
    fireEvent.submit(form!)
    fireEvent.submit(form!)
    expect(submit).toHaveBeenCalledOnce()
    release()
  })

  /* AND THE SHORT-CODE GUARD THROUGH THE SAME DOOR. Enter on four digits must
     not spend an attempt either. */
  it('does not submit a short code on Enter', () => {
    const submit = outcome('connected')
    const { container } = render(<PairScreen onConnected={vi.fn()} submit={submit} />)
    type('1234')
    fireEvent.submit(container.querySelector('form')!)
    expect(submit).not.toHaveBeenCalled()
  })
})
