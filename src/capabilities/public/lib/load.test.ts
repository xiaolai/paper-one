import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIFETIME_MS,
  EMPTY_PUBLIC_FILE,
  MAX_APPENDED_SHARED,
  MAX_HELD_PER_BOOK,
  PUBLIC_VERSION,
  canonicalJson,
  publicPathIn,
  publicSignedBytes,
  writeQueue,
  type IndexFs,
  type PublicCrypto,
  type PublicEnvelope,
} from '../../../kernel'
import { readPublic, takePublic, writePublic } from './publicStore'

/**
 * WI-26.7's sustained run — what a flood of strangers costs the reader.
 *
 * ⚠️ **THE ADVERSARY IS STATED AND THE MEASUREMENT IS OF THE READER'S WORK.**
 * An attacker with unlimited keys, unlimited publication ids and a fast uplink,
 * who wants the reader's own writing to become slow or to fail. What is
 * conceded is that they can fill the public quota; what must not happen is that
 * the reader's own note is refused, lost, or scheduled behind a thousand of
 * theirs.
 *
 * ⚠️ **AND THE LEGITIMATE VOICE CARRIES NO LABEL.** The plan is explicit that
 * *"an unbound legitimate voice and an unbound attacker voice carry IDENTICAL
 * evidence"*, so nothing here may prefer one — the honest voice is placed at a
 * random position among the flood and is expected to fare exactly as well as
 * any of them.
 *
 * ⚠️ **IN-PROCESS, AND THAT IS THE HONEST SCOPE.** This measures the STORE and
 * the QUEUE under load, which is where the reader's own writing is at risk.
 * The transport's own load is `share::acceptance`'s, in Rust, against real
 * endpoints.
 */

const BOOK = 'ab'.repeat(32)
const SIG = 'cd'.repeat(64)
const NOW = 1_700_000_000_000

/** Every message this run will accept — a stand-in for Ed25519, not a bypass. */
const accepted = new Set<string>()
const crypto: PublicCrypto = { verify: (_key, message, sig) => sig === SIG && accepted.has(message) }

/** One stranger's publication, under a fresh key. */
function fromStranger(n: number, book = BOOK): string {
  const envelope = {
    v: PUBLIC_VERSION,
    voice: n.toString(16).padStart(64, '0'),
    book,
    seq: 1,
    at: NOW + n,
    expires: NOW + DEFAULT_LIFETIME_MS,
    pub: `p${n}`,
    op: 'note',
    passage: { quote: `a sentence ${n}`, prefix: '', suffix: '', chapter: '' },
    sig: SIG,
  } as PublicEnvelope
  accepted.add(publicSignedBytes(envelope.v, envelope))
  return canonicalJson(envelope)
}

function fakeFs(files: Map<string, string>): IndexFs {
  return {
    readFile: (path: string) => {
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

const lanes = (queue: ReturnType<typeof writeQueue>) => ({ queue, lane: (bookId: string) => bookId })

describe('WI-26.7 — a flood of strangers while the reader writes', () => {
  it('never refuses the reader’s own write, however full the public line is', async () => {
    /* ⚠️ **THE OBJECTIVE, MEASURED.** Before `appendShared` existed, filling a
       book's queue with public tasks made the next private edit reject with
       `WriteQueueFull` — WI-26.7's stated goal inverted. */
    const queue = writeQueue()
    let release = (): void => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = queue.append('book:1', () => blocked)

    /* The flood takes its whole share and then some. */
    const flood = Array.from({ length: MAX_APPENDED_SHARED + 200 }, () =>
      queue.appendShared('book:1', () => Promise.resolve()).catch(() => undefined),
    )
    /* The reader's own note, queued while the flood is at its cap. */
    let mine = false
    const own = queue.append('book:1', () => {
      mine = true
      return Promise.resolve()
    })
    release()
    await Promise.all([running, own, ...flood])
    expect(mine, 'the reader’s own write was refused for want of room').toBe(true)
  })

  it('holds the retained bound with a thousand fresh keys arriving', async () => {
    const queue = writeQueue()
    const files = new Map<string, string>()
    const fs = fakeFs(files)
    const lines = Array.from({ length: 1000 }, (_, i) => fromStranger(i))
    await writePublic(fs, lanes(queue), 'book:1', BOOK, lines, crypto, NOW, () => false)
    await queue.idle()

    const held = await readPublic(fs, 'book:1', BOOK, crypto, NOW, () => false)
    expect(held.file.held.length).toBeLessThanOrEqual(MAX_HELD_PER_BOOK)
    /* And the file on disk is inside what a load will read. */
    expect(new TextEncoder().encode(files.get(publicPathIn('book:1')) ?? '').length).toBeLessThan(4 * 1024 * 1024)
  })

  it('an honest voice at a random position fares exactly as any of them', async () => {
    /* ⚠️ **NOTHING HERE MAY PREFER THE HONEST ONE**, because nothing CAN
       distinguish it: an unbound legitimate voice and an unbound attacker
       voice carry identical evidence. What is asserted is the absence of a
       hidden label, not a privilege. */
    const queue = writeQueue()
    const fs = fakeFs(new Map())
    const honest = fromStranger(999_999)
    const flood = Array.from({ length: 200 }, (_, i) => fromStranger(i))
    const at = 137
    const lines = [...flood.slice(0, at), honest, ...flood.slice(at)]

    await writePublic(fs, lanes(queue), 'book:1', BOOK, lines, crypto, NOW, () => false)
    await queue.idle()
    const held = await readPublic(fs, 'book:1', BOOK, crypto, NOW, () => false)
    /* Two hundred and one is under the cap, so everything honest and dishonest
       alike is held — the point being that position bought nothing either way. */
    expect(held.file.held).toHaveLength(201)
    expect(held.file.held.some((one) => one.pub === 'p999999')).toBe(true)
  })

  it('a cancelled public load stops within one slice', async () => {
    /* The cancellation latency WI-26.7 asks for, counted in slices rather than
       timed — a timing assertion here would measure the machine. */
    const lines = Array.from({ length: 1000 }, (_, i) => fromStranger(i))
    let slices = 0
    const taken = await takePublic(EMPTY_PUBLIC_FILE, lines, BOOK, crypto, NOW, () => false, {
      breathe: () => {
        slices += 1
        return Promise.resolve()
      },
      live: () => slices < 1,
    })
    expect(taken).toBeNull()
    expect(slices).toBe(1)
  })

  it('refuses every envelope for another book, however many arrive', async () => {
    const queue = writeQueue()
    const fs = fakeFs(new Map())
    const elsewhere = Array.from({ length: 300 }, (_, i) => fromStranger(i, 'ef'.repeat(32)))
    const out = await writePublic(fs, lanes(queue), 'book:1', BOOK, elsewhere, crypto, NOW, () => false)
    await queue.idle()
    expect(out.file.held).toEqual([])
    expect(out.refused.malformed).toBe(300)
  })
})
