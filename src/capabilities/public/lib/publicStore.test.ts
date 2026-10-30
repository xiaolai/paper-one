import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LIFETIME_MS,
  EMPTY_PUBLIC_FILE,
  MAX_HELD_BYTES_PER_BOOK,
  MAX_TASK_MS,
  VERIFY_PER_TASK,
  foldPublic,
  MAX_HELD_PER_BOOK,
  PUBLIC_SUPPORTED,
  PUBLIC_VERSION,
  canonicalJson,
  isPublicEnvelopeShape,
  publicPathIn,
  publicSignedBytes,
  type IndexFs,
  type PublicCrypto,
  type PublicEnvelope,
  type WriteQueue,
  writeQueue,
} from '../../../kernel'
import {
  MAX_CONFLICTS_PER_BOOK,
  MAX_EVIDENCE_BYTES_PER_BOOK,
  MAX_STORED_BYTES_PER_BOOK,
  MAX_SUPPRESSIONS_PER_BOOK,
  readPublic,
  takePublic,
  writePublic,
} from './publicStore'

/* The book every fixture below is about. `readPublic` and `takePublic` take it
   explicitly now — an envelope for ANOTHER book was otherwise accepted out of
   this book's file, so the expected hash is not optional and these wrappers
   keep the fixtures reading as they did. */
const readPublic2 = (
  fs: Parameters<typeof readPublic>[0],
  bookId: string,
  crypto: Parameters<typeof readPublic>[3],
  now: number,
  blocked: (voice: string) => boolean,
) => readPublic(fs, bookId, BOOK, crypto, now, blocked)

const takePublic2 = (
  held: Parameters<typeof takePublic>[0],
  lines: readonly string[],
  crypto: Parameters<typeof takePublic>[3],
  now: number,
  blocked: (voice: string) => boolean,
  pace: Parameters<typeof takePublic>[6],
) => takePublic(held, lines, BOOK, crypto, now, blocked, pace)

const VOICE = 'a'.repeat(64)
const BOOK = 'b'.repeat(64)
const SIG = 'c'.repeat(128)
const NOW = 1_700_000_000_000
const never = () => false

/** Verifies anything whose bytes are in `accepts`. */
function crypto(accepts: Set<string>): PublicCrypto {
  return { verify: (key, message, sig) => key === VOICE && sig === SIG && accepts.has(message) }
}

const accepted = new Set<string>()
function unnote(over: Partial<PublicEnvelope> = {}): string {
  const { passage: _gone, ...rest } = JSON.parse(note()) as Record<string, unknown>
  const envelope = { ...rest, op: 'unnote', seq: 2, ...over } as unknown as PublicEnvelope
  accepted.add(publicSignedBytes(envelope.v, envelope))
  return canonicalJson(envelope)
}

function note(over: Partial<PublicEnvelope> = {}): string {
  const envelope = {
    v: PUBLIC_VERSION,
    voice: VOICE,
    book: BOOK,
    seq: 1,
    at: NOW,
    expires: NOW + DEFAULT_LIFETIME_MS,
    pub: 'p1',
    op: 'note',
    passage: { quote: 'a sentence', prefix: '', suffix: '', chapter: '' },
    sig: SIG,
    ...over,
  } as PublicEnvelope
  accepted.add(publicSignedBytes(envelope.v, envelope))
  return canonicalJson(envelope)
}

/** A filesystem that holds one file, and can be told to fail. */
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

const encoded = (text: string): Uint8Array => new TextEncoder().encode(text)

/**
 * The same filesystem over BYTES, for the cases where a line's bytes are the
 * assertion — `fakeFs` above decodes every write to a string, which is the
 * very step that altered them.
 */
function bytesFs(files: Map<string, Uint8Array>): IndexFs {
  return {
    readFile: (path: string) => {
      const held = files.get(path)
      return held === undefined ? Promise.reject(new Error(`not found: ${path}`)) : Promise.resolve(held.slice())
    },
    writeFile: (path: string, bytes: Uint8Array) => {
      files.set(path, bytes.slice())
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

/** A stored file of these lines, each ended by a newline — the layout `writePublic` writes. */
function fileOf(lines: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(lines.reduce((sum, line) => sum + line.length + 1, 0))
  let at = 0
  for (const line of lines) {
    out.set(line, at)
    at += line.length
    out[at] = 0x0a
    at += 1
  }
  return out
}

/** A stored file's lines, as bytes, the blank ones dropped as the reader drops them. */
function linesIn(file: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  let start = 0
  for (let at = 0; at <= file.length; at += 1) {
    if (at === file.length || file[at] === 0x0a) {
      if (at > start) out.push(file.slice(start, at))
      start = at + 1
    }
  }
  return out
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, at) => byte === b[at])

/** One canonical line as the fold takes it. */
const delivered = (line: string) => ({ envelope: JSON.parse(line) as PublicEnvelope, received: line })

const pace = { breathe: () => Promise.resolve(), live: () => true }
const lanes = { queue: writeQueue() as WriteQueue, lane: (bookId: string) => bookId }

/** Verifies any voice's signature over accepted bytes — for the fixtures with more than one voice. */
const anyVoice: PublicCrypto = { verify: (_key, message, sig) => sig === SIG && accepted.has(message) }

/** The stored file's lines, as text, the blank ones dropped. */
const storedLines = (files: Map<string, string>): string[] =>
  (files.get(publicPathIn('book:1')) ?? '').split('\n').filter((line) => line !== '')

/** What the store holds in ENVELOPES — the record of what equivocated is not one. */
const envelopeLines = (files: Map<string, string>): string[] =>
  storedLines(files).filter((line) => !line.startsWith('{"equivocated":'))

/** The store's record of the sequences it has seen equivocated, or `null` where it keeps none. */
const conflictLine = (files: Map<string, string>): string | null =>
  storedLines(files).find((line) => line.startsWith('{"equivocated":')) ?? null

/**
 * Run `work` with the platform's idle callback stood in for, and hand back
 * every breath it asked for — `breathe` asks for one where it exists and sleeps
 * where it does not, so this is how a test sees the thread being given back.
 */
async function breathsDuring<T>(work: () => Promise<T>): Promise<{ result: T; breaths: { timeout: number }[] }> {
  const breaths: { timeout: number }[] = []
  vi.stubGlobal('requestIdleCallback', (callback: () => void, options: { timeout: number }) => {
    breaths.push(options)
    callback()
  })
  try {
    return { result: await work(), breaths }
  } finally {
    vi.unstubAllGlobals()
  }
}

/** A note whose stored line, newline included, costs exactly `cost` bytes. */
function noteCosting(cost: number, seq: number, pub: string, at = NOW): string {
  const bare = note({ seq, pub, at, passage: { quote: '', prefix: '', suffix: '', chapter: '', note: '' } })
  let room = cost - (encoded(bare).length + 1)
  const fill = (limit: number): string => {
    const take = Math.min(room, limit)
    room -= take
    return 'x'.repeat(take)
  }
  const line = note({
    seq,
    pub,
    at,
    passage: { quote: fill(2_000), prefix: fill(2_000), suffix: fill(2_000), chapter: fill(500), note: fill(4_000) },
  })
  if (encoded(line).length + 1 !== cost) throw new Error(`the fixture cannot make a note of ${cost} bytes`)
  return line
}

/**
 * Pairs of notes at one sequence each — equivocations, which no bound on notes
 * trims — whose lines cost exactly `total` bytes between them.
 */
function equivocationsCosting(total: number, firstSeq: number): string[] {
  const EACH = 10_000
  const pairs = Math.floor(total / (2 * EACH))
  const rest = total - pairs * 2 * EACH
  const lines = Array.from({ length: pairs }, (_, i) => [
    noteCosting(EACH, firstSeq + i, `a${firstSeq + i}`),
    noteCosting(EACH, firstSeq + i, `b${firstSeq + i}`),
  ]).flat()
  const last = firstSeq + pairs
  if (rest > 0) {
    lines.push(noteCosting(Math.ceil(rest / 2), last, `a${last}`), noteCosting(Math.floor(rest / 2), last, `b${last}`))
  }
  return lines
}

describe('readPublic', () => {
  it('a book nobody has annotated is empty, not an error', () => {
    return readPublic2(fakeFs(new Map()), 'book:1', crypto(accepted), NOW, never).then((read) => {
      expect(read.file).toEqual(EMPTY_PUBLIC_FILE)
    })
  })

  it('a file that will not read THROWS rather than loading nothing', async () => {
    /* ⚠️ **`readMarks` NAMES THIS AS THE MOST DESTRUCTIVE LINE IT EVER HAD.** A
       momentary read failure loading nothing means the next write puts that
       nothing on disk over everything the reader had received. */
    const fs = fakeFs(new Map(), new Error('the disk is busy'))
    await expect(readPublic2(fs, 'book:1', crypto(accepted), NOW, never)).rejects.toThrow(/disk is busy/u)
  })

  it('verifies every stored line, and drops the ones that do not', async () => {
    /* ⚠️ **THE CIRCLE'S LOADER CHECKS NEITHER A SIGNATURE NOR A ROSTER**, and
       was safe only because the network receiver refused strangers upstream.
       There is no upstream here. */
    const good = note()
    const files = new Map([[publicPathIn('book:1'), `${good}\n${note({ pub: 'forged', seq: 2 }).replace(SIG, 'f'.repeat(128))}\n`]])
    const read = await readPublic2(fakeFs(files), 'book:1', crypto(accepted), NOW, never)
    expect(read.file.held).toHaveLength(1)
    expect(read.file.held[0]?.received).toBe(good)
    /* A well-formed line under a wrong signature is `bad-signature`, not
       `malformed` — the two are different facts and the tally says which. */
    expect(read.refused).toEqual({ 'bad-signature': 1 })
  })

  it('one stranger’s bad line does not cost the rest of the file', async () => {
    /* ⚠️ **A BAD LINE IS THE ORDINARY STATE OF A PUBLIC STORE.** Refusing the
       whole file over one would let anybody take a book's annotations away. */
    const good = note()
    const files = new Map([[publicPathIn('book:1'), `{ not json\n${good}\n\n`]])
    const read = await readPublic2(fakeFs(files), 'book:1', crypto(accepted), NOW, never)
    expect(read.file.held).toHaveLength(1)
    expect(read.refused.malformed).toBe(1)
  })

  it('drops a blocked voice on load, not only on arrival', async () => {
    const files = new Map([[publicPathIn('book:1'), `${note()}\n`]])
    const read = await readPublic2(fakeFs(files), 'book:1', crypto(accepted), NOW, (v: string) => v === VOICE)
    expect(read.file.held).toEqual([])
    expect(read.refused.blocked).toBe(1)
    /* A block is the reader's rule for what is drawn, applied to a line that
       READ — see `PublicRead.unreadable` — so it is not carried as damage. */
    expect(read.unreadable, 'a line the reader silenced was reported as one this build cannot read').toEqual([])
  })

  it('splits the stored file at its newline bytes, whether or not the last line ends in one', async () => {
    /* A one-byte first line, so a split that confused "no newline found" with
       a newline at index one would read the whole file as a single line — and
       no newline at the end, which a truncated file has. */
    const good = note()
    const files = new Map([[publicPathIn('book:1'), `x\n${good}`]])
    const read = await readPublic2(fakeFs(files), 'book:1', crypto(accepted), NOW, never)
    expect(read.file.held.map((one) => one.received)).toEqual([good])
    expect(read.unreadable).toEqual([encoded('x')])
  })

  it('gives the thread back between the slices it verifies, under the task ceiling', async () => {
    /* WI-26.7: verification is sliced, and the breath between two slices is
       what returns the frame to the reader. One line past a slice, one breath. */
    const lines = Array.from({ length: VERIFY_PER_TASK + 1 }, (_, i) => note({ seq: i + 1, pub: `p${i}` }))
    const files = new Map([[publicPathIn('book:1'), `${lines.join('\n')}\n`]])
    const { result, breaths } = await breathsDuring(() =>
      readPublic2(fakeFs(files), 'book:1', crypto(accepted), NOW, never),
    )
    expect(result.file.held).toHaveLength(lines.length)
    expect(breaths, 'a sliced load did not give the thread back, or not under the ceiling').toEqual([
      { timeout: MAX_TASK_MS },
    ])
  })

  it('drops an expired line on load', async () => {
    const files = new Map([[publicPathIn('book:1'), `${note()}\n`]])
    const read = await readPublic2(fakeFs(files), 'book:1', crypto(accepted), NOW + DEFAULT_LIFETIME_MS + 1, never)
    expect(read.file.held).toEqual([])
    expect(read.refused.expired).toBe(1)
  })
})

describe('takePublic', () => {
  it('yields between slices and stops when the book closes', async () => {
    /* ⚠️ **VERIFICATION IS NEW MAIN-THREAD WORK AND IS SYNCHRONOUS BY
       DESIGN.** A load of a thousand envelopes is a thousand Ed25519 checks in
       one task without this. */
    const lines = Array.from({ length: 200 }, (_, i) => note({ seq: i + 1, pub: `p${i}` }))
    let breaths = 0
    const stopped = await takePublic2(EMPTY_PUBLIC_FILE, lines, crypto(accepted), NOW, never, {
      breathe: () => {
        breaths += 1
        return Promise.resolve()
      },
      live: () => breaths < 2,
    })
    expect(stopped, 'a cancelled load answered with a partial file').toBeNull()
    expect(breaths).toBeLessThan(7)
  })

  it('takes a whole batch when nothing cancels it', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => note({ seq: i + 1, pub: `p${i}` }))
    const read = await takePublic2(EMPTY_PUBLIC_FILE, lines, crypto(accepted), NOW, never, pace)
    expect(read?.file.held).toHaveLength(40)
  })

  it('stops admitting past the book’s retained bound', async () => {
    /* Traffic limits are not storage limits — WI-26.7's finding, at the write. */
    const lines = Array.from({ length: MAX_HELD_PER_BOOK + 50 }, (_, i) => note({ seq: i + 1, pub: `p${i}` }))
    const read = await takePublic2(EMPTY_PUBLIC_FILE, lines, crypto(accepted), NOW, never, pace)
    expect(read?.file.held.length).toBeLessThanOrEqual(MAX_HELD_PER_BOOK)
  })

  it('breathes between slices, and not after the last one', async () => {
    const breathsFor = async (count: number): Promise<number> => {
      let breaths = 0
      const lines = Array.from({ length: count }, (_, i) => note({ seq: i + 1, pub: `p${i}` }))
      await takePublic2(EMPTY_PUBLIC_FILE, lines, crypto(accepted), NOW, never, {
        breathe: () => {
          breaths += 1
          return Promise.resolve()
        },
        live: () => true,
      })
      return breaths
    }
    expect(await breathsFor(VERIFY_PER_TASK), 'one slice breathed after it').toBe(0)
    expect(await breathsFor(VERIFY_PER_TASK + 1)).toBe(1)
    expect(await breathsFor(2 * VERIFY_PER_TASK), 'the last slice breathed after it').toBe(1)
  })

  it('weighs notes by their bytes — the ones arriving and the ones the book already holds', async () => {
    /* Every line the same size, so where the byte bound falls is arithmetic
       here rather than a second implementation of `hasRoom`. The book holds one
       note fewer than fits, and three arrive: one fits. Weigh either side by
       anything but its bytes and all three do. */
    const big = {
      quote: 'x'.repeat(2_000),
      prefix: 'x'.repeat(2_000),
      suffix: 'x'.repeat(2_000),
      chapter: 'x'.repeat(500),
      note: 'x'.repeat(4_000),
    }
    const line = (seq: number): string => note({ seq, pub: `p${seq}`, passage: big })
    const cost = encoded(line(100)).length + 1
    const fits = Math.floor(MAX_HELD_BYTES_PER_BOOK / cost)
    expect(fits, 'the byte bound has to bite before the count bound').toBeLessThan(MAX_HELD_PER_BOOK)
    const held = foldPublic(
      EMPTY_PUBLIC_FILE,
      Array.from({ length: fits - 1 }, (_, i) => delivered(line(100 + i))),
      NOW,
    )
    const arriving = [line(900), line(901), line(902)]
    expect(
      [held.held[held.held.length - 1]!.received, ...arriving].every((one) => encoded(one).length + 1 === cost),
      'the fixture lines differ in size',
    ).toBe(true)

    const read = await takePublic2(held, arriving, crypto(accepted), NOW, never, pace)
    expect(read?.refused, 'notes were not weighed by their bytes').toEqual({ full: 2 })
    expect(read?.file.held).toHaveLength(fits)
  })

  it('spends no room on a line it already holds, or twice on a line that arrives twice', async () => {
    /* Room for exactly two more, so a duplicate that spent any pushes the last
       real arrival out. */
    const base = foldPublic(
      EMPTY_PUBLIC_FILE,
      Array.from({ length: MAX_HELD_PER_BOOK - 2 }, (_, i) => delivered(note({ seq: i + 1, pub: `p${i}` }))),
      NOW,
    )
    const twice = note({ seq: 9_001, pub: 'twice' })
    const last = note({ seq: 9_002, pub: 'last' })
    const arriving = [note({ seq: 1, pub: 'p0' }), twice, twice, last]
    const read = await takePublic2(base, arriving, crypto(accepted), NOW, never, pace)
    expect(read?.refused, 'a duplicate spent room').toEqual({})
    expect(read?.file.held.map((one) => one.pub)).toContain('last')
    expect(read?.file.held).toHaveLength(MAX_HELD_PER_BOOK)
  })

  /* ⚠️ **A WITHDRAWAL TOOK A NOTE'S ROOM IF IT ARRIVED FIRST.** Admission
     counted everything it took against the note bound, so a batch of one
     withdrawal and one note refused the note from a book with room for it —
     the rule `admit` states, *capacity is about live notes*, broken inside a
     single batch. Found by the 2026-09-14 mutation sweep. */
  it('lets no withdrawal arriving beside a note take that note’s room', async () => {
    const base = foldPublic(
      EMPTY_PUBLIC_FILE,
      Array.from({ length: MAX_HELD_PER_BOOK - 1 }, (_, i) => delivered(note({ seq: i + 1, pub: `p${i}` }))),
      NOW,
    )
    const read = await takePublic2(
      base,
      [unnote({ seq: 9_000, pub: 'never-held' }), note({ seq: 9_001, pub: 'last' })],
      crypto(accepted),
      NOW,
      never,
      pace,
    )
    expect(read?.refused, 'the withdrawal was weighed as a note').toEqual({})
    expect(read?.file.held.map((one) => one.pub)).toContain('last')
  })
})

describe('writePublic — one queued transaction', () => {
  const write = (fs: ReturnType<typeof fakeFs>, lines: readonly string[]) =>
    writePublic(fs, lanes, 'book:1', BOOK, lines, crypto(accepted), NOW, never)

  it('writes the received bytes verbatim, one per line', async () => {
    /* ⚠️ **WHAT IS STORED IS WHAT WAS SIGNED.** No projection, so there is
       nothing separately mutable to move the hole into. */
    const files = new Map<string, string>()
    await write(fakeFs(files), [note()])
    await lanes.queue.idle()
    expect(files.get(publicPathIn('book:1'))).toBe(`${note()}\n`)
  })

  it('writes an empty file rather than a stray newline when nothing is held', async () => {
    const files = new Map<string, string>()
    await write(fakeFs(files), [])
    await lanes.queue.idle()
    expect(files.get(publicPathIn('book:1'))).toBe('')
  })

  it('round-trips through the reader', async () => {
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    await write(fs, [note(), note({ seq: 2, pub: 'p2' })])
    await lanes.queue.idle()
    const back = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    expect(back.file.held.map((one) => one.pub).sort()).toEqual(['p1', 'p2'])
    expect(back.refused).toEqual({})
  })

  it('keeps a withdrawal across a reload, so a replay does not revive the note', async () => {
    /* ⚠️ **MEASURED BY AUDIT: A WITHDRAWAL SURVIVED THE FOLD, DISAPPEARED
       AFTER SAVING AND RELOADING, AND REPLAYING THE NOTE RESTORED IT.** The
       store wrote only the live notes, so the two things WI-26.3 is about died
       with the process. */
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    await write(fs, [note(), unnote()])
    await lanes.queue.idle()
    const back = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    expect(back.file.held).toEqual([])
    expect(back.file.withdrawn).toHaveLength(1)

    await write(fs, [note()])
    await lanes.queue.idle()
    const again = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    expect(again.file.held, 'a replayed note revived across a restart').toEqual([])
  })

  it('two overlapping writes do not overwrite each other', async () => {
    /* ⚠️ **ONLY THE FINAL SNAPSHOT WRITE USED TO RUN INSIDE THE LANE.** Two
       callers folded independently from the same old state and then wrote in
       turn, so whichever wrote second erased the other's arrivals. */
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    await Promise.all([write(fs, [note()]), write(fs, [note({ seq: 2, pub: 'p2' })])])
    await lanes.queue.idle()
    const back = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    expect(back.file.held.map((one) => one.pub).sort()).toEqual(['p1', 'p2'])
  })

  it('admits a withdrawal even when the book is full of notes', async () => {
    /* ⚠️ **MEASURED BY AUDIT: WITH 512 HELD NOTES A VALID WITHDRAWAL WAS
       SILENTLY DISCARDED AND ALL 512 REMAINED.** The reader's "take it back"
       must not be droppable by somebody else filling the book first. */
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const many = Array.from({ length: MAX_HELD_PER_BOOK + 20 }, (_, i) => note({ seq: i + 1, pub: `p${i}` }))
    await write(fs, many)
    await lanes.queue.idle()
    const full = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    expect(full.file.held.length).toBeGreaterThan(0)

    const target = full.file.held[0]!.pub
    await write(fs, [unnote({ seq: 9999, pub: target })])
    await lanes.queue.idle()
    const after = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    expect(after.file.held.some((one) => one.pub === target), 'the withdrawal was dropped for want of room').toBe(false)
    expect(after.file.withdrawn.map((one) => one.key)).toContain(`${VOICE}#${target}`)
  })

  /* ⚠️ **THE TEST ABOVE PASSED WITH THE DEFECT PRESENT, AND THIS ONE IS WHY IT
     HAD TO EXIST.** The refusal was a `break`, which abandons only the REST OF
     THE CURRENT SLICE — and `VERIFY_PER_TASK` is 32, so a withdrawal written
     after 532 notes landed in a later slice and was processed normally. The
     drop happens only when the note that meets a full book and the withdrawal
     share ONE slice. A batch is exactly where they do. */
  it('admits a withdrawal that arrives in the same batch as a note the full book refused', async () => {
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const many = Array.from({ length: MAX_HELD_PER_BOOK }, (_, i) => note({ seq: i + 1, pub: `p${i}` }))
    await write(fs, many)
    await lanes.queue.idle()
    const full = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    expect(full.file.held).toHaveLength(MAX_HELD_PER_BOOK)
    const target = full.file.held[0]!.pub

    /* One line the book has no room for, then the withdrawal immediately
       behind it — adjacent, so nothing can put them in separate slices. */
    const outcome = await write(fs, [note({ seq: 8000, pub: 'crowd' }), unnote({ seq: 9999, pub: target })])
    await lanes.queue.idle()
    const after = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)

    expect(after.file.held.some((one) => one.pub === target), 'the withdrawal behind a refused note was lost').toBe(
      false,
    )
    expect(after.file.withdrawn.map((one) => one.key)).toContain(`${VOICE}#${target}`)
    /* And the refusal is REPORTED rather than silent: a capacity drop used to
       produce no reason at all, so the one refusal a reader might need
       explained was the only one with no diagnostic.

       ⚠️ **THIS ASKED THE RELOAD FOR IT, AND THE RELOAD ANSWERED FOR THE WRONG
       REASON.** `after.refused.full` was never the refused note — that was
       refused by the WRITE — but a note the write had KEPT, dropped by the
       reload because the withdrawal written ahead of it took its room. So the
       assertion passed on the defect below it (2026-09-14 mutation sweep). */
    expect(outcome.refused, 'the note the full book refused was not reported').toEqual({ full: 1 })
    expect(after.file.held, 'the reload dropped a note the write had kept').toHaveLength(MAX_HELD_PER_BOOK - 1)
    expect(after.refused).toEqual({})
  })

  /* ⚠️ **A BYTE BUDGET COUNTED IN UTF-16 UNITS IS INVISIBLE TO EVERY TEST
     WRITTEN IN ENGLISH**, because ASCII makes the two units identical. This is
     the assertion that makes the mismatch loud: Chinese is one unit and three
     bytes, so a store admitted under `.length` overshoots the read gate — which
     measures UTF-8 — and the next read refuses the whole file, permanently. */
  /* ⚠️ **A FLOOD OF WITHDRAWALS COULD MAKE A BOOK PERMANENTLY UNREADABLE.**
     Suppression lines were kept without limit — right about the danger of
     evicting one, wrong about the cost — so twelve thousand of them took the
     file past what its own reader accepts, and every later load refused it
     whole. That loses every REAL suppression too, and never recovers. */
  /* ⚠️ **A CEILING THAT IS A FRACTION OF THE TEST'S OWN RUNTIME IS A THROUGHPUT
     ASSERTION.** These two tests sign, write and re-verify thousands of envelopes
     on purpose, and their sizes are measured rather than chosen — 12 000 is where
     `MAX_STORED_BYTES_PER_BOOK` falls, and a smaller flood passes with the bound
     removed. At rest they take 8.1 s and 3.2 s against the project's 15 s, so
     they run with a 1.9x and 4.7x margin while `vitest.config.ts` records a
     SEVEN-FOLD inflation under load. Both duly timed out in `pnpm test:coverage`
     on 2026-09-10 while passing in isolation — measured at 8.0 s and 2.9 s WITH
     coverage, so instrumentation is not the cost and contention is.

     60 s is not a multiple of the runtime; it is the same bound the `scripts` and
     `app` projects already carry and its only job is that a genuine hang fails
     rather than hangs. This is the class `blobs.rs`'s `TRANSFER_LIVENESS` and
     `vitest.setup.ts`'s `asyncUtilTimeout` were both fixed under: **contention
     has no ceiling, so no multiple of observed runtime is safe.**

     ⚠️ **DO NOT "FIX" THIS BY SHRINKING THE FLOOD.** The count is the assertion. */
  const FLOOD_TIMEOUT_MS = 60_000

  it('bounds withdrawals that suppress nothing, so a flood cannot brick the book', async () => {
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    /* One real note and its real withdrawal — the reader's own take-back. */
    await write(fs, [note({ seq: 1, pub: 'mine' })])
    await lanes.queue.idle()
    await write(fs, [unnote({ seq: 2, pub: 'mine' })])
    await lanes.queue.idle()

    /* Then a flood of withdrawals for publications this device has never seen.
       ⚠️ **THE COUNT IS MEASURED, NOT GUESSED.** An `unnote` line is 379 bytes,
       so ~11 000 of them is where `MAX_STORED_BYTES_PER_BOOK` falls — and a
       smaller flood passes this test with the bound removed, proving nothing.
       Two batches rather than many: each write re-reads and re-verifies the
       whole store, and the point here is the total, not the pacing. */
    const junk = Array.from({ length: 12_000 }, (_, i) => unnote({ seq: 10_000 + i, pub: `junk${i}` }))
    await write(fs, junk.slice(0, 6_000))
    await lanes.queue.idle()
    await write(fs, junk.slice(6_000))
    await lanes.queue.idle()

    const stored = new TextEncoder().encode(files.get(publicPathIn('book:1')) ?? '').length
    expect(stored, 'the store grew past what its own reader will accept').toBeLessThanOrEqual(
      MAX_STORED_BYTES_PER_BOOK,
    )
    /* And it is still READABLE, which is the whole point. */
    const back = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    /* ⚠️ **THE READER'S OWN WITHDRAWAL SURVIVED THE FLOOD.** It suppresses a
       note this device holds, so it is never in the set that gets trimmed. */
    expect(back.file.withdrawn.map((one) => one.key)).toContain(`${VOICE}#mine`)
    expect(back.file.held.some((one) => one.pub === 'mine'), 'the withdrawn note came back').toBe(false)
    /* ⚠️ **THIS TEST RAN UNDER THE 15 s DEFAULT, AND IT IS THE ONE THE BOUND
       ABOVE WAS WRITTEN FOR.** `FLOOD_TIMEOUT_MS` closed the test after it
       instead — a cheap one — so this took 12.5 s alone and timed out beside a
       sweep (2026-09-14). */
  }, FLOOD_TIMEOUT_MS)

  it('trims the withdrawals that suppress nothing oldest first, keeps every one that does, and says so', async () => {
    /* ⚠️ **THE FLOOD ABOVE PASSES WITH THE TRIM'S ORDER, ITS ROOM AND ITS TALLY
       ALL WRONG.** Its junk outnumbers the room many times over, and the one
       withdrawal it checks sorts first either way. This is sized to the room:
       one orphan too many, and the one to go is the newest — which sits in the
       middle of the stored order, so neither that order nor its reverse can
       pass for the rule. */
    expect(MAX_SUPPRESSIONS_PER_BOOK, 'twice the note cap').toBe(2 * MAX_HELD_PER_BOOK)
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const takeBack = unnote({ seq: 2, pub: 'mine', at: NOW })
    const newest = MAX_HELD_PER_BOOK
    const orphans = Array.from({ length: MAX_SUPPRESSIONS_PER_BOOK }, (_, i) =>
      unnote({ seq: 10_000 + i, pub: `junk${i}`, at: i === newest ? NOW - 1 : NOW - 60_000 }),
    )
    const outcome = await write(fs, [note({ seq: 1, pub: 'mine' }), takeBack, ...orphans])
    await lanes.queue.idle()

    expect(outcome.refused, 'an orphan was let go and nothing said so').toEqual({ full: 1 })
    const lines = storedLines(files)
    expect(lines, 'the reader’s own withdrawal was trimmed as if it suppressed nothing').toContain(takeBack)
    expect(lines, 'a newer orphan was kept over an older one').not.toContain(orphans[newest])
    expect(lines).toContain(orphans[0])
    expect(lines).toContain(orphans[orphans.length - 1])
    expect(lines).toHaveLength(1 + 1 + MAX_SUPPRESSIONS_PER_BOOK - 1)
  })

  it('keeps a withdrawal of something it has never held, so the note cannot arrive after it', async () => {
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    await write(fs, [unnote({ seq: 5, pub: 'later' })])
    await lanes.queue.idle()
    await write(fs, [note({ seq: 1, pub: 'later' })])
    await lanes.queue.idle()
    const back = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    expect(back.file.held, 'a note that arrived after its own withdrawal was drawn').toEqual([])
  })

  it('writes each side of an equivocation once, whichever operation it is', async () => {
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const said = note({ seq: 3, pub: 'said' })
    const unsaid = unnote({ seq: 3, pub: 'said' })
    const outcome = await write(fs, [said, unsaid])
    await lanes.queue.idle()
    expect(outcome.file.equivocated.map((one) => one.key)).toEqual([`${VOICE}#3`])
    expect(envelopeLines(files).sort(), 'a line was written twice').toEqual([said, unsaid].sort())
  })

  it('gives the thread back between the slices of a batch it takes, under the task ceiling', async () => {
    const lines = Array.from({ length: VERIFY_PER_TASK + 1 }, (_, i) => note({ seq: i + 1, pub: `p${i}` }))
    const { result, breaths } = await breathsDuring(() => write(fakeFs(new Map()), lines))
    await lanes.queue.idle()
    expect(result.file.held).toHaveLength(lines.length)
    expect(breaths, 'a sliced batch did not give the thread back, or not under the ceiling').toEqual([
      { timeout: MAX_TASK_MS },
    ])
  })

  /* ⚠️ **EQUIVOCATION EVIDENCE HAD NO BOUND, SO ONE STRANGER COULD BLOCK A
     BOOK.** Both sides of an equivocation are kept as evidence and no bound on
     notes trims them, so two batches that each fill the note bound put the
     stored bound's worth on disk — and from then on the write's size guard
     refused every arrival, genuine or not, until the evidence expired
     (2026-09-14). STORED as those batches leave it rather than taken through
     them: admission re-weighs every note held for each one arriving, which was
     nearly the whole cost of this test. */
  it('bounds equivocation evidence, so a flood of it cannot refuse a genuine note', async () => {
    const files = new Map<string, Uint8Array>()
    const fs = bytesFs(files)
    const half = MAX_STORED_BYTES_PER_BOOK / 2
    files.set(
      publicPathIn('book:1'),
      fileOf([...equivocationsCosting(half, 1), ...equivocationsCosting(half, 1_000)].map(encoded)),
    )

    const genuine = note({ seq: 5_000, pub: 'genuine' })
    const outcome = await writePublic(fs, lanes, 'book:1', BOOK, [genuine], crypto(accepted), NOW, never)
    await lanes.queue.idle()

    expect(outcome.refused, 'evidence was let go and nothing said so').toEqual({ full: 1 })
    const stored = linesIn(files.get(publicPathIn('book:1'))!).map((line) => new TextDecoder().decode(line))
    expect(stored, 'the genuine note did not land').toContain(genuine)
    const evidence = stored.filter((line) => line !== genuine && !line.startsWith('{"equivocated":'))
    expect(
      evidence.reduce((sum, line) => sum + encoded(line).length + 1, 0),
      'the evidence outgrew its bound',
    ).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES_PER_BOOK)
    const back = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    expect(back.file.held.map((one) => one.pub), 'a kept side was drawn, or the note was not').toEqual(['genuine'])
  })

  it('evicts evidence a whole sequence at a time, oldest kept first, never one side of a pair', async () => {
    /* Sized so the ORDER is the assertion. The bound fits every group but one;
       the one let go is neither the last stored nor the newest, and the group
       behind it fills the bound to the byte. Keeping groups in stored order,
       newest first, or by a group's newest line lets a different one go. One
       group is three spellings, and one is a note beside a withdrawal. */
    const files = new Map<string, string>()
    const oldest = [1, 2, 3].map((i) => noteCosting(10_000, 50, `a${i}`, NOW - 90_000))
    const unsaid = unnote({ seq: 40, pub: 'w-unsaid', at: NOW })
    const beside = [noteCosting(11_000 - (encoded(unsaid).length + 1), 40, 'w-said', NOW - 80_000), unsaid]
    const middle = Array.from({ length: 22 }, (_, i) => [
      noteCosting(10_750, 10 + i, `b${i}`, NOW - 70_000 + i),
      noteCosting(10_750, 10 + i, `c${i}`, NOW - 70_000 + i),
    ]).flat()
    const letGo = [noteCosting(5_250, 4, 'big-a', NOW - 20), noteCosting(5_250, 4, 'big-b', NOW - 20)]
    const fills = [noteCosting(5_144, 3, 'small-a', NOW - 5), noteCosting(5_144, 3, 'small-b', NOW - 5)]
    const kept = [...oldest, ...beside, ...middle, ...fills]
    expect(
      kept.reduce((sum, line) => sum + encoded(line).length + 1, 0),
      'the kept groups no longer fill the bound exactly',
    ).toBe(MAX_EVIDENCE_BYTES_PER_BOOK)

    const outcome = await write(fakeFs(files), [...kept, ...letGo])
    await lanes.queue.idle()

    expect(outcome.refused, 'a group was let go and nothing said so').toEqual({ full: 1 })
    expect(envelopeLines(files).sort(), 'the wrong group was let go, or only part of one').toEqual([...kept].sort())
    const back = await readPublic2(fakeFs(files), 'book:1', crypto(accepted), NOW, never)
    expect(back.file.held, 'a side of an equivocation was drawn as honest').toEqual([])
    /* The kept groups, and the one let go: its BYTES are gone and the fact that
       it equivocated is not — see `MAX_CONFLICTS_PER_BOOK`. */
    expect(back.file.equivocated).toHaveLength(1 + 1 + 22 + 1 + 1)
    expect(back.file.equivocated.map((one) => one.key), 'the group let go was forgotten with its bytes').toContain(
      `${VOICE}#4`,
    )
  })

  it('keeps a withdrawal that equivocates with its sequence as evidence, not as an orphan to trim', async () => {
    /* Room for every orphan exactly, and the equivocating withdrawal the newest
       line of all: weighed as an orphan it is the one let go, and the note it
       equivocated with is then drawn as honest. */
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const orphans = Array.from({ length: MAX_SUPPRESSIONS_PER_BOOK }, (_, i) =>
      unnote({ seq: 10_000 + i, pub: `junk${i}`, at: NOW - 60_000 }),
    )
    const unsaid = unnote({ seq: 7, pub: 'unsaid', at: NOW })
    const outcome = await write(fs, [...orphans, note({ seq: 7, pub: 'said', at: NOW - 1 }), unsaid])
    await lanes.queue.idle()

    expect(outcome.refused, 'a line was let go').toEqual({})
    expect(storedLines(files)).toContain(unsaid)
    const back = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    expect(back.file.held, 'one side of an equivocation was drawn as honest').toEqual([])
    expect(back.file.equivocated.map((one) => one.key)).toEqual([`${VOICE}#7`])
  })

  /* ⚠️ **AND A NOTE'S WITHDRAWALS HAD NO BOUND EITHER, BY THE SAME ROAD.** Every
     withdrawal of a note this device holds was kept, and a voice can sign as
     many as it likes of one of its own notes at fresh sequences — so one
     stranger with one note could fill the store until every write was refused.
     One withdrawal takes a note back as well as any number (2026-09-14). */
  it('keeps one withdrawal of a note, however many take it back', async () => {
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const takeBacks = [2, 3, 4].map((seq) => unnote({ seq, pub: 'p1' }))
    await write(fs, [note(), ...takeBacks])
    await lanes.queue.idle()
    expect(storedLines(files).filter((line) => takeBacks.includes(line)), 'every withdrawal was kept').toHaveLength(1)
    expect((await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)).file.held).toEqual([])
  })

  it('weighs a withdrawal whose note the same write lets go as an orphan', async () => {
    /* ⚠️ **"A NOTE THIS DEVICE HOLDS" MEANT ONE IT HELD BEFORE THE TRIM.** So a
       store with more notes than this build retains — another build's —
       counted a withdrawal of every one of them as untrimmable, and no bound
       held. Here the withdrawn note is the newest of 513, so `keepWithin` lets
       it go; its withdrawal then competes for the orphans' room, which is full,
       and is the newest there too. */
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const older = Array.from({ length: MAX_HELD_PER_BOOK - 1 }, (_, i) =>
      note({ seq: i + 1, pub: `p${i}`, at: NOW - 90_000 + i }),
    )
    const letGo = note({ seq: 900, pub: 'let-go', at: NOW })
    const takeBack = unnote({ seq: 901, pub: 'let-go', at: NOW - 1 })
    const orphans = Array.from({ length: MAX_SUPPRESSIONS_PER_BOOK }, (_, i) =>
      unnote({ seq: 10_000 + i, pub: `junk${i}`, at: NOW - 60_000 }),
    )
    files.set(publicPathIn('book:1'), `${[...older, letGo, takeBack, ...orphans].join('\n')}\n`)

    await write(fs, [note({ seq: 950, pub: 'oldest', at: NOW - 100_000 })])
    await lanes.queue.idle()

    const lines = storedLines(files)
    expect(lines, 'the note the trim let go was written').not.toContain(letGo)
    expect(lines.filter((line) => orphans.includes(line)), 'a withdrawal of a let-go note took an orphan’s room').toHaveLength(
      orphans.length,
    )
    expect(lines).not.toContain(takeBack)
  })

  /* ⚠️ **THE WRITE'S SIZE GUARD COULD NO LONGER BE REACHED, SO IT IS HELD HERE.**
     It refused a write its own reader would refuse, and every class the write
     retains is bounded now — so what it asserted at runtime is arithmetic, and
     arithmetic fails here the moment a bound grows (2026-09-14). The widest a
     withdrawal can be is fixed by its shape: every number at its widest, and a
     publication id of control characters, which JSON spells in six bytes each. */
  it('retains no more than its own reader accepts, whatever the lines hold', () => {
    const NUL = String.fromCharCode(0)
    const widest = (pub: string) => ({
      v: Math.max(...PUBLIC_SUPPORTED),
      voice: VOICE,
      book: BOOK,
      seq: Number.MAX_SAFE_INTEGER,
      at: Number.MAX_SAFE_INTEGER,
      expires: Number.MAX_SAFE_INTEGER,
      pub,
      op: 'unnote',
      sig: SIG,
    })
    let pub = ''
    while (isPublicEnvelopeShape(widest(`${pub}${NUL}`))) pub += NUL
    expect(pub.length, 'no publication id was accepted at all').toBeGreaterThan(0)
    const withdrawal = encoded(canonicalJson(widest(pub))).length + 1

    /* And the record of what equivocated, at ITS widest: a key of the widest
       voice and sequence, and a time. This is what that record costs a book. */
    const record = `["${VOICE}#${Number.MAX_SAFE_INTEGER}",${Number.MAX_SAFE_INTEGER}],`
    const conflicts = encoded(`{"equivocated":[],"v":${Math.max(...PUBLIC_SUPPORTED)}}`).length + 1
    const remembering = conflicts + MAX_CONFLICTS_PER_BOOK * encoded(record).length
    expect(remembering, 'the record of what equivocated costs a book more than a tenth of its store').toBeLessThan(
      MAX_STORED_BYTES_PER_BOOK / 10,
    )

    /* Notes at their bound; a withdrawal per written note and the orphans, which
       share one cap; the evidence at its bound; and that record. */
    expect(MAX_HELD_PER_BOOK, 'a withdrawal per written note has to fit the shared cap').toBeLessThanOrEqual(
      MAX_SUPPRESSIONS_PER_BOOK,
    )
    expect(
      MAX_HELD_BYTES_PER_BOOK + MAX_SUPPRESSIONS_PER_BOOK * withdrawal + MAX_EVIDENCE_BYTES_PER_BOOK + remembering,
      'what a write retains can outgrow what its reader accepts',
    ).toBeLessThan(MAX_STORED_BYTES_PER_BOOK)
  })

  /* ⚠️ **SPREADING TALLIES OVERWROTE MATCHING COUNTS INSTEAD OF ADDING THEM.**
     One malformed line on disk plus one malformed line arriving reported a
     single refusal — the later map replaced the earlier value, so the tally
     under-reported exactly when there was most to report. Reproduced by audit. */
  it('adds refusal counts from the stored file and the arriving batch', async () => {
    const files = new Map<string, string>()
    files.set(publicPathIn('book:1'), '{ not json at all\n')
    const fs = fakeFs(files)
    const outcome = await write(fs, ['{ also not json'])
    await lanes.queue.idle()
    expect(
      outcome.refused.malformed,
      'the stored bad line and the arriving one were counted as one',
    ).toBe(2)
  })

  /* ⚠️ **SUPPRESSION EVIDENCE IS NOT A NOTE, AND ADMISSION COUNTED IT AS ONE.**
     `kept` carries withdrawals and equivocation pairs beside publications, and
     it retains a withdrawal past its own expiry while it still suppresses
     something — all of it evidence, none of it an annotation a reader sees.
     Weighing the lot against the live-note cap meant a book showing NOTHING
     could refuse a new annotation. `held` is the fold's own answer to what a
     reader sees, which is what a capacity bound is about. Found by audit.

     `takePublic` directly, because this is a fact about ADMISSION: the write
     path's trimming is a separate rule with its own tests, and routing through
     it would measure both at once. */
  it('weighs live publications against the note cap, not the whole record', async () => {
    /* A full book, then every one of them taken back. */
    const many = Array.from({ length: MAX_HELD_PER_BOOK }, (_, i) => delivered(note({ seq: i + 1, pub: `p${i}` })))
    const withdrawn = Array.from({ length: MAX_HELD_PER_BOOK }, (_, i) =>
      delivered(unnote({ seq: 5_000 + i, pub: `p${i}` })),
    )
    const filled = await takePublic2(EMPTY_PUBLIC_FILE, [], crypto(accepted), NOW, never, pace)
    const stocked = foldPublic(filled!.file, [...many, ...withdrawn], NOW)
    expect(stocked.held, 'the withdrawals did not take effect').toHaveLength(0)
    expect(stocked.kept.length, 'the evidence is not being retained').toBeGreaterThan(MAX_HELD_PER_BOOK)

    const read = await takePublic2(stocked, [note({ seq: 20_000, pub: 'fresh' })], crypto(accepted), NOW, never, pace)
    expect(
      read?.file.held.map((one) => one.pub),
      'a book showing nothing refused a new annotation, because its suppression record filled the note cap',
    ).toEqual(['fresh'])
  })

  it('measures a book’s retained bytes in UTF-8, so Chinese text cannot overshoot the budget threefold', async () => {
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    /* One UTF-16 unit per character, THREE UTF-8 bytes. Sized just inside the
       envelope's own field limits (2 000 byte quote, 4 000 byte note) so every
       line is VALID — the point is that each is accepted, not malformed. That
       is ~2 000 units and ~6 000 bytes each: 512 of them sit comfortably inside
       the 2 MiB budget when counted wrongly, and half again over it when
       counted right. */
    const quote = '汉'.repeat(Math.floor(2_000 / 3))
    const words = '汉'.repeat(Math.floor(4_000 / 3))
    const many = Array.from({ length: MAX_HELD_PER_BOOK }, (_, i) =>
      note({ seq: i + 1, pub: `p${i}`, passage: { quote, prefix: '', suffix: '', chapter: '', note: words } }),
    )
    await write(fs, many)
    await lanes.queue.idle()
    const back = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)

    const heldBytes = back.file.held.reduce((sum, one) => sum + new TextEncoder().encode(one.received).length, 0)
    /* Under `.length` this was about 340 KiB over the bound, because 512
       envelopes of ~2 000 units each measured well inside a budget those same
       envelopes exceed in bytes. */
    expect(heldBytes, 'retained bytes exceeded the bound they are named for').toBeLessThanOrEqual(
      MAX_HELD_BYTES_PER_BOOK,
    )
    /* And the byte bound is what bit, not the count bound — otherwise this
       would pass for a reason that has nothing to do with the unit. */
    expect(back.file.held.length).toBeLessThan(MAX_HELD_PER_BOOK)
    expect(back.file.held.length).toBeGreaterThan(0)
 }, FLOOD_TIMEOUT_MS)
})

/**
 * ⚠️ **SILENCING A VOICE DELETED THIS DEVICE'S RECORD OF THEM.** `writePublic`
 * is a read-MODIFY-WRITE and it made the read WITH the block, so every line the
 * block hid was a line the rewrite then dropped from disk — on the reader's
 * next "Look for some", silently. Their withdrawals went with their notes, and
 * both sides of any equivocation, which are the two things `PublicFile.kept`
 * exists to persist. `VoiceDecisions` offers "Hear this voice again" as a
 * reversal; it restored a note the author had taken back, and a voice this
 * device had caught equivocating came back looking honest. Found by audit.
 */
describe('silencing a voice', () => {
  const write = (fs: ReturnType<typeof fakeFs>, lines: readonly string[]) =>
    writePublic(fs, lanes, 'book:1', BOOK, lines, crypto(accepted), NOW, never)
  const silenced = (fs: ReturnType<typeof fakeFs>, lines: readonly string[]) =>
    writePublic(fs, lanes, 'book:1', BOOK, lines, crypto(accepted), NOW, (voice: string) => voice === VOICE)
  const heardAgain = (fs: ReturnType<typeof fakeFs>) => readPublic2(fs, 'book:1', crypto(accepted), NOW, never)

  it('keeps what they took back, so hearing them again does not revive it', async () => {
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    await write(fs, [note(), unnote()])
    await lanes.queue.idle()
    expect((await heardAgain(fs)).file.withdrawn).toHaveLength(1)

    /* One ordinary write while they are silenced — which is every "Look for
       some" the reader makes on this book. */
    await silenced(fs, [])
    await lanes.queue.idle()
    /* The note stays beside its withdrawal — `onlySaid` says why: dropping it
       shortens how long the fold keeps the withdrawal. */
    expect(files.get(publicPathIn('book:1')), 'silencing deleted the note a withdrawal still takes back').toContain(
      note(),
    )

    const back = await heardAgain(fs)
    expect(back.file.withdrawn.map((one) => one.key), 'silencing deleted the withdrawal').toEqual([`${VOICE}#p1`])
    await write(fs, [note()])
    await lanes.queue.idle()
    const replayed = await heardAgain(fs)
    expect(replayed.file.held, 'a note the voice had withdrawn came back when they were heard again').toEqual([])
  })

  it('keeps both sides of their equivocation, so hearing them again does not clear it', async () => {
    /* ⚠️ **`order.ts` SAYS WHY IN AS MANY WORDS**: drop one side and the next
       reload sees a single envelope at that sequence, finds no conflict, and
       hands the reader something this device had already decided was
       equivocation. */
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const oneWay = note({ pub: 'p1' })
    const theOther = note({ pub: 'p2' })
    await write(fs, [oneWay, theOther])
    await lanes.queue.idle()
    const caught = await heardAgain(fs)
    expect(caught.file.equivocated.map((one) => one.key)).toEqual([`${VOICE}#1`])
    expect(caught.file.held).toEqual([])

    await silenced(fs, [])
    await lanes.queue.idle()

    const back = await heardAgain(fs)
    expect(back.file.equivocated.map((one) => one.key), 'silencing forgot the equivocation').toEqual([`${VOICE}#1`])
    await write(fs, [oneWay])
    await lanes.queue.idle()
    expect((await heardAgain(fs)).file.held, 'one side of an equivocation revived').toEqual([])
  })

  it('hears them take something back while they are silenced', async () => {
    /* The envelope door's half of the same rule: an `unnote` can only ever
       remove a publication of its own voice, so refusing one because the reader
       silenced its author makes the reader hear MORE of them. */
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    await write(fs, [note()])
    await lanes.queue.idle()
    await silenced(fs, [unnote()])
    await lanes.queue.idle()

    const back = await heardAgain(fs)
    expect(back.file.withdrawn.map((one) => one.key), 'the withdrawal was refused for being theirs').toEqual([
      `${VOICE}#p1`,
    ])
    expect(back.file.held).toEqual([])
  })

  it('does discard what they merely said, so the room comes back', async () => {
    /* NON-VACUOUS IN THE OTHER DIRECTION: the three cases above would all pass
       if the block had simply stopped applying to the stored file. It still
       applies to a live publication — the thing the reader asked not to see,
       and the thing that occupies the book's retained room. What it no longer
       reaches is the evidence. */
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    await write(fs, [note()])
    await lanes.queue.idle()
    expect(files.get(publicPathIn('book:1'))).toBe(`${note()}\n`)

    await silenced(fs, [])
    await lanes.queue.idle()
    expect(files.get(publicPathIn('book:1')), 'a silenced voice went on holding the book’s room').toBe('')
  })

  it('frees the room their live notes took for what arrives, and nobody else’s', async () => {
    /* A full book with ONE of its notes theirs, so it has room for exactly one
       arrival once they are silenced: freeing nobody's room refuses both,
       freeing everybody's refuses neither. */
    const LOUD = 'd'.repeat(64)
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const full = [
      note({ voice: LOUD, seq: 1, pub: 'loud' }),
      ...Array.from({ length: MAX_HELD_PER_BOOK - 1 }, (_, i) => note({ seq: i + 1, pub: `p${i}` })),
    ]
    files.set(publicPathIn('book:1'), `${full.join('\n')}\n`)

    const arriving = [note({ seq: 9_001, pub: 'first' }), note({ seq: 9_002, pub: 'second' })]
    const outcome = await writePublic(fs, lanes, 'book:1', BOOK, arriving, anyVoice, NOW, (voice) => voice === LOUD)
    await lanes.queue.idle()
    expect(outcome.refused, 'the room freed was not the silenced voice’s alone').toEqual({ full: 1 })
  })
})

/**
 * ⚠️ **A STORED LINE THIS BUILD COULD NOT READ WAS DELETED BY THE NEXT WRITE.**
 * `readPublic` drops a line it refuses — right for what is DRAWN — and
 * `writePublic` is a read-modify-write of that read, so the dropped line was
 * gone from disk on the reader's next "Look for some": a stored file holding
 * `broken stored bytes` became an empty one (2026-09-13 verify). Every line a
 * write adds is verified first, so a stored line that no longer reads is damage
 * or another build's, never a stranger's — a stranger's bad line is refused on
 * ARRIVAL and never reaches the disk, which stays true below.
 *
 * Refusing the whole write was the other answer, and it loses something this
 * does not: a withdrawal arriving for that book could never be kept, so a note
 * its author took back would stay on screen. So the line is WRITTEN BACK AS IT
 * WAS, and what arrives still lands.
 */
describe('a stored line this build cannot read', () => {
  const OTHER_BOOK = 'e'.repeat(64)
  const stored = (files: Map<string, string>, text: string) => files.set(publicPathIn('book:1'), text)

  it('is written back verbatim, not deleted, by a write that brings nothing', async () => {
    const files = new Map<string, string>()
    stored(files, 'broken stored bytes\n')
    const outcome = await writePublic(fakeFs(files), lanes, 'book:1', BOOK, [], crypto(accepted), NOW, never)
    await lanes.queue.idle()
    expect(files.get(publicPathIn('book:1'))).toBe('broken stored bytes\n')
    expect(outcome.refused).toEqual({ malformed: 1 })
    expect(outcome.unreadable).toEqual([encoded('broken stored bytes')])
  })

  it.each([
    ['not JSON', () => '{ not json at all', 'malformed'],
    ['another book’s', () => note({ book: OTHER_BOOK, pub: 'elsewhere' }), 'malformed'],
    ['under a signature that does not verify', () => note({ pub: 'forged', seq: 7 }).replace(SIG, 'f'.repeat(128)), 'bad-signature'],
    ['of a version this build does not take', () => note({ v: PUBLIC_VERSION + 1, pub: 'newer', seq: 8 }), 'version'],
  ])('keeps a stored line that is %s beside what it reads, and still takes what arrives', async (_name, make, why) => {
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const odd = make()
    stored(files, `${note()}\n${odd}\n`)

    /* A withdrawal of the stored note arrives: the one arrival that must land. */
    const outcome = await writePublic(fs, lanes, 'book:1', BOOK, [unnote()], crypto(accepted), NOW, never)
    await lanes.queue.idle()

    expect(outcome.refused).toEqual({ [why]: 1 })
    const lines = (files.get(publicPathIn('book:1')) ?? '').split('\n').filter((line) => line !== '')
    expect(lines, 'the line this build could not read was deleted').toContain(odd)
    expect(lines).toContain(unnote())
    const back = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    expect(back.file.held, 'the withdrawal did not land').toEqual([])
    expect(back.refused).toEqual({ [why]: 1 })
    expect(back.unreadable).toEqual([encoded(odd)])
  })

  it('drops a stored line refused for its TIME — expiry is what a book retains, not damage', async () => {
    const files = new Map<string, string>()
    stored(files, `${note()}\n`)
    const later = NOW + DEFAULT_LIFETIME_MS + 1
    const outcome = await writePublic(fakeFs(files), lanes, 'book:1', BOOK, [], crypto(accepted), later, never)
    await lanes.queue.idle()
    expect(outcome.refused).toEqual({ expired: 1 })
    expect(outcome.unreadable).toEqual([])
    expect(files.get(publicPathIn('book:1'))).toBe('')
  })

  it('never keeps a stranger’s bad line that ARRIVES — only the device’s own stored bytes are carried', async () => {
    const files = new Map<string, string>()
    const outcome = await writePublic(fakeFs(files), lanes, 'book:1', BOOK, ['{ junk from a stranger', note({ book: OTHER_BOOK })], crypto(accepted), NOW, never)
    await lanes.queue.idle()
    expect(outcome.refused).toEqual({ malformed: 2 })
    expect(outcome.unreadable).toEqual([])
    expect(files.get(publicPathIn('book:1'))).toBe('')
  })

  /* ⚠️ **"AS IT WAS" MEANT AS A STRING, AND A STRING IS NOT THE BYTES.** The
     read decoded the file with a decoder that replaces what is not UTF-8 and
     eats a leading byte-order mark, and the write encoded what it got: `ff`
     came back as `ef bf bd`, and the mark was gone. Reproduced by the
     2026-09-14 verify. The line is first, so the mark opens the FILE — the only
     place the old whole-file decode removed one. */
  it.each([
    ['bytes that are not UTF-8', Uint8Array.of(0xff, 0xfe)],
    ['opened by a byte-order mark', Uint8Array.of(0xef, 0xbb, 0xbf, ...encoded('broken stored bytes'))],
  ])('writes back the exact bytes of a stored line that is %s, and still takes what arrives', async (_name, odd) => {
    const files = new Map<string, Uint8Array>()
    const fs = bytesFs(files)
    files.set(publicPathIn('book:1'), fileOf([odd, encoded(note())]))

    const outcome = await writePublic(fs, lanes, 'book:1', BOOK, [unnote()], crypto(accepted), NOW, never)
    await lanes.queue.idle()

    expect(outcome.refused).toEqual({ malformed: 1 })
    expect(outcome.unreadable).toEqual([odd])
    const lines = linesIn(files.get(publicPathIn('book:1'))!)
    expect(lines.filter((line) => sameBytes(line, odd)), 'the stored bytes came back altered').toHaveLength(1)
    const back = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    expect(back.file.held, 'the withdrawal did not land').toEqual([])
    expect(back.unreadable).toEqual([odd])
  })
})

/**
 * ⚠️ **THE LINES CARRIED BACK WERE WEIGHED AGAINST THE FILE'S BOUND AS IF THEY
 * WERE WHAT IT HOLDS, SO A FILE THEY FILLED REFUSED A WITHDRAWAL.** The write
 * threw at its size guard, and the author's take-back was lost to bytes this
 * build cannot even read. Reproduced by the 2026-09-14 verify. What this build
 * reads is the store; what it cannot read is carried in the room left over.
 */
describe('unreadable lines at the size limit', () => {
  /** One stored line and its newline: 64 KiB, so the limit is a whole number of them. */
  const LINE = 64 * 1024
  const junk = (size: number, at: number): Uint8Array => new Uint8Array(size).fill(0x61 + (at % 26))

  it('carries every one back when they fill the file exactly to the limit', async () => {
    const count = MAX_STORED_BYTES_PER_BOOK / LINE
    expect(Number.isInteger(count), 'the fixture no longer divides the limit').toBe(true)
    const files = new Map<string, Uint8Array>()
    const stored = fileOf(Array.from({ length: count }, (_, at) => junk(LINE - 1, at)))
    expect(stored.length).toBe(MAX_STORED_BYTES_PER_BOOK)
    files.set(publicPathIn('book:1'), stored)

    const outcome = await writePublic(bytesFs(files), lanes, 'book:1', BOOK, [], crypto(accepted), NOW, never)
    await lanes.queue.idle()

    expect(outcome.refused).toEqual({ malformed: count })
    expect(sameBytes(files.get(publicPathIn('book:1'))!, stored), 'a line was let go from a file that fit').toBe(true)
  })

  it('takes a withdrawal into a file they fill to the limit, letting go only what no longer fits', async () => {
    const files = new Map<string, Uint8Array>()
    const fs = bytesFs(files)
    const held = encoded(note())
    const room = MAX_STORED_BYTES_PER_BOOK - (held.length + 1)
    /* Whole lines, then one BIG line that absorbs the remainder, then one tiny
       line: the withdrawal can only land by letting the big one go, and the
       tiny one behind it still fits — so a store that stopped at the first line
       it could not carry would be caught by the last assertion. */
    const whole = Math.floor((room - 2) / LINE) - 1
    const unreadable = [
      ...Array.from({ length: whole }, (_, at) => junk(LINE - 1, at)),
      junk(room - 2 - whole * LINE - 1, whole),
      Uint8Array.of(0x7a),
    ]
    const stored = fileOf([held, ...unreadable])
    expect(stored.length).toBe(MAX_STORED_BYTES_PER_BOOK)
    files.set(publicPathIn('book:1'), stored)

    const outcome = await writePublic(fs, lanes, 'book:1', BOOK, [unnote()], crypto(accepted), NOW, never)
    await lanes.queue.idle()

    const written = files.get(publicPathIn('book:1'))!
    expect(written.length, 'the store grew past what its own reader will accept').toBeLessThanOrEqual(
      MAX_STORED_BYTES_PER_BOOK,
    )
    const back = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    expect(back.file.held, 'the withdrawal was refused for room the unreadable lines took').toEqual([])
    expect(back.file.withdrawn.map((one) => one.key)).toEqual([`${VOICE}#p1`])
    /* AND WHAT THE WRITE SAYS IT CARRIED IS WHAT IT CARRIED. It returned every
       unreadable line the read had found, the ones it let go included, so its
       answer and the file disagreed by exactly what did not fit — found by the
       2026-09-14 verify. */
    /* Compared by `sameBytes`, not `toEqual`: a deep equality walks the four
       megabytes element by element, which took this test past its limit under
       coverage in `pnpm verify` (2026-09-14). */
    expect(outcome.unreadable.length, 'the write reported lines it did not keep').toBe(back.unreadable.length)
    expect(
      outcome.unreadable.every((line, at) => sameBytes(line, back.unreadable[at]!)),
      'the write reported lines other than the ones it kept',
    ).toBe(true)

    /* What came back is what was stored, byte for byte and in stored order,
       less what had to go. */
    const letGo: Uint8Array[] = []
    let carried = 0
    for (const line of unreadable) {
      const next = back.unreadable[carried]
      if (next !== undefined && sameBytes(next, line)) carried += 1
      else letGo.push(line)
    }
    expect(carried, 'a line came back that was not stored, or out of order').toBe(back.unreadable.length)
    expect(letGo.length, 'nothing had to go, so the limit was never reached').toBeGreaterThan(0)
    expect(outcome.refused.full, 'lines were let go and nothing said so').toBe(letGo.length)
    for (const line of letGo) {
      expect(written.length + line.length + 1, 'a line was let go that would have fit').toBeGreaterThan(
        MAX_STORED_BYTES_PER_BOOK,
      )
    }
  })
})

/**
 * ⚠️ **A RELOAD DROPPED WHAT THE WRITE HAD KEPT, AND THE NEXT WRITE MADE THE LOSS
 * PERMANENT.** `readPublic` weighed the stored file against the note bound as if
 * it were a batch arriving, and it counted what `writePublic` does not count —
 * the withdrawals and both sides of every equivocation, which the write puts
 * FIRST in the file. So they took the room of the notes behind them: a stranger's
 * five hundred withdrawals of publications this book never held made the next
 * reload hold none of its notes, and the write after it erased every one
 * (2026-09-14 mutation sweep, reproduced before the fix). And an equivocation
 * past the bound lost one side, so the other came back as an honest note — the
 * revival `order.ts` exists to prevent.
 */
describe('a reload holds everything the write kept', () => {
  it('loses no note to a flood of withdrawals for publications the book never held', async () => {
    const STRANGER = 'd'.repeat(64)
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const held = Array.from({ length: 3 }, (_, i) => note({ seq: i + 1, pub: `p${i}` }))
    await writePublic(fs, lanes, 'book:1', BOOK, held, anyVoice, NOW, never)
    const junk = Array.from({ length: MAX_HELD_PER_BOOK }, (_, i) =>
      unnote({ voice: STRANGER, seq: i + 1, pub: `junk${i}` }),
    )
    await writePublic(fs, lanes, 'book:1', BOOK, junk, anyVoice, NOW, never)
    await lanes.queue.idle()

    const back = await readPublic(fs, 'book:1', BOOK, anyVoice, NOW, never)
    expect(back.file.held, 'the reload dropped the notes stored behind the withdrawals').toHaveLength(held.length)
    expect(back.refused).toEqual({})
    await writePublic(fs, lanes, 'book:1', BOOK, [], anyVoice, NOW, never)
    await lanes.queue.idle()
    expect(storedLines(files), 'the write after the reload deleted them').toEqual(expect.arrayContaining(held))
  })

  it('keeps both sides of every equivocation it wrote, however many there are', async () => {
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    /* One sequence spelled three ways, so every pair after it sits one line off
       any bound that counts lines. */
    const first = [note({ seq: 1, pub: 't0' }), note({ seq: 1, pub: 't1' }), note({ seq: 1, pub: 't2' })]
    const last = MAX_HELD_PER_BOOK / 2
    for (let seq = 2; seq < last; seq += 1) first.push(note({ seq, pub: `a${seq}` }), note({ seq, pub: `b${seq}` }))
    await writePublic(fs, lanes, 'book:1', BOOK, first, crypto(accepted), NOW, never)
    const lastPair = [note({ seq: last, pub: `a${last}` }), note({ seq: last, pub: `b${last}` })]
    await writePublic(fs, lanes, 'book:1', BOOK, lastPair, crypto(accepted), NOW, never)
    await lanes.queue.idle()

    const back = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    expect(back.file.held, 'one side of an equivocation this device recorded came back as an honest note').toEqual([])
    expect(back.file.equivocated).toHaveLength(last)
  })

  it('bounds what it draws of a store holding more than the book retains, by the book’s own rule, and says so', async () => {
    /* NON-VACUOUS IN THE OTHER DIRECTION: no room is weighed on the way in from
       disk now, so a store this build did not write — more notes than the book
       retains — is bounded where it is DRAWN, by `keepWithin`, oldest first. The
       newest is FIRST in the file, so bounding in file order cannot pass for it.
       What the book RETAINS stays the write's decision: every line is kept. */
    const lines = Array.from({ length: MAX_HELD_PER_BOOK + 1 }, (_, i) =>
      note({ seq: i + 1, pub: `p${i}`, at: NOW - i }),
    )
    const files = new Map([[publicPathIn('book:1'), `${lines.join('\n')}\n`]])
    const read = await readPublic2(fakeFs(files), 'book:1', crypto(accepted), NOW, never)
    expect(read.file.held).toHaveLength(MAX_HELD_PER_BOOK)
    expect(read.file.held.map((one) => one.pub), 'what was drawn was not the book’s oldest').not.toContain('p0')
    expect(read.refused, 'a note left undrawn was not reported').toEqual({ full: 1 })
    expect(read.file.kept, 'the reload decided what the book retains').toHaveLength(lines.length)
  })
})

/**
 * ⚠️ **A WITHDRAWN NOTE WAS DRAWN AGAIN AFTER A RELOAD, AND THE NEXT WRITE MADE
 * IT PERMANENT.** `order.ts` keeps a withdrawal for as long as the note it takes
 * back could still be drawn, and two things beat it on the way in from disk: the
 * envelope reader refused the withdrawal once its OWN expiry passed, and the
 * reload folded the stored lines as if they were arriving, which is the one case
 * the fold will not lengthen a withdrawal's life for. A 180-day note taken back
 * by a two-hour withdrawal was drawn again three hours later, and the write
 * after that reload deleted the withdrawal from disk (2026-09-14, reproduced
 * before the fix).
 */
describe('a withdrawal outlives the note it takes back, across a reload', () => {
  const HOUR = 60 * 60 * 1000

  it('hides the note on every reload and through every write after the withdrawal’s own expiry', async () => {
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const takeBack = unnote({ expires: NOW + 2 * HOUR })
    await writePublic(fs, lanes, 'book:1', BOOK, [note(), takeBack], crypto(accepted), NOW, never)
    await lanes.queue.idle()

    const later = NOW + 3 * HOUR
    const back = await readPublic2(fs, 'book:1', crypto(accepted), later, never)
    expect(back.file.held, 'the note came back when its withdrawal expired').toEqual([])
    expect(back.refused, 'a withdrawal still taking a note back was counted as expired').toEqual({})
    await writePublic(fs, lanes, 'book:1', BOOK, [], crypto(accepted), later, never)
    await lanes.queue.idle()
    expect(storedLines(files), 'the write after the reload deleted the withdrawal').toContain(takeBack)
    expect((await readPublic2(fs, 'book:1', crypto(accepted), later + HOUR, never)).file.held).toEqual([])
  })

  it('forgets both, and counts both expired, once the note has expired too', async () => {
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    await writePublic(fs, lanes, 'book:1', BOOK, [note(), unnote({ expires: NOW + 2 * HOUR })], crypto(accepted), NOW, never)
    await lanes.queue.idle()

    const gone = NOW + DEFAULT_LIFETIME_MS
    const back = await readPublic2(fs, 'book:1', crypto(accepted), gone, never)
    expect(back.file.kept).toEqual([])
    expect(back.refused, 'the withdrawal the fold forgot was not reported').toEqual({ expired: 2 })
    await writePublic(fs, lanes, 'book:1', BOOK, [], crypto(accepted), gone, never)
    await lanes.queue.idle()
    expect(files.get(publicPathIn('book:1'))).toBe('')
  })

  /* The door's half, which is a change for what ARRIVES: a withdrawal past its
     own expiry used to be refused whatever it took back. Now the fold decides,
     so one whose note this device still holds is taken, and one that takes back
     nothing is still let go and still counted — as it was. */
  it('takes a withdrawal arriving after its own expiry while its note is held, and still refuses one that takes nothing back', async () => {
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    await writePublic(fs, lanes, 'book:1', BOOK, [note()], crypto(accepted), NOW, never)
    await lanes.queue.idle()

    const late = unnote({ expires: NOW + HOUR })
    const stray = unnote({ seq: 3, pub: 'never-held', expires: NOW + HOUR })
    const later = NOW + 2 * HOUR
    const outcome = await writePublic(fs, lanes, 'book:1', BOOK, [late, stray], crypto(accepted), later, never)
    await lanes.queue.idle()

    expect(outcome.refused).toEqual({ expired: 1 })
    expect(outcome.file.held, 'a late withdrawal of a held note was refused').toEqual([])
    const lines = storedLines(files)
    expect(lines).toContain(late)
    expect(lines).not.toContain(stray)
  })
})

/**
 * Four defects an independent review reproduced against this store, each with
 * the fixture that found it — 2026-09-14.
 */
describe('what a review found', () => {
  it('carries back a stored line of exactly the bound that ended without a newline', async () => {
    /* ⚠️ **THE SEPARATOR AFTER THE LAST LINE EMPTIED A FULL STORE.** A file of
       exactly the bound with no final newline holds one line this build cannot
       read; weighed with a newline it no longer fitted, so the write let it go
       and the store became nothing — the loss the carry exists to prevent. A
       newline BETWEEN lines is a separator; the one at the end is a terminator,
       and the reader does not need it. */
    const files = new Map<string, Uint8Array>()
    const fs = bytesFs(files)
    const stored = new Uint8Array(MAX_STORED_BYTES_PER_BOOK).fill(0x78)
    files.set(publicPathIn('book:1'), stored.slice())

    const outcome = await writePublic(fs, lanes, 'book:1', BOOK, [], crypto(accepted), NOW, never)
    await lanes.queue.idle()

    expect(outcome.refused).toEqual({ malformed: 1 })
    expect(outcome.unreadable, 'the write said it let the bytes go').toHaveLength(1)
    const after = files.get(publicPathIn('book:1'))!
    expect(after.length, 'the store was emptied by a newline it does not need').toBe(MAX_STORED_BYTES_PER_BOOK)
    expect(sameBytes(after, stored), 'the bytes came back altered').toBe(true)
    const back = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    expect(back.unreadable, 'what came back no longer reads as the line it was').toHaveLength(1)
  })

  it('ends the file with a newline whenever there is room for one', async () => {
    /* One byte under the bound, so the terminator is the last byte that fits —
       the boundary between writing one and leaving it off. */
    const files = new Map<string, Uint8Array>()
    const fs = bytesFs(files)
    files.set(publicPathIn('book:1'), new Uint8Array(MAX_STORED_BYTES_PER_BOOK - 1).fill(0x78))
    await writePublic(fs, lanes, 'book:1', BOOK, [], crypto(accepted), NOW, never)
    await lanes.queue.idle()
    const after = files.get(publicPathIn('book:1'))!
    expect(after.length).toBe(MAX_STORED_BYTES_PER_BOOK)
    expect(after[after.length - 1], 'the file did not end in a newline it had room for').toBe(0x0a)
  })

  it('keeps the withdrawal with the longest horizon, not the first one it sees', async () => {
    /* ⚠️ **ONE WITHDRAWAL PER NOTE TOOK THE FIRST, WHICH FORGETS SOONEST.** The
       one kept decides how long the publication stays suppressed once the note
       it took back has expired, so keeping a shorter horizon over a longer one
       lets a fresh note under that id be drawn while the discarded withdrawal
       was still in force. */
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const short = unnote({ seq: 2, pub: 'p1', expires: NOW + 200 })
    const long = unnote({ seq: 3, pub: 'p1', expires: NOW + 1_000 })
    /* A third, shorter again and LAST in the stored order, so keeping whichever
       came last is as wrong as keeping whichever came first. */
    const shorter = unnote({ seq: 4, pub: 'p1', expires: NOW + 150 })
    await writePublic(
      fs,
      lanes,
      'book:1',
      BOOK,
      [note({ expires: NOW + 100 }), short, long, shorter],
      crypto(accepted),
      NOW,
      never,
    )
    await lanes.queue.idle()

    const lines = envelopeLines(files)
    expect(lines, 'the withdrawal that forgets soonest was the one kept').toContain(long)
    expect(lines).not.toContain(short)
    expect(lines).not.toContain(shorter)

    /* Past the note's expiry and the shorter withdrawal's, inside the longer one. */
    const later = NOW + 300
    const again = note({ seq: 4, pub: 'p1', at: NOW + 250, expires: NOW + 2_000 })
    const outcome = await writePublic(fs, lanes, 'book:1', BOOK, [again], crypto(accepted), later, never)
    await lanes.queue.idle()
    expect(outcome.file.held, 'a publication its voice had taken back was drawn again').toEqual([])
    expect((await readPublic2(fs, 'book:1', crypto(accepted), later, never)).file.held).toEqual([])
  })

  it('writes the note it admitted into a book whose publications were all taken back', async () => {
    /* ⚠️ **ADMISSION WEIGHED WHAT IS DRAWN AND THE WRITE WEIGHED WHAT IS KEPT.**
       A book of withdrawn publications shows nothing, so a new note was taken
       and reported held — and then `keepWithin` weighed it beside every
       withdrawn note and let the newest go, which was the new one. The write
       said held, the disk said nothing, and no refusal named it. */
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const held = Array.from({ length: MAX_HELD_PER_BOOK }, (_, i) =>
      note({ seq: i + 1, pub: `p${i}`, at: NOW - 90_000 }),
    )
    const takenBack = held.map((_, i) => unnote({ seq: 5_000 + i, pub: `p${i}`, at: NOW - 90_000 }))
    files.set(publicPathIn('book:1'), `${[...held, ...takenBack].join('\n')}\n`)

    const fresh = note({ voice: 'd'.repeat(64), seq: 1, pub: 'fresh', at: NOW })
    const outcome = await writePublic(fs, lanes, 'book:1', BOOK, [fresh], anyVoice, NOW, never)
    await lanes.queue.idle()

    expect(outcome.file.held.map((one) => one.pub), 'the write did not take it at all').toEqual(['fresh'])
    expect(envelopeLines(files), 'it was reported held and never written').toContain(fresh)
    const back = await readPublic(fs, 'book:1', BOOK, anyVoice, NOW, never)
    expect(back.file.held.map((one) => one.pub), 'a reload of the store showed nothing of it').toEqual(['fresh'])
    /* And the notes it keeps are still bounded: the drawn one, and what is
       withdrawn in the room left. */
    expect(
      envelopeLines(files).filter((line) => line.includes('"op":"note"')),
      'the notes kept outgrew the bound they share',
    ).toHaveLength(MAX_HELD_PER_BOOK)
    expect(outcome.refused.full, 'a withdrawn note was let go and nothing said so').toBe(1)
  })

  it('gives a withdrawn note only the room in bytes the drawn ones leave', async () => {
    /* The count bound has room to spare here, so only the bytes decide: one
       drawn note of its own and the withdrawn ones filling the rest. */
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const big = {
      quote: 'x'.repeat(2_000),
      prefix: 'x'.repeat(2_000),
      suffix: 'x'.repeat(2_000),
      chapter: 'x'.repeat(500),
      note: 'x'.repeat(4_000),
    }
    const cost = encoded(note({ seq: 100, pub: 'p100', passage: big })).length + 1
    const count = Math.ceil(MAX_HELD_BYTES_PER_BOOK / cost)
    expect(count, 'the byte bound has to bite before the count bound').toBeLessThan(MAX_HELD_PER_BOOK)
    const gone = Array.from({ length: count }, (_, i) =>
      note({ seq: 100 + i, pub: `p${100 + i}`, at: NOW - 90_000, passage: big }),
    )
    const takenBack = gone.map((_, i) => unnote({ seq: 5_000 + i, pub: `p${100 + i}`, at: NOW - 90_000 }))
    files.set(publicPathIn('book:1'), `${[...gone, ...takenBack].join('\n')}\n`)

    const fresh = note({ seq: 9_000, pub: 'fresh', at: NOW, passage: big })
    const outcome = await writePublic(fs, lanes, 'book:1', BOOK, [fresh], crypto(accepted), NOW, never)
    await lanes.queue.idle()

    const notes = envelopeLines(files).filter((line) => line.includes('"op":"note"'))
    expect(notes, 'the drawn note was not written').toContain(fresh)
    expect(
      notes.reduce((sum, line) => sum + encoded(line).length + 1, 0),
      'the notes kept outgrew the bytes they share',
    ).toBeLessThanOrEqual(MAX_HELD_BYTES_PER_BOOK)
    expect(notes.length, 'the withdrawn notes took no room at all, or more than was left').toBe(
      Math.floor(MAX_HELD_BYTES_PER_BOOK / cost),
    )
    expect(outcome.refused.full).toBe(1)
  })

  it('keeps the withdrawn note that lends the longest horizon', async () => {
    /* A withdrawn note is kept for the horizon it lends its withdrawal, so the
       one to keep is the one that lends the most. */
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    /* The one that lends the most is in the MIDDLE of the stored order, so
       keeping whichever came first and keeping whichever came last are both
       wrong. */
    const brief = note({ seq: 1, pub: 'p1', expires: NOW + 100 })
    const lasting = note({ seq: 2, pub: 'p1', expires: NOW + 5_000 })
    const briefer = note({ seq: 3, pub: 'p1', expires: NOW + 150 })
    const takeBack = unnote({ seq: 4, pub: 'p1', expires: NOW + 200 })
    await writePublic(fs, lanes, 'book:1', BOOK, [lasting, brief, briefer, takeBack], crypto(accepted), NOW, never)
    await lanes.queue.idle()
    expect(envelopeLines(files), 'the note that lends the shorter horizon was kept').toContain(lasting)

    const later = NOW + 300
    const again = note({ seq: 5, pub: 'p1', at: NOW + 250, expires: NOW + 6_000 })
    await writePublic(fs, lanes, 'book:1', BOOK, [again], crypto(accepted), later, never)
    await lanes.queue.idle()
    expect(
      (await readPublic2(fs, 'book:1', crypto(accepted), later, never)).file.held,
      'a publication its voice had taken back was drawn again',
    ).toEqual([])
  })

  it('keeps, of two that tie, the one first in the fold’s order, so every device writes the same bytes', async () => {
    /* Equal horizons, so which survives changes nothing drawn — only the bytes
       written, which two devices holding the same lines have to agree on. They
       arrive in the opposite order, so arrival cannot be what decides. */
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const firstNote = note({ seq: 1, pub: 'p1', expires: NOW + 5_000 })
    const secondNote = note({ seq: 2, pub: 'p1', expires: NOW + 5_000 })
    const firstTakeBack = unnote({ seq: 3, pub: 'p1', expires: NOW + 9_000 })
    const secondTakeBack = unnote({ seq: 4, pub: 'p1', expires: NOW + 9_000 })
    await writePublic(
      fs,
      lanes,
      'book:1',
      BOOK,
      [secondTakeBack, secondNote, firstTakeBack, firstNote],
      crypto(accepted),
      NOW,
      never,
    )
    await lanes.queue.idle()
    const lines = envelopeLines(files)
    expect(lines, 'a tie between notes was broken by something other than the fold’s order').toContain(firstNote)
    expect(lines).not.toContain(secondNote)
    expect(lines, 'a tie between withdrawals was broken by something other than the fold’s order').toContain(
      firstTakeBack,
    )
    expect(lines).not.toContain(secondTakeBack)
  })

  it('refuses a replay of a sequence it saw equivocated, once the evidence itself has been let go', async () => {
    /* ⚠️ **EVICTING THE EVIDENCE FORGAVE THE LIE.** Both spellings go together,
       which is right — one side alone reads as honest — but with them went the
       device's only record that the sequence had two, so replaying either
       spelling afterwards was drawn as an honest note. The FACT is kept now,
       which costs a key and a time rather than two envelopes. */
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    /* Big enough that the room the flood leaves cannot hold it: the trim keeps
       a later, smaller sequence where one fits, which is `keepWithin`'s rule. */
    const said = noteCosting(10_000, 1, 'said', NOW)
    const unsaid = noteCosting(10_000, 1, 'unsaid', NOW)
    await writePublic(fs, lanes, 'book:1', BOOK, [said, unsaid], crypto(accepted), NOW, never)
    await lanes.queue.idle()
    expect(conflictLine(files), 'the store keeps no record of what equivocated').not.toBeNull()

    /* Older equivocations, which the bound keeps over the newer pair. */
    const flood = Array.from({ length: 30 }, (_, i) => [
      noteCosting(10_000, 10 + i, `x${i}`, NOW - 60_000),
      noteCosting(10_000, 10 + i, `y${i}`, NOW - 60_000),
    ]).flat()
    const outcome = await writePublic(fs, lanes, 'book:1', BOOK, flood, crypto(accepted), NOW, never)
    await lanes.queue.idle()
    expect(outcome.refused.full ?? 0, 'the flood did not fill the evidence bound').toBeGreaterThan(0)
    expect(envelopeLines(files), 'the pair was not let go, so this measures nothing').not.toContain(said)

    await writePublic(fs, lanes, 'book:1', BOOK, [said], crypto(accepted), NOW, never)
    await lanes.queue.idle()
    const back = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)
    expect(back.file.held, 'a replayed side of an equivocation was drawn as honest').toEqual([])
    expect(back.file.equivocated.map((one) => one.key)).toContain(`${VOICE}#1`)
  })

  it('bounds what it remembers of past equivocations, keeping the ones with longest to run', async () => {
    /* A store another run left, holding more records than this build keeps:
       the cap decides which survive, and a record of a version this build does
       not read is bytes it cannot read — carried, never used. */
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const record = (until: number, i: number): [string, number] => [`${'e'.repeat(63)}${i % 10}#${i}`, until]
    const rows = Array.from({ length: MAX_CONFLICTS_PER_BOOK + 76 }, (_, i) => record(NOW + 1_000 + i, i))
    /* Rows that are not rows, beside rows that are: dropped alone, and each
       chosen so that keeping it would SHOW — a key that is not a key and a time
       that is not one survive the fold's own pruning and reach the file. */
    const stored = JSON.stringify({
      equivocated: [
        ...rows,
        ['only-a-key'],
        42,
        [123, NOW + 5_000],
        ['floaty#1', NOW + 5_000.5],
        /* An object that indexes like a row: not a row. */
        { 0: 'object#1', 1: NOW + 5_000 },
      ],
      v: 1,
    })
    const laterBuild = JSON.stringify({ equivocated: [record(NOW + 90_000, 9_999)], v: 2 })
    files.set(publicPathIn('book:1'), `${stored}\n${laterBuild}\n${note()}\n`)

    const outcome = await writePublic(fs, lanes, 'book:1', BOOK, [], crypto(accepted), NOW, never)
    await lanes.queue.idle()

    const kept = JSON.parse(conflictLine(files)!) as { equivocated: [string, number][] }
    expect(kept.equivocated, 'the record this book keeps is unbounded').toHaveLength(MAX_CONFLICTS_PER_BOOK)
    const untils = kept.equivocated.map(([, until]) => until)
    expect(Math.min(...untils), 'the records kept were the ones nearest their end').toBe(
      NOW + 1_000 + rows.length - MAX_CONFLICTS_PER_BOOK,
    )
    const keys = kept.equivocated.map(([key]) => key)
    for (const bad of ['only-a-key', 123, 'floaty#1', 'object#1']) {
      expect(keys, `a row that is not one was read as a record: ${String(bad)}`).not.toContain(bad)
    }
    expect(outcome.refused.full, 'records were let go and nothing said so').toBe(1)
    expect(outcome.unreadable, 'a record of a version this build cannot read was not carried').toEqual([
      encoded(laterBuild),
    ])
    expect(storedLines(files), 'a record this build cannot read was deleted').toContain(laterBuild)
  })

  /* The door verifies a withdrawal past its own expiry now, so a stored one
     whose signature does not verify earns `bad-signature` where it earned
     `expired` before. That is the answer this store wants, and this pins it: a
     line refused for WHAT IT IS is damage this device wrote and is carried back
     verbatim, while one refused for its TIME is this build's own rule about
     what a book retains, and goes. */
  it('carries a stored withdrawal whose signature does not verify, expired or not', async () => {
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const forged = unnote({ seq: 9, pub: 'p9', expires: NOW + 1_000 }).replace(SIG, 'f'.repeat(128))
    files.set(publicPathIn('book:1'), `${note()}\n${forged}\n`)

    const later = NOW + 2_000
    const outcome = await writePublic(fs, lanes, 'book:1', BOOK, [], crypto(accepted), later, never)
    await lanes.queue.idle()

    expect(outcome.refused).toEqual({ 'bad-signature': 1 })
    expect(outcome.unreadable).toEqual([encoded(forged)])
    expect(envelopeLines(files), 'damaged bytes this device wrote were deleted').toContain(forged)
  })
})

describe('the book an envelope names', () => {
  it('is refused when it is not the book whose file this is', async () => {
    /* ⚠️ **MEASURED BY AUDIT: VALID ENVELOPES FOR ANOTHER BOOK WERE ACCEPTED
       FROM THIS BOOK'S FILE AND PASSED TO ITS RESOLVER.** A quotation shared
       between two books would place an authentic statement in the wrong one.
       The signature says who wrote it; it does not say which file it is in. */
    const elsewhere = note({ book: 'f'.repeat(64) })
    const taken = await takePublic2(EMPTY_PUBLIC_FILE, [elsewhere], crypto(accepted), NOW, never, pace)
    expect(taken?.file.held).toEqual([])
    expect(taken?.refused.malformed).toBe(1)
    /* Reported, as the bytes of the line that arrived — and kept by nothing. */
    expect(taken?.unreadable).toEqual([encoded(elsewhere)])
  })

  it('is refused on load as well as on arrival', async () => {
    const files = new Map([[publicPathIn('book:1'), `${note({ book: 'f'.repeat(64) })}\n`]])
    const read = await readPublic2(fakeFs(files), 'book:1', crypto(accepted), NOW, never)
    expect(read.file.held).toEqual([])
  })
})

describe('the stored file is bounded before it is read', () => {
  it('refuses a file larger than this build will read', async () => {
    /* ⚠️ **MEASURED BY AUDIT: 600 VALID NOTES WERE ALL VERIFIED AND RETAINED
       DESPITE THE 512 CAP.** The bound has to bite before the work, which
       means before the parse and before the allocation. */
    const files = new Map([[publicPathIn('book:1'), 'x'.repeat(MAX_STORED_BYTES_PER_BOOK + 1)]])
    await expect(readPublic2(fakeFs(files), 'book:1', crypto(accepted), NOW, never)).rejects.toThrow(/larger than/u)
  })
})

describe('a cancelled load stops', () => {
  it('before the first slice, not only between slices', async () => {
    /* ⚠️ **MEASURED BY AUDIT: AN ALREADY-CANCELLED BATCH OF 32 OR FEWER LINES
       WAS FULLY VERIFIED AND RETURNED AS SUCCESSFUL.** */
    const taken = await takePublic2(EMPTY_PUBLIC_FILE, [note()], crypto(accepted), NOW, never, {
      breathe: () => Promise.resolve(),
      live: () => false,
    })
    expect(taken).toBeNull()
  })

  it('and after the last slice', async () => {
    let calls = 0
    const lines = Array.from({ length: 40 }, (_, i) => note({ seq: i + 1, pub: `p${i}` }))
    const taken = await takePublic2(EMPTY_PUBLIC_FILE, lines, crypto(accepted), NOW, never, {
      breathe: () => Promise.resolve(),
      /* Alive for the entry check and the first slice, gone by the end. */
      live: () => {
        calls += 1
        return calls < 3
      },
    })
    expect(taken).toBeNull()
  })
})
