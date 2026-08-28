// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AskContext, CompanionProvider } from '../../core/companion'
import { useCompanionThread } from './useCompanionThread'

/**
 * The thread's failure line — what the reader is told when an answer does not
 * arrive.
 *
 * WI-20.18. The line was built with `error instanceof Error ? error.message :
 * 'The companion could not answer'`, and the plugin rejects with `{ kind,
 * message }` — a plain object — so every failure the capability had not
 * wrapped reached the reader as the sentence that names nothing. The
 * translation to a reader's sentence lives in the companion capability, on the
 * far side of the port; what this hook owes is to SHOW whatever text arrived
 * rather than flatten it, and to keep the reader's own abort out of the
 * failure slot.
 */

afterEach(cleanup)

const CONTEXT: AskContext = { bookTitle: 'Moby-Dick', chapterLabel: 'Loomings', selection: null, passages: [] }

/** A provider whose `ask` yields the given deltas and then raises `cause`. */
function failingProvider(cause: unknown, deltas: readonly string[] = []): CompanionProvider {
  return {
    name: 'test',
    configured: true,
    async *ask() {
      for (const delta of deltas) yield delta
      throw cause
    },
  }
}

const askAndSettle = async (provider: CompanionProvider) => {
  const hook = renderHook(() => useCompanionThread(provider, () => CONTEXT))
  act(() => hook.result.current.ask('why?'))
  await waitFor(() => expect(hook.result.current.busy).toBe(false))
  const reply = hook.result.current.messages[1]
  if (reply === undefined) throw new Error('no reply message was added')
  return { hook, reply }
}

describe('the failure line', () => {
  it('shows the sentence an Error carries', async () => {
    const { reply } = await askAndSettle(failingProvider(new Error('That agent is not signed in')))
    expect(reply.failure).toBe('That agent is not signed in')
    expect(reply.streaming).toBe(false)
  })

  /* A provider that did not translate still hands over a `message`; showing
     it beats a sentence that says nothing. This is the shape the plugin
     rejects with, and it is not an `Error`. */
  it('shows the message of a plain-object rejection rather than flattening it', async () => {
    const { reply } = await askAndSettle(failingProvider({ kind: 'agentSignedOut', message: 'codex is not signed in' }))
    expect(reply.failure).toBe('codex is not signed in')
  })

  it('falls back to the generic sentence only when the rejection carries no text', async () => {
    const { reply } = await askAndSettle(failingProvider(null))
    expect(reply.failure).toBe('The companion could not answer')
  })

  /* What arrived before the failure is kept beside it — the reader has
     already seen those words. */
  it('keeps the partial answer beside the failure', async () => {
    const { reply } = await askAndSettle(failingProvider(new Error('the daemon went away'), ['It begins', ' and then']))
    expect(reply.text).toBe('It begins and then')
    expect(reply.failure).toBe('the daemon went away')
  })

  /* THE READER'S OWN ABORT IS NOT A FAILURE. `cancel` aborts the signal and
     the provider raises whatever it raises; the partial answer stands with no
     failure line under it. */
  it('reports nothing when the reader stopped the answer themselves', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const provider: CompanionProvider = {
      name: 'test',
      configured: true,
      async *ask(_question, _context, signal) {
        yield 'Half an'
        await gate
        signal.throwIfAborted()
        throw { kind: 'cancelled', message: 'cancelled' }
      },
    }
    const hook = renderHook(() => useCompanionThread(provider, () => CONTEXT))
    act(() => hook.result.current.ask('why?'))
    await waitFor(() => expect(hook.result.current.messages[1]?.text).toBe('Half an'))
    act(() => hook.result.current.cancel())
    release()
    await waitFor(() => expect(hook.result.current.messages[1]?.streaming).toBe(false))
    expect(hook.result.current.messages[1]?.failure).toBeNull()
    expect(hook.result.current.messages[1]?.text).toBe('Half an')
  })
})
