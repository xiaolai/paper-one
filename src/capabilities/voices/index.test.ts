// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { voices } from './index'
import type { CapabilityContext, Disposable, PaneContext, SpeechEnginePort } from '../../kernel'

/** What a contributed settings section is told when it is drawn. */
const DRAWN: PaneContext = { bookId: null }

/**
 * ⚠️ **THIS CAPABILITY HAD NO TEST FILE AT ALL, AND THE MUTATION GATE IS WHAT
 * SAID SO.** Four mutants survived in `index.ts` — its settings section could
 * be emptied, its title blanked and its order moved, and every one of those is
 * a fact a reader meets in Settings. They are static mutants, so the gate can
 * only name them; nothing here throws at import, so they genuinely survived.
 *
 * What this file pins is the CONTRIBUTION and the LIFETIME. The pane itself is
 * `VoicesPane.test.tsx`'s subject, and the port is `port.test.ts`'s; neither
 * can see whether the capability offers them to the app at all.
 */

/** A context whose services and diagnostics the case can read back. */
function contextWith(over: Partial<CapabilityContext['services']> = {}) {
  const bound: { port: SpeechEnginePort | null; disposed: number } = { port: null, disposed: 0 }
  const info = vi.fn()
  const services = {
    bindSpeechEngines: (port: SpeechEnginePort) => {
      bound.port = port
      return { dispose: () => { bound.disposed += 1 } }
    },
    ...over,
  }
  return { api: { services, diagnostics: { info } } as unknown as CapabilityContext, bound, info }
}

describe('what the app is offered', () => {
  it('is the voices capability, requiring nothing', () => {
    /* ⚠️ `requires` is a standing right to reach inside another capability, and
       `capability-requires-used` refuses a declaration nothing uses. This one
       needs none: the engine is a kernel PORT, not another capability. */
    expect(voices.id).toBe('voices')
    expect(voices.requires).toEqual([])
  })

  it('contributes exactly one settings section, named and placed', () => {
    /* ⚠️ Every value here survived a mutation. The ORDER is the one a reader
       feels without being able to name: 14 puts Voices after Reading (10) and
       before Devices (20), because a voice is part of how a book is read and
       not part of what talks to another machine. A declared number rather than
       a default, so neither moves when the other changes its mind. */
    expect(voices.settings).toHaveLength(1)
    const section = voices.settings![0]!
    expect(section.id).toBe('voices:voices')
    expect(section.title).toBe('Voices')
    expect(section.order).toBe(14)
  })

  it('draws its pane, and makes the port it draws with only once', () => {
    /* ⚠️ `pane ??= voicesPortOver()` is a memo, and a memo nothing asserts is a
       memo that can quietly become a fresh port per render — which would give
       every redraw its own progress subscription. Rendering twice and reading
       the element's prop is the only seam: the port is a closure's. */
    const first = voices.settings![0]!.render(DRAWN) as { props: { port: unknown } }
    const second = voices.settings![0]!.render(DRAWN) as { props: { port: unknown } }
    expect(first.props.port, 'the pane is given a port').toBeDefined()
    expect(second.props.port, 'and the same one every time').toBe(first.props.port)
  })
})

describe('the lifetime', () => {
  it('binds the speech engines on start, and says it started', () => {
    const { api, bound, info } = contextWith()
    const stop = voices.start!(api, new AbortController().signal) as Disposable
    expect(bound.port, 'nothing bound the port').not.toBeNull()
    expect(info).toHaveBeenCalledWith('voices.started', {})
    stop.dispose()
  })

  it('releases the model on the way out, not only the binding', () => {
    /* ⚠️ **THE READER'S MEMORY IS THE POINT.** A loaded Chinese model holds
       about 2.5 GB — measured with `footprint`, which is the only instrument
       that can see it — and a composition being torn down is the last moment
       anything will ask for it back. Unbinding alone would leave it held by a
       plugin nobody can reach. */
    const { api, bound } = contextWith()
    const stop = voices.start!(api, new AbortController().signal) as Disposable
    const release = vi.spyOn(bound.port!, 'release')
    stop.dispose()
    expect(bound.disposed, 'the binding is released').toBe(1)
    expect(release, 'and so is the model').toHaveBeenCalledTimes(1)
  })

  it('does not let a failed release take the teardown down with it', () => {
    /* A composition is torn down on a path that cannot afford to throw: the
       next one is already being built. */
    const { api, bound } = contextWith()
    const stop = voices.start!(api, new AbortController().signal) as Disposable
    vi.spyOn(bound.port!, 'release').mockRejectedValue(new Error('the plugin is gone'))
    expect(() => stop.dispose()).not.toThrow()
  })

  it('binds a port of its own, not the one the settings pane draws with', () => {
    /* ⚠️ **TWO PORTS, DELIBERATELY**, and `index.ts` says why: the pane outlives
       the composition, so it holds a module-level port of its own. A single
       shared one would be released out from under an open Settings pane. */
    const { api, bound } = contextWith()
    const stop = voices.start!(api, new AbortController().signal) as Disposable
    const drawn = (voices.settings![0]!.render(DRAWN) as { props: { port: unknown } }).props.port
    expect(bound.port).not.toBe(drawn)
    stop.dispose()
  })
})
