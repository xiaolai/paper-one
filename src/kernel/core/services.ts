import { messageOf } from './messageOf'
import type { PublicPassage } from './public/envelope'
import type { IndexFs, IndexedBook } from './bookIndex'
import type { Disposable, ServiceContribution } from './capability'
import { createCards, type CardStorage, type Cards } from './cardStore'
import { type Hlc, compareHlc, deviceOf, laterHlc, makeHlc, parseHlc, ZERO_DEVICE, HLC_MAX_COUNTER } from './hlc'
import { createLibrary, type Library } from './libraryStore'
import { createMarkStore, type MarkStore } from './markStore'
import { folderOf, readBook, recordPath } from './bookFolder'
import {
  NOOP_DIAGNOSTICS,
  NOOP_RECORDER,
  REMOVABLE_BLOB_KINDS,
  REMOVABLE_BLOB_NAMES,
  recorded,
  type DevicePort,
  type Diagnostics,
  type MutationRecorder,
  type MutationToken,
  type RemovableBlobName,
  type SettingsStore,
  type ShelfPort,
  type HashPort,
  type SizePort,
  type SpeechEnginePort,
} from './ports'
import { carryLegacySettings, createSettingsStore, type SettingsMigration } from './settings'
import { writeQueue, type WriteQueue } from './writeQueue'

/**
 * The kernel's services, built together — because they share things that
 * must be ONE.
 *
 * The write queue above all: a book's record and its marks are two files in
 * one folder, and two queues meant a write to one could not see a write to
 * the other, which is how a mark landed in a folder a removal had just moved.
 * One queue keyed by book makes every write touching a book serial, and gives
 * the window something to wait for when it closes (`drain`).
 *
 * This is what a composition root builds once and hands to the UI — and, in
 * time, to every capability's `start`. The hooks in `ui/hooks` are adapters
 * over these instances; nothing else holds the shelf, the marks or the cards.
 */
export interface KernelServices {
  readonly library: Library
  readonly marks: MarkStore
  readonly cards: Cards
  readonly settings: SettingsStore
  readonly diagnostics: Diagnostics
  /** The one queue every folder write goes through. */
  readonly writes: WriteQueue
  /**
   * Whether `initialBooks` is the shelf, or a stand-in for one nobody read.
   *
   * The composition root opens the window on an empty snapshot when the index
   * will not load — not opening at all would be worse — and the kernel had no
   * way to tell that from a library with no books in it. So every consumer
   * that counts the snapshot answered "0 books" for "the shelf could not be
   * read", including `shelf.status`, which is the service a peer uses to
   * decide whether this device is healthy.
   *
   * A function rather than a field for the same reason the ports are: it is
   * the composition root's knowledge, not the store's.
   */
  readonly shelfRead: () => boolean
  /**
   * The library's filesystem, or null outside Tauri — exposed for a
   * capability that READS the folders the kernel writes (the sync journal
   * digests a book's current state; `readBook`/`readMarks` take an fs).
   * The write paths stay behind the stores.
   */
  readonly fs: IndexFs | null
  /** The flat store, or null. Same audience and same caveat as `fs`. */
  readonly storage: CardStorage | null
  /**
   * Delete ONE closed-name blob from a book's folder — the delete twin of
   * the peer plugin's landing (WI-10.2). The folder comes from the book id
   * (`folderOf`, so a hostile id cannot name a path), the name must sit in
   * the closed set (`content.<ext>` | `cover.jpg` | the legacy, evict-only
   * `cover.webp`), and anything else — `book.json`, a `../` escape — throws.
   * This is the ONLY way anything outside the kernel deletes inside
   * `books/<id>/`: a capability's own fs handle is namespace-confined
   * (WI-10.3) and cannot reach there at all. A no-op without a filesystem,
   * and for a blob that is not there — removing what is absent is done.
   */
  removeBlob(bookId: string, name: RemovableBlobName): Promise<void>
  /**
   * Bind the mutation-recorder port — the sync journal, at composition.
   *
   * LATE-BOUND, and that is the point: the services must exist before any
   * capability starts (a `start` receives them), so a port implemented BY a
   * capability can only arrive after construction. The stores hold a
   * delegating recorder from birth; this swaps its target. Binding while
   * already bound throws — two journals bracketing one write queue would be
   * two truths — and everything recorded before the bind went to the previous
   * target (the no-op default), which is exactly the pre-journal state the
   * journal's own bootstrap and verify pass exist to square.
   *
   * Returns an idempotent disposer that RESTORES the previous target and
   * frees the slot to be bound again. The sync capability disposes it before
   * it closes the journal, so a torn-down sync never leaves the stores
   * writing into a closed journal, and the same services can be re-composed.
   */
  bindRecorder(recorder: MutationRecorder): Disposable
  /**
   * Bind the stamp clock — the sync capability's HLC, at composition. Same
   * shape, same once-at-a-time rule, and the same restoring disposer as
   * `bindRecorder`. Until bound, stamps are the legacy wall clock under the
   * zero device (`hlcOf`), which is enough with no sync composed.
   *
   * `witness`, when the clock has one, is how the port tells it a floor: a clock
   * bound behind the newest stamp already handed out is told that stamp and
   * asked again, so the clock's own persisted floor learns it (`flooredClock`).
   */
  bindClock(clock: () => Hlc, witness?: (stamp: Hlc) => void): Disposable
  /**
   * A stamp from THE clock — the one every store stamps with.
   *
   * ⚠️ **ONE CLOCK PER DEVICE, so a capability that mints a stamp asks here
   * rather than keeping a clock of its own.** The option's note says why in
   * as many words: two clocks on one device could order one edit before the
   * removal that preceded it. The circle stamps what it publishes with an
   * HLC (`Publication.at`), and a second clock beside the stores' would be
   * exactly that second clock. Reads through the bound slot, so it is the
   * sync capability's HLC once bound and the legacy wall clock before.
   */
  clock(): Hlc
  /**
   * Bind the SERVICE HOST — the peer transport, at composition. A shelf serves
   * the capabilities' contributed `services` over the peer router; the host is
   * what turns a `ServiceContribution` set into served, grant-gated handlers.
   * Late-bound like the recorder, and — unlike it — NOT once-at-a-time: every
   * transport binds its own host (the peer plugin, and the browser client's
   * webhost beside it), and `serveServices` hands the composed set to each. The
   * disposer removes THIS binding and no other, and is idempotent; there is no
   * previous target to restore. Until bound (a browser tab, a satchel with no peer plugin, every
   * test that composes without `peer`) the default hosts NOTHING — replication
   * is the spine and services are enhancement, so an unbound host is not an
   * error, it is the offline case.
   */
  bindServiceHost(host: ServiceHost): Disposable
  /**
   * Bind the PRIVATE-AUDIENCE port — what this reader has already sent to an
   * audience that is not the public one. The circle binds it at composition.
   *
   * ⚠️ **THIS EXISTS BECAUSE THE STRONGEST PRIVACY WARNING IN THE APP COULD
   * NEVER FIRE.** `linksVoiceToPerson` detects a reader about to publish, under
   * a pseudonym, words they have already shared with their circle — identical
   * quote, prefix and suffix, so anybody in both audiences can match them and
   * learn who the pseudonym is. It was written, tested, and handed an empty
   * list by the only caller in the running app, so it always answered `false`.
   * Found by audit, and it is the third rule in this phase to be reachable only
   * from its own tests.
   *
   * ⚠️ **A PORT RATHER THAN A `requires`, BECAUSE iOS COMPOSES `public` WITHOUT
   * `circle`.** Making public depend on circle would break that build, and it
   * would be false besides: a reader with no circle has shared nothing
   * privately, so the empty default is the RIGHT answer there rather than a
   * degraded one. This is the same shape as `bindServiceHost` for the same
   * reason — a capability's knowledge, offered to another that must not import
   * it, with an honest default when nobody offers.
   *
   * Returns the same restoring, idempotent disposer as the other binders.
   */
  bindPrivateAudience(port: PrivateAudience): Disposable
  /**
   * The passages this reader has already shared privately for one book.
   *
   * Empty when nothing is bound, which is every build with no circle and every
   * reader who has shared nothing.
   *
   * ⚠️ **ASYNC, BECAUSE THE ANSWER IS ON DISK.** The circle keeps this in a
   * file per book; a synchronous port would force it to hold a cache whose only
   * consumer is this, and a stale cache here understates the warning — which is
   * the one direction this must not fail in. The disclosure is a step the
   * reader opens, so there is a moment to load it in.
   */
  sharedPrivately(bookId: string): Promise<readonly PublicPassage[]>
  /**
   * Bind the DEVICE port — the peer capability's view of who is paired
   * (phase 11). Late-bound and once-at-a-time like the recorder, with the
   * same restoring disposer. Until bound, `devices()` is null and `device.*`
   * refuses `unsupported` by name rather than answering an empty list.
   */
  bindDevicePort(port: DevicePort): Disposable
  /** The bound device port, or null. Read at CALL time by every `device.*`
   *  handler, so a port bound during a capability's `start` reaches services
   *  that were built before it. */
  devices(): DevicePort | null
  /**
   * Bind the SHELF port — the role, the endpoint, and the journal's head and
   * epoch (phase 11). Same rules as `bindDevicePort`.
   */
  bindShelfPort(port: ShelfPort): Disposable
  shelf(): ShelfPort | null
  /**
   * Bind the SIZE port — bytes on disk, which only a host can measure
   * (phase 11). Bound by a host rather than by a capability, and otherwise
   * the same slot as the two above.
   */
  bindSizePort(port: SizePort): Disposable
  sizes(): SizePort | null
  /**
   * Bind the SPEECH ENGINE port — the downloadable voices, by the `voices`
   * capability. The same slot rule again: a host without one leaves it null,
   * and every reader answers "no voice" rather than failing, which is what a
   * browser client and a phone get.
   */
  bindSpeechEngines(port: SpeechEnginePort): Disposable
  speechEngines(): SpeechEnginePort | null
  /** Bind the HASH port — BLAKE3 in Rust, by the peer capability. The same slot rule as the size port. */
  bindHashPort(port: HashPort): Disposable
  hashes(): HashPort | null
  /**
   * Serve a composed set of services through the bound host, once every
   * capability has started (so a delegating handler's target is ready). The
   * registry calls this with `Composition.services`; the returned `Disposable`
   * unserves them and rides the composition's teardown. With no host bound it
   * resolves to a no-op — nothing is served, nothing throws.
   */
  serveServices(services: readonly ServiceContribution[]): Promise<Disposable>
  /**
   * Resolves when nothing is in flight — the index flushed, the queue idle AND
   * the flat store flushed. For the one moment that cannot be deferred: the
   * window closing. Every stage is attempted even when an earlier one fails;
   * the failures are raised afterwards.
   */
  drain(): Promise<void>
}

/**
 * What the peer capability binds to turn contributed services into served
 * handlers: given the composed set, decide by role (a satchel serves nothing)
 * and hand back a `Disposable` that unserves. Async because the role and the
 * transport are.
 */
export type ServiceHost = (services: readonly ServiceContribution[]) => Disposable | Promise<Disposable>

/**
 * What a reader has already sent to a private audience — see
 * {@link KernelServices.bindPrivateAudience}.
 *
 * ⚠️ **ASYNC, AND THIS PARAGRAPH SAID "Synchronous".** The signature is
 * `Promise<…>` and `bindPrivateAudience`'s own doc says why — the answer is on
 * disk. The reasoning quoted here (a control that renders before it knows what
 * to warn about) is the reason the CALLER must handle the pending state, not a
 * description of the type, and reading it as the latter would have somebody
 * write `audience(bookId).length`.
 */
export type PrivateAudience = (bookId: string) => Promise<readonly PublicPassage[]>

export interface KernelServicesOptions {
  /** The library's filesystem, or null outside Tauri. */
  readonly fs: IndexFs | null
  /** The flat store — cards and settings. Null outside any storage at all. */
  readonly storage: CardStorage | null
  /** The shelf as read at boot, so no frame renders an empty library. */
  readonly initialBooks?: readonly IndexedBook[]
  /**
   * Whether `initialBooks` came from a shelf that was actually read.
   *
   * Defaults to `true`, which is right for every caller that HAS the books —
   * a test, a satchel, a fresh library. The composition root passes `false`
   * when `loadShelf` threw, so nothing downstream reports an unreadable shelf
   * as an empty one.
   */
  readonly shelfRead?: boolean
  readonly recorder?: MutationRecorder
  readonly diagnostics?: Diagnostics
  readonly settingsMigration?: SettingsMigration
  /**
   * ONE clock for every store's stamps (`updatedAt`, `deletedAt`, presence)
   * — one, because two clocks on one device could order one edit before the
   * removal that preceded it. Absent, each store uses the legacy wall clock
   * until `bindClock` supplies the sync capability's HLC.
   */
  readonly clock?: () => Hlc
}

/**
 * ONE exclusive-binding slot — the bind-once rule, the identity-guarded
 * restore, and the bound flag, stated once. It lived as three hand-rolled
 * copies (recorder, clock, service host), and the same defect had been
 * pasted into each: a STALE disposer cleared the bound flag it no longer
 * owned, so firing it after a re-bind let a second simultaneous binding in.
 * Here the flag and the target move together, only under the disposer that
 * still owns the active binding.
 */
function exclusiveSlot<T>(
  alreadyBound: string,
  fallback: T,
): { get(): T; bind(next: T): Disposable; generation(): number } {
  let target = fallback
  /* Bumped on every bind AND every unbind, so "the binding that issued this"
   * is answerable later without holding a reference to the value itself. Used
   * by the recorder port; harmless for the slots that ignore it. */
  let generation = 0
  /* Ownership is a fresh token per bind, not the bound value's identity:
   * binding the SAME object twice is legal (dispose, then bind again), and
   * an identity guard would let the first binding's stale disposer unbind
   * the second. Null means unbound. */
  let owner: object | null = null
  return {
    get: () => target,
    generation: () => generation,
    bind: (next) => {
      if (owner !== null) throw new Error(alreadyBound)
      const token = {}
      owner = token
      target = next
      generation += 1
      return {
        /* Idempotent: a disposer that no longer owns the binding — re-bound
         * since, or already run — changes nothing. */
        dispose: () => {
          if (owner !== token) return
          target = fallback
          owner = null
          generation += 1
        },
      }
    },
  }
}

/**
 * The recorder every store writes through, routing each commit to whichever
 * binding issued its begin.
 *
 * Its own function because it is a POLICY, not wiring: three cases, each with
 * a different right answer, and the reasoning below is why. Inline among
 * thirty other `const`s it read as setup, and the one time it was changed the
 * change was made without the third case in view.
 */
function routedRecorder(
  slot: { get(): MutationRecorder; generation(): number },
  fallback: MutationRecorder,
): MutationRecorder {
  /**
   * Which binding issued each token, held BESIDE the token rather than on it.
   *
   * ⚠️ **THE TOKEN USED TO BE CLONED.** `{ ...token, [BINDING]: at }` returns a
   * different object from the one the recorder minted, which breaks every
   * recorder whose token is more than a bag of enumerable fields: one that keys
   * a `Map` by identity, one that hands back a class instance with a prototype,
   * one with a non-enumerable id. Each would be handed something it did not
   * issue and would rightly refuse to commit it — after the file write, so the
   * mutation is durable, unjournalled, and reported as a failure.
   *
   * `MutationToken` is an interface, so the kernel does not get to assume the
   * shape behind it. A `WeakMap` records the generation and the issuer without
   * touching the value, and the token that reaches `commit` is byte-for-byte
   * the one `begin` returned.
   *
   * PER RECORDER PORT, not module-wide. Token uniqueness is not something
   * `MutationRecorder` promises, so a recorder that reused one token object
   * across two `KernelServices` instances had each overwriting the other's
   * routing generation in a shared map. Weak, so an entry dies with its
   * token — a bracket left open by a crash must not pin one forever.
   */
  const issuedAt = new WeakMap<MutationToken, { readonly at: number; readonly by: MutationRecorder }>()
  /* A COMMIT GOES TO THE RECORDER THAT ISSUED ITS BEGIN, OR TO NOBODY — never
   * to a recorder that did not issue it.
   *
   * The first rule here was "each end resolves the current slot", and its
   * reasoning still holds for the case it was written for: an UNBIND between
   * begin and commit must not reach the issuing journal, which may have CLOSED.
   * Routing a commit back to its issuer regardless, tried before that, turned a
   * recoverable gap into a rejected write whose bytes were already down.
   *
   * A REBIND — unbind then bind, which is every capability reload — was the
   * second case: "resolve the current slot" handed a different, live journal a
   * token it never issued, and it rejected it after the file write had landed.
   *
   * ⚠️ **AND THE FIX FOR THAT SENT THE TOKEN TO THE DEFAULT, WHICH NEVER ISSUED
   * IT EITHER.** That was harmless only while the default was the no-op; a
   * composition that passes a real recorder as `recorder` got the same foreign
   * token and the same rejection after the write. Measured with an identity-
   * checking default. Found by audit.
   *
   * So there are three answers, and the entry tells them apart. The issuing
   * binding still bound (same generation): commit to it. Issued by the DEFAULT:
   * commit to the default, which is never unbound and so never closes, however
   * often the slot has moved since. Issued by a binding that has since been
   * RETIRED: commit to nobody. The old journal keeps a dangling begin, which is
   * exactly what a crash leaves and what its launch recovery settles — and no
   * other recorder is handed something it did not issue. A token this port has
   * no entry for was issued by nobody it knows, and gets the same answer. */
  return {
    begin: async (book, what) => {
      const at = slot.generation()
      const by = slot.get()
      const token = await by.begin(book, what)
      /* THE RECORDER'S OWN OBJECT, UNTOUCHED — see `issuedAt`. */
      issuedAt.set(token, { at, by })
      return token
    },
    commit: (token: MutationToken, digest?: string) => {
      const issued = issuedAt.get(token)
      /* A TOKEN THIS PORT HAS NO ENTRY FOR gets the retired bracket's answer:
         commit to nobody. Asked as `issued === undefined` on a line of its own,
         which decided nothing this one does not — neither arm can match an
         entry that is not there, `at` being a number and `by` an object. */
      // Stryker disable next-line OptionalChaining: with no entry the arms answer `undefined === <number>` and `undefined === <the fallback>`, which is the same nobody.
      if (issued?.at === slot.generation() || issued?.by === fallback) return issued.by.commit(token, digest)
      return Promise.resolve()
    },
  }
}

/** What `removeBlob` needs of the services being built around it. */
interface BlobRemoval {
  readonly library: Library
  readonly recorder: MutationRecorder
}

/**
 * Delete one blob from a book's folder — the kernel's ONE door into
 * `books/<id>/`.
 *
 * Its own function because it is an OPERATION, not composition: a closed name
 * set, an ownership check against the shelf, a lane, a journal bracket and an
 * idempotent delete, each with a reason that has to be read together. It sat
 * inline among thirty bindings, where it was by some distance the longest
 * thing in `createKernelServices` and the only one that did any work.
 */
async function removeBlob(
  { library, recorder }: BlobRemoval,
  bookId: string,
  name: RemovableBlobName,
): Promise<void> {
    if (!REMOVABLE_BLOB_NAMES.has(name)) {
      throw new Error(`removeBlob: ${JSON.stringify(name)} is not a blob the kernel removes`)
    }
    /* NO FILESYSTEM IS THE LANE'S NO-OP, NOT A CHECK OF ITS OWN. This returned
     * early on `!fs`, ahead of a lane — `library.updateAfter` — that answers
     * nothing without one and never runs a hook, so the early return decided
     * nothing the lane had not already decided. The refusal of a name above
     * still comes first, filesystem or none. */
    /* ⚠️ **AN ALIAS MUST NOT REACH ANOTHER BOOK'S FOLDER.** `folderOf`
     * sanitises an id into `books/<safeId>` — a slash, a dot, anything
     * outside [A-Za-z0-9] becomes `_` — which stops traversal and does NOT
     * stop collision: it is many-to-one, so `book:a/b` and `book:a_b` are two
     * ids over one directory. A caller holding the first could delete the
     * second's content or jacket, and every check here passed it.
     *
     * The shelf is the authority on which id owns a folder. An id the shelf
     * does not hold at all is left alone — that is an already-removed book,
     * and absence is this operation's documented no-op — but an id whose
     * folder belongs to a DIFFERENT, live book is refused rather than
     * quietly honoured. */
    /* ANY row on the folder that is not this id refuses — not the FIRST row
     * found. A snapshot holding both the requested id and a colliding alias
     * (a corrupt index, a caller-supplied initial set) let ordering decide
     * whether the shared blob could be deleted. */
    /* AND FOLDED, because the filesystem folds: on macOS's default volume
     * `books/Book_A` and `books/book_a` are one directory, so a row spelled
     * the other way round owns these very bytes. Compared exactly, the guard
     * looked straight past it. `book.add` and the store's lane key fold for
     * the same reason. */
    // Stryker disable next-line MethodExpression: `folderOf` answers ASCII letters, digits, `_` and `/` alone, so folding either way groups exactly the same names.
    const owner = (id: string) => folderOf(id).toLowerCase()
    const mine = owner(bookId)
    const claimant = () => library.getSnapshot().find((one) => owner(one.bookId) === mine && one.bookId !== bookId)
    /* `folderOf` sanitises the id into `books/<safeId>` — a slash, a dot,
     * anything outside [A-Za-z0-9] becomes `_` — so the joined path cannot
     * leave the book's folder whatever the id says. And the delete runs
     * INSIDE the book's queued task, like every other folder mutation: a
     * remove racing a landing or a folder move is the exact interleaving
     * the one-queue rule exists to prevent, and within the task the
     * exists/remove pair is atomic, so two concurrent removes both resolve
     * as the documented absent-blob no-op. */
    /* THE FOLDER'S LANE, not the id's — `library.lane`, the same resolver
     * the record, mark and move writers use.
     *
     * This queued on the raw `bookId` while writing to `folderOf(bookId)`,
     * and `folderOf` is MANY-TO-ONE: `book:a/b` and `book:a_b` are two ids
     * and one directory, so they took two lanes over the same files and a
     * delete could interleave with a landing or a folder move. The comment
     * below already claimed this ran "inside the book's queued task, like
     * every other folder mutation" — it was the one that did not. */
    /* RECORDED, like every other folder mutation.
     *
     * A blob deletion changed the folder and journalled nothing, so a crash
     * between the unlink and whatever the caller did next left the bytes
     * gone with no entry saying so — invisible to the feed and to the
     * unclean-shutdown verify pass. The kind follows the name: a cover is a
     * `cover` mutation, everything else is `content`. */
    /* THE SURFACE COMES FROM THE ONE MAP — see `REMOVABLE_BLOB_KINDS`. It
     * was spelled out here as a second policy, so a removable cover name
     * added to the closed set would have been journalled as `content` and
     * told every peer the book's bytes had changed. */
    const kind = REMOVABLE_BLOB_KINDS[name]
    /* ⚠️ **THE UNLINK AND THE FACTS IN ONE LANE TASK** — `updateAfter`. Two
       tasks — the unlink, then a record change queued after it — left a gap
       a stamp could land in: a jacket landed again under this name between
       the two had its fresh facts erased by the cleanup. And a recorder
       commit that failed after the unlink used to throw past the cleanup
       altogether, leaving facts describing a file that was not there. The
       hook runs inside the lane, before the record write, and says whether
       the record follows; a refusal by another book's claim, and a recorder
       failure after the bytes left, are raised once the lane is done. */
    let claimedBy: string | null = null
    let unreadable: Error | null = null
    let deletable = false
    await library.updateAfter(
      bookId,
      {
        before: async (target) => {
          /* ⚠️ **ASKED INSIDE THE LANE, where the answer cannot go stale.** The
           * shelf was read before the queue was joined — a check-then-act across
           * a lane boundary — so an add or a rekey already queued for this folder
           * could claim it while the deletion waited its turn, and the delete
           * then ran against a snapshot describing a book that no longer owned
           * these bytes. This is the same repair `AddGuard.fresh` and
           * `RestoreGuard` are: the scan is the diagnosis, the lane is the
           * decision. */
          /* RESOLVED INSIDE THE LANE, beside the ownership check it belongs with:
           * a rekey queued ahead of this may have moved the book, and then the
           * folder this id names either belongs to the new id — refused below —
           * or no longer holds the bytes, which the exists check reads as the
           * documented absent no-op. An id no longer on the shelf still clears
           * its orphaned folder: that is the no-op the contract promises. */
          const other = claimant()
          if (other !== undefined) {
            claimedBy = other.bookId
            return 'refuse'
          }
          /* ⚠️ CHECKED BEFORE ANY BRACKET IS OPENED. An absent blob is the
           * documented no-op, and opening a bracket around it wrote a
           * committed mutation for a change that did not happen: the journal
           * advanced, the feed carried an entry, and the verify pass had one
           * more surface to digest — all for a file that was already gone.
           *
           * EXISTS-THEN-REMOVE IS ATOMIC ONLY AGAINST THIS QUEUE, and another
           * PROCESS can still take the file in between — so a remove that races
           * one is an ordinary absence, not a fault. Both checks are inside the
           * queued task, so the pair is still atomic against everything else
           * touching this folder. */
          if (!(await target.exists(`${folderOf(bookId)}/${name}`))) return 'refuse'
          /* THE RECORD, READ WHERE THE WRITE HAPPENS — BEFORE THE BYTES GO. One
             that is there and will not read cannot have its facts cleared, and
             a jacket deleted under it would leave facts for a file that is
             gone: refused, and said. An absent record is an orphaned folder,
             whose blob the contract still clears. */
          const record = await readBook(target, bookId)
          if (record === null && (await target.exists(recordPath(bookId)))) {
            unreadable = new Error(`removeBlob: book.json for ${bookId} is there but could not be read`)
            return 'refuse'
          }
          deletable = true
          /* A JACKET GONE IS ITS FACTS GONE (WI-23.C5): `coverFacts` describe a
             file that is no longer there, and a circle that read them would
             publish a digest this device cannot serve.

             THE FACTS OF THIS NAME, not any facts. A book can hold both names
             (a legacy `cover.webp` beside the honest `cover.jpg`), and clearing
             whatever facts were there when the legacy one went discarded the
             JPEG's valid measurement. A record carrying no facts of this name
             is not written, so an ordinary removal costs no record bracket —
             and a content removal never writes one: a record's facts only ever
             name a cover, since `parseCoverFacts` refuses any other name. (A
             separate `kind !== 'cover'` refusal stood here and decided nothing
             this line does not.) */
          if (record?.coverFacts?.name !== name) return 'refuse'
          // Stryker disable next-line StringLiteral: the lane refuses on `'refuse'` alone, so any other answer lets the record write go ahead.
          return 'go'
        },
        /* ⚠️ **THE FACTS FIRST, THE FILE SECOND.** Two brackets, each honest
           about its kind, and the record's before the cover's: a crash or a
           journal failure between them leaves a jacket with no facts — which
           the next pass measures again — and never facts with no jacket, which
           the circle would publish and this device could not serve. The other
           order had exactly that window. One lane task around both, so a stamp
           queued behind the removal lands after it, not between. */
        after: async (target) => {
          if (!deletable) return
          const path = `${folderOf(bookId)}/${name}`
          await recorded(recorder, bookId, kind, async () => {
            await target.remove(path).catch(async (cause: unknown) => {
              if (await target.exists(path)) throw cause
            })
          })
        },
      },
      (held) => {
        if (held.coverFacts?.name !== name) return held
        const { coverFacts: _gone, ...rest } = held
        return rest
      },
    )
    if (claimedBy !== null) {
      throw new Error(`removeBlob: ${JSON.stringify(bookId)} does not own ${folderOf(bookId)} — ${JSON.stringify(claimedBy)} does`)
    }
    if (unreadable !== null) throw unreadable
}

/**
 * The clock the kernel runs on when no capability binds one — wall time,
 * never repeating.
 *
 * `hlcOf(Date.now())` alone stamped two writes in one millisecond alike, and
 * two of the circle's LWW registers written in one tick then merged as a
 * tie — the later word lost to the tie rule. The counter is what an HLC has
 * a counter FOR: it ticks when the millisecond does not.
 */
export function monotonicClock(): () => Hlc {
  let lastMs = -1
  let counter = 0
  return () => {
    const ms = Date.now()
    if (ms > lastMs) {
      lastMs = ms
      counter = 0
    } else if (counter < HLC_MAX_COUNTER) {
      counter += 1
    } else {
      /* The counter is full: the stamp moves into the next millisecond, as
         the sync clock's does, rather than throwing from `makeHlc`. */
      lastMs += 1
      counter = 0
    }
    return makeHlc(lastMs, counter, ZERO_DEVICE)
  }
}

/**
 * The clock port every store stamps through: the bound clock, never handing
 * out a stamp at or before one it already has — across a change of binding.
 *
 * ⚠️ **A BINDING CHANGE SENT STAMPS BACKWARDS.** The port read the slot and
 * nothing else. The sync capability's HLC runs ahead of wall time once it has
 * met a peer whose clock is ahead, and unbinding it restored the wall clock
 * under it — so the next edit was stamped EARLIER than the last, and a
 * last-writer-wins merge preferred the edit that came first. A clock bound
 * behind the last stamp did the same. Measured with a bound clock one minute
 * ahead. Found by audit.
 *
 * WITHIN ONE BINDING THE CLOCK IS TRUSTED AS IT IS. Every clock bound here is
 * monotonic on its own terms, and a port that second-guessed one would be a
 * second clock beside it — `ONE CLOCK PER DEVICE` is the rule this port exists
 * for. What it owns is the SEAM: a clock newly in the slot is held above the
 * newest stamp handed out before it, by counter, as an HLC holds a physical
 * clock that is behind; once its own stamps overtake, it is trusted again.
 *
 * ⚠️ **AND IT TELLS THE CLOCK, WHICH IT COULD NOT.** A `() => Hlc` had no way to
 * be told a floor, so the sync HLC's persisted floor never learned a stamp this
 * port raised, and a relaunch inside that window could issue it again
 * (2026-09-13 verify). A clock bound with a `witness` is told the newest stamp
 * and asked again, so what is handed out is the clock's own stamp and its floor
 * is saved past it. Only a clock that cannot be told — the legacy default, or a
 * witness that moves nothing — is held above by counter here.
 */
function flooredClock(slot: { get(): BoundClock; generation(): number }): () => Hlc {
  /* The highest stamp handed out, which is the floor a later binding is held
     above — `undefined` until one has been. Kept with `laterHlc`, the store's
     own rule for which of two stamps is the later: spelled out here as a
     comparison, the two answers agreed for every pair, since the same stamp by
     either name is the same string. */
  let newest: Hlc | undefined
  /* The binding whose stamps are passed through untouched. Starts as the one
     in the slot at birth, which has handed out nothing to be held above. */
  let trusted = slot.generation()
  return () => {
    const generation = slot.generation()
    const bound = slot.get()
    const stamp = bound.now()
    if (generation === trusted || newest === undefined || compareHlc(stamp, newest) > 0) {
      trusted = generation
      newest = laterHlc(newest, stamp)
      return stamp
    }
    const told = tell(bound, newest)
    if (compareHlc(told, newest) > 0) {
      trusted = generation
      newest = told
      return told
    }
    const { ms, counter } = parseHlc(newest)
    newest = counter < HLC_MAX_COUNTER ? makeHlc(ms, counter + 1, deviceOf(stamp)) : makeHlc(ms + 1, 0, deviceOf(stamp))
    return newest
  }
}

/** A stamp clock as the port holds it: the clock, and how to tell it a floor when it can be told one. */
interface BoundClock {
  readonly now: () => Hlc
  readonly witness?: ((stamp: Hlc) => void) | undefined
}

/**
 * Tell a clock a floor and ask it again — or answer the floor itself for a clock
 * that cannot be told, which is never past it and so is held above like any
 * clock that did not move. (This answered `null` for that clock, and the caller
 * tested for it before comparing — but `compareHlc` answers 0 for `null` against
 * any stamp, so the test decided nothing the comparison did not.)
 *
 * A WITNESS THAT THROWS IS NOT CAUGHT. The sync HLC refuses only a stamp
 * implausibly far ahead of its wall, which no clock bound here hands out; a clock
 * refusing its floor is a fault to surface at the write, not one to paper over
 * with a stamp the clock never agreed to.
 */
function tell(bound: BoundClock, floor: Hlc): Hlc {
  if (bound.witness === undefined) return floor
  bound.witness(floor)
  return bound.now()
}

export function createKernelServices({
  fs,
  storage,
  initialBooks = [],
  shelfRead = true,
  recorder = NOOP_RECORDER,
  diagnostics = NOOP_DIAGNOSTICS,
  settingsMigration,
  clock,
}: KernelServicesOptions): KernelServices {
  /* The delegating ports. The stores capture THESE, so a bind after
   * construction reaches every store without any of them knowing. Each
   * slot's default target is what an unbind RESTORES. */
  const recorderSlot = exclusiveSlot<MutationRecorder>('bindRecorder: the recorder port is already bound', recorder)
  const recorderPort = routedRecorder(recorderSlot, recorder)
  const clockSlot = exclusiveSlot<BoundClock>('bindClock: the clock port is already bound', {
    now: clock ?? monotonicClock(),
  })
  /* Empty is the honest default, not a degraded one: a build with no circle
     composed — every phone — has no private audience, and a reader who has
     shared nothing has shared nothing. See `bindPrivateAudience`. */
  const privateAudienceSlot = exclusiveSlot<PrivateAudience>(
    'bindPrivateAudience: the private-audience port is already bound',
    () => Promise.resolve([]),
  )
  const clockPort = flooredClock(clockSlot)

  /* A SET, NOT A SLOT, since phase 18.
   *
   * It was `exclusiveSlot` — "the service host is already bound" — which was
   * right while `peer` was the only transport. It is not a property of the
   * kernel: a service is a service, and the question of how many wires carry it
   * belongs to the wires. The browser client is a second transport serving the
   * SAME contributions, and with a slot it simply could not bind: `peer` held
   * it, and a browser signed in, called `book.list`, and waited for ever.
   *
   * Third time this shape has appeared in this phase — the envelope's home and
   * the test-project globs were the other two. An assumption that is safe with
   * one caller and silent with two. */
  /* ⚠️ **A SET OF BINDINGS, NOT A SET OF FUNCTIONS.** It held the `ServiceHost`
   * itself, so binding the SAME function twice collapsed to one entry and
   * either disposer removed the other's binding — a transport unbound by a
   * teardown that had nothing to do with it. Two transports sharing a
   * module-level host function is not exotic; it is what a shared adapter
   * looks like. Wrapping each binding in its own object makes identity
   * per-BINDING, which is what `bindServiceHost` returns a disposer for.
   * Found by audit. */
  const serviceHosts = new Set<{ readonly host: ServiceHost }>()
  /* Null defaults, and that is the whole default: there is nothing sensible
   * for an unbound device or shelf port to answer, and a stub that returned
   * an empty peer list would be a lie a caller could not detect. */
  const deviceSlot = exclusiveSlot<DevicePort | null>('bindDevicePort: the device port is already bound', null)
  const shelfSlot = exclusiveSlot<ShelfPort | null>('bindShelfPort: the shelf port is already bound', null)
  const sizeSlot = exclusiveSlot<SizePort | null>('bindSizePort: the size port is already bound', null)
  const hashSlot = exclusiveSlot<HashPort | null>('bindHashPort: the hash port is already bound', null)
  const speechSlot = exclusiveSlot<SpeechEnginePort | null>('bindSpeechEngines: the speech engine port is already bound', null)

  const writes = writeQueue()
  const library = createLibrary({ fs, queue: writes, initial: initialBooks, recorder: recorderPort, clock: clockPort, hashes: () => hashSlot.get() })
  /* THE LIBRARY'S LANE, so a marks write and the record/move writes for the
   * same book are on ONE lane even after a rekey — `folderOf` alone is folder-
   * correct but does not follow a rename chain. */
  const marks = createMarkStore({ fs, queue: writes, recorder: recorderPort, clock: clockPort, lane: library.lane })
  const cards = createCards({ storage, recorder: recorderPort, clock: clockPort, queue: writes })
  const settings = createSettingsStore(
    /* `carryLegacySettings` by default, not `keepValues`: the app has a
     * settings file older than the namespaced keys, and the kernel is where
     * that history is known. A composition may still supply its own. */
    { storage, migrate: settingsMigration ?? carryLegacySettings },
  )
  /**
   * Dispose every served host, whatever any single one does.
   *
   * ⚠️ **THIS LOOP WAS WRITTEN OUT THREE TIMES AND EVERY COPY CALLED
   * `dispose()` BARE**, so one host throwing took the other two paths with it:
   *
   * - on the REJECTION unwind, the loop aborted, every host after the thrower
   *   stayed registered, and the throw replaced `thrown.reason` — the original
   *   failure, and the only one that says why any of this is unwinding;
   * - on the NO-DISPOSER unwind, the same, masking the error naming the host
   *   that answered wrongly;
   * - in the returned composite disposer, the same leak with nothing left to
   *   report it.
   *
   * A partial serve left running is the exact leak both unwinds exist to
   * prevent, arriving by the one door neither of them watched. Found by audit.
   *
   * Best-effort and total: every host is asked, failures are collected rather
   * than propagated, and the caller decides what outranks what. The original
   * error always does.
   */
  const disposeAll = (all: readonly (Disposable | undefined)[]): unknown[] => {
    const failures: unknown[] = []
    for (const one of all) {
      /* The property is read INSIDE the guard: a getter that throws is a
         failure of this host, not a reason to leave the hosts after it
         undisposed. */
      /* ⚠️ **NOTHING TO DISPOSE IS NOT A FAILURE, AND TWO DIRECTIVES HERE SAID IT
         COULD NOT HAPPEN.** They claimed an undefined host threw and was recorded
         "the same outcome", and that a host with no disposer was refused before
         this ran. Both are false on the unwinds: a host that REJECTED is an
         `undefined` in the list, and the host being refused for answering no
         disposer is in the list that unwind disposes. Skipping them is what
         keeps them out of the dispose-failure report — which the report's tests
         now read. */
      try {
        const dispose = one?.dispose
        if (typeof dispose !== 'function') continue
        dispose.call(one)
      } catch (cause) {
        failures.push(cause)
      }
    }
    return failures
  }

  const reportDisposeFailures = (where: string, failures: readonly unknown[]): void => {
    for (const cause of failures) {
      /* The diagnostics port is injected, and a throwing one must not abort
       * the remaining reports, make ordinary disposal throw, or REPLACE the
       * host-start failure this is reporting on. Every report on its own. */
      try {
        diagnostics.warn('services.host-dispose-failed', {
          where,
          message: messageOf(cause),
        })
      } catch (reporting) {
        console.error('Paper: the diagnostics port threw while reporting a dispose failure', reporting, cause)
      }
    }
  }

  return {
    library,
    marks,
    cards,
    settings,
    diagnostics,
    writes,
    shelfRead: () => shelfRead,
    fs,
    storage,
    removeBlob: (bookId, name) => removeBlob({ library, recorder: recorderPort }, bookId, name),
    bindRecorder: (next) => recorderSlot.bind(next),
    bindClock: (next, witness) => clockSlot.bind({ now: next, witness }),
    bindPrivateAudience: (next) => privateAudienceSlot.bind(next),
    sharedPrivately: (bookId) => privateAudienceSlot.get()(bookId),
    clock: clockPort,
    bindServiceHost: (next) => {
      /* A fresh object per bind — see the Set's own note. Two binds of one
       * function are two bindings and two disposers, and neither reaches the
       * other. */
      const binding = { host: next }
      serviceHosts.add(binding)
      /* Idempotent, like every other disposer here: a capability whose teardown
       * runs twice must not remove a host a later composition bound. The
       * binding's own identity is what makes it so — a second delete of this
       * object finds nothing, and a later bind of the same function is a
       * different object. (A `disposed` flag stood here as well, and changed
       * nothing a second call could do.) */
      return {
        dispose: () => {
          serviceHosts.delete(binding)
        },
      }
    },
    bindDevicePort: (next) => deviceSlot.bind(next),
    devices: () => deviceSlot.get(),
    bindShelfPort: (next) => shelfSlot.bind(next),
    shelf: () => shelfSlot.get(),
    bindSizePort: (next) => sizeSlot.bind(next),
    bindSpeechEngines: (next) => speechSlot.bind(next),
    speechEngines: () => speechSlot.get(),
    sizes: () => sizeSlot.get(),
    bindHashPort: (next) => hashSlot.bind(next),
    hashes: () => hashSlot.get(),
    serveServices: async (list) => {
      /* NO HOST IS THE OFFLINE CASE, not a failure — see `bindServiceHost`.
       * With none bound there is nothing to serve and nothing to dispose: an
       * empty set settles to an empty list, which refuses nothing, and whose
       * disposer disposes and reports nothing. (It returned a shared no-op
       * disposer early, which answered exactly that by a second route.) */

      /* EVERY host gets the same list. They are transports, and a service
       * reachable over one wire and not another would be a difference nothing
       * in this table describes. */
      /* ⚠️ `Promise.all` LOST THE DISPOSERS OF EVERY HOST THAT SUCCEEDED.
       *
       * It rejects on the first rejection and discards the other results, so a
       * second host that had already registered its handlers was left running
       * with nothing holding its disposer — the exact partial-serve leak the
       * check below was written to prevent, arriving by the one door that check
       * could not see. `allSettled` keeps them all, so the unwind can be
       * complete whichever way a host failed. */
      const settled = await Promise.allSettled([...serviceHosts].map(async ({ host }) => await host(list)))
      /* A REJECTED RESULT CARRIES NO `value`, so reading it answers `undefined`
         — a host that did not serve, which the unwind skips. Asked of the status
         first, the answer was the same either way. */
      const served = settled.map((one) => (one as { readonly value?: Disposable }).value)
      const thrown = settled.find((one): one is PromiseRejectedResult => one.status === 'rejected')
      if (thrown !== undefined) {
        /* THE ORIGINAL FAILURE WINS. A disposer throwing during the unwind is
         * worth reporting and must not replace the reason we are unwinding. */
        reportDisposeFailures('serve-rejected', disposeAll(served as (Disposable | undefined)[]))
        throw thrown.reason
      }

      /* ⚠️ A BOUND HOST RETURNING NO DISPOSER IS A DEFECT IN THAT HOST, and it
       * has to be told so where it happens rather than at the next restart.
       * This was once `?? NOOP_DISPOSABLE`, indistinguishable from the unbound
       * fallback — so a host that answered wrongly was silently accepted, and
       * if it had registered handlers their disposer went with it: teardown
       * took nothing down and the registrations leaked into the next
       * composition.
       *
       * Checked for EVERY host, and the ones that answered properly are still
       * disposed before throwing — a partial serve left running is the leak
       * this check exists to prevent, arriving by a different door. */
      /* The READ is guarded as well: `dispose` could be a getter, and a
         getter that throws escaped this line before `disposeAll` ran, leaking
         every host that had answered properly. */
      /* ⚠️ THE DIRECTIVE HERE COVERED ALL THREE BLOCKS AND WAS TRUE OF ONE. An
         empty CATCH answers undefined and refuses the host the same way; an
         empty function or an empty TRY refuses every host, which the serving
         cases see at once. Narrowed to the catch. */
      const hasDisposer = (one: unknown): boolean => {
        try {
          // Stryker disable next-line OptionalChaining: an undefined host throws inside this try and is refused the same way.
          return typeof (one as Disposable | undefined)?.dispose === 'function'
        }
        // Stryker disable next-line BlockStatement: an empty catch answers undefined, which refuses the host the same way.
        catch {
          return false
        }
      }
      const bad = served.findIndex((one) => !hasDisposer(one))
      if (bad !== -1) {
        reportDisposeFailures('serve-no-disposer', disposeAll(served as (Disposable | undefined)[]))
        throw new Error(`serveServices: a bound service host returned no disposer (host ${bad + 1} of ${served.length})`)
      }

      /* ONCE, HOWEVER OFTEN IT IS CALLED. `Disposable` says disposal is
       * idempotent and this ran every child again on a second call — so a
       * caller that disposed defensively (a teardown path and an unmount, say)
       * double-disposed every host beneath it. The same contract DOES require
       * each host's own disposer to tolerate a second call — but a host is
       * exactly the code this port cannot vouch for, and one flag here means no
       * host is ever asked to prove it. */
      let disposed = false
      return {
        dispose: () => {
          if (disposed) return
          disposed = true
          /* NOT `throw`: `Disposable.dispose()` is called from teardown paths
           * that have nothing to do with the host that failed, and a throw
           * here would abort THEIR cleanup for somebody else's defect. The
           * failure is reported instead, which is the only thing left that can
           * still be done with it. */
          reportDisposeFailures('unserve', disposeAll(served as (Disposable | undefined)[]))
        },
      }
    },
    drain: async () => {
      /* THE INDEX FIRST (phase 20, D4): a page turn writes `book.json` and
       * leaves the index dirty behind a throttle, and a drain is the one
       * moment — quit, window close — that must not wait for the timer. The
       * flush queues the rewrite; the idle below is what waits for it.
       *
       * ⚠️ **AND THE INDEX AGAIN, AFTER THE IDLE.** A tick still ON the queue
       * marks the index dirty only when its record lands, which is after the
       * first flush has already found nothing to do — so the drain resolved
       * with `index.dirty` on disk and the promised flush not made. The marker
       * kept recovery safe; the second flush is what makes the drain true.
       *
       * ⚠️ **EVERY STAGE IS ATTEMPTED, WHATEVER AN EARLIER ONE DID.** These were
       * bare awaits in a row, so an index write that rejected skipped the idle
       * and the flat store's flush — a failure in the shelf's cache abandoning
       * settings and cards that had nothing to do with it, at the one moment
       * nothing can be retried. `shutdown.ts` fixed the same shape one level up.
       * The failures are raised once everything has been tried: one as itself,
       * several as one `AggregateError` whose message names each. */
      const failures: unknown[] = []
      const stage = async (run: () => unknown): Promise<void> => {
        try {
          await run()
        } catch (cause) {
          failures.push(cause)
        }
      }
      await stage(() => library.flushIndex())
      await stage(() => writes.idle())
      await stage(() => library.flushIndex())
      await stage(() => writes.idle())
      await stage(() => storage?.flush?.())
      /* SEVERAL ASKED FIRST. Asked second, `> 1` was reached only by a count
         that was not one, where `>= 1` answered the same — a bound no count
         could tell apart from its neighbour. */
      if (failures.length > 1) {
        throw new AggregateError(failures, `drain: ${failures.length} stages failed — ${failures.map(messageOf).join('; ')}`)
      }
      if (failures.length === 1) throw failures[0]
    },
  }
}
