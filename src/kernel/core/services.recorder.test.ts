import { describe, expect, it } from 'vitest'
import { HLC_MAX_COUNTER, ZERO_DEVICE, compareHlc, deviceOf, hlcOf, makeHlc, type Hlc } from './hlc'
import type { MutationKind, MutationRecorder, MutationToken } from './ports'
import { createKernelServices } from './services'
import { gatedRecorder, servicesWith, spyRecorder } from './servicesWorld.testkit'

/** Two device ids, so a stamp's issuer can be read back off it. */
const DEVICE = '1d8865efc2eaef44'
const OTHER_DEVICE = '2e9976f0d3fbf055'

/**
 * The bind/unbind contract of the recorder and clock ports (C2).
 *
 * Binding is late — the sync journal arrives after the stores exist — and its
 * disposer must RESTORE the previous target, not leave the stores delegating
 * into a journal that has since closed. These tests drive a real write through
 * the store and watch which recorder it reaches.
 */

describe('bindRecorder / bindClock disposers', () => {
  it('restores the default recorder on dispose, so no write reaches a torn-down journal', async () => {
    const base = spyRecorder()
    const journal = spyRecorder()
    const services = servicesWith(base.recorder)

    const unbind = services.bindRecorder(journal.recorder)
    await services.library.update('book_x', (record) => ({ ...record, title: 'A' }))
    await services.drain()
    expect(journal.kinds).toEqual(['record'])
    expect(base.kinds).toEqual([])
    /* THE COMMIT, NOT ONLY THE BEGIN. Reading `kinds` alone watches half the
       bracket: a commit routed to the torn-down journal after dispose would
       satisfy every assertion here, and that is the exact failure this suite
       is named for. */
    expect(journal.commits).toHaveLength(1)
    expect(base.commits).toHaveLength(0)

    unbind.dispose()
    await services.library.update('book_x', (record) => ({ ...record, title: 'B' }))
    await services.drain()
    // The write after unbind reaches the DEFAULT, never the unbound journal.
    expect(journal.kinds).toEqual(['record'])
    expect(base.kinds).toEqual(['record'])
    /* And its commit went with it — the journal took no second commit, which
       is what "no write reaches a torn-down journal" actually means. */
    expect(journal.commits).toHaveLength(1)
    expect(base.commits).toHaveLength(1)
    expect(base.commits[0]?.book).toBe('book_x')
  })

  it('frees the slot so the services can be bound again (re-composition)', () => {
    const services = servicesWith(spyRecorder().recorder)
    const first = services.bindRecorder(spyRecorder().recorder)
    expect(() => services.bindRecorder(spyRecorder().recorder)).toThrow(/already bound/)
    first.dispose()
    expect(() => services.bindRecorder(spyRecorder().recorder)).not.toThrow()
  })

  it('dispose is idempotent and identity-guarded — an old disposer cannot unbind a newer target', async () => {
    const base = spyRecorder()
    const services = servicesWith(base.recorder)
    const first = services.bindRecorder(spyRecorder().recorder)
    first.dispose()
    const second = spyRecorder()
    services.bindRecorder(second.recorder)
    // The stale disposer fires again; it must not touch the new binding.
    first.dispose()
    await services.library.update('book_x', (record) => ({ ...record, title: 'C' }))
    await services.drain()
    expect(second.kinds).toEqual(['record'])
    expect(base.kinds).toEqual([])
  })

  /* ONE TYPED STAMP, not three `as never` literals. The cast was load-bearing
     only because the literal was hand-written: `hlcOf` produces the same value
     with the type intact, so a change to `Hlc` reaches this file instead of
     being silenced three times. */
  const stamp = () => hlcOf(0)

  it('bindClock returns a disposer that frees the slot', () => {
    const services = servicesWith(spyRecorder().recorder)
    const unbind = services.bindClock(stamp)
    expect(() => services.bindClock(stamp)).toThrow(/already bound/)
    unbind.dispose()
    expect(() => services.bindClock(stamp)).not.toThrow()
  })

  it('clock() answers the bound clock, and the legacy wall clock before and after', () => {
    /* ⚠️ **ONE CLOCK PER DEVICE.** A capability minting a stamp of its own
       beside the stores' could order one edit before the removal that preceded
       it; `clock()` is how it asks the one the stores use instead. It reads
       through the SLOT, so a bind and an unbind both reach it. */
    const services = servicesWith(spyRecorder().recorder)
    expect(services.clock().endsWith(`-${ZERO_DEVICE}`)).toBe(true)
    /* AHEAD of the stamp just taken, which is what a live sync clock is. A
       clock bound BEHIND it is held above it — see the suite below — and this
       used `hlcOf(0)`, which would now read as that case instead of this one. */
    const ahead = hlcOf(Date.now() + 60_000, DEVICE)
    const unbind = services.bindClock(() => ahead)
    expect(services.clock()).toBe(ahead)
    unbind.dispose()
    expect(services.clock()).not.toBe(ahead)
    expect(services.clock().endsWith(`-${ZERO_DEVICE}`)).toBe(true)
  })
})

/**
 * THE CLOCK ACROSS A CHANGE OF BINDING.
 *
 * ⚠️ The port read the slot and nothing else, so unbinding a clock that was
 * AHEAD of wall time — which the sync HLC is, once it has met a peer whose
 * clock is — handed the next edit a stamp EARLIER than the one before it, and a
 * last-writer-wins merge then preferred the older edit.
 */
describe('the clock across a change of binding', () => {
  it('never stamps an edit before the last one when a clock ahead of wall time is unbound', () => {
    const services = servicesWith(spyRecorder().recorder)
    const ahead = hlcOf(Date.now() + 60_000, DEVICE)
    const unbind = services.bindClock(() => ahead)
    const last = services.clock()
    unbind.dispose()

    const next = services.clock()
    expect(compareHlc(next, last), 'the stamp after the unbind went backwards').toBeGreaterThan(0)
    expect(compareHlc(services.clock(), next)).toBeGreaterThan(0)
    /* Held above by counter, but still the restored clock's own device. */
    expect(deviceOf(next)).toBe(ZERO_DEVICE)
  })

  it('holds a clock bound behind the last stamp above it, and trusts it again once it overtakes', () => {
    const services = servicesWith(spyRecorder().recorder)
    const early = services.bindClock(() => makeHlc(5_000_000_000_000, 0, DEVICE))
    const last = services.clock()
    early.dispose()

    let wall = 1_000
    services.bindClock(() => makeHlc(wall, 0, OTHER_DEVICE))
    const held = services.clock()
    expect(compareHlc(held, last)).toBeGreaterThan(0)
    expect(deviceOf(held)).toBe(OTHER_DEVICE)

    wall = 6_000_000_000_000
    expect(services.clock(), 'a clock that has overtaken is passed through untouched').toBe(makeHlc(wall, 0, OTHER_DEVICE))
  })

  it('passes one binding’s stamps through exactly as its clock gives them', () => {
    /* NOT A SECOND CLOCK. Within a binding the clock is trusted — a port that
       re-ordered its stamps would be the second clock `clock()` exists to
       prevent — so even a clock that repeats itself is answered verbatim. */
    const fixed = makeHlc(1_700_000_000_000, 0, DEVICE)
    const services = createKernelServices({ fs: null, storage: null, clock: () => fixed })
    expect([services.clock(), services.clock()]).toEqual([fixed, fixed])
  })

  /* ⚠️ **AND THE CLOCK WAS NEVER TOLD** (2026-09-13 verify). A clock bound behind
     the last stamp was held above it by a counter the PORT made up, which the
     clock's own persisted floor never learned — so a relaunch inside that window
     could issue the same stamp again. A clock that can be told is told, and asked
     again: the stamp handed out is the clock's own. */
  it('tells a clock bound behind the last stamp where to start, and hands out its own stamp', () => {
    const services = servicesWith(spyRecorder().recorder)
    const early = services.bindClock(() => makeHlc(5_000_000_000_000, 0, DEVICE))
    const last = services.clock()
    early.dispose()

    let raised = false
    let issued = 0
    const told: string[] = []
    services.bindClock(
      () => makeHlc(raised ? 5_000_000_000_000 : 1_000, (issued += 1), OTHER_DEVICE),
      (stamp) => {
        told.push(stamp)
        raised = true
        issued = 0
      },
    )

    expect(services.clock()).toBe(makeHlc(5_000_000_000_000, 1, OTHER_DEVICE))
    expect(told).toEqual([last])
    expect(services.clock(), 'a clock that was told is trusted again').toBe(makeHlc(5_000_000_000_000, 2, OTHER_DEVICE))
  })

  /* A CLOCK THAT WILL NOT MOVE IS STILL HELD ABOVE: a witness that changes
     nothing leaves the port where it stood before it could tell a clock anything
     — by counter, under the clock's own device. */
  it('holds a clock above by counter when telling it changes nothing', () => {
    const services = servicesWith(spyRecorder().recorder)
    const early = services.bindClock(() => makeHlc(5_000_000_000_000, 0, DEVICE))
    services.clock()
    early.dispose()

    services.bindClock(
      () => makeHlc(1_000, 0, OTHER_DEVICE),
      () => {},
    )

    expect(services.clock()).toBe(makeHlc(5_000_000_000_000, 1, OTHER_DEVICE))
  })

  /* AND A CLOCK THAT REFUSES ITS FLOOR SAYS SO. The sync HLC refuses only a
     stamp implausibly far ahead, which no clock bound here hands out; a refusal is
     a fault to surface at the write, not one to paper over with a stamp the clock
     never agreed to. */
  it('lets a clock that refuses its floor refuse the stamp', () => {
    const services = servicesWith(spyRecorder().recorder)
    const early = services.bindClock(() => makeHlc(5_000_000_000_000, 0, DEVICE))
    services.clock()
    early.dispose()

    services.bindClock(
      () => makeHlc(1_000, 0, OTHER_DEVICE),
      () => {
        throw new Error('witness: stamp implausibly far in the future')
      },
    )

    expect(() => services.clock()).toThrow(/implausibly far in the future/u)
  })

  /* NOT EVEN ONCE MORE. A clock bound after the unbind that answers exactly the
     last stamp handed out is a clock at the floor, not past it — and a stamp
     handed out twice is two edits a merge cannot order. */
  it('holds a clock that answers exactly the last stamp above it', () => {
    const services = servicesWith(spyRecorder().recorder)
    const last = makeHlc(5_000_000_000_000, 3, DEVICE)
    const early = services.bindClock(() => last)
    expect(services.clock()).toBe(last)
    early.dispose()

    services.bindClock(() => last)
    expect(services.clock()).toBe(makeHlc(5_000_000_000_000, 4, DEVICE))
  })

  /* THE NEWEST, NOT THE LATEST. Within a binding a clock is trusted as it is,
     even one that steps back — so the floor a later binding is held above is the
     highest stamp handed out, whichever order they came in. */
  it('holds a later clock above the newest stamp handed out, not the last one', () => {
    for (const order of [
      [5_000_000_000_000, 4_000_000_000_000],
      [4_000_000_000_000, 5_000_000_000_000],
    ]) {
      const services = servicesWith(spyRecorder().recorder)
      const stamps = order.map((ms) => makeHlc(ms, 0, DEVICE))
      let at = 0
      const first = services.bindClock(() => stamps[at++]!)
      expect([services.clock(), services.clock()], 'a binding’s own stamps are passed through as given').toEqual(stamps)
      first.dispose()

      services.bindClock(() => makeHlc(4_500_000_000_000, 0, OTHER_DEVICE))
      expect(services.clock(), `after ${order.join(', ')}`).toBe(makeHlc(5_000_000_000_000, 1, OTHER_DEVICE))
    }
  })

  /* A CLOCK THAT WAS TOLD IS BELIEVED ONLY PAST THE FLOOR. Moved beyond it, its
     own stamp is handed out — not the port's counter above the floor; moved only
     TO it, it is still held above, since the floor was already handed out. */
  it('hands out a told clock’s own stamp once it is past the floor, and holds one that only reached it', () => {
    const floor = makeHlc(5_000_000_000_000, 0, DEVICE)

    const past = servicesWith(spyRecorder().recorder)
    const before = past.bindClock(() => floor)
    past.clock()
    before.dispose()
    let raisedTo: Hlc | null = null
    past.bindClock(
      () => raisedTo ?? makeHlc(1_000, 0, OTHER_DEVICE),
      () => {
        raisedTo = makeHlc(6_000_000_000_000, 0, OTHER_DEVICE)
      },
    )
    expect(past.clock()).toBe(makeHlc(6_000_000_000_000, 0, OTHER_DEVICE))

    const reached = servicesWith(spyRecorder().recorder)
    const early = reached.bindClock(() => floor)
    reached.clock()
    early.dispose()
    let told = false
    reached.bindClock(
      () => (told ? floor : makeHlc(1_000, 0, OTHER_DEVICE)),
      () => {
        told = true
      },
    )
    expect(reached.clock()).toBe(makeHlc(5_000_000_000_000, 1, OTHER_DEVICE))
  })

  /* AND A FULL COUNTER MOVES THE HELD STAMP INTO THE NEXT MILLISECOND, as the
     fallback clock does, rather than asking `makeHlc` for a counter it refuses. */
  it('holds a clock above a stamp whose counter is full by moving to the next millisecond', () => {
    const services = servicesWith(spyRecorder().recorder)
    const full = makeHlc(5_000_000_000_000, HLC_MAX_COUNTER, DEVICE)
    const early = services.bindClock(() => full)
    services.clock()
    early.dispose()

    services.bindClock(() => makeHlc(1_000, 0, OTHER_DEVICE))
    expect(services.clock()).toBe(makeHlc(5_000_000_000_001, 0, OTHER_DEVICE))
  })
})

/**
 * A COMMIT MUST NEVER REACH A RECORDER THAT DID NOT ISSUE ITS BEGIN.
 *
 * An unbind between begin and commit must not reach the retired journal, and
 * the old journal keeps a dangling begin that launch recovery settles because
 * it cannot tell that from a crash. A REBIND was the case that first broke:
 * every capability reload unbinds and binds again, so "resolve the current
 * slot" handed the NEW journal a token it never issued — rejected, after the
 * file write had already happened, leaving a durable unjournalled mutation
 * and a write failure for something that did not fail.
 *
 * ⚠️ **AND THE DEFAULT DID NOT ISSUE IT EITHER.** The fix for the rebind sent
 * the commit to the default instead, and these cases asserted that it arrived
 * there — which a spy happily accepts and a default that checks its own tokens
 * refuses, after the write. A retired bracket's commit now goes to nobody.
 */
/**
 * THE TOKEN THAT REACHES `commit` IS THE ONE `begin` RETURNED.
 *
 * ⚠️ The port used to hand back `{ ...token, [BINDING]: generation }` — a
 * different object. `MutationToken` is an interface, so a recorder is entitled
 * to any shape behind it: a class instance, a key in an identity `Map`, a
 * value with non-enumerable state. Every one of those would be given something
 * it never issued and would rightly refuse it — AFTER the file write, so the
 * mutation is durable, unjournalled, and reported to the reader as a failure.
 *
 * The journal this ships with happens to use a plain object, which is why
 * nothing caught it.
 */
describe('the token crossing the recorder port', () => {
  it('is the recorder’s own object, not a copy of its fields', async () => {
    const issued: MutationToken[] = []
    const committed: MutationToken[] = []
    /* A token with identity and nothing enumerable to copy — the shape a
       spread silently destroys. */
    class Ticket implements MutationToken {
      constructor(
        readonly book: string,
        readonly what: MutationKind,
      ) {}
    }
    const journal: MutationRecorder = {
      begin: async (book, what) => {
        const ticket = new Ticket(book, what)
        issued.push(ticket)
        return ticket
      },
      commit: async (token) => void committed.push(token),
    }
    const services = servicesWith(journal)
    await services.library.update('book_x', (record) => ({ ...record, title: 'A' }))
    await services.drain()

    expect(issued).toHaveLength(1)
    expect(committed).toHaveLength(1)
    expect(committed[0], 'the port handed back a copy').toBe(issued[0])
    expect(committed[0], 'the prototype did not survive').toBeInstanceOf(Ticket)
  })

  /* AND A RECORDER KEYING BY IDENTITY STILL WORKS, which is the failure the
     copy produced in practice: an open-bracket table missing its own key. */
  it('lets a recorder match its own token by identity', async () => {
    const open = new Set<MutationToken>()
    let refused = 0
    const journal: MutationRecorder = {
      begin: async (book, what) => {
        const token = { book, what }
        open.add(token)
        return token
      },
      commit: async (token) => {
        if (!open.delete(token)) refused += 1
      },
    }
    const services = servicesWith(journal)
    await services.library.update('book_x', (record) => ({ ...record, title: 'B' }))
    await services.drain()

    expect(refused, 'the journal was handed a token it never issued').toBe(0)
    expect(open.size, 'the bracket was left open').toBe(0)
  })
})

/** The title the shelf holds for the one book, which is how a landed write is told from a lost one. */
const titleOf = (services: ReturnType<typeof servicesWith>) =>
  services.library.getSnapshot().find((one) => one.bookId === 'book_x')?.title

describe('a bracket that spans a rebind', () => {
  it('commits to nobody: not the journal bound since, and not the default that never issued it', async () => {
    const base = spyRecorder()
    const second = spyRecorder()
    const services = servicesWith(base.recorder)

    /* The rebind happens INSIDE `begin`, which is the only way to hold a
     * bracket open across it without exposing the port: the store has already
     * called begin and has not yet called commit. */
    let unbind: { dispose(): void } | null = null
    const first: MutationRecorder = {
      begin: async (book: string, what: MutationKind): Promise<MutationToken> => {
        unbind?.dispose()
        services.bindRecorder(second.recorder)
        return { book, what }
      },
      commit: async () => {
        throw new Error('the issuing journal has closed and must not be committed to')
      },
    }
    unbind = services.bindRecorder(first)

    await services.library.update('book_x', (record) => ({ ...record, title: 'A' }))
    await services.drain()

    /* The journal bound during the bracket must not have seen a token it
     * never issued — and nor may the default, which did not issue it either. */
    expect(second.commits).toEqual([])
    expect(base.commits).toEqual([])
    /* And the write itself landed: an abandoned commit is not a lost write. */
    expect(titleOf(services)).toBe('A')
  })

  /* THE REFUSAL THE SPY COULD NOT SEE. A default that holds its own open
     brackets refuses a token it never issued, and it refused it after the
     record was on disk — so the update rejected for a write that had landed. */
  it('does not hand a default that checks its tokens one it never issued', async () => {
    const issuedByDefault = new Set<MutationToken>()
    let refused = 0
    const checking: MutationRecorder = {
      begin: async (book, what) => {
        const token = { book, what }
        issuedByDefault.add(token)
        return token
      },
      commit: async (token) => {
        if (issuedByDefault.delete(token)) return
        refused += 1
        throw new Error('the default was handed a token it never issued')
      },
    }
    const services = servicesWith(checking)
    let unbind: { dispose(): void } | null = null
    const retiring: MutationRecorder = {
      begin: async (book: string, what: MutationKind): Promise<MutationToken> => {
        unbind?.dispose()
        services.bindRecorder(spyRecorder().recorder)
        return { book, what }
      },
      commit: async () => {
        throw new Error('the issuing journal has closed and must not be committed to')
      },
    }
    unbind = services.bindRecorder(retiring)

    await expect(services.library.update('book_x', (record) => ({ ...record, title: 'A' }))).resolves.toBeUndefined()
    await services.drain()
    expect(refused).toBe(0)
    expect(titleOf(services)).toBe('A')
  })

  /* AND THE DEFAULT'S OWN BRACKETS STILL CLOSE. It is never unbound, so a
     bracket it opened is committed to it however the slot has moved since —
     which is the one fall-through that was always right. */
  it('still commits a bracket the default opened, after a journal was bound over it', async () => {
    const base = gatedRecorder()
    const journal = spyRecorder()
    const services = servicesWith(base.recorder)

    const writing = services.library.update('book_x', (record) => ({ ...record, title: 'A' }))
    await base.began
    services.bindRecorder(journal.recorder)
    base.release()
    await writing
    await services.drain()

    expect(base.commits).toHaveLength(1)
    expect(base.commits[0]?.book).toBe('book_x')
    expect(journal.commits).toEqual([])
  })

  it('still commits to the same journal when nothing rebound', async () => {
    const base = spyRecorder()
    const journal = spyRecorder()
    const services = servicesWith(base.recorder)
    services.bindRecorder(journal.recorder)

    await services.library.update('book_x', (record) => ({ ...record, title: 'B' }))
    await services.drain()
    expect(journal.commits).toHaveLength(1)
    expect(base.commits).toEqual([])
  })
})

/**
 * A REBIND THAT LANDS MID-WRITE.
 *
 * The cases above switch recorders BETWEEN completed writes, which is the easy
 * half. The hard half is the one the app actually does: the sync capability
 * binds during startup and unbinds during teardown, both while the write queue
 * may hold work — so a bracket can be OPENED against one recorder and closed
 * after the slot has moved.
 *
 * A commit routed to whichever recorder is current at commit time closes a
 * bracket the new one never opened, and leaves the old one's begin dangling
 * forever. A dangling begin is what the journal reads as an unfinished write
 * on every open, which is what drives recovery and the verify pass.
 */
describe('a recorder rebound while a write is in flight', () => {
  it('leaves the issuing bracket dangling and commits to nobody', async () => {
    const first = gatedRecorder()
    const second = spyRecorder()
    /* THE DEFAULT IS WATCHED, AND THE WRITE WITH IT. This said the default had
       to RECEIVE the commit, because otherwise "routed to the default" could not
       be told from "dropped on the floor". But the default never issued the
       token, so no entry could land there that was not bogus — the outcome that
       matters is the WRITE, which landing proves was not lost. */
    const base = spyRecorder()
    const services = servicesWith(base.recorder)
    const unbind = services.bindRecorder(first.recorder)

    /* The write starts, and its `begin` is held open. */
    const writing = services.library.update('book_x', (record) => ({ ...record, title: 'A' }))
    await first.began

    /* The journal is torn down and another bound WHILE the bracket is open —
     * exactly what a capability restart does. */
    unbind.dispose()
    services.bindRecorder(second.recorder)

    first.release()
    await writing
    await services.drain()

    /* THE BEGIN WENT TO THE RECORDER THAT WAS BOUND. */
    expect(first.kinds).toEqual(['record'])

    /* AND THE COMMIT REACHES NOBODY — not either journal, and not the default.
     *
     * This is `services.ts`'s documented choice, and it is written down here
     * because the cost was not: the old journal keeps a DANGLING BEGIN, and a
     * dangling begin is indistinguishable from a crash. So the NEXT open of
     * that library runs recovery and the unclean-shutdown verify pass for a
     * write that in fact completed — once, not forever: `recoverDangling`
     * commits the exact begin and the following clean close clears the flag
     * (`journal.test.ts`, "#5 close keeps the dirty flag"). The cost is one
     * verify pass, which on a large shelf is one digest per tracked surface
     * before the first paint, and it is paid on an ORDINARY restart rather
     * than on a crash.
     *
     * The alternatives it rejects are worse in a different way: committing to
     * whatever is bound NOW, or to the default, hands a recorder a token it
     * never issued, which it may refuse — and the data write has already
     * landed, so the refusal reports a failure for something that did not fail.
     *
     * Pinned rather than argued about. If the routing changes, this is the
     * assertion that says which of the outcomes was chosen. */
    expect(first.commits).toEqual([])
    expect(second.kinds).toEqual([])
    expect(second.commits).toEqual([])
    expect(base.commits).toEqual([])
    expect(base.kinds).toEqual([])
    /* And the write landed. Without this the assertions above are satisfied
       by a write that was lost along with its commit. */
    expect(titleOf(services)).toBe('A')
  })

  it('sends the NEXT write to the recorder bound now', async () => {
    const first = spyRecorder()
    const second = spyRecorder()
    const services = servicesWith(spyRecorder().recorder)
    const unbind = services.bindRecorder(first.recorder)
    await services.library.update('book_x', (record) => ({ ...record, title: 'A' }))
    await services.drain()

    unbind.dispose()
    services.bindRecorder(second.recorder)
    await services.library.update('book_x', (record) => ({ ...record, title: 'B' }))
    await services.drain()

    expect(first.kinds).toEqual(['record'])
    expect(second.kinds).toEqual(['record'])
  })
})
