import { describe, expect, it, vi } from 'vitest'
import {
  createController,
  detailFor,
  glossModel,
  readerFailure,
  type ControllerPlugin,
  type InferenceSnapshot,
} from './controller'
import type { InstallProgress, ModelRow, RuntimeStatus } from './plugin'

const MODEL: ModelRow = {
  id: 'qwen',
  label: 'Qwen3-4B',
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

  /* ⚠️ **THE GLOSS'S OWN, AND IT USED NOT TO EXIST AS A KIND AT ALL.**
   * `generate::stream` decoded `finish_reason` and dropped it, so a definition
   * cut off at `MAX_GLOSS_TOKENS` came back as a finished one and was drawn in
   * amber. `inference_gloss` refuses it now, and a refusal that landed on the
   * default would tell the reader "Something went wrong" about a model that had
   * simply been asked for less than it wanted to say. */
  it('has a sentence for an answer the model was cut off in', () => {
    expect(detailFor({ kind: 'answerTruncated' })).toBe('The answer was cut off before it finished')
  })

  /* ── A CLOUD ENDPOINT, which Paper talks to itself since the gloss routes
   * contract. Two sentences for two different things to do: an endpoint that
   * answered "no" wants its key or its model name looked at; one that never
   * answered wants its address or the network looked at. One sentence for both
   * would leave the reader guessing which. */
  it('tells an endpoint that refused apart from one that could not be reached', () => {
    expect(detailFor({ kind: 'endpointHttp' })).toBe('That endpoint refused the request')
    expect(detailFor({ kind: 'endpointUnreachable' })).toBe('That endpoint could not be reached')
  })

  /* EVERY OTHER KIND, BY ITS OWN SENTENCE. A `case` that goes missing falls
     through to the sentence beneath it — `runtimeUnreachable` would read "not
     running", `runtimeMalformed` "cut off" — and a test that names only some of
     the kinds cannot see which one moved. */
  it('has its own sentence for every other kind the plugin raises', () => {
    const sentences = {
      runtimeExited: 'The runtime stopped',
      digestMismatch: 'The download did not verify — nothing was changed',
      sizeMismatch: 'The download did not verify — nothing was changed',
      runtimeUnreachable: 'The runtime is not answering',
      notRunning: 'The runtime is not running',
      noModelInstalled: 'No language model is installed yet',
      modelUnknown: 'That model is not available',
      requestBusy: 'That request is already running',
      fieldTooLarge: 'That request was too large',
      runtimeHttp: 'The runtime refused the request',
      runtimeMalformed: 'The runtime’s answer could not be read',
      cancelled: 'The runtime stopped before it answered',
    }
    expect(Object.fromEntries(Object.keys(sentences).map((kind) => [kind, detailFor({ kind })]))).toEqual(sentences)
    /* And a kind no `case` names is still the default, an empty one included. */
    expect(detailFor({ kind: '' })).toBe('Something went wrong')
  })
})

/**
 * THE FOUR BRANCHES BOTH READERS' FAILURES GO THROUGH — the gloss and the
 * companion — so each is held here by what it hands back, not only through the
 * callers that happen to reach it.
 */
describe('readerFailure', () => {
  const live = new AbortController().signal
  const aborted = AbortSignal.abort()

  it('passes the reader’s own abort through as itself', () => {
    const cause = { kind: 'cancelled', message: 'cancelled' }
    expect(readerFailure(cause, aborted)).toBe(cause)
  })

  /* `signal` DECIDES ONE BRANCH AND ONLY ONE. A daemon that cancelled on stop is
     not the reader's abort, and neither is any other kind that happens to land
     after the reader moved on. */
  it('translates every other plugin failure into the reader’s sentence, keeping the cause', () => {
    const daemonCancelled = { kind: 'cancelled', message: 'the daemon stopped' }
    const notReady = { kind: 'notReady', message: 'port 13399 refused' }
    for (const [cause, signal, sentence] of [
      [daemonCancelled, live, 'The runtime stopped before it answered'],
      [notReady, aborted, 'The runtime did not start'],
    ] as const) {
      const raised = readerFailure(cause, signal)
      expect(raised).toBeInstanceOf(Error)
      expect((raised as Error).message).toBe(sentence)
      expect((raised as Error).cause, 'the plugin’s own failure was dropped from the chain').toBe(cause)
    }
  })

  it('passes an Error that is not the plugin’s through untouched', () => {
    const cause = new Error('Command inference_gloss not found')
    expect(readerFailure(cause, live)).toBe(cause)
  })

  it('makes a bare rejection readable, keeping it as the cause', () => {
    const cause = 'Command inference_gloss not found'
    const raised = readerFailure(cause, live)
    expect(raised).toBeInstanceOf(Error)
    expect((raised as Error).message).toBe('Command inference_gloss not found')
    expect((raised as Error).cause).toBe(cause)
  })
})

/**
 * ⚠️ **WHICH MODEL DEFINES THE READER'S WORDS USED TO BE ARRAY ORDER.**
 *
 * `snapshot.models.find(…)` answered with whichever row `models.manifest.json`
 * happened to leave first — deterministic by accident, and silently different
 * after a reorder that had nothing to do with the gloss. The cache is keyed on
 * the model, so such a reorder would also have dropped every remembered
 * definition with nothing anywhere saying why.
 */
/**
 * The two contracts an audit found unenforced.
 */
describe('what a badly-behaved subscriber cannot do', () => {
  /* ⚠️ **`install` AND `uninstall` PROMISE TO RESOLVE, IN CAPITALS**, because
     their only callers are `void model.install(id)` in the pane — a rejection
     there is an unhandled promise and a reader told nothing. Both call `set`
     BEFORE their `try`, so a throwing listener rejected them, left the install
     slot owned and stuck the state on "installing" with nothing able to clear
     it. */
  it('cannot make install reject', async () => {
    const controller = createController(plugin())
    controller.subscribe(() => {
      throw new Error('a subscriber that throws')
    })

    await expect(controller.install('qwen')).resolves.toBe(true)
  })

  it('cannot make uninstall reject', async () => {
    const controller = createController(plugin())
    controller.subscribe(() => {
      throw new Error('a subscriber that throws')
    })

    await expect(controller.uninstall('qwen')).resolves.toBe(true)
  })

  /* AND EVERY OTHER SUBSCRIBER IS STILL TOLD. A throw used to abandon the loop,
     so half the listeners saw an update and half did not — which is worse than
     either all or none, because it is invisible. */
  it('does not stop the subscribers after it from being told', async () => {
    const controller = createController(plugin())
    const thrown = new Error('a subscriber that throws')
    let told = 0
    controller.subscribe(() => {
      throw thrown
    })
    controller.subscribe(() => {
      told += 1
    })

    /* AND THE THROW IS WRITTEN DOWN, NOT SWALLOWED WHOLE. An empty catch passes
       the count below and leaves a broken pane with no trace anywhere. */
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await controller.refresh()
      expect(logged.mock.calls).toEqual([['inference controller: a subscriber threw while being notified', thrown]])
    } finally {
      logged.mockRestore()
    }

    expect(told).toBeGreaterThan(0)
  })
})

describe('glossModel', () => {
  const row = (over: Partial<ModelRow> & { id: string }): ModelRow => ({
    ...MODEL,
    installed: true,
    ...over,
  })

  it('has nothing to answer with when nothing is installed', () => {
    expect(glossModel([])).toBeNull()
    expect(glossModel([row({ id: 'a', installed: false })])).toBeNull()
  })

  /* SMALLEST FIRST, for the feature's own reason: a gloss is wanted in
     milliseconds, and bytes are the best proxy this layer has for both the
     first load and every generation after it. */
  it('takes the smallest installed text model', () => {
    expect(
      glossModel([row({ id: 'big', bytes: 9_000 }), row({ id: 'small', bytes: 1_000 })]),
    ).toBe('small')
  })

  /* ⚠️ THE CASE THE OLD CODE GOT WRONG. Same rows, reversed: `.find()` answered
     `big` for one order and `small` for the other. */
  it('answers the same whatever order the manifest lists them in', () => {
    const big = row({ id: 'big', bytes: 9_000 })
    const small = row({ id: 'small', bytes: 1_000 })
    expect(glossModel([big, small])).toBe(glossModel([small, big]))
  })

  /* A TOTAL ORDER, so two models of identical size do not put the array back in
     charge of the answer. */
  it('breaks a tie by id rather than by position', () => {
    const a = row({ id: 'aaa', bytes: 1_000 })
    const b = row({ id: 'bbb', bytes: 1_000 })
    expect(glossModel([b, a])).toBe('aaa')
    expect(glossModel([a, b])).toBe('aaa')
  })

  /* SIZE DECIDES BEFORE THE ID DOES, and the tie is only among the smallest: the
     lowest id of all belongs to the largest model here, and the one listed first
     is neither. Every order answers the same. */
  it('breaks a tie by id only among the smallest, in any order', () => {
    const large = row({ id: 'aaa', bytes: 9_000 })
    const small = row({ id: 'zzz', bytes: 1_000 })
    const alsoSmall = row({ id: 'mmm', bytes: 1_000 })
    for (const order of [
      [large, small, alsoSmall],
      [alsoSmall, small, large],
      [small, large, alsoSmall],
      [small, alsoSmall, large],
    ]) {
      expect(glossModel(order), order.map((one) => one.id).join(',')).toBe('mmm')
    }
  })

  /* An uninstalled row is not a candidate however small — the gloss cannot run
     artifacts that are not on disk, and `resolve_model` refuses it anyway. */
  it('ignores a smaller model that is not installed', () => {
    expect(
      glossModel([
        row({ id: 'tiny', bytes: 10, installed: false }),
        row({ id: 'real', bytes: 1_000 }),
      ]),
    ).toBe('real')
  })

  /* IT DOES NOT REORDER THE CALLER'S ARRAY. `snapshot.models` is handed to the
     pane by reference, and a sort here would shuffle the Local models list
     under the reader as a side effect of a lookup. */
  it('leaves the array it was given alone', () => {
    const models = [row({ id: 'big', bytes: 9_000 }), row({ id: 'small', bytes: 1_000 })]
    glossModel(models)
    expect(models.map((m) => m.id)).toEqual(['big', 'small'])
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
    /* The whole of it: nothing listed, nothing moving, nothing failed. */
    expect(controller.getSnapshot()).toEqual({
      runtime: { kind: 'absent', reason: 'Not installed' },
      models: [],
      installing: null,
      removing: null,
      failure: null,
    })
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

  /* ONLY THE TWO KINDS THAT DESCRIBE WORK IN PROGRESS MOVE THE ROW. The third,
     `installed`, says nothing the command's own settle does not, and the settle
     is what decides the runtime — it must not be drawn as a verification. */
  it('draws nothing new for the progress event that says the bytes are in', async () => {
    const seen: InferenceSnapshot['runtime'][] = []
    const controller = createController(
      plugin({
        installModel: async (_id, _model, onProgress: (p: InstallProgress) => void) => {
          onProgress({ kind: 'downloading', received: 1, total: 2 })
          onProgress({ kind: 'installed' })
          seen.push(controller.getSnapshot().runtime)
        },
      }),
    )
    await controller.install('qwen')
    expect(seen).toEqual([{ kind: 'installing', model: 'qwen', received: 1, total: 2 }])
    controller.dispose()
  })

  /* OWNERSHIP ON THE PROGRESS PATH TOO. A progress callback can outlive the
     download that registered it, and by then the slot may belong to the one
     that replaced it — whose row must keep its own model and counts. */
  it('ignores progress from a download that no longer owns the slot', async () => {
    const told: ((progress: InstallProgress) => void)[] = []
    const gates = [deferred(), deferred()]
    const controller = createController(
      plugin({
        installModel: async (_id, _model, onProgress: (p: InstallProgress) => void) => {
          const mine = told.push(onProgress) - 1
          await gates[mine]!.promise
          if (mine === 0) throw cancelled()
        },
      }),
    )
    const first = controller.install('qwen')
    controller.cancelInstall()
    gates[0]!.open()
    await expect(first).resolves.toBe(false)
    const second = controller.install('gemma')

    told[0]!({ kind: 'downloading', received: 7, total: 9 })
    told[0]!({ kind: 'verifying' })
    expect(controller.getSnapshot().runtime, 'a replaced download wrote over the one that replaced it').toEqual({
      kind: 'installing',
      model: 'gemma',
      received: 0,
      total: 0,
    })

    gates[1]!.open()
    await second
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

  /* ONE ROW, NOT THE CATALOGUE. The correction is keyed on the model the
     command named; every other row keeps what the last read said. */
  it('corrects only the row it installed or removed when the confirming refresh fails', async () => {
    const OTHER: ModelRow = { ...MODEL, id: 'gemma' }
    const rows = (controller: ReturnType<typeof createController>) =>
      controller.getSnapshot().models.map((row) => [row.id, row.installed])
    const withCatalogue = (listed: readonly ModelRow[]) => {
      let changed = false
      return createController(
        plugin({
          installModel: async () => void (changed = true),
          removeModel: async () => void (changed = true),
          models: async () => {
            if (changed) throw { kind: 'runtimeUnreachable' }
            return listed
          },
        }),
      )
    }

    const installing = withCatalogue([MODEL, OTHER])
    await installing.refresh()
    await expect(installing.install('qwen')).resolves.toBe(true)
    expect(rows(installing), 'the install marked a model it never touched').toEqual([['qwen', true], ['gemma', false]])
    installing.dispose()

    const removing = withCatalogue([{ ...MODEL, installed: true }, { ...OTHER, installed: true }])
    await removing.refresh()
    await expect(removing.uninstall('qwen')).resolves.toBe(true)
    expect(rows(removing), 'the removal unmarked a model it never touched').toEqual([['qwen', false], ['gemma', true]])
    removing.dispose()
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
  it('reports a real install failure as the operation’s, resolves false, and says why', async () => {
    const events: { event: string; fields: Record<string, unknown> }[] = []
    const controller = createController(
      plugin({
        installModel: async () => {
          throw Object.assign(new Error('digest 9f3a… did not match'), { kind: 'digestMismatch' })
        },
      }),
      (event, fields) => void events.push({ event, fields }),
    )

    const runtimeBefore = controller.getSnapshot().runtime
    await expect(controller.install('qwen')).resolves.toBe(false)
    /* THE RUNTIME IS NOT THE THING THAT FAILED. This used to stamp `degraded`
       on the runtime for a download whose bytes did not verify — the daemon
       was fine, and the pane said it was not (audit-fix #289). `failure` is
       the operation's field; the runtime stays what it was. */
    expect(controller.getSnapshot().runtime).toEqual(runtimeBefore)
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
    await expect(controller.install('gemma')).resolves.toBe(false)

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

  /* THE RUNTIME IS WITHHELD, NOT THE CATALOGUE. Only the runtime field belongs
     to the download; the model list a mid-download refresh read is still the
     current one. */
  it('still brings the catalogue up to date when a refresh lands mid-download', async () => {
    const gate = deferred()
    let listed: readonly ModelRow[] = [MODEL]
    const controller = createController(plugin({ models: async () => listed, installModel: async () => gate.promise }))
    const install = controller.install('qwen')
    listed = [MODEL, { ...MODEL, id: 'gemma' }]
    await controller.refresh()
    expect(controller.getSnapshot().models.map((row) => row.id), 'a download froze the catalogue').toEqual([
      'qwen',
      'gemma',
    ])
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
    expect(issued[0], 'the id does not say what kind of request it is').toMatch(/^install-/)
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
    await expect(controller.install('gemma')).resolves.toBe(false)
    expect(started, 'a second install started while the first was still unwinding').toEqual(['qwen'])

    gate.open()
    await install
    /* And once it has settled, the next one is allowed through. */
    await controller.install('gemma')
    expect(started).toEqual(['qwen', 'gemma'])
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

  /* `starting` IS SHOWN FOR A LAUNCH, NOT FOR A HEALTH CHECK. `start` runs before
     every question, so a daemon already up must not flash "starting" on the
     row each time one is asked. */
  it('shows starting while a launch is out, and never over a runtime that is already ready', async () => {
    const gates = [deferred(), deferred()]
    let launches = 0
    const controller = createController(
      plugin({
        start: async () => {
          await gates[launches++]!.promise
          return 13399
        },
        status: async () => ({ state: 'ready', version: '11.7.0', port: 13399 }),
      }),
    )
    const first = controller.start()
    expect(controller.getSnapshot().runtime, 'a launch from nothing did not say it was starting').toEqual({
      kind: 'starting',
    })
    gates[0]!.open()
    await first
    expect(controller.getSnapshot().runtime).toEqual({ kind: 'ready', version: '11.7.0' })

    const second = controller.start()
    expect(controller.getSnapshot().runtime, 'a ready runtime was shown starting again').toEqual({
      kind: 'ready',
      version: '11.7.0',
    })
    gates[1]!.open()
    await second
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

  it('names an installed model and ignores an uninstalled one', async () => {
    const controller = createController(
      plugin({
        models: async () => [
          { ...MODEL, installed: false },
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
    const before = controller.getSnapshot()
    controller.dispose()
    await controller.refresh()
    expect(listener).not.toHaveBeenCalled()
    /* NOR WRITING. Silence alone would pass a controller that went on changing
       state nobody is told about, for whoever reads it next. */
    expect(controller.getSnapshot(), 'a disposed controller kept what a late refresh read').toBe(before)
  })

  it('stops telling a subscriber that unsubscribed, and only that one', async () => {
    const controller = createController(plugin())
    const gone = vi.fn()
    const kept = vi.fn()
    const unsubscribe = controller.subscribe(gone)
    controller.subscribe(kept)
    unsubscribe()
    await controller.refresh()
    expect(gone).not.toHaveBeenCalled()
    expect(kept, 'nobody was told at all, so this measures nothing').toHaveBeenCalled()
    controller.dispose()
  })

  /* A DOWNLOAD THAT FAILS AFTER ITS CONTROLLER IS GONE BELONGS TO NOBODY. It
     did not end up installed for anyone, so it resolves false, and `dispose`
     had already abandoned it, so no `install-failed` line is written for it. */
  it('resolves false and reports nothing for a download that fails after dispose', async () => {
    const gate = deferred()
    const events: string[] = []
    const controller = createController(
      plugin({
        installModel: async () => {
          await gate.promise
          throw Object.assign(new Error('digest 9f3a… did not match'), { kind: 'digestMismatch' })
        },
      }),
      (event) => void events.push(event),
    )
    const installing = controller.install('qwen')
    controller.dispose()
    gate.open()
    await expect(installing).resolves.toBe(false)
    expect(events, 'an abandoned download reported a failure').toEqual([])
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
    const fields: Record<string, unknown>[] = []
    const controller = createController(
      plugin({
        removeModel: async () => {
          throw Object.assign(new Error('EBUSY'), { kind: 'notRunning' })
        },
      }),
      (event, said) => {
        events.push(event)
        fields.push(said)
      },
    )
    await controller.refresh()

    await expect(controller.uninstall(MODEL.id)).resolves.toBe(false)
    expect(controller.getSnapshot().failure).toBe('The runtime is not running')
    expect(events).toEqual(['inference.remove-failed'])
    /* Which model, and both halves: the reader's sentence alone finds nothing. */
    expect(fields).toEqual([{ model: MODEL.id, detail: 'The runtime is not running', message: 'EBUSY' }])
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
    /* AND ITS ABSENCE IS NOT A FAULT. Calling a reporter that was never given
       would throw into the guard, which would then log "the failure reporter
       itself threw" for every failure of a controller that simply has none. */
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(controller.refresh()).resolves.toBeUndefined()
      expect(logged).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
    controller.dispose()
  })
})

describe('audit-fix round 1 — the controller', () => {
  const ready: RuntimeStatus = { state: 'ready', port: 1, model: null } as unknown as RuntimeStatus
  it('an older ensureReady that lands last does not overwrite the newer answer', async () => {
    let answers: Array<(status: RuntimeStatus) => void> = []
    const controller = createController(
      plugin({
        start: async () => 1,
        status: () => new Promise<RuntimeStatus>((resolve) => void answers.push(resolve)),
      }),
    )
    const first = controller.ensureReady()
    const second = controller.ensureReady()
    // Both have passed `start()` and are waiting on `status()` once the
    // microtasks drain; the SECOND asked last and answers first, ready; the
    // first then answers stopped.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(answers).toHaveLength(2)
    answers[1]!(ready)
    await second
    answers[0]!({ state: 'stopped' } as unknown as RuntimeStatus)
    await first
    expect(controller.getSnapshot().runtime.kind).toBe('ready')
  })

  it('a finished install leaves the runtime as it was, and a failed one blames the operation', async () => {
    const controller = createController(plugin({ installModel: async () => {} }))
    await controller.refresh()
    const before = controller.getSnapshot().runtime
    await controller.install('qwen')
    expect(controller.getSnapshot().runtime).toEqual(before)
    const failing = createController(
      plugin({
        installModel: async () => {
          throw { kind: 'digestMismatch', message: 'bad bytes' }
        },
      }),
    )
    await failing.refresh()
    const was = failing.getSnapshot().runtime
    await failing.install('qwen')
    expect(failing.getSnapshot().failure).toMatch(/nothing was changed/)
    expect(failing.getSnapshot().runtime).toEqual(was)
  })

  it('one removal at a time: a second Remove while the first runs is refused, not sent', async () => {
    let finish!: () => void
    let removals = 0
    const controller = createController(
      plugin({
        removeModel: () =>
          new Promise<void>((resolve) => {
            removals += 1
            finish = resolve
          }),
      }),
    )
    const first = controller.uninstall('qwen')
    expect(controller.getSnapshot().removing).toBe('qwen')
    expect(await controller.uninstall('qwen')).toBe(false)
    expect(removals).toBe(1)
    finish()
    await first
    expect(controller.getSnapshot().removing).toBeNull()
  })

  it('a reporter that throws does not turn an absorbed failure into a rejection', async () => {
    const broken = new Error('the reporter is broken')
    const controller = createController(
      plugin({
        status: async () => {
          throw new Error('daemon gone')
        },
      }),
      () => {
        throw broken
      },
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(controller.refresh()).resolves.toBeUndefined()
      /* ABSORBED, NOT LOST: the reporter's own failure is written where it can
         still be read, with the event it was carrying when it threw. */
      expect(logged.mock.calls).toEqual([
        ['inference controller: the failure reporter itself threw', broken, 'while reporting', 'inference.refresh-failed'],
      ])
    } finally {
      logged.mockRestore()
    }
  })
})

/**
 * ⚠️ **A START THAT FAILED KNEW WHY AND TOLD NOBODY.**
 *
 * `ensureReady` turned every failure into `false` and reported nothing, so the
 * one place holding the cause threw it away: the reader was told "The runtime
 * is not running" by `glossProvider`'s fallback while this controller had just
 * computed "The runtime is not installed", and no diagnostic recorded either.
 * `start` is the same launch with the cause kept; `ensureReady` is `start`
 * collapsed, for the callers whose contract is a boolean (2026-09-13 audit,
 * round 2).
 */
describe('audit-fix round 2 — a start that failed says why', () => {
  const refusal = { kind: 'runtimeMissing', message: 'the inference runtime is not installed at /x' }

  it('rejects with the plugin’s own failure, so a caller can translate it', async () => {
    const controller = createController(
      plugin({
        start: async () => {
          throw refusal
        },
      }),
    )
    const cause = await controller.start().then(() => null, (thrown: unknown) => thrown)
    expect(cause, 'the cause was replaced, so nothing downstream can name it').toBe(refusal)
    expect(detailFor(cause)).toBe('The runtime is not installed')
    controller.dispose()
  })

  /* BOTH HALVES, as `refresh` already reported them: `detail` is the reader's
     sentence and `message` is the crate's, and they are deliberately different
     — reporting only the first would have said "Something went wrong" to the
     log as well. */
  it('writes one diagnostic carrying the reader’s sentence and the crate’s', async () => {
    const events: { event: string; fields: Record<string, unknown> }[] = []
    const controller = createController(
      plugin({
        start: async () => {
          throw refusal
        },
      }),
      (event, fields) => void events.push({ event, fields }),
    )
    await controller.start().catch(() => {})
    expect(events).toEqual([
      {
        event: 'inference.start-failed',
        fields: { detail: 'The runtime is not installed', message: refusal.message },
      },
    ])
    expect(controller.getSnapshot().runtime).toEqual({
      kind: 'degraded',
      detail: 'The runtime is not installed',
    })
    controller.dispose()
  })

  /* AND `ensureReady` KEEPS ITS OWN CONTRACT. It answers false rather than
     rejecting, because its callers are `const ready = await …` with no catch
     — the port's `ensureReady` promises "false when it could not". */
  it('leaves ensureReady answering false rather than rejecting', async () => {
    const controller = createController(
      plugin({
        start: async () => {
          throw refusal
        },
      }),
    )
    await expect(controller.ensureReady()).resolves.toBe(false)
    controller.dispose()
  })

  /**
   * A DAEMON THAT CAME UP AND IS STILL NOT READY IS NOT AN EXCEPTION, and the
   * state must stay the status's own rather than becoming `degraded`: what the
   * reader can do about an absent runtime is install one, and `degraded` tells
   * them to restart something they do not have.
   */
  it('refuses by the status when the launch itself did not fail, and keeps the status’s state', async () => {
    const events: { event: string; fields: Record<string, unknown> }[] = []
    const controller = createController(
      plugin({ start: async () => 13399, status: async () => ({ state: 'absent', reason: 'not staged' }) }),
      (event, fields) => void events.push({ event, fields }),
    )
    const cause = await controller.start().then(() => null, (thrown: unknown) => thrown)
    expect(detailFor(cause), 'an absent runtime was reported as one that did not start').toBe(
      'The runtime is not installed',
    )
    expect(controller.getSnapshot().runtime).toEqual({ kind: 'absent', reason: 'not staged' })
    /* Reported as a launch that threw is: both halves, the status's reason as the maintainer's. */
    expect(events).toEqual([
      { event: 'inference.start-failed', fields: { detail: 'The runtime is not installed', message: 'not staged' } },
    ])
    controller.dispose()
  })

  /**
   * ⚠️ **AND THE SAME SHAPE ONE FIELD ALONG: A DISPOSED CONTROLLER LEFT ITS
   * DOWNLOAD RUNNING.**
   *
   * `dispose` cleared the install slot and told nobody, so the request it had
   * minted went on downloading in Rust for a controller that no longer exists —
   * no pane counting the bytes, no Cancel to press, and a staging path a
   * re-composed capability could start writing to as well. `inferencePort`'s
   * teardown now cancels every request it has out; this was the last minting
   * site that did not (2026-09-13 audit, round 2).
   */
  it('cancels a download it still had out when it is disposed', async () => {
    const gate = deferred()
    const cancel = vi.fn(async (_requestId: string) => {})
    const issued: string[] = []
    const controller = createController(
      plugin({
        cancel,
        installModel: async (requestId) => {
          issued.push(requestId)
          await gate.promise
        },
      }),
    )
    const installing = controller.install('qwen')
    expect(issued, 'no download went out, so this measures nothing').toHaveLength(1)

    controller.dispose()
    expect(cancel.mock.calls, 'a download outlived the controller that started it').toEqual([[issued[0]]])

    gate.open()
    await expect(installing).resolves.toBe(false)
  })

  it('says the runtime is not running when it is installed and stopped', async () => {
    const controller = createController(plugin({ start: async () => 13399, status: async () => ({ state: 'stopped' }) }))
    const cause = await controller.start().then(() => null, (thrown: unknown) => thrown)
    expect(detailFor(cause)).toBe('The runtime is not running')
    expect(cause, 'the maintainer’s half does not say what the status was').toEqual({
      kind: 'notRunning',
      message: 'the runtime is stopped after a start that did not fail',
    })
    expect(controller.getSnapshot().runtime).toEqual({ kind: 'installed' })
    controller.dispose()
  })
})
