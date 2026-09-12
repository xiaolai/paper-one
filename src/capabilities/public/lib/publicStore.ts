import {
  EMPTY_PUBLIC_FILE,
  MAX_HELD_BYTES_PER_BOOK,
  MAX_HELD_PER_BOOK,
  VERIFY_PER_TASK,
  atomicWrite,
  breathe,
  MAX_TASK_MS,
  isMissingFile,
  foldPublic,
  hasRoom,
  keepWithin,
  publicPathIn,
  publicationKey,
  readPublicEnvelope,
  sequenceKey,
  sizeOf,
  sliceFor,
  type Delivered,
  type IndexFs,
  type KeptEnvelope,
  type PublicCrypto,
  type PublicFile,
  type PublicRefusal,
  type VaultFs,
  type Weighed,
  type WriteQueue,
} from '../../../kernel'

/**
 * Where a stranger's annotations live on this device, and what it costs to
 * hold them — phase 26, WI-26.2 and WI-26.7.
 *
 * ⚠️ **NEVER `circle/`, AND NEVER ITS LOADER.** Phase 26's review found that
 * the circle's disk loader checks the filename and the fields and neither a
 * signature nor a roster — it was safe solely because the network receiver
 * refused strangers upstream. There is no upstream here: the whole point is
 * that strangers reach this. So every line is verified on the way in AND on the
 * way out, by `readPublicEnvelope`, against the bytes that were signed.
 *
 * ## What is stored is what was signed
 *
 * ⚠️ **NO PROJECTION.** The circle keeps the passage and the stamps and drops
 * the envelope, so a provider forwarding that projection forwards something
 * unsigned — finding #3. The fix is not another signature check; it is to have
 * nothing separately mutable. One canonical string per line, and every field a
 * surface shows is parsed out of it at the moment it is shown.
 *
 * ## Absent and unreadable are not the same answer
 *
 * `readMarks` names this as the most destructive line it ever had, and it
 * applies with one exception stated below: a book nobody has annotated and a
 * file that would not read look identical to a caller who collapses both, so a
 * momentary read failure loads nothing and the next write puts that nothing on
 * disk. Absent is empty; unreadable THROWS.
 *
 * ⚠️ **A LINE that will not read is different from a FILE that will not read.**
 * Every line came from a stranger, so a bad one is the ordinary state of a
 * public store rather than evidence of damage: it is dropped, counted and
 * reported, and the rest of the file is kept. Refusing the file over one
 * stranger's line would let anybody take a book's annotations away.
 */

/** What one book's public store amounts to, and what was refused reading it. */
export interface PublicRead {
  readonly file: PublicFile
  /** How many stored lines did not survive verification, by reason. */
  readonly refused: Readonly<Partial<Record<PublicRefusal, number>>>
}

/** Somewhere to read and write a book's folder. */
export interface StoreFs {
  readonly fs: IndexFs
  readonly queue: WriteQueue
  readonly lane: (bookId: string) => string
}


/** Several tallies of the same reasons, added rather than replaced. */
const addUp = (
  ...tallies: readonly Readonly<Partial<Record<PublicRefusal, number>>>[]
): Partial<Record<PublicRefusal, number>> => {
  const out: Partial<Record<PublicRefusal, number>> = {}
  for (const one of tallies) {
    for (const [why, count] of Object.entries(one) as [PublicRefusal, number][]) {
      out[why] = (out[why] ?? 0) + count
    }
  }
  return out
}

const tally = (
  into: Partial<Record<PublicRefusal, number>>,
  refusal: PublicRefusal,
): Partial<Record<PublicRefusal, number>> => ({ ...into, [refusal]: (into[refusal] ?? 0) + 1 })

/**
 * The most bytes one book's stored file may be before it is refused unread.
 *
 * ⚠️ **LARGER THAN WHAT IS RETAINED, DELIBERATELY.** `MAX_HELD_BYTES_PER_BOOK`
 * bounds the live notes; the file also carries withdrawals and equivocation
 * pairs, which are the evidence WI-26.3 needs and which have to fit beside
 * them. Twice the retained bound is the room for that, and it is still a
 * number rather than "however much somebody wrote".
 */
export const MAX_STORED_BYTES_PER_BOOK = 2 * MAX_HELD_BYTES_PER_BOOK

/**
 * The most suppression records one book keeps that suppress nothing it holds.
 *
 * ⚠️ **A BOUND ON THE PART AN ATTACKER CHOOSES THE SIZE OF.** A withdrawal for
 * a publication this device holds is never counted here and never dropped; this
 * caps only the ones guarding against a replay of something never seen, which
 * is the set anybody can mint without limit. Twice the note cap, because
 * suppression is the cheaper record and the one whose loss is harder to
 * notice.
 */
export const MAX_SUPPRESSIONS_PER_BOOK = 2 * MAX_HELD_PER_BOOK

/* ⚠️ **ONE SPELLING OF EACH KEY, AND THERE WERE THREE.** This file wrote
   `` `${one.voice}#${one.pub}` `` here and `` `${one.voice}#${one.seq}` ``
   inline in `writePublic`, beside the kernel's own `publicationKey` and
   `sequenceKey` — the exact shape of the `byteLength` duplication this file
   carries the scars of at the bottom, and worse, because a key that disagrees
   with the fold's does not fail loudly: it simply matches nothing, so a
   suppression stops suppressing and looks like an absence. */

/** `voice#pub` — the key a suppression and its note share. */
const publicationKeyOf = (one: KeptEnvelope): string => publicationKey(one.voice, one.pub)

/** `voice#seq` — one point in one voice's own stream. */
const sequenceKeyOf = (one: Pick<KeptEnvelope, 'voice' | 'seq'>): string => sequenceKey(one.voice, one.seq)

/**
 * Read one book's public annotations, verifying every line.
 *
 * ⚠️ **VERIFIED ON LOAD, NOT ONLY ON ARRIVAL.** A file on disk is a file
 * anything with a filesystem can write, and the circle's loader not doing this
 * is the finding that replaced phase 26's first design.
 *
 * ⚠️ **AND `expectedBook` IS REQUIRED.** Without it a valid envelope for
 * ANOTHER book was accepted out of this book's file and handed to this book's
 * resolver — measured by audit. A quotation shared between two books would
 * then place an authentic statement in the wrong one, signed and all. The
 * signature says who wrote it; it does not say which file it belongs in.
 */
export async function readPublic(
  fs: IndexFs,
  bookId: string,
  expectedBook: string,
  crypto: PublicCrypto,
  now: number,
  blocked: (voice: string) => boolean,
): Promise<PublicRead> {
  let bytes: Uint8Array
  try {
    bytes = await fs.readFile(publicPathIn(bookId))
  } catch (cause) {
    /* Absent is empty — the ordinary state of almost every book. Anything else
       throws, for `readMarks`'s reason. */
    if (isMissingFile(cause)) return { file: EMPTY_PUBLIC_FILE, refused: {} }
    throw cause
  }
  /* ⚠️ **BEFORE THE DECODE, WHICH IS BEFORE THE SECOND ALLOCATION.** See
     `MAX_STORED_BYTES_PER_BOOK`. This used to decode the whole file to a string
     and then re-encode it to measure it — three copies of an attacker-chosen
     file in memory to find out it was too big. The bytes already know their own
     length. A file over the bound is refused WHOLE rather than read down to it:
     a truncated read of a store this device wrote is not a smaller store, it is
     a store with an arbitrary line missing. */
  if (bytes.length > MAX_STORED_BYTES_PER_BOOK) {
    throw new Error(`public: ${publicPathIn(bookId)} is larger than this build will read`)
  }
  const text = new TextDecoder().decode(bytes)
  const lines = text.split('\n').filter((line) => line !== '')
  const taken = await takePublic(EMPTY_PUBLIC_FILE, lines, expectedBook, crypto, now, blocked, {
    breathe: () => breathe(MAX_TASK_MS),
    live: () => true,
  })
  /* `takePublic` answers `null` only for a cancelled load, and nothing cancels
     this one — `live` is a constant. */
  return taken ?? { file: EMPTY_PUBLIC_FILE, refused: {} }
}

/**
 * Take arriving envelopes into a book's store, under the bounds.
 *
 * ⚠️ **VERIFICATION IS SLICED — WI-26.7.** It is new main-thread work before
 * anchoring even starts, and it is synchronous by design, so a load of a
 * thousand envelopes is a thousand Ed25519 checks in one task.
 */
export async function takePublic(
  held: PublicFile,
  lines: readonly string[],
  expectedBook: string,
  crypto: PublicCrypto,
  now: number,
  blocked: (voice: string) => boolean,
  pace: { readonly breathe: () => Promise<void>; readonly live: () => boolean },
): Promise<PublicRead | null> {
  /* ⚠️ **ASKED BEFORE THE FIRST SLICE, NOT ONLY BETWEEN SLICES.** An already-
     cancelled batch of thirty-two lines or fewer was verified in full and
     returned as a success — measured by audit. The check after the last slice
     was missing for the same reason. */
  if (!pace.live()) return null
  let refused: Partial<Record<PublicRefusal, number>> = {}
  const arriving: Delivered[] = []
  /* ⚠️ **THE ADMITTED SET IS ACCUMULATED, NOT REBUILT PER ENVELOPE.** This
     spliced `held` and `arriving` into a fresh array for every line, which is
     O(n²) over a count an attacker chooses. */
  /* ⚠️ **CAPACITY IS ABOUT LIVE NOTES, AND THIS COUNTED EVERYTHING KEPT.**
     `held.kept` carries withdrawals and both sides of an equivocation as well
     as publications, and it retains them past their own expiry when they still
     suppress something — all of which are EVIDENCE, not notes a reader will
     ever see. Counting them against `heldPerBook` and `heldBytesPerBook` meant
     a book full of withdrawn publications refused new ones while showing
     nothing, and the fuller the suppression record grew the less room there was
     for the annotations the bound exists to cap. The trimmer already draws this
     line — `writePublic` splits suppressions from notes before calling
     `keepWithin` — and admission did not. Found by audit. */
  const admitted: Weighed[] = held.held.map((one) => ({ received: one.received, at: one.at }))
  const seen = new Set(held.kept.map((one) => one.received))
  let at = 0
  while (at < lines.length) {
    const { take } = sliceFor(lines.length - at, VERIFY_PER_TASK)
    for (const line of lines.slice(at, at + take)) {
      const read = readPublicEnvelope(line, crypto, now, blocked)
      if (typeof read === 'string') {
        refused = tally(refused, read)
        continue
      }
      /* ⚠️ **THE BOOK IS CHECKED HERE AND NOWHERE ELSE COULD DO IT.** The
         signature proves who wrote the envelope; `envelope.book` is what says
         which book it is about, and only the caller knows which book's file
         this is. */
      if (read.envelope.book !== expectedBook) {
        refused = tally(refused, 'malformed')
        continue
      }
      /* A line already held is not a new one, and must not spend capacity —
         a duplicate delivery used to consume provisional room and push a real
         arrival out. */
      if (seen.has(read.received)) continue
      /* ⚠️ **SUPPRESSION IS NOT SUBJECT TO THE LIVE-NOTE CAPACITY.** A valid
         withdrawal arriving at a full book was silently discarded and all the
         notes stayed — measured by audit, and it is the worst direction for
         this to fail in: the reader's "take it back" is exactly what must not
         be droppable by somebody else filling the book first. An `unnote` is a
         few hundred bytes and always admitted; only publications queue. */
      /* ⚠️ **`continue`, NEVER `break` — AND THE COMMENT ABOVE IS WHY.** This
         was a `break`, which abandoned the REST OF THE SLICE the moment one
         note met a full book: a batch of `[note, withdrawal]` admitted neither,
         so the withdrawn note stayed visible. That is the very drop the comment
         above forbids, reintroduced two lines below it by a control-flow
         keyword. Reproduced by audit.

         ⚠️ **AND THE SIZE IS BYTES.** `read.received.length` is UTF-16 code
         units; `sizeOf` is the unit `heldBytesPerBook` is named in. See
         `bounds.ts`. */
      if (read.envelope.op === 'note' && !hasRoom(admitted, sizeOf(read.received))) {
        refused = tally(refused, 'full')
        continue
      }
      seen.add(read.received)
      admitted.push(asWeighed(read))
      arriving.push(read)
    }
    at += take
    if (at < lines.length) {
      await pace.breathe()
      /* A cancelled load stops. `null` rather than a partial answer: the caller
         asked for a book that is no longer open, and writing a half-taken file
         would look exactly like a complete one. */
      if (!pace.live()) return null
    }
  }
  if (!pace.live()) return null
  return { file: foldPublic(held, arriving, now), refused }
}

const asWeighed = (one: Delivered) => ({ received: one.received, at: one.envelope.at })
const asWeighedKept = (one: KeptEnvelope) => ({ received: one.received, at: one.at })

/**
 * Nobody is silenced, for the one read that must not be filtered.
 *
 * Named rather than written inline, because `() => false` at a `blocked`
 * parameter reads as an oversight and this one is the opposite.
 */
const NOBODY_SILENCED = (): boolean => false

/**
 * Write a book's public annotations, on the book's own lane.
 *
 * ⚠️ **THE READ, THE FOLD AND THE WRITE ARE ONE QUEUED TRANSACTION.** Two
 * callers used to fold independently from the same old state and then overwrite
 * each other in turn, so whichever wrote second erased the other's arrivals.
 * `take` runs INSIDE the lane, against the file as it is at that moment.
 *
 * ⚠️ **AND WHAT IS WRITTEN IS `kept`, NOT `held`.** Writing only the live notes
 * threw away every withdrawal and every equivocation, so a reload forgot them
 * and a replayed note came back — measured by audit. See `PublicFile.kept`.
 *
 * ⚠️ **AND THE READER'S BLOCK REACHES A LIVE PUBLICATION AND NOTHING ELSE.**
 * This read the stored file WITH the block, which is the same defect by another
 * road: a read-modify-write that cannot see a line deletes it. See `onlySaid`.
 */
export async function writePublic(
  fs: VaultFs & Pick<IndexFs, 'readFile'>,
  { queue, lane }: Pick<StoreFs, 'queue' | 'lane'>,
  bookId: string,
  expectedBook: string,
  arriving: readonly string[],
  crypto: PublicCrypto,
  now: number,
  blocked: (voice: string) => boolean,
): Promise<PublicRead> {
  let outcome: PublicRead = { file: EMPTY_PUBLIC_FILE, refused: {} }
  /* ⚠️ **`appendShared`, NOT `append`.** The lane is shared with the reader's
     own writing, deliberately — a public write on an unrelated queue races
     rekeying and deletion — but the LINE is not: a flood of arrivals refuses
     at half the cap and leaves the rest for the reader's next note. */
  await queue.appendShared(lane(bookId), async () => {
    /* ⚠️ **THE STORED FILE IS READ WITHOUT THE BLOCK, AND IT USED TO BE READ
       WITH IT.** This is a read-MODIFY-WRITE of the device's own record, so
       every line the block hid from the read was a line this rewrite then
       deleted from disk — silently, on the reader's next "Look for some". It
       took the silenced voice's WITHDRAWALS with it, and both sides of any
       equivocation, which are the two things `PublicFile.kept` exists to
       persist. So "Hear this voice again" was not a reversal: a note the
       author had taken back came straight back with them, and a voice this
       device had caught equivocating came back looking honest. That is the
       replay `order.ts` names in as many words — *"drop one side and the next
       reload finds no conflict"* — reached through the reader's own control.
       Found by audit. */
    const current = await readPublic(fs as IndexFs, bookId, expectedBook, crypto, now, NOBODY_SILENCED)
    /* The one thing the block DOES do to the stored file, and it is about room
       rather than about evidence: a silenced voice's live publications stop
       occupying the space an arriving note is weighed against. `held` is
       exactly the live set — the fold puts neither a withdrawn note nor an
       equivocating one there — so this frees what `hasRoom` counts and touches
       nothing that is keeping a record. */
    const standing: PublicFile = { ...current.file, held: current.file.held.filter((one) => !blocked(one.voice)) }
    const taken = await takePublic(standing, arriving, expectedBook, crypto, now, blocked, {
      breathe: () => breathe(MAX_TASK_MS),
      live: () => true,
    })
    const file = taken?.file ?? standing
    let refusedHere: Partial<Record<PublicRefusal, number>> = {}
    /* Trimmed at the boundary as well as at the fold: `keepWithin` is the one
       rule for what a book retains, and a writer that skipped it would put a
       file on disk the reader could never load under the bounds.

       ⚠️ **SUPPRESSION LINES ARE NOT TRIMMED.** They are the evidence, they are
       small, and evicting one is what lets a withdrawn note come back. */
    const equivocating = new Set(file.equivocated.map((one) => one.key))
    const withdrawn = new Set(file.withdrawn.map((one) => one.key))
    /**
     * ⚠️ **SILENCING DISCARDS WHAT A VOICE SAID AND NEVER WHAT THIS DEVICE
     * KNOWS ABOUT THEM — AND IT USED TO TAKE BOTH.** The read above was made
     * WITH the block, which hid a silenced voice's lines from a read-MODIFY-
     * WRITE and so deleted them from disk on the reader's next "Look for some".
     * Their withdrawals went with them, and both sides of any equivocation —
     * the two things `PublicFile.kept` exists to persist. So "Hear this voice
     * again" was not a reversal: a note its author had taken back came back
     * with them, and a voice this device had caught equivocating came back
     * looking honest, which is the revival `order.ts` names in as many words.
     * Found by audit.
     *
     * A note an `unnote` has already taken back is kept for a reason that is
     * easy to miss: `surviving` bounds a withdrawal's retention by the LATER of
     * its own expiry and that of the note it suppresses, so dropping the note
     * shortens the suppression to the `unnote`'s own lifetime — and a
     * short-lived withdrawal of a long-lived note would then be forgotten while
     * the note was still valid. That is the defect `surviving` already carries
     * a paragraph about, re-entered by deleting the other half of the pair.
     * Asked AFTER the fold, so a withdrawal arriving in THIS batch counts.
     *
     * ⚠️ **AND THE ROOM THIS RECLAIMS IS A COURTESY, NOT A DEFENCE.**
     * `bounds.ts` states the adversary as one with unlimited keys and concedes
     * the flood outright — *"a bulletin board anybody may write to is one
     * anybody may fill"* — so no block holds a book's room against somebody who
     * can mint another voice for nothing. Where the courtesy and the evidence
     * disagreed, the courtesy used to win.
     */
    const onlySaid = (one: KeptEnvelope): boolean =>
      blocked(one.voice) && !withdrawn.has(publicationKeyOf(one)) && !equivocating.has(sequenceKeyOf(one))
    const conflicts = file.kept.filter((one) => one.op === 'note' && equivocating.has(sequenceKeyOf(one)))
    const notes = file.kept.filter(
      (one) => one.op === 'note' && !equivocating.has(sequenceKeyOf(one)) && !onlySaid(one),
    )
    /* ⚠️ **SUPPRESSION LINES ARE BOUNDED, AND THEY USED TO BE UNBOUNDED.**
       Keeping every withdrawal was right about the DANGER — evicting one lets a
       withdrawn note come back — and wrong about the cost: nothing capped them,
       so twelve thousand valid withdrawals took the file past
       `MAX_STORED_BYTES_PER_BOOK` and every later read refused it WHOLE.
       Reproduced by audit. That trades a bounded loss for a total one: an
       unreadable file loses every real suppression as well as the junk, and it
       never recovers, because a file does not shrink by being refused.

       So the trim is ordered by what a suppression is FOR. One that matches a
       note this device actually holds is doing its job and is never dropped —
       which covers every withdrawal a reader makes of their own work, since
       their note is right there. One that matches nothing is guarding against a
       replay of something never seen; those are what an attacker can mint
       without limit, and those are what goes first. */
    const held = new Set(notes.map((one) => publicationKeyOf(one)))
    const suppressing = file.kept.filter((one) => one.op === 'unnote' && held.has(publicationKeyOf(one)))
    const orphans = file.kept.filter((one) => one.op === 'unnote' && !held.has(publicationKeyOf(one)))
    /* Oldest first, so the ones with least of their horizon left go first —
       the same direction `keepWithin` evicts in, and for the same reason. */
    const roomForOrphans = Math.max(0, MAX_SUPPRESSIONS_PER_BOOK - suppressing.length)
    const keptOrphans = [...orphans].sort((a, b) => a.at - b.at).slice(0, roomForOrphans)
    if (keptOrphans.length < orphans.length) {
      refusedHere = tally(refusedHere, 'full')
    }
    const kept = [
      ...suppressing,
      ...keptOrphans,
      ...conflicts,
      ...keepWithin(notes.map(asWeighedKept)).map((one) => byLine(notes, one)),
    ]
    const text = kept.map((one) => one.received).join('\n')
    const bytes = new TextEncoder().encode(text === '' ? '' : `${text}\n`)
    /* ⚠️ **WHAT THIS DEVICE WRITES, THIS DEVICE MUST BE ABLE TO READ.** The
       read gate refuses an oversized file whole and permanently, so a writer
       that can exceed it is a writer that can brick a book. This is the
       assertion that makes any future way of doing so loud here, at the write,
       rather than silent until the next load. */
    if (bytes.length > MAX_STORED_BYTES_PER_BOOK) {
      throw new Error(
        `public: refusing to write ${publicPathIn(bookId)} at ${bytes.length} bytes — its own reader would refuse it`,
      )
    }
    await atomicWrite(fs, publicPathIn(bookId), bytes)
    /* ⚠️ **SPREADING OVERWROTE MATCHING COUNTS INSTEAD OF ADDING THEM.** One
       malformed line already on disk plus one malformed line arriving reported
       `{ malformed: 1 }` — the later map simply replaced the earlier value, so
       every tally that mattered under-reported exactly when there was most to
       report. Reproduced by audit. */
    outcome = { file, refused: addUp(current.refused, taken?.refused ?? {}, refusedHere) }
  })
  return outcome
}

/** The kept envelope a weighed row came from. */
const byLine = (kept: readonly KeptEnvelope[], one: Weighed): KeptEnvelope =>
  kept.find((held) => held.received === one.received)!

/* ⚠️ **NO LOCAL `byteLength` ANY MORE.** This file had its own copy of "how
   many bytes is this string", beside the kernel's exported `byteLengthOf` —
   and a second definition of the unit is a second chance for a bound to be
   counted wrongly, which is precisely the defect this file already carries the
   scars of. The one place that still needs a byte count reads it off the
   `Uint8Array` the filesystem hands back, which is cheaper than either. */

/** Whether a filesystem failure is "there is no such file". */
/* ⚠️ **`isMissing` STOOD HERE TOO.** Three definitions of "is this data
   loss?" — this one, `voicePort`'s and the kernel's `isMissingFile`, whose own
   header says *"one copy, because there were already two"* and names these
   two. Neither was removed when it was written. Found by audit. */
