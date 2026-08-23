import { describe, expect, it } from 'vitest'
import { hlcOf } from './hlc'
import type { MutationKind, MutationRecorder, MutationToken } from './ports'
import { gatedRecorder, servicesWith, spyRecorder } from './servicesWorld.testkit'

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
})

/**
 * A COMMIT MUST NEVER REACH A JOURNAL THAT DID NOT ISSUE ITS BEGIN.
 *
 * An unbind between begin and commit was already handled: the commit falls to
 * the default, the old journal keeps a dangling begin, and launch recovery
 * settles it because it cannot tell that from a crash. A REBIND was not.
 * Every capability reload unbinds and binds again, so "resolve the current
 * slot" handed the NEW journal a token it never issued — rejected, after the
 * file write had already happened, leaving a durable unjournalled mutation
 * and a write failure for something that did not fail.
 */
describe('a bracket that spans a rebind', () => {
  it('sends the commit to the default, not to the journal bound since', async () => {
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
     * never issued. */
    expect(second.commits).toEqual([])
    /* It went to the default — where an unbind already sent it. */
    expect(base.commits).toHaveLength(1)
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
  it('leaves the issuing bracket dangling and sends the commit to the default', async () => {
    const first = gatedRecorder()
    const second = spyRecorder()
    /* THE DEFAULT IS KEPT, NOT DISCARDED. Asserting only that neither `first`
       nor `second` was committed to cannot tell "routed to the default" from
       "dropped on the floor" — and those are opposite outcomes: one is the
       documented fall-through, the other loses a journal entry. */
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

    /* AND THE COMMIT REACHES NEITHER — it falls through to the default.
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
     * The alternative it rejects is worse in a different way: committing to
     * whatever is bound NOW hands a newly bound journal a token it never
     * issued, which it refuses — and the data write has already landed, so the
     * refusal reports a failure for something that did not fail.
     *
     * Pinned rather than argued about. If the routing changes, this is the
     * assertion that says which of the three outcomes was chosen. */
    expect(first.commits).toEqual([])
    expect(second.kinds).toEqual([])
    expect(second.commits).toEqual([])
    /* And it landed — exactly once, on the book that was written. Without
       this the previous three assertions are satisfied by a lost commit. */
    expect(base.commits).toHaveLength(1)
    expect(base.commits[0]?.book).toBe('book_x')
    expect(base.kinds).toEqual([])
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
