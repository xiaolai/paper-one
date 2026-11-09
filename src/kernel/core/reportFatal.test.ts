// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { explainFatal, installFatalHandlers, reportFatal } from './reportFatal'

/**
 * THE FATAL SURFACE HAS TO STATE THE FAULT, not the victim.
 *
 * A packaged app has no console anyone will read, so this banner is the only
 * account of a startup failure there is. It printed `name`, `message` and
 * `stack` and dropped `cause` — and `cause` is where the diagnosis lives:
 * `composeCapabilities` reports `capability "sync" failed to start; nothing
 * stays registered`, which names what gave way, while the sentence that says
 * WHY hangs one link below it.
 *
 * That cost two debugging sessions and one bug report with nothing actionable
 * in it. Both times the fault — a path Rust would not accept, then a journal
 * whose sequence went backwards — was one `cause` away from the text on screen.
 */

const errorWith = (message: string, cause: unknown) => new Error(message, { cause })

describe('explainFatal', () => {
  it('prints the cause under the error', () => {
    const text = explainFatal(errorWith('capability "sync" failed to start', new Error('seq 12040 does not increase past 12047')))
    expect(text).toContain('capability "sync" failed to start')
    expect(text).toContain('caused by:')
    expect(text).toContain('seq 12040 does not increase past 12047')
  })

  it('follows a chain more than one link deep', () => {
    const text = explainFatal(errorWith('outer', errorWith('middle', new Error('the actual fault'))))
    expect(text).toContain('the actual fault')
  })

  it('spells out an AggregateError, which is how a rollback reports itself', () => {
    /* The registry wraps a failed start together with every teardown that then
       failed; the interesting one can be any of them. */
    const text = explainFatal(new AggregateError([new Error('first thing'), new Error('second thing')], 'rollback failed'))
    expect(text).toContain('rollback failed')
    expect(text).toContain('first thing')
    expect(text).toContain('second thing')
  })

  /* THIS RUNS WHERE THINGS ARE ALREADY GOING WRONG. A reporter that recurses
     for ever, or hangs, replaces a bad error message with no error message. */
  it('survives a cycle', () => {
    const a = new Error('a')
    const b = errorWith('b', a)
    ;(a as Error & { cause?: unknown }).cause = b
    expect(() => explainFatal(a)).not.toThrow()
    expect(explainFatal(a)).toContain('…')
  })

  it('caps the depth', () => {
    let deep: unknown = new Error('bottom')
    for (let i = 0; i < 20; i++) deep = errorWith(`level ${i}`, deep)
    const text = explainFatal(deep)
    expect(text).toContain('…')
    expect(text).not.toContain('bottom')
  })

  /* THE EXACT SHAPE, so nothing is added to an error that has no cause and
     nothing is dropped from one that has. */
  it('prints a lone error as its name, message and stack, and nothing more', () => {
    const error = new Error('alone')
    error.stack = 'at the only frame'
    expect(explainFatal(error)).toBe('Error: alone\nat the only frame')
  })

  it('prints an error with no stack without inventing one', () => {
    const error = new Error('stackless')
    delete error.stack
    expect(explainFatal(error)).toBe('Error: stackless\n')
  })

  it('puts each thing underneath on a line of its own', () => {
    const one = new Error('first')
    one.stack = 's1'
    const two = new Error('second')
    two.stack = 's2'
    const outer = new AggregateError([one, two], 'rollback failed')
    outer.stack = 's0'
    expect(explainFatal(outer)).toBe('AggregateError: rollback failed\ns0\n  [0] Error: first\ns1\n  [1] Error: second\ns2')
  })

  it('lists `errors` only for an AggregateError', () => {
    const error = Object.assign(new Error('plain'), { errors: [new Error('not mine to list')] })
    expect(explainFatal(error)).not.toContain('not mine to list')
  })

  /* The cap counts from the error it is handed: an error AT the cap is still
     printed, and what hangs under it is not — through `errors` as through
     `cause`. */
  it('prints the error at the cap and stops under it', () => {
    const outer = new AggregateError([new Error('child')], 'at the cap')
    const text = explainFatal(outer, 6)
    expect(text.startsWith('AggregateError: at the cap\n')).toBe(true)
    expect(text).toContain('  [0] …')
    expect(text).not.toContain('child')
  })

  it('stops a cycle at the first repeat, not at the depth cap', () => {
    const a = new Error('a')
    const b = errorWith('b', a)
    ;(a as Error & { cause?: unknown }).cause = b
    expect(explainFatal(a).split('caused by:')).toHaveLength(3)
  })

  it('takes something that is not an Error at all', () => {
    // `unhandledrejection` hands over whatever was rejected — often a string.
    expect(explainFatal('just a string')).toBe('just a string')
    expect(explainFatal(undefined)).toBe('undefined')
  })
})

/**
 * THE BANNER MUST NOT OWN THE PAGE. It is fixed over the reader at up to 40vh,
 * and it was append-only with no way to close it: a reading run that hit one
 * error per frame finished with the bottom 40 % of every page covered by
 * copies of the same two lines, for the rest of the session.
 */
describe('the error banner', () => {
  const banner = () => document.getElementById('paper-fatal')
  const lines = () => Array.from(banner()?.querySelectorAll(':scope > div') ?? [], (el) => el.textContent)

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    banner()?.remove()
    vi.restoreAllMocks()
  })

  it('shows the label and the explained error', () => {
    reportFatal('Uncaught error', new Error('it broke', { cause: 'underneath' }))
    expect(banner()?.getAttribute('role')).toBe('alert')
    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toMatch(/^Uncaught error — Error: it broke\n/)
    expect(lines()[0]).toContain('caused by: underneath')
    expect(console.error).toHaveBeenCalledWith('Uncaught error', expect.any(Error))
  })

  it('counts a repeated error on one line instead of appending copies', () => {
    for (let i = 0; i < 50; i++) reportFatal('Uncaught error', 'ResizeObserver loop')
    expect(lines()).toEqual(['Uncaught error — ResizeObserver loop (×50)'])
  })

  it('keeps distinct errors apart, each counting its own repeats', () => {
    reportFatal('Uncaught error', 'first')
    reportFatal('Uncaught error', 'second')
    reportFatal('Uncaught error', 'first')
    reportFatal('Unhandled rejection', 'first')
    expect(lines()).toEqual(['Uncaught error — first (×2)', 'Uncaught error — second', 'Unhandled rejection — first'])
  })

  it('can be dismissed', () => {
    reportFatal('Uncaught error', 'once')
    const dismiss = banner()?.querySelector('button')
    expect(dismiss?.type).toBe('button')
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss the error report')
    dismiss?.click()
    expect(banner()).toBeNull()
  })

  it('comes back, counting afresh, for the next error after a dismissal', () => {
    reportFatal('Uncaught error', 'again')
    reportFatal('Uncaught error', 'again')
    banner()?.querySelector('button')?.click()
    reportFatal('Uncaught error', 'again')
    expect(lines()).toEqual(['Uncaught error — again'])
    expect(banner()?.querySelectorAll('button')).toHaveLength(1)
  })

  /* WHERE IT SITS IS THE DEFECT THIS FILE HAD, so the geometry is pinned:
     a fixed strip along the bottom, above everything, capped and scrolling. */
  it('floats over the page along the bottom, capped and scrolling', () => {
    reportFatal('Uncaught error', 'placed')
    const style = (banner() as HTMLElement).style
    expect(style.position).toBe('fixed')
    expect([style.left, style.right, style.bottom]).toEqual(['12px', '12px', '12px'])
    expect(style.zIndex).toBe('2147483647')
    expect(style.maxHeight).toBe('40vh')
    expect(style.overflow).toBe('auto')
    expect(style.padding).toBe('14px 16px')
    expect(style.borderRadius).toBe('14px')
    expect(style.getPropertyValue('background')).toContain('#FBF6EE')
    expect(style.getPropertyValue('border')).toContain('#E7D6BE')
    expect(style.color).toContain('#9E5A16')
    expect(style.getPropertyValue('font')).toContain('ui-monospace')
    expect(style.whiteSpace).toBe('pre-wrap')
  })

  it('draws its Dismiss button as a control that stays in reach', () => {
    reportFatal('Uncaught error', 'placed')
    const button = banner()?.querySelector('button') as HTMLButtonElement
    expect(button.textContent).toBe('Dismiss')
    const style = button.style
    expect(style.position).toBe('sticky')
    expect(style.top).toBe('0px')
    expect(style.cssFloat).toBe('right')
    expect(style.marginLeft).toBe('12px')
    expect(style.borderRadius).toBe('6px')
    expect(style.getPropertyValue('border')).toContain('#E7D6BE')
    expect(style.getPropertyValue('background')).toContain('#FBF6EE')
    expect(style.color).toBe('inherit')
    expect(style.getPropertyValue('font')).toBe('inherit')
    expect(style.cursor).toBe('pointer')
  })

  /* The listeners are captured rather than added: a window listener outlives
     the test that added it, and two installs would report every event twice. */
  const installed = () => {
    const handlers = new Map<string, (event: Event) => void>()
    vi.spyOn(window, 'addEventListener').mockImplementation((type: string, handler: unknown) => {
      handlers.set(type, handler as (event: Event) => void)
    })
    installFatalHandlers()
    return handlers
  }

  it('installs on a page that has no banner yet', () => {
    expect(banner()).toBeNull()
    expect(() => installed()).not.toThrow()
  })

  it('clears a banner left over from a previous load when installed', () => {
    reportFatal('Uncaught error', 'left over from a previous load')
    installed()
    expect(banner()).toBeNull()
  })

  it('reports uncaught errors and unhandled rejections once installed', () => {
    const handlers = installed()
    expect([...handlers.keys()]).toEqual(['error', 'unhandledrejection'])
    handlers.get('error')?.(new ErrorEvent('error', { message: 'only a message' }))
    handlers.get('error')?.(new ErrorEvent('error', { message: 'ignored', error: new Error('the error itself') }))
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown }
    rejection.reason = 'rejected'
    handlers.get('unhandledrejection')?.(rejection)
    expect(lines()).toEqual([
      'Uncaught error — only a message',
      expect.stringMatching(/^Uncaught error — Error: the error itself\n/),
      'Unhandled rejection — rejected',
    ])
  })
})
