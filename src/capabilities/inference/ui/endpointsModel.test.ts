import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Endpoint } from '../lib/plugin'
import {
  EMPTY_DRAFT,
  createEndpointsModel,
  hostOf,
  refuseDraft,
  rowFor,
  validBaseUrl,
  validId,
  type EndpointDraft,
  type EndpointsPlugin,
} from './endpointsModel'

/** A promise the test opens when it wants the read under test to finish. */
function deferred(): { readonly promise: Promise<void>; open(): void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open: () => open() }
}

const endpoint = (over: Partial<Endpoint> & Pick<Endpoint, 'id'>): Endpoint => ({
  label: over.id,
  baseUrl: 'https://api.example.com/v1',
  keyState: 'set',
  ...over,
})

const draft = (over: Partial<EndpointDraft> = {}): EndpointDraft => ({
  ...EMPTY_DRAFT,
  id: 'my-proxy',
  baseUrl: 'https://api.example.com/v1',
  ...over,
})

/**
 * ⚠️ ONE CORPUS, TWO VALIDATORS.
 *
 * `endpoints.rs` decides what Paper stores; these rules refuse the same things
 * in the reader's own words, beside the field, so a bad address is not a round
 * trip and an error naming nothing they can act on. Two implementations of one
 * rule is the shape that drifts, and neither side can see the other.
 *
 * So both read the SAME file — `fixtures/endpoint-validation.json`, which
 * lives in the crate — and assert their own answer against it. A rule changed
 * on one side alone turns this red, or its twin in `endpoints.rs`. Asserting
 * against cases written out here instead would only have recorded what I
 * believed the crate did, which is the assumption this exists to remove.
 */
describe('the rules the crate and the pane both apply', () => {
  const corpus = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../../../src-tauri/crates/tauri-plugin-inference/fixtures/endpoint-validation.json', import.meta.url),
      ),
      'utf8',
    ),
  ) as {
    ids: { valid: string[]; invalid: string[] }
    baseUrls: { valid: string[]; invalid: string[] }
  }

  /* NON-EMPTY, so a corpus that failed to parse into the shape this reads
     cannot pass by comparing nothing — the same guard its Rust twin has. */
  it('reads a corpus with cases in it', () => {
    for (const [group, key] of [
      ['ids', 'valid'],
      ['ids', 'invalid'],
      ['baseUrls', 'valid'],
      ['baseUrls', 'invalid'],
    ] as const) {
      expect(corpus[group][key], `${group}.${key} is empty`).not.toEqual([])
    }
  })

  it('accepts every name the crate accepts, and no others', () => {
    for (const id of corpus.ids.valid) expect(validId(id), JSON.stringify(id)).toBe(true)
    for (const id of corpus.ids.invalid) expect(validId(id), JSON.stringify(id)).toBe(false)
  })

  it('accepts every address the crate accepts, and no others', () => {
    for (const url of corpus.baseUrls.valid) expect(validBaseUrl(url), JSON.stringify(url)).toBe(true)
    for (const url of corpus.baseUrls.invalid) expect(validBaseUrl(url), JSON.stringify(url)).toBe(false)
  })
})

/**
 * ⚠️ THESE RULES MIRROR `endpoints.rs`, WHICH REMAINS THE AUTHORITY.
 *
 * They exist so a reader is told what is wrong with what they typed, beside
 * the field, rather than after a round trip as a `ManifestMalformed` naming
 * nothing they can act on. Two validators for one rule is the shape that
 * drifts — so what is asserted below is the direction that matters: anything
 * accepted here is accepted there. Stricter merely annoys; laxer hands the
 * reader an error from a process away, which is what having no pre-check does.
 *
 * The cases are `valid_id`'s and `valid_base_url`'s own, read across.
 */
describe('what the crate will accept', () => {
  it('takes a name of lower-case letters, digits and hyphens', () => {
    for (const good of ['a', 'my-proxy', 'openai-1', '0', 'a'.repeat(40)]) {
      expect(validId(good), good).toBe(true)
    }
  })

  it('refuses a name the crate would refuse', () => {
    for (const bad of ['', 'A', 'My-Proxy', 'my proxy', 'my_proxy', 'my.proxy', 'a'.repeat(41), 'é']) {
      expect(validId(bad), bad).toBe(false)
    }
  })

  it('takes an https address with a host', () => {
    for (const good of [
      'https://a',
      'https://api.example.com',
      'https://api.example.com/v1',
      'https://api.example.com:8443/v1?x=1',
      'https://127.0.0.1:11434/v1',
    ]) {
      expect(validBaseUrl(good), good).toBe(true)
    }
  })

  /**
   * ⚠️ EVERY ONE OF THESE PASSED A `startsWith('https://')` CHECK, which is
   * what `valid_base_url` was before an audit — and each reaches the daemon as
   * a provider registration that cannot resolve, so it surfaces as a route
   * that fails when pressed rather than as a value refused when it was typed.
   */
  it('refuses an address the crate would refuse', () => {
    for (const bad of [
      '',
      'http://api.example.com',
      'api.example.com',
      'https://',
      'https:///v1',
      'https://api.example.com/a b',
      'https://user:pass@api.example.com',
      'https://api.example.com#frag',
      'https://exa mple.com',
      `https://${'a'.repeat(400)}`,
    ]) {
      expect(validBaseUrl(bad), bad).toBe(false)
    }
  })

  /* A tab or a newline pasted with a URL is the ordinary way one arrives, and
     a header built from it would be split by it. */
  it('refuses whitespace and control characters wherever they sit', () => {
    for (const bad of ['https://api.example.com\n', 'https://api.\texample.com', 'https://api.example.com ']) {
      expect(validBaseUrl(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('refuseDraft', () => {
  it('accepts a draft the crate would take', () => {
    expect(refuseDraft(draft())).toBeNull()
    /* A key is OPTIONAL: an endpoint with none is reported `noKey` by the
       probe and says so in its row, rather than being refused here. */
    expect(refuseDraft(draft({ key: '' }))).toBeNull()
  })

  it('says which field is wrong, in words the reader can act on', () => {
    expect(refuseDraft(draft({ id: '' }))).toMatch(/name/i)
    expect(refuseDraft(draft({ id: 'My Proxy' }))).toMatch(/lower-case/i)
    expect(refuseDraft(draft({ baseUrl: '' }))).toMatch(/address/i)
    expect(refuseDraft(draft({ baseUrl: 'http://x' }))).toMatch(/https/i)
  })
})

describe('rowFor', () => {
  it('says the host and whether a key is stored, and never the key', () => {
    const row = rowFor(endpoint({ id: 'p', label: 'My proxy' }), null)
    expect(row.label).toBe('My proxy')
    expect(row.value).toBe('api.example.com · key set')
    expect(row.keyState).toBe('set')
  })

  it('says so when there is no key, which is why the route cannot answer', () => {
    expect(rowFor(endpoint({ id: 'p', keyState: 'missing' }), null).value).toMatch(/no key$/)
  })

  /* WI-20.20. The keychain refusing to read a key is not "no key": the key is
     probably there, and telling the reader to add one sends them to re-enter a
     credential the next read will refuse again. The row says which it is. */
  it('says when the keychain would not read the key, rather than calling it missing', () => {
    const row = rowFor(endpoint({ id: 'p', keyState: 'unreadable' }), null)
    expect(row.value).toMatch(/key unreadable$/)
    expect(row.value).not.toMatch(/no key/)
    expect(row.keyState).toBe('unreadable')
  })

  it('falls back to the id when the endpoint was given no label', () => {
    expect(rowFor(endpoint({ id: 'p', label: '' }), null).label).toBe('p')
  })

  /* TWO PRESSES, because a key cannot be put back: Paper never reads one, so
     it cannot restore one, and a reader who no longer has it has lost access
     to whatever they were paying for. */
  it('offers Remove, and confirmation once armed', () => {
    expect(rowFor(endpoint({ id: 'p' }), null).action).toBe('remove')
    expect(rowFor(endpoint({ id: 'p' }), 'p').action).toBe('confirm')
    expect(rowFor(endpoint({ id: 'p' }), 'other').action).toBe('remove')
  })

  it('shows the host of an address with a port or a path', () => {
    expect(hostOf('https://127.0.0.1:11434/v1')).toBe('127.0.0.1:11434')
    expect(hostOf('https://api.example.com?x=1')).toBe('api.example.com')
  })
})

/* ------------------------------- the store ------------------------------- */

function fakePlugin(over: Partial<EndpointsPlugin> = {}) {
  let listed: Endpoint[] = []
  const spies = {
    endpoints: vi.fn(async (): Promise<readonly Endpoint[]> => listed),
    addEndpoint: vi.fn(async (id: string, label: string, baseUrl: string) => {
      listed = [...listed.filter((one) => one.id !== id), { id, label, baseUrl, keyState: 'missing' }]
    }),
    removeEndpoint: vi.fn(async (id: string) => {
      listed = listed.filter((one) => one.id !== id)
    }),
    setEndpointKey: vi.fn(async (id: string, key: string) => {
      listed = listed.map((one) => (one.id === id ? { ...one, keyState: key !== '' ? 'set' : 'missing' } : one))
    }),
  }
  return {
    plugin: { ...spies, ...over } as EndpointsPlugin,
    ...spies,
    seed: (next: Endpoint[]) => void (listed = next),
  }
}

describe('the endpoints store', () => {
  it('is empty and loading until the first read', async () => {
    const world = fakePlugin()
    world.seed([endpoint({ id: 'p' })])
    const model = createEndpointsModel({ plugin: world.plugin })
    expect(model.getSnapshot().loading).toBe(true)
    expect(model.getSnapshot().rows).toEqual([])

    await model.refresh()
    expect(model.getSnapshot().loading).toBe(false)
    expect(model.getSnapshot().rows.map((r) => r.id)).toEqual(['p'])
    model.dispose()
  })

  /* THE STABLE REFERENCE `useSyncExternalStore` requires: two reads with
     nothing changed between them are the SAME object, and a change produces a
     different one. A fresh object per call is an infinite re-render. */
  it('returns one snapshot object until something changes', async () => {
    const world = fakePlugin()
    const model = createEndpointsModel({ plugin: world.plugin })
    await model.refresh()
    const before = model.getSnapshot()
    expect(model.getSnapshot()).toBe(before)

    await model.pressRemove('nothing')
    const after = model.getSnapshot()
    expect(after).not.toBe(before)
    expect(model.getSnapshot()).toBe(after)
    model.dispose()
  })

  it('saves a draft, sets its key, and re-reads', async () => {
    const world = fakePlugin()
    const model = createEndpointsModel({ plugin: world.plugin })
    await model.refresh()

    await expect(model.save(draft({ label: 'My proxy', key: 'sk-secret' }))).resolves.toBe(true)
    expect(world.addEndpoint.mock.calls).toEqual([['my-proxy', 'My proxy', 'https://api.example.com/v1']])
    expect(world.setEndpointKey.mock.calls).toEqual([['my-proxy', 'sk-secret']])
    expect(model.getSnapshot().rows[0]?.keyState).toBe('set')
    model.dispose()
  })

  /**
   * ⚠️ A BLANK KEY IS NOT AN EMPTY KEY. `set_key("")` CLEARS, by the crate's
   * own rule — so calling it for an untouched field would take the key off an
   * endpoint the reader was only relabelling, and the row would go from
   * answering to `noKey` with nothing said.
   */
  it('leaves the stored key alone when the field is blank', async () => {
    const world = fakePlugin()
    world.seed([endpoint({ id: 'my-proxy', keyState: 'set' })])
    const model = createEndpointsModel({ plugin: world.plugin })
    await model.refresh()

    await model.save(draft({ label: 'Renamed', key: '' }))
    expect(world.setEndpointKey, 'a blank field cleared the stored key').not.toHaveBeenCalled()
    model.dispose()
  })

  it('falls back to the name when no label was typed', async () => {
    const world = fakePlugin()
    const model = createEndpointsModel({ plugin: world.plugin })
    await model.save(draft({ label: '' }))
    expect(world.addEndpoint.mock.calls[0]?.[1]).toBe('my-proxy')
    model.dispose()
  })

  /* REFUSED BEFORE THE ROUND TRIP, and nothing is spent: the reader is told
     what is wrong beside the field rather than by a failure from the crate. */
  it('refuses a bad draft without calling the plugin', async () => {
    const world = fakePlugin()
    const model = createEndpointsModel({ plugin: world.plugin })
    await expect(model.save(draft({ baseUrl: 'http://insecure' }))).resolves.toBe(false)
    expect(world.addEndpoint).not.toHaveBeenCalled()
    expect(model.getSnapshot().failure).toMatch(/https/i)
    model.dispose()
  })

  it('takes two presses to remove, and removes only the row that was armed', async () => {
    const world = fakePlugin()
    world.seed([endpoint({ id: 'a' }), endpoint({ id: 'b' })])
    const model = createEndpointsModel({ plugin: world.plugin })
    await model.refresh()

    await model.pressRemove('a')
    expect(world.removeEndpoint, 'one press deleted it').not.toHaveBeenCalled()
    expect(model.getSnapshot().rows.find((r) => r.id === 'a')?.action).toBe('confirm')

    /* ARMING ANOTHER ROW DISARMS THE FIRST, so nothing is ever more than one
       press away from exactly one deletion. */
    await model.pressRemove('b')
    expect(world.removeEndpoint).not.toHaveBeenCalled()
    expect(model.getSnapshot().rows.find((r) => r.id === 'a')?.action).toBe('remove')

    await model.pressRemove('b')
    expect(world.removeEndpoint.mock.calls).toEqual([['b']])
    expect(model.getSnapshot().rows.map((r) => r.id)).toEqual(['a'])
    model.dispose()
  })

  it('takes an arming back when the reader saves, or asks it to', async () => {
    const world = fakePlugin()
    world.seed([endpoint({ id: 'a' })])
    const model = createEndpointsModel({ plugin: world.plugin })
    await model.refresh()

    await model.pressRemove('a')
    model.disarm()
    expect(model.getSnapshot().rows[0]?.action).toBe('remove')

    await model.pressRemove('a')
    await model.save(draft())
    expect(
      model.getSnapshot().rows.find((r) => r.id === 'a')?.action,
      'a removal stayed armed while the reader did something else',
    ).toBe('remove')
    model.dispose()
  })

  /**
   * ⚠️ AN UNREADABLE LIST IS NOT AN EMPTY ONE. `endpoints.rs` refuses to treat
   * a malformed file as empty, so that one bad write cannot silently drop
   * every endpoint the reader configured — and a pane that showed "none yet"
   * over the same file would invite them to add a duplicate.
   */
  it('says the list could not be read, rather than showing none', async () => {
    const events: string[] = []
    const world = fakePlugin({
      endpoints: async () => {
        throw new Error('endpoints.json is malformed')
      },
    })
    const model = createEndpointsModel({ plugin: world.plugin, report: (event) => void events.push(event) })
    await expect(model.refresh()).resolves.toBeUndefined()

    expect(model.getSnapshot().failure).toMatch(/could not be read/i)
    expect(model.getSnapshot().loading, 'an unreadable list was drawn as an empty one').toBe(true)
    expect(events).toEqual(['inference.endpoints-failed'])
    model.dispose()
  })

  /* RESOLVES FALSE, DOES NOT REJECT — the pane calls this from a click
     handler, so a rejection is an unhandled promise and a reader who is told
     nothing. The same contract the controller's install and uninstall have. */
  it('resolves false and explains itself when a save fails', async () => {
    const events: { event: string; fields: Record<string, unknown> }[] = []
    const world = fakePlugin({
      addEndpoint: async () => {
        throw Object.assign(new Error('the keychain refused'), { kind: 'keychain' })
      },
    })
    const model = createEndpointsModel({
      plugin: world.plugin,
      report: (event, fields) => void events.push({ event, fields }),
    })
    await expect(model.save(draft())).resolves.toBe(false)
    expect(model.getSnapshot().failure).toMatch(/could not be saved/i)
    expect(model.getSnapshot().busy, 'the pane was left disabled by the failure').toBe(false)
    expect(events[0]?.event).toBe('inference.add-endpoint-failed')
    expect(events[0]?.fields.message).toBe('the keychain refused')
    model.dispose()
  })

  it('resolves and explains itself when a removal fails', async () => {
    const events: string[] = []
    const world = fakePlugin({
      removeEndpoint: async () => {
        throw new Error('the keychain refused')
      },
    })
    world.seed([endpoint({ id: 'a' })])
    const model = createEndpointsModel({ plugin: world.plugin, report: (event) => void events.push(event) })
    await model.refresh()
    await model.pressRemove('a')
    await model.pressRemove('a')

    expect(model.getSnapshot().failure).toMatch(/could not be removed/i)
    expect(model.getSnapshot().rows.map((r) => r.id), 'a failed removal took the row anyway').toEqual(['a'])
    expect(events).toEqual(['inference.remove-endpoint-failed'])
    model.dispose()
  })

  /**
   * TWO READS, NEWEST WINS. Every mutation re-reads and the pane reads on
   * mount, so two are in flight the moment a reader saves while one is out.
   */
  it('keeps the newest read when an older one resolves after it', async () => {
    const gates = [deferred(), deferred()]
    let asked = 0
    const world = fakePlugin({
      endpoints: async () => {
        const mine = asked++
        await gates[mine]!.promise
        return [endpoint({ id: mine === 0 ? 'stale' : 'fresh' })]
      },
    })
    const model = createEndpointsModel({ plugin: world.plugin })
    const older = model.refresh()
    const newer = model.refresh()

    gates[1]!.open()
    await newer
    expect(model.getSnapshot().rows.map((r) => r.id)).toEqual(['fresh'])

    gates[0]!.open()
    await older
    expect(model.getSnapshot().rows.map((r) => r.id), 'a superseded read overwrote the current list').toEqual([
      'fresh',
    ])
    model.dispose()
  })

  it('notifies subscribers, stops on unsubscribe, and says nothing after dispose', async () => {
    const world = fakePlugin()
    const model = createEndpointsModel({ plugin: world.plugin })
    let seen = 0
    const stop = model.subscribe(() => void (seen += 1))
    await model.refresh()
    expect(seen).toBe(1)

    stop()
    await model.refresh()
    expect(seen, 'a detached listener was still notified').toBe(1)

    let after = 0
    model.subscribe(() => void (after += 1))
    model.dispose()
    await model.refresh()
    expect(after, 'a read landing after dispose notified a torn-down pane').toBe(0)
  })
})
