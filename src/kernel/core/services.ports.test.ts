import { describe, expect, it } from 'vitest'
import { NOT_CONFIGURED, type CompanionProvider } from './companion'
import { LOOK_UP_MODES, LOOK_UP_SETTING, NO_GLOSS, availableModes, effectiveMode, type GlossProvider } from './gloss'
import { NO_WORK_LINE, type WorkLine } from './ports'
import { createKernelServices } from './services'
import { servicesWith, spyRecorder } from './servicesWorld.testkit'

/**
 * THE THREE PORTS PHASE 15 ADDED, at rest and after a bind.
 *
 * Each is late-bound by a capability that may not be installed, so the DEFAULT
 * is the state most readers are in and is the one a test is most likely to
 * skip. Two of the three defaults refuse rather than answer, and a refusal
 * nobody calls is a refusal nobody has read: `NOT_CONFIGURED.ask` is an async
 * generator, so its throw does not happen until the first `next()` — a caller
 * that merely invoked it and dropped the result would see no error at all.
 *
 * The accessors are resolved PER CALL rather than captured, which is what lets
 * a reader install a model without restarting, and the disposer restores the
 * previous provider rather than the default — the same contract `bindRecorder`
 * has, for the same reason: a torn-down capability must not leave the kernel
 * pointing at it.
 */
describe('the companion, gloss and work-line ports', () => {
  const fake = (name: string): CompanionProvider => ({
    name,
    configured: true,
    async *ask() {
      return { citations: [], hadUnknownCitation: false }
    },
  })

  it('defaults to a companion that says it is not configured', () => {
    const services = servicesWith(spyRecorder().recorder)
    expect(services.companion()).toBe(NOT_CONFIGURED)
    expect(services.companion().configured).toBe(false)
    expect(services.companion().name).toBe('No model configured')
  })

  it('refuses to ask when nothing is bound, and refuses on ITERATION', async () => {
    /* The generator is created without complaint; the throw is on the first
       `next()`. A test that only called `ask()` would pass over a provider
       that never refuses at all. */
    const services = servicesWith(spyRecorder().recorder)
    const stream = services
      .companion()
      .ask('q', { bookTitle: 'X', chapterLabel: 'One', selection: null, passages: [] }, new AbortController().signal)
    await expect(stream.next()).rejects.toThrow(/no provider/i)
  })

  it('binds a companion and restores the previous one on dispose', () => {
    const services = servicesWith(spyRecorder().recorder)
    const unbind = services.bindCompanion(fake('Local'))
    expect(services.companion().name).toBe('Local')
    unbind.dispose()
    expect(services.companion()).toBe(NOT_CONFIGURED)
  })

  it('defaults to a gloss that is unavailable and refuses', async () => {
    const services = servicesWith(spyRecorder().recorder)
    expect(services.gloss()).toBe(NO_GLOSS)
    expect(services.gloss().available).toBe(false)
    await expect(services.gloss().gloss('word', { sentence: 'a word here', bookTitle: 'X' }, new AbortController().signal)).rejects.toThrow(/no gloss provider/i)
  })

  it('binds a gloss and restores it on dispose', async () => {
    const services = servicesWith(spyRecorder().recorder)
    const provider: GlossProvider = { available: true, gloss: async () => 'a meaning' }
    const unbind = services.bindGloss(provider)
    expect(services.gloss().available).toBe(true)
    await expect(services.gloss().gloss('w', { sentence: 's', bookTitle: 'X' }, new AbortController().signal)).resolves.toBe('a meaning')
    unbind.dispose()
    expect(services.gloss()).toBe(NO_GLOSS)
  })

  /* AT REST THE BAR IS WHAT IT ALWAYS WAS. `line()` is null and `subscribe`
     hands back a working unsubscribe rather than undefined — a store that
     returned nothing there would throw inside `useSyncExternalStore`'s
     cleanup, on unmount, in a build nobody had bound a work line in. */
  it('defaults to a work line that reports nothing and notifies nobody', () => {
    const services = servicesWith(spyRecorder().recorder)
    expect(services.workLine()).toBe(NO_WORK_LINE)
    expect(services.workLine().line()).toBeNull()
    const stop = services.workLine().subscribe(() => {})
    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
  })

  it('binds a work line and restores it on dispose', () => {
    const services = servicesWith(spyRecorder().recorder)
    const listeners: (() => void)[] = []
    const work: WorkLine = {
      line: () => 'Importing 3 books',
      subscribe: (listener) => {
        listeners.push(listener)
        return () => {
          /* GUARDED. `splice(-1, 1)` removes the LAST listener, so a repeated
             or stale unsubscribe in this double would have quietly detached
             somebody else — a fake that misbehaves in a way the real store
             does not is a test that can only mislead. */
          const at = listeners.indexOf(listener)
          if (at >= 0) listeners.splice(at, 1)
        }
      },
    }
    const unbind = services.bindWorkLine(work)
    expect(services.workLine().line()).toBe('Importing 3 books')
    const stop = services.workLine().subscribe(() => {})
    expect(listeners).toHaveLength(1)
    stop()
    expect(listeners).toHaveLength(0)
    unbind.dispose()
    expect(services.workLine().line()).toBeNull()
  })

  it('refuses a second bind on each of the three, by name', () => {
    const services = servicesWith(spyRecorder().recorder)
    services.bindCompanion(fake('one'))
    expect(() => services.bindCompanion(fake('two'))).toThrow(/already bound/)
    services.bindGloss({ available: true, gloss: async () => 'x' })
    expect(() => services.bindGloss({ available: true, gloss: async () => 'y' })).toThrow(/already bound/)
    services.bindWorkLine({ line: () => null, subscribe: () => () => {} })
    expect(() => services.bindWorkLine({ line: () => null, subscribe: () => () => {} })).toThrow(/already bound/)
  })
})

/**
 * `Look up`, WHICH THE KERNEL OWNS AND TWO CAPABILITIES DRAW.
 *
 * The setting is `kernel.lookUp` on purpose — `ui/lookUp.ts` acts on it — but
 * `scopeSettings` confines a capability to its own namespace at every door,
 * `services.settings` included. So the two panes that draw the control cannot
 * reach the value through a store at all, and reading it through one threw
 * `namespace` on their first render. This accessor is the seam; these cases
 * are what say it behaves.
 */
/**
 * THE SERVICE HOST'S DISPOSER IS ITS CONTRACT.
 *
 * ⚠️ `serveServices` ended in `?? NOOP_DISPOSABLE`, which cannot tell a BOUND
 * host that answered wrongly from the unbound fallback that answers nothing by
 * design. So a host returning `undefined` — in breach of its own signature —
 * was accepted silently, and if it had registered handlers their disposer went
 * with it: teardown took nothing down and the registrations survived into the
 * next composition. A defect in the host, reported at the next restart as a
 * duplicate registration, with nothing to connect the two.
 */
describe('serving a composed set of services', () => {
  it('answers a no-op disposer while nothing is bound', async () => {
    const services = servicesWith(spyRecorder().recorder)
    const served = await services.serveServices([])
    expect(typeof served.dispose).toBe('function')
    expect(() => served.dispose()).not.toThrow()
  })

  it('hands back the bound host’s own disposer', async () => {
    const services = servicesWith(spyRecorder().recorder)
    let disposed = 0
    const own = { dispose: () => void (disposed += 1) }
    services.bindServiceHost(() => own)

    const served = await services.serveServices([])
    expect(served, 'the host’s disposer was replaced').toBe(own)
    served.dispose()
    expect(disposed).toBe(1)
  })

  it('refuses a bound host that returns no disposer, rather than papering over it', async () => {
    const services = servicesWith(spyRecorder().recorder)
    services.bindServiceHost((() => undefined) as never)
    await expect(services.serveServices([])).rejects.toThrow(/no disposer/)
  })

  it('refuses one whose disposer is not callable', async () => {
    const services = servicesWith(spyRecorder().recorder)
    services.bindServiceHost((() => ({ dispose: 'soon' })) as never)
    await expect(services.serveServices([])).rejects.toThrow(/no disposer/)
  })
})

/**
 * WHETHER THIS PLATFORM HAS A DICTIONARY, which only the kernel can answer.
 *
 * ⚠️ `CompanionPane` took it as an OPTIONAL prop defaulting to `false` and the
 * production caller passed nothing — so on macOS, the one platform that has a
 * system dictionary, it was excluded from the cycle and the reader could not
 * select `System dictionary` or `Both` at all. A capability cannot work it out
 * for itself: the platform and `hasDictionary` both live behind the kernel's
 * React entry, which `kernel-public-entry-only` puts out of its reach. So the
 * composition root answers once and every drawer of the control asks.
 */
describe('the system dictionary', () => {
  it('is false where no caller said otherwise', () => {
    expect(servicesWith(spyRecorder().recorder).hasDictionary()).toBe(false)
  })

  it('reports what the composition root was told', () => {
    const services = createKernelServices({
      fs: null,
      storage: null,
      initialBooks: [],
      hasDictionary: true,
    })
    expect(services.hasDictionary()).toBe(true)
    /* AND IT REACHES THE CYCLE. With a dictionary and no gloss there is one
       mode, so nothing moves; the point is that the mode EXISTS, which is
       what the default of `false` was denying on macOS. */
    expect(availableModes(services.hasDictionary(), false)).toEqual(['system'])
    expect(availableModes(services.hasDictionary(), true)).toHaveLength(3)
  })

  it('offers only the gloss when the platform has no dictionary', () => {
    const services = servicesWith(spyRecorder().recorder)
    expect(availableModes(services.hasDictionary(), true)).toEqual(['gloss'])
  })
})

describe('the look-up mode', () => {
  /* An untouched store reads the SHIPPED default, whatever that is — asserted
     through the setting rather than against a literal. This used to read
     `toBe('system')` and carried the comment "which is what makes the
     no-regression rule true"; both were wrong. The no-regression rule is made
     true by `decideLookUp`, whose first branch never reads the preference at
     all, and pinning the literal here meant changing the default broke a test
     that was only ever describing it. What this file owns is the wiring: an
     unset store answers with the fallback. `ui/lookUp.test.ts` owns what the
     fallback then DOES. */
  it('answers with the shipped default when nothing is stored', () => {
    expect(servicesWith(spyRecorder().recorder).lookUp()).toBe(LOOK_UP_SETTING.fallback)
  })

  it('does nothing when only one mode is available', () => {
    const services = servicesWith(spyRecorder().recorder)
    const before = services.lookUp()
    /* A dictionary and no gloss: one mode, so the control is not offered and
       pressing it must not move to a mode that would fail when used.

       UNCHANGED, not equal to some particular mode. The stored value may well
       name a mode this machine cannot serve — that is allowed and deliberate
       (see "A STORED PREFERENCE OUTLIVES THE THING IT NAMES" below), and
       `decideLookUp` resolves it at the point of use. Asserting a literal here
       tested the default, not the no-op. */
    services.cycleLookUp(true, false)
    expect(services.lookUp()).toBe(before)
    /* Neither: no modes at all. */
    services.cycleLookUp(false, false)
    expect(services.lookUp()).toBe(before)
  })

  it('cycles the whole set when both halves are there, and wraps', () => {
    const services = servicesWith(spyRecorder().recorder)
    const seen = [services.lookUp()]
    for (let i = 0; i < LOOK_UP_MODES.length; i++) {
      services.cycleLookUp(true, true)
      seen.push(services.lookUp())
    }
    /* Every mode visited, and back where it started — a cycle, not a walk off
       the end of the list. */
    expect(new Set(seen.slice(0, LOOK_UP_MODES.length))).toEqual(new Set(LOOK_UP_MODES))
    expect(seen[seen.length - 1]).toBe(seen[0])
  })

  /* A STORED PREFERENCE OUTLIVES THE THING IT NAMES. A reader who chose
     `gloss` and then removed the model has a setting pointing at nothing;
     cycling from there must land on what EXISTS rather than on the next entry
     of a list that no longer applies. */
  it('keeps an unavailable preference, and resolves it to what exists', () => {
    const services = servicesWith(spyRecorder().recorder)
    /* Cycle to something that needs the gloss, so removing the model makes
       the STORED choice unavailable — the case the note above describes. */
    services.cycleLookUp(true, true)
    while (services.lookUp() === 'system') services.cycleLookUp(true, true)
    const chosen = services.lookUp()
    const withoutGloss = availableModes(true, false)
    expect(withoutGloss, 'the stored choice was still available, so this proves nothing').not.toContain(chosen)

    /* PRESERVED, NOT REWRITTEN. Re-installing the model must restore what they
       asked for without them asking twice, which only works if the stored
       value survives the model going away. */
    services.cycleLookUp(true, false)
    expect(services.lookUp(), 'the preference was rewritten when its model vanished').toBe(chosen)

    /* And what is USED meanwhile is the one that exists. */
    expect(effectiveMode(services.lookUp(), withoutGloss)).toBe('system')
  })
})
