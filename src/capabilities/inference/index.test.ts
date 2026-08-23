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
