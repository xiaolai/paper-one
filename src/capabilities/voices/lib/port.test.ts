// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { StopFailed, voicesPortOver } from './port'
import type { VoicesWire, SpokenRow } from './wire'

const PACK = {
  id: 'english-kokoro',
  name: 'English',
  summary: 'Kokoro 82M, read on this device.',
  family: 'kokoro',
  languages: ['en'],
  bytes: 336_822_660,
  minimumMemoryGb: 4,
  voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', note: '' }],
  installed: true,
}

const SPOKEN: SpokenRow = {
  pcm: [0, 0, 1, 0],
  sampleRate: 24_000,
  words: [{ start: 0, length: 5, startMs: 400, endMs: 825 }],
  skipped: [],
}

/** A wire the case drives. */
function wireOver(over: Partial<VoicesWire> = {}): VoicesWire {
  return {
    catalogue: async () => [PACK],
    install: async () => {},
    stop: async () => {},
    remove: async () => {},
    render: async () => SPOKEN,
    release: async () => {},
    onProgress: async () => () => {},
    ...over,
  }
}

/** The value a rejected promise carries, whatever it is. */
async function refusalOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(() => null, (cause: unknown) => cause)
}

describe('the catalogue', () => {
  it('reads the packs the plugin answers with', async () => {
    const packs = await voicesPortOver(wireOver()).catalogue()
    expect(packs.map((p) => p.id)).toEqual(['english-kokoro'])
  })

  it('leaves out one row it cannot read, and keeps the rest', async () => {
    // A row this version cannot read is a build defect in one entry, not a
    // reason to hide a pack that reads perfectly.
    const packs = await voicesPortOver(wireOver({ catalogue: async () => [{ id: 'broken' }, PACK] })).catalogue()
    expect(packs.map((p) => p.id)).toEqual(['english-kokoro'])
  })

  it('refuses a reply that is not a list, rather than answering none', async () => {
    /* ⚠️ **THE DEFECT THIS EXISTS FOR.** It was `Array.isArray(rows) ? rows : []`
       — present-and-wrong answered as absent, which is the rule this repository
       has already had to fix in eighteen stores. A malformed reply looked
       exactly like a device with no voices, and the pane said so. */
    for (const answer of [null, 'packs', { packs: [PACK] }, 42]) {
      const cause = await refusalOf(voicesPortOver(wireOver({ catalogue: async () => answer as never })).catalogue())
      expect(cause, String(answer)).toBeInstanceOf(Error)
      expect((cause as Error).message).toMatch(/not a list of packs/u)
    }
  })
})

describe('installing a pack', () => {
  it('reports the progress the plugin emits, for this pack only', async () => {
    let emit: ((payload: unknown) => void) | null = null
    const seen: unknown[] = []
    const port = voicesPortOver(
      wireOver({
        onProgress: async (handler) => {
          emit = handler
          return () => {}
        },
        install: async () => {
          emit?.({ pack: 'chinese-qwen', kind: 'downloading', received: 1, total: 2 })
          emit?.({ pack: 'english-kokoro', kind: 'downloading', received: 10, total: 20 })
        },
      }),
    )
    await port.install('english-kokoro', (p) => seen.push(p))
    expect(seen).toEqual([{ kind: 'downloading', received: 10, total: 20 }])
  })

  it('unsubscribes whether the install resolves or rejects', async () => {
    for (const install of [async () => {}, async () => { throw new Error('refused') }]) {
      const off = vi.fn()
      const port = voicesPortOver(wireOver({ onProgress: async () => off, install }))
      await refusalOf(port.install('english-kokoro', () => {}))
      expect(off).toHaveBeenCalledTimes(1)
    }
  })

  it('never starts a download for a signal that has already aborted', async () => {
    /* ⚠️ **A LISTENER IS NOT A CANCELLATION CHECK.** `addEventListener('abort',
       …)` on a signal that has already aborted never runs, so the old shape
       subscribed, called `wire.install`, and fetched gigabytes for a caller
       that had cancelled before it asked. */
    const install = vi.fn(async () => {})
    const port = voicesPortOver(wireOver({ install }))
    const cause = await refusalOf(port.install('english-kokoro', () => {}, AbortSignal.abort()))
    expect(cause).toBeInstanceOf(Error)
    expect(install).not.toHaveBeenCalled()
  })

  it('never starts one for a signal that aborts while it is subscribing', async () => {
    // Subscribing is a round trip to the plugin. A reader who presses Stop
    // during it would otherwise be heard by nobody.
    const install = vi.fn(async () => {})
    const off = vi.fn()
    const control = new AbortController()
    const port = voicesPortOver(
      wireOver({
        install,
        onProgress: async () => {
          control.abort()
          return off
        },
      }),
    )
    const cause = await refusalOf(port.install('english-kokoro', () => {}, control.signal))
    expect(cause).toBeInstanceOf(Error)
    expect(install).not.toHaveBeenCalled()
    expect(off, 'the subscription is released before refusing').toHaveBeenCalledTimes(1)
  })

  it('asks the plugin to stop when the reader aborts', async () => {
    const stop = vi.fn(async () => {})
    const control = new AbortController()
    const port = voicesPortOver(
      wireOver({
        stop,
        install: async () =>
          new Promise((_resolve, reject) => {
            control.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
            control.abort()
          }),
      }),
    )
    await refusalOf(port.install('english-kokoro', () => {}, control.signal))
    expect(stop).toHaveBeenCalledWith('english-kokoro')
  })

  it('reports a stop that FAILED, rather than reporting the download installed', async () => {
    /* ⚠️ It was `void wire.stop(packId)`: the rejection went nowhere, and a
       download the reader had asked to stop ran on to "Installed" with nothing
       anywhere saying the stop had not worked. */
    const control = new AbortController()
    const port = voicesPortOver(
      wireOver({
        stop: async () => {
          throw new Error('the plugin could not stop it')
        },
        install: async () => {
          control.abort()
        },
      }),
    )
    const cause = await refusalOf(port.install('english-kokoro', () => {}, control.signal))
    expect(cause).toBeInstanceOf(StopFailed)
    expect((cause as Error).message).toMatch(/could not stop it/u)
    /* A TYPE and not a sentence: the pane says "Download stopped. Nothing was
       left half-installed." for every aborted install, and this is the one case
       where that is false. Matching on the message would hold until somebody
       edited it. */
    expect((cause as Error).message).toMatch(/could not be stopped/u)
  })
})

describe('a rendered passage', () => {
  it('reads the samples, the rate and the timings', async () => {
    const audio = await voicesPortOver(wireOver()).render({ packId: 'english-kokoro', voiceId: 'af_heart', text: 'Ideas' })
    expect([...audio.pcm]).toEqual([0, 0, 1, 0])
    expect(audio.sampleRate).toBe(24_000)
    expect(audio.words[0]?.endMs).toBe(825)
  })

  it('refuses samples that are not bytes, rather than wrapping them round', async () => {
    /* ⚠️ `Uint8Array.from([256, -1, 1.5])` is `[0, 255, 1]` and never fails —
       three wrong samples, silently, which is a click in the middle of a
       sentence with nothing saying a byte was wrong. */
    const port = voicesPortOver(wireOver({ render: async () => ({ ...SPOKEN, pcm: [256, -1, 1.5, 0] }) as never }))
    const cause = await refusalOf(port.render({ packId: 'p', voiceId: 'v', text: 't' }))
    expect((cause as Error).message).toMatch(/not bytes/u)
  })

  it('refuses half a sample', async () => {
    // Two bytes to a frame — the same refusal `narrate/wav.rs` makes.
    const port = voicesPortOver(wireOver({ render: async () => ({ ...SPOKEN, pcm: [0, 0, 1] }) }))
    expect(((await refusalOf(port.render({ packId: 'p', voiceId: 'v', text: 't' }))) as Error).message).toMatch(/half a sample/u)
  })

  it('refuses a rate that would divide to infinity', async () => {
    for (const sampleRate of [0, -1, 24_000.5, Number.NaN]) {
      const port = voicesPortOver(wireOver({ render: async () => ({ ...SPOKEN, sampleRate }) }))
      const cause = await refusalOf(port.render({ packId: 'p', voiceId: 'v', text: 't' }))
      expect((cause as Error).message, String(sampleRate)).toMatch(/no sample rate/u)
    }
  })

  it('refuses timings and a skip list that are not what they claim', async () => {
    const bad = [
      [{ ...SPOKEN, words: [{ start: 0 }] }, /not timings/u],
      [{ ...SPOKEN, words: 'none' }, /not timings/u],
      [{ ...SPOKEN, skipped: [{ text: 'Manhattoes' }] }, /skip list/u],
      [{ ...SPOKEN, skipped: null }, /skip list/u],
    ] as const
    for (const [row, message] of bad) {
      const port = voicesPortOver(wireOver({ render: async () => row as never }))
      const cause = await refusalOf(port.render({ packId: 'p', voiceId: 'v', text: 't' }))
      expect((cause as Error).message, JSON.stringify(row)).toMatch(message)
    }
  })

  it('refuses a reply that is no passage at all', async () => {
    const port = voicesPortOver(wireOver({ render: async () => null as never }))
    expect(((await refusalOf(port.render({ packId: 'p', voiceId: 'v', text: 't' }))) as Error).message).toMatch(/no passage/u)
  })
})

describe('the rest of the port', () => {
  it('passes a removal and a release straight through', async () => {
    const remove = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const port = voicesPortOver(wireOver({ remove, release }))
    await port.remove('english-kokoro')
    await port.release()
    expect(remove).toHaveBeenCalledWith('english-kokoro')
    expect(release).toHaveBeenCalledTimes(1)
  })
})
