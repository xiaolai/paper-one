import { describe, expect, it, vi } from 'vitest'
import { NOT_CONFIGURED, type CompanionProvider } from './companion'
import { compareHlc, parseHlc } from './hlc'
import { monotonicClock } from './services'
import { NO_GLOSS, type GlossProvider } from './gloss'
import { NO_WORK_LINE, type WorkLine } from './ports'
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
    const provider: GlossProvider = { available: true, installable: true, gloss: async () => 'a meaning' }
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
    services.bindGloss({ available: true, installable: true, gloss: async () => 'x' })
    expect(() => services.bindGloss({ available: true, installable: true, gloss: async () => 'y' })).toThrow(/already bound/)
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

  it('disposes the bound host’s own disposer, rather than replacing it', async () => {
    /* This asserted disposer IDENTITY while a slot allowed one host. It is a
       SET since phase 18 — two transports serve the same services — so the
       answer is a composite and identity is no longer the thing to check.
       What it was guarding is unchanged and is checked directly: the host's
       own disposer runs, and exactly once. Replaced by a no-op it would not. */
    const services = servicesWith(spyRecorder().recorder)
    let disposed = 0
    const own = { dispose: () => void (disposed += 1) }
    services.bindServiceHost(() => own)

    const served = await services.serveServices([])
    served.dispose()
    expect(disposed, 'the host’s disposer was replaced').toBe(1)

    /* ⚠️ **"EXACTLY ONCE" WAS ASSERTED FROM A SINGLE CALL.** One `dispose()`
     * cannot tell "runs once per call" from "runs once ever" — and the second
     * is the property that matters, because a composite disposer is held by a
     * composition root that may tear down more than once: an unmount and a
     * shutdown handshake both reach for it. A host disposed twice unregisters
     * handlers a LATER composition has already bound, and the symptom is a
     * service that stops answering with nothing in the log. */
    served.dispose()
    served.dispose()
    expect(disposed, 'a second teardown ran the host’s disposer again').toBe(1)
  })

  it('serves every bound host, and disposes them all', async () => {
    /* The reason the slot became a set: `peer` and `webhost` are two transports
       carrying the SAME services. A service reachable over one wire and not the
       other would be a difference nothing in the service table describes. */
    const services = servicesWith(spyRecorder().recorder)
    const seen: string[] = []
    const disposed: string[] = []
    services.bindServiceHost(() => {
      seen.push('a')
      return { dispose: () => void disposed.push('a') }
    })
    services.bindServiceHost(() => {
      seen.push('b')
      return { dispose: () => void disposed.push('b') }
    })

    const served = await services.serveServices([])
    expect(seen.sort()).toEqual(['a', 'b'])
    served.dispose()
    expect(disposed.sort()).toEqual(['a', 'b'])
  })

  it('unbinding one host leaves the other serving', async () => {
    const services = servicesWith(spyRecorder().recorder)
    const seen: string[] = []
    const first = services.bindServiceHost(() => {
      seen.push('a')
      return { dispose: () => {} }
    })
    services.bindServiceHost(() => {
      seen.push('b')
      return { dispose: () => {} }
    })

    first.dispose()
    await services.serveServices([])
    expect(seen).toEqual(['b'])
  })

  it('takes down the hosts that did serve when another returns no disposer', async () => {
    /* A partial serve left running is the leak the refusal below exists to
       prevent, arriving by a different door: one host registered handlers and
       another broke its contract, so nothing ever disposed the first. */
    const services = servicesWith(spyRecorder().recorder)
    let disposed = 0
    services.bindServiceHost(() => ({ dispose: () => void (disposed += 1) }))
    services.bindServiceHost((() => undefined) as never)

    await expect(services.serveServices([])).rejects.toThrow(/no disposer/)
    expect(disposed, 'the host that served properly was left running').toBe(1)
  })

  /**
   * ⚠️ **A HOST THAT THREW TOOK THE OTHERS' DISPOSERS WITH IT.**
   *
   * `serveServices` used `Promise.all`, which rejects on the first rejection
   * and DISCARDS the other results — so a host that had already registered its
   * handlers was left running with nothing holding its disposer. Exactly the
   * partial serve the "returned no disposer" case above was written to
   * prevent, arriving by the one door that check could not see.
   */
  it('takes down the hosts that did serve when another THROWS', async () => {
    const services = servicesWith(spyRecorder().recorder)
    let disposed = 0
    services.bindServiceHost(() => ({ dispose: () => void (disposed += 1) }))
    services.bindServiceHost(() => {
      throw new Error('this transport could not start')
    })

    await expect(services.serveServices([])).rejects.toThrow(/could not start/)
    expect(disposed, 'the host that served properly was left running').toBe(1)
  })

  it('takes them down when another host REJECTS asynchronously', async () => {
    const services = servicesWith(spyRecorder().recorder)
    let disposed = 0
    services.bindServiceHost(() => ({ dispose: () => void (disposed += 1) }))
    services.bindServiceHost(async () => {
      await Promise.resolve()
      throw new Error('the socket refused')
    })

    await expect(services.serveServices([])).rejects.toThrow(/socket refused/)
    expect(disposed).toBe(1)
  })

  /*
   * ⚠️ **TWO BINDS OF ONE FUNCTION ARE TWO BINDINGS.** The registry was a
   * `Set<ServiceHost>`, so binding the same function twice collapsed to one
   * entry and either disposer removed the other's binding — a live transport
   * unbound by a teardown that had nothing to do with it. Two transports
   * sharing a module-level host function is what a shared adapter looks like.
   */
  it('keeps two bindings of the same host function apart', async () => {
    const services = servicesWith(spyRecorder().recorder)
    let served = 0
    const shared: Parameters<typeof services.bindServiceHost>[0] = () => {
      served += 1
      return { dispose: () => {} }
    }
    const first = services.bindServiceHost(shared)
    services.bindServiceHost(shared)

    /* Both bindings serve — the registry holds two, not one. */
    await services.serveServices([])
    expect(served, 'the second bind of one function replaced the first').toBe(2)

    /* And disposing one leaves the other bound. */
    first.dispose()
    served = 0
    await services.serveServices([])
    expect(served, 'disposing one binding unbound the other').toBe(1)
  })

  /**
   * ⚠️ **AND A DISPOSER THAT THROWS MUST NOT ABORT THE UNWIND.**
   *
   * The unwind loop called `dispose()` bare, three times over in three places.
   * A host whose disposer threw stopped the loop where it stood — so every
   * host after it stayed registered, which is the very partial serve the
   * unwind exists to prevent, arriving by the one door it did not watch.
   *
   * Worse, the throw REPLACED the original reason: the caller was told a
   * disposer failed instead of being told why anything was unwinding at all.
   * Found by audit.
   */
  it('disposes every host even when one disposer throws, and keeps the original error', async () => {
    const services = servicesWith(spyRecorder().recorder)
    const disposed: string[] = []
    services.bindServiceHost(() => ({ dispose: () => void disposed.push('first') }))
    services.bindServiceHost(() => ({
      dispose: () => {
        throw new Error('this disposer is broken')
      },
    }))
    services.bindServiceHost(() => ({ dispose: () => void disposed.push('third') }))
    services.bindServiceHost(() => {
      throw new Error('this transport could not start')
    })

    /* THE ORIGINAL FAILURE, not the disposer's — the disposer's is a casualty
       of the unwind and says nothing about why it started. */
    await expect(services.serveServices([])).rejects.toThrow(/could not start/)
    /* AND THE HOST PAST THE BROKEN DISPOSER WAS STILL TAKEN DOWN. */
    expect(disposed, 'a throwing disposer left a later host registered').toEqual(['first', 'third'])
  })

  /* The same rule on the ordinary path: unserving is called from teardowns
     that have nothing to do with the host that failed, so one broken disposer
     must neither abort the others nor throw into somebody else's cleanup. */
  it('unserves every host even when one disposer throws, without throwing', async () => {
    const services = servicesWith(spyRecorder().recorder)
    const disposed: string[] = []
    services.bindServiceHost(() => ({ dispose: () => void disposed.push('first') }))
    services.bindServiceHost(() => ({
      dispose: () => {
        throw new Error('this disposer is broken')
      },
    }))
    services.bindServiceHost(() => ({ dispose: () => void disposed.push('third') }))

    const served = await services.serveServices([])
    expect(() => served.dispose()).not.toThrow()
    expect(disposed).toEqual(['first', 'third'])
  })

  /**
   * DISPOSAL IS IDEMPOTENT — `Disposable` says so, and the composite did not.
   *
   * A second call ran every child again, so a caller disposing defensively (a
   * teardown path and an unmount, say) double-disposed every host beneath it.
   * The children are not required to tolerate that and the contract does not
   * ask them to.
   */
  it('runs each host disposer exactly once, however often it is disposed', async () => {
    const services = servicesWith(spyRecorder().recorder)
    const counts = { first: 0, second: 0 }
    services.bindServiceHost(() => ({ dispose: () => void (counts.first += 1) }))
    services.bindServiceHost(() => ({ dispose: () => void (counts.second += 1) }))

    const served = await services.serveServices([])
    served.dispose()
    served.dispose()
    served.dispose()
    expect(counts).toEqual({ first: 1, second: 1 })
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

/*
 * ⚠️ **TWO WHOLE `describe` BLOCKS WERE HERE — 11 CASES — AND THEY ARE
 * DELETED WITH WHAT THEY TESTED.**
 *
 * `the system dictionary` held `KernelServices.hasDictionary()`; `the look-up
 * mode` held `lookUp()` and `cycleLookUp()` — the shipped default, the no-op
 * when only one mode is available, the wrap-around, and the rule that a stored
 * preference outlives the model it names. All three accessors are gone with
 * the three-mode `Look up` they served.
 *
 * WHAT IS WORTH CARRYING FORWARD, because it was a real defect and the shape
 * recurs: `hasDictionary` was a fact the composition root computed and passed
 * down, `CompanionPane` took it as an OPTIONAL prop defaulting to `false`, and
 * the production caller passed nothing — so on macOS, the one platform that
 * had a system dictionary, it was silently excluded from the cycle and the
 * reader could not select `System dictionary` or `Both` at all.
 *
 * The replacement fact is `GlossProvider.installable`, and it is deliberately
 * shaped so the same defect cannot recur: it is a REQUIRED field on the object
 * that knows the answer, not an optional argument threaded through a root that
 * has to remember to pass it. `gloss.test.ts` pins the `NO_GLOSS` end and
 * `ui/lookUp.test.ts` pins what the reader UI does with it.
 */

describe('the fallback clock', () => {
  it('never answers the same stamp twice, and moves on with the millisecond', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1_700_000_000_000)
      const clock = monotonicClock()
      const [a, b, c] = [clock(), clock(), clock()]
      expect(a).not.toBe(b)
      expect(b).not.toBe(c)
      expect(compareHlc(a, b)).toBeLessThan(0)
      expect(compareHlc(b, c)).toBeLessThan(0)
      vi.setSystemTime(1_700_000_000_001)
      const d = clock()
      expect(compareHlc(c, d)).toBeLessThan(0)
      expect(parseHlc(d).counter).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a host whose disposer cannot even be read', () => {
  it('is refused like one that returned none, and the hosts that served are taken down first', async () => {
    const services = servicesWith(spyRecorder().recorder)
    let disposed = 0
    services.bindServiceHost(() => ({ dispose: () => void (disposed += 1) }))
    services.bindServiceHost(
      () =>
        ({
          get dispose(): () => void {
            throw new Error('no disposer today')
          },
        }) as never,
    )
    await expect(services.serveServices([])).rejects.toThrow(/no disposer/u)
    expect(disposed, 'the host that served properly was left running').toBe(1)
  })
})

describe('the clock slot, held to the letter', () => {
  it('stamps the first millisecond of time itself, and refuses a second clock by name', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(0)
      const clock = monotonicClock()
      expect(parseHlc(clock()).ms).toBe(0)
      expect(parseHlc(clock()).counter).toBe(1)
    } finally {
      vi.useRealTimers()
    }
    const services = servicesWith(spyRecorder().recorder)
    const bound = services.bindClock(() => '018bcfe56809-0000-1d8865efc2eaef44' as never)
    expect(() => services.bindClock(() => '018bcfe56809-0001-1d8865efc2eaef44' as never)).toThrow(/bindClock: the clock port is already bound/u)
    bound.dispose()
  })
})

describe('the clock’s counter, exhausted', () => {
  it('moves into the next millisecond rather than throwing', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1_700_000_000_000)
      const clock = monotonicClock()
      let last = clock()
      for (let i = 0; i < 65_540; i++) {
        const next = clock()
        expect(compareHlc(last, next)).toBeLessThan(0)
        last = next
      }
      expect(parseHlc(last).ms).toBe(1_700_000_000_001)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the hash port — BLAKE3 by the peer plugin, bound late (WI-23.C5)', () => {
  it('answers null until bound, the port while bound, and null again once released', async () => {
    const services = servicesWith(spyRecorder().recorder)
    expect(services.hashes()).toBeNull()
    const port = { hashFile: vi.fn(() => Promise.resolve({ blake3: 'ab'.repeat(32), size: 3 })) }
    const bound = services.bindHashPort(port)
    expect(await services.hashes()!.hashFile('books/b', 'cover.jpg')).toEqual({ blake3: 'ab'.repeat(32), size: 3 })
    /* One at a time, like every slot: a second binder is refused rather than quietly replacing the first. */
    expect(() => services.bindHashPort(port)).toThrow(/already bound/u)
    bound.dispose()
    expect(services.hashes()).toBeNull()
  })
})
