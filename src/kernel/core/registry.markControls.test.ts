import { describe, expect, it } from 'vitest'
import type { Capability, MarkControl } from './capability'
import { composeCapabilities, kernelApi } from './registry'
import { createKernelServices } from './services'

/**
 * The mark-control contribution — the tenth type, added for WI-23.A1.
 *
 * What is proven here is the REGISTRY's half: that a control is validated the
 * way a screen is, collected the way a book action is, and withdrawn with the
 * composition. What the control draws is the capability's business
 * (`ShareControl.test.tsx`), and where it is drawn is Marginalia's.
 */

const api = () => kernelApi(createKernelServices({ fs: null, storage: null }))
const signal = () => new AbortController().signal

const control = (over: Partial<MarkControl> = {}): MarkControl => ({
  id: 'circle:share',
  render: () => null,
  ...over,
})

const withControls = (controls: readonly MarkControl[], id = 'circle'): Capability => ({
  id,
  markControls: controls,
})

describe('a mark control, through the composition', () => {
  it('is collected once the capability starts, and withdrawn when the composition goes', async () => {
    const composition = await composeCapabilities([withControls([control()])], api(), signal())
    expect(composition.markControls.map((one) => one.id)).toEqual(['circle:share'])
    composition.dispose()
    /* Nothing draws a torn-down capability's control on a reader's note. */
    expect(composition.markControls).toEqual([])
  })

  it('hands the row the capability its element, with the mark it asked about', async () => {
    /* The renderer is bound and copied at composition, the way a screen's
       is, so the value the row receives is the capability's own answer. */
    const seen: string[] = []
    const composition = await composeCapabilities(
      [withControls([control({ render: (mark) => { seen.push(mark.id); return 'drawn' } })])],
      api(),
      signal(),
    )
    const rendered = composition.markControls[0]!.render({ id: 'm1' } as never)
    expect(rendered).toBe('drawn')
    expect(seen).toEqual(['m1'])
    composition.dispose()
  })

  it('refuses an id that does not name its capability', async () => {
    /* `<capability>:<name>`, like every other contribution, so an id says who
       owns it and cannot collide with a kernel surface. */
    await expect(
      composeCapabilities([withControls([control({ id: 'share:circle' as never })])], api(), signal()),
    ).rejects.toThrow(/mark control id "share:circle" of capability "circle" must be "circle:<name>"/u)
  })

  it('refuses a bare prefix with no name after it', async () => {
    await expect(
      composeCapabilities([withControls([control({ id: 'circle:' as never })])], api(), signal()),
    ).rejects.toThrow(/must be "circle:<name>"/u)
  })

  it('refuses a control with nothing to render', async () => {
    /* ⚠️ Checked at composition rather than discovered inside a Marginalia
       row: a control whose `render` is undefined has an id that validates and
       throws under the reader's own notes. */
    await expect(
      composeCapabilities([withControls([control({ render: undefined as never })])], api(), signal()),
    ).rejects.toThrow(/mark control "circle:share" has no render\(\) to call/u)
  })

  it('refuses the same id contributed twice', async () => {
    await expect(
      composeCapabilities([withControls([control(), control()])], api(), signal()),
    ).rejects.toThrow(/mark control "circle:share" is registered twice/u)
  })

  it('refuses one id claimed by two capabilities', async () => {
    await expect(
      composeCapabilities(
        [withControls([control()], 'circle'), withControls([control({ id: 'circle:share' })], 'other')],
        api(),
        signal(),
      ),
    ).rejects.toThrow(/must be "other:<name>"/u)
  })
})

describe('a capability with no controls at all', () => {
  it('contributes none, and the refusal names the namespace rule', async () => {
    const { markControls: _none, ...bare } = withControls([])
    const composition = await composeCapabilities([bare as Capability], api(), signal())
    expect(composition.markControls).toEqual([])
    composition.dispose()
    await expect(composeCapabilities([withControls([control({ render: undefined as never })])], api(), signal())).rejects.toMatchObject({ code: 'namespace' })
  })
})

describe('a service with nothing to call', () => {
  it('is refused at composition, before any transport meets it', async () => {
    const broken = { ...withControls([]), services: [{ name: 'circle.ping', grant: 'circle:read', handler: undefined as never }] } as Capability
    await expect(composeCapabilities([broken], api(), signal())).rejects.toThrow(/service "circle.ping" has no handler to call/u)
  })
})
