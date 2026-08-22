import { describe, expect, it, vi } from 'vitest'
import { createController, detailFor } from './controller'
import type { InferencePlugin, InstallProgress, ModelRow, RuntimeStatus } from './plugin'

const MODEL: ModelRow = {
  id: 'qwen',
  label: 'Qwen3-4B',
  modality: 'text',
  license: 'Apache-2.0',
  bytes: 2_497_281_120,
  installed: false,
}

function plugin(over: Partial<InferencePlugin> = {}): InferencePlugin {
  return {
    status: async (): Promise<RuntimeStatus> => ({ state: 'stopped' }),
    models: async () => [MODEL],
    start: async () => 13399,
    stop: async () => {},
    installModel: async () => {},
    removeModel: async () => {},
    cancel: async () => {},
    ...over,
  } as unknown as InferencePlugin
}

/** A promise the test opens when it wants the operation under test to finish. */
function deferred(): { readonly promise: Promise<void>; open(): void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open: () => open() }
}

describe('detailFor', () => {
  it('says what happened in the reader’s words, not a code', () => {
    expect(detailFor({ kind: 'runtimeMissing' })).toBe('The runtime is not installed')
    expect(detailFor({ kind: 'notReady' })).toBe('The runtime did not start')
    expect(detailFor({ kind: 'digestMismatch' })).toMatch(/nothing was changed/)
  })

  it('has a sentence for a rejection that is not the plugin’s', () => {
    expect(detailFor(new Error('boom'))).toBe('Something went wrong')
    expect(detailFor(null)).toBe('Something went wrong')
  })
})

describe('the controller', () => {
  /* ── F2, THE LOAD-BEARING PROPERTY ────────────────────────────────────
   * Absent is a normal state, not a failed start. A controller that threw
   * here would take the Codex and Claude routes down with it on every first
   * launch — routes that need no download at all. */
  it('starts in absent and launches nothing', () => {
    const start = vi.fn()
    const controller = createController(plugin({ start: start as never }))
    expect(controller.getSnapshot().runtime.kind).toBe('absent')
    expect(start).not.toHaveBeenCalled()
  })

  it('reports a failed refresh as degraded rather than throwing', async () => {
    const controller = createController(
      plugin({ status: (async () => { throw { kind: 'runtimeMissing' } }) as never }),
    )
    await expect(controller.refresh()).resolves.toBeUndefined()
    expect(controller.getSnapshot().runtime).toEqual({
      kind: 'degraded',
      detail: 'The runtime is not installed',
    })
  })

  it('reads the catalogue and the runtime status', async () => {
    const controller = createController(plugin())
    await controller.refresh()
    const snapshot = controller.getSnapshot()
    expect(snapshot.runtime.kind).toBe('installed')
    expect(snapshot.models).toHaveLength(1)
  })

  it('reports ready with the daemon’s version', async () => {
    const controller = createController(
      plugin({ status: async () => ({ state: 'ready', version: '11.7.0', port: 13399 }) }),
    )
    await controller.refresh()
    expect(controller.getSnapshot().runtime).toEqual({ kind: 'ready', version: '11.7.0' })
  })

  it('notifies subscribers when the snapshot changes', async () => {
    const controller = createController(plugin())
    const listener = vi.fn()
    controller.subscribe(listener)
    await controller.refresh()
    expect(listener).toHaveBeenCalled()
  })

  it('reports download progress as two counts', async () => {
    const controller = createController(
      plugin({
        installModel: (async (_id: string, _m: string, onProgress: (p: InstallProgress) => void) => {
          onProgress({ kind: 'downloading', received: 412_000_000, total: 2_497_281_120 })
        }) as never,
      }),
    )
    const install = controller.install('qwen')
    await install
    // The final state is `installed`; the intermediate was observed by the
    // callback above, which is what the pane subscribes to.
    expect(controller.getSnapshot().installing).toBeNull()
  })

  it('moves through verifying on the way to installed', async () => {
    const seen: string[] = []
    const controller = createController(
      plugin({
        installModel: (async (_id: string, _m: string, onProgress: (p: InstallProgress) => void) => {
          onProgress({ kind: 'downloading', received: 1, total: 2 })
          seen.push(controller.getSnapshot().runtime.kind)
          onProgress({ kind: 'verifying' })
          seen.push(controller.getSnapshot().runtime.kind)
        }) as never,
      }),
    )
    await controller.install('qwen')
    expect(seen).toEqual(['installing', 'verifying'])
  })

  /* A cancellation is the reader's own doing. Reporting it as `degraded`
   * would put an error in front of someone who pressed Cancel. */
  it('returns quietly to where it was when the reader cancels', async () => {
    const controller = createController(
      plugin({ installModel: (async () => { throw { kind: 'cancelled' } }) as never }),
    )
    await controller.install('qwen')
    /* BACK TO WHAT IT WAS, not to `installed`. This test asserted `installed`
     * and was encoding a bug an audit caught: a reader cancelling their FIRST
     * download had nothing installed, and the row claimed otherwise. The
     * controller starts in `absent`, so that is where cancelling returns it. */
    expect(controller.getSnapshot().runtime.kind).toBe('absent')
    expect(controller.getSnapshot().installing).toBeNull()
  })

  it('returns to `installed` when that is where it was', async () => {
    const controller = createController(
      plugin({ installModel: (async () => { throw { kind: 'cancelled' } }) as never }),
    )
    await controller.refresh()
    expect(controller.getSnapshot().runtime.kind).toBe('installed')
    await controller.install('qwen')
    expect(controller.getSnapshot().runtime.kind).toBe('installed')
  })

  it('reports a real install failure as degraded and rethrows', async () => {
    const controller = createController(
      plugin({ installModel: (async () => { throw { kind: 'digestMismatch' } }) as never }),
    )
    await expect(controller.install('qwen')).rejects.toBeTruthy()
    expect(controller.getSnapshot().runtime).toEqual({
      kind: 'degraded',
      detail: 'The download did not verify — nothing was changed',
    })
  })

  it('refuses a second download while one is in flight', async () => {
    /* A gate the test opens, rather than a captured `resolve`: TypeScript
     * cannot see an assignment made inside the promise's executor, so the
     * captured-variable spelling narrows to `never` and will not compile. */
    const gate = deferred()
    const controller = createController(plugin({ installModel: (() => gate.promise) as never }))
    const first = controller.install('qwen')
    await controller.install('kokoro')
    expect(controller.getSnapshot().installing).toBe('qwen')
    gate.open()
    await first
  })

  /* A refresh landing mid-download must not stamp `installed` over a state
   * whose bytes are still arriving. */
  it('does not let a refresh overwrite a download in flight', async () => {
    const gate = deferred()
    const controller = createController(plugin({ installModel: (() => gate.promise) as never }))
    const install = controller.install('qwen')
    await controller.refresh()
    expect(controller.getSnapshot().runtime.kind).toBe('installing')
    gate.open()
    await install
  })

  it('cancels the in-flight download by its request id', async () => {
    const cancel = vi.fn(async () => {})
    const gate = deferred()
    const controller = createController(
      plugin({ cancel: cancel as never, installModel: (() => gate.promise) as never }),
    )
    const install = controller.install('qwen')
    controller.cancelInstall()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().installing).toBeNull()
    gate.open()
    await install
  })

  it('cancelling nothing is a no-op', () => {
    const cancel = vi.fn(async () => {})
    const controller = createController(plugin({ cancel: cancel as never }))
    controller.cancelInstall()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('starts the daemon only when asked, and reports whether it came up', async () => {
    const start = vi.fn(async () => 13399)
    const controller = createController(
      plugin({ start: start as never, status: async () => ({ state: 'ready', version: '11.7.0', port: 13399 }) }),
    )
    await expect(controller.ensureReady()).resolves.toBe(true)
    expect(start).toHaveBeenCalledTimes(1)
  })

  /* ⚠️ THIS TEST USED TO ASSERT THE BUG. It required `start` to be called
   * once and never again, which is exactly what made a crashed daemon
   * unrecoverable: every later question saw the cached `ready`, skipped the
   * start, and failed at the request instead. An audit caught it.
   *
   * `start` is idempotent and cheap when the daemon is up — the plugin
   * health-checks and returns the same port — so asking every time costs one
   * loopback round trip and buys a runtime that recovers by itself. */
  it('re-asks on every call, so a crashed daemon can come back', async () => {
    const start = vi.fn(async () => 13399)
    const controller = createController(
      plugin({ start: start as never, status: async () => ({ state: 'ready', version: '11.7.0', port: 13399 }) }),
    )
    await controller.ensureReady()
    await controller.ensureReady()
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('recovers when the daemon comes back after a failure', async () => {
    let alive = false
    const controller = createController(
      plugin({
        start: (async () => {
          if (!alive) throw { kind: 'notReady' }
          return 13399
        }) as never,
        status: async () => (alive ? { state: 'ready', version: '11.7.0', port: 13399 } : { state: 'stopped' }),
      }),
    )
    await expect(controller.ensureReady()).resolves.toBe(false)
    expect(controller.getSnapshot().runtime.kind).toBe('degraded')
    alive = true
    await expect(controller.ensureReady()).resolves.toBe(true)
    expect(controller.getSnapshot().runtime.kind).toBe('ready')
  })

  /* The race an audit named: a refresh in flight when an install starts must
   * not land with a stale `busy` and stamp over the download. */
  it('does not let an in-flight refresh overwrite an install that started after it', async () => {
    const gate = deferred()
    const controller = createController(
      plugin({
        status: (async () => {
          await gate.promise
          return { state: 'stopped' }
        }) as never,
        installModel: (() => new Promise<void>(() => {})) as never,
      }),
    )
    const refreshing = controller.refresh()
    void controller.install('qwen')
    expect(controller.getSnapshot().runtime.kind).toBe('installing')
    gate.open()
    await refreshing
    expect(controller.getSnapshot().runtime.kind).toBe('installing')
  })

  it('reports degraded and false when the daemon will not start', async () => {
    const controller = createController(
      plugin({ start: (async () => { throw { kind: 'notReady' } }) as never }),
    )
    await expect(controller.ensureReady()).resolves.toBe(false)
    expect(controller.getSnapshot().runtime.kind).toBe('degraded')
  })

  it('names an installed text model and ignores an uninstalled or speech one', async () => {
    const controller = createController(
      plugin({
        models: async () => [
          { ...MODEL, installed: false },
          { ...MODEL, id: 'kokoro', modality: 'speech', installed: true },
          { ...MODEL, id: 'qwen-installed', installed: true },
        ],
      }),
    )
    await controller.refresh()
    expect(controller.textModel()).toBe('qwen-installed')
  })

  it('names no model when none is installed', async () => {
    const controller = createController(plugin())
    await controller.refresh()
    expect(controller.textModel()).toBeNull()
  })

  it('stops notifying once disposed', async () => {
    const controller = createController(plugin())
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.dispose()
    await controller.refresh()
    expect(listener).not.toHaveBeenCalled()
  })
})

/**
 * UNINSTALL, which is the one command here that DELETES a reader's bytes.
 *
 * The refresh afterwards is the load-bearing half and the easy one to drop:
 * without it the row keeps saying Installed over artifacts that are gone, and
 * the next Install is offered as a Remove.
 */
describe('uninstall', () => {
  it('removes through the plugin, then re-reads the list', async () => {
    const removed: string[] = []
    let listed = [MODEL]
    const controller = createController(
      plugin({
        removeModel: async (id: string) => {
          removed.push(id)
          listed = []
        },
        models: async () => listed,
      }),
    )
    await controller.refresh()
    expect(controller.getSnapshot().models).toHaveLength(1)

    await controller.uninstall(MODEL.id)
    expect(removed).toEqual([MODEL.id])
    /* The re-read, not a local splice: the daemon is the authority on what is
       on disk, and a list edited here would diverge the moment a removal
       partly failed. */
    expect(controller.getSnapshot().models).toEqual([])
    controller.dispose()
  })
})
