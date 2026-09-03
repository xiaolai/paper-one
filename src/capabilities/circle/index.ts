import {
  canonicalJson,
  drawable,
  overlayKey,
  type Capability,
  type CapabilityContext,
  type Disposable,
  type ForeignAnnotation,
  type ForeignEntry,
  type IndexFs,
  type IndexedBook,
  type Library,
  type OverlayRequest,
  type ResolvedPassage,
  type VaultFs,
  type WriteQueue,
} from '../../kernel'
import { createElement } from 'react'
import { peopleFor, readForeign } from './lib/store'
import { answerPages, welcome, type BookLike, type Serving } from './lib/exchange'
import { readShared, writeShared, type Publisher } from './lib/publish'
import { CIRCLE_SERVICES } from './lib/protocol'
import { personPort, publishPort } from '../peer'
import { CirclePane } from './ui/CirclePane'

/**
 * The `circle` capability — passages other readers shared, drawn in your book.
 *
 * ## What it does today, stated plainly
 *
 * ⚠️ **IT READS AND DRAWS; IT DOES NOT YET RECEIVE.** The store, the overlay
 * seam and the anchoring are here and working. What is missing is the
 * TRANSPORT — no page crosses a socket, because
 * `docs/design/circle/wire.md`'s format is fixed the moment one does, and the
 * plan gates that on Stage A shipping. Drop a file into
 * `<book>/circle/<person>.json` and it draws; nothing else fills that file yet.
 *
 * That is a deliberate half, not an oversight, and it is the half that can be
 * changed the week after it ships.
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
  /**
   * The current relationship epoch per person, where one is known.
   *
   * ⚠️ **ABSENT MEANS "THE FILE IS THE RECORD", AND THAT IS AN INTERIM WITH A
   * STATED END.** `relationships.md` says a foreign entry is drawn only when
   * its epoch matches the relationship's — which is what stops a re-admitted
   * person's old passages reviving. That needs a relationship STORE, and
   * WI-22.E1's store is not built.
   *
   * Until it is, an entry on disk is trusted the way `marks.json` is trusted:
   * only the transport writes these files, and only for an admitted person.
   * The first version of this required a record and had none, so the capability
   * filtered out every entry and drew nothing at all — a feature that is
   * silently inert, which is the shape this repository keeps having to remove.
   *
   * When the relationship store lands, this map is filled from it and the
   * default flips to refusing: a person with no record is somebody you have not
   * admitted.
   */
  readonly epochs: Map<string, number>
  readonly listeners: Set<() => void>
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
async function entriesFor(fs: IndexFs, bookId: string): Promise<readonly ForeignEntry[]> {
  const out: ForeignEntry[] = []
  for (const person of await peopleFor(fs, bookId)) {
    try {
      out.push(...(await readForeign(fs, bookId, person)).entries)
    } catch (cause) {
      console.warn(`Paper: could not read ${person}'s shared passages for this book`, cause)
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
  const entries = await entriesFor(held.fs, request.bookId)
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

  return drawable(
    anchored,
    /* No roster yet, so the person's own id is the only name there is. It is
       shown as a claim and never as a name Paper has checked — see
       `surfaces.md` on the displayed name. */
    (person) => person,
    (person, epoch) => {
      const current = held.epochs.get(person)
      /* No record yet: the file is the record. See `Held.epochs`. */
      return current === undefined || current === epoch
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
function served(): { hello: (r: unknown) => Promise<unknown>; pages: (r: unknown) => Promise<unknown> } {
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
  }
}

/** What the handlers read, gathered once at `start`. */
interface Running {
  readonly publisher: () => Promise<Publisher | null>
  readonly serving: () => Serving
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
function publisherFor(work: Publisher['work'], mine: PagePublisherLike): Publisher {
  return {
    person: mine.person,
    device: mine.device,
    work,
    roster: [...mine.roster],
    revocations: mine.revocations,
    delegation: canonicalJson(mine.delegation),
    sign: async (message) => {
      /* Read at the moment of signing, not captured: a teardown between
         building the page and signing it must fail loudly rather than sign
         through a port the run no longer owns. */
      const port = publishPort()
      if (!port) throw new Error('this device cannot sign — peer has not started')
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
  ],
  screens: [
    {
      id: 'circle:circle',
      label: 'Circle',
      render: () => createElement(CirclePane, { port: personPort(), devices: deviceCount() }),
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
      ? { fs: fs as IndexFs, epochs: new Map(), listeners: new Set() }
      : null
    held = mine
    running = mine ? runningOver(mine.fs, ctx.services.library, ctx.services.writes) : null
    const ours = running
    return {
      dispose: () => {
        mine?.listeners.clear()
        if (held === mine) held = null
        /* Guarded for the reason `held` is: an overlapping restart must not
           have the OLD disposable take the NEW run's services away. */
        if (running === ours) running = null
      },
    }
  },
}

/** This run's inputs for the service handlers. See `Running`. */
let running: Running | null = null

/** Everything the handlers read, over one run's services. */
function runningOver(fs: IndexFs, library: Library, writes: WriteQueue): Running {
  const serving = (): Serving => ({
    books: library.getSnapshot().map(bookLike),
    shared: (bookId) => readShared(fs as VaultFs, bookId),
    seal: (bookId, sealed) =>
      /* ⚠️ **`library.lane`, NEVER A LANE DERIVED HERE.** `folderOf` is
       * MANY-TO-ONE, so a lane keyed on the raw id splits one directory across
       * two lanes — and a rekeyed book has to stay on the lane its earlier
       * writes are still draining on. `Library.lane` says so in as many words,
       * and `store.ts` already paid for deriving one. */
      writeShared(fs as VaultFs, writes, (id) => library.lane(id), bookId, sealed),
    publisher: async (work) => {
      const port = publishPort()
      if (!port) return null
      const identity = await port.mine()
      return identity ? publisherFor(work, identity) : null
    },
  })
  return { publisher: () => serving().publisher(EMPTY_WORK), serving }
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
  /* Spread rather than field-by-field: `exactOptionalPropertyTypes` makes an
     explicit `undefined` a different thing from an absent key, and `claimFor`
     reads absence. */
  const { bookId, title, author, identifier, languages } = book
  return {
    id: bookId,
    ...(title === undefined ? {} : { title }),
    ...(author === undefined ? {} : { author }),
    ...(identifier === undefined ? {} : { identifier }),
    ...(languages === undefined ? {} : { languages }),
  }
}

/**
 * How many of this reader's OWN devices are paired.
 *
 * ⚠️ **ZERO IS NOT "ONE" AND MUST NOT BE ROUNDED UP.** The custody marker
 * fires at `devices <= 1`, so a wrong answer here is the difference between a
 * reader being told their circle is at risk and being told nothing. The peer
 * capability owns the real count; until this reads it, the honest answer is the
 * one that shows the marker — a false alarm is recoverable and a missed one is
 * a lost identity.
 */
function deviceCount(): number {
  return 1
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
  /* A copy, because a listener may unsubscribe while being told. */
  for (const listener of [...(held?.listeners ?? [])]) {
    try {
      listener()
    } catch (cause) {
      /* One surface failing to react must not stop the others hearing. */
      console.warn('Paper: a circle listener could not be told', cause)
    }
  }
}
