import { describe, expect, it, vi } from 'vitest'
import { act, reachMarginalia } from './circle-navigate.mjs'

/**
 * The orchestration, against injected dependencies.
 *
 * ⚠️ **THIS IS THE COVERAGE THE EXCLUSION WAS HIDING.** `circle-drive.mjs` was
 * excluded on the rule that a process entry cannot be called by a test. That is
 * true of argv and exit codes and was NOT true of these two functions, which
 * are pure control flow over two injected callbacks. Excluding them recorded
 * "cannot be measured" about code that simply had not been.
 *
 * No socket, no app, no clock: `wait` resolves immediately, so a 120-try
 * patience costs nothing here.
 */

const now = () => Promise.resolve()

describe('act — the assertion is the observation, not the call returning', () => {
  it('returns as soon as the world looks right, and says how long it took', async () => {
    let seen = 0
    const evaluate = vi.fn(() => Promise.resolve({ ok: true }))
    const result = await act({ evaluate, wait: now }, 'sock', 'script', 'the label', () => ++seen >= 2)
    expect(result).toEqual({ ok: true, confirmedAfterMs: 1000 })
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it('gives up by NAME rather than hanging, when the app never arrives', async () => {
    const result = await act({ evaluate: () => Promise.resolve({ ok: true }), wait: now }, 's', 'x', 'open the pane', () => false, 3)
    expect(result.ok).toBe(false)
    expect(result.why).toMatch(/open the pane: the script ran and the app never reached the expected state/u)
  })

  it('returns the script’s OWN refusal without polling at all', async () => {
    /* A script that reports `ok: false` has said what is wrong; polling for a
       state it already refused to reach would replace that reason with a
       timeout, which is the less useful of the two. */
    const verify = vi.fn(() => true)
    const refusal = { ok: false, why: 'no switch labelled X' }
    const result = await act({ evaluate: () => Promise.resolve(refusal), wait: now }, 's', 'x', 'flip', verify)
    expect(result).toBe(refusal)
    expect(verify).not.toHaveBeenCalled()
  })

  it('PROPAGATES an error rather than treating it as "probably ran"', async () => {
    /* The regression this guards: a bridge timeout was once swallowed on the
       theory that the script had landed anyway. It had not — the script never
       parsed — and swallowing hid that permanently. */
    const boom = new Error('Script execution timeout')
    await expect(act({ evaluate: () => Promise.reject(boom), wait: now }, 's', 'x', 'l', () => true)).rejects.toThrow(boom)
  })
})

describe('reachMarginalia — every step names its own failure', () => {
  const scripts = {
    AT_SHELF: 'AT_SHELF',
    TO_SHELF: 'TO_SHELF',
    OPEN_MARGINALIA: 'OPEN_MARGINALIA',
    READ_MARKS: 'READ_MARKS',
    filterShelf: (t) => 'filter:' + t,
    shelfMatches: (t) => 'matches:' + t,
    openMatch: (t) => 'open:' + t,
  }

  /** A fake app: answers each script from `state`, and records what it was asked. */
  const appWith = (state) => {
    const asked = []
    const evaluate = (_socket, script) => {
      asked.push(script)
      if (script === 'AT_SHELF') return Promise.resolve({ shelf: state.shelf })
      if (script.startsWith('matches:')) return Promise.resolve({ cells: state.cells })
      if (script === 'READ_MARKS') return Promise.resolve({ rows: state.rows })
      if (script === 'TO_SHELF') { state.shelf = true; return Promise.resolve({ ok: true }) }
      if (script.startsWith('filter:')) { state.cells = 1; return Promise.resolve({ ok: true }) }
      if (script.startsWith('open:')) { state.shelf = false; return Promise.resolve({ ok: true }) }
      if (script === 'OPEN_MARGINALIA') { state.rows = [{}]; return Promise.resolve({ ok: true }) }
      throw new Error('unexpected script: ' + script)
    }
    return { evaluate, asked }
  }

  it('walks shelf → filter → open → Marginalia when it starts in the reader', async () => {
    const app = appWith({ shelf: false, cells: 0, rows: [] })
    const result = await reachMarginalia({ evaluate: app.evaluate, wait: now }, 's', 'A Book', scripts)
    expect(result).toEqual({ ok: true })
    expect(app.asked).toContain('TO_SHELF')
    expect(app.asked).toContain('filter:A Book')
    expect(app.asked).toContain('open:A Book')
    expect(app.asked).toContain('OPEN_MARGINALIA')
  })

  it('SKIPS the trip to the shelf when it is already there — the step is idempotent', async () => {
    const app = appWith({ shelf: true, cells: 0, rows: [] })
    await reachMarginalia({ evaluate: app.evaluate, wait: now }, 's', 'A Book', scripts)
    expect(app.asked).not.toContain('TO_SHELF')
  })

  it('stops at the step that failed, naming it, and does not go on', async () => {
    /* A book that never narrows must not then be "opened": the later steps
       would report their own confusing failures about a state the earlier one
       never established. */
    const app = appWith({ shelf: true, cells: 0, rows: [] })
    const evaluate = (socket, script) => (script.startsWith('filter:') ? Promise.resolve({ ok: true }) : app.evaluate(socket, script))
    const result = await reachMarginalia({ evaluate, wait: now }, 's', 'A Book', scripts)
    expect(result.ok).toBe(false)
    expect(result.why).toMatch(/narrow the shelf/u)
    expect(app.asked).not.toContain('open:A Book')
  })

  it('reports the OPEN step when the book never leaves the shelf', async () => {
    const app = appWith({ shelf: true, cells: 1, rows: [] })
    const evaluate = (socket, script) => (script.startsWith('open:') ? Promise.resolve({ ok: true }) : app.evaluate(socket, script))
    const result = await reachMarginalia({ evaluate, wait: now }, 's', 'A Book', scripts)
    expect(result.why).toMatch(/open the book/u)
  })

  it('reports Marginalia when the pane never draws a share control', async () => {
    const app = appWith({ shelf: true, cells: 1, rows: [] })
    const evaluate = (socket, script) => (script === 'OPEN_MARGINALIA' ? Promise.resolve({ ok: true }) : app.evaluate(socket, script))
    const result = await reachMarginalia({ evaluate, wait: now }, 's', 'A Book', scripts)
    expect(result.why).toMatch(/open Marginalia/u)
  })
})
