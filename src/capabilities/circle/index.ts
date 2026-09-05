import {
  acceptsTransport,
  canonicalJson,
  createCoverFactsPass,
  drawable,
  drawsEntry,
  folderOf,
  listTrash,
  messageOf,
  overlayKey,
  publishableCover,
  readmit,
  type Capability,
  type CapabilityContext,
  type Disposable,
  type ForeignAnnotation,
  type ForeignEntry,
  type HashPort,
  type Hlc,
  type IndexFs,
  type IndexedBook,
  type Library,
  type OverlayRequest,
  type Relationship,
  type ResolvedPassage,
  type SettingsStore,
  type TrashFs,
  type VaultFs,
  type WriteQueue,
} from '../../kernel'
import { createElement } from 'react'
import { peopleFor, readForeign, type ForeignFile } from './lib/store'
import { answerCover, answerPages, welcome, type BookLike, type Serving } from './lib/exchange'
import { COVER_CAP_SETTING, createCoverFetcher } from './lib/covers'
import { readShared, updateShared, type Publisher } from './lib/publish'
import { CIRCLE_SERVICES } from './lib/protocol'
import { mintPub, sharePortOver, type SharePort } from './lib/sharing'
import { opinionPortOver, type OpinionDriver } from './lib/opinionPort'
import { BookPane } from './ui/BookPane'
import { createCadence, type Cadence } from './lib/cadence'
import { fetchRound, type FetchPorts } from './lib/fetch'
import { pageCrypto } from './lib/crypto'
import { readHeldShelf, writeForeign, writeHeldShelf } from './lib/store'
import { readOwnShelf, syncShelf, updateOwnShelf } from './lib/shelf'
import { answerLists, answerShelf } from './lib/exchange'
import { ownListIds, readOwnList, updateOwnList } from './lib/lists'
import { heldListIdsOf, readHeldList, writeHeldList } from './lib/store'
import { circlePortOver, type CirclePort } from './lib/circlePort'
import { tellEach } from './lib/listeners'
import { createSpendLedger, type SpendLedger } from './lib/spendLedger'
import { listsPortOver, type ListsPort } from './lib/listsPort'
import { purgePerson, readRelationship, writeRelationship } from './lib/relationships'
import { peerPort, personPort, publishPort, type PublishPort } from '../peer'
import { CirclePane } from './ui/CirclePane'
import { ShareControl } from './ui/ShareControl'

/**
 * The `circle` capability — passages other readers shared, drawn in your book.
 *
 * ## What it does today, stated plainly
 *
 * It publishes, fetches, holds and draws. The share control (WI-23.A1)
 * writes a passage into `<book>/shared.json`; the fetch driver (WI-23.A2)
 * asks every admitted person's devices on a cadence and files what they
 * serve under `<book>/circle/<person>.json`, `circle/<person>/shelf.json`
 * and `circle/<person>/lists/`; the overlay draws the passages held, subject
 * to the relationship record; the book pane and the Circle screen draw the
 * rest. `docs/design/circle/wire.md` is the format on the socket, and
 * `dev-docs/plans/phase-23-the-circle-reads.md` the trail of what landed.
 *
 * ## Why it contributes an overlay rather than marks
 *
 * A foreign passage must NEVER enter `marks.json` — `exportMarks`, the sync
 * feed and every one of the reader's own devices would carry it as theirs.
 * `overlays` is the contribution type for exactly this: the capability answers
 * with DATA and the kernel's own painter draws it, so rendering never moves
 * into a capability.
 *
 * ## The resolver comes from the kernel, and that is load-bearing
 *
 * `forBook` is handed `resolve`, which walks the OPEN book through
 * `section.createDocument()` — the object `refuseBookScripts` wrapped at open.
 * A capability that parsed the file itself would get an unstripped document and
 * a path that can disagree by a child index, which is `bookScripts.test.ts`'s
 * *"address the same passage by the same path"* failing silently.
 */

interface Held {
  readonly fs: IndexFs
  readonly listeners: Set<() => void>
  /** The run's diagnostics, so a file that would not read is in the log the reader can open, not only on the console. */
  readonly warn: (event: string, detail: Record<string, unknown>) => void
}

let held: Held | null = null

/**
 * Every foreign entry this device holds for a book, across every person.
 *
 * ⚠️ **ONE PERSON'S UNREADABLE FILE MUST NOT COST THE OTHERS.** `readForeign`
 * throws rather than collapsing absent and unreadable — which is right, and
 * would take the whole book's overlay down if this let it propagate. Reported
 * per person, and the rest are drawn: the same posture `enrichOne` takes, for
 * the same reason.
 */
async function entriesFor(
  fs: IndexFs,
  bookId: string,
  warn: Held['warn'],
): Promise<readonly ForeignEntry[]> {
  const out: ForeignEntry[] = []
  for (const person of await peopleFor(fs, bookId)) {
    try {
      out.push(...(await readForeign(fs, bookId, person)).entries)
    } catch (cause) {
      warn('circle.read-failed', { person, bookId, message: messageOf(cause) })
    }
  }
  return out
}

/**
 * Anchor what has not been anchored, then hand over what can be drawn.
 *
 * ⚠️ **A PASSAGE IS RESOLVED BEFORE IT IS CONTRIBUTED, never after.**
 * `surfaces.md`: contributing an unresolved passage *"would put a foreign path
 * in front of the painter, which is the defect all of phase 21 exists to
 * remove."* `ForeignAnnotation.cfi` is a `ResolvedCfi`, so the compiler agrees.
 *
 * ⚠️ **AND AN INCOMPLETE WALK IS NOT A MISS.** `resolve` answers
 * `complete: false` when the reader closed the book or a section would not
 * load, with an empty `missed` — so nothing here needs to remember the rule,
 * only to not invent misses of its own.
 */
async function annotationsFor(
  held: Held,
  request: OverlayRequest,
): Promise<readonly ForeignAnnotation[]> {
  const entries = await entriesFor(held.fs, request.bookId, held.warn)
  if (entries.length === 0) return []

  /* ⚠️ **KEYED BY PERSON AND PUB, AND IT WAS KEYED BY `pub` ALONE.** A `pub`
   * is minted by whoever shared the passage, so it is unique to that PERSON and
   * not across the circle: two people can mint the same string, and the shelf
   * has no say in it. Keyed on `pub` alone, both landed on one entry in `found`
   * and BOTH entries then took whichever anchor arrived last — so Alice's mark
   * was drawn at Bob's sentence, and `foreignWeight` counted two readers of a
   * passage only one of them had marked. `overlayKey` already composes both
   * for exactly this reason; this is the same composition one step earlier. */
  const pending = entries
    .filter((entry) => entry.resolved === undefined)
    .map((entry) => ({
      id: overlayKey(entry),
      quote: entry.passage.quote,
      prefix: entry.passage.prefix,
      suffix: entry.passage.suffix,
    }))

  /* Only walk when there is something to walk FOR. A book whose entries are
     all anchored already costs nothing on open. */
  /* ⚠️ **NO CAST HERE, AND THERE USED TO BE ONE.** `fresh.cfi as never` widened
     the resolver's answer back to whatever it happened to be, so the
     `ResolvedCfi` brand — the whole of WI-22.A1 — was bypassed at the one seam
     a foreign passage crosses. `ResolvedPassage.cfi` now carries the brand, so
     this reads through unchanged and a cast would not compile. */
  const found = new Map<string, ResolvedPassage>()
  if (pending.length > 0) {
    const result = await request.resolve(pending)
    for (const one of result.found) found.set(one.id, one)
  }

  const anchored = entries.map((entry) => {
    const fresh = found.get(overlayKey(entry))
    return fresh
      ? { ...entry, resolved: { cfi: fresh.cfi, sectionIndex: fresh.sectionIndex } }
      : entry
  })

  /* ⚠️ **THE RELATIONSHIP RECORD DECIDES WHAT IS DRAWN** — `drawsEntry`,
   * WI-22.E3 through WI-23.C2's store: a muted or blocked person's passages
   * are not drawn, and a re-admitted person's old ones are not revived,
   * because their epoch is the old relationship's. A record that will not
   * read refuses the person's entries rather than drawing them: a decision
   * about a person is not something to guess at. */
  const relationships = new Map<string, Relationship>()
  for (const person of new Set(anchored.map((entry) => entry.person))) {
    try {
      relationships.set(person, await readRelationship(held.fs as VaultFs, person))
    } catch (cause) {
      /* In the log the reader can open, as a circle file that will not read
         is — a decision about a person that cannot be read is as much their
         news as a passage that cannot be. Drawing nothing of theirs. */
      held.warn('circle.relationship-read-failed', { person, message: messageOf(cause) })
    }
  }
  return drawable(
    anchored,
    /* No roster here, so the person's own id is the only name there is. It is
       shown as a claim and never as a name Paper has checked — see
       `surfaces.md` on the displayed name. */
    (person) => person,
    (person, epoch) => {
      const relationship = relationships.get(person)
      return relationship !== undefined && drawsEntry(relationship, epoch)
    },
  )
}

/**
 * What this device serves a friend who asks — WI-22.C4.
 *
 * ⚠️ **THE HANDLERS ARE THIN ON PURPOSE.** A service handler is the hardest
 * thing in this capability to reach from a test: it needs a peer, a grant and a
 * live envelope. So the deciding is in `exchange.ts`, which is pure and
 * exhaustively tested, and this is the wiring that hands it its inputs.
 */
function served(): {
  hello: (r: unknown) => Promise<unknown>
  pages: (r: unknown) => Promise<unknown>
  shelf: (r: unknown, peer: string) => Promise<unknown>
  lists: (r: unknown, peer: string) => Promise<unknown>
  cover: (r: unknown, peer: string) => Promise<unknown>
} {
  /* Captured per call, not read through the module binding mid-operation: a
     teardown clears it, and a handler that re-read it would fail halfway
     instead of belonging to the run that started it. */
  const run = running
  return {
    hello: async (request) => {
      if (!run) throw new Error('circle has not started')
      const mine = await run.publisher()
      /* A device with no identity has no name to answer under. Not an error in
         the reader's world — they have never shared — but there is nothing to
         say, and a hello that answered anyway would be answering for nobody. */
      if (!mine) throw new Error('this device has no person identity')
      const answer = welcome(request, mine.person)
      if (!answer) throw new Error('that hello is not one this build answers')
      return answer
    },
    pages: async (request) => {
      if (!run) throw new Error('circle has not started')
      const answer = await answerPages(request, run.serving())
      if (!answer) throw new Error('that request is not one this build answers')
      return answer
    },
    /* ⚠️ **THE SWITCH IS CHECKED HERE, PER PERSON, AGAINST THE RELATIONSHIP**
     * — not by the envelope against a grant. The caller is a DEVICE; the
     * decision is about the person the roster says that device speaks for.
     * A device nobody's roster names, or a person the switch is off for,
     * is answered exactly as a reader who owns nothing is. */
    shelf: async (request, peer) => {
      if (!run) throw new Error('circle has not started')
      const answer = await answerShelf(request, run.serving(), await run.discloses(peer))
      if (!answer) throw new Error('that request is not one this build answers')
      return answer
    },
    /* The lists, under the shelf's switch — WI-23.E1. */
    lists: async (request, peer) => {
      if (!run) throw new Error('circle has not started')
      const answer = await answerLists(request, run.serving(), await run.discloses(peer))
      if (!answer) throw new Error('that request is not one this build answers')
      return answer
    },
    /* A jacket, one chunk per call (WI-23.C5). The refusal is one sentence
       whatever the reason — see `answerCover`. */
    cover: async (request, peer) => {
      if (!run) throw new Error('circle has not started')
      const answer = await answerCover(request, run.serving(), await run.discloses(peer))
      if (!answer) throw new Error('that request is not one this build answers')
      return answer
    },
  }
}

/** What the handlers read, gathered once at `start`. */
interface Running {
  readonly publisher: () => Promise<Publisher | null>
  readonly serving: () => Serving
  /** Whether the person the calling DEVICE speaks for is shown the shelf. */
  readonly discloses: (device: string) => Promise<boolean>
  /**
   * The share control's port — WI-23.A1.
   *
   * ONE per run, not one per render: the control keys an effect on it, and a
   * port built afresh on every render of every mark row would re-read the
   * store on each. Made at `start`, so it is bound to this run's filesystem
   * and clock and dies with them.
   */
  readonly sharing: SharePort & { dispose(): void }
  /**
   * The book pane's port and the republish driver behind it — WI-23.B4.
   * One per run, for `sharing`'s reason, and disposed with the run: it holds
   * a subscription to the library.
   */
  readonly opinion: OpinionDriver
  /** The Circle screen's own port — the shelf switch, the Friends view, the purge. WI-23.C2–C4. */
  readonly circle: CirclePort & { dispose(): void }
  /** The reader's own lists — WI-23.E1. One per run, for `sharing`'s reason. */
  readonly lists: ListsPort & { dispose(): void }
  /**
   * Bring the published shelf up to the library — WI-23.C1's driver. A
   * no-op without an identity to publish as, and idempotent: the store is
   * written only when the shelf changed.
   */
  readonly publishShelf: () => Promise<void>
  /**
   * The reader has just made an identity — `PersonPort.onIdentity`: publish
   * what waited on one, each on its own, and tell every surface that asks
   * whether it can publish, whatever failed.
   */
  readonly identityChanged: () => Promise<void>
}

/**
 * The publishing identity, turned into what a page needs.
 *
 * ⚠️ **THE DELEGATION IS RE-CANONICALISED HERE, AND THAT IS SAFE.** Rust
 * serialises its struct in declaration order; `canonicalJson` sorts. The
 * signature covers `delegationBytes` — six fields joined by newlines, never
 * this JSON — so re-spelling the object changes nothing it is checked against,
 * and gives the recipient the canonical form `readDelegation` requires.
 */
function publisherFor(work: Publisher['work'], mine: PagePublisherLike, port: PublishPort): Publisher {
  return {
    person: mine.person,
    device: mine.device,
    work,
    roster: [...mine.roster],
    revocations: mine.revocations,
    delegation: canonicalJson(mine.delegation),
    sign: async (message) => {
      /* THE PORT THAT ANSWERED `mine()`, and only while it is still the
         current one: a teardown between building the page and signing it
         must fail loudly rather than sign through a port the run no longer
         owns — and a peer RESTART in that window must not sign this
         publisher's page with a different device's key. */
      if (publishPort() !== port) throw new Error('this device cannot sign — peer has not started, or has restarted since')
      return port.sign(message)
    },
  }
}

/** The shape `peer_circle_mine` answers with. */
interface PagePublisherLike {
  readonly person: string
  readonly device: string
  readonly delegation: object
  readonly roster: readonly string[]
  readonly revocations: number
}

export const circle: Capability = {
  id: 'circle',
  requires: ['peer'],
  /**
   * The circle's own SCREEN — WI-22.D3.
   *
   * ⚠️ **A SCREEN, NOT A PANE, AND IT WAS A PANE FIRST.** The side pane holds
   * panels ABOUT what is already on screen — this book's contents, this shelf's
   * tags. The circle is about neither; it is a third thing the reader looks at,
   * peer to the library. Drawn in the pane it was a strip beside a grid of
   * books it had nothing to do with.
   *
   * ⚠️ **NOT A LIST OF SHARED PASSAGES.** Those are drawn in the book, where
   * the sentence is; `surfaces.md` decides that and this screen does not
   * relitigate it. What is here is what a reader cannot see by turning a page:
   * who is in the circle, and whether their own identity is one dead laptop
   * from being gone.
   */
  /**
   * The two services a friend calls — WI-22.C4.
   *
   * ⚠️ **BOTH GATED ON `circle:read`, WHICH IS GRANTED ONLY BY A CIRCLE
   * PAIRING.** `personPortOver` passes exactly that grant when it joins or
   * confirms one, so a device paired as a DEVICE — your own laptop — cannot
   * ask for pages. That is the whole distinction the two pairing kinds exist
   * to make, and a service with no grant would erase it.
   */
  services: [
    {
      name: CIRCLE_SERVICES.hello.name,
      grant: CIRCLE_SERVICES.hello.grant,
      handler: (request: unknown) => served().hello(request),
    },
    {
      name: CIRCLE_SERVICES.pages.name,
      grant: CIRCLE_SERVICES.pages.grant,
      handler: (request: unknown) => served().pages(request),
    },
    {
      name: CIRCLE_SERVICES.shelf.name,
      grant: CIRCLE_SERVICES.shelf.grant,
      handler: (request: unknown, ctx) => served().shelf(request, ctx.peer),
    },
    {
      name: CIRCLE_SERVICES.lists.name,
      grant: CIRCLE_SERVICES.lists.grant,
      handler: (request: unknown, ctx) => served().lists(request, ctx.peer),
    },
    {
      name: CIRCLE_SERVICES.cover.name,
      grant: CIRCLE_SERVICES.cover.grant,
      handler: (request: unknown, ctx) => served().cover(request, ctx.peer),
    },
  ],
  screens: [
    {
      id: 'circle:circle',
      label: 'Circle',
      render: (context) =>
        /* Stryker disable all: wiring — each line hands one store, port or prop through; the port's own tests hold the behaviour, and `index.peer.test.ts` holds that the seams reach the peer. */
        createElement(CirclePane, {
          port: personPort(),
          circle: running?.circle ?? null,
          lists: running?.lists ?? null,
          ...(context.openBook ? { openBook: context.openBook } : {}),
        }),
      /* Stryker restore all */
    },
  ],
  /**
   * The share control, on every one of the reader's own marks — WI-23.A1.
   *
   * ⚠️ **ON THE MARK'S OWN ROW, through the kernel's `markControls` seam** —
   * not a second list of the reader's marks in a pane of this capability's
   * own, which would be *"a second place to read the same book badly"*
   * (`CirclePane`). Marginalia hands over the mark; this hands back the
   * element; the kernel never learns what Share does.
   *
   * `running?.sharing ?? null` is read at RENDER, so a row drawn before the
   * capability starts, or after it stops, draws nothing rather than a control
   * over a port that no longer owns a filesystem.
   */
  markControls: [
    {
      id: 'circle:share',
      render: (mark) => createElement(ShareControl, { mark, port: running?.sharing ?? null }),
    },
  ],
  /**
   * The book's surface — WI-23.B4, and Stage D's home.
   *
   * A PANE beside the open book, because that is where a reader says what
   * they think of it and where the circle's view of it belongs; the kernel
   * hands the pane the open book through `PaneContext`. On the reader screen
   * only: on the shelf there is no one book to be about.
   */
  panes: [
    {
      id: 'circle:book',
      label: 'Circle',
      screens: ['reader'],
      render: (context) =>
        /* Stryker disable all: wiring — each line hands one store, port or prop through; the port's own tests hold the behaviour, and `index.peer.test.ts` holds that the seams reach the peer. */
        createElement(BookPane, {
          bookId: context.bookId,
          port: running?.opinion ?? null,
          circle: running?.circle ?? null,
          lists: running?.lists ?? null,
          ...(context.openBook ? { openBook: context.openBook } : {}),
        }),
      /* Stryker restore all */
    },
  ],
  overlays: [
    {
      id: 'circle:shared',
      forBook: (request) => (held ? annotationsFor(held, request) : Promise.resolve([])),
      subscribe: (listener) => {
        /* ⚠️ **THE SET IS CAPTURED, NOT LOOKED UP AGAIN ON THE WAY OUT.** The
         * unsubscribe read the module slot, so after a restart it deleted the
         * listener from the NEW run's set — removing somebody else's
         * subscription and leaving its own in place. */
        const into = held?.listeners
        into?.add(listener)
        return () => {
          into?.delete(listener)
        }
      },
    },
  ],
  start(ctx: CapabilityContext): Disposable {
    const fs = ctx.services.fs
    /* No filesystem is a legitimate composition — the browser client has none
       — and it means no shared passages rather than a failed capability. */
    /* ⚠️ **THIS RUN'S OWN STATE, AND `dispose` USED TO READ THE MODULE SLOT.**
     * An overlapping restart replaces `held`; the OLD disposable then ran
     * `held?.listeners.clear()` and `held = null` against the NEW run — leaving
     * a capability that is nominally started, contributes an overlay, and has
     * had its listeners taken away. `peer/index.ts` already guards its own
     * teardown this way (`if (port === held.port)`), for the same reason. */
    const mine: Held | null = fs
      ? {
          fs: fs as IndexFs,
          listeners: new Set(),
          /* Both the console and the in-app log: the console is where a
             developer looks first, the diagnostics window is the one a reader
             can open. A composition without diagnostics still gets the first. */
          warn: (event, detail) => {
            console.warn(`Paper: ${event}`, detail)
            ctx.diagnostics?.warn(event, detail)
          },
        }
      : null
    /* ONE ledger for the run: the round and the jackets charge the same budget (WI-23.C5). */
    const ledger = createSpendLedger()
    /* RE-ADMISSION IS A PAIRING — the ceremony `readmit` insists on. A person
       removed keeps an exited record as a tombstone (`purgePerson`), and the
       one act that turns it into a new epoch is meeting them again. */
    const offPairing = mine ? readmitOnPairing(mine.fs as VaultFs, ctx.services.writes, ctx.services.clock, ctx.diagnostics) : null
    held = mine
    running = mine
      ? runningOver({
          fs: mine.fs,
          library: ctx.services.library,
          writes: ctx.services.writes,
          clock: ctx.services.clock,
          warn: (event, detail) => ctx.diagnostics.warn(event, detail),
          hashes: () => ctx.services.hashes(),
          ledger,
          settings: ctx.settings,
          /* This run's listeners — the overlay's set, which `circleChanged`
             also tells — handed in rather than read from the module slot. */
          onChanged: (listener) => {
            mine.listeners.add(listener)
            return () => {
              mine.listeners.delete(listener)
            }
          },
          changed: () => tellEach(mine.listeners, 'circle'),
        })
      : null
    const ours = running
    /* ⚠️ **THE FETCH PORTS LIVE FOR THE RUN, NOT FOR THE ROUND.** They carry
       the spend ledger; ports made afresh each round handed every person a
       fresh budget every five minutes. The peer's own ports are still read
       inside them per call, so a peer that starts later is found. */
    const fetchPorts = mine ? fetchPortsOver(mine.fs, ctx.services.library, ctx.services.writes, ledger, mine.warn) : null
    /* THE FETCH DRIVER — WI-23.A2. On a cadence timed from this start and
       from nothing else; see `cadence.ts` for why a book being opened must
       never move it. Its ports are read per round, so a peer that starts
       after the circle is found on the next tick rather than never. */
    const driver: Cadence | null = mine
      ? createCadence({
          run: async () => {
            const report = await fetchRound(fetchPorts!)
            ctx.diagnostics.info('circle.fetch', { ...report, skipped: report.skipped.length, skips: report.skipped })
          },
          failed: (cause) => {
            ctx.diagnostics.warn('circle.fetch.failed', { message: messageOf(cause) })
          },
        })
      : null
    /* EVERYTHING ACQUIRED FROM HERE IS LET GO IF THE REST OF `start` THROWS:
       a capability half started — driver armed, subscription taken, module
       slots pointing at it — is one the composition believes is not running
       at all. `dispose` is idempotent, so the same function serves both. */
    let offShelf: (() => void) | null = null
    let offIdentity: (() => void) | null = null
    const dispose = (): void => {
      driver?.stop()
      offPairing?.()
      offShelf?.()
      offIdentity?.()
      ours?.circle.dispose()
      ours?.sharing.dispose()
      ours?.opinion.dispose()
      ours?.lists.dispose()
      mine?.listeners.clear()
      if (held === mine) held = null
      /* Guarded for the reason `held` is: an overlapping restart must not
         have the OLD disposable take the NEW run's services away. */
      if (running === ours) running = null
    }
    /* On the kernel's own stack too, so a startup that fails in ANOTHER
       capability tears this one down with the rest. */
    ctx.onCleanup(dispose)
    try {
      driver?.start()
      /* The opinion driver reads every book's switch once, so a relaunch goes
         on publishing what it published — and anything the reader changed
         while the app was closed is published now. Off the boot path. */
      void ours?.opinion.warm().catch((cause: unknown) => {
        ctx.diagnostics.warn('circle.opinion.warm-failed', { message: messageOf(cause) })
      })
      /* The published shelf follows the library — WI-23.C1: adding a book
         publishes `shelf`, removing one `unshelf`. Once at start, then on every
         change; a no-op until there is an identity to publish as. */
      offShelf = ours
        ? ctx.services.library.subscribe(() => {
            void ours.publishShelf().catch((cause: unknown) => {
              ctx.diagnostics.warn('circle.shelf.publish-failed', { message: messageOf(cause) })
            })
          })
        : null
      void ours?.publishShelf().catch((cause: unknown) => {
        ctx.diagnostics.warn('circle.shelf.publish-failed', { message: messageOf(cause) })
      })
      /* AN IDENTITY MADE LATER — WI-23.C1 and A1. The peer's own lifecycle,
         not a panel's call: `ensure` on the Circle screen is one way an
         identity arrives, and the capability must not depend on every
         surface that makes one remembering to say so. The port is read at
         start: `peer` starts first (`requires`), and a composition without
         one — the browser client — has no identity to make. */
      offIdentity = ours ? (personPort()?.onIdentity(() => void ours.identityChanged()) ?? null) : null
    } catch (cause) {
      dispose()
      throw cause
    }
    return {
      dispose: () => {
        dispose()
      },
    }
  },
}

/**
 * Every list held for a person, by id — one reader for the two adapters that
 * need it.
 *
 * ⚠️ **ONE LIST THAT WILL NOT READ MUST NOT COST THE OTHERS** — `entriesFor`'s
 * rule, and it was broken here: one malformed file rejected the whole read,
 * and with it the friend's shelf, their activity and every valid list, on
 * the screen and in the round. Reported per list, and the rest are read; in
 * the round a list unread is asked for from its start, and the file that
 * would not read is written over by one that does.
 */
async function readHeldLists(fs: IndexFs, person: string, warn: Held['warn']): Promise<ReadonlyMap<string, ForeignFile>> {
  const ids = await heldListIdsOf(fs, person)
  const read = await Promise.all(
    ids.map(async (id) => {
      try {
        return [id, await readHeldList(fs as VaultFs, person, id)] as const
      } catch (cause) {
        warn('circle.list-read-failed', { person, listId: id, message: messageOf(cause) })
        return null
      }
    }),
  )
  return new Map(read.filter((one) => one !== null))
}

/**
 * The round's ports, over this run's services and the peer's live ports.
 *
 * ⚠️ **THE PEER PORTS ARE READ HERE, PER ROUND, NOT CAPTURED AT START.**
 * `peer` starts before `circle` (`requires`), but its wire is the plugin's and
 * a composition without one — the browser client — has none; a round then
 * asks nobody, which is the honest answer, and a peer that arrives later is
 * found by the next tick.
 *
 * The spend ledger lives for the run. The caller dials; a peer cannot make
 * this side re-launch to reset it, which is the case `bound.ts` persists the
 * serving-side ledger against.
 */
/* The spend ledger is `lib/spendLedger.ts` — one step, read to commit. */

/**
 * Whether a person is still admitted in the epoch some pages were recorded
 * under — asked by the store's writers INSIDE the file's lane, where a purge
 * that took the lane first has left an exited record. See `writeForeign`.
 */
async function stillAdmits(fs: VaultFs, person: string, epoch: number): Promise<boolean> {
  const held = await readRelationship(fs, person)
  return acceptsTransport(held.state) && held.epoch === epoch
}

/**
 * Re-admit, in a new epoch, a person the reader has just met again.
 *
 * The roster is diffed across each circle pairing that completes: the
 * person it added, and only them, is looked up, and one whose record has
 * ended — exited by a forget, or blocked — is re-admitted through `readmit`,
 * which is the bump the design makes unforgettable. A person whose record
 * still admits them needs nothing. Nothing is minted for a pairing that
 * failed, and a roster that will not read is reported and leaves every
 * record as it was.
 */
function readmitOnPairing(fs: VaultFs, writes: WriteQueue, clock: () => Hlc, diagnostics: CapabilityContext['diagnostics']): (() => void) | null {
  const port = personPort()
  if (!port) return null
  const roster = async (): Promise<ReadonlySet<string>> => new Set((await port.people()).map((one) => one.person))
  let known: ReadonlySet<string> | null = null
  const first = roster().then((now) => {
    known = now
  })
  return port.onResult((result) => {
    if (!result.ok) return
    void (async () => {
      /* The roster as it was at start, before anything is diffed against it. */
      await first.catch(() => {})
      const now = await roster()
      const before = known ?? new Set<string>()
      known = now
      for (const person of now) {
        if (before.has(person)) continue
        const held = await readRelationship(fs, person)
        if (acceptsTransport(held.state)) continue
        const again = await writeRelationship(fs, writes, readmit(held, clock()))
        diagnostics.info('circle.readmitted', { person, epoch: again.epoch })
      }
    })().catch((cause: unknown) => {
      diagnostics.warn('circle.readmit-failed', { message: messageOf(cause) })
    })
  })
}

function fetchPortsOver(fs: IndexFs, library: Library, writes: WriteQueue, ledger: SpendLedger, warn: Held['warn']): FetchPorts {
  return {
    mine: async () => {
      const mine = await publishPort()?.mine()
      return mine ? { person: mine.person } : null
    },
    people: async () => (await personPort()?.people()) ?? [],
    /* The relationship record — its state says whether to dial, its epoch is
       what every entry taken is recorded under (WI-23.D3). */
    relationship: (person) => readRelationship(fs as VaultFs, person),
    dialable: async () => new Set(((await peerPort()?.listPeers()) ?? []).map((peer) => peer.id)),
    dial: async (device) => {
      const port = peerPort()
      if (!port) throw new Error('peer has not started')
      return port.connect(device)
    },
    books: () => library.getSnapshot().map(bookLike),
    /* Stryker disable all: the stores, handed through — reached only with a verified page in hand, which needs a peer's real signature; the fetch driver's tests hold what a keep does at the port. */
    held: (bookId, person) => readForeign(fs as VaultFs, bookId, person),
    keep: (bookId, person, file, epoch) =>
      /* A book removed while the round was out is not written back into being:
         its folder is gone, and a keep would recreate it around one file. */
      library.getSnapshot().some((one) => one.bookId === bookId)
        ? writeForeign(fs as VaultFs, writes, (id) => library.lane(id), bookId, person, file, circleChanged, () => stillAdmits(fs as VaultFs, person, epoch))
        : Promise.resolve(),
    heldShelf: (person) => readHeldShelf(fs as VaultFs, person),
    keepShelf: (person, file, epoch) => writeHeldShelf(fs as VaultFs, writes, person, file, circleChanged, () => stillAdmits(fs as VaultFs, person, epoch)),
    heldLists: (person) => readHeldLists(fs, person, warn),
    keepList: (person, id, file, epoch) => writeHeldList(fs as VaultFs, writes, person, id, file, circleChanged, () => stillAdmits(fs as VaultFs, person, epoch)),
    /* The spend ledger, charged only as pages land — the same reach. */
    charge: (person, key, bytes, now, budget) => ledger.charge(person, key, bytes, now, budget),
    /* Stryker restore all */
    // Stryker disable next-line ArrowFunction: the clock, handed through.
    now: () => Date.now(),
    crypto: pageCrypto,
  }
}

/** This run's inputs for the service handlers. See `Running`. */
let running: Running | null = null

/** Everything the handlers read, over one run's services. */
interface RunningDeps {
  readonly fs: IndexFs
  readonly library: Library
  readonly writes: WriteQueue
  readonly clock: () => Hlc
  readonly warn: (event: string, detail: Record<string, unknown>) => void
  readonly hashes: () => HashPort | null
  readonly ledger: SpendLedger
  readonly settings: SettingsStore
  /**
   * The store's change signal, THIS RUN'S — handed in by `start`, which owns
   * the listeners, rather than read from the module slot: the factories below
   * are then functions of what they are given, and a test can hand them a
   * set of its own.
   */
  readonly onChanged: (listener: () => void) => () => void
  readonly changed: () => void
}

/**
 * What the service handlers read — the serving side, over one run's stores.
 * Its own factory, so what a friend is SERVED can be read apart from what
 * the reader's own surfaces are handed.
 */
function servingOver({ fs, library, writes }: Pick<RunningDeps, 'fs' | 'library' | 'writes'>): () => Serving {
  /* The same `books` array for the same shelf snapshot, so `indexOf` in
     `exchange.ts` finds its index built rather than building it per request.
     `getSnapshot` answers one array until the library changes. */
  let indexed: { readonly snapshot: ReturnType<Library['getSnapshot']>; readonly books: readonly BookLike[] } | null = null
  const booksNow = (): readonly BookLike[] => {
    const snapshot = library.getSnapshot()
    // Stryker disable next-line ConditionalExpression,EqualityOperator: a cache over one array's identity — with or without it, the same books are answered.
    if (indexed === null || indexed.snapshot !== snapshot) indexed = { snapshot, books: snapshot.map(bookLike) }
    return indexed.books
  }
  return (): Serving => ({
    books: booksNow(),
    shared: (bookId) => readShared(fs as VaultFs, bookId),
    seal: (bookId, sealed) =>
      /* ⚠️ **`library.lane`, NEVER A LANE DERIVED HERE.** `folderOf` is
       * MANY-TO-ONE, so a lane keyed on the raw id splits one directory across
       * two lanes — and a rekeyed book has to stay on the lane its earlier
       * writes are still draining on. `Library.lane` says so in as many words,
       * and `store.ts` already paid for deriving one.
       *
       * And a TRANSACTION, not a replacement: the boundaries were cut over the
       * log as it was read, and only they are written — a share that landed
       * on the file meanwhile is kept, and the boundaries still cover the
       * sequences they were sealed over. */
      // Stryker disable next-line ArrowFunction: the lane, handed through — the queue serialises on it; the tests' queue takes any.
      updateShared(fs as VaultFs, writes, (id) => library.lane(id), bookId, (current) => ({ ...current, sealed: sealed.sealed })).then(() => undefined),
    publisher: async (work) => {
      const port = publishPort()
      if (!port) return null
      const identity = await port.mine()
      return identity ? publisherFor(work, identity, port) : null
    },
    shelf: () => readOwnShelf(fs as VaultFs),
    /* Boundaries only, for `seal`'s reason. */
    sealShelf: async (held) => {
      await updateOwnShelf(fs as VaultFs, writes, (current) => ({ ...current, sealed: held.sealed }))
    },
    lists: async () => {
      const ids = await ownListIds(fs)
      return Promise.all(ids.map(async (id) => ({ id, held: await readOwnList(fs as VaultFs, id) })))
    },
    sealList: async (id, held) => {
      await updateOwnList(fs as VaultFs, writes, id, (current) => ({ ...current, sealed: held.sealed }))
    },
    /* The jacket the record's facts describe, read whole (WI-23.C5): a file
       that has gone, or changed size under its facts, answers null and the
       request is refused rather than served with the wrong bytes. */
    cover: async (bookId) => {
      const facts = library.getSnapshot().find((one) => one.bookId === bookId)?.coverFacts
      // Stryker disable next-line ConditionalExpression: a book with no facts publishes no digest, so no request ever names it; this spares a read.
      if (facts === undefined) return null
      const bytes = await (fs as VaultFs).readFile(`${folderOf(bookId)}/${facts.name}`).catch(() => null)
      return bytes === null ? null : { hash: facts.hash, size: facts.size, bytes }
    },
  })
}

/**
 * The reader's own side: the ports the surfaces are handed, and the drivers
 * that publish what the library and the reader change.
 */
/**
 * The share control's port and the opinion driver — WI-23.A1 and B4 — over
 * one run's stores. Its own factory: what the reader PUBLISHES, read apart
 * from what they are shown of others.
 *
 * ⚠️ **`services.clock`, NOT A CLOCK OF THIS CAPABILITY'S OWN.** One clock
 * per device — two could order one edit before the removal that preceded
 * it — and `Publication.at` is a stamp the stores' registers are compared
 * against. `KernelServices.clock` reads the bound slot, which is the sync
 * capability's HLC once it has started.
 */
function publicationOver({ fs, library, writes, clock, warn, onChanged }: RunningDeps, publisher: Running['publisher']): Pick<Running, 'sharing' | 'opinion'> {
  /* Stryker disable all: wiring — each line hands one store, port or prop through; the port's own tests hold the behaviour, and `index.peer.test.ts` holds that the seams reach the peer. */
  const sharing = sharePortOver({
    shared: (bookId) => readShared(fs as VaultFs, bookId),
    update: (bookId, transform) => updateShared(fs as VaultFs, writes, (id) => library.lane(id), bookId, transform),
    reachable: () => publishPort() !== null,
    device: async () => (await publisher())?.device ?? null,
    clock,
    mintPub: () => mintPub(),
    onChanged,
  })
  const opinion = opinionPortOver({
    books: () => library.getSnapshot(),
    changes: (listener) => library.subscribe(listener),
    patch: (bookId, fields) => library.patch(bookId, fields),
    failed: (cause) => warn('circle.opinion.publish-failed', { message: messageOf(cause) }),
    shared: (bookId) => readShared(fs as VaultFs, bookId),
    update: (bookId, transform) => updateShared(fs as VaultFs, writes, (id) => library.lane(id), bookId, transform),
    device: async () => (await publisher())?.device ?? null,
    clock,
    mintPub: () => mintPub(),
  })
  /* Stryker restore all */
  return { sharing, opinion }
}

/**
 * The Circle screen's reads — the roster's relationships, the friends'
 * files, their jackets, the purge — and the disclosure rule the shelf
 * service asks. WI-23.C2–C5, over one run's stores.
 */
function circleReadsOver({ fs, library, writes, clock, warn, ledger, settings, onChanged, changed }: RunningDeps): Pick<Running, 'circle' | 'discloses'> {
  // Stryker disable next-line ArrowFunction: the lane, handed through.
  const lane = (id: string) => library.lane(id)
  /** The person a calling device speaks for, by the rosters this side holds. */
  const personOf = async (device: string): Promise<string | null> => {
    const people = (await personPort()?.people()) ?? []
    /* A device on the roster AND not revoked from it: a revoked device
       still listed speaks for nobody, least of all for the shelf. */
    return people.find((one) => one.devices.includes(device) && !one.revoked.includes(device))?.person ?? null
  }
  const discloses = async (device: string): Promise<boolean> => {
    const person = await personOf(device)
    if (person === null) return false
    /* The switch, AND a relationship that still admits them: a record left
       with the switch on after a block is a record, not a disclosure. */
    const relationship = await readRelationship(fs as VaultFs, person)
    return acceptsTransport(relationship.state) && relationship.shelf
  }
  /* Stryker disable all: wiring — each line hands one store, port or prop through; the port's own tests hold the behaviour, and `index.peer.test.ts` holds that the seams reach the peer. */
  const covers = createCoverFetcher({
    fs: fs as VaultFs,
    dial: (device) => {
      const port = peerPort()
      if (!port) throw new Error('peer has not started')
      return port.connect(device)
    },
    charge: (person, bytes) => ledger.charge(person, 'cover', bytes, Date.now()),
    now: () => Date.now(),
    capBytes: () => settings.get(COVER_CAP_SETTING) * 1024 * 1024,
  })
  const circle = circlePortOver({
    clock,
    books: () => library.getSnapshot().map((book) => ({ ...bookLike(book), title: book.title })),
    people: async () => ((await personPort()?.people()) ?? []).map(({ person, displayName }) => ({ person, displayName })),
    relationship: (person) => readRelationship(fs as VaultFs, person),
    writeRelationship: (record) => writeRelationship(fs as VaultFs, writes, record),
    heldShelf: (person) => readHeldShelf(fs as VaultFs, person),
    heldOf: (bookId, person) => readForeign(fs as VaultFs, bookId, person),
    heldLists: (person) => readHeldLists(fs, person, warn),
    coverOf: (person, device, pub, digest, signal) => covers.ensure(person, device, pub, digest, signal),
    /* The jackets first — their index, and the fence on any still on their
       way — then the files: a fetch landing after the folder went would have
       put the folder back. */
    purge: async (person, books) => {
      await covers.purge(person)
      /* The trash too: a trashed book keeps the person's file, and a restore
         brings it back. Hidden by the exited record, but theirs. */
      const trashed = (await listTrash(fs as unknown as TrashFs)).map((one) => one.bookId)
      await purgePerson(fs, writes, lane, person, books, changed, trashed)
    },
    forgetPeer: async (person) => {
      await personPort()?.forgetPerson(person)
    },
    onChanged,
    warn,
  })
  /* Stryker restore all */
  return { circle, discloses }
}

/**
 * The reader's own shelf, brought up to the library — WI-23.C1's driver.
 *
 * One step on the shelf's lane — read, sync, write — so the library firing
 * on every page turn cannot interleave two passes on the one file, and a
 * pass that fails fails alone: the next one runs.
 */
function shelfPublisherOver({ fs, library, writes, clock, hashes }: RunningDeps, publisher: Running['publisher']): Running['publishShelf'] {
  const coverPass = createCoverFactsPass({ fs, library, hashes })
  return async () => {
    const mine = await publisher()
    if (!mine) return
    /* The jackets measured first, a few per pass (WI-23.C5): each stamp is a
       library change, which is another pass, until every jacket is measured
       and the shelf carries every digest it may. */
    await coverPass.runOnce()
    const books = library.getSnapshot().map(shelvedBook)
    await updateOwnShelf(fs as VaultFs, writes, (before) => syncShelf(before, books, mine.device, clock(), () => mintPub()))
  }
}

/** The reader's own lists — WI-23.E1. One per run, for `sharing`'s reason. */
function listsOver({ fs, library, writes, clock }: RunningDeps, publisher: Running['publisher']): Running['lists'] {
  /* Stryker disable all: wiring — each line hands one store, port or prop through; the port's own tests hold the behaviour, and `index.peer.test.ts` holds that the seams reach the peer. */
  return listsPortOver({
    ids: () => ownListIds(fs),
    read: (listId) => readOwnList(fs as VaultFs, listId),
    update: (listId, transform) => updateOwnList(fs as VaultFs, writes, listId, transform),
    books: () => library.getSnapshot().map(shelvedBook),
    device: async () => (await publisher())?.device ?? null,
    clock,
    mintPub: () => mintPub(),
  })
  /* Stryker restore all */
}

/**
 * One run's services, COMPOSED — each made by its own factory above, so what
 * the reader publishes, what they are shown, and what they are served can be
 * read and tested apart. Nothing here reads a module slot: the change signal
 * comes in through `deps`.
 */
function runningOver(deps: RunningDeps): Running {
  const serving = servingOver(deps)
  const publisher = () => serving().publisher(EMPTY_WORK)
  const { sharing, opinion } = publicationOver(deps, publisher)
  const publishShelf = shelfPublisherOver(deps, publisher)
  const { circle, discloses } = circleReadsOver(deps)
  const lists = listsOver(deps, publisher)
  /* What waited on an identity: the shelf, and the opinions whose switch is
     on — EACH ON ITS OWN, so a shelf that would not publish does not keep
     the opinions unpublished. Then everyone who asks whether they can
     publish is told, whatever failed: a share control saying "Start a
     circle" over an identity that exists is the state this signal ends. */
  const identityChanged = async (): Promise<void> => {
    const [shelf, opinions] = await Promise.allSettled([publishShelf(), opinion.warm()])
    deps.changed()
    if (shelf.status === 'rejected') deps.warn('circle.shelf.publish-failed', { message: messageOf(shelf.reason) })
    if (opinions.status === 'rejected') deps.warn('circle.opinion.warm-failed', { message: messageOf(opinions.reason) })
  }
  return { publisher, serving, sharing, opinion, discloses, circle, lists, publishShelf, identityChanged }
}

/** What a book says about the work it is — the claim's inputs, in clear, absent when the book says nothing. */
function named(book: IndexedBook): { title?: string; author?: string; identifier?: string; languages?: readonly string[] } {
  const { title, author, identifier, languages } = book
  /* Spread rather than field-by-field: `exactOptionalPropertyTypes` makes an
     explicit `undefined` a different thing from an absent key, and `claimFor`
     reads absence. */
  /* Stryker disable ConditionalExpression: an explicit undefined reads as absence in every reader of this (`workOf`, `claimFor`); the spread keeps the type honest under `exactOptionalPropertyTypes`. */
  return {
    ...(title === undefined ? {} : { title }),
    ...(author === undefined ? {} : { author }),
    ...(identifier === undefined ? {} : { identifier }),
    ...(languages === undefined ? {} : { languages }),
  }
  /* Stryker restore ConditionalExpression */
}

/** A shelf row as the published shelf names it. */
function shelvedBook(book: IndexedBook): { bookId: string; cover?: string } & ReturnType<typeof named> {
  const cover = publishableCover(book)
  return { bookId: book.bookId, ...named(book), ...(cover === undefined ? {} : { cover }) }
}

/**
 * A claim for a work nothing will match — the hello has no book in hand.
 *
 * The hello only needs the person id, which every publisher carries whatever
 * work is named. Passing a real claim would suggest the answer depended on one.
 */
const EMPTY_WORK: Publisher['work'] = { ids: [], titles: [], author: '', language: '' }

/** A shelf row, as far as naming the work goes. */
function bookLike(book: IndexedBook): BookLike {
  return { id: book.bookId, ...named(book) }
}

/**
 * Tell the reader's open book that what is shared has changed.
 *
 * ⚠️ **THE LISTENERS WERE ADDED, REMOVED AND CLEARED, AND NEVER CALLED.**
 * `OverlayContribution.subscribe` is the seam's whole answer to *"a share
 * arriving mid-session can neither appear nor disappear"* — a signal the kernel
 * re-asks `forBook` on. A subscription nothing can fire is that promise made
 * and not kept: every passage landing after the book opened would have waited
 * for some unrelated redraw.
 *
 * Exported and REQUIRED by the store's writers rather than left as a
 * convention: `writeForeign` and `purgeForeign` take it as an argument, so a
 * future transport cannot land a page and forget to say so — the same reason
 * `checkPage` takes `maySpeak` as a required parameter instead of looking it up.
 */
export function circleChanged(): void {
  /* Each on its own — one surface failing to react, or rejecting, must not
     stop the others hearing. */
  if (held) tellEach(held.listeners, 'circle')
}
