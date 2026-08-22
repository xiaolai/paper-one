import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '../lib/controller'
import { downloadLine, formatBytes, lookUpValue, modelAction, modelValue, runtimeValue } from './modelsModel'

const MODELS = [
  { id: 'qwen', label: 'Qwen3-4B', bytes: 2_497_281_120, installed: false },
  { id: 'kokoro', label: 'Kokoro', bytes: 353_746_785, installed: false },
]

describe('formatBytes', () => {
  /* Decimal, not binary, and the reason is the reader rather than the
   * arithmetic: this is compared against a download they were quoted in the
   * same units, and 2.5 GB shown as 2.3 GiB reads as a different file. */
  it('reads in the units the reader was quoted', () => {
    expect(formatBytes(2_497_281_120)).toBe('2.5 GB')
    expect(formatBytes(353_746_785)).toBe('354 MB')
    expect(formatBytes(4_096)).toBe('4 KB')
    expect(formatBytes(512)).toBe('512 B')
  })

  /* `—`, NEVER `0`. Lemonade is specifically credited for returning null
   * rather than zero for memory it cannot read, and a `0` beside "Memory" is
   * a claim that nothing is resident — a different statement from "unknown". */
  it('says `—` for an unknown figure and never zero', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(null)).not.toBe('0 B')
    /* And a genuine zero is still a zero, which is not the same thing. */
    expect(formatBytes(0)).toBe('0 B')
  })
})

describe('runtimeValue', () => {
  it('says what each state is, in the reader’s words', () => {
    expect(runtimeValue({ kind: 'absent', reason: 'x' })).toBe('Not installed')
    expect(runtimeValue({ kind: 'installed' })).toBe('Ready to start')
    expect(runtimeValue({ kind: 'starting' })).toBe('Starting…')
    expect(runtimeValue({ kind: 'verifying', model: 'qwen' })).toBe('Verifying…')
    expect(runtimeValue({ kind: 'ready', version: '11.7.0' })).toBe('Running · 11.7.0')
  })

  /* F3: the vocabulary has no progress bar, so a download reports as a fact in
   * the same right-hand `value` slot every other fact goes in. */
  it('reports a download as two counts and no bar', () => {
    const state: RuntimeState = { kind: 'installing', model: 'qwen', received: 412_000_000, total: 2_497_281_120 }
    expect(runtimeValue(state)).toBe('Downloading · 412 MB of 2.5 GB')
  })

  it('does not quote a total it does not have yet', () => {
    expect(runtimeValue({ kind: 'installing', model: 'qwen', received: 0, total: 0 })).toBe('Downloading…')
  })

  /* `degraded` says what went wrong rather than showing a code — and it is
   * NOT `absent`: one means download it, the other means restart it. */
  it('says what went wrong when degraded', () => {
    expect(runtimeValue({ kind: 'degraded', detail: 'The runtime stopped' })).toBe('The runtime stopped')
  })

  it('says `Running` for a daemon that would not name its version', () => {
    expect(runtimeValue({ kind: 'ready', version: '' })).toBe('Running')
  })
})

describe('modelValue', () => {
  it('quotes the download cost before the reader commits to it', () => {
    expect(modelValue(MODELS[0]!, { kind: 'installed' })).toBe('2.5 GB')
  })

  it('says installed, with what it cost', () => {
    expect(modelValue({ ...MODELS[0]!, installed: true }, { kind: 'installed' })).toBe('Installed · 2.5 GB')
  })

  /* The progress belongs to the row being downloaded and to no other. */
  it('shows progress on the row that is downloading', () => {
    const state: RuntimeState = { kind: 'installing', model: 'qwen', received: 1_000_000, total: 2_000_000 }
    expect(modelValue(MODELS[0]!, state)).toBe('Downloading · 1 MB of 2 MB')
    expect(modelValue(MODELS[1]!, state)).toBe('354 MB')
  })
})

describe('modelAction', () => {
  /* One button whose label is the action available now, rather than three
   * controls two of which are always disabled. */
  it('offers Install, then Remove, then Cancel', () => {
    expect(modelAction({ id: 'qwen', installed: false }, { kind: 'installed' })).toBe('install')
    expect(modelAction({ id: 'qwen', installed: true }, { kind: 'installed' })).toBe('remove')
    expect(
      modelAction({ id: 'qwen', installed: false }, { kind: 'installing', model: 'qwen', received: 0, total: 1 }),
    ).toBe('cancel')
  })

  it('offers Cancel while verifying, too — it has not finished', () => {
    expect(modelAction({ id: 'qwen', installed: false }, { kind: 'verifying', model: 'qwen' })).toBe('cancel')
  })

  it('does not offer Cancel on a row that is not the one downloading', () => {
    expect(
      modelAction({ id: 'kokoro', installed: false }, { kind: 'installing', model: 'qwen', received: 0, total: 1 }),
    ).toBe('install')
  })
})

describe('downloadLine', () => {
  /* ── WI-15.12's NEGATIVE HALF, WHICH IS THE LOAD-BEARING HALF ─────────
   * "with no download running the status bar is byte-for-byte what it is
   * today". Nothing is added at rest — and in particular there is no
   * standing "AI is ready", because readiness is not work. */
  it('is null at rest, in every state that is not a download', () => {
    const atRest: RuntimeState[] = [
      { kind: 'absent', reason: 'x' },
      { kind: 'installed' },
      { kind: 'starting' },
      { kind: 'ready', version: '11.7.0' },
      { kind: 'degraded', detail: 'The runtime stopped' },
    ]
    for (const state of atRest) expect(downloadLine(state, MODELS)).toBeNull()
  })

  it('never says the companion is ready', () => {
    const line = downloadLine({ kind: 'ready', version: '11.7.0' }, MODELS)
    expect(line).toBeNull()
  })

  it('names the model and both counts while downloading', () => {
    const state: RuntimeState = { kind: 'installing', model: 'qwen', received: 412_000_000, total: 2_497_281_120 }
    expect(downloadLine(state, MODELS)).toBe('Downloading Qwen3-4B — 412 MB of 2.5 GB')
  })

  it('says it is verifying, so a count that stopped moving does not read as a stall', () => {
    expect(downloadLine({ kind: 'verifying', model: 'kokoro' }, MODELS)).toBe('Verifying Kokoro')
  })

  it('falls back to the id when the catalogue has not loaded yet', () => {
    const state: RuntimeState = { kind: 'installing', model: 'unknown-id', received: 0, total: 0 }
    expect(downloadLine(state, [])).toBe('Downloading unknown-id')
  })
})

describe('lookUpValue', () => {
  it('is null where there is no control to draw', () => {
    expect(lookUpValue('system', false, false)).toBeNull()
  })

  it('names the mode in the reader’s words', () => {
    expect(lookUpValue('system', true, false)).toBe('System dictionary')
    expect(lookUpValue('gloss', false, true)).toBe('Gloss')
    expect(lookUpValue('both', true, true)).toBe('Both')
  })

  it('shows what is actually in use when the stored choice is unavailable', () => {
    expect(lookUpValue('both', true, false)).toBe('System dictionary')
  })
})
