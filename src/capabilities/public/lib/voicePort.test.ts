import { describe, expect, it, vi } from 'vitest'
import { VOICE_DECISIONS_PATH, writeQueue, type IndexFs, type VoiceBinding } from '../../../kernel'
import { MAX_DECISIONS, decisionsFrom, voiceDecisionsPortOver, type VoiceDecisionsPort } from './voicePort'

const VOICE = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const PERSON = 'ef'.repeat(32)
const ELSE = 'fa'.repeat(32)

const binding = (over: Partial<VoiceBinding> = {}): VoiceBinding => ({
  voice: VOICE,
  person: PERSON,
  assertedBy: PERSON,
  at: 1,
  ...over,
})

function fakeFs(files: Map<string, string>, failWith?: Error): IndexFs {
  return {
    readFile: (path: string) => {
      if (failWith) return Promise.reject(failWith)
      const held = files.get(path)
      return held === undefined
        ? Promise.reject(new Error(`not found: ${path}`))
        : Promise.resolve(new TextEncoder().encode(held))
    },
    writeFile: (path: string, bytes: Uint8Array) => {
      files.set(path, new TextDecoder().decode(bytes))
      return Promise.resolve()
    },
    exists: (path: string) => Promise.resolve(files.has(path)),
    mkdir: () => Promise.resolve(),
    remove: (path: string) => {
      files.delete(path)
      return Promise.resolve()
    },
    rename: (from: string, to: string) => {
      const held = files.get(from)
      if (held !== undefined) {
        files.set(to, held)
        files.delete(from)
      }
      return Promise.resolve()
    },
    removeDir: () => Promise.resolve(),
    readDir: () => Promise.resolve([]),
  } as unknown as IndexFs
}

const portOn = (files = new Map<string, string>(), changed = () => {}) => {
  const queue = writeQueue()
  return { files, queue, port: voiceDecisionsPortOver(fakeFs(files), queue, changed) }
}

/** What `run` threw, or `null` — so a test can assert that it is an `Error` and what it says. */
function thrown(run: () => unknown): unknown {
  try {
    run()
  } catch (cause) {
    return cause
  }
  return null
}

/** `count` distinct voices, well-formed. */
const voices = (count: number): string[] => Array.from({ length: count }, (_, i) => i.toString(16).padStart(64, '0'))

/** A stored decisions file, with every collection empty unless given. */
const storedWith = (over: Record<string, unknown>): string =>
  JSON.stringify({ v: 1, bindings: [], blockedVoices: [], blockedPeople: [], ...over })

describe('decisionsFrom — the stored file, read back', () => {
  it.each([
    ['null', 'null'],
    ['a number', '42'],
    ['a string', '"decisions"'],
  ])('refuses a file that is %s rather than a record', (_name, text) => {
    const cause = thrown(() => decisionsFrom(text))
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe(`public: ${VOICE_DECISIONS_PATH} is not a record of decisions`)
  })

  it('reads a collection it does not find as empty, because absent is empty', () => {
    expect(decisionsFrom('{"v":1}')).toEqual({ bindings: [], blockedVoices: [], blockedPeople: [] })
  })

  it.each([
    ['bindings', 'bindings'],
    ['blocked voices', 'blockedVoices'],
    ['blocked people', 'blockedPeople'],
  ])('names the %s list when it is there and will not read', (name, key) => {
    const cause = thrown(() => decisionsFrom(storedWith({ [key]: 'not a list' })))
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe(`public: ${VOICE_DECISIONS_PATH} has a ${name} list that will not read`)
  })

  it('drops an entry of a blocked list that is not a string, and keeps the rest', () => {
    const held = decisionsFrom(storedWith({ blockedVoices: [VOICE, 7, null], blockedPeople: [{}, PERSON] }))
    expect(held.blockedVoices).toEqual([VOICE])
    expect(held.blockedPeople).toEqual([PERSON])
  })

  it.each([
    ['bindings', (count: number) => ({ bindings: voices(count).map((voice) => binding({ voice })) })],
    ['blocked voices', (count: number) => ({ blockedVoices: voices(count) })],
    ['blocked people', (count: number) => ({ blockedPeople: voices(count) })],
  ])('reads %s at exactly the cap, and refuses a file one past it', (_name, holding) => {
    expect(() => decisionsFrom(storedWith(holding(MAX_DECISIONS))), 'a file at the cap was refused').not.toThrow()
    const cause = thrown(() => decisionsFrom(storedWith(holding(MAX_DECISIONS + 1))))
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe(`public: ${VOICE_DECISIONS_PATH} holds more decisions than this build will keep`)
  })
})

describe('a reader who has decided nothing', () => {
  /* ⚠️ **A LOSSY READ FEEDING A WRITE MAKES THE LOSS PERMANENT.** Each of
     these read as "nothing decided", which silently stops every silence
     applying — and the next change writes that emptiness over the original.
     The reader hears somebody they blocked and there is nothing left to say
     they ever blocked them. Reproduced by audit. */
  it('refuses a decisions file whose blocked-voices list is not a list', async () => {
    const files = new Map<string, string>()
    files.set(VOICE_DECISIONS_PATH, JSON.stringify({ v: 1, bindings: [], blockedVoices: 'a', blockedPeople: [] }))
    const { port } = portOn(files)
    await expect(port.decisions()).rejects.toThrow(/blocked voices list that will not read/u)
  })

  /* ⚠️ **AND `bindings` WAS THE COLLECTION LEFT OUT OF THAT RULE.** The two
     blocked lists became fatal and this one kept reading a present-but-
     mistyped value as no bindings — so the next decision wrote that emptiness
     over every voice the reader had bound to a person, and the file is this
     device's own. Found by the 2026-09-13 audit. */
  it('refuses a decisions file whose bindings list is not a list, and writes nothing over it', async () => {
    const files = new Map<string, string>()
    const raw = JSON.stringify({ v: 1, bindings: 'x', blockedVoices: [], blockedPeople: [] })
    files.set(VOICE_DECISIONS_PATH, raw)
    const { port, queue } = portOn(files)

    const cause = await port.decisions().then(
      () => null,
      (error: unknown) => error,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(/bindings list that will not read/u)

    await port.blockVoice(VOICE).catch(() => {})
    await queue.idle()
    expect(files.get(VOICE_DECISIONS_PATH), 'the file it could not read must be intact').toBe(raw)
  })

  it('refuses a decisions file holding more than this build will keep', async () => {
    const files = new Map<string, string>()
    const many = Array.from({ length: MAX_DECISIONS + 1 }, (_, i) => `${i}`.padStart(64, '0'))
    files.set(VOICE_DECISIONS_PATH, JSON.stringify({ v: 1, bindings: [], blockedVoices: many, blockedPeople: [] }))
    const { port } = portOn(files)
    await expect(port.decisions()).rejects.toThrow(/more decisions than this build will keep/u)
  })

  /* ⚠️ **THE VALIDATOR THREW ON THE INPUT IT EXISTS TO JUDGE.** `isWellFormed`
     read `binding.voice` without checking it had one, so a `null` row took the
     whole read down — and the documented promise is that a malformed row is
     DROPPED and the rest survives. */
  it('drops a null binding and keeps every decision beside it', async () => {
    const files = new Map<string, string>()
    files.set(
      VOICE_DECISIONS_PATH,
      JSON.stringify({ v: 1, bindings: [null, { voice: 'x' }], blockedVoices: [VOICE], blockedPeople: [] }),
    )
    const { port } = portOn(files)
    const held = await port.decisions()
    expect(held.bindings, 'a malformed row was kept, or took the file down with it').toEqual([])
    expect(held.blockedVoices, 'one bad row lost the reader every silence they had').toEqual([VOICE])
  })

  it('has no decisions, and every voice is a stranger', async () => {
    const { port } = portOn()
    expect(await port.decisions()).toEqual({ bindings: [], blockedVoices: [], blockedPeople: [] })
    expect(await port.standing(VOICE)).toBe('stranger')
    expect(await port.person(VOICE)).toBeNull()
  })
})

describe('a file that will not read', () => {
  it('THROWS rather than reporting no decisions', async () => {
    /* ⚠️ **`readMarks` NAMES THIS AS THE MOST DESTRUCTIVE LINE IT EVER HAD.**
       Reporting nothing means the next write puts that nothing on disk over
       every decision the reader had made. */
    const port = voiceDecisionsPortOver(fakeFs(new Map(), new Error('the disk is busy')), writeQueue(), () => {})
    await expect(port.decisions()).rejects.toThrow(/disk is busy/u)
  })

  it('refuses a version this build does not write', async () => {
    const files = new Map([[VOICE_DECISIONS_PATH, '{"v":2,"bindings":[],"blockedVoices":[],"blockedPeople":[]}']])
    const { port } = portOn(files)
    await expect(port.decisions()).rejects.toThrow(/version 2/u)
  })

  it('drops a malformed binding without losing the rest of the file', async () => {
    /* It cannot change an answer — `standingOf` filters too — so refusing the
       whole file over one would lose every decision beside it. */
    const forged = { voice: VOICE, person: PERSON, assertedBy: ELSE, at: 1 }
    const files = new Map([
      [
        VOICE_DECISIONS_PATH,
        JSON.stringify({ v: 1, bindings: [forged, binding({ voice: OTHER })], blockedVoices: [], blockedPeople: [] }),
      ],
    ])
    const { port } = portOn(files)
    const held = await port.decisions()
    expect(held.bindings.map((one) => one.voice)).toEqual([OTHER])
    expect(await port.standing(VOICE)).toBe('stranger')
  })
})

describe('the lifecycle, through the file', () => {
  it('binds, survives a reload, and reverts on unbind', async () => {
    const { files, queue, port } = portOn()
    expect(await port.bind(binding())).toBeNull()
    await queue.idle()
    expect(await port.standing(VOICE)).toBe('bound')
    expect(await port.person(VOICE)).toBe(PERSON)

    /* A reload: a fresh port over the same bytes. */
    const again = portOn(files)
    expect(await again.port.standing(VOICE)).toBe('bound')

    await port.unbind(VOICE)
    await queue.idle()
    expect(await port.standing(VOICE)).toBe('stranger')
  })

  it('refuses a binding asserted by anybody but its subject', async () => {
    /* ⚠️ **ONE FRIEND TELLING THE READER WHO A THIRD PARTY'S PSEUDONYM IS** —
       which they cannot know, and which would let one circle member attribute
       a stranger's words to another. */
    const { port, queue } = portOn()
    expect(await port.bind(binding({ assertedBy: ELSE }))).toBe('not-theirs')
    await queue.idle()
    expect(await port.standing(VOICE)).toBe('stranger')
  })

  it('refuses a second person claiming one voice', async () => {
    const { port, queue } = portOn()
    await port.bind(binding())
    await queue.idle()
    expect(await port.bind(binding({ person: ELSE, assertedBy: ELSE, at: 9 }))).toBe('already-claimed')
    await queue.idle()
    expect(await port.person(VOICE)).toBe(PERSON)
  })

  it('lets one person hold several voices, because rotation exists', async () => {
    const { port, queue } = portOn()
    await port.bind(binding())
    await port.bind(binding({ voice: OTHER, at: 2 }))
    await queue.idle()
    expect([...(await port.voicesOf(PERSON))].sort()).toEqual([VOICE, OTHER].sort())
  })

  it('blocks a person and silences every voice bound to them', async () => {
    const { port, queue } = portOn()
    await port.bind(binding())
    await port.blockPerson(PERSON)
    await queue.idle()
    expect(await port.standing(VOICE)).toBe('blocked')
    expect(await port.person(VOICE)).toBeNull()

    await port.unblockPerson(PERSON)
    await queue.idle()
    expect(await port.standing(VOICE)).toBe('bound')
  })

  it('blocks one voice whoever it belongs to', async () => {
    const { port, queue } = portOn()
    await port.blockVoice(OTHER)
    await queue.idle()
    expect(await port.standing(OTHER)).toBe('blocked')
    await port.unblockVoice(OTHER)
    await queue.idle()
    expect(await port.standing(OTHER)).toBe('stranger')
  })

  it('keeps the bindings when a person is blocked', async () => {
    /* ⚠️ **DELETING THEM WOULD BE LOUDER, NOT QUIETER**: the person's voices
       would become strangers and the block would stop applying. */
    const { port, queue } = portOn()
    await port.bind(binding())
    await port.blockPerson(PERSON)
    await queue.idle()
    expect((await port.decisions()).bindings).toHaveLength(1)
  })
})

describe('the write is one queued transaction', () => {
  it('two overlapping binds do not overwrite each other', async () => {
    /* The read is inside the lane; two callers folding from one snapshot and
       writing in turn is how the second erases the first. */
    const { port, queue } = portOn()
    await Promise.all([port.bind(binding()), port.bind(binding({ voice: OTHER, at: 2 }))])
    await queue.idle()
    expect((await port.decisions()).bindings).toHaveLength(2)
  })

  it('tells its listeners once a decision landed, and not on a refusal', async () => {
    const changed = vi.fn()
    const { port, queue } = portOn(new Map(), changed)
    const listener = vi.fn()
    port.subscribe(listener)
    await port.bind(binding())
    await queue.idle()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledTimes(1)

    await port.bind(binding({ assertedBy: ELSE }))
    await queue.idle()
    expect(listener, 'a refusal was announced as a change').toHaveBeenCalledTimes(1)
  })

  it('stops telling a listener once it has unsubscribed', async () => {
    const { port, queue } = portOn()
    const listener = vi.fn()
    const unsubscribe = port.subscribe(listener)
    unsubscribe()
    await port.blockVoice(VOICE)
    await queue.idle()
    expect(listener, 'an unsubscribed listener was told').not.toHaveBeenCalled()
  })

  it('names this store when a listener throws, and the decision still lands', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { port, queue } = portOn()
      port.subscribe(() => {
        throw new Error('a pane that broke')
      })
      await port.blockVoice(VOICE)
      await queue.idle()
      expect(await port.standing(VOICE)).toBe('blocked')
      expect(reported).toHaveBeenCalledWith(
        'Paper: a voice decisions subscriber threw while being notified',
        expect.any(Error),
      )
    } finally {
      reported.mockRestore()
    }
  })

  it('writes a binding said again with a newer time, and tells its listeners', async () => {
    const { port, queue } = portOn()
    await port.bind(binding({ at: 1 }))
    await queue.idle()
    const listener = vi.fn()
    port.subscribe(listener)
    expect(await port.bind(binding({ at: 2 }))).toBeNull()
    await queue.idle()
    expect((await port.decisions()).bindings.map((one) => one.at), 'the newer time was taken for no change').toEqual([2])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('writes a reordering, because the order is the reader’s own', async () => {
    /* The same person and the same time for both, so only WHICH voice sits
       where tells the two orders apart. */
    const { port, queue } = portOn()
    await port.bind(binding())
    await port.bind(binding({ voice: OTHER }))
    await queue.idle()
    /* Said again, so it moves to the end. */
    await port.bind(binding())
    await queue.idle()
    expect((await port.decisions()).bindings.map((one) => one.voice), 'a reordering was taken for no change').toEqual([
      OTHER,
      VOICE,
    ])
  })
})

describe('the store is bounded', () => {
  it('refuses past the number of decisions this device will keep', async () => {
    const many = Array.from({ length: MAX_DECISIONS }, (_, i) => `${i}`.padStart(64, '0'))
    const files = new Map([
      [VOICE_DECISIONS_PATH, JSON.stringify({ v: 1, bindings: [], blockedVoices: many, blockedPeople: [] })],
    ])
    const { port, queue } = portOn(files)
    await expect(port.blockVoice(VOICE)).rejects.toThrow(/decisions it will keep/u)
    await queue.idle()
  })

  it('writes nothing and tells nobody when the decision is already made', async () => {
    /* ⚠️ **A NO-OP REWROTE THE WHOLE FILE AND REFRESHED EVERY PANE.** Blocking
       a voice that is already blocked wrote the same bytes back — and could
       report a WRITE FAILURE for a change that did not need making, which
       reaches the reader as "your silence did not take" when it is already in
       place. */
    const { files, port, queue } = portOn()
    await port.blockVoice(VOICE)
    await port.bind(binding())
    await queue.idle()
    const before = files.get(VOICE_DECISIONS_PATH)
    let told = 0
    port.subscribe(() => {
      told += 1
    })
    /* The same block again, and a binding that is already held. */
    await port.blockVoice(VOICE)
    await port.bind(binding())
    await queue.idle()
    expect(told, 'a change that changed nothing was announced').toBe(0)
    expect(files.get(VOICE_DECISIONS_PATH), 'the file was rewritten for nothing').toBe(before)
  })

  it.each<[string, (count: number) => Record<string, unknown>, (port: VoiceDecisionsPort) => Promise<unknown>]>([
    [
      'bindings',
      (count) => ({ bindings: voices(count).map((voice) => binding({ voice })) }),
      (port) => port.bind(binding({ voice: 'ff'.repeat(32) })),
    ],
    ['blocked voices', (count) => ({ blockedVoices: voices(count) }), (port) => port.blockVoice('ff'.repeat(32))],
    ['blocked people', (count) => ({ blockedPeople: voices(count) }), (port) => port.blockPerson('ff'.repeat(32))],
  ])('writes %s up to the cap, and refuses the decision past it', async (_name, holding, decide) => {
    const under = portOn(new Map([[VOICE_DECISIONS_PATH, storedWith(holding(MAX_DECISIONS - 1))]]))
    await decide(under.port)
    await under.queue.idle()
    expect(
      JSON.stringify(await under.port.decisions()),
      'the decision that reaches the cap was not written',
    ).toContain('ff'.repeat(32))

    const at = portOn(new Map([[VOICE_DECISIONS_PATH, storedWith(holding(MAX_DECISIONS))]]))
    const cause = await decide(at.port).then(
      () => null,
      (error: unknown) => error,
    )
    await at.queue.idle()
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe(`public: this device already holds the ${MAX_DECISIONS} decisions it will keep`)
  })

  it('copies the binding it is handed, so mutating it afterwards changes nothing', async () => {
    /* ⚠️ **THE CALLER'S OBJECT WAS HELD ACROSS THE QUEUE AND THE READ.**
       `readonly` on the interface stops nothing: the caller keeps its own
       reference, and mutating it in between changed what was validated and
       what was written. */
    const { port, queue } = portOn()
    const binding = { voice: VOICE, person: PERSON, assertedBy: PERSON, at: 1 }
    const pending = port.bind(binding)
    binding.voice = 'ff'.repeat(32)
    binding.person = 'ee'.repeat(32)
    await pending
    await queue.idle()
    expect(await port.person(VOICE), 'the binding was changed under the port').toBe(PERSON)
  })
})
