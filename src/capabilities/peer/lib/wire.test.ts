import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tauriWire } from './wire'

/**
 * The Tauri seam, with the plugin faked: what a subscription promises about
 * the gap between `listen` being asked and its unlisten arriving.
 */
const listeners = new Map<string, (event: { payload: unknown }) => void>()
let attach: (event: string) => Promise<() => void> = () => Promise.resolve(() => {})

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, fn: (event: { payload: unknown }) => void) => {
    listeners.set(event, fn)
    return attach(event)
  }),
}))


beforeEach(() => {
  listeners.clear()
  attach = () => Promise.resolve(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

const settled = () => new Promise((done) => setTimeout(done, 0))
const fire = (event: string, payload: unknown): void => {
  const fn = listeners.get(event)
  if (!fn) throw new Error(`nothing listens to ${event}`)
  fn({ payload })
}

describe('a subscription on the Tauri wire', () => {
  it('delivers events while live and drops one that lands after unsubscribe, before the plugin has detached', async () => {
    const seen: unknown[] = []
    const off = tauriWire().onPairingResult((payload) => void seen.push(payload))
    fire('peer://pairing-result', 'first')
    off()
    fire('peer://pairing-result', 'late')
    await settled()
    expect(seen).toEqual(['first'])
  })

  it('says a subscribe failure out loud, and whenListening raises the FIRST failure once every registration has settled', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    attach = (event) => (event === 'peer://pairing-pending' ? Promise.reject(new Error('no pairing events')) : Promise.resolve(() => {}))
    const wire = tauriWire()
    wire.onPairingPending(() => {})
    wire.onPairingResult(() => {})
    await expect(wire.whenListening!()).rejects.toThrow(/no pairing events/u)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('peer://pairing-pending'), expect.objectContaining({ message: 'no pairing events' }))
    /* Another wire is not poisoned by this one's failure. */
    attach = () => Promise.resolve(() => {})
    const clean = tauriWire()
    clean.onPairingResult(() => {})
    await expect(clean.whenListening!()).resolves.toBeUndefined()
    spy.mockRestore()
  })

  it('warns when the plugin will not take a listener down, and unsubscribing twice takes it down once', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let taken = 0
    attach = () =>
      Promise.resolve(() => {
        taken += 1
        throw new Error('unlisten refused')
      })
    const off = tauriWire().onPairingResult(() => {})
    await settled()
    off()
    off()
    await settled()
    expect(taken).toBe(1)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('peer://pairing-result'), expect.objectContaining({ message: 'unlisten refused' }))
    spy.mockRestore()
  })
})

describe('a registration that rejects with nothing at all', () => {
  it('is still a failure whenListening raises', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    attach = () => Promise.reject(null)
    const wire = tauriWire()
    wire.onPairingResult(() => {})
    await expect(wire.whenListening!()).rejects.toBeNull()
    spy.mockRestore()
  })
})

describe('the wire’s registrations, held to the letter', () => {
  it('waits for a slow attachment, raises the FIRST of two failures, and wires every session event to its name', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let release: (() => void) | null = null
    attach = (event) => (event === 'peer://session-open' ? new Promise<() => void>((resolve) => { release = () => resolve(() => {}) }) : Promise.resolve(() => {}))
    const wire = tauriWire()
    wire.onSessionOpen!(() => {})
    let listening = false
    void wire.whenListening!().then(() => { listening = true })
    await settled()
    expect(listening).toBe(false)
    release!()
    await settled()
    expect(listening).toBe(true)
    const names = ['peer://session-closed', 'peer://session-frames', 'peer://transfer']
    attach = (event) => (names.includes(event) ? Promise.reject(new Error(`no ${event}`)) : Promise.resolve(() => {}))
    const failing = tauriWire()
    failing.onSessionClosed!(() => {})
    failing.onSessionFrames!(() => {})
    failing.onTransfer!(() => {})
    await expect(failing.whenListening!()).rejects.toThrow(/no peer:\/\/session-closed/u)
    for (const name of names) expect(listeners.has(name)).toBe(true)
    spy.mockRestore()
  })
})
