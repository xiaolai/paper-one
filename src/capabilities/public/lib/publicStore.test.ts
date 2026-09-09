import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIFETIME_MS,
  EMPTY_PUBLIC_FILE,
  MAX_HELD_BYTES_PER_BOOK,
  foldPublic,
  MAX_HELD_PER_BOOK,
  PUBLIC_VERSION,
  canonicalJson,
  publicPathIn,
  publicSignedBytes,
  type IndexFs,
  type PublicCrypto,
  type PublicEnvelope,
  type WriteQueue,
  writeQueue,
} from '../../../kernel'
import { MAX_STORED_BYTES_PER_BOOK, readPublic, takePublic, writePublic } from './publicStore'

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

/** One canonical line as the fold takes it. */
const delivered = (line: string) => ({ envelope: JSON.parse(line) as PublicEnvelope, received: line })

const pace = { breathe: () => Promise.resolve(), live: () => true }
const lanes = { queue: writeQueue() as WriteQueue, lane: (bookId: string) => bookId }

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
    await write(fs, [note({ seq: 8000, pub: 'crowd' }), unnote({ seq: 9999, pub: target })])
    await lanes.queue.idle()
    const after = await readPublic2(fs, 'book:1', crypto(accepted), NOW, never)

    expect(after.file.held.some((one) => one.pub === target), 'the withdrawal behind a refused note was lost').toBe(
      false,
    )
    expect(after.file.withdrawn.map((one) => one.key)).toContain(`${VOICE}#${target}`)
    /* And the refusal is REPORTED rather than silent: a capacity drop used to
       produce no reason at all, so the one refusal a reader might need
       explained was the only one with no diagnostic. */
    expect(after.refused.full ?? 0).toBeGreaterThan(0)
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
