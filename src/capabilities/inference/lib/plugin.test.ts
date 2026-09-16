import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * WHAT `plugin.ts` DOES, measured at the Tauri boundary and nowhere above it.
 *
 * `plugin.contract.test.ts` holds the command NAMES to the crate's three Rust
 * surfaces by reading the files. That is a different question from what the
 * functions do when called — the exact string handed to `invoke`, the channel
 * a streaming command is given, how a rejection is read — and a test that reads
 * text cannot be scored against a mutated module. This one stands in for
 * `@tauri-apps/api/core` only, and runs everything in `plugin.ts` for real.
 */

/* The fake is held here rather than imported back from `@tauri-apps/api/core`:
   `no-tauri-api-outside-peer-wire` refuses that import from any file under
   src/capabilities/ but the wires themselves, tests included. */
const tauri = vi.hoisted(() => {
  /* No default `onmessage`: a channel nobody wired must stay unwired, or a
     command that streams to nothing would look like one that streams. */
  class Channel<T> {
    onmessage?: (value: T) => void
  }
  return { Channel, invoke: vi.fn((..._args: unknown[]) => Promise.resolve('answered')) }
})
vi.mock('@tauri-apps/api/core', () => tauri)

const { Channel, invoke } = tauri
type Channel<T> = InstanceType<typeof tauri.Channel<T>>

import { cancelRequest, errorKind, inferencePlugin, isCancelled, reasonOf, type Route } from './plugin'

afterEach(() => {
  vi.mocked(invoke).mockClear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Every call `invoke` received, in order, argument lists whole. */
const calls = (): unknown[][] => vi.mocked(invoke).mock.calls

describe('the commands, as invoke receives them', () => {
  it('sends each argument-free command under its full plugin name and nothing else', async () => {
    const table: [() => Promise<unknown>, string][] = [
      [inferencePlugin.status, 'plugin:inference|inference_status'],
      [inferencePlugin.start, 'plugin:inference|inference_start'],
      [inferencePlugin.stop, 'plugin:inference|inference_stop'],
      [inferencePlugin.models, 'plugin:inference|inference_models'],
      [inferencePlugin.resourceUsage, 'plugin:inference|inference_resource_usage'],
      [inferencePlugin.revealModelsDir, 'plugin:inference|inference_reveal_models_dir'],
      [inferencePlugin.probe, 'plugin:inference|inference_probe'],
      [inferencePlugin.endpoints, 'plugin:inference|inference_endpoints'],
    ]
    for (const [call, name] of table) {
      vi.mocked(invoke).mockClear()
      await expect(call()).resolves.toBe('answered')
      expect(calls(), name).toEqual([[name]])
    }
  })

  it('sends each command that takes arguments with exactly those arguments', async () => {
    const table: [() => Promise<unknown>, unknown[]][] = [
      [() => inferencePlugin.removeModel('qwen'), ['plugin:inference|inference_remove_model', { model: 'qwen' }]],
      [
        () => inferencePlugin.gloss('gloss-1', 'qwen', 'be brief', 'what is a gam?'),
        ['plugin:inference|inference_gloss', { requestId: 'gloss-1', model: 'qwen', system: 'be brief', question: 'what is a gam?' }],
      ],
      [
        () => inferencePlugin.speak('voice-1', 'kokoro', 'Call me Ishmael.', null),
        ['plugin:inference|inference_speak', { requestId: 'voice-1', model: 'kokoro', text: 'Call me Ishmael.', voice: null }],
      ],
      [
        () => inferencePlugin.addEndpoint('work', 'Work', 'https://llm.example.invalid/v1'),
        ['plugin:inference|inference_add_endpoint', { id: 'work', label: 'Work', baseUrl: 'https://llm.example.invalid/v1' }],
      ],
      [() => inferencePlugin.removeEndpoint('work'), ['plugin:inference|inference_remove_endpoint', { id: 'work' }]],
      [
        () => inferencePlugin.setEndpointKey('work', 'sk-test'),
        ['plugin:inference|inference_set_endpoint_key', { id: 'work', key: 'sk-test' }],
      ],
      [() => inferencePlugin.agentSignIn('claude'), ['plugin:inference|agent_sign_in', { route: 'claude' }]],
      [() => inferencePlugin.cancel('ask-3'), ['plugin:inference|inference_cancel', { requestId: 'ask-3' }]],
    ]
    for (const [call, expected] of table) {
      vi.mocked(invoke).mockClear()
      await expect(call()).resolves.toBe('answered')
      expect(calls(), String(expected[0])).toEqual([expected])
    }
  })

  /* A channel with no `onmessage` is a command that runs to completion having
     delivered nothing — so each streaming command's channel is fired here, not
     merely found. */
  it('hands each streaming command a channel that delivers to its callback', async () => {
    const onProgress = vi.fn()
    await inferencePlugin.installModel('install-1', 'qwen', onProgress)
    const onChunk = vi.fn()
    await inferencePlugin.generate('ask-1', 'qwen', 'be brief', 'who is speaking?', onChunk)
    const onAgentChunk = vi.fn()
    await inferencePlugin.agentAsk('ask-2', 'claude', 'who is speaking?', 'thorough', onAgentChunk)

    expect(calls()).toEqual([
      ['plugin:inference|inference_install_model', { requestId: 'install-1', model: 'qwen', progress: expect.any(Channel) }],
      [
        'plugin:inference|inference_generate',
        { requestId: 'ask-1', model: 'qwen', system: 'be brief', question: 'who is speaking?', chunks: expect.any(Channel) },
      ],
      [
        'plugin:inference|agent_ask',
        { requestId: 'ask-2', route: 'claude', prompt: 'who is speaking?', depth: 'thorough', chunks: expect.any(Channel) },
      ],
    ])
    const [install, generate, agent] = calls().map((call) => call[1] as Record<string, Channel<unknown>>)
    install!.progress!.onmessage!({ kind: 'verifying' })
    generate!.chunks!.onmessage!('Ishmael')
    agent!.chunks!.onmessage!('the narrator')
    expect(onProgress.mock.calls).toEqual([[{ kind: 'verifying' }]])
    expect(onChunk.mock.calls).toEqual([['Ishmael']])
    expect(onAgentChunk.mock.calls).toEqual([['the narrator']])
  })
})

describe('reading a rejection', () => {
  it('reads the kind the plugin rejected with', () => {
    expect(errorKind({ kind: 'runtimeExited', message: 'gone' })).toBe('runtimeExited')
  })

  /* `null` rather than a guess: a rejection with no string `kind` is a Tauri or
     webview failure, and reading it as the plugin's own would put the wrong
     sentence in front of the reader. */
  it('answers null for anything that is not an object carrying a string kind — and never throws reading it', () => {
    expect(errorKind(null)).toBeNull()
    expect(errorKind(undefined)).toBeNull()
    expect(errorKind('cancelled')).toBeNull()
    expect(errorKind(new Error('Command inference_status not found'))).toBeNull()
    expect(errorKind({ kind: 42, message: 'a number is not a kind' })).toBeNull()
    /* A function is not a rejection from the plugin, whatever it carries. */
    expect(errorKind(Object.assign(() => undefined, { kind: 'cancelled' }))).toBeNull()
  })

  it('calls a rejection cancelled only when its kind says so', () => {
    expect(isCancelled({ kind: 'cancelled', message: 'the reader stopped it' })).toBe(true)
    expect(isCancelled({ kind: 'runtimeExited', message: 'gone' })).toBe(false)
    expect(isCancelled({ kind: '', message: 'an empty kind' })).toBe(false)
    expect(isCancelled(new Error('cancelled'))).toBe(false)
  })
})

describe('the reason a route cannot answer', () => {
  const route = (reason: unknown): Route =>
    ({ id: 'qwen', kind: 'local', label: 'Qwen', detail: null, unusable: 'Not installed', reason, installed: false, modality: 'text' }) as Route

  it('reads a unit code, which serde writes as a bare string', () => {
    expect(reasonOf(route('notInstalled'))).toBe('notInstalled')
  })

  it('reads a code with a payload, which serde writes as a one-key object', () => {
    expect(reasonOf(route({ versionUnsupported: { found: '1.0' } }))).toBe('versionUnsupported')
  })

  it('answers null for a usable route, a code this build does not know, and an object naming none', () => {
    expect(reasonOf(route(undefined))).toBeNull()
    expect(reasonOf(route('somethingNewer'))).toBeNull()
    expect(reasonOf(route({ somethingNewer: {} }))).toBeNull()
    expect(reasonOf(route({}))).toBeNull()
  })
})

describe('cancelling a request', () => {
  /** Lets the rejection handler run — it is on a promise nothing awaits. */
  const settled = () => new Promise((done) => setTimeout(done, 0))

  it('asks the plugin to cancel exactly that request', async () => {
    const cancel = vi.fn(() => Promise.resolve())
    cancelRequest({ cancel }, 'ask-7', vi.fn())
    await settled()
    expect(cancel.mock.calls).toEqual([['ask-7']])
  })

  it('says nothing when the cancel lost the ordinary race', async () => {
    const report = vi.fn()
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    cancelRequest({ cancel: () => Promise.reject({ kind: 'requestUnknown', message: 'already done' }) }, 'gloss-1', report)
    await settled()
    expect(report).not.toHaveBeenCalled()
    expect(said).not.toHaveBeenCalled()
  })

  it('reports any other failure under its own event, with the request, the kind and the message', async () => {
    const report = vi.fn()
    cancelRequest({ cancel: () => Promise.reject({ kind: 'runtimeExited', message: 'the daemon went away' }) }, 'ask-7', report)
    await settled()
    expect(report.mock.calls).toEqual([
      ['inference.cancel-failed', { requestId: 'ask-7', kind: 'runtimeExited', message: 'the daemon went away' }],
    ])
  })

  /* It runs from an `abort` listener, where nobody is left to catch — and a
     host that bound no reporter has asked for silence, not for a complaint
     that the reporter is missing. */
  it('stays silent with no reporter bound', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => cancelRequest({ cancel: () => Promise.reject(new Error('boom')) }, 'x-1')).not.toThrow()
    await settled()
    expect(said).not.toHaveBeenCalled()
  })

  it('says so on the console when the reporter itself throws, naming what it was doing', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = new Error('the reporter is broken')
    cancelRequest({ cancel: () => Promise.reject({ kind: 'runtimeExited', message: 'gone' }) }, 'ask-9', () => {
      throw broken
    })
    await settled()
    expect(said.mock.calls).toEqual([
      ['inference: the failure reporter itself threw', broken, 'while reporting a failed cancel'],
    ])
  })
})

/**
 * THE SESSION PART IS MINTED ONCE PER LOAD, so each case here loads the module
 * afresh under the platform it describes rather than reading the copy every
 * other test shares.
 */
describe('request ids', () => {
  const load = async () => {
    vi.resetModules()
    return import('./plugin')
  }

  it('numbers ids in order under one session taken from the platform UUID', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '0123abcd-4567-89ef-0123-456789abcdef' })
    const { mintRequestId } = await load()
    expect(mintRequestId('ask')).toBe('ask-0123abcd4567-1')
    expect(mintRequestId('gloss')).toBe('gloss-0123abcd4567-2')
  })

  it('falls back to the clock and a random with no crypto at all', async () => {
    vi.stubGlobal('crypto', undefined)
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { mintRequestId } = await load()
    expect(mintRequestId('ask')).toBe('ask-loyw3v28i-1')
  })

  it('falls back the same way when crypto has no randomUUID', async () => {
    vi.stubGlobal('crypto', {})
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { mintRequestId } = await load()
    expect(mintRequestId('voice')).toBe('voice-loyw3v28i-1')
  })

  /* A random of exactly 0 gives `'0'`, whose digits after the point are EMPTY. */
  it('keeps a character in the random part when the random is exactly zero', async () => {
    vi.stubGlobal('crypto', undefined)
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { mintRequestId } = await load()
    expect(mintRequestId('ask')).toBe('ask-loyw3v280-1')
  })
})
