import { isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composeCapabilities, createKernelServices, kernelApi, type CommandContext, type Diagnostics } from '../../kernel'
import { HEARTBEAT_MS, example } from './index'

/**
 * The example capability registers exactly one of each surface — a pane, a
 * command, a service — under its own prefix, composes cleanly, and leaves
 * nothing behind on dispose: the interval its `start` begins is the thing
 * WI-5.12's deletion test will prove gone with the capability, and this is
 * where it is proved to be its own to clean up.
 */

function recordingDiagnostics(log: string[] = []): Diagnostics & { log: string[] } {
  const d: Diagnostics & { log: string[] } = {
    log,
    child: () => d,
    info: (event) => log.push(event),
    warn: (event) => log.push(`warn ${event}`),
    error: (event) => log.push(`error ${event}`),
  }
  return d
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('the example capability', () => {
  it('is namespaced under "example" on every surface', () => {
    expect(example.id).toBe('example')
    expect(example.requires).toEqual([])
    expect(example.panes?.map((p) => p.id)).toEqual(['example:pane'])
    expect(example.services?.map((s) => [s.name, s.grant])).toEqual([['example.ping', 'example:ping']])
  })

  it('composes with one pane, one command and one service, and starts one timer', async () => {
    const diagnostics = recordingDiagnostics()
    const api = kernelApi(createKernelServices({ fs: null, storage: null, diagnostics }))
    const composition = await composeCapabilities([example], api, new AbortController().signal)

    expect(composition.order).toEqual(['example'])
    expect(composition.panes).toHaveLength(1)
    expect(composition.panes[0]).toMatchObject({ id: 'example:pane', label: 'Example', screens: ['library', 'reader'] })
    expect([...composition.services.keys()]).toEqual(['example.ping'])
    const opened: string[] = []
    const ctx: CommandContext = { screen: 'reader', pane: null, hasBook: false, openPane: (pane) => opened.push(pane) }
    const commands = composition.commands(ctx)
    expect(commands.map((c) => [c.id, c.group])).toEqual([['example:hello', 'Example']])
    commands[0]?.run()
    expect(opened).toEqual(['example:pane'])
    expect(composition.commands({ ...ctx, pane: 'example:pane' })[0]?.on).toBe(true)

    expect(vi.getTimerCount()).toBe(1)
    expect(diagnostics.log).toContain('example.started')
    composition.dispose()
  })

  it('the service echoes its request', async () => {
    const service = example.services?.[0]
    const result = await service?.handler({ n: 1 }, {
      peer: 'p',
      signal: new AbortController().signal,
      input: (async function* () {})(),
    })
    expect(result).toEqual({ n: 1 })
  })

  it('renders a React element from the pane, and the element says what it is', () => {
    const node = example.panes?.[0]?.render()
    expect(isValidElement(node)).toBe(true)
    expect(renderToStaticMarkup(node as ReactElement)).toContain('example')
  })

  it('the heartbeat ticks on its interval and stops with dispose — no timer leaks', async () => {
    const diagnostics = recordingDiagnostics()
    const api = kernelApi(createKernelServices({ fs: null, storage: null, diagnostics }))
    const composition = await composeCapabilities([example], api, new AbortController().signal)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(HEARTBEAT_MS * 2)
    expect(diagnostics.log.filter((e) => e === 'example.heartbeat')).toHaveLength(2)
    composition.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(HEARTBEAT_MS * 2)
    expect(diagnostics.log.filter((e) => e === 'example.heartbeat')).toHaveLength(2)
    // Disposing twice is nothing.
    composition.dispose()
  })

  it('stops when the lifetime signal aborts, too', async () => {
    const controller = new AbortController()
    const api = kernelApi(createKernelServices({ fs: null, storage: null }))
    await composeCapabilities([example], api, controller.signal)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    expect(vi.getTimerCount()).toBe(0)
  })
})
