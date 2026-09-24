import { beforeEach, describe, expect, it, vi } from 'vitest'
import { passagesWire } from './wire'

/**
 * The Tauri seam, with the plugin faked.
 *
 * ⚠️ **THIS FILE EXISTS BECAUSE A WIRE IS ALL NAMES AND ARGUMENTS.** Nothing in
 * it decides anything, so nothing about it can be checked by asking what it
 * answers — a command name spelled wrong, a `{ book }` that arrives empty, a
 * `from`/`to` the wrong way round — all type-check perfectly and all reach the
 * plugin as a refusal the reader is told nothing about. Phase 30 found
 * `voices/lib/wire.ts` with 21 mutants and no test file at all for exactly this
 * shape. The only thing to assert is what crosses, so that is what is asserted,
 * name by name.
 */
const seam = vi.hoisted(() => ({
  invoke: vi.fn((_command: string, _args?: unknown): Promise<unknown> => Promise.resolve(null)),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: seam.invoke }))

beforeEach(() => {
  seam.invoke.mockReset()
  seam.invoke.mockImplementation(() => Promise.resolve(null))
})

describe('the passages wire', () => {
  it('offers every command the capability may call, and nothing else', () => {
    expect(Object.keys(passagesWire()).sort()).toEqual([
      'flush',
      'forget',
      'indexed',
      'note',
      'notePartial',
      'pending',
      'put',
      'rebuild',
      'rekey',
      'retry',
      'search',
      'status',
    ])
  })

  it('names each command exactly, and carries exactly the arguments it takes', async () => {
    const wire = passagesWire()
    const called = async (run: () => Promise<unknown>): Promise<unknown[]> => {
      seam.invoke.mockClear()
      await run()
      expect(seam.invoke).toHaveBeenCalledTimes(1)
      return seam.invoke.mock.calls[0] as unknown[]
    }
    expect(await called(() => wire.put('book:a', 'gen1', [{ index: 0, text: 'x' }], 7))).toEqual([
      'plugin:passages|passages_put',
      { book: 'book:a', generation: 'gen1', sections: [{ index: 0, text: 'x' }], at: 7 },
    ])
    expect(await called(() => wire.note('book:a', 'gen1', 'no text', 7))).toEqual([
      'plugin:passages|passages_note',
      { book: 'book:a', generation: 'gen1', why: 'no text', at: 7 },
    ])
    expect(await called(() => wire.notePartial('book:a', 'gen1', '1 chapter', 7))).toEqual([
      'plugin:passages|passages_note_partial',
      { book: 'book:a', generation: 'gen1', why: '1 chapter', at: 7 },
    ])
    expect(await called(() => wire.flush())).toEqual(['plugin:passages|passages_flush'])
    expect(await called(() => wire.forget('book:a', 7))).toEqual([
      'plugin:passages|passages_forget',
      { book: 'book:a', at: 7 },
    ])
    /* ⚠️ **THE ORDER OF `from` AND `to` IS THE WHOLE OF WHAT A REKEY IS.**
     * Swapped, it type-checks, runs, and moves the book the wrong way. */
    expect(await called(() => wire.rekey('book:old', 'book:new'))).toEqual([
      'plugin:passages|passages_rekey',
      { from: 'book:old', to: 'book:new' },
    ])
    expect(await called(() => wire.pending([['book:a', 'gen1']]))).toEqual([
      'plugin:passages|passages_pending',
      { books: [['book:a', 'gen1']] },
    ])
    expect(await called(() => wire.indexed())).toEqual(['plugin:passages|passages_indexed'])
    expect(await called(() => wire.rebuild())).toEqual(['plugin:passages|passages_rebuild'])
    expect(await called(() => wire.retry())).toEqual(['plugin:passages|passages_retry'])
    expect(await called(() => wire.status())).toEqual(['plugin:passages|passages_status'])
    expect(await called(() => wire.search('whale', 10))).toEqual([
      'plugin:passages|passages_search',
      { query: 'whale', limit: 10 },
    ])
  })

  it('sends a null limit rather than omitting it', () => {
    /* The plugin's parameter is `Option<u32>`, and an ABSENT field and a `null`
     * one are the same thing to serde — but only because the field is optional
     * on that side. Asserting the shape that is sent is what would catch the
     * day it stops being. */
    void passagesWire().search('whale', null)
    expect(seam.invoke).toHaveBeenCalledWith('plugin:passages|passages_search', {
      query: 'whale',
      limit: null,
    })
  })

  it('answers whatever the plugin answered, unread', () => {
    /* The wire decides nothing — `rows.ts` does. A wire that parsed would be a
     * second place the shape is known. */
    seam.invoke.mockResolvedValueOnce([{ anything: true }])
    return expect(passagesWire().search('whale', null)).resolves.toEqual([{ anything: true }])
  })
})
