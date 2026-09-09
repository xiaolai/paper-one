import { describe, expect, it } from 'vitest'
import {
  PUBLIC_DISCLOSURE,
  PUBLIC_LINKS_DISCLOSURE,
  isPublicEnvelopeShape,
  publicSignedBytes,
  type IndexedBook,
  type Library,
  type PublicEnvelope,
  type PublicPassage,
} from '../../../kernel'
import type { SharePort, ShareService, SharedBook, VoicePort, VoiceStatus } from '../../peer'
import { publishPortOver } from './publishPort'

const HASH = 'a'.repeat(64)
/* ⚠️ **HEX, BECAUSE A VOICE IS 64 LOWER-CASE HEX AND THE MINT CHECKS.** The
   first spelling of this fixture used `'v'` and `'w'`, and every publish test
   failed with "that is not a publishable envelope" — which is the shape check
   at the mint doing exactly its job, one layer earlier than a verifier would
   have. */
const VOICE = 'be'.repeat(32)
const OLD_VOICE = 'ce'.repeat(32)
const NOW = 1_700_000_000_000
const passage: PublicPassage = { quote: 'a sentence', prefix: 'before ', suffix: ' after', chapter: 'One' }

const book = (over: Record<string, unknown> = {}): IndexedBook =>
  ({ bookId: 'book:1', title: 'A', author: 'B', hasContent: true, ext: 'epub', contentHash: HASH, ...over }) as IndexedBook

const libraryOf = (books: readonly IndexedBook[]): Library =>
  ({ getSnapshot: () => books, subscribe: () => () => {} }) as unknown as Library

/** A voice that records what it was asked to sign, and under which key. */
function fakeVoice() {
  const signed: { message: string; voice: string | undefined }[] = []
  let seq = 0
  const port: VoicePort & { readonly signed: typeof signed; retired: string[] } = {
    signed,
    retired: [OLD_VOICE],
    status: () =>
      Promise.resolve({ voice: VOICE, seq, retired: port.retired.map((v) => ({ voice: v, until: NOW })) } as VoiceStatus),
    nextSeq: () => {
      seq += 1
      return Promise.resolve(seq)
    },
    sign: (message: string, voice?: string) => {
      if (!/^paper\.public\.\d+\.envelope\n/u.test(message)) {
        return Promise.reject(new Error('a voice signs public envelopes and nothing else'))
      }
      if (voice !== undefined && voice !== VOICE && !port.retired.includes(voice)) {
        return Promise.reject(new Error("this device no longer holds that voice's key"))
      }
      signed.push({ message, voice })
      return Promise.resolve('c'.repeat(128))
    },
    rotate: () => Promise.resolve({ voice: VOICE, seq, retired: [] }),
    sweep: () => Promise.resolve(0),
  }
  return port
}

/** A share port that records the lines it was told to publish. */
function fakeShare() {
  const published: { hash: string; record: string }[] = []
  const port: SharePort & { readonly published: typeof published } = {
    published,
    offered: () => Promise.resolve([] as SharedBook[]),
    offerBytes: () => Promise.resolve(),
    offerNotes: () => Promise.resolve(),
    withdraw: (_h: string, _s: ShareService) => Promise.resolve(),
    publishNote: (hash: string, record: string) => {
      published.push({ hash, record })
      return Promise.resolve(published.length)
    },
    resolve: () => Promise.resolve([]),
    fetch: () => Promise.resolve(1),
  }
  return port
}

const portWith = (voice = fakeVoice(), share = fakeShare(), books = [book()]) => ({
  voice,
  share,
  port: publishPortOver(libraryOf(books), () => voice, () => share, () => NOW, () => {}),
})

describe('the disclosure', () => {
  it('is shown before a public act and not before a circle one', () => {
    const { port } = portWith()
    expect(port.disclosure('circle', passage, [])).toBeNull()
    expect(port.disclosure('public', passage, [])).toBe(PUBLIC_DISCLOSURE)
  })

  it('names the linkage when the circle already has these exact words', () => {
    const { port } = portWith()
    expect(port.disclosure('public', passage, [passage])).toContain(PUBLIC_LINKS_DISCLOSURE)
  })
})

describe('publish', () => {
  it('refuses without an acknowledged disclosure, at the boundary', () => {
    /* ⚠️ **A SURFACE THAT SHOWED THE SENTENCE IS A SURFACE; THIS IS THE
       BOUNDARY.** The two disagree exactly when a caller forgets. */
    const { port, share } = portWith()
    return Promise.all([
      expect(port.publish({ bookId: 'book:1', passage, acknowledged: false })).rejects.toThrow(/disclosure/u),
      Promise.resolve(expect(share.published).toEqual([])),
    ])
  })

  it('publishes a line its own verifier accepts', async () => {
    const { port, share, voice } = portWith()
    const out = await port.publish({ bookId: 'book:1', passage, acknowledged: true })
    expect(share.published).toHaveLength(1)
    const line = share.published[0]!.record
    const parsed: unknown = JSON.parse(line)
    expect(isPublicEnvelopeShape(parsed)).toBe(true)
    const envelope = parsed as PublicEnvelope
    expect(envelope).toMatchObject({ op: 'note', voice: VOICE, book: HASH, pub: out.pub, seq: 1 })
    /* The signer was handed exactly what a verifier will recompute. */
    expect(voice.signed[0]?.message).toBe(publicSignedBytes(envelope.v, envelope))
    expect(share.published[0]?.hash).toBe(HASH)
  })

  it('takes the sequence from the plugin, which persists it before answering', async () => {
    /* ⚠️ **A REUSED SEQUENCE IS AN EQUIVOCATION BY THE FOLD'S OWN RULE AND
       DROPS BOTH ENVELOPES.** Deriving one from what is already published
       would reuse numbers whose envelopes have expired. */
    const { port, share } = portWith()
    await port.publish({ bookId: 'book:1', passage, acknowledged: true })
    await port.publish({ bookId: 'book:1', passage, acknowledged: true })
    const seqs = share.published.map((one) => (JSON.parse(one.record) as PublicEnvelope).seq)
    expect(seqs).toEqual([1, 2])
  })

  it('mints a fresh publication id each time, so one passage twice is two publications', async () => {
    const { port } = portWith()
    const first = await port.publish({ bookId: 'book:1', passage, acknowledged: true })
    const second = await port.publish({ bookId: 'book:1', passage, acknowledged: true })
    expect(first.pub).not.toBe(second.pub)
  })

  it('refuses a book with no digest, because there is no name to publish under', async () => {
    const { port } = portWith(fakeVoice(), fakeShare(), [book({ contentHash: undefined })])
    await expect(port.publish({ bookId: 'book:1', passage, acknowledged: true })).rejects.toThrow(/fingerprint/u)
  })

  it('refuses a book this library does not have', async () => {
    const { port } = portWith()
    await expect(port.publish({ bookId: 'book:missing', passage, acknowledged: true })).rejects.toThrow(/not in this library/u)
  })

  it('refuses where there is no plugin to hold a voice', async () => {
    const port = publishPortOver(libraryOf([book()]), () => null, () => null, () => NOW, () => {})
    await expect(port.publish({ bookId: 'book:1', passage, acknowledged: true })).rejects.toThrow(/not available/u)
    expect(await port.voice()).toBeNull()
  })
})

describe('withdraw', () => {
  it('signs with the voice that published it, not the current one', async () => {
    /* ⚠️ **WI-26.3's WHOLE REASON FOR RETAINING AN OLD KEY.** Asking the
       CURRENT voice to withdraw the previous one's work produces an envelope
       every recipient refuses, because the signature is not the
       publication's. */
    const { port, voice, share } = portWith()
    await port.withdraw('book:1', { pub: 'p9', voice: OLD_VOICE, seq: 4 })
    expect(voice.signed[0]?.voice).toBe(OLD_VOICE)
    const envelope = JSON.parse(share.published[0]!.record) as PublicEnvelope
    expect(envelope).toMatchObject({ op: 'unnote', voice: OLD_VOICE, pub: 'p9' })
  })

  it('carries no passage', async () => {
    const { port, share } = portWith()
    await port.withdraw('book:1', { pub: 'p9', voice: VOICE, seq: 4 })
    expect(share.published[0]!.record).not.toContain('passage')
  })

  it('takes its own sequence, not the publication’s', async () => {
    /* They come from different places, and swapping them is a withdrawal that
       withdraws nothing and an equivocation at once. */
    const { port, share } = portWith()
    await port.withdraw('book:1', { pub: 'p9', voice: VOICE, seq: 4 })
    expect((JSON.parse(share.published[0]!.record) as PublicEnvelope).seq).toBe(1)
  })

  it('fails when this device no longer holds the publishing key', async () => {
    const voice = fakeVoice()
    voice.retired = []
    const { port } = portWith(voice)
    await expect(port.withdraw('book:1', { pub: 'p9', voice: OLD_VOICE, seq: 4 })).rejects.toThrow(/no longer holds/u)
  })
})

describe('nothing here mirrors a circle act', () => {
  it('has no method that takes two audiences', () => {
    /* ⚠️ **WI-26.4, AS A PROPERTY OF THE SURFACE RATHER THAN A HABIT.** The
       same passage sent to both audiences links the pseudonym to the person
       for anybody in both, so there is nowhere to ask for both at once. */
    const { port } = portWith()
    expect(Object.keys(port).sort()).toEqual(['disclosure', 'publish', 'voice', 'withdraw'])
    expect(port.publish.length).toBe(1)
  })
})
