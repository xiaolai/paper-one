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
import { readPublic, writePublic, type StoreFs } from './lib/publicStore'
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
  /** The write queue and its lanes — what `writePublic` takes. */
  readonly writes: Pick<StoreFs, 'queue' | 'lane'>
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
 * How many rounds of asking one call will do.
 *
 * ⚠️ **A PROVIDER'S ANSWER IS CAPPED, SO A FULL BOOK TAKES SEVERAL.** The cap
 * is 256 records and a book retains at most 512, so TWO rounds cover any book
 * this device would keep and the fourth is slack — the prose said "three
 * rounds" beside a constant of four, which is the kind of disagreement that
 * gets the constant changed to match the sentence. The bound is here rather
 * than "until `more` is false" because `more` is a stranger's claim and a
 * hostile provider would otherwise hold this loop for as long as it liked.
 */
const NOTE_ROUNDS = 4

/**
 * Ask whoever serves this book for its public annotations, and keep what
 * verifies — phase 26's receiving half.
 *
 * ⚠️ **THIS DID NOT EXIST, AND WITHOUT IT THE WHOLE FEATURE WAS UNREACHABLE.**
 * The overlay reads `public.jsonl`; `writePublic` is what fills it; and until
 * now nothing in the app called `writePublic` at all. The plugin has answered
 * `paper/share-notes/1` since the phase landed and no device ever asked, so an
 * ordinary reader never saw a stranger's annotation. Found by audit.
 *
 * ⚠️ **THE PROVIDER IS NOT TRUSTED FOR ANYTHING.** What comes back is bytes;
 * `writePublic` is the door, and it checks the signature, the book, the
 * expiry, the reader's block list, the equivocation record and the storage
 * bounds. A provider that sends a thousand junk lines spends a thousand
 * refusals and changes nothing — which is the same posture the DHT's own note
 * takes: *"the provider index is a bulletin board, not a roster"*.
 *
 * ⚠️ **AND IT ASKS FROM ZERO EVERY TIME, DELIBERATELY.** A stored cursor is a
 * second thing to keep consistent with the file, and a cursor that drifts
 * skips records permanently — the exact failure `generation` exists to catch
 * one layer down. Asking again is bandwidth on a reader's own explicit
 * request; every record already held is refused as a duplicate before it
 * reaches the bounds.
 */
async function receiveNotes(held: Running, bookId: string, named: readonly string[] = []): Promise<number> {
  const { fs, voices } = held
  if (fs === null || voices === null) return 0
  const book = held.library.getSnapshot().find((one) => one.bookId === bookId)
  if (book === undefined || !isContentHash(book.contentHash)) return 0
  const share = sharePort()
  if (share === null) return 0
  const hash = book.contentHash
  /* Who to ask. The index is a hint and never a roster, so an empty answer is
     "nobody advertised", not "nobody has it".

     ⚠️ **AND THE FALLBACK THIS COMMENT USED TO PROMISE DOES NOT EXIST.** It
     said `fetchNotes` "falls back to discovery itself when the list is empty",
     which is true and is a fallback TO THE DHT: `ShareNode::discovered`
     returns an empty vector the moment `dht()` is `None`. So with announcing
     off — which is the only way to use this layer without writing a home
     address into a permanent public index — an empty list means nobody, on a
     LAN or anywhere. Measured 2026-09-11 between two Macs on one network.

     `named` is the way out, and it is out-of-band by design: a reader hands
     somebody their share id the way they would a phone number, and it is
     tried BEFORE the index rather than instead of it, so the two compose. */
  /* ⚠️ **A FAILED LOOKUP AND AN EMPTY INDEX READ IDENTICALLY, AND THIS SAID
     NOTHING ABOUT THE DIFFERENCE.** `.catch(() => [])` folded a share endpoint
     that never started, a DHT socket that refused and a lookup that timed out
     into the same answer the paragraph above says means "nobody advertised". So
     "Look for some" reported "Nobody who answered has published anything" over a
     layer that had not asked anybody — the shape three evenings of a silent far
     end went to. Named through `held.warn`, which is `ctx.diagnostics.warn`, so
     `diagnostics.jsonl` carries it on a release build where nothing else can be
     asked. The ANSWER is unchanged: an unreachable index is still nobody. */
  const advertised = await share.resolve(hash, 'notes').catch((thrown: unknown) => {
    held.warn('public.resolve-failed', { book: bookId, message: messageOf(thrown) })
    return [] as readonly string[]
  })
  const providers = [...named, ...advertised.filter((one) => !named.includes(one))]
  const decisions = await voices.decisions()
  const blocked = (voice: string): boolean => standingOf(voice, decisions) === 'blocked'
  let taken = 0
  let since = 0
  let generation: number | undefined
  for (let round = 0; round < NOTE_ROUNDS; round += 1) {
    const answer = await share.fetchNotes(hash, providers, since, generation)
    if (answer.records.length > 0) {
      const written = await writePublic(fs, held.writes, bookId, hash, answer.records, publicCrypto, Date.now(), blocked)
      for (const [why, count] of Object.entries(written.refused)) {
        held.warn('public.refused', { bookId, why, count })
      }
      taken += answer.records.length
    }
    if (!answer.more) break
    since = answer.next
    generation = answer.generation
  }
  /* The overlay re-asks rather than being pushed to — `OverlayContribution`'s
     rule — so the signal is what makes what just landed visible. */
  notifyAll(held.listeners, 'public')
  return taken
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

/* ⚠️ **THREE ACCESSORS STOOD HERE AND NOTHING CALLED ANY OF THEM.**
   `publicPort()`, `publishPublicPort()` and `voiceDecisionsPort()` each
   answered `running?.<field> ?? null`, and every render site reads `running`
   directly — which is what the `?? null` in each `render` above is. So they
   were an abstraction over a field, exported, never used, and free to
   disagree with the thing they wrapped. `sharePort()` and `voicePort()` in the
   peer capability look like these and are NOT the same shape: those cross a
   capability boundary, which is a reason. Found by audit. */

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
 * Ask for this book's public annotations, on the reader's own say-so.
 *
 * ⚠️ **ON A CONTROL AND NEVER ON A TIMER OR AN OPEN.** Asking is a network act
 * that tells whoever answers that this device is interested in this book, and
 * doing it automatically would make opening a book a broadcast. The reader
 * decides, per book, each time — which is the same posture `PublishControl`
 * takes for the other direction.
 */
/**
 * This device's share endpoint id, for the pane to show.
 *
 * A thunk rather than a value because the capability may not be running, and
 * a stable one because `PublicPane` keys an effect on it — a fresh closure per
 * render would re-ask the plugin on every paint.
 */
const shareIdOfThisDevice = (): Promise<string> => {
  const port = sharePort()
  return port === null ? Promise.reject(new Error('the peer capability is not running')) : port.shareId()
}

const lookForNotes = (bookId: string, named: readonly string[] = []): Promise<number> =>
  running === null ? Promise.resolve(0) : receiveNotes(running, bookId, named)

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

/**
 * Everything one run of this capability owns, wired together.
 *
 * ⚠️ **EXTRACTED FROM `start`, WHICH DID FIVE THINGS AT ONCE**: it built the
 * notifier, constructed three ports, assembled the shared state, installed it
 * and defined the disposal — so which of them owned the listeners, and which
 * of the three ports could tell them, could only be worked out by reading all
 * fifty lines. `start` now installs and disposes; this decides what a run IS.
 * Found by audit.
 */
function runningOver(ctx: CapabilityContext): Running {
  const listeners = new Set<() => void>()
  const tell = (): void => {
    /* A SIGNAL, not a payload: the kernel re-asks `forBook`, so there is one
       path for "what should be drawn" rather than two that can disagree —
       `OverlayContribution.subscribe`'s rule.

       ⚠️ **AND EACH SUBSCRIBER ON ITS OWN.** A throwing listener stopped every
       later one AND travelled back into the change that had already been
       written — so a publication that landed on disk reported failure. See
       `notifyAll`, which is where that class is written down. */
    notifyAll(listeners, 'public')
  }
  /**
   * One port's "something moved": say so in the log, then tell the overlay.
   *
   * ⚠️ **A FACTORY, BECAUSE THERE WERE THREE COPIES OF IT.** Each port took a
   * callback that logged an event and then told the overlay, and the three
   * differed only in the event's name.
   */
  const changed =
    (event: string) =>
    (): void => {
      ctx.diagnostics.info(event)
      tell()
    }
  return {
    library: ctx.services.library,
    fs: ctx.services.fs,
    writes: { queue: ctx.services.writes, lane: (bookId: string) => ctx.services.library.lane(bookId) },
    /* ⚠️ **`null` WITHOUT A FILESYSTEM, AND THE OVERLAY ALREADY STANDS DOWN
       THERE.** `annotationsFor` returns early on `fs === null`, which is the
       same condition — a browser client has neither. */
    voices:
      ctx.services.fs === null
        ? null
        : voiceDecisionsPortOver(ctx.services.fs, ctx.services.writes, changed('public.decisions-changed')),
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
          lookForNotes: lookForNotes,
          shareId: shareIdOfThisDevice,
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
    const mine = runningOver(ctx)
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
