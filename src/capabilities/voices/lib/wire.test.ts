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
      'install',
      'onProgress',
      'release',
      'remove',
      'render',
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
    expect(await called(() => wire.render('chinese-qwen', 'Vivian', '春天', 1.25))).toEqual([
      'plugin:voices|voices_render',
      { pack: 'chinese-qwen', voice: 'Vivian', text: '春天', rate: 1.25 },
    ])
    /* A null rate is the reader having chosen none, and it must cross as null
       rather than be dropped: the plugin reads an absent rate as the pack's
       own default, which is a different reading from the one asked for. */
    expect(await called(() => wire.render('english-kokoro', 'Heart', 'Call me Ishmael.', null))).toEqual([
      'plugin:voices|voices_render',
      { pack: 'english-kokoro', voice: 'Heart', text: 'Call me Ishmael.', rate: null },
    ])
    expect(await called(() => wire.release())).toEqual(['plugin:voices|voices_release'])
  })

  it('hands back what the plugin answered, rather than answering itself', async () => {
    const rows = [{ id: 'english-kokoro' }]
    seam.invoke.mockImplementation(() => Promise.resolve(rows))
    await expect(voicesWire().catalogue()).resolves.toBe(rows)
    const spoken = { pcm: [0, 1], sampleRate: 24_000, words: [], skipped: [] }
    seam.invoke.mockImplementation(() => Promise.resolve(spoken))
    await expect(voicesWire().render('english-kokoro', 'Heart', 'A.', null)).resolves.toBe(spoken)
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
