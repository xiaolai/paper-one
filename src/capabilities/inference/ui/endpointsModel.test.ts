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
  validModelName,
  type EndpointDraft,
  type EndpointsModel,
  type EndpointsPlugin,
  type EndpointsSnapshot,
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
  model: 'gpt-4.1-mini',
  keyState: 'set',
  ...over,
})

const draft = (over: Partial<EndpointDraft> = {}): EndpointDraft => ({
  ...EMPTY_DRAFT,
  id: 'my-proxy',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-4.1-mini',
  ...over,
})

/**
 * Type a whole draft into a model, field by field, as the pane's inputs do.
 *
 * ⚠️ **THE DRAFT IS THE MODEL'S, AND IT USED TO BE `useState` IN THE PANE** —
 * which `PaneGroup` unmounts whenever the reader closes the group, taking a
 * half-typed endpoint with it. `save` therefore takes no argument: handing the
 * model its own draft back would be two copies of one thing.
 */
const type = (model: EndpointsModel, over: Partial<EndpointDraft> = {}): void => {
  const whole = draft(over)
  for (const field of ['id', 'label', 'baseUrl', 'model', 'key'] as const) model.edit(field, whole[field])
}

/** What a refused address is told — every scheme the crate takes, in one sentence. */
const ADDRESS_REFUSED =
  'An address is an https:// URL with a host and no credentials in it — or http:// to this computer (localhost).'

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
    models: { valid: string[]; invalid: string[] }
  }

  /* NON-EMPTY, so a corpus that failed to parse into the shape this reads
     cannot pass by comparing nothing — the same guard its Rust twin has. */
  it('reads a corpus with cases in it', () => {
    for (const [group, key] of [
      ['ids', 'valid'],
      ['ids', 'invalid'],
      ['baseUrls', 'valid'],
      ['baseUrls', 'invalid'],
      ['models', 'valid'],
      ['models', 'invalid'],
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

  /* NON-VACUITY FOR THE LOOPBACK RULE: the corpus must carry both an http://
     address the crate takes and one it refuses, or "no others" says nothing
     about the one scheme the rule is about. */
  it('carries plain-http cases on both sides', () => {
    expect(corpus.baseUrls.valid.some((url) => url.startsWith('http://'))).toBe(true)
    expect(corpus.baseUrls.invalid.some((url) => url.startsWith('http://'))).toBe(true)
  })

  it('accepts every model name the crate accepts, and no others', () => {
    for (const name of corpus.models.valid) expect(validModelName(name), JSON.stringify(name)).toBe(true)
    for (const name of corpus.models.invalid) expect(validModelName(name), JSON.stringify(name)).toBe(false)
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

  /* ⚠️ **PLAIN HTTP TO THIS MACHINE, AND TO NOTHING THAT MERELY SOUNDS LIKE
     IT.** Ollama and LM Studio serve on the loopback and speak no TLS; the key
     travels in a header, so any other host over http is a key sent in the
     clear. The loopback is recognised by NAME — a lookalike host, another
     loopback-range address, credentials or a path that says `localhost` are
     all refused, as the crate refuses them. */
  it('takes plain http only to localhost, 127.0.0.1 or [::1], with or without a port', () => {
    for (const good of ['http://localhost', 'http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1']) {
      expect(validBaseUrl(good), good).toBe(true)
    }
    for (const bad of [
      'http://api.example.com/v1',
      'http://localhost.example.com/v1',
      'http://evillocalhost:1234/v1',
      'http://127a0a0a1:1234/v1',
      'http://127.0.0.2:1234/v1',
      'http://0.0.0.0:11434/v1',
      'http://localhost@evil.example/v1',
      'http://evil.example/localhost',
      'http://localhost:/v1',
      'http://localhost:80a/v1',
      'http://[::1/v1',
      /* The platform parser still has the last word on a port. */
      'http://localhost:99999/v1',
    ]) {
      expect(validBaseUrl(bad), bad).toBe(false)
    }
  })

  /* A model name as a provider spells it — `/`, `:`, `.` and `@` included —
     and bounded in BYTES, as the crate counts. */
  it('takes a model name with a provider’s punctuation, and no whitespace', () => {
    for (const good of ['gpt-4.1-mini', 'qwen2.5:7b', 'meta-llama/Llama-3.1-8B-Instruct', 'claude@latest', 'm'.repeat(200)]) {
      expect(validModelName(good), good).toBe(true)
    }
    for (const bad of ['', ' gpt', 'gpt 4', 'gpt\t4', 'gpt-4\n', 'gpt\u00004', 'm'.repeat(201), 'é'.repeat(101)]) {
      expect(validModelName(bad), JSON.stringify(bad)).toBe(false)
    }
    expect(new TextEncoder().encode('é'.repeat(101)).length, 'the case is not past 200 bytes, so this measures nothing').toBe(202)
    expect(validModelName('é'.repeat(100)), '200 bytes is the crate’s own bound, inclusive').toBe(true)
  })

  /* A tab or a newline pasted with a URL is the ordinary way one arrives, and
     a header built from it would be split by it. */
  it('refuses whitespace and control characters wherever they sit', () => {
    for (const bad of ['https://api.example.com\n', 'https://api.\texample.com', 'https://api.example.com ']) {
      expect(validBaseUrl(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  /* THE BOUND IS INCLUSIVE, as the crate's `url.len() > MAX_ENDPOINT_URL` is:
     an address of exactly 400 bytes is one `endpoints.rs` stores, and refusing
     it here would be a pre-check stricter than the authority by one byte. */
  it('takes an address of exactly the crate’s 400 bytes, and refuses one byte more', () => {
    const atBound = `https://${'a'.repeat(392)}`
    expect(new TextEncoder().encode(atBound).length, 'the case is not 400 bytes, so this measures nothing').toBe(400)
    expect(validBaseUrl(atBound)).toBe(true)
    expect(validBaseUrl(`${atBound}a`)).toBe(false)
  })

  /* EVERY CHARACTER OF THE HOST, as `endpoints.rs` checks every one: letters,
     digits, dots, hyphens and a port's colon. An underscore is a hostname the
     platform parser accepts and the crate refuses, so only the character check
     stands between it and a round trip — at the start, in the middle or at the
     end. A bracketed IPv6 literal is refused by the same check. */
  it('refuses a host character the crate refuses, wherever it sits', () => {
    for (const bad of [
      'https://my_host.example.com',
      'https://_host.example.com',
      'https://host.example.com_',
      'https://[::1]:8443/v1',
    ]) {
      expect(validBaseUrl(bad), bad).toBe(false)
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
    expect(refuseDraft(draft({ model: '' }))).toMatch(/model/i)
    expect(refuseDraft(draft({ model: 'gpt 4' }))).toMatch(/model name/i)
  })

  /* THE ADDRESS FIRST: a draft wrong in two places names the first field on
     the form, which is where the reader's eye starts. */
  it('names the address before the model when both are wrong', () => {
    expect(refuseDraft(draft({ baseUrl: 'http://x', model: '' }))).toMatch(/address/i)
  })

  /* THE WORDS THEMSELVES. A blank name and a malformed one both mention a
     name, and a blank address and a malformed one both mention an address, so
     a pattern cannot tell "you left it empty" from "you typed it wrong" — and
     those are two different things for the reader to do. */
  it('tells a field left empty from one typed wrong', () => {
    expect(refuseDraft(draft({ id: '' }))).toBe('Give the endpoint a name to refer to it by.')
    expect(refuseDraft(draft({ id: 'My Proxy' }))).toBe(
      'A name is lower-case letters, digits and hyphens, up to 40 characters.',
    )
    expect(refuseDraft(draft({ baseUrl: '' }))).toBe('Give the endpoint its address.')
    expect(refuseDraft(draft({ baseUrl: 'http://x' }))).toBe(ADDRESS_REFUSED)
    expect(refuseDraft(draft({ model: '' }))).toBe('Give the name of the model to ask for — the provider’s own, like gpt-4.1-mini.')
    expect(refuseDraft(draft({ model: 'gpt 4' }))).toBe('A model name has no spaces in it, and is at most 200 characters.')
  })
})

describe('rowFor', () => {
  it('says the host and whether a key is stored, and never the key', () => {
    const row = rowFor(endpoint({ id: 'p', label: 'My proxy' }), null)
    expect(row.label).toBe('My proxy')
    expect(row.value).toBe('api.example.com · gpt-4.1-mini · key set')
    expect(row.keyState).toBe('set')
  })

  /* AN ENDPOINT STORED BEFORE THE FIELD EXISTED reads `""`, and its route
     cannot answer (`noModelName`) — the row says why, in the same words. */
  it('says so when the endpoint has no model name', () => {
    expect(rowFor(endpoint({ id: 'p', model: '' }), null).value).toBe('api.example.com · no model name · key set')
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
    /* And a loopback address over plain http, which is the Ollama case. */
    expect(hostOf('http://localhost:11434/v1')).toBe('localhost:11434')
  })
})

/* ------------------------------- the store ------------------------------- */

function fakePlugin(over: Partial<EndpointsPlugin> = {}) {
  let listed: Endpoint[] = []
  const spies = {
    endpoints: vi.fn(async (): Promise<readonly Endpoint[]> => listed),
    addEndpoint: vi.fn(async (id: string, label: string, baseUrl: string, model: string) => {
      listed = [...listed.filter((one) => one.id !== id), { id, label, baseUrl, model, keyState: 'missing' }]
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

/**
 * Every snapshot a subscriber was told about, read AT THE NOTIFICATION, the
 * way `useSyncExternalStore` reads it.
 *
 * ⚠️ **A TEST THAT READS ONLY AT THE END CANNOT SEE A MISSING NOTIFICATION.**
 * The snapshot cache is empty after any change, so a late `getSnapshot` builds
 * a fresh, correct one whether or not anybody was told — while the pane, which
 * reads only when told, is still drawing the state before it.
 */
const watch = (model: EndpointsModel): EndpointsSnapshot[] => {
  const seen: EndpointsSnapshot[] = []
  model.subscribe(() => void seen.push(model.getSnapshot()))
  return seen
}

const BLANK = { id: '', label: '', baseUrl: '', model: '', key: '' } as const

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

    type(model, { label: 'My proxy', key: 'sk-secret' })
    await expect(model.save()).resolves.toBe(true)
    expect(world.addEndpoint.mock.calls).toEqual([['my-proxy', 'My proxy', 'https://api.example.com/v1', 'gpt-4.1-mini']])
    expect(world.setEndpointKey.mock.calls).toEqual([['my-proxy', 'sk-secret']])
    expect(model.getSnapshot().rows[0]?.keyState).toBe('set')
    model.dispose()
  })

  /**
   * ⚠️ **THE DRAFT OUTLIVES THE PANE, AND IT USED NOT TO.**
   *
   * It was `useState` in `EndpointsPane`, and `PaneGroup` unmounts a closed
   * group deliberately — so a reader who pasted an address, opened another
   * group to find their key and came back met three empty fields. It is the
   * model's now, which is the thing the close does not touch (2026-09-13 audit,
   * round 2).
   */
  it('holds what the reader typed, and clears it only when a save succeeds', async () => {
    const world = fakePlugin()
    const model = createEndpointsModel({ plugin: world.plugin })
    await model.refresh()

    type(model, { baseUrl: 'http://insecure' })
    expect(model.getSnapshot().draft.baseUrl).toBe('http://insecure')

    await expect(model.save(), 'the draft was accepted, so this measures nothing').resolves.toBe(false)
    expect(model.getSnapshot().draft, 'a refused draft was thrown away').toEqual(draft({ baseUrl: 'http://insecure' }))

    model.edit('baseUrl', 'https://api.example.com/v1')
    await expect(model.save()).resolves.toBe(true)
    expect(model.getSnapshot().draft, 'the fields kept an endpoint that had been saved').toEqual(EMPTY_DRAFT)
    model.dispose()
  })

  /* ⚠️ **AND ONLY THE DRAFT THAT WAS SENT.** A save is a round trip to the
     runtime, and a reader goes on typing across it — so clearing whatever is in
     the fields when it lands took away the NEXT endpoint they had begun
     (2026-09-13 verify, round 2). `edit` builds a new draft, so identity is the
     whole test. */
  it('keeps what the reader typed while a save was still in flight', async () => {
    let land = (): void => {}
    const world = fakePlugin({
      addEndpoint: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          land = resolve
        })
      }),
    })
    const model = createEndpointsModel({ plugin: world.plugin })
    await model.refresh()

    type(model, { id: 'first', baseUrl: 'https://one.example.com' })
    const saving = model.save()
    type(model, { id: 'second', baseUrl: 'https://two.example.com' })
    land()

    await expect(saving).resolves.toBe(true)
    expect(model.getSnapshot().draft, 'the endpoint begun while the first was saving').toEqual(
      draft({ id: 'second', baseUrl: 'https://two.example.com' }),
    )
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

    type(model, { label: 'Renamed', key: '' })
    await model.save()
    expect(world.setEndpointKey, 'a blank field cleared the stored key').not.toHaveBeenCalled()
    model.dispose()
  })

  it('falls back to the name when no label was typed', async () => {
    const world = fakePlugin()
    const model = createEndpointsModel({ plugin: world.plugin })
    type(model, { label: '' })
    await model.save()
    expect(world.addEndpoint.mock.calls[0]?.[1]).toBe('my-proxy')
    model.dispose()
  })

  /* REFUSED BEFORE THE ROUND TRIP, and nothing is spent: the reader is told
     what is wrong beside the field rather than by a failure from the crate. */
  it('refuses a bad draft without calling the plugin', async () => {
    const world = fakePlugin()
    const model = createEndpointsModel({ plugin: world.plugin })
    type(model, { baseUrl: 'http://insecure' })
    await expect(model.save()).resolves.toBe(false)
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
    type(model)
    await model.save()
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
    type(model)
    await expect(model.save()).resolves.toBe(false)
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

  /* NOTHING TYPED, NOTHING WRONG, NOTHING IN FLIGHT — before the first read
     and after it. Save and Remove are disabled on `busy`, so a store that
     opened busy would draw a pane nobody can press. */
  it('opens with nothing typed, nothing wrong and nothing in flight', async () => {
    const model = createEndpointsModel({ plugin: fakePlugin().plugin })
    expect(model.getSnapshot()).toEqual({ rows: [], loading: true, busy: false, failure: null, draft: BLANK })

    await model.refresh()
    expect(model.getSnapshot()).toEqual({ rows: [], loading: false, busy: false, failure: null, draft: BLANK })
    model.dispose()
  })

  /* A SUBSCRIBER THAT THROWS IS NAMED BY THE STORE IT BELONGS TO, so the line
     in the console says which pane broke rather than that one did. */
  it('names the endpoints store when one of its subscribers throws', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const model = createEndpointsModel({ plugin: fakePlugin().plugin })
      model.subscribe(() => {
        throw new Error('a pane broke')
      })
      await model.refresh()
      expect(said).toHaveBeenCalledWith('Paper: a endpoints subscriber threw while being notified', expect.any(Error))
      model.dispose()
    } finally {
      said.mockRestore()
    }
  })

  /* THE REPORTER IS OPTIONAL, and the reader's half is not: a store built with
     nothing to report to still says the list could not be read. */
  it('explains an unreadable list with no reporter to tell', async () => {
    const world = fakePlugin({
      endpoints: async () => {
        throw new Error('endpoints.json is malformed')
      },
    })
    const model = createEndpointsModel({ plugin: world.plugin })
    await expect(model.refresh()).resolves.toBeUndefined()
    expect(model.getSnapshot().failure).toBe('The endpoint list could not be read.')
    model.dispose()
  })

  /* THE MAINTAINER'S HALF: what the failed read actually said. */
  it('hands the reporter what the failed read said', async () => {
    const report = vi.fn()
    const world = fakePlugin({
      endpoints: async () => {
        throw new Error('endpoints.json is malformed')
      },
    })
    const model = createEndpointsModel({ plugin: world.plugin, report })
    await model.refresh()
    expect(report.mock.calls).toEqual([['inference.endpoints-failed', { message: 'endpoints.json is malformed' }]])
    model.dispose()
  })

  /* AN OLDER READ THAT FAILS IS SUPERSEDED TOO. The newer one has already
     answered, and "could not be read" over a list on screen is a false alarm. */
  it('says nothing about a superseded read that fails after the newest answered', async () => {
    const gates = [deferred(), deferred()]
    let asked = 0
    const world = fakePlugin({
      endpoints: async () => {
        const mine = asked++
        await gates[mine]!.promise
        if (mine === 0) throw new Error('the older read failed')
        return [endpoint({ id: 'fresh' })]
      },
    })
    const model = createEndpointsModel({ plugin: world.plugin })
    const older = model.refresh()
    const newer = model.refresh()

    gates[1]!.open()
    await newer
    gates[0]!.open()
    await older
    expect(model.getSnapshot().failure, 'a superseded failure was drawn over the current list').toBeNull()
    expect(model.getSnapshot().rows.map((r) => r.id)).toEqual(['fresh'])
    model.dispose()
  })

  /* BUSY FOR EXACTLY AS LONG AS THE SAVE IS OUT, AND THE PANE IS TOLD AT BOTH
     ENDS. A start it was not told about lets a second save race the first; an
     end it was not told about leaves Save and Remove disabled for good. */
  it('tells the pane a save is out, and tells it again when the save lands', async () => {
    const landing = deferred()
    const world = fakePlugin({
      addEndpoint: vi.fn(async () => {
        await landing.promise
      }),
    })
    const model = createEndpointsModel({ plugin: world.plugin })
    await model.refresh()
    type(model)
    const seen = watch(model)

    const saving = model.save()
    expect(seen.at(-1)?.busy, 'the pane was not told a save had begun').toBe(true)

    landing.open()
    await expect(saving).resolves.toBe(true)
    expect(seen.at(-1)?.busy, 'the pane was left disabled after the save landed').toBe(false)
    expect(seen.at(-1)?.draft, 'the pane still drew the endpoint it had just saved').toEqual(BLANK)
    model.dispose()
  })

  /* A REMOVAL CLEARS NO DRAFT, so nothing after it would tell the pane by
     accident: the end of `busy` has to be said for itself. */
  it('tells the pane a removal is over once it lands', async () => {
    const world = fakePlugin()
    world.seed([endpoint({ id: 'a' })])
    const model = createEndpointsModel({ plugin: world.plugin })
    await model.refresh()
    await model.pressRemove('a')
    const seen = watch(model)

    await model.pressRemove('a')
    expect(seen[0]?.busy, 'the pane was not told a removal had begun').toBe(true)
    expect(seen.at(-1)?.busy, 'the pane was left disabled after the removal landed').toBe(false)
    model.dispose()
  })

  /* A SAVE THAT FAILED IS TOLD AS ONE — the reason, and the buttons back —
     and what the reader typed stays: they correct the address rather than
     paste a key a second time. */
  it('tells the pane a save failed, and keeps what the reader typed', async () => {
    const world = fakePlugin({
      addEndpoint: async () => {
        throw new Error('the keychain refused')
      },
    })
    const model = createEndpointsModel({ plugin: world.plugin })
    type(model, { key: 'sk-secret' })
    const seen = watch(model)

    await expect(model.save(), 'a failed save with no reporter rejected').resolves.toBe(false)
    expect(seen.at(-1)?.failure).toBe('That endpoint could not be saved.')
    expect(seen.at(-1)?.busy).toBe(false)
    expect(model.getSnapshot().draft, 'a failed save threw away what the reader typed').toEqual(draft({ key: 'sk-secret' }))
    model.dispose()
  })

  it('tells the pane why a draft was refused', async () => {
    const model = createEndpointsModel({ plugin: fakePlugin().plugin })
    type(model, { baseUrl: 'http://insecure' })
    const seen = watch(model)

    await model.save()
    expect(seen.at(-1)?.failure).toBe(ADDRESS_REFUSED)
    model.dispose()
  })

  /* A STORE DISPOSED WITH A SAVE OUT DOES NOT MOVE WHEN IT LANDS, whichever
     way it lands. The capability is being torn down; a snapshot that changes
     afterwards is state written for nobody — the rule a read landing after
     dispose already keeps. */
  it.each(['lands', 'fails'] as const)('changes nothing when a save %s after dispose', async (outcome) => {
    const landing = deferred()
    const world = fakePlugin({
      addEndpoint: vi.fn(async () => {
        await landing.promise
        if (outcome === 'fails') throw new Error('the keychain refused')
      }),
    })
    const model = createEndpointsModel({ plugin: world.plugin })
    type(model)
    const saving = model.save()
    model.dispose()
    const atDispose = model.getSnapshot()

    landing.open()
    await saving
    expect(model.getSnapshot(), 'a save landing after dispose moved the store').toBe(atDispose)
  })

  /* DISPOSED MEANS DEAF AND STILL: a torn-down pane is told nothing, whatever
     is typed or pressed, and a read after dispose replaces nothing. */
  it('tells nobody anything after dispose, and reads nothing into itself', async () => {
    const world = fakePlugin()
    world.seed([endpoint({ id: 'a' })])
    const model = createEndpointsModel({ plugin: world.plugin })
    await model.refresh()
    let told = 0
    model.subscribe(() => void (told += 1))
    model.dispose()

    model.edit('id', 'typed-after')
    await model.pressRemove('a')
    world.seed([endpoint({ id: 'b' })])
    await model.refresh()
    expect(told, 'a torn-down pane was told').toBe(0)
    expect(model.getSnapshot().rows.map((r) => r.id), 'a read after dispose replaced the list').toEqual(['a'])
  })

  /* THE PANE DISARMS ON EVERY KEYSTROKE, before every `edit` — so a disarm with
     nothing armed has to be nothing: no new snapshot, no notification. One
     with something armed has to be said, or the button keeps offering it. */
  it('takes nothing back when nothing is armed, and tells the pane when something was', async () => {
    const world = fakePlugin()
    world.seed([endpoint({ id: 'a' })])
    const model = createEndpointsModel({ plugin: world.plugin })
    await model.refresh()
    const seen = watch(model)
    const before = model.getSnapshot()

    model.disarm()
    expect(seen, 'a disarm with nothing armed told the pane').toEqual([])
    expect(model.getSnapshot()).toBe(before)

    await model.pressRemove('a')
    expect(seen.at(-1)?.rows[0]?.action).toBe('confirm')
    model.disarm()
    expect(seen.at(-1)?.rows[0]?.action, 'the pane still offered the removal it took back').toBe('remove')
    model.dispose()
  })
})

describe('audit-fix round 1 — a base URL is a host, measured in bytes', () => {
  it('refuses a malformed host the old character class let through', () => {
    for (const bad of ['https://a:99999', 'https://a..b', 'https://-host', 'https://host-.example']) {
      expect(validBaseUrl(bad), bad).toBe(false)
    }
    expect(validBaseUrl('https://api.example.com:8443/v1')).toBe(true)
  })
  it('bounds the length in UTF-8 bytes, as the crate does', () => {
    const long = `https://${'é'.repeat(1200)}.example`
    expect(validBaseUrl(long)).toBe(false)
  })
})
