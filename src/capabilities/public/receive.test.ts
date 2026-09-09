import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LIFETIME_MS,
  PUBLIC_VERSION,
  canonicalJson,
  publicPathIn,
  publicSignedBytes,
  writeQueue,
  type CapabilityContext,
  type IndexedBook,
  type PublicEnvelope,
} from '../../kernel'
import { fakeFs } from '../../kernel/testkit'

/**
 * Phase 26's RECEIVING half, end to end through the capability.
 *
 * ⚠️ **THIS PATH DID NOT EXIST AND NOTHING NOTICED FOR A WHOLE PHASE.** The
 * overlay reads `public.jsonl`; `writePublic` is the only thing that fills it;
 * and no code in the app called `writePublic` at all. The plugin has answered
 * `paper/share-notes/1` since the phase landed and no device ever asked, so an
 * ordinary reader never saw a stranger's annotation. Found by audit — and what
 * makes it worth a test of its own is that every OTHER test in this capability
 * passed while the feature was unreachable, because each one supplied the
 * stored file itself.
 */

const BOOK = 'ab'.repeat(32)
const VOICE = 'ef'.repeat(32)
/* The capability stamps its reads with the REAL clock, so the fixtures are
   dated against the real clock too — a fixed epoch here is simply expired. */
const NOW = Date.now()

const warnings: [string, unknown][] = []
const { accepted, SIG_HOISTED } = vi.hoisted(() => ({ accepted: new Set<string>(), SIG_HOISTED: 'cd'.repeat(64) }))

/** One publication, signed by a stand-in for Ed25519 that is not a bypass. */
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
    sig: SIG_HOISTED,
    ...over,
  } as PublicEnvelope
  accepted.add(publicSignedBytes(envelope.v, envelope))
  return canonicalJson(envelope)
}

/* The share port the capability reaches for, replaced whole. What is under
   test is that the capability ASKS it and keeps what verifies. */
const provider = vi.hoisted(() => ({
  records: [] as string[],
  asked: [] as { hash: string; since: number | undefined }[],
  resolved: [] as string[],
}))
/* The signature check, replaced whole: this test is about the PATH, and real
   Ed25519 over fixture envelopes would only be a slower way to assert the same
   thing. `crypto.test.ts` is where the verification itself is measured. */
vi.mock('./lib/crypto', () => ({
  publicCrypto: {
    verify: (_key: string, message: string, sig: string) => sig === SIG_HOISTED && accepted.has(message),
  },
}))
vi.mock('../peer', () => ({
  sharePort: () => ({
    offered: () => Promise.resolve([]),
    offerBytes: () => Promise.resolve(),
    offerNotes: () => Promise.resolve(),
    withdraw: () => Promise.resolve(),
    publishNote: () => Promise.resolve(1),
    resolve: () => Promise.resolve(provider.resolved),
    fetch: () => Promise.resolve(0),
    fetchNotes: (hash: string, _providers?: readonly string[], since?: number) => {
      provider.asked.push({ hash, since })
      return Promise.resolve({
        records: provider.records.slice(since ?? 0),
        next: provider.records.length,
        generation: 1,
        more: false,
      })
    },
  }),
  voicePort: () => null,
}))

const { publicSharing } = await import('./index')

const book = (over: Partial<IndexedBook> = {}): IndexedBook =>
  ({ bookId: 'book:1', title: 'A', author: 'B', contentHash: BOOK, hasContent: true, ext: 'epub', ...over }) as IndexedBook

/** The context the capability starts against — a real queue and a real fs. */
function contextWith(): { ctx: CapabilityContext; fs: ReturnType<typeof fakeFs> } {
  const queue = writeQueue()
  const fs = fakeFs()
  const ctx = {
    services: {
      fs,
      writes: queue,
      library: {
        getSnapshot: () => [book()],
        subscribe: () => () => {},
        lane: (bookId: string) => bookId,
      },
      sharedPrivately: () => Promise.resolve([]),
    },
    diagnostics: { info: () => {}, warn: (event: string, fields: unknown) => warnings.push([event, fields]) },
  } as unknown as CapabilityContext
  return { ctx, fs }
}

/** What the store holds at a path, as text. */
const storedAt = (fs: ReturnType<typeof fakeFs>, path: string): string | undefined => {
  const bytes = fs.store.get(path)
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes)
}

/** The pane's props, as the capability composes them. */
function paneProps(): Record<string, unknown> {
  const pane = publicSharing.panes?.[0]
  if (pane === undefined) throw new Error('the capability draws no pane')
  const element = pane.render({ bookId: 'book:1' } as never) as { props: Record<string, unknown> }
  return element.props
}

describe('the receiving half', () => {
  it('asks a provider, keeps what verifies, and tells the overlay', async () => {
    const { ctx, fs } = contextWith()
    const started = (await publicSharing.start!(ctx, new AbortController().signal)) as { dispose: () => void }
    try {
      provider.records = [note(), note({ pub: 'p2', seq: 2, passage: { quote: 'another', prefix: '', suffix: '', chapter: '' } })]
      provider.asked = []
      let told = 0
      const contribution = publicSharing.overlays?.[0]
      const off = contribution!.subscribe(() => {
        told += 1
      })

      const look = paneProps()['lookForNotes'] as (bookId: string) => Promise<number>
      const arrived = await look('book:1')

      expect(arrived, 'the capability did not ask, or the answer was dropped').toBe(2)
      expect(provider.asked.map((one) => one.hash)).toEqual([BOOK])
      /* ⚠️ **THE STORE IS THE POINT.** The overlay reads this file and nothing
         else; a path that fetched and did not write would report success and
         draw nothing. */
      const stored = storedAt(fs, publicPathIn('book:1'))
      expect(stored, 'nothing reached the store the overlay reads').toBeDefined()
      expect(stored!.split('\n').filter((one) => one !== '')).toHaveLength(2)
      expect(told, 'the overlay was not told to re-ask').toBeGreaterThan(0)
      off()
    } finally {
      started.dispose()
    }
  })

  it('keeps nothing a provider made up', async () => {
    /* ⚠️ **THE PROVIDER IS NOT TRUSTED FOR ANYTHING.** `writePublic` is the
       door: signature, book, expiry, block list, bounds. A provider that
       sends junk spends refusals and changes the store not at all. */
    const { ctx, fs } = contextWith()
    const started = (await publicSharing.start!(ctx, new AbortController().signal)) as { dispose: () => void }
    try {
      provider.records = [
        'not json at all',
        /* Correctly shaped, correctly signed — for a DIFFERENT book. */
        note({ book: 'ff'.repeat(32), pub: 'elsewhere' }),
      ]
      const look = paneProps()['lookForNotes'] as (bookId: string) => Promise<number>
      const arrived = await look('book:1')
      expect(arrived, 'what arrived is counted, whatever became of it').toBe(2)
      const stored = storedAt(fs, publicPathIn('book:1'))
      expect(stored === undefined || stored.trim() === '', 'a provider wrote into the store').toBe(true)
    } finally {
      started.dispose()
    }
  })
})
