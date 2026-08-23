import { describe, expect, it } from 'vitest'
import { NOOP_DIAGNOSTICS, createKernelServices, scopeSettings, type SettingsStore } from '../../kernel'
import { inference } from './index'

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
 * the tests ever called `ModelsModel.dispose`, so in the running app the
 * settings subscription, an `Audio` element, a blob URL and any voice request
 * in flight survived every restart of the capability and accumulated. A leak
 * whose individual instances are all small is one that nothing notices until
 * there are hundreds of them.
 *
 * The settings subscription is the observable end of it: the model takes one
 * when it is built, so counting subscribers across a start/stop pair says
 * whether the model was disposed without reaching inside it.
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
  const started = () => {
    const services = createKernelServices({ fs: null, storage: null, initialBooks: [] })
    const controller = new AbortController()
    const handle = inference.start?.(
      {
        services,
        settings: scopeSettings(services.settings, 'inference'),
        diagnostics: NOOP_DIAGNOSTICS,
        onCleanup: () => {},
      },
      controller.signal,
    )
    if (handle === undefined || handle instanceof Promise) throw new Error('start returned no synchronous handle')
    return handle
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
    expect(endpoints?.render(), 'a section drew before anything started').toBeNull()

    const handle = started()
    expect(endpoints?.render(), 'the section drew nothing while the capability ran').not.toBeNull()
    handle.dispose()
    expect(endpoints?.render(), 'the section outlived the capability').toBeNull()
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
    expect(models?.render(), 'the first composition drew nothing').not.toBeNull()

    const second = started()
    second.dispose()
    expect(
      models?.render(),
      'stopping the second composition blanked the first’s pane',
    ).not.toBeNull()

    first.dispose()
    expect(models?.render(), 'the section still drew after every composition stopped').toBeNull()
  })

  it('detaches everything it attached, the models model included', () => {
    const services = createKernelServices({ fs: null, storage: null, initialBooks: [] })
    const scoped = scopeSettings(services.settings, 'inference')
    let subscribers = 0
    const settings: SettingsStore = {
      ...scoped,
      subscribe: (listener) => {
        subscribers += 1
        const off = scoped.subscribe(listener)
        return () => {
          subscribers -= 1
          off()
        }
      },
    }
    const controller = new AbortController()
    const handle = inference.start?.(
      {
        services,
        settings,
        diagnostics: NOOP_DIAGNOSTICS,
        onCleanup: () => {},
      },
      controller.signal,
    )
    if (handle === undefined || handle instanceof Promise) throw new Error('start returned no synchronous handle')
    expect(subscribers, 'the models model never subscribed, so this proves nothing').toBeGreaterThan(0)

    handle.dispose()
    expect(subscribers, 'a subscription outlived the capability that took it').toBe(0)
  })
})
