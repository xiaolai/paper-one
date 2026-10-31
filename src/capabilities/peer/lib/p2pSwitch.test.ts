import { describe, expect, it } from 'vitest'
import { createP2pSwitch } from './p2pSwitch'

const write = async () => {}

describe('the P2P switch across one run', () => {
  it('needs nothing until the answer changes', () => {
    expect(createP2pSwitch(true, write).needsReopen()).toBe(false)
    expect(createP2pSwitch(false, write).needsReopen()).toBe(false)
  })

  it('needs a reopen after going off, and going on again does not undo the close', async () => {
    const p2p = createP2pSwitch(true, write)
    await p2p.set(false)
    expect(p2p.needsReopen()).toBe(true)
    await p2p.set(true)
    expect(p2p.chosen()).toBe(true)
    expect(p2p.needsReopen()).toBe(true)
  })

  it('needs no reopen when a run that started off goes on and back, because nothing ever ran', async () => {
    const p2p = createP2pSwitch(false, write)
    await p2p.set(true)
    expect(p2p.needsReopen()).toBe(true)
    await p2p.set(false)
    expect(p2p.needsReopen()).toBe(false)
  })

  it('keeps the old answer when the write is refused', async () => {
    const p2p = createP2pSwitch(true, () => Promise.reject(new Error('disk full')))
    await expect(p2p.set(false)).rejects.toThrow('disk full')
    expect(p2p.chosen()).toBe(true)
    expect(p2p.needsReopen()).toBe(false)
  })

  it('tells a subscriber when an answer lands, until it unsubscribes', async () => {
    const p2p = createP2pSwitch(true, write)
    const seen: boolean[] = []
    const stop = p2p.subscribe(() => seen.push(p2p.chosen()))
    await p2p.set(false)
    stop()
    await p2p.set(true)
    expect(seen).toEqual([false])
  })
})
