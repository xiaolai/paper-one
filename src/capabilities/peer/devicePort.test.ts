import { describe, expect, it, vi } from 'vitest'
import type { WirePeer } from './lib/wire'
import { fakeWire } from './lib/fakeWire.testkit'
import { devicePortOver, deviceRow, personPortOver, publishPortOver, readRole, releasePeer, serveWhenShelf } from './index'

/**
 * THE `device` NOUN'S ADAPTER — the three operations that change who this
 * shelf trusts.
 *
 * They lived inline in the capability's `start`, which needs a composed app
 * around it, so not one of them had ever been executed by a test: not the
 * refusal translation, not the read-back that catches a dropped grant, not
 * the concurrent-forget behaviour that exists because two of them raced in
 * the field. These are authorisation mutations reachable over the wire.
 */

const PEER: WirePeer = {
  id: 'peer-1',
  name: 'Paper on macOS',
  platform: 'macos',
  role: 'satchel',
  grants: ['book:read'],
  pairedAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_100_000,
  lastAddrs: ['198.18.0.1:7842'],
} as WirePeer

/** A plugin whose stored peers the test controls. */
function plugin(initial: readonly WirePeer[] = [PEER]) {
  let peers = [...initial]
  const calls = { setGrants: 0, forgetPeer: 0, listPeers: 0 }
  return {
    calls,
    peers: () => peers,
    listPeers: async () => {
      calls.listPeers += 1
      return peers
    },
    setGrants: async (id: string, grants: readonly string[]) => {
      calls.setGrants += 1
      const at = peers.findIndex((one) => one.id === id)
      if (at === -1) throw { kind: 'peerUnknown' }
      peers = peers.map((one, index) => (index === at ? { ...one, grants: [...grants] } : one))
    },
    forgetPeer: async (id: string) => {
      calls.forgetPeer += 1
      if (!peers.some((one) => one.id === id)) throw { kind: 'peerUnknown' }
      peers = peers.filter((one) => one.id !== id)
    },
  }
}

describe('deviceRow', () => {
  /**
   * `lastAddrs` IS THIS LAN'S SHAPE — internal hostnames and private
   * addresses — and no caller of `device.list` needs it to name a device.
   * Built from named fields rather than spread, so it cannot be published by
   * accident and neither can whatever the plugin adds next.
   */
  it('publishes exactly the declared fields and nothing else', () => {
    const row = deviceRow(PEER)
    expect(Object.keys(row).sort()).toEqual(['grants', 'id', 'lastSeenAt', 'name', 'pairedAt', 'platform', 'role'])
    expect(JSON.stringify(row)).not.toContain('198.18')
    expect(row).toMatchObject({ id: 'peer-1', role: 'satchel', platform: 'macos' })
  })

  /* THE GRANTS ARE COPIED. They are the plugin's own array, and a caller that
   * sorted or pushed to what it was handed would be editing the
   * authorisation record this process is holding. */
  it('hands out a copy of the grants, not the plugin’s array', () => {
    const row = deviceRow(PEER)
    expect(row.grants).toEqual(PEER.grants)
    expect(row.grants).not.toBe(PEER.grants)
    ;(row.grants as string[]).push('shelf:admin')
    expect(PEER.grants).toEqual(['book:read'])
  })
})

describe('device.list', () => {
  it('projects every stored peer', async () => {
    const port = devicePortOver(plugin([PEER, { ...PEER, id: 'peer-2' }]))
    expect((await port.list()).map((one) => one.id)).toEqual(['peer-1', 'peer-2'])
  })

  it('answers an empty list for a plugin with no peers', async () => {
    expect(await devicePortOver(plugin([])).list()).toEqual([])
  })
})

describe('device.grant', () => {
  it('stores the grants and answers with the peer as it now stands', async () => {
    const backing = plugin()
    const port = devicePortOver(backing)
    const after = await port.grant('peer-1', ['book:*', 'mark:read'])
    expect(after.grants).toEqual(['book:*', 'mark:read'])
    expect(backing.peers()[0]?.grants).toEqual(['book:*', 'mark:read'])
  })

  /**
   * THE ANSWER IS READ BACK, NOT ECHOED.
   *
   * The plugin is the authority on what it stored. A caller told "these are
   * the grants" from its own request would never learn that one had been
   * dropped — which is precisely the case where a peer ends up with less
   * access than the operator believes they granted.
   */
  it('reports what the plugin actually kept, not what was asked for', async () => {
    const backing = plugin()
    const dropping = {
      ...backing,
      setGrants: async (id: string, grants: readonly string[]) =>
        backing.setGrants(id, grants.filter((one) => one !== 'shelf:admin')),
    }
    const after = await devicePortOver(dropping).grant('peer-1', ['book:*', 'shelf:admin'])
    expect(after.grants).toEqual(['book:*'])
  })

  /**
   * THE PLUGIN'S REFUSAL, TRANSLATED. `peerUnknown` is not a `ServiceError`,
   * so the envelope carried it as `internal` — the generic code a caller
   * cannot branch on — for a condition with a perfectly good name.
   */
  it('refuses an unknown peer by name rather than as an internal fault', async () => {
    const port = devicePortOver(plugin([]))
    await expect(port.grant('nobody', ['book:*'])).rejects.toMatchObject({
      code: 'not-found',
      message: 'no peer nobody',
      retryable: false,
    })
  })

  /* A PEER THAT VANISHED BETWEEN THE WRITE AND THE READ-BACK gets the same
   * name, because it is the same fact. */
  it('refuses when the peer disappears between the write and the read-back', async () => {
    const backing = plugin()
    const racing = {
      ...backing,
      listPeers: async () => (backing.calls.setGrants > 0 ? [] : backing.peers()),
    }
    await expect(devicePortOver(racing).grant('peer-1', ['book:*'])).rejects.toMatchObject({ code: 'not-found' })
  })

  /* ANY OTHER FAILURE IS CARRIED OUT AS ITSELF. Translating everything into
   * `not-found` would tell an operator a peer is gone when the plugin simply
   * could not be reached. */
  it('carries an unrelated plugin failure through untranslated', async () => {
    const backing = plugin()
    const broken = {
      ...backing,
      setGrants: async () => {
        throw new Error('the plugin is not responding')
      },
    }
    await expect(devicePortOver(broken).grant('peer-1', ['book:*'])).rejects.toThrow(/not responding/)
  })
})

describe('device.forget', () => {
  it('revokes the pairing and says it did', async () => {
    const backing = plugin()
    expect(await devicePortOver(backing).forget('peer-1')).toBe(true)
    expect(backing.peers()).toEqual([])
  })

  /**
   * TWO CONCURRENT FORGETS BOTH SUCCEED — one deletes, the other reports
   * "there was nothing to forget".
   *
   * This was a pre-check followed by a delete, two separate IPC calls: both
   * saw the peer, one deleted it, and the other's delete failed on a peer that
   * had just gone — reported as an error for doing exactly what was asked.
   */
  it('does not fail the loser of a race with another forget', async () => {
    const backing = plugin()
    const port = devicePortOver(backing)
    const [first, second] = await Promise.all([port.forget('peer-1'), port.forget('peer-1')])
    expect([first, second].filter(Boolean)).toHaveLength(1)
    expect([first, second]).toContain(false)
    expect(backing.peers()).toEqual([])
  })

  it('answers false for a peer that was never there', async () => {
    expect(await devicePortOver(plugin([])).forget('nobody')).toBe(false)
  })

  it('carries an unrelated plugin failure through rather than reporting false', async () => {
    const backing = plugin()
    const broken = {
      ...backing,
      forgetPeer: async () => {
        throw new Error('the plugin is not responding')
      },
    }
    await expect(devicePortOver(broken).forget('peer-1')).rejects.toThrow(/not responding/)
  })
})

/**
 * THE ROLE READ IS ASKED EXACTLY ONCE PER COMPOSITION, so whatever it answers
 * decides whether a shelf serves for the rest of the session.
 *
 * A single transient failure used to resolve to "satchel" — which serves
 * nothing — so a shelf that lost one race at startup silently served nothing
 * until the app was restarted.
 */
/**
 * ONE PORT PER WIRE. The circle's publisher refuses to sign through any port
 * but the one that answered `mine()`, by identity — so `publishPort()` has to
 * answer the SAME object for as long as the same peer is running, and a new
 * one only when the wire is replaced. It built a fresh object per call, and
 * against the real plugin every page signing failed.
 */
describe('the publish port over a wire', () => {
  it('is one object per wire, and another for another wire', () => {
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-1' })
    const port = publishPortOver(wire)
    expect(publishPortOver(wire)).toBe(port)
    expect(publishPortOver(fakeWire({ role: 'shelf', endpointId: 'shelf-2' }))).not.toBe(port)
  })
})

/**
 * THE ROSTER'S SIZE IS READ, NOT MINTED. `devices()` went through
 * `circleMine`, which renews a due delegation and refuses a leaf whose
 * delegation ran out — so refreshing the Circle panel wrote credentials or
 * became an error, for a count that was on disk the whole time.
 */
describe('the person port’s device count', () => {
  const mine = {
    person: 'p1',
    device: 'd1',
    roster: ['d1', 'd2', 'd3'],
    revocations: 0,
    delegation: { person: 'p1', device: 'd1', notBefore: 0, notAfter: 1, roster: 1, sig: 's' },
  }

  it('counts the roster the file holds without asking the wire to mint or renew', async () => {
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-1' })
    /* `mine` is the fake's own field — what its `circleRoster` reads, as the real command reads the file. */
    const held = wire as unknown as { mine: typeof mine | null }
    const minted = vi.spyOn(wire, 'circleMine')
    held.mine = mine
    expect(await personPortOver(wire).devices()).toBe(3)
    held.mine = null
    expect(await personPortOver(wire).devices()).toBe(0)
    expect(minted).not.toHaveBeenCalled()
  })
})

describe('readRole', () => {
  const quiet = { warn: () => {} }

  it('answers the role when the plugin is ready', async () => {
    expect(await readRole({ localRole: async () => 'shelf' }, () => false, quiet)).toBe('shelf')
  })

  it('retries a plugin that is not ready yet, rather than concluding satchel', async () => {
    vi.useFakeTimers()
    try {
      let tries = 0
      const port = {
        localRole: async () => {
          tries += 1
          if (tries < 3) throw new Error('not ready')
          return 'shelf' as const
        },
      }
      const answer = readRole(port, () => false, quiet)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await answer).toBe('shelf')
      expect(tries).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  /* THE WAIT IS COUNTED IN POLLS, NOT READ OFF THE CLOCK. `Date.now()` is
   * not monotonic: set back an hour during the backoff, a wait measured as
   * `now - started` held the shelf's services for the hour. The retry must
   * come at the backoff whatever the wall clock does. */
  it('retries on schedule even when the wall clock is set back during the wait', async () => {
    vi.useFakeTimers()
    try {
      let tries = 0
      const port = {
        localRole: async () => {
          tries += 1
          if (tries < 2) throw new Error('not ready')
          return 'satchel' as const
        },
      }
      const answer = readRole(port, () => false, quiet)
      /* The clock jumps back an hour once the wait has begun. */
      await vi.advanceTimersByTimeAsync(50)
      vi.setSystemTime(Date.now() - 3_600_000)
      await vi.advanceTimersByTimeAsync(300)
      expect(tries).toBe(2)
      expect(await answer).toBe('satchel')
    } finally {
      vi.useRealTimers()
    }
  })

  /* NULL, NOT A GUESS. The caller serves nothing either way, but "we could
   * not find out" and "this is a satchel" are different facts. */
  it('answers null and says so when it never becomes readable', async () => {
    vi.useFakeTimers()
    try {
      const said: { event: string; fields: Record<string, unknown> }[] = []
      const answer = readRole(
        {
          localRole: async () => {
            throw new Error('the plugin is gone')
          },
        },
        () => false,
        { warn: (event, fields) => said.push({ event, fields }) },
      )
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await answer).toBeNull()
      expect(said).toHaveLength(1)
      expect(said[0]?.event).toBe('peer.role-unknown')
      expect(said[0]?.fields.message).toMatch(/plugin is gone/)
    } finally {
      vi.useRealTimers()
    }
  })

  /* ABANDONED THE MOMENT THE CAPABILITY STOPS, so a dead plugin does not hold
   * a teardown open for the length of the backoff. */
  it('gives up at once when the capability has stopped', async () => {
    let tries = 0
    const answer = await readRole(
      {
        localRole: async () => {
          tries += 1
          throw new Error('not ready')
        },
      },
      () => true,
      quiet,
    )
    expect(answer).toBeNull()
    expect(tries).toBe(0)
  })
})

/**
 * TEARDOWN, AS A FUNCTION.
 *
 * It used to read four `let` slots out of `start`'s scope, which is why that
 * function ran past a hundred lines and why the teardown could only be
 * exercised by composing the whole capability — so its one real property, that
 * a throwing dispose must not rob the later steps, had never been executed.
 */
describe('releasePeer', () => {
  const disposer = (record: string[], label: string, throws = false) => ({
    dispose: () => {
      record.push(label)
      if (throws) throw new Error(`${label} failed`)
    },
  })

  it('releases everything, in reverse order of acquisition', () => {
    const seen: string[] = []
    releasePeer(
      {
        port: null,
        model: disposer(seen, 'model') as never,
        serviceHost: disposer(seen, 'service-host'),
        devicePort: disposer(seen, 'device-port'),
        hashPort: disposer(seen, 'hash-port'),
      },
      { warn: () => {} },
    )
    expect(seen).toEqual(['hash-port', 'device-port', 'service-host', 'model'])
  })

  /**
   * A CAPABILITY WHOSE TEARDOWN GIVES UP HALFWAY is worse than one that never
   * had a teardown, because the half that ran makes the rest look done.
   */
  it('carries on past a dispose that throws, and says which one', () => {
    const seen: string[] = []
    const said: { event: string; fields: Record<string, unknown> }[] = []
    releasePeer(
      {
        port: null,
        model: disposer(seen, 'model') as never,
        serviceHost: disposer(seen, 'service-host', true),
        devicePort: disposer(seen, 'device-port'),
        hashPort: disposer(seen, 'hash-port', true),
      },
      { warn: (event: string, fields: Record<string, unknown>) => said.push({ event, fields }) },
    )
    expect(seen).toEqual(['hash-port', 'device-port', 'service-host', 'model'])
    expect(said).toHaveLength(2)
    expect(said.map((one) => one.event)).toEqual(['peer.teardown-step-failed', 'peer.teardown-step-failed'])
    /* Each step named by its own label, so the log says which slot would not let go. */
    expect(said.map((one) => one.fields.label)).toEqual(['hash-port', 'service-host'])
  })

  it('is a no-op for what was never acquired', () => {
    expect(() =>
      releasePeer({ port: null, model: null, serviceHost: null, devicePort: null, hashPort: null }, { warn: () => {} }),
    ).not.toThrow()
  })
})

/**
 * THE SHELF SIDE OF THE SERVICE TABLE.
 *
 * A shelf serves the composed set over the router; a satchel serves nothing.
 * The property that could not be reached inline is the one about ORDER:
 * teardown is re-checked after every await, so a serve that resolves past
 * `stop` is unserved on the spot rather than leaking listeners into an ended
 * lifetime.
 */
describe('serveWhenShelf', () => {
  const quiet = { warn: () => {} }
  const SERVICES = [{ name: 'book.list', grant: 'book:read', handler: () => [] }] as never

  /** A port whose role and `serve` the test controls. */
  function port(role: 'shelf' | 'satchel', onServe?: () => void) {
    const state = { served: 0, unserved: 0 }
    return {
      state,
      port: {
        localRole: async () => role,
        serve: async () => {
          state.served += 1
          onServe?.()
          return () => void (state.unserved += 1)
        },
      } as never,
    }
  }

  it('serves on a shelf', async () => {
    const world = port('shelf')
    const held = await serveWhenShelf({ port: world.port, stopped: () => false, diagnostics: quiet })(SERVICES)
    expect(world.state.served).toBe(1)
    held.dispose()
    expect(world.state.unserved).toBe(1)
  })

  it('serves nothing on a satchel', async () => {
    const world = port('satchel')
    await serveWhenShelf({ port: world.port, stopped: () => false, diagnostics: quiet })(SERVICES)
    expect(world.state.served).toBe(0)
  })

  it('serves nothing with no plugin at all', async () => {
    const answer = await serveWhenShelf({ port: null, stopped: () => false, diagnostics: quiet })(SERVICES)
    expect(() => answer.dispose()).not.toThrow()
  })

  it('serves nothing when the capability has already stopped', async () => {
    const world = port('shelf')
    await serveWhenShelf({ port: world.port, stopped: () => true, diagnostics: quiet })(SERVICES)
    expect(world.state.served).toBe(0)
  })

  /**
   * A SERVE THAT RESOLVES PAST `stop` IS UNSERVED ON THE SPOT.
   *
   * `serve` is asynchronous and the capability can be torn down while it is in
   * flight — a restart, a failed boot. Without this the listeners it
   * registered outlive the lifetime that asked for them, and the next `start`
   * runs beside them.
   */
  it('undoes a serve that landed after the capability stopped', async () => {
    let stopped = false
    const world = port('shelf', () => {
      stopped = true
    })
    const answer = await serveWhenShelf({ port: world.port, stopped: () => stopped, diagnostics: quiet })(SERVICES)
    expect(world.state.served).toBe(1)
    expect(world.state.unserved).toBe(1)
    /* And the disposer it hands back does not unserve a second time. */
    answer.dispose()
    expect(world.state.unserved).toBe(1)
  })

  /* AN EMPTY SET IS NOT SERVED. Registering nothing costs a listener for no
   * service, and the router would answer `unknown-service` either way. */
  it('serves nothing when the composed set is empty', async () => {
    const world = port('shelf')
    await serveWhenShelf({ port: world.port, stopped: () => false, diagnostics: quiet })([] as never)
    expect(world.state.served).toBe(0)
  })
})

describe('the person port (WI-22.B3)', () => {
  const wireWith = (over: Record<string, unknown> = {}) =>
    ({
      pairBegin: vi.fn(() => Promise.resolve({ url: 'u', svg: '', expiresAt: 0 })),
      pairFromUri: vi.fn(() => Promise.resolve({ sas: '000000' })),
      pairConfirm: vi.fn(() => Promise.resolve(null)),
      pairCancel: vi.fn(() => Promise.resolve()),
      ...over,
    }) as never

  it('offers a CIRCLE pairing, never a device one', async () => {
    /* ⚠️ **THE KIND IS THE WHOLE POINT AND IT WAS UNTESTED.** A device offer
       refuses a shelf, so a circle started as one would fail at the far end
       with nothing here to say why. The panel's own test could not catch this:
       it only saw that `offer` had been called. */
    const wire = wireWith()
    await personPortOver(wire).offer()

    expect((wire as unknown as { pairBegin: ReturnType<typeof vi.fn> }).pairBegin).toHaveBeenCalledWith(
      undefined,
      'circle',
    )
  })

  it('joins with the circle grant, so the far side files it as one', async () => {
    const wire = wireWith()
    await personPortOver(wire).join('paper://pair?s=x')

    expect((wire as unknown as { pairFromUri: ReturnType<typeof vi.fn> }).pairFromUri).toHaveBeenCalledWith(
      'paper://pair?s=x',
      undefined,
      ['circle:read'],
    )
  })

  it('ignores a DEVICE attempt, so it cannot answer one with circle grants', async () => {
    /* ⚠️ **TWO SURFACES, ONE EVENT STREAM, DIFFERENT GRANTS.** Devices confirms
       with a reader's own-device grants; the circle confirms with
       `circle:read`. Before the events carried a `kind`, whichever panel was
       mounted answered whatever arrived — so Devices could hand another PERSON
       the permissions meant for the reader's own phone, and the circle could
       file the reader's own phone with circle access only.

       Filtered in the PORT rather than in each panel, so a third consumer
       inherits the rule instead of re-deriving it. */
    const seen: string[] = []
    /* An array, not a `let`: TypeScript's control flow cannot see an
       assignment made inside a callback, so a `let` narrows to `never` and
       calling it does not compile. */
    const emit: ((e: unknown) => void)[] = []
    const wire = wireWith({
      onPairingPending: (fn: (e: unknown) => void) => {
        emit.push(fn)
        return () => {}
      },
    })
    personPortOver(wire).onPending((e) => seen.push(e.name))

    emit[0]?.({ id: 'd', name: 'my phone', platform: 'macos', sas: '1', attemptId: 'a', kind: 'device' })
    emit[0]?.({ id: 'c', name: 'a friend', platform: 'macos', sas: '2', attemptId: 'b', kind: 'circle' })

    expect(seen).toEqual(['a friend'])
  })

  it('ignores a device RESULT for the same reason', async () => {
    const seen: boolean[] = []
    const emit: ((e: unknown) => void)[] = []
    const wire = wireWith({
      onPairingResult: (fn: (e: unknown) => void) => {
        emit.push(fn)
        return () => {}
      },
    })
    personPortOver(wire).onResult((e) => seen.push(e.ok))

    emit[0]?.({ ok: true, id: 'd', kind: 'device' })
    emit[0]?.({ ok: false, id: 'c', kind: 'circle' })

    expect(seen).toEqual([false])
  })

  it('carries the attempt id through a confirmation', async () => {
    /* Bound to the attempt the human saw, not to whatever a pre-played QR has
       since started — the reason `attemptId` exists at all. */
    const wire = wireWith()
    await personPortOver(wire).confirm(true, 'attempt-9')

    expect((wire as unknown as { pairConfirm: ReturnType<typeof vi.fn> }).pairConfirm).toHaveBeenCalledWith(
      true,
      ['circle:read'],
      'attempt-9',
    )
  })
})

describe('the device count the circle panel reads — WI-23.A3', () => {
  /* ⚠️ **THE CUSTODY MARKER USED TO READ A HARDCODED 1.** The roster this
     device presents is the count, this device included; a reader with no
     identity has no roster to lose and answers 0, which the marker never
     reads because `hasIdentity` is false first. */
  /* `circleRoster` is the read; `circleMine` would mint or renew, and a
     status read that reached for it is the defect the read exists to stop. */
  const withRoster = (roster: readonly string[] | null) =>
    personPortOver({
      circleRoster: () => Promise.resolve(roster),
      circleMine: () => Promise.reject(new Error('a count must not mint')),
    } as never)

  it('is the roster’s size', async () => {
    expect(await withRoster(['a'.repeat(64)]).devices()).toBe(1)
    expect(await withRoster(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]).devices()).toBe(3)
  })

  it('is 0 with no identity, and is not rounded up to 1', async () => {
    expect(await withRoster(null).devices()).toBe(0)
  })
})

describe('readRole, stopped after the retries', () => {
  it('answers null without a word once the run has stopped', async () => {
    let failures = 0
    const port = { localRole: () => { failures += 1; return Promise.reject(new Error('not yet')) } }
    const warn = vi.fn()
    vi.useFakeTimers()
    try {
      const answer = readRole(port, () => failures >= 3, { warn })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await answer).toBeNull()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the person port over a wire', () => {
  it('introduces a device and revokes one through the wire', async () => {
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-1' })
    const seen = wire as unknown as { introduced: unknown[]; revoked: string[] }
    const port = personPortOver(wire)
    await port.introduce('dev-1', ['addr'])
    expect(seen.introduced).toEqual([{ device: 'dev-1', addrs: ['addr'] }])
    await port.revokeDevice('dev-2')
    expect(seen.revoked).toEqual(['dev-2'])
  })
})

describe('the role read’s wait, held to the letter', () => {
  it('retries only once the backoff has passed, and gives up within a tick of a stop', async () => {
    vi.useFakeTimers()
    try {
      let tries = 0
      const port = { localRole: () => { tries += 1; return Promise.reject(new Error('not yet')) } }
      const answer = readRole(port, () => false, { warn: () => {} })
      await vi.advanceTimersByTimeAsync(100)
      expect(tries).toBe(1)
      await vi.advanceTimersByTimeAsync(200)
      expect(tries).toBe(2)
      await vi.advanceTimersByTimeAsync(600)
      expect(tries).toBe(3)
      expect(await answer).toBeNull()
      let stopped = false
      let asked = 0
      const slow = readRole({ localRole: () => { asked += 1; return Promise.reject(new Error('not yet')) } }, () => stopped, { warn: () => {} })
      await vi.advanceTimersByTimeAsync(10)
      stopped = true
      await vi.advanceTimersByTimeAsync(60)
      expect(await slow).toBeNull()
      expect(asked).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases without a word when there is no service host to release', () => {
    const said: unknown[] = []
    releasePeer({ port: null, model: null, serviceHost: undefined, devicePort: undefined } as never, { warn: (event) => void said.push(event) })
    expect(said).toEqual([])
  })
})

/* ONE PORT PER WIRE, with the identity's listeners on it: a port built afresh
   on every `personPort()` call had nobody to tell, and everything that waited
   on an identity — the published shelf, the share controls — heard nothing. */
describe('the person port’s identity lifecycle', () => {
  it('is one port per wire, and tells its listeners when an identity is made, restored or forgotten', async () => {
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-1' })
    const port = personPortOver(wire)
    expect(personPortOver(wire)).toBe(port)
    const heard: unknown[] = []
    const off = port.onIdentity((event) => heard.push(event))
    const person = await port.ensure()
    expect(heard).toEqual([{ kind: 'made', person }])
    /* Told AFTER the wire answered: a listener that asks finds the identity there. */
    await port.forget()
    expect(heard.at(-1)).toEqual({ kind: 'forgotten' })
    const words = (await (async () => {
      await port.ensure()
      return port.phrase()
    })())!
    await port.forget()
    const restored = await port.restore(words)
    expect(heard.at(-1)).toEqual({ kind: 'restored', person: restored })
    off()
    await port.ensure()
    expect(heard).toHaveLength(5)
    /* A listener that throws does not stop the next one. */
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const after: string[] = []
      port.onIdentity(() => {
        throw new Error('a surface fell over')
      })
      port.onIdentity(() => after.push('told'))
      await port.ensure()
      expect(after).toEqual(['told'])
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
