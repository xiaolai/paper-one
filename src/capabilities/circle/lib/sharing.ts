import {
  shareAbsentBecause,
  type Annotation,
  type Hlc,
  type Passage,
  type Publishability,
} from '../../../kernel'
import { share, unshare, type Publication, type SharedFile } from './publish'
import { tellEach } from './listeners'

/**
 * The share control's deciding half — WI-23.A1.
 *
 * A reader marks a passage as shared, or takes it back, from the mark's own
 * row. What that means on disk is `publish.ts`'s business (a snapshot row in
 * `shared.json`, a tombstone on withdrawal); what it means to the reader is
 * decided here, over injected ports, so every path below is reachable from a
 * test with no peer, no keychain and no filesystem.
 *
 * ## The note is a separate choice, per share
 *
 * ⚠️ `wire.md` §"The publisher's store": *"sharing the passage and sharing what
 * you thought about it are different acts."* `passageOf` carries the note only
 * when asked, and the control's default is without — so a reader who shares a
 * highlight and later writes a private note has not had the note published by
 * that earlier decision.
 *
 * ## The store holds a COPY, and this is where the copy is taken
 *
 * `passageOf` reads the mark's text at the moment of sharing and never keeps
 * the mark. Edit the note afterwards, delete the mark, restart: the row in
 * `shared.json` still says what was published, which is what lets a page a
 * friend already holds be reproduced byte for byte.
 */

/** What the mark's row asks the capability. */
export interface ShareState {
  readonly publishability: Publishability
  /** Whether THIS mark is out right now — a live publication names it. */
  readonly published: boolean
}

/** What the share control needs, with no React and no peer types in it. */
export interface SharePort {
  state(mark: Annotation): Promise<ShareState>
  /**
   * Publish the passage, and the note only if asked.
   *
   * Idempotent over a mark that is already out: a second Share while the
   * first is live is a duplicate publication nobody asked for, and the control
   * does not offer it — but a port must not depend on a control's manners.
   */
  share(mark: Annotation, withNote: boolean): Promise<void>
  /** Withdraw the live publication of this mark. A no-op when there is none. */
  unshare(mark: Annotation): Promise<void>
  /** Told after every share or withdrawal, so a row re-asks `state`. */
  subscribe(listener: () => void): () => void
}

/**
 * The passage a mark publishes — the copy the store keeps.
 *
 * The note travels only when `withNote`, and an EMPTY note never travels: a
 * `note: ''` on the wire would tell every recipient the reader wrote nothing,
 * which is a fact about the reader and not about the passage.
 */
export function passageOf(
  mark: Pick<Annotation, 'text' | 'prefix' | 'suffix' | 'chapter' | 'note'>,
  withNote: boolean,
): Passage {
  const note = mark.note.trim()
  return {
    quote: mark.text,
    prefix: mark.prefix,
    suffix: mark.suffix,
    chapter: mark.chapter,
    ...(withNote && note !== '' ? { note: mark.note } : {}),
  }
}

/**
 * The publication of a mark that is still out, or null.
 *
 * The LAST live row, because a mark can be published, withdrawn and published
 * again — three rows, one of them live — and `unshare` names a `pub`, so the
 * control has to know which.
 */
export function livePublication(held: SharedFile, markId: string): Publication | null {
  let live: Publication | null = null
  for (const row of held.publications) {
    if (row.markId === markId && row.unshared === undefined) live = row
  }
  return live
}

/**
 * EVERY publication of a mark that is still out. Two of the reader's devices
 * can each have published the same mark before their stores met; a withdrawal
 * that named only the last row left the other one out, on the wire, in the
 * reader's name.
 */
export function livePublications(held: SharedFile, markId: string): readonly Publication[] {
  return held.publications.filter((row) => row.markId === markId && row.unshared === undefined)
}

/**
 * A publication id — 128 random bits as 32 lower-case hex characters.
 *
 * ⚠️ **MINTED PER SHARE, NEVER PER MARK.** `share(P), share(P), unshare(P)`
 * has to be three unambiguous entries, and the withdrawal names exactly one
 * of the two publications by this id. Random rather than derived from the
 * mark so two devices sharing one mark cannot mint one id.
 */
export function mintPub(random: (bytes: Uint8Array) => Uint8Array = fill): string {
  return Array.from(random(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The platform's randomness — `crypto.getRandomValues`, in every runtime this reaches. */
function fill(bytes: Uint8Array): Uint8Array {
  return globalThis.crypto.getRandomValues(bytes)
}

/**
 * Whether this device can publish at all, as the control's state.
 *
 * On the desktop the publication is LOCAL — `shared.json` is written here and
 * served from here — so the only two things that can be missing are the peer
 * (the plugin that signs a page) and the identity a page is signed under.
 * `surfaces.md`'s other states describe a satchel reaching a shelf and do not
 * arise on the shelf itself.
 */
export function publishabilityOf(peer: boolean, identity: boolean): Publishability {
  if (!peer) return 'unreachable'
  return identity ? 'usable' : 'no-identity'
}

/** What a share port reads and writes. Every one of these is a seam. */
export interface SharingDeps {
  /** This reader's publications for a book — `readShared`. */
  readonly shared: (bookId: string) => Promise<SharedFile>
  /**
   * Change them as ONE step on the book's lane — `updateShared`. Read and
   * write in one turn, so a share and a republish racing on one file cannot
   * lose each other; the transform answering the same object writes nothing.
   */
  readonly update: (bookId: string, transform: (held: SharedFile) => SharedFile) => Promise<SharedFile>
  /** Whether the peer that signs pages has started. */
  readonly reachable: () => boolean
  /** This device's id when it has a person identity, else null. */
  readonly device: () => Promise<string | null>
  /** THE clock — `KernelServices.clock`, never one of the capability's own. */
  readonly clock: () => Hlc
  readonly mintPub: () => string
}

export function sharePortOver(deps: SharingDeps): SharePort {
  const listeners = new Set<() => void>()
  const changed = (): void => tellEach(listeners, 'share')
  /* Reachability is sampled ONCE per check: read twice around an await, a
     peer stopping in between made the identity of a reachable peer and the
     reachability of an absent one — a state that is neither. */
  const publishability = async (): Promise<Publishability> => {
    const reachable = deps.reachable()
    // Stryker disable next-line BooleanLiteral: `publishabilityOf` answers 'unreachable' before it reads the identity.
    const identified = reachable ? (await deps.device()) !== null : false
    return publishabilityOf(reachable, identified)
  }
  /* Asked only when the peer is there: `mine()` on a peer that has not
     started is a call into nothing. */
  const deviceOrNull = (): Promise<string | null> => (deps.reachable() ? deps.device() : Promise.resolve(null))

  return {
    state: async (mark) => ({
      publishability: await publishability(),
      published: livePublication(await deps.shared(mark.bookId), mark.id) !== null,
    }),
    share: async (mark, withNote) => {
      /* ONE SAMPLE DECIDES. The state is read once and refused by its own
         reason; a peer that stops between that read and the identity read
         is refused as unreachable, which it now is — never as "usable". */
      const state = await publishability()
      if (state !== 'usable') throw new Error(shareAbsentBecause(state) ?? state)
      const device = await deviceOrNull()
      // Stryker disable next-line StringLiteral: `shareAbsentBecause` names every state; the fallback is for the type.
      if (device === null) throw new Error(shareAbsentBecause('unreachable') ?? 'unreachable')
      const pub = deps.mintPub()
      const at = deps.clock()
      const passage = passageOf(mark, withNote)
      await deps.update(mark.bookId, (held) =>
        livePublication(held, mark.id) !== null ? held : share(held, { markId: mark.id, passage, device }, pub, at).held,
      )
      changed()
    },
    unshare: async (mark) => {
      const at = deps.clock()
      await deps.update(mark.bookId, (held) => {
        /* Every one of them — see `livePublications`. */
        let next = held
        for (const live of livePublications(held, mark.id)) next = unshare(next, live.pub, at)
        return next
      })
      changed()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

