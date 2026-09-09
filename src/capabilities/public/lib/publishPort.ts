import {
  disclosureFor,
  isContentHash,
  linksVoiceToPerson,
  mayPublish,
  mintNote,
  mintPublicationId,
  mintUnnote,
  sealPublic,
  type Audience,
  type IndexedBook,
  type Library,
  type PublicPassage,
} from '../../../kernel'
import type { SharePort, VoicePort } from '../../peer'

/**
 * Saying something publicly — phase 26's writing side.
 *
 * ⚠️ **THIS EXISTS BECAUSE NOTHING MINTED AN ENVELOPE.** The format, the key,
 * the ordering, the store and the painter were all built and tested, and no
 * path in the reader's window produced a single publication. A protocol
 * nothing speaks is a specification.
 *
 * ## Four things happen, in this order, and the order is the design
 *
 *  1. **The disclosure is answered for.** `mayPublish` refuses an
 *     unacknowledged public act — per act, never per session, because a flag
 *     that survives the first publication makes every later one silent.
 *  2. **The sequence is taken from the plugin**, which persists it BEFORE
 *     answering. A reused sequence is an equivocation by the public fold's own
 *     rule and drops both envelopes.
 *  3. **The envelope is minted and signed by the VOICE key**, which Rust
 *     confines to `paper.public.<v>.envelope` bytes. The endpoint key cannot
 *     sign one even by mistake.
 *  4. **The line is stored by the share endpoint**, which serves it to
 *     strangers under its own switch.
 *
 * ⚠️ **AND NOTHING HERE MIRRORS A CIRCLE ACT.** WI-26.4: the same passage sent
 * to both audiences links the pseudonym to the person for anybody in both, so
 * each audience is reached by its own explicit call. There is no method that
 * takes two audiences.
 */

/** What a reader is about to publish, and what they were told about it. */
export interface PublishAct {
  readonly bookId: string
  readonly passage: PublicPassage
  /**
   * Whether the reader saw and accepted the disclosure for THIS act.
   *
   * ⚠️ **PER ACT.** See `publish.ts` — a session-wide flag is the forwarding
   * switch WI-26.4 forbids, wearing a checkbox.
   */
  readonly acknowledged: boolean
}

/** What a publication became. */
export interface Published {
  /** The publication id, which a withdrawal names. */
  readonly pub: string
  /** The voice it was published under. */
  readonly voice: string
  /** This voice's sequence for it. */
  readonly seq: number
}

export interface PublishPublicPort {
  /**
   * The sentence to show before a public act, given what the circle holds.
   *
   * `sharedWithCircle` is the passages this reader has already sent their
   * circle for this book; an empty list is the ordinary case and the honest
   * default for a build with no circle composed.
   */
  disclosure(audience: Audience, passage: PublicPassage, sharedWithCircle: readonly PublicPassage[]): string | null
  /** Publish one passage publicly. Refuses without an acknowledged disclosure. */
  publish(act: PublishAct): Promise<Published>
  /** Take one back. Signed by the voice that published it, current or retired. */
  withdraw(bookId: string, published: Published): Promise<void>
  /** This device's voice, or `null` where there is no plugin to hold one. */
  voice(): Promise<string | null>
}

export function publishPortOver(
  library: Library,
  voice: () => VoicePort | null,
  share: () => SharePort | null,
  now: () => number,
  changed: () => void,
): PublishPublicPort {
  const bookOf = (bookId: string): IndexedBook | undefined =>
    library.getSnapshot().find((book) => book.bookId === bookId)

  /** The book's network name, or the reason there is none. */
  const nameOf = (bookId: string): string => {
    const book = bookOf(bookId)
    if (book === undefined) throw new Error('that book is not in this library')
    const hash = book.contentHash
    if (!isContentHash(hash)) throw new Error('Paper has not finished reading this file’s fingerprint yet.')
    return hash
  }

  const ports = (): { readonly voice: VoicePort; readonly share: SharePort } => {
    const held = { voice: voice(), share: share() }
    if (held.voice === null || held.share === null) {
      throw new Error('publishing is not available on this device')
    }
    return { voice: held.voice, share: held.share }
  }

  return {
    disclosure: (audience, passage, sharedWithCircle) =>
      disclosureFor(audience, linksVoiceToPerson(passage, sharedWithCircle)),

    async publish(act) {
      /* ⚠️ **THE GATE IS HERE, NOT ONLY WHERE THE BUTTON IS DRAWN.** A surface
         that showed the sentence is a surface; this is the boundary, and the
         two disagree exactly when a caller forgets. */
      const refusal = mayPublish({ audience: 'public', passage: act.passage, acknowledged: act.acknowledged })
      if (refusal !== null) {
        throw new Error('This has not been published: the disclosure was not shown.')
      }
      const book = nameOf(act.bookId)
      const { voice: mine, share: out } = ports()
      const who = await mine.status()
      /* ⚠️ **THE SEQUENCE COMES FROM THE PLUGIN, WHICH PERSISTS IT BEFORE
         ANSWERING.** Deriving one from what is already published would reuse
         numbers whose envelopes have expired and been dropped. */
      const seq = await mine.nextSeq()
      const pub = mintPublicationId()
      const unsigned = mintNote({ voice: who.voice, book, seq, at: now(), pub }, act.passage)
      /* ⚠️ **THE VOICE IS NAMED, NOT LEFT TO WHATEVER IS CURRENT.** Omitting it
         signs with the key that is current AT SIGNING TIME, and `who.voice` was
         read before the envelope was built — a rotation in between produced a
         signature by one key over an envelope naming another, which every
         recipient refuses while this device reports a successful publication.
         `withdraw` below already binds the two for the same reason; this is the
         same rule on the path that mints. Found by audit. */
      const sig = await mine.sign(unsigned.signedBytes, who.voice)
      await out.publishNote(book, sealPublic(unsigned, sig))
      changed()
      return { pub, voice: who.voice, seq }
    },

    async withdraw(bookId, published) {
      const book = nameOf(bookId)
      const { voice: mine, share: out } = ports()
      const seq = await mine.nextSeq()
      const unsigned = mintUnnote({ voice: published.voice, book, seq, at: now(), pub: published.pub })
      /* ⚠️ **SIGNED BY THE VOICE THAT PUBLISHED IT, WHICH MAY BE A RETIRED
         ONE.** WI-26.3's whole reason for retaining an old key is that a
         withdrawal is an envelope that key has to sign; asking the CURRENT
         voice to withdraw the previous one's work produces an envelope every
         recipient refuses, because the signature is not the publication's. */
      const sig = await mine.sign(unsigned.signedBytes, published.voice)
      await out.publishNote(book, sealPublic(unsigned, sig))
      changed()
    },

    async voice() {
      const held = voice()
      return held === null ? null : (await held.status()).voice
    },
  }
}
