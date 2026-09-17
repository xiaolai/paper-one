import { describe, expect, it, vi } from 'vitest'
import {
  NOOP_DIAGNOSTICS,
  UNFINISHED_PANE_IDS,
  createKernelServices,
  scopeSettings,
  type Disposable,
  type GlossContext,
} from '../../kernel'
import { refusalOf } from '../../kernel/testkit'
import { MODELS_SECTION, detailFor, inference, inferencePort } from './index'
import { inferencePlugin, type InstallProgress } from './lib/plugin'
import type { EndpointsModel } from './ui/endpointsModel'
import type { ModelsModel } from './ui/modelsModel'

/**
 * ⚠️ THE `inferenceDownloadLine()` CASE THAT WAS HERE TESTED A DEAD EXPORT.
 *
 * The status bar reads the bound work-line service, not that function, and had
 * done for some time — its own comment still said `App` read it. So the only
 * caller of the export was this test, which is the shape a second
 * implementation takes while it is quietly diverging from the live one. Both
 * are gone; the work-line binding in `start` is the single implementation, and
 * `modelsModel.test.ts` covers `downloadLine` itself.
 */

/**
 * TEARDOWN ACTUALLY TEARS DOWN.
 *
 * `stop()` disposed the controller and left the models model attached: only
 * the tests ever called `ModelsModel.dispose`, so in the running app an
 * `Audio` element, a blob URL and any voice request in flight survived every
 * restart of the capability and accumulated. A leak whose individual instances
 * are all small is one that nothing notices until there are hundreds of them.
 *
 * ⚠️ **THE OBSERVABLE USED TO BE A SETTINGS SUBSCRIPTION, AND THE MODEL NEVER
 * READ A SETTING.** Counting subscribers on a store nothing consults measured
 * the model's constructor and not its teardown, and it kept a required
 * dependency alive for the sake of the measurement. The model itself is
 * reachable — the contributed section renders it as a prop — so what the
 * teardown is asked for now is the thing that actually stops: a disposed model
 * tells its listeners nothing, whatever it is asked to refresh.
 */
describe('starting and stopping the capability', () => {
  /**
   * One composition: its own kernel services, its own settings handle.
   *
   * A SEPARATE `KernelServices` PER COMPOSITION, because the ports are
   * exclusive by design — two starts against one kernel collide on
   * `bindGloss`, which is the kernel refusing correctly. What two live
   * compositions genuinely share is the MODULE scope this capability keeps its
   * render slot in, and that is what this exercises.
   */
  const started = (
    services = createKernelServices({ fs: null, storage: null, initialBooks: [] }),
    diagnostics = NOOP_DIAGNOSTICS,
  ) => {
    const controller = new AbortController()
    const handle = inference.start?.(
      {
        services,
        settings: scopeSettings(services.settings, 'inference'),
        diagnostics,
        onCleanup: () => {},
      },
      controller.signal,
    )
    if (handle === undefined || handle instanceof Promise) throw new Error('start returned no synchronous handle')
    return handle
  }

  /** Diagnostics that remember what they were told, in order. */
  const recording = () => {
    const lines: (readonly [string, string, Record<string, unknown> | undefined])[] = []
    const diagnostics: typeof NOOP_DIAGNOSTICS = {
      child: () => diagnostics,
      info: (event, fields) => void lines.push(['info', event, fields]),
      warn: (event, fields) => void lines.push(['warn', event, fields]),
      error: (event, fields) => void lines.push(['error', event, fields]),
    }
    return { lines, diagnostics }
  }

  /**
   * ⚠️ THE FOUR ENDPOINT COMMANDS HAD NO CALLER ANYWHERE UNDER `src/`.
   *
   * Everything under them was built and tested — the endpoint file, the key in
   * the OS keychain, the provisioning into the daemon's environment at spawn,
   * the per-start registration, the probe route and `resolve_model`'s
   * acceptance of it — and a reader could not add one, so none of it could ever
   * run in the app. The feature ledger called it Shipped. An audit found the
   * commands with nothing invoking them.
   *
   * This is what says the section exists and is wired: a contributed pane draws
   * nothing until `start` holds a model for it.
   */
  it('contributes a Cloud endpoints section, drawn only while it is running', () => {
    const endpoints = inference.settings?.find((one) => one.id === 'inference:endpoints')
    expect(endpoints, 'the Cloud endpoints section is not contributed').toBeDefined()
    expect(endpoints?.render({ bookId: null }), 'a section drew before anything started').toBeNull()

    const handle = started()
    expect(endpoints?.render({ bookId: null }), 'the section drew nothing while the capability ran').not.toBeNull()
    handle.dispose()
    expect(endpoints?.render({ bookId: null }), 'the section outlived the capability').toBeNull()
  })

  /* THE INSTALL OFFER NAMES A SECTION THIS CAPABILITY DECLARES (phase 17, L3).
     The section spells its id as a literal — `scripts/surfaces.mjs` reads only
     literals — and the gloss provider reads the constant, so this is what holds
     the two spellings to one another: a renamed section would otherwise leave
     "Install one" opening Settings on nothing. */
  it('offers the install at the section it contributes as Local models', () => {
    const models = inference.settings?.find((one) => one.id === MODELS_SECTION)
    expect(models, `no contributed section is called ${MODELS_SECTION}`).toBeDefined()
    expect(models?.title).toBe('Local models')
  })

  /* ⚠️ **SHOWN TO EVERY READER, AND DELIBERATELY.** Companion's panel is hidden,
     and a settings section is hidden with the capability its id names — but
     these two are `inference`'s, and Look up ships on this engine, so hiding
     them would take a finished feature's settings with them. The rule reads the
     id before the colon against `UNFINISHED_PANE_IDS` (`settingsSectionOffered`,
     which the kernel entry does not export); what this holds is that nothing
     here answers to a name on that list. */
  it('offers Local models and Cloud endpoints under its own name, which no unfinished panel shares', () => {
    expect(inference.id).toBe('inference')
    expect((inference.settings ?? []).map(({ id, title }) => [id, title])).toEqual([
      ['inference:models', 'Local models'],
      ['inference:endpoints', 'Cloud endpoints'],
    ])
    for (const { id } of inference.settings ?? []) expect(id.startsWith(`${inference.id}:`), id).toBe(true)
    expect(UNFINISHED_PANE_IDS, 'Companion is no longer hidden, so this measures nothing').toContain('companion')
    expect(UNFINISHED_PANE_IDS, 'a finished engine’s settings would be hidden with an unfinished panel').not.toContain(
      inference.id,
    )
  })

  /* AND THE GLOSS `start` BINDS IS THAT OFFER. The provider is built from this
     start's own plugin and controller and names the section above; handed
     nothing, it has no runtime to follow and no section to name, and Look up
     reaches the kernel as a port that throws on first touch. */
  it('binds a gloss that follows this runtime, offers Local models, and answers through the plugin', async () => {
    const TEXT = { id: 'qwen-small', label: 'Qwen', modality: 'text', license: 'Apache-2.0', bytes: 1, installed: true } as const
    const answer = 'Structures along a shore where ships dock.'
    const status = vi.spyOn(inferencePlugin, 'status').mockResolvedValue({ state: 'ready', version: '1', port: 1 })
    const catalogue = vi.spyOn(inferencePlugin, 'models').mockResolvedValue([TEXT])
    const launch = vi.spyOn(inferencePlugin, 'start').mockResolvedValue(1)
    const gloss = vi.spyOn(inferencePlugin, 'gloss').mockResolvedValue(answer)
    let handle: ReturnType<typeof started> | undefined
    try {
      const services = createKernelServices({ fs: null, storage: null, initialBooks: [] })
      handle = started(services)
      /* Before `start`'s own refresh lands the runtime reads absent, and there is nowhere to send a reader yet. */
      expect(services.gloss().installAt).toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(services.gloss().installAt).toBe(MODELS_SECTION)
      expect(services.gloss().available).toBe(true)

      const context: GlossContext = {
        sentence: 'The ships lay at the wharves.',
        bookTitle: 'X',
        answerIn: [{ tag: 'en', name: 'English', label: 'English' }],
      }
      await expect(services.gloss().gloss('wharves', context, new AbortController().signal)).resolves.toBe(answer)
      expect(gloss.mock.calls.map((call) => call[1]), 'the gloss was not asked of the installed text model').toEqual(['qwen-small'])
    } finally {
      handle?.dispose()
      for (const spy of [status, catalogue, launch, gloss]) spy.mockRestore()
    }
  })

  /* AFTER Local models, because it is the same subject one step further out:
     this machine's models, then somebody else's. */
  it('puts the two inference sections in that order', () => {
    const ids = (inference.settings ?? []).map((one) => one.id)
    expect(ids).toEqual(['inference:models', 'inference:endpoints'])
    const orders = (inference.settings ?? []).map((one) => one.order)
    expect(orders).toEqual([...orders].sort((a, b) => (a ?? 0) - (b ?? 0)))
  })

  /**
   * ⚠️ TWO LIVE COMPOSITIONS, AND THE SECOND'S TEARDOWN BLANKING THE FIRST.
   *
   * The settings section reads a module slot, because `render` takes no
   * arguments. That slot was a bare `let` with an `=== mine` check, which
   * stops an OLD lifetime clearing a NEWER one and does nothing about the
   * reverse: the second start overwrote the first, and stopping the second set
   * the slot to null while the first was still running and still bound. Its
   * pane drew nothing from then on.
   */
  it('leaves the earlier composition’s pane drawing when a later one stops', () => {
    const models = inference.settings?.[0]
    expect(models, 'the Local models section is not contributed').toBeDefined()

    const first = started()
    expect(models?.render({ bookId: null }), 'the first composition drew nothing').not.toBeNull()

    const second = started()
    second.dispose()
    expect(
      models?.render({ bookId: null }),
      'stopping the second composition blanked the first’s pane',
    ).not.toBeNull()

    first.dispose()
    expect(models?.render({ bookId: null }), 'the section still drew after every composition stopped').toBeNull()
  })

  /**
   * ⚠️ THE SAME FINDING AGAIN, IN THE FIELD BESIDE THE RENDER SLOT.
   *
   * There is ONE daemon for the plugin, and which lifetime may stop it was a
   * monotonic "is mine the newest" token. That answers about the latest start
   * and says nothing about two LIVE ones: stopping the newer composition
   * killed a child process the older one was still talking to, and the older
   * one's own teardown then declined to stop it — its lifetime was no longer
   * current — so the process outlived every owner it ever had.
   */
  it('stops the shared daemon only when the last live composition lets go', () => {
    const stop = vi.spyOn(inferencePlugin, 'stop').mockResolvedValue(undefined)
    try {
      const first = started()
      const second = started()

      second.dispose()
      expect(stop, 'the newer composition’s teardown stopped a daemon the older one is still using').not.toHaveBeenCalled()

      first.dispose()
      expect(stop, 'the last owner let go and the child process was left running').toHaveBeenCalledTimes(1)
    } finally {
      stop.mockRestore()
    }
  })

  it('detaches everything it attached, the models model included', async () => {
    const section = inference.settings?.find((one) => one.id === 'inference:models')
    const handle = started()
    const drawn = section?.render({ bookId: null }) as { readonly props: { readonly model: ModelsModel } } | null
    const model = drawn?.props.model
    if (model === undefined) throw new Error('the section drew no model to observe')

    let told = 0
    model.subscribe(() => {
      told += 1
    })
    /* NON-VACUOUS: a live model tells its listeners when a refresh lands, so
       the silence below is the disposal and not a model that never speaks. */
    await model.refresh()
    expect(told, 'a running model told nobody, so the check below proves nothing').toBeGreaterThan(0)

    handle.dispose()
    told = 0
    await model.refresh()
    expect(told, 'the models model outlived the capability that built it').toBe(0)
  })

  /* WHAT IT REPORTS REACHES ITS COMPOSITION'S DIAGNOSTICS — the start, a runtime
     that would not answer, and a daemon that would not stop — rather than a
     reporter that drops them. */
  it('writes its start, a failed read and a failed stop to the composition’s diagnostics', async () => {
    const status = vi
      .spyOn(inferencePlugin, 'status')
      .mockRejectedValue({ kind: 'runtimeUnreachable', message: 'connection refused on 13399' })
    const catalogue = vi.spyOn(inferencePlugin, 'models').mockResolvedValue([])
    const stop = vi
      .spyOn(inferencePlugin, 'stop')
      .mockRejectedValue({ kind: 'runtimeExited', message: 'the daemon had already gone' })
    const { lines, diagnostics } = recording()
    let handle: ReturnType<typeof started> | undefined
    try {
      handle = started(undefined, diagnostics)
      expect(lines).toEqual([['info', 'inference.started', {}]])
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(lines.slice(1), 'a runtime that would not answer left no line').toEqual([
        ['warn', 'inference.refresh-failed', { detail: 'The runtime is not answering', message: 'connection refused on 13399' }],
      ])

      handle.dispose()
      handle = undefined
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(lines.slice(2), 'a daemon that would not stop left no line').toEqual([
        ['warn', 'inference.stop-failed', { message: 'the daemon had already gone' }],
      ])
    } finally {
      handle?.dispose()
      for (const spy of [status, catalogue, stop]) spy.mockRestore()
    }
  })

  /* THE CLOUD ENDPOINTS SECTION DRAWS A MODEL THAT READS THE PLUGIN, and the
     model stops with the capability, as the Local models one above does. */
  it('draws Cloud endpoints from the plugin’s own list, and stops that model with the capability', async () => {
    const listed = vi
      .spyOn(inferencePlugin, 'endpoints')
      .mockResolvedValue([{ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyState: 'set' }])
    const stop = vi.spyOn(inferencePlugin, 'stop').mockResolvedValue(undefined)
    let handle: ReturnType<typeof started> | undefined
    try {
      handle = started()
      const section = inference.settings?.find((one) => one.id === 'inference:endpoints')
      const drawn = section?.render({ bookId: null }) as { readonly props: { readonly model?: EndpointsModel } } | null
      const model = drawn?.props.model
      if (model === undefined) throw new Error('the Cloud endpoints section drew no model')

      await model.refresh()
      expect(model.getSnapshot().rows.map((row) => row.id), 'the section’s model did not read the plugin').toEqual(['groq'])

      let told = 0
      model.subscribe(() => {
        told += 1
      })
      model.edit('label', 'Groq, fast')
      expect(told, 'a running model told nobody, so the check below proves nothing').toBeGreaterThan(0)

      handle.dispose()
      handle = undefined
      told = 0
      model.edit('label', 'Groq, again')
      expect(told, 'the endpoints model outlived the capability that built it').toBe(0)
    } finally {
      handle?.dispose()
      for (const spy of [listed, stop]) spy.mockRestore()
    }
  })

  /* A DOWNLOAD IS ON THE LIBRARY STATUS BAR WHILE IT RUNS (WI-15.12), and
     stopping the capability takes both the line and the download: the request
     is cancelled rather than left pulling gigabytes for a composition that is
     gone. */
  it('puts a download on the status bar while it runs, and cancels it when the capability stops', async () => {
    const TEXT = { id: 'qwen-small', label: 'Qwen', modality: 'text', license: 'Apache-2.0', bytes: 2_000_000, installed: false } as const
    let progress: (update: InstallProgress) => void = () => {}
    let finish: () => void = () => {}
    const catalogue = vi.spyOn(inferencePlugin, 'models').mockResolvedValue([TEXT])
    const status = vi.spyOn(inferencePlugin, 'status').mockResolvedValue({ state: 'stopped' })
    const installModel = vi.spyOn(inferencePlugin, 'installModel').mockImplementation(async (_requestId, _model, onProgress) => {
      progress = onProgress
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    const cancel = vi.spyOn(inferencePlugin, 'cancel').mockResolvedValue(undefined)
    const stop = vi.spyOn(inferencePlugin, 'stop').mockResolvedValue(undefined)
    let handle: ReturnType<typeof started> | undefined
    try {
      const services = createKernelServices({ fs: null, storage: null, initialBooks: [] })
      handle = started(services)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const section = inference.settings?.find((one) => one.id === MODELS_SECTION)
      const drawn = section?.render({ bookId: null }) as { readonly props: { readonly model: ModelsModel } } | null
      const model = drawn?.props.model
      if (model === undefined) throw new Error('the section drew no model to drive')

      const bar = services.workLine()
      expect(bar.line(), 'the status bar said something before anything started').toBeNull()
      let told = 0
      const unsubscribe = bar.subscribe(() => {
        told += 1
      })
      const installing = model.install(TEXT.id)
      progress({ kind: 'downloading', received: 1_000_000, total: 2_000_000 })
      expect(bar.line()).toBe('Downloading Qwen — 1 MB of 2 MB')
      expect(told, 'the status bar was never told its line changed').toBeGreaterThan(0)
      unsubscribe()

      handle.dispose()
      handle = undefined
      expect(services.workLine().line(), 'the download line outlived the capability').toBeNull()
      expect(cancel.mock.calls, 'a download outlived the capability that started it').toEqual([
        [installModel.mock.calls[0]?.[0]],
      ])
      finish()
      await expect(installing).resolves.toBe(false)
    } finally {
      handle?.dispose()
      for (const spy of [catalogue, status, installModel, cancel, stop]) spy.mockRestore()
    }
  })

  /* STOPPING GIVES BACK WHAT STARTING TOOK. The gloss and the work line are
     exclusive ports on the kernel, so a composition that stopped without letting
     go of them would leave the next start on the same kernel refused. */
  it('can start again on the kernel it stopped on', () => {
    const stop = vi.spyOn(inferencePlugin, 'stop').mockResolvedValue(undefined)
    let again: ReturnType<typeof started> | undefined
    try {
      const services = createKernelServices({ fs: null, storage: null, initialBooks: [] })
      started(services).dispose()
      expect(() => {
        again = started(services)
      }, 'a stopped composition still held a port on its kernel').not.toThrow()
    } finally {
      again?.dispose()
      stop.mockRestore()
    }
  })

  /**
   * ⚠️ **THE PORT HAD THE RENDER SLOT'S DEFECT, ONE FIELD ALONG.**
   *
   * `running` was a bare `let` with an `=== mine` check — the shape
   * `createRenderSlot` was written to replace, and both slots beside it had
   * already been moved off it. So the second of two live compositions cleared
   * the value on its way out, and `inferencePort()` answered null while the
   * first was still started, still bound and still owning the daemon: a
   * `companion` composed against it from then on came up unwired.
   */
  it('keeps publishing the earlier composition’s port when a later one stops', () => {
    const first = started()
    const second = started()

    second.dispose()
    expect(inferencePort(), 'stopping the second composition took away the port the first still serves').not.toBeNull()

    first.dispose()
    expect(inferencePort(), 'a port was still published after every composition stopped').toBeNull()
  })

  /**
   * ⚠️ **A PORT HANDED OUT BEFORE A TEARDOWN WENT ON WORKING AFTER IT.**
   *
   * `inferencePort()` builds its methods over the plugin and the controller and
   * never asked whether the composition that owns them was still there. A
   * disposed controller only stops WRITING state — its `ensureReady` still calls
   * `plugin.start` — so a port kept past its teardown could launch the daemon
   * after the last owner had stopped it, and nothing would ever stop it again.
   */
  it('refuses work through a port whose composition has stopped', async () => {
    const launch = vi.spyOn(inferencePlugin, 'start').mockResolvedValue(1)
    const generate = vi.spyOn(inferencePlugin, 'generate').mockResolvedValue('an answer')
    const agentAsk = vi.spyOn(inferencePlugin, 'agentAsk').mockResolvedValue('an answer')
    const probe = vi.spyOn(inferencePlugin, 'probe').mockResolvedValue({ routes: [], runtimeVersion: null })
    const signIn = vi.spyOn(inferencePlugin, 'agentSignIn').mockResolvedValue(undefined)
    const stop = vi.spyOn(inferencePlugin, 'stop').mockResolvedValue(undefined)
    /* READY, so a port that did not refuse would answer `true` below — without
       it the launch's status read fails and `false` would pass for the wrong
       reason. */
    const status = vi.spyOn(inferencePlugin, 'status').mockResolvedValue({ state: 'ready', version: '1', port: 1 })
    try {
      const handle = started()
      const port = inferencePort()
      if (port === null) throw new Error('a running composition published no port')
      handle.dispose()

      const live = new AbortController().signal
      await expect(port.ensureReady(), 'a stopped port said the runtime could start').resolves.toBe(false)
      const attempts: readonly (readonly [string, () => Promise<unknown>])[] = [
        ['generate', () => port.generate('qwen', 'system', 'question', () => {}, live)],
        ['agentAsk', () => port.agentAsk('agent:codex', 'prompt', 'default', () => {}, live)],
        ['probe', () => port.probe()],
        ['signIn', () => port.signIn('agent:codex')],
      ]
      for (const [what, attempt] of attempts) {
        expect((await refusalOf(attempt())).message, `${what} through a stopped port`).toMatch(/Inference has stopped/)
      }
      expect(launch, 'a port kept past its teardown launched a daemon nothing owns').not.toHaveBeenCalled()
      for (const spy of [generate, agentAsk, probe, signIn]) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of [launch, generate, agentAsk, probe, signIn, stop, status]) spy.mockRestore()
    }
  })

  /* AND ONE THAT STOPS WHILE THE RUNTIME IS STARTING. The launch is the one
     await on the way to a question, so a check made only before it is a check
     made a process launch too early: the question went on to a daemon its
     owner had just been told to stop. */
  it('does not send a question whose composition stopped while the runtime was starting', async () => {
    let handle: ReturnType<typeof started> | undefined
    const launch = vi.spyOn(inferencePlugin, 'start').mockImplementation(async () => {
      handle?.dispose()
      return 1
    })
    const status = vi.spyOn(inferencePlugin, 'status').mockResolvedValue({ state: 'ready', version: '1', port: 1 })
    const generate = vi.spyOn(inferencePlugin, 'generate').mockResolvedValue('an answer')
    const stop = vi.spyOn(inferencePlugin, 'stop').mockResolvedValue(undefined)
    try {
      handle = started()
      const port = inferencePort()
      if (port === null) throw new Error('a running composition published no port')

      const refusal = await refusalOf(port.generate('qwen', 'system', 'question', () => {}, new AbortController().signal))
      expect(launch, 'the question never reached the launch, so this measures nothing').toHaveBeenCalledTimes(1)
      expect(refusal.message).toMatch(/Inference has stopped/)
      expect(generate, 'the question went to a daemon its owner had stopped').not.toHaveBeenCalled()
    } finally {
      for (const spy of [launch, status, generate, stop]) spy.mockRestore()
    }
  })

  /**
   * ⚠️ **THE PORT COLLAPSED A START FAILURE TOO, AND THE COMPANION READS THE
   * RESULT.**
   *
   * `generate` took a boolean from the launch and raised its own
   * `Error('The runtime is not running')` for every way one can fail — so a
   * reader with no runtime installed at all was told it was not running, by a
   * line one call away from the plugin's own `kind`. `companion`'s `failure`
   * translates a `kind` and passes an `Error` through, so the wrapper was
   * exactly what stopped it naming the cause (2026-09-13 audit, round 2).
   */
  it('raises what actually stopped the runtime, rather than that it is not running', async () => {
    const refusal = { kind: 'runtimeMissing', message: 'the inference runtime is not installed at /x' }
    const launch = vi.spyOn(inferencePlugin, 'start').mockRejectedValue(refusal)
    const status = vi.spyOn(inferencePlugin, 'status').mockResolvedValue({ state: 'absent', reason: 'not staged' })
    const generate = vi.spyOn(inferencePlugin, 'generate').mockResolvedValue('an answer')
    const stop = vi.spyOn(inferencePlugin, 'stop').mockResolvedValue(undefined)
    let handle: ReturnType<typeof started> | undefined
    try {
      handle = started()
      const port = inferencePort()
      if (port === null) throw new Error('a running composition published no port')

      const raised = await refusalOf(port.generate('qwen', 'system', 'question', () => {}, new AbortController().signal))
      expect(launch, 'the question never reached the launch, so this measures nothing').toHaveBeenCalled()
      expect(raised.kind, 'the plugin’s own kind was thrown away, so nothing downstream can name the cause').toBe(
        'runtimeMissing',
      )
      expect(detailFor(raised)).toBe('The runtime is not installed')
      expect(generate, 'the question went out over a runtime that never started').not.toHaveBeenCalled()
    } finally {
      handle?.dispose()
      for (const spy of [launch, status, generate, stop]) spy.mockRestore()
    }
  })

  /**
   * ⚠️ **`ensureReady` ANSWERED `true` FOR A LIFETIME THAT HAD ENDED.**
   *
   * The liveness check ran BEFORE the launch and never again, and the launch is
   * seconds long — it binds a socket, probes accelerators and loads a model. So
   * a composition torn down during it had its port report a runtime ready to
   * serve, on behalf of an owner that no longer existed. `generate` beside it
   * had already learned to ask twice (2026-09-13 audit, round 2).
   */
  it('does not report ready through a port whose composition stopped while the runtime was starting', async () => {
    let handle: ReturnType<typeof started> | undefined
    const launch = vi.spyOn(inferencePlugin, 'start').mockImplementation(async () => {
      handle?.dispose()
      return 1
    })
    const status = vi.spyOn(inferencePlugin, 'status').mockResolvedValue({ state: 'ready', version: '1', port: 1 })
    const stop = vi.spyOn(inferencePlugin, 'stop').mockResolvedValue(undefined)
    try {
      handle = started()
      const port = inferencePort()
      if (port === null) throw new Error('a running composition published no port')

      await expect(
        port.ensureReady(),
        'a port whose composition stopped mid-launch still called the runtime ready',
      ).resolves.toBe(false)
      expect(launch, 'the launch never ran, so this measures nothing').toHaveBeenCalledTimes(1)
    } finally {
      handle?.dispose()
      for (const spy of [launch, status, stop]) spy.mockRestore()
    }
  })

  /**
   * ⚠️ **A STOPPED COMPOSITION LEFT ITS REQUESTS RUNNING.**
   *
   * `index.ts` said so in as many words and called it covered: the last owner's
   * stop trips `take_down`, which cancels every registered request. That is
   * true and it is the case that does NOT need covering — when another owner
   * keeps the daemon there is no `take_down`, so the request of a lifetime that
   * has ended goes on generating with a port that refuses every new call and
   * nobody at all to read the answer. Two live compositions here for exactly
   * that reason: the daemon is untouched, so a cancel can only have come from
   * the teardown (2026-09-13 audit, round 2).
   */
  it('cancels a request its composition still had out, with another owner keeping the daemon', async () => {
    let release: (answer: string) => void = () => {}
    const pending = new Promise<string>((resolve) => {
      release = resolve
    })
    const launch = vi.spyOn(inferencePlugin, 'start').mockResolvedValue(1)
    const status = vi.spyOn(inferencePlugin, 'status').mockResolvedValue({ state: 'ready', version: '1', port: 1 })
    const generate = vi.spyOn(inferencePlugin, 'generate').mockImplementation(async () => pending)
    const stop = vi.spyOn(inferencePlugin, 'stop').mockResolvedValue(undefined)
    const cancelled: string[] = []
    const cancel = vi.spyOn(inferencePlugin, 'cancel').mockImplementation(async (requestId: string) => {
      cancelled.push(requestId)
    })
    let first: ReturnType<typeof started> | undefined
    let second: ReturnType<typeof started> | undefined
    try {
      first = started()
      /* THE FIRST COMPOSITION'S PORT, taken before the second exists — the slot
         hands out the newest, and this is about the one that goes away. */
      const port = inferencePort()
      if (port === null) throw new Error('a running composition published no port')
      second = started()

      const asking = port.generate('qwen', 'system', 'question', () => {}, new AbortController().signal)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(generate, 'the question never reached the plugin, so this measures nothing').toHaveBeenCalledTimes(1)

      first.dispose()
      first = undefined
      expect(stop, 'the daemon was stopped, so Rust would have cancelled and this measures nothing').not.toHaveBeenCalled()
      expect(cancelled, 'the request of a lifetime that ended was left generating').toHaveLength(1)
      expect(cancelled[0]).toBe(generate.mock.calls[0]?.[0])

      release('an answer')
      await asking
    } finally {
      first?.dispose()
      second?.dispose()
      for (const spy of [launch, status, generate, stop, cancel]) spy.mockRestore()
    }
  })

  /* THE REQUEST ID SAYS WHAT KIND OF REQUEST IT IS — `ask-`, `agent-` — which is
     what a correlation id carries into the daemon's log beside its counter. And
     a port whose composition is running says ready when the runtime is. */
  it('asks through the plugin under an id naming the request, and says ready while its composition runs', async () => {
    const launch = vi.spyOn(inferencePlugin, 'start').mockResolvedValue(1)
    const status = vi.spyOn(inferencePlugin, 'status').mockResolvedValue({ state: 'ready', version: '1', port: 1 })
    const generate = vi.spyOn(inferencePlugin, 'generate').mockResolvedValue('a local answer')
    const agentAsk = vi.spyOn(inferencePlugin, 'agentAsk').mockResolvedValue('an agent answer')
    const stop = vi.spyOn(inferencePlugin, 'stop').mockResolvedValue(undefined)
    let handle: ReturnType<typeof started> | undefined
    try {
      handle = started()
      const port = inferencePort()
      if (port === null) throw new Error('a running composition published no port')
      const live = new AbortController().signal
      const onChunk = (): void => {}

      await expect(port.ensureReady(), 'a live port over a ready runtime said it could not start').resolves.toBe(true)
      await expect(port.generate('qwen', 'system', 'question', onChunk, live)).resolves.toBe('a local answer')
      expect(generate.mock.calls).toEqual([[expect.stringMatching(/^ask-/), 'qwen', 'system', 'question', onChunk]])
      await expect(port.agentAsk('agent:codex', 'prompt', 'thorough', onChunk, live)).resolves.toBe('an agent answer')
      expect(agentAsk.mock.calls).toEqual([[expect.stringMatching(/^agent-/), 'agent:codex', 'prompt', 'thorough', onChunk]])
    } finally {
      handle?.dispose()
      for (const spy of [launch, status, generate, agentAsk, stop]) spy.mockRestore()
    }
  })

  /* THE READER'S STOP REACHES THE DAEMON, AND ONLY FOR WORK STILL OUT. A request
     that has settled is forgotten on both counts — the listener on its signal
     and its place on the teardown's list — so neither a later abort nor the
     composition stopping cancels an id the daemon has already finished. */
  it('cancels a request its reader stops, and never one that has already settled', async () => {
    let release: (answer: string) => void = () => {}
    const pending = new Promise<string>((resolve) => {
      release = resolve
    })
    const launch = vi.spyOn(inferencePlugin, 'start').mockResolvedValue(1)
    const status = vi.spyOn(inferencePlugin, 'status').mockResolvedValue({ state: 'ready', version: '1', port: 1 })
    const generate = vi
      .spyOn(inferencePlugin, 'generate')
      .mockImplementationOnce(async () => pending)
      .mockResolvedValue('a second answer')
    const stop = vi.spyOn(inferencePlugin, 'stop').mockResolvedValue(undefined)
    const cancelled: string[] = []
    const cancel = vi.spyOn(inferencePlugin, 'cancel').mockImplementation(async (requestId: string) => {
      cancelled.push(requestId)
    })
    let handle: ReturnType<typeof started> | undefined
    try {
      handle = started()
      const port = inferencePort()
      if (port === null) throw new Error('a running composition published no port')

      const reader = new AbortController()
      const asking = port.generate('qwen', 'system', 'question', () => {}, reader.signal)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(generate, 'the question never reached the plugin, so this measures nothing').toHaveBeenCalledTimes(1)
      const stopped = generate.mock.calls[0]?.[0]
      reader.abort()
      expect(cancelled, 'the reader pressed Stop and the daemon was not told').toEqual([stopped])
      release('an answer nobody reads')
      await asking

      const later = new AbortController()
      await expect(port.generate('qwen', 'system', 'another', () => {}, later.signal)).resolves.toBe('a second answer')
      later.abort()
      handle.dispose()
      handle = undefined
      expect(cancelled, 'a request that had already settled was cancelled').toEqual([stopped])
    } finally {
      handle?.dispose()
      for (const spy of [launch, status, generate, stop, cancel]) spy.mockRestore()
    }
  })

  /* A READER WHO HAS GIVEN UP IS NOT ASKED FOR, ON EITHER SIDE OF THE LAUNCH.
     Before it, nothing is launched for them; during it, the launch is left to
     finish — the daemon serves every later question — but their question is
     never sent. Both refuse with the reader's own abort, which is what a caller
     recognises as theirs. */
  it('sends nothing for a reader who gave up, before the launch or while it ran', async () => {
    const launch = vi.spyOn(inferencePlugin, 'start').mockResolvedValue(1)
    const status = vi.spyOn(inferencePlugin, 'status').mockResolvedValue({ state: 'ready', version: '1', port: 1 })
    const generate = vi.spyOn(inferencePlugin, 'generate').mockResolvedValue('an answer')
    const stop = vi.spyOn(inferencePlugin, 'stop').mockResolvedValue(undefined)
    let handle: ReturnType<typeof started> | undefined
    try {
      handle = started()
      const port = inferencePort()
      if (port === null) throw new Error('a running composition published no port')
      const outcome = (asked: Promise<string>) => asked.then(() => null, (thrown: unknown) => thrown)

      const before = new AbortController()
      before.abort()
      expect(await outcome(port.generate('qwen', 'system', 'question', () => {}, before.signal))).toBe(before.signal.reason)
      expect(launch, 'a launch began for a reader who had already given up').not.toHaveBeenCalled()

      const during = new AbortController()
      launch.mockImplementation(async () => {
        during.abort()
        return 1
      })
      expect(await outcome(port.generate('qwen', 'system', 'question', () => {}, during.signal))).toBe(during.signal.reason)
      expect(launch, 'the launch never ran, so this measures nothing').toHaveBeenCalledTimes(1)
      expect(generate, 'a question given up during the launch was still sent').not.toHaveBeenCalled()
    } finally {
      handle?.dispose()
      for (const spy of [launch, status, generate, stop]) spy.mockRestore()
    }
  })

  /**
   * A TEARDOWN STEP THAT FAILS IS NAMED, AND THE STEPS AFTER IT STILL RUN.
   *
   * Nothing this capability releases throws today — the plugin's commands reject
   * rather than throw, and the kernel's disposers are idempotent — so the name
   * each step is owned under is read only on the day one does, and on that day
   * the name is the whole diagnostic. Every step that CAN be made to fail from
   * outside is made to here, by a plugin and a kernel that throw where the real
   * ones reject. (The render slots and the endpoints model cannot, and are marked
   * beside their `own`.)
   *
   * ON ITS OWN MODULE INSTANCES: a `running` step that throws never reaches its
   * slot's release, which would leave a port published in module scope for
   * every case after this one.
   */
  it('names each teardown step that fails, and still runs the steps after it', async () => {
    vi.resetModules()
    const isolated = await import('./index')
    const { inferencePlugin: plugin } = await import('./lib/plugin')
    const TEXT = { id: 'qwen-small', label: 'Qwen', modality: 'text', license: 'Apache-2.0', bytes: 1, installed: false } as const
    const VOICE = { id: 'kokoro', label: 'Kokoro', modality: 'speech', license: 'Apache-2.0', bytes: 1, installed: true } as const
    const gates: (() => void)[] = []
    const held = <T,>(value: T): Promise<T> =>
      new Promise<T>((resolve) => {
        gates.push(() => resolve(value))
      })
    const spies = [
      vi.spyOn(plugin, 'status').mockResolvedValue({ state: 'ready', version: '1', port: 1 }),
      vi.spyOn(plugin, 'models').mockResolvedValue([TEXT, VOICE]),
      vi.spyOn(plugin, 'start').mockResolvedValue(1),
      vi.spyOn(plugin, 'installModel').mockImplementation(() => held(undefined)),
      vi.spyOn(plugin, 'speak').mockImplementation(() => held([])),
      vi.spyOn(plugin, 'generate').mockImplementation(() => held('an answer')),
      vi.spyOn(plugin, 'cancel').mockImplementation(() => {
        throw new Error('the cancel command is gone')
      }),
      vi.spyOn(plugin, 'stop').mockImplementation(() => {
        throw new Error('the stop command is gone')
      }),
    ]
    const kernel = createKernelServices({ fs: null, storage: null, initialBooks: [] })
    const refusing = (bound: Disposable, what: string): Disposable => ({
      dispose: () => {
        bound.dispose()
        throw new Error(`${what} would not let go`)
      },
    })
    const services: typeof kernel = {
      ...kernel,
      bindGloss: (provider) => refusing(kernel.bindGloss(provider), 'the gloss port'),
      bindWorkLine: (work) => refusing(kernel.bindWorkLine(work), 'the work line'),
    }
    const warned: (readonly [string, Record<string, unknown> | undefined])[] = []
    try {
      const handle = isolated.inference.start?.(
        {
          services,
          settings: scopeSettings(services.settings, 'inference'),
          diagnostics: { ...NOOP_DIAGNOSTICS, warn: (event, fields) => void warned.push([event, fields]) },
          onCleanup: () => {},
        },
        new AbortController().signal,
      )
      if (handle === undefined || handle instanceof Promise) throw new Error('start returned no synchronous handle')
      await new Promise((resolve) => setTimeout(resolve, 0))

      const section = isolated.inference.settings?.find((one) => one.id === isolated.MODELS_SECTION)
      const drawn = section?.render({ bookId: null }) as { readonly props: { readonly model: ModelsModel } } | null
      const model = drawn?.props.model
      const port = isolated.inferencePort()
      if (model === undefined || port === null) throw new Error('the composition published nothing to put work through')
      void model.install(TEXT.id)
      void model.testVoice()
      void port.generate(TEXT.id, 'system', 'question', () => {}, new AbortController().signal)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(gates, 'the download, the voice and the question were not all out, so this measures nothing').toHaveLength(3)

      handle.dispose()
      /* Last owned, first released: the child process is stopped soonest. */
      expect(warned).toEqual(
        [
          ['daemon', 'the stop command is gone'],
          ['modelsModel', 'the cancel command is gone'],
          ['running', 'the cancel command is gone'],
          ['unbindWorkLine', 'the work line would not let go'],
          ['unbindGloss', 'the gloss port would not let go'],
          ['controller', 'the cancel command is gone'],
        ].map(([label, message]) => ['inference.teardown-step-failed', { label, message }]),
      )
      expect(section?.render({ bookId: null }), 'a step that failed stopped the ones after it').toBeNull()

      for (const open of gates) open()
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  /**
   * ⚠️ **A START THAT FAILED KEPT ITS CLAIM ON THE DAEMON, FOR GOOD.**
   *
   * The claim was taken near the top of `start` and its release registered at
   * the bottom, with every binding in between. So a start refused part-way — the
   * gloss port already bound is the ordinary way — unwound everything it had
   * registered and left the claim behind, where no teardown could reach it. The
   * last composition that really did start then counted an owner that was never
   * coming back, and never stopped the child process.
   *
   * LAST IN THE FILE, because on the defect it measures the leaked claim is
   * module state and would take the daemon cases above down with it.
   */
  it('releases the daemon claim of a start that failed, so the last real owner still stops it', () => {
    const stop = vi.spyOn(inferencePlugin, 'stop').mockResolvedValue(undefined)
    try {
      const taken = createKernelServices({ fs: null, storage: null, initialBooks: [] })
      taken.bindGloss({ available: false, installAt: null, warm: () => {}, gloss: () => Promise.reject(new Error('never asked')) })
      const cleanups: (() => void)[] = []
      expect(
        () =>
          inference.start?.(
            {
              services: taken,
              settings: scopeSettings(taken.settings, 'inference'),
              diagnostics: NOOP_DIAGNOSTICS,
              onCleanup: (dispose) => {
                cleanups.push(dispose)
              },
            },
            new AbortController().signal,
          ),
        'the start was not refused, so this measures nothing',
      ).toThrow(/the gloss port is already bound/)
      /* What the registry does with a start that threw: run what it registered, newest first. */
      for (const cleanup of [...cleanups].reverse()) cleanup()
      stop.mockClear()

      started().dispose()
      expect(stop, 'the failed start’s claim outlived it, so the last real owner left the child process running').toHaveBeenCalledTimes(1)
    } finally {
      stop.mockRestore()
    }
  })
})
