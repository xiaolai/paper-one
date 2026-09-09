import { createElement } from 'react'
import {
  isContentHash,
  messageOf,
  notifyAll,
  standingOf,
  type Capability,
  type CapabilityContext,
  type Disposable,
  type ForeignAnnotation,
  type IndexFs,
  type Library,
  type OverlayRequest,
  type PublicPassage,
} from '../../kernel'
import { sharePort, voicePort } from '../peer'
import { publicAnnotationsFor } from './lib/overlay'
import { publicPortOver, type PublicPort } from './lib/publicPort'
import { publishPortOver, type PublishPublicPort } from './lib/publishPort'
import { voiceDecisionsPortOver, type VoiceDecisionsPort } from './lib/voicePort'
import { readPublic } from './lib/publicStore'
import { publicCrypto } from './lib/crypto'
import { PublicPane } from './ui/PublicPane'
import { PublishControl } from './ui/PublishControl'

/**
 * The `public` capability — what this reader publishes to strangers.
 *
 * Phase 25. The Rust half is the share endpoint in `tauri-plugin-peer`
 * (`src/share/`): a second keypair on a second port, content-addressed, with
 * two independent services — the book's bytes and public annotations about it.
 * This half is the composition: the kernel's pure rules (`publicShare.ts`), the
 * library snapshot, the peer plugin's share commands, and one pane.
 *
 * ## Why it is not part of `circle`
 *
 * ⚠️ **PUBLIC AND CIRCLE HAVE OPPOSITE DEFAULTS, AND A CAPABILITY THAT HELD
 * BOTH WOULD BE A PLACE FOR THE WRONG ONE TO BE INVISIBLE.** The circle denies
 * unless a person is admitted; this layer answers anybody who holds a hash and
 * offers nothing unless a reader turned it on. They share no key, no port, no
 * ALPN, no storage and no authorization — and phase 26 states that as the rule
 * the whole design rests on. A shared capability would have been the first
 * place it blurred.
 *
 * ## Why `requires: ['peer']` and not `['circle']`
 *
 * The share endpoint is the peer plugin's, so this needs `peer` started before
 * it — the same ordering `sync` and `webhost` declare. It needs nothing from
 * `circle` at all, and a build composed without a circle still publishes.
 */

interface Running {
  readonly port: PublicPort
  /** Minting, signing and publishing — phase 26's writing side. */
  readonly publishing: PublishPublicPort
  /** The reader's decisions about voices, or `null` without a filesystem. */
  readonly voices: VoiceDecisionsPort | null
  readonly library: Library
  readonly fs: IndexFs | null
  readonly warn: (event: string, fields: Record<string, unknown>) => void
  /** What the reader has already shared privately — the kernel's port, which
      the circle binds when it is composed and which answers empty when it is
      not. See `bindPrivateAudience`. */
  readonly sharedPrivately: (bookId: string) => Promise<readonly PublicPassage[]>
  /** Told when what is held changed, so the painter re-asks. */
  readonly listeners: Set<() => void>
}

/**
 * What a book's public annotations amount to, drawn.
 *
 * ⚠️ **ONE BOOK'S UNREADABLE FILE MUST NOT COST THE READER THE PAGE.**
 * `readPublic` throws rather than collapsing absent and unreadable — which is
 * right, and would take the whole overlay down if this let it propagate. The
 * same posture the circle's `entriesFor` takes, and `enrichOne` before it.
 */
async function annotationsFor(held: Running, request: OverlayRequest): Promise<readonly ForeignAnnotation[]> {
  /* Narrowed rather than asserted: the two are set together in `start`, and a
     `!` here would be the compiler being told to trust that rather than shown
     it. */
  const { fs, voices } = held
  if (fs === null || voices === null) return []
  try {
    /* ⚠️ **THE BOOK'S OWN HASH IS REQUIRED, AND THE OVERLAY IS WHERE IT COMES
       FROM.** An envelope names the book it is about; without comparing that
       against THIS book, a valid annotation for another one is drawn here —
       authentic, signed and in the wrong place. `null` when the library has no
       digest for the book yet, in which case there is nothing to compare and
       nothing is drawn. */
    const book = held.library.getSnapshot().find((one) => one.bookId === request.bookId)
    if (book === undefined || !isContentHash(book.contentHash)) return []
    const decisions = await voices.decisions()
    /* ⚠️ **A BLOCKED VOICE IS REFUSED BEFORE ITS SIGNATURE IS CHECKED.**
       `checkPublicEnvelope` orders `blocked` ahead of `bad-signature` for
       exactly this: verification is the expensive step, and a reader who has
       stopped hearing somebody should not go on paying for their Ed25519. */
    const read = await readPublic(fs, request.bookId, book.contentHash, publicCrypto, Date.now(), (voice) =>
      standingOf(voice, decisions) === 'blocked',
    )
    for (const [why, count] of Object.entries(read.refused)) {
      held.warn('public.refused', { bookId: request.bookId, why, count })
    }
    /* ⚠️ **THE READER'S OWN DECISIONS DECIDE WHAT IS DRAWN AND WHAT IS
       COUNTED.** A blocked voice is not anchored at all — anchoring walks
       every section, so filtering after it would let a blocked voice keep
       spending the reader's main thread — and a bound voice folds into the
       person it belongs to rather than counting as one more key. */
    return await publicAnnotationsFor(read.file, decisions, request)
  } catch (cause) {
    held.warn('public.read-failed', { bookId: request.bookId, message: messageOf(cause) })
    return []
  }
}

/**
 * The voices one book's file actually carried — WI-26.5's surface needs a list
 * before a reader can decide about one.
 *
 * ⚠️ **THE BLOCK FILTER IS OFF HERE, AND IT IS THE ONLY PLACE IT IS.** Every
 * other reader of this file refuses a silenced voice before verifying it,
 * because that is the cheap and correct order for drawing. A reader taking a
 * silence back needs the opposite: the envelope has to be readable for its
 * voice to be listed at all. This runs when the pane opens, not on a paint.
 *
 * ⚠️ **AND IT IS NOT THE WHOLE LIST.** Blocking is enforced before storage, so
 * a voice silenced long ago leaves nothing in the file to find. The surface
 * unions this with the device's own silenced set; neither half alone is
 * complete, and only this half is per book.
 */
async function voicesHeardOn(held: Running, bookId: string): Promise<readonly string[]> {
  const { fs, voices } = held
  if (fs === null || voices === null) return []
  const book = held.library.getSnapshot().find((one) => one.bookId === bookId)
  if (book === undefined || !isContentHash(book.contentHash)) return []
  const read = await readPublic(fs, bookId, book.contentHash, publicCrypto, Date.now(), () => false)
  /* ⚠️ **`kept`, NOT `held`.** `held` is the LIVE notes, so a voice whose only
     publication was withdrawn — or lost to an equivocation — would be absent
     from the list, and a reader who wants to silence somebody for withdrawing
     under them could not. `kept` is every accepted envelope, and it carries
     the voice already: no re-parse, and no second way to read a field. */
  return [...new Set(read.file.kept.map((one) => one.voice))]
}

let running: Running | null = null

/** The port, for a surface. `null` before `start`. */
export function publicPort(): PublicPort | null {
  return running?.port ?? null
}

/** Minting and publishing, for a surface. `null` before `start`. */
export function publishPublicPort(): PublishPublicPort | null {
  return running?.publishing ?? null
}

/** The reader's decisions about voices. `null` before `start`, and without an fs. */
export function voiceDecisionsPort(): VoiceDecisionsPort | null {
  return running?.voices ?? null
}

/**
 * ⚠️ **DECLARED ONCE, AT MODULE LEVEL, AND THAT IS LOAD-BEARING.** The pane
 * lists the voices in an effect keyed on this function, so a fresh closure per
 * render would re-read and re-verify the book's whole public file on every
 * paint — the one cost `voicesHeardOn` is written to charge only on opening.
 * An arrow built inside `render` looks identical and is that bug.
 */
const heardOn = (bookId: string): Promise<readonly string[]> =>
  running === null ? Promise.resolve([]) : voicesHeardOn(running, bookId)

/**
 * What this reader has already shared privately about one book, as a thunk the
 * disclosure step calls.
 *
 * ⚠️ **MEMOISED PER BOOK, AND THAT IS LOAD-BEARING.** `PublishControl` keys an
 * effect on this function, so a fresh closure per render would re-read the
 * circle's file on every paint — the cost the deferred load exists to avoid.
 * One entry per book, and the map is cleared when the capability stops.
 */
const sharedThunks = new Map<string, () => Promise<readonly PublicPassage[]>>()
function sharedWithCircleFor(bookId: string): () => Promise<readonly PublicPassage[]> {
  const held = sharedThunks.get(bookId)
  if (held !== undefined) return held
  const made = (): Promise<readonly PublicPassage[]> =>
    running === null ? Promise.resolve([]) : running.sharedPrivately(bookId)
  sharedThunks.set(bookId, made)
  return made
}

export const publicSharing: Capability = {
  id: 'public',
  requires: ['peer'],
  /**
   * Publishing one passage, on the mark's own row — WI-26.4's surface.
   *
   * ⚠️ **THE SAME SEAM THE CIRCLE'S SHARE USES, AND A SEPARATE CONTROL.** The
   * two sit beside each other under one note precisely so that reaching both
   * audiences takes two acts by the reader. A single control offering both
   * would be the mirror WI-26.4 forbids, built into the one place a reader
   * would never notice it.
   *
   * `running?.publishing ?? null` is read at RENDER, so a row drawn before the
   * capability starts, or after it stops, draws nothing.
   */
  markControls: [
    {
      id: 'public:publish',
      /* Stryker disable all: wiring — the port's own tests hold the behaviour. */
      render: (mark) =>
        createElement(PublishControl, {
          bookId: mark.bookId,
          passage: {
            quote: mark.text,
            prefix: mark.prefix,
            suffix: mark.suffix,
            chapter: mark.chapter,
          },
          port: running?.publishing ?? null,
          /* ⚠️ **THE ONE PROP WHOSE ABSENCE WAS A SILENT PRIVACY FAILURE.**
             Omitted here, `sharedWithCircle` defaulted to an empty list, so
             `linksVoiceToPerson` always said no and the disclosure that warns a
             reader they are about to link their pseudonym to their name could
             not appear. Found by audit. It reaches the circle through the
             kernel's port rather than by importing it, because iOS composes
             this capability with no circle at all — where empty is the true
             answer rather than a default. */
          sharedWithCircle: sharedWithCircleFor(mark.bookId),
        }),
      /* Stryker restore all */
    },
  ],
  panes: [
    {
      id: 'public:book',
      label: 'Publish',
      screens: ['reader'],
      /* After the circle's pane, which is about people the reader knows.
         Publishing to strangers is the rarer act and sits below it. */
      order: 20,
      render: (context) =>
        /* Stryker disable all: wiring — one prop each, and the port's own tests hold the behaviour. */
        createElement(PublicPane, {
          bookId: context.bookId,
          port: running?.port ?? null,
          voices: running?.voices ?? null,
          heardOn: heardOn,
        }),
      /* Stryker restore all */
    },
  ],
  overlays: [
    {
      id: 'public:annotations',
      forBook: (request) => (running ? annotationsFor(running, request) : Promise.resolve([])),
      subscribe: (listener) => {
        const held = running
        held?.listeners.add(listener)
        return () => {
          held?.listeners.delete(listener)
        }
      },
    },
  ],
  start(ctx: CapabilityContext): Disposable {
    const listeners = new Set<() => void>()
    const tell = (): void => {
      /* A SIGNAL, not a payload: the kernel re-asks `forBook`, so there is one
         path for "what should be drawn" rather than two that can disagree —
         `OverlayContribution.subscribe`'s rule.

         ⚠️ **AND EACH SUBSCRIBER ON ITS OWN.** A throwing listener stopped
         every later one AND travelled back into the change that had already
         been written — so a publication that landed on disk reported failure.
         See `notifyAll`, which is where that class is written down. */
      notifyAll(listeners, 'public')
    }
    /** One port's "something moved": say so in the log, then tell the overlay. */
    const changed =
      (event: string) =>
      (): void => {
        ctx.diagnostics.info(event)
        tell()
      }
    const mine: Running = {
      library: ctx.services.library,
      fs: ctx.services.fs,
      /* ⚠️ **`null` WITHOUT A FILESYSTEM, AND THE OVERLAY ALREADY STANDS DOWN
         THERE.** `annotationsFor` returns early on `fs === null`, which is the
         same condition — a browser client has neither. */
      voices:
        ctx.services.fs === null
          ? null
          : /* ⚠️ **THREE COPIES OF ONE SEQUENCE.** Each port took a callback
               that logged an event and then told the overlay, and the three
               differed only in the event's name — which is a factory, not a
               pattern to keep writing out. */
            voiceDecisionsPortOver(ctx.services.fs, ctx.services.writes, changed('public.decisions-changed')),
      publishing: publishPortOver(
        ctx.services.library,
        () => voicePort(),
        () => sharePort(),
        () => Date.now(),
        changed('public.published'),
      ),
      warn: (event, fields) => ctx.diagnostics.warn(event, fields),
      sharedPrivately: (bookId) => ctx.services.sharedPrivately(bookId),
      listeners,
      port: publicPortOver(
        ctx.services.library,
        /* Read per call, not captured: `peer` may be composed and this
           capability still started before its wire exists, and a port captured
           as `null` would stay null for the run. */
        () => sharePort(),
        changed('public.changed'),
      ),
    }
    running = mine
    return {
      /* Safe to call twice, and it only clears a run that is still THIS one:
         a start that raced a stop would otherwise take down its successor. */
      dispose: () => {
        if (running === mine) running = null
      },
    }
  },
}
