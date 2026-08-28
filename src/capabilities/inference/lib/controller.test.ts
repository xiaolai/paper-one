import { describe, expect, it, vi } from 'vitest'
import { createController, detailFor, type ControllerPlugin, type InferenceSnapshot } from './controller'
import type { InstallProgress, ModelRow, RuntimeStatus } from './plugin'

const MODEL: ModelRow = {
  id: 'qwen',
  label: 'Qwen3-4B',
  modality: 'text',
  license: 'Apache-2.0',
  bytes: 2_497_281_120,
  installed: false,
}

/**
 * A typed stand-in for the six commands the controller uses.
 *
 * NO CAST ANYWHERE. This fake used to end in `as unknown as InferencePlugin`
 * with most overrides cast to `never` on the way in, which switched off
 * signature checking for the whole suite — the one thing that would catch the
 * plugin's API moving under the controller. `createController` now takes
 * `ControllerPlugin`, six commands wide, so the fake type-checks as written and
 * a changed signature is a red test rather than a runtime surprise.
 */
function plugin(over: Partial<ControllerPlugin> = {}): ControllerPlugin {
  return {
    status: async (): Promise<RuntimeStatus> => ({ state: 'stopped' }),
    models: async (): Promise<readonly ModelRow[]> => [MODEL],
    start: async () => 13399,
    installModel: async () => {},
    removeModel: async () => {},
    cancel: async () => {},
    ...over,
  }
}

/** A promise the test opens when it wants the operation under test to finish. */
function deferred(): { readonly promise: Promise<void>; open(): void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open: () => open() }
}

const cancelled = () => Object.assign(new Error('cancelled'), { kind: 'cancelled' })

describe('detailFor', () => {
  it('says what happened in the reader’s words, not a code', () => {
    expect(detailFor({ kind: 'runtimeMissing' })).toBe('The runtime is not installed')
    expect(detailFor({ kind: 'notReady' })).toBe('The runtime did not start')
    expect(detailFor({ kind: 'digestMismatch' })).toMatch(/nothing was changed/)
    expect(detailFor({ kind: 'runtimeUnverified' })).toBe('The runtime did not verify — nothing was started')
  })

  it('has a sentence for a rejection that is not the plugin’s', () => {
    expect(detailFor(new Error('boom'))).toBe('Something went wrong')
    expect(detailFor(null)).toBe('Something went wrong')
  })

  /* ── REACHABLE FROM THE COMPANION, and added because they were not ────
   * WI-20.18. An agent route rejects with the four `agent*` kinds and the
   * keychain with its own, and every one of them landed on the default — so a
   * reader signed out of Codex was told "Something went wrong" by a thread
   * that knew exactly what was wrong. */
  it('has a sentence for each way an agent route fails', () => {
    expect(detailFor({ kind: 'agentSignedOut' })).toBe('That agent is not signed in')
    expect(detailFor({ kind: 'agentMissing' })).toBe('That agent is not installed')
    expect(detailFor({ kind: 'agentUnsupportedVersion' })).toBe('That agent’s version is not supported')
    expect(detailFor({ kind: 'agentMalformed' })).toBe('That agent’s answer could not be read')
    expect(detailFor({ kind: 'keychain' })).toBe('The keychain refused')
  })
})

describe('the controller', () => {
  /* ── F2, THE LOAD-BEARING PROPERTY ────────────────────────────────────
   * Absent is a normal state, not a failed start. A controller that threw
   * here would take the Codex and Claude routes down with it on every first
   * launch — routes that need no download at all. */
  it('starts in absent and launches nothing', () => {
    const start = vi.fn(async () => 13399)
    const controller = createController(plugin({ start }))
    expect(controller.getSnapshot().runtime.kind).toBe('absent')
    expect(start).not.toHaveBeenCalled()
  })

  it('reports a failed refresh as degraded rather than throwing', async () => {
    const controller = createController(
      plugin({
        status: async () => {
          throw { kind: 'runtimeMissing' }
        },
      }),
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

  /**
   * TWO REFRESHES, NEWEST WINS.
   *
   * `status()` and `models()` are two IPC round trips and need not answer in
   * the order they were asked, so a refresh issued when the reader opens the
   * pane can land after one issued by a later action and put back the
   * catalogue it read. Nothing caught it: the old suite only ever had one
   * refresh in flight at a time.
   */
  it('keeps the newest refresh when an older one resolves after it', async () => {
    const gates = [deferred(), deferred()]
    let asked = 0
    const controller = createController(
      plugin({
        models: async () => {
          const mine = asked++
          await gates[mine]!.promise
          return [{ ...MODEL, id: mine === 0 ? 'stale' : 'fresh' }]
        },
      }),
    )
    const older = controller.refresh()
    const newer = controller.refresh()

    /* BACKWARDS ON PURPOSE: the second call answers first, then the first. */
    gates[1]!.open()
    await newer
    expect(controller.getSnapshot().models.map((row) => row.id)).toEqual(['fresh'])

    gates[0]!.open()
    await older
    expect(
      controller.getSnapshot().models.map((row) => row.id),
      'a superseded refresh overwrote the current catalogue',
    ).toEqual(['fresh'])
    controller.dispose()
  })

  /* THE COUNTS THEMSELVES, not just the end state. This test used to assert
     only that `installing` was null when it was over, so a controller that
     ignored every progress callback passed it — and the byte figure is the
     entire content of the row while a download runs. */
  it('reports download progress as two counts', async () => {
    const seen: InferenceSnapshot[] = []
    const controller = createController(
      plugin({
        installModel: async (_id, _model, onProgress: (p: InstallProgress) => void) => {
          onProgress({ kind: 'downloading', received: 412_000_000, total: 2_497_281_120 })
          seen.push(controller.getSnapshot())
        },
      }),
    )
    await controller.install('qwen')

    expect(seen).toHaveLength(1)
    expect(seen[0]?.runtime).toEqual({
      kind: 'installing',
      model: 'qwen',
      received: 412_000_000,
      total: 2_497_281_120,
    })
    expect(seen[0]?.installing).toBe('qwen')
    expect(controller.getSnapshot().installing).toBeNull()
    controller.dispose()
  })

  it('moves through verifying on the way to installed', async () => {
    const seen: string[] = []
    const controller = createController(
      plugin({
        installModel: async (_id, _model, onProgress: (p: InstallProgress) => void) => {
          onProgress({ kind: 'downloading', received: 1, total: 2 })
          seen.push(controller.getSnapshot().runtime.kind)
          onProgress({ kind: 'verifying' })
          seen.push(controller.getSnapshot().runtime.kind)
        },
      }),
    )
    await controller.install('qwen')
    expect(seen).toEqual(['installing', 'verifying'])
    controller.dispose()
  })

  /**
   * THE ROW IS CORRECTED FROM THE COMMAND, NOT ONLY FROM THE REFRESH.
   *
   * `refresh` absorbs its own failure by design, so an install that depended
   * on it alone reported success over a catalogue still saying the model was
   * not installed — and the button the reader was looking at still said
   * Install for something that had just finished downloading.
   */
  it('marks the model installed even when the confirming refresh fails', async () => {
    let installed = false
    const controller = createController(
      plugin({
        installModel: async () => void (installed = true),
        models: async () => {
          if (installed) throw { kind: 'runtimeUnreachable' }
          return [MODEL]
        },
      }),
    )
    await controller.refresh()
    expect(controller.getSnapshot().models[0]?.installed).toBe(false)

    await expect(controller.install('qwen')).resolves.toBe(true)
    expect(
      controller.getSnapshot().models[0]?.installed,
      'a swallowed refresh failure left a downloaded model reading Install',
    ).toBe(true)
    controller.dispose()
  })

  /* A cancellation is the reader's own doing. Reporting it as `degraded`
   * would put an error in front of someone who pressed Cancel. */
  it('returns quietly to where it was when the reader cancels', async () => {
    const controller = createController(
      plugin({
        installModel: async () => {
          throw cancelled()
        },
      }),
    )
    await expect(controller.install('qwen')).resolves.toBe(false)
    /* BACK TO WHAT IT WAS, not to `installed`. This test asserted `installed`
     * and was encoding a bug an audit caught: a reader cancelling their FIRST
     * download had nothing installed, and the row claimed otherwise. The
     * controller starts in `absent`, so that is where cancelling returns it. */
    expect(controller.getSnapshot().runtime.kind).toBe('absent')
    expect(controller.getSnapshot().installing).toBeNull()
    /* And quietly: a cancellation is not a failure the reader is shown. */
    expect(controller.getSnapshot().failure).toBeNull()
    controller.dispose()
  })

  it('returns to `installed` when that is where it was', async () => {
    const controller = createController(
      plugin({
        installModel: async () => {
          throw cancelled()
        },
      }),
    )
    await controller.refresh()
    expect(controller.getSnapshot().runtime.kind).toBe('installed')
    await controller.install('qwen')
    expect(controller.getSnapshot().runtime.kind).toBe('installed')
    controller.dispose()
  })

  /**
   * A REAL FAILURE RESOLVES FALSE AND SAYS WHY — IT DOES NOT REJECT.
   *
   * `ModelsPane` calls this as `void model.install(id)`, so a rejection is an
   * unhandled promise and a reader who is told nothing. The previous contract
   * rethrew, and the test asserted `rejects.toBeTruthy()` — which does not even
   * establish that the ORIGINAL failure came back, only that something did.
   * Both halves now go where every other failure on this controller goes.
   */
  it('reports a real install failure as degraded, resolves false, and says why', async () => {
    const events: { event: string; fields: Record<string, unknown> }[] = []
    const controller = createController(
      plugin({
        installModel: async () => {
          throw Object.assign(new Error('digest 9f3a… did not match'), { kind: 'digestMismatch' })
        },
      }),
      (event, fields) => void events.push({ event, fields }),
    )

    await expect(controller.install('qwen')).resolves.toBe(false)
    expect(controller.getSnapshot().runtime).toEqual({
      kind: 'degraded',
      detail: 'The download did not verify — nothing was changed',
    })
    /* THE READER IS TOLD. Before this the state changed and nothing on screen
       explained it, because the only channel was a rejection nobody caught. */
    expect(controller.getSnapshot().failure).toBe('The download did not verify — nothing was changed')
    expect(controller.getSnapshot().installing).toBeNull()

    /* And the maintainer's half names the cause, which the reader's does not. */
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('inference.install-failed')
    expect(events[0]?.fields.model).toBe('qwen')
    expect(events[0]?.fields.message).toBe('digest 9f3a… did not match')
    controller.dispose()
  })

  it('clears the last failure when the next download starts', async () => {
    let fail = true
    const controller = createController(
      plugin({
        installModel: async () => {
          if (fail) throw { kind: 'digestMismatch' }
        },
      }),
    )
    await controller.install('qwen')
    expect(controller.getSnapshot().failure).not.toBeNull()
    fail = false
    await controller.install('qwen')
    expect(controller.getSnapshot().failure, 'a stale failure outlived the retry that worked').toBeNull()
    controller.dispose()
  })

  it('refuses a second download while one is in flight, and says it refused', async () => {
    /* A gate the test opens, rather than a captured `resolve`: TypeScript
     * cannot see an assignment made inside the promise's executor, so the
     * captured-variable spelling narrows to `never` and will not compile. */
    const gate = deferred()
    /* Typed like the real command, so `mock.calls[0][1]` is the model id
       rather than an index into an empty tuple. */
    const installModel = vi.fn(async (_requestId: string, _model: string) => gate.promise)
    const controller = createController(plugin({ installModel }))

    const first = controller.install('qwen')
    /* FALSE, NOT `undefined`. A refusal used to be indistinguishable from a
       completed download to every caller. */
    await expect(controller.install('kokoro')).resolves.toBe(false)

    /* AND IT NEVER REACHED THE PLUGIN. Reading `installing` alone would pass a
       controller that started the second download and then relabelled it. */
    expect(installModel).toHaveBeenCalledTimes(1)
    expect(installModel.mock.calls[0]?.[1]).toBe('qwen')
    expect(controller.getSnapshot().installing).toBe('qwen')

    gate.open()
    await first
    controller.dispose()
  })

  /* A refresh landing mid-download must not stamp `installed` over a state
   * whose bytes are still arriving. */
  it('does not let a refresh overwrite a download in flight', async () => {
    const gate = deferred()
    const controller = createController(plugin({ installModel: async () => gate.promise }))
    const install = controller.install('qwen')
    await controller.refresh()
    expect(controller.getSnapshot().runtime.kind).toBe('installing')
    gate.open()
    await install
    controller.dispose()
  })

  /**
   * A DOWNLOAD OWNS THE RUNTIME SLOT, AND `ensureReady` RESPECTS IT.
   *
   * `refresh` already stepped around a download in flight; `ensureReady` did
   * not. So asking a question — or anything else that wants the daemon up —
   * while a model was downloading replaced `installing` with `starting` or
   * `ready`, which erased the byte counts and took the Cancel button off the
   * screen with them, until the next progress event happened to arrive.
   * `snapshot.installing` still said a download was running the whole time,
   * which is the contradiction that names the bug.
   */
  it('does not let ensureReady overwrite a download in flight', async () => {
    const gate = deferred()
    const start = vi.fn(async () => 13399)
    const controller = createController(
      plugin({
        start,
        status: async () => ({ state: 'ready', version: '11.7.0', port: 13399 }),
        installModel: async () => gate.promise,
      }),
    )
    const install = controller.install('qwen')
    /* Still asked and still answered — only the state write waits. */
    await expect(controller.ensureReady()).resolves.toBe(true)
    expect(start).toHaveBeenCalledTimes(1)
    expect(
      controller.getSnapshot().runtime.kind,
      'a readiness check erased the download the reader was watching',
    ).toBe('installing')
    expect(controller.getSnapshot().installing).toBe('qwen')

    gate.open()
    await install
    controller.dispose()
  })

  it('does not let a failed ensureReady overwrite a download in flight', async () => {
    const gate = deferred()
    const controller = createController(
      plugin({
        start: async () => {
          throw { kind: 'notReady' }
        },
        installModel: async () => gate.promise,
      }),
    )
    const install = controller.install('qwen')
    await expect(controller.ensureReady()).resolves.toBe(false)
    expect(controller.getSnapshot().runtime.kind).toBe('installing')
    gate.open()
    await install
    controller.dispose()
  })

  /**
   * OWNERSHIP IS RELEASED WHEN THE BACKEND CONFIRMS, NOT WHEN CANCEL IS
   * PRESSED.
   *
   * This used to clear `installing` synchronously inside `cancelInstall`, and
   * the fake here resolved `installModel` rather than rejecting it — so the
   * test asserted the race instead of the requirement. The real
   * `install::install` checks its cancel token and returns `Error::Cancelled`
   * (there is a Rust case pinning `err.kind() == "cancelled"`), so a cancelled
   * install DOES settle, and its settle is the only conclusive sign that Rust
   * has stopped writing the staging path derived from the model id.
   *
   * Releasing early let the next install start against that same path while
   * the first was still unwinding: two writers, one file.
   */
  it('cancels the request id it minted, and holds ownership until it settles', async () => {
    const cancel = vi.fn(async (_requestId: string) => {})
    const gate = deferred()
    const issued: string[] = []
    const controller = createController(
      plugin({
        cancel,
        installModel: async (requestId) => {
          issued.push(requestId)
          await gate.promise
          throw cancelled()
        },
      }),
    )
    const install = controller.install('qwen')
    await Promise.resolve()
    controller.cancelInstall()

    /* THE SAME ID, not merely "one call". A controller that cancelled some
       other request would satisfy a call count and leave the download running,
       which is exactly what the reader pressed the button to stop. */
    expect(issued).toHaveLength(1)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel.mock.calls[0]?.[0]).toBe(issued[0])

    /* STILL OWNED. Rust has been asked to stop and has not yet said it did. */
    expect(controller.getSnapshot().installing, 'ownership was released before the backend confirmed').toBe(
      'qwen',
    )

    gate.open()
    await install
    expect(controller.getSnapshot().installing).toBeNull()
    controller.dispose()
  })

  /* THE RACE ITSELF. A second install pressed while the first is unwinding
     must not reach the plugin — the staging path is derived from the model id
     and the first writer has not let go of it. */
  it('refuses a second install until the cancelled one has settled', async () => {
    const started: string[] = []
    const gate = deferred()
    const controller = createController(
      plugin({
        installModel: async (_id, model) => {
          started.push(model)
          await gate.promise
          throw cancelled()
        },
      }),
    )
    const install = controller.install('qwen')
    controller.cancelInstall()
    await expect(controller.install('kokoro')).resolves.toBe(false)
    expect(started, 'a second install started while the first was still unwinding').toEqual(['qwen'])

    gate.open()
    await install
    /* And once it has settled, the next one is allowed through. */
    await controller.install('kokoro')
    expect(started).toEqual(['qwen', 'kokoro'])
    controller.dispose()
  })

  it('cancelling nothing is a no-op', () => {
    const cancel = vi.fn(async () => {})
    const controller = createController(plugin({ cancel }))
    controller.cancelInstall()
    expect(cancel).not.toHaveBeenCalled()
  })

  /**
   * ⚠️ THIS TEST USED TO ASSERT THE BUG. It required `start` to be called once
   * and never again, which is exactly what made a crashed daemon
   * unrecoverable: every later question saw the cached `ready`, skipped the
   * start, and failed at the request instead. An audit caught it.
   *
   * `start` is idempotent and cheap when the daemon is up — the plugin
   * health-checks and returns the same port — so asking every time costs one
   * loopback round trip and buys a runtime that recovers by itself.
   *
   * One test rather than the two near-identical ones this replaces: they built
   * the same fake and asserted overlapping halves of the same property.
   */
  it('starts the daemon on every call, so a crashed one can come back', async () => {
    const start = vi.fn(async () => 13399)
    const controller = createController(
      plugin({ start, status: async () => ({ state: 'ready', version: '11.7.0', port: 13399 }) }),
    )
    await expect(controller.ensureReady()).resolves.toBe(true)
    expect(start).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().runtime).toEqual({ kind: 'ready', version: '11.7.0' })

    await expect(controller.ensureReady()).resolves.toBe(true)
    expect(start, 'a cached `ready` skipped the restart').toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().runtime).toEqual({ kind: 'ready', version: '11.7.0' })
    controller.dispose()
  })

  it('recovers when the daemon comes back after a failure', async () => {
    let alive = false
    const controller = createController(
      plugin({
        start: async () => {
          if (!alive) throw { kind: 'notReady' }
          return 13399
        },
        status: async (): Promise<RuntimeStatus> =>
          alive ? { state: 'ready', version: '11.7.0', port: 13399 } : { state: 'stopped' },
      }),
    )
    await expect(controller.ensureReady()).resolves.toBe(false)
    expect(controller.getSnapshot().runtime.kind).toBe('degraded')
    alive = true
    await expect(controller.ensureReady()).resolves.toBe(true)
    expect(controller.getSnapshot().runtime.kind).toBe('ready')
    controller.dispose()
  })

  /* The race an audit named: a refresh in flight when an install starts must
     not land with a stale answer and stamp over the download. */
  it('does not let an in-flight refresh overwrite an install that started after it', async () => {
    const statusGate = deferred()
    /* A SECOND GATE, so the install is a promise this test settles rather than
       a permanently pending one it abandons. The version that never resolved
       left unfinished asynchronous work behind, which is how a later change
       from resolve to reject becomes an unhandled rejection in a suite that
       still looks green. */
    const installGate = deferred()
    const controller = createController(
      plugin({
        status: async () => {
          await statusGate.promise
          return { state: 'stopped' }
        },
        installModel: async () => installGate.promise,
      }),
    )
    const refreshing = controller.refresh()
    const installing = controller.install('qwen')
    expect(controller.getSnapshot().runtime.kind).toBe('installing')

    statusGate.open()
    await refreshing
    expect(controller.getSnapshot().runtime.kind).toBe('installing')

    installGate.open()
    await expect(installing).resolves.toBe(true)
    controller.dispose()
  })

  it('reports degraded and false when the daemon will not start', async () => {
    const controller = createController(
      plugin({
        start: async () => {
          throw { kind: 'notReady' }
        },
      }),
    )
    await expect(controller.ensureReady()).resolves.toBe(false)
    expect(controller.getSnapshot().runtime.kind).toBe('degraded')
    controller.dispose()
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
    controller.dispose()
  })

  it('names no model when none is installed', async () => {
    const controller = createController(plugin())
    await controller.refresh()
    expect(controller.textModel()).toBeNull()
    controller.dispose()
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

    await expect(controller.uninstall(MODEL.id)).resolves.toBe(true)
    expect(removed).toEqual([MODEL.id])
    /* The re-read, not a local splice: the daemon is the authority on what is
       on disk, and a list edited here would diverge the moment a removal
       partly failed. */
    expect(controller.getSnapshot().models).toEqual([])
    controller.dispose()
  })

  /**
   * A FAILED REMOVAL SAYS SO.
   *
   * `ModelsPane` calls this as `void model.uninstall(id)`, so the rejection
   * this used to produce was an unhandled promise: the reader pressed Remove,
   * the model stayed, and nothing anywhere said why.
   */
  it('resolves false and explains itself when the removal fails', async () => {
    const events: string[] = []
    const controller = createController(
      plugin({
        removeModel: async () => {
          throw Object.assign(new Error('EBUSY'), { kind: 'notRunning' })
        },
      }),
      (event) => void events.push(event),
    )
    await controller.refresh()

    await expect(controller.uninstall(MODEL.id)).resolves.toBe(false)
    expect(controller.getSnapshot().failure).toBe('The runtime is not running')
    expect(events).toEqual(['inference.remove-failed'])
    controller.dispose()
  })

  /**
   * AND A SWALLOWED REFRESH FAILURE DOES NOT LEAVE A GHOST.
   *
   * The removal succeeded, so the row must stop saying Installed whatever the
   * confirming read does. `refresh` absorbs its own failure by design, so
   * without applying the confirmed result locally the reader was left with a
   * Remove button for a model that was already gone.
   */
  it('marks the model removed even when the confirming refresh fails', async () => {
    let removed = false
    const controller = createController(
      plugin({
        models: async () => {
          if (removed) throw { kind: 'runtimeUnreachable' }
          return [{ ...MODEL, installed: true }]
        },
        removeModel: async () => void (removed = true),
      }),
    )
    await controller.refresh()
    expect(controller.getSnapshot().models[0]?.installed).toBe(true)

    await expect(controller.uninstall(MODEL.id)).resolves.toBe(true)
    expect(
      controller.getSnapshot().models[0]?.installed,
      'a deleted model was still listed as installed',
    ).toBe(false)
    controller.dispose()
  })
})

/**
 * A DEGRADED RUNTIME IS NOT SILENT.
 *
 * `refresh` swallows its error by design — a capability must not fail to start
 * over IPC — and the diagnostic that was supposed to record it lived on a
 * `.catch` of a promise that never rejects. So the one failure that mattered,
 * every command invoked without its plugin prefix, produced "Something went
 * wrong" on screen and nothing whatsoever in the log.
 */
describe('reporting a failed refresh', () => {
  it('reports the reader sentence and the maintainer message, which differ', async () => {
    const seen: { event: string; fields: Record<string, unknown> }[] = []
    const controller = createController(
      plugin({
        status: async () => {
          throw new Error('Command inference_status not found')
        },
      }),
      (event, fields) => void seen.push({ event, fields }),
    )
    await controller.refresh()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.event).toBe('inference.refresh-failed')
    /* The reader's half: `detailFor`'s default, because a bare string carries
       no `kind`. The maintainer's half is the sentence that names the cause. */
    expect(seen[0]?.fields.detail).toBe('Something went wrong')
    expect(seen[0]?.fields.message).toBe('Command inference_status not found')
    expect(controller.getSnapshot().runtime).toEqual({ kind: 'degraded', detail: 'Something went wrong' })
    controller.dispose()
  })

  /**
   * AND IT REPORTS DURING A DOWNLOAD TOO.
   *
   * The suppression that keeps a refresh from stamping over a download in
   * flight used to wrap the diagnostic as well, so every refresh failure that
   * happened while a model was downloading was discarded entirely. Withholding
   * the STATE write is the requirement; withholding the record is how a
   * degraded runtime goes back to being silent.
   */
  it('reports a refresh failure that happens during a download', async () => {
    const seen: string[] = []
    const gate = deferred()
    const controller = createController(
      plugin({
        status: async () => {
          throw new Error('Command inference_status not found')
        },
        installModel: async () => gate.promise,
      }),
      (event) => void seen.push(event),
    )
    const install = controller.install('qwen')
    await controller.refresh()

    expect(seen, 'a refresh failure during a download was discarded, diagnostic and all').toEqual([
      'inference.refresh-failed',
    ])
    /* And the download is still the state the reader sees. */
    expect(controller.getSnapshot().runtime.kind).toBe('installing')

    gate.open()
    await install
    controller.dispose()
  })

  it('says nothing on a refresh that works', async () => {
    const seen: string[] = []
    const controller = createController(plugin(), (event) => void seen.push(event))
    await controller.refresh()
    expect(seen).toEqual([])
    controller.dispose()
  })

  /* The hook is optional, because the fakes in every other suite here pass no
     reporter and must not have to. */
  it('does not require a reporter', async () => {
    const controller = createController(
      plugin({
        status: async () => {
          throw new Error('boom')
        },
      }),
    )
    await expect(controller.refresh()).resolves.toBeUndefined()
    controller.dispose()
  })
})
