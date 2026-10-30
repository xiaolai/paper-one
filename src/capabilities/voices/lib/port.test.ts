// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { StopFailed, voicesPortOver } from './port'
import type { VoicesWire } from './wire'
import type { SpeechRequest } from '../../../kernel'

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

/** What the plugin answers for a clip, before anything has read it. */
const CLIP = {
  stem: 'book_a-3-0123456789abcdef',
  path: '/data/audio/clips/book_a-3-0123456789abcdef.wav',
  bytes: 48,
  sampleRate: 24_000,
  durationMs: 2,
  words: [{ start: 0, length: 5, startMs: 400, endMs: 825 }],
  skipped: [],
  evicted: { clips: 0, bytes: 0 },
}

/** The one WAV shape `wav.rs` writes: a header, then `bytes` of samples. */
function wavOf(samples: readonly number[], rate = 24_000): Uint8Array {
  const out = new Uint8Array(44 + samples.length)
  const view = new DataView(out.buffer)
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < 4; i += 1) out[at + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length, true)
  out.set(samples, 44)
  return out
}

/** A request for a section, which is what every render is now. */
function requestFor(over: Partial<SpeechRequest> = {}): SpeechRequest {
  return {
    packId: 'english-kokoro',
    voiceId: 'af_heart',
    text: 'Ideas',
    clip: { bookId: 'book:a', section: 3, textDigest: 'fnv1a64:5:0000000000000001' },
    ...over,
  }
}

/** A wire the case drives. */
function wireOver(over: Partial<VoicesWire> = {}): VoicesWire {
  return {
    catalogue: async () => [PACK],
    install: async () => {},
    stop: async () => {},
    remove: async () => {},
    clipFind: async () => null,
    clipRender: async () => CLIP,
    clipHold: async (stems: readonly string[]) => stems.length,
    clipUsage: async () => ({ bytes: 0, budget: 5 * 1024 * 1024 * 1024, clips: 0 }),
    clipForget: async () => ({ clips: 0, bytes: 0 }),
    readClip: async () => wavOf([0, 0, 1, 0]),
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

  it('lets the install’s own refusal through, when no stop was ever asked for', async () => {
    /* The refusal is HELD rather than rethrown, so the stop can be asked about
       on both roads out — and a hold with nothing that re-throws it is an
       install that fails and reports success. */
    const port = voicesPortOver(
      wireOver({
        install: async () => {
          throw new Error("the file's digest does not match the catalogue")
        },
      }),
    )
    const cause = await refusalOf(port.install('english-kokoro', () => {}))
    expect(cause).toBeInstanceOf(Error)
    expect(cause).not.toBeInstanceOf(StopFailed)
    expect((cause as Error).message).toMatch(/digest does not match/u)
  })

  it('does not report a stop that WORKED as one that failed', async () => {
    /* The other half of the case above it. A stop that the plugin honoured
       leaves the install aborted and nothing else to say — reporting it as a
       failed stop would put "the download could not be stopped" in front of
       every reader who pressed Stop and was obeyed. */
    const control = new AbortController()
    const stop = vi.fn(async () => {})
    const port = voicesPortOver(
      wireOver({
        stop,
        install: async () =>
          new Promise((_resolve, reject) => {
            control.signal.addEventListener('abort', () => reject(new Error('the fetch was interrupted')), { once: true })
            control.abort()
          }),
      }),
    )
    const cause = await refusalOf(port.install('english-kokoro', () => {}, control.signal))
    expect(stop).toHaveBeenCalledWith('english-kokoro')
    expect(cause).not.toBeInstanceOf(StopFailed)
    expect((cause as Error).message).toMatch(/fetch was interrupted/u)
  })

  it('stops listening to the signal once the install is over', async () => {
    /* A listener left on the signal turns a reader's later Stop — on the NEXT
       download, or on a pane being closed — into a `voices_stop` for a pack
       that finished minutes ago. */
    const control = new AbortController()
    const stop = vi.fn(async () => {})
    const port = voicesPortOver(wireOver({ stop }))
    await port.install('english-kokoro', () => {}, control.signal)
    control.abort()
    await Promise.resolve()
    expect(stop).not.toHaveBeenCalled()
  })

  it('reports a failed stop even when the install refuses too', async () => {
    /* ⚠️ **THE COMPOUND CASE, AND IT WAS SILENT.** The stop was only asked
       about when the install RESOLVED, so a stop that failed beside an install
       that also failed went unlooked-at and the reader was told the download
       had stopped cleanly. The stop is awaited on both roads now, and outranks
       the install's own error because it is the more actionable news. */
    const control = new AbortController()
    const port = voicesPortOver(
      wireOver({
        stop: async () => {
          throw new Error('the plugin could not stop it')
        },
        install: async () =>
          new Promise((_resolve, reject) => {
            control.signal.addEventListener('abort', () => reject(new Error('the fetch was interrupted')), { once: true })
            control.abort()
          }),
      }),
    )
    const cause = await refusalOf(port.install('english-kokoro', () => {}, control.signal))
    expect(cause).toBeInstanceOf(StopFailed)
    expect((cause as Error).message).toMatch(/could not stop it/u)
  })
})

describe('a rendered section', () => {
  it('reads the samples out of the file, and the timings out of the row', async () => {
    const audio = await voicesPortOver(wireOver()).render(requestFor())
    expect([...audio.pcm]).toEqual([0, 0, 1, 0])
    expect(audio.sampleRate).toBe(24_000)
    expect(audio.words[0]?.endMs).toBe(825)
    expect(audio.clipPath).toBe(CLIP.path)
    expect(audio.evicted).toEqual({ clips: 0, bytes: 0 })
  })

  it('asks for the clip before rendering one, which is the whole of the phase', async () => {
    /* ⚠️ A SECTION THE READER HAS HEARD BEFORE MUST NOT BE RENDERED AGAIN. WI-34.0
       measured a real one at 315 s; asking first is what turns that into nothing. */
    const clipFind = vi.fn(async () => CLIP)
    const clipRender = vi.fn(async () => CLIP)
    const port = voicesPortOver(wireOver({ clipFind, clipRender }))
    await port.render(requestFor())
    expect(clipFind).toHaveBeenCalledTimes(1)
    expect(clipRender, 'a hit renders nothing').not.toHaveBeenCalled()
  })

  it('renders when there is no clip, and reads the one it made', async () => {
    const clipRender = vi.fn(async () => CLIP)
    const readClip = vi.fn(async () => wavOf([0, 0, 1, 0]))
    const port = voicesPortOver(wireOver({ clipFind: async () => null, clipRender, readClip }))
    await port.render(requestFor())
    expect(clipRender).toHaveBeenCalledTimes(1)
    expect(readClip, 'read by the NAME the plugin answered').toHaveBeenCalledWith(CLIP.stem)
  })

  it('treats an absent answer as a miss, as well as a null one', async () => {
    /* Tauri answers `null` for a Rust `Option::None`; a fake or a future version
       could answer `undefined`. Both are "there is no clip", and reading either as
       a CLIP would hand `clipOf` nothing and refuse the reading. */
    const clipRender = vi.fn(async () => CLIP)
    const port = voicesPortOver(wireOver({ clipFind: async () => undefined, clipRender }))
    await port.render(requestFor())
    expect(clipRender).toHaveBeenCalledTimes(1)
  })

  it('sends the key the request carries, and computes the spoken digest itself', async () => {
    /* ⚠️ THE SPOKEN DIGEST IS THE PORT'S, AND THE TEXT DIGEST IS THE CALLER'S. A
       caller that supplied its own spoken digest could hand over a digest of a
       string it did not send, and the failure would be a whole chapter of
       misplaced word highlights with nothing throwing. */
    const clipFind = vi.fn(async () => CLIP)
    const port = voicesPortOver(wireOver({ clipFind }))
    await port.render(requestFor({ text: 'foobar', rate: 1.25 }))
    expect(clipFind).toHaveBeenCalledWith({
      book: 'book:a',
      section: 3,
      pack: 'english-kokoro',
      voice: 'af_heart',
      rate: 1.25,
      textDigest: 'fnv1a64:5:0000000000000001',
      spokenDigest: 'fnv1a64:6:85944171f73967e8',
    })
  })

  it('asks for no rate where the reader has chosen none', async () => {
    /* `?? null` and `&& null` differ on exactly this: a chosen rate arriving as
       `null` is read by the plugin as the pack's own default — a reading at a
       speed nobody asked for, with nothing anywhere saying so. And a rate is in
       the clip's KEY, so getting it wrong is a second clip as well. */
    const asked: { rate?: number | null } = {}
    const port = voicesPortOver(
      wireOver({
        clipFind: async (query) => {
          asked.rate = query.rate
          return CLIP
        },
      }),
    )
    await port.render(requestFor())
    expect(asked.rate).toBeNull()
  })

  it('refuses a row that is not a section', async () => {
    const port = voicesPortOver(wireOver({ clipRender: async () => 7 as never }))
    const cause = await refusalOf(port.render(requestFor()))
    expect((cause as Error).message).toMatch(/no section/u)
  })

  it('refuses a rate the file does not agree with', async () => {
    /* A clip played at the wrong rate is a voice at the wrong pitch all the way
       through, with nothing failing. The row and the file are two statements of
       one fact, so they are made to agree. */
    const port = voicesPortOver(wireOver({ readClip: async () => wavOf([0, 0], 22_050) }))
    const cause = await refusalOf(port.render(requestFor()))
    expect((cause as Error).message).toMatch(/says 22050 Hz where the section says 24000 Hz/u)
  })

  it('refuses a file that is not the shape Paper writes', async () => {
    const port = voicesPortOver(wireOver({ readClip: async () => new Uint8Array(44) }))
    const cause = await refusalOf(port.render(requestFor()))
    expect((cause as Error).message).toMatch(/says 0 bytes of audio and holds 0|not the WAV shape/u)
  })

  it('carries what an eviction took away, so the reader can be told', async () => {
    const port = voicesPortOver(
      wireOver({ clipRender: async () => ({ ...CLIP, evicted: { clips: 2, bytes: 96_088 } }) }),
    )
    const audio = await port.render(requestFor())
    expect(audio.evicted).toEqual({ clips: 2, bytes: 96_088 })
  })
})

describe('holding a rendered section open while something reads it', () => {
  /* ⚠️ **NO TEST REACHED THIS AT ALL — FOUND BY THE MUTATION SWEEP, which reported
     ten `NoCoverage` mutants in one method.** The export's lease runs through it,
     and every defect in it type-checks perfectly and arrives at the plugin as a
     refusal the reader is told nothing about — the same shape `voices/lib/wire.ts`
     was in when it had 21 mutants and no test file. */
  it('passes the names and the direction through, and answers the count', async () => {
    const asked: [readonly string[], boolean][] = []
    const port = voicesPortOver(
      wireOver({
        clipHold: async (stems: readonly string[], hold: boolean) => {
          asked.push([stems, hold])
          return stems.length
        },
      }),
    )
    await expect(port.holdClips(['a-0-x', 'b-1-y'], true)).resolves.toBe(2)
    await expect(port.holdClips(['a-0-x'], false)).resolves.toBe(1)
    expect(asked).toEqual([
      [['a-0-x', 'b-1-y'], true],
      [['a-0-x'], false],
    ])
  })

  it('answers zero, because zero is the store saying the clip has gone', async () => {
    /* ⚠️ **NOT A REFUSAL, WHICH IS THE WHOLE VALUE OF THE NUMBER.** The audiobook
       export reads 0 as *that clip is not here any more* and renders the chapter
       instead; a port that threw on it would turn the race this closes into a
       failed export. */
    const port = voicesPortOver(wireOver({ clipHold: async () => 0 }))
    await expect(port.holdClips(['a-0-x'], true)).resolves.toBe(0)
  })

  it('refuses a count that is not one', async () => {
    /* A count is what the caller branches on, so a non-number arriving as one is
       the defect that would make `=== 1` silently false for ever. */
    const named = /answered with a count that is not one/u
    for (const answered of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined, {}]) {
      const port = voicesPortOver(wireOver({ clipHold: async () => answered as number }))
      await expect(port.holdClips(['a-0-x'], true), String(answered)).rejects.toThrow(named)
    }
    /* Zero and one are both counts, and the bound is on the SIGN rather than on
       being non-empty — a release of nothing is an ordinary answer. */
    for (const answered of [0, 1, 99]) {
      const port = voicesPortOver(wireOver({ clipHold: async () => answered }))
      await expect(port.holdClips(['a-0-x'], true)).resolves.toBe(answered)
    }
  })

  it('lets the wire’s own refusal through rather than dressing it as a count', async () => {
    const port = voicesPortOver(
      wireOver({
        clipHold: async () => {
          throw new Error('the store would not answer')
        },
      }),
    )
    await expect(port.holdClips(['a-0-x'], true)).rejects.toThrow(/would not answer/u)
  })
})

describe('asking whether a section is rendered, without rendering it', () => {
  it('answers a clip without reading its samples', async () => {
    /* The audiobook export names the file to the packer and never needs its bytes
       in the webview — a ten-hour book is gigabytes. */
    const readClip = vi.fn(async () => wavOf([0, 0]))
    const port = voicesPortOver(wireOver({ clipFind: async () => CLIP, readClip }))
    const found = await port.findClip(requestFor())
    expect(found).toEqual({
      stem: CLIP.stem,
      path: CLIP.path,
      bytes: CLIP.bytes,
      sampleRate: CLIP.sampleRate,
      durationMs: CLIP.durationMs,
      words: CLIP.words,
      /* ⚠️ **THE SKIPS TRAVEL WITH THE CLIP**, and were dropped here until an
         independent audit found it: an export reusing this clip would otherwise
         report a book whole that the reading had said was not. */
      skipped: CLIP.skipped,
    })
    expect(readClip, 'the samples are not read').not.toHaveBeenCalled()
  })

  it('answers null for a miss, and renders nothing', async () => {
    const clipRender = vi.fn(async () => CLIP)
    const port = voicesPortOver(wireOver({ clipFind: async () => null, clipRender }))
    await expect(port.findClip(requestFor())).resolves.toBeNull()
    expect(clipRender, 'asking by rendering is not asking').not.toHaveBeenCalled()
  })

  it('answers null for an absent answer as well as a null one', async () => {
    const port = voicesPortOver(wireOver({ clipFind: async () => undefined }))
    await expect(port.findClip(requestFor())).resolves.toBeNull()
  })

  it('refuses a row that is not a section rather than reporting a miss', async () => {
    /* A miss is *render it*; a malformed row is a plugin answering something this
       build cannot read, and reading it as a miss would render a section that is
       already there, every time, for ever. */
    const port = voicesPortOver(wireOver({ clipFind: async () => ({ stem: '' }) as never }))
    expect(((await refusalOf(port.findClip(requestFor()))) as Error).message).toMatch(
      /no name for the audio/u,
    )
  })
})

describe('the disk the rendered reading holds', () => {
  it('reads the usage row', async () => {
    const port = voicesPortOver(
      wireOver({ clipUsage: async () => ({ bytes: 1_000, budget: 2_000, clips: 3 }) }),
    )
    await expect(port.clipUsage()).resolves.toEqual({ bytes: 1_000, budget: 2_000, clips: 3 })
  })

  it('refuses a usage row that is not counts', async () => {
    const port = voicesPortOver(wireOver({ clipUsage: async () => ({ bytes: -1 }) as never }))
    expect(((await refusalOf(port.clipUsage())) as Error).message).toMatch(/not counts/u)
  })

  it('forgets one book, or all of them, and says what went', async () => {
    const clipForget = vi.fn(async () => ({ clips: 2, bytes: 96_088 }))
    const port = voicesPortOver(wireOver({ clipForget }))
    await expect(port.forgetClips('book:a')).resolves.toEqual({ clips: 2, bytes: 96_088 })
    expect(clipForget).toHaveBeenLastCalledWith('book:a')
    /* ⚠️ AN ABSENT BOOK CROSSES AS `null` AND NOT AS `undefined`. The plugin reads
       `null` as *forget all of it*; an absent argument would read the same way by
       accident, and an accident is not a decision. */
    await port.forgetClips()
    expect(clipForget).toHaveBeenLastCalledWith(null)
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

describe('a refusal whose value is null', () => {
  /* ⚠️ **`null` MEANT BOTH "IT WORKED" AND A REJECTION VALUE — FOUND BY AN
     INDEPENDENT AUDIT, 2026-09-30.** `Promise.reject(null)` is legal and a
     plugin boundary can produce one: the install then resolved as a success, and
     a failed stop read as a clean one, over which the pane says "Nothing was
     left half-installed". The outcome and the value are two different things
     now, and neither can stand in for the other. */

  it('an install rejecting with null is still a failure', async () => {
    const port = voicesPortOver(
      wireOver({
        install: async () => {
          throw null
        },
      }),
    )
    const cause = await refusalOf(port.install('english-kokoro', () => {}))
    expect(cause, 'a rejection with null is a rejection').toBeNull()
    /* And it REJECTED rather than resolving, which is the property — the value
       being null is exactly what made that invisible before. */
    let resolved = false
    await port
      .install('english-kokoro', () => {})
      .then(
        () => {
          resolved = true
        },
        () => {},
      )
    expect(resolved).toBe(false)
  })

  it('a stop rejecting with null still raises StopFailed', async () => {
    const control = new AbortController()
    const port = voicesPortOver(
      wireOver({
        install: async () => {
          control.abort()
          await Promise.resolve()
        },
        stop: async () => {
          throw null
        },
      }),
    )
    const cause = await refusalOf(port.install('english-kokoro', () => {}, control.signal))
    expect(cause, 'the stop was refused and the reader must be told').toBeInstanceOf(StopFailed)
    expect((cause as Error).message).toMatch(/could not be stopped/u)
  })

  it('and an ordinary stop still resolves', async () => {
    const control = new AbortController()
    const port = voicesPortOver(
      wireOver({
        install: async () => {
          control.abort()
          await Promise.resolve()
        },
        stop: async () => {},
      }),
    )
    /* The install itself was aborted, so it rejects — with the abort, not with
       `StopFailed`, which is the distinction the tag preserves. */
    const cause = await refusalOf(port.install('english-kokoro', () => {}, control.signal))
    expect(cause).not.toBeInstanceOf(StopFailed)
  })
})
