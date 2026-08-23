import { describe, expect, it } from 'vitest'
import { NOOP_DIAGNOSTICS, createKernelServices, scopeSettings, type SettingsStore } from '../../kernel'
import { inference, inferenceDownloadLine } from './index'

/**
 * THE STATUS BAR AT REST, which is the state almost every reader is in.
 *
 * `inferenceDownloadLine` is read by `App` on every render of the library
 * status bar, whether or not `inference` is composed — that is the whole point
 * of exporting it from the capability rather than pushing it into the kernel.
 * With the capability absent or not started there is no controller to ask, and
 * the answer has to be `null` rather than a throw or an empty string: the bar
 * draws a third rung only when there IS a line, and at rest it must be
 * byte-for-byte the two-rung ladder it was before any of this existed.
 *
 * A build with `inference` left out is the case that would otherwise be found
 * by a reader opening the shelf and seeing a crash, since nothing else in the
 * suite renders the bar without the capability.
 */
describe('the library status bar line', () => {
  it('is null when the capability is not running', () => {
    expect(inferenceDownloadLine()).toBeNull()
  })
})

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
