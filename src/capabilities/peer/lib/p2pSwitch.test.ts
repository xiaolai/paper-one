import { describe, expect, it, vi } from 'vitest'
import { createP2pSwitch } from './p2pSwitch'
import type { P2pAnswer } from './wire'

const write = async (on: boolean) => ({ closed: !on, recordError: null })

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
    const p2p = createP2pSwitch(false, () => Promise.reject(new Error('disk full')))
    await expect(p2p.set(true)).rejects.toThrow('disk full')
    expect(p2p.chosen()).toBe(false)
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

  /* The close behind an Off can take seconds, and a pane reopened meanwhile could
     ask again. Completion order used to choose the answer shown. */
  describe('with writes that overlap', () => {
    const held = () => {
      const started: { on: boolean; land: () => void; refuse: () => void }[] = []
      const write = (on: boolean) =>
        new Promise<P2pAnswer>((resolve, reject) => {
          started.push({ on, land: () => resolve({ closed: !on, recordError: null }), refuse: () => reject(new Error('disk full')) })
        })
      return { started, write }
    }

    it('runs them one at a time, in the order asked, so the last asked is the answer', async () => {
      const { started, write } = held()
      const p2p = createP2pSwitch(true, write)
      const off = p2p.set(false)
      const on = p2p.set(true)
      expect(started.map((one) => one.on)).toEqual([false])
      started[0]!.land()
      await off
      await vi.waitFor(() => expect(started).toHaveLength(2))
      expect(started[1]!.on).toBe(true)
      started[1]!.land()
      await on
      expect(p2p.chosen()).toBe(true)
    })

    it('goes on to the next write after a refused one', async () => {
      const { started, write } = held()
      const p2p = createP2pSwitch(true, write)
      const off = p2p.set(false)
      const again = p2p.set(false)
      started[0]!.refuse()
      await expect(off).rejects.toThrow('disk full')
      await vi.waitFor(() => expect(started).toHaveLength(2))
      started[1]!.land()
      await again
      expect(p2p.chosen()).toBe(false)
    })

    it('needs a launch when the plugin says an Off closed the transport without recording it', async () => {
      const p2p = createP2pSwitch(true, async () => ({ closed: true, recordError: new Error('disk full') }))
      await expect(p2p.set(false)).rejects.toThrow('disk full')
      expect(p2p.chosen()).toBe(true)
      expect(p2p.needsReopen()).toBe(true)
    })

    /* An IPC failure, say: the endpoints are still serving, so saying "closed"
       would tell the reader the connections had gone while they had not. */
    it('claims no close when an Off is rejected, because that says nothing of the transport', async () => {
      const p2p = createP2pSwitch(true, () => Promise.reject(new Error('ipc down')))
      await expect(p2p.set(false)).rejects.toThrow('ipc down')
      expect(p2p.chosen()).toBe(true)
      expect(p2p.needsReopen()).toBe(false)
    })

    it('claims no close when the plugin says it did not, whatever the answer asked for', async () => {
      const p2p = createP2pSwitch(true, async () => ({ closed: false, recordError: new Error('disk full') }))
      await expect(p2p.set(false)).rejects.toThrow('disk full')
      expect(p2p.needsReopen()).toBe(false)
    })

    it('needs no launch when a refused On closed nothing', async () => {
      const p2p = createP2pSwitch(false, async () => ({ closed: false, recordError: new Error('disk full') }))
      await expect(p2p.set(true)).rejects.toThrow('disk full')
      expect(p2p.chosen()).toBe(false)
      expect(p2p.needsReopen()).toBe(false)
    })

    it('calls the write before returning when nothing is ahead of it', () => {
      const { started, write } = held()
      void createP2pSwitch(true, write).set(false)
      expect(started).toHaveLength(1)
    })

    it('says a write is pending, and tells only the writing subscribers about a refusal', async () => {
      const { started, write } = held()
      const p2p = createP2pSwitch(true, write)
      const answers: boolean[] = []
      const pending: boolean[] = []
      p2p.subscribe(() => answers.push(p2p.chosen()))
      const stop = p2p.subscribeWriting(() => pending.push(p2p.writing()))

      const refused = p2p.set(false)
      expect(p2p.writing()).toBe(true)
      started[0]!.refuse()
      await expect(refused).rejects.toThrow('disk full')
      expect(p2p.writing()).toBe(false)
      expect(pending).toEqual([true, false])
      expect(answers).toEqual([])

      stop()
      const landed = p2p.set(false)
      started[1]!.land()
      await landed
      expect(pending).toEqual([true, false])
      expect(answers).toEqual([false])
    })
  })
})
