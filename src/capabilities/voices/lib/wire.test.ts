import { beforeEach, describe, expect, it, vi } from 'vitest'
import { voicesWire } from './wire'

/**
 * The Tauri seam, with the plugin faked.
 *
 * ⚠️ **THIS FILE EXISTS BECAUSE A WIRE IS ALL NAMES AND ARGUMENTS.** Nothing in
 * it decides anything, so nothing about it can be checked by asking what it
 * answers — a command name spelled wrong, a `{ pack }` that arrives empty or a
 * subscription on the wrong event all type-check perfectly and all reach the
 * plugin as a refusal the reader is told nothing about. The only thing to
 * assert is what crosses, so that is what is asserted, name by name.
 */
const seam = vi.hoisted(() => ({
  invoke: vi.fn((_command: string, _args?: unknown): Promise<unknown> => Promise.resolve(null)),
  listen: vi.fn(
    (_event: string, _handler: (event: { payload: unknown }) => void): Promise<() => void> =>
      Promise.resolve(() => {}),
  ),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: seam.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: seam.listen }))

beforeEach(() => {
  seam.invoke.mockReset()
  seam.invoke.mockImplementation(() => Promise.resolve(null))
  seam.listen.mockReset()
  seam.listen.mockImplementation(() => Promise.resolve(() => {}))
})

describe('the voices wire', () => {
  it('offers every command the capability may call, and nothing else', () => {
    expect(Object.keys(voicesWire()).sort()).toEqual([
      'catalogue',
      'clipFind',
      'clipForget',
      'clipHold',
      'clipRender',
      'clipUsage',
      'install',
      'onProgress',
      'readClip',
      'release',
      'remove',
      'stop',
    ])
  })

  it('names each command exactly, and carries exactly the arguments it takes', async () => {
    const wire = voicesWire()
    const called = async (run: () => Promise<unknown>): Promise<unknown[]> => {
      seam.invoke.mockClear()
      await run()
      expect(seam.invoke).toHaveBeenCalledTimes(1)
      return seam.invoke.mock.calls[0] as unknown[]
    }
    expect(await called(() => wire.catalogue())).toEqual(['plugin:voices|voices_catalogue'])
    expect(await called(() => wire.install('english-kokoro'))).toEqual([
      'plugin:voices|voices_install',
      { pack: 'english-kokoro' },
    ])
    expect(await called(() => wire.stop('english-kokoro'))).toEqual([
      'plugin:voices|voices_stop',
      { pack: 'english-kokoro' },
    ])
    expect(await called(() => wire.remove('chinese-qwen'))).toEqual([
      'plugin:voices|voices_remove',
      { pack: 'chinese-qwen' },
    ])
    const query = {
      book: 'book:a',
      section: 12,
      pack: 'chinese-qwen',
      voice: 'Vivian',
      rate: 1.25,
      textDigest: 'fnv1a64:2:0000000000000001',
      spokenDigest: 'fnv1a64:2:0000000000000002',
    }
    expect(await called(() => wire.clipFind(query))).toEqual([
      'plugin:voices|voices_clip_find',
      { ask: query },
    ])
    expect(await called(() => wire.clipRender(query, '春天'))).toEqual([
      'plugin:voices|voices_clip_render',
      { ask: query, text: '春天' },
    ])
    /* A null rate is the reader having chosen none, and it must cross as null
       rather than be dropped: the plugin reads an absent rate as the pack's
       own default, which is a different reading from the one asked for. */
    expect(await called(() => wire.clipFind({ ...query, rate: null }))).toEqual([
      'plugin:voices|voices_clip_find',
      { ask: { ...query, rate: null } },
    ])
    /* ⚠️ **THE LEASE'S COMMAND NAME AND ITS ARGUMENTS WERE UNASSERTED — FOUND BY
       THE MUTATION SWEEP.** Every defect here type-checks and arrives at the
       plugin as a refusal the reader is told nothing about: a wrong name is an
       unknown command, and dropped arguments are a hold of nothing that answers
       zero, which the export reads as *the clip has gone* and re-renders. */
    expect(await called(() => wire.clipHold(['book_a-12-0', 'book_b-3-1'], true))).toEqual([
      'plugin:voices|voices_clip_hold',
      { stems: ['book_a-12-0', 'book_b-3-1'], hold: true },
    ])
    /* BOTH DIRECTIONS, because the flag is the whole of what distinguishes taking
       a lease from giving one back. */
    expect(await called(() => wire.clipHold(['book_a-12-0'], false))).toEqual([
      'plugin:voices|voices_clip_hold',
      { stems: ['book_a-12-0'], hold: false },
    ])
    expect(await called(() => wire.clipUsage())).toEqual(['plugin:voices|voices_clip_usage'])
    expect(await called(() => wire.clipForget('book:a'))).toEqual([
      'plugin:voices|voices_clip_forget',
      { book: 'book:a' },
    ])
    /* A null book is *forget all of it*, and must cross as null rather than be
       dropped: an absent argument would read as the same thing by accident, and
       an accident is not a decision. */
    expect(await called(() => wire.clipForget(null))).toEqual([
      'plugin:voices|voices_clip_forget',
      { book: null },
    ])
    seam.invoke.mockImplementation(() => Promise.resolve(new Uint8Array([1, 2]).buffer))
    expect(await called(() => wire.readClip('book_a-12-0'))).toEqual([
      'plugin:voices|voices_clip_read',
      { stem: 'book_a-12-0' },
    ])
    seam.invoke.mockImplementation(() => Promise.resolve(null))
    expect(await called(() => wire.release())).toEqual(['plugin:voices|voices_release'])
  })

  it('hands back what the plugin answered, rather than answering itself', async () => {
    const rows = [{ id: 'english-kokoro' }]
    seam.invoke.mockImplementation(() => Promise.resolve(rows))
    await expect(voicesWire().catalogue()).resolves.toBe(rows)
    const clip = { stem: 'book_a-1-0', path: '/x.wav', bytes: 44 }
    seam.invoke.mockImplementation(() => Promise.resolve(clip))
    const query = {
      book: 'book:a',
      section: 1,
      pack: 'english-kokoro',
      voice: 'Heart',
      rate: null,
      textDigest: 'fnv1a64:2:0000000000000001',
      spokenDigest: 'fnv1a64:2:0000000000000002',
    }
    await expect(voicesWire().clipFind(query)).resolves.toBe(clip)
    await expect(voicesWire().clipRender(query, 'A.')).resolves.toBe(clip)
  })

  it('reads a clip as bytes, not as a list of numbers', async () => {
    /* ⚠️ THE WHOLE REASON THE READ IS A COMMAND OF THE PLUGIN'S RATHER THAN A
       `Vec<u8>` RETURN: WI-34.0 measured a real section at 139 924 800 bytes, and
       a `Vec<u8>` crosses as a JSON array of decimal numbers. The Rust side
       answers `tauri::ipc::Response`, which arrives as an `ArrayBuffer`. */
    const bytes = new Uint8Array([0, 255, 7, 8])
    seam.invoke.mockImplementation(() => Promise.resolve(bytes.buffer))
    const read = await voicesWire().readClip('book_a-1-0')
    expect(read).toBeInstanceOf(Uint8Array)
    expect([...read]).toEqual([0, 255, 7, 8])
  })

  it('lets a refusal through instead of swallowing it', async () => {
    seam.invoke.mockImplementation(() => Promise.reject(new Error('no such pack')))
    await expect(voicesWire().install('nope')).rejects.toThrow(/no such pack/u)
  })

  it('subscribes to the progress event, and hands the handler the payload alone', async () => {
    const seen: unknown[] = []
    const off = () => {}
    seam.listen.mockImplementation(() => Promise.resolve(off))
    const unlisten = await voicesWire().onProgress((payload) => void seen.push(payload))
    expect(seam.listen.mock.calls[0]?.[0]).toBe('voices://progress')
    expect(unlisten, 'the plugin’s own unlisten, not one of ours').toBe(off)
    const deliver = seam.listen.mock.calls[0]?.[1]
    deliver?.({ payload: { pack: 'english-kokoro', kind: 'verifying' } })
    expect(seen).toEqual([{ pack: 'english-kokoro', kind: 'verifying' }])
  })
})
