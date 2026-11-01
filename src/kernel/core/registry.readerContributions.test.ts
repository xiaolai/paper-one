import { describe, expect, it } from 'vitest'
import type { Capability, ReaderContext, ReaderContribution } from './capability'
import { composeCapabilities, kernelApi } from './registry'
import { createKernelServices } from './services'

/**
 * The two contributions the reader's own reading will leave the kernel through:
 * `windowHosts` and `readerControls`.
 *
 * What is proven here is the REGISTRY's half, which is the same for both: each is
 * validated the way a mark control is, collected from what started, and withdrawn
 * with the composition. Where they are drawn, and what a held pace does to the
 * book, is `ui/reader/readerContributions.test.tsx`.
 */

const api = () => kernelApi(createKernelServices({ fs: null, storage: null }))
const signal = () => new AbortController().signal
const compose = (caps: readonly Capability[]) => composeCapabilities(caps, api(), signal())

const one = (over: Partial<ReaderContribution> = {}): ReaderContribution => ({
  id: 'narration:one',
  render: () => null,
  ...over,
})

const CONTEXT = { sectionKey: 'section', surface: {} } as unknown as ReaderContext

describe.each([
  { seam: 'windowHosts', kind: 'window host' },
  { seam: 'readerControls', kind: 'reader control' },
] as const)('$seam, through the composition', ({ seam, kind }) => {
  const providing = (contributions: readonly ReaderContribution[], id = 'narration'): Capability => ({
    id,
    [seam]: contributions,
  })

  it('is collected once the capability starts, and withdrawn when the composition goes', async () => {
    const composition = await compose([providing([one()])])
    expect(composition[seam].map((drawn) => drawn.id)).toEqual(['narration:one'])
    composition.dispose()
    expect(composition[seam]).toEqual([])
  })

  it('keeps registration order, across capabilities', async () => {
    const composition = await compose([
      providing([one({ id: 'first:a' }), one({ id: 'first:b' })], 'first'),
      providing([one({ id: 'second:a' })], 'second'),
    ])
    expect(composition[seam].map((drawn) => drawn.id)).toEqual(['first:a', 'first:b', 'second:a'])
    composition.dispose()
  })

  it('hands the renderer the context and the kernel its answer, bound to the contribution', async () => {
    const seen: unknown[] = []
    const contribution = {
      id: 'narration:one',
      said: 'drawn',
      render(this: { said: string }, context: ReaderContext) {
        seen.push(context)
        return this.said
      },
    } as unknown as ReaderContribution
    const composition = await compose([providing([contribution])])
    const { render } = composition[seam][0]!
    expect(render(CONTEXT)).toBe('drawn')
    expect(seen).toEqual([CONTEXT])
    composition.dispose()
  })

  it('takes the id and the renderer, and nothing else that was on the object', async () => {
    const composition = await compose([providing([{ ...one(), extra: true } as ReaderContribution])])
    expect(Object.keys(composition[seam][0]!).sort()).toEqual(['id', 'render'])
    composition.dispose()
  })

  it('cannot be changed after it was checked', async () => {
    /* `start` runs after the check, with the capability's own arrays still in its
       hands: what it does to them must not reach what the window draws. */
    const list = [one()]
    const object = list[0] as { render: ReaderContribution['render'] }
    const composition = await compose([
      {
        ...providing(list),
        start: () => {
          list.push(one({ id: 'other:unchecked' }))
          object.render = () => 'swapped'
          return { dispose: () => {} }
        },
      },
    ])
    expect(composition[seam].map((drawn) => drawn.id)).toEqual(['narration:one'])
    expect(composition[seam][0]!.render(CONTEXT)).toBe(null)
    expect(Object.isFrozen(composition[seam]), 'the list').toBe(true)
    expect(Object.isFrozen(composition[seam][0]), 'the record').toBe(true)
    composition.dispose()
  })

  it('is left out with a capability that did not start, and kept for one that did', async () => {
    const composition = await compose([
      {
        ...providing([one({ id: 'broken:a' })], 'broken'),
        start: () => {
          throw new Error('no engine')
        },
      },
      providing([one({ id: 'fine:a' })], 'fine'),
    ])
    expect(composition.failures.map((failure) => failure.id)).toEqual(['broken'])
    expect(composition[seam].map((drawn) => drawn.id)).toEqual(['fine:a'])
    composition.dispose()
  })

  it('is empty for a capability that offers none', async () => {
    const composition = await compose([{ id: 'narration' }])
    expect(composition[seam]).toEqual([])
    composition.dispose()
  })

  it('refuses an id that does not name its capability, by what it is', async () => {
    const refusal = compose([providing([one({ id: 'other:one' })])])
    await expect(refusal).rejects.toThrow(`${kind} id "other:one" of capability "narration" must be "narration:<name>"`)
    await expect(refusal).rejects.toMatchObject({ code: 'namespace' })
  })

  it('refuses a bare prefix with no name after it', async () => {
    await expect(compose([providing([one({ id: 'narration:' })])])).rejects.toThrow(/must be "narration:<name>"/u)
  })

  it('refuses one with nothing to render, at composition rather than in the window', async () => {
    const refusal = compose([providing([one({ render: undefined as never })])])
    await expect(refusal).rejects.toThrow(`${kind} "narration:one" has no render() to call`)
    await expect(refusal).rejects.toMatchObject({ code: 'namespace' })
  })

  it('refuses the same id contributed twice', async () => {
    const refusal = compose([providing([one(), one()])])
    await expect(refusal).rejects.toThrow(`${kind} "narration:one" is registered twice`)
    await expect(refusal).rejects.toMatchObject({ code: 'duplicate-contribution' })
  })
})

describe('a window host and a reader control', () => {
  it('may share one name: they are different contributions in different lists', async () => {
    /* A host and the control that drives it are the natural pair to name alike,
       which is what a shared claim once cost a book action and a book status. */
    const composition = await compose([{ id: 'narration', windowHosts: [one()], readerControls: [one()] }])
    expect(composition.windowHosts.map((drawn) => drawn.id)).toEqual(['narration:one'])
    expect(composition.readerControls.map((drawn) => drawn.id)).toEqual(['narration:one'])
    composition.dispose()
  })
})
