import {
  DEFAULT_PUBLIC_BOUNDS,
  EMPTY_PUBLIC_FILE,
  MAX_HELD_BYTES_PER_BOOK,
  MAX_HELD_PER_BOOK,
  VERIFY_PER_TASK,
  atomicWrite,
  breathe,
  canonicalJson,
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
  type PublicWithdrawal,
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
 * public store rather than evidence of damage: it is dropped from what is
 * drawn, counted and reported, and the rest of the file is kept. Refusing the
 * file over one stranger's line would let anybody take a book's annotations
 * away.
 *
 * ⚠️ **"DROPPED" MEANT FROM THE DISK TOO, AND IT MUST NOT.** A stranger's bad
 * line is refused on arrival and never written, so a STORED line that will not
 * read is this device's own bytes, and the rewrite deleted it. It is written
 * back as it was now — see `PublicRead.unreadable` (2026-09-13 verify).
 */

/** What one book's public store amounts to, and what was refused reading it. */
export interface PublicRead {
  readonly file: PublicFile
  /** How many stored lines did not survive verification, by reason. */
  readonly refused: Readonly<Partial<Record<PublicRefusal, number>>>
  /**
   * The lines refused for what they ARE, verbatim — not JSON, not an envelope,
   * another book's, or a version, bound or signature this build will not take.
   *
   * NOT the ones refused for their TIME (`expired`), for ROOM (`full`) or by the
   * reader's own block (`blocked`): those are this build's rules for what a book
   * retains, applied to lines it could read. `expired` is one word for two
   * facts — past its expiry, or further out than this build accepts — and both
   * go, because the tally cannot tell them apart and the first is the ordinary
   * one.
   *
   * ⚠️ **WHY IT EXISTS: THE WRITE DELETED THEM.** See `writePublic`. From a read
   * of the STORED file these are bytes this device wrote and can no longer read;
   * from a batch that ARRIVED they are a stranger's, and nothing keeps those.
   *
   * ⚠️ **BYTES, AND THEY WERE STRINGS.** A string is a decoding of the line, and
   * the decoding was lossy: stored `ff` was written back as `ef bf bd`, and a
   * byte-order mark opening the file was not written back at all (2026-09-14
   * verify). From the stored file these are the bytes that were there.
   */
  readonly unreadable: readonly Uint8Array[]
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
 * ⚠️ **A BOUND ON THE PART AN ATTACKER CHOOSES THE SIZE OF.** One withdrawal
 * for each note a write keeps is never dropped, and takes its share of this cap
 * first; the rest caps the ones guarding against a replay of something never
 * seen, which is the set anybody can mint without limit. Twice the note cap,
 * because suppression is the cheaper record and the one whose loss is harder to
 * notice — and so at least a withdrawal per retained note always fits.
 */
export const MAX_SUPPRESSIONS_PER_BOOK = 2 * MAX_HELD_PER_BOOK

/**
 * The most bytes of equivocation evidence one book keeps — every spelling of
 * every sequence a voice signed more than one way.
 *
 * ⚠️ **A BOUND OF ITS OWN, AND IT HAD NONE (2026-09-14).** Evidence is not a
 * note, so no note bound trims it, and a stranger with a free key can spell as
 * many sequences two ways as they like: it grew until `MAX_STORED_BYTES_PER_BOOK`
 * refused every write, and nobody's note could land until the evidence expired.
 *
 * A quarter of the note bound — half a megabyte — because what a write retains
 * has to stay under what its reader accepts WHATEVER the lines hold: notes at
 * their bound, the withdrawals at their shared cap each as wide as a withdrawal
 * can be spelled, the record of what equivocated at its cap, and this. Their
 * sum leaves room to spare under the stored bound, and `publicStore.test.ts`
 * holds it, so none of them can grow past that room without a test failing —
 * which is why the number is there rather than here, where it would drift.
 *
 * Let go a whole sequence at a time, the newest first and the oldest kept, for
 * the orphans' reason: a flood of new evidence goes rather than what the book
 * already had. Never one side: a sequence with one spelling left is not an
 * equivocation, and its survivor is drawn as honest.
 */
export const MAX_EVIDENCE_BYTES_PER_BOOK = MAX_HELD_BYTES_PER_BOOK / 4

/**
 * The most sequences one book remembers as equivocated once their envelopes
 * are gone.
 *
 * ⚠️ **EVICTING THE EVIDENCE FORGAVE THE LIE (2026-09-14).** Both spellings go
 * together, which is right — one alone reads as honest — but the device's only
 * record that the sequence had two went with them, so a replay of either was
 * drawn as an honest note afterwards. Unbounded retention used to remember it;
 * what is remembered now is the FACT rather than the bytes: a `voice#seq` key
 * and the moment no valid envelope can carry that sequence any more.
 *
 * Written as one line of this book's own file, which no other device reads, and
 * ignored by any build that does not know it — an older one carries it back as
 * bytes it cannot read, which is exactly what it should do with it.
 *
 * ⚠️ **WHAT IT COSTS A BOOK:** a key is a 64-hex voice, a `#` and a sequence,
 * and the time beside it is another number — about a hundred bytes a record, so
 * this cap is roughly a tenth of a megabyte in the worst case and nothing at
 * all for a book nobody lied about. `publicStore.test.ts` holds that sum beside
 * the other bounds. The ones with the longest left to run are kept, so what a
 * flood of fresh conflicts crowds out is the protection nearest its end.
 */
export const MAX_CONFLICTS_PER_BOOK = MAX_SUPPRESSIONS_PER_BOOK

/** The version of the record this build writes and reads. A later one is not this. */
const CONFLICTS_VERSION = 1

/** This book's record of what equivocated, as one line. */
const conflictsLine = (remembered: readonly PublicWithdrawal[]): string =>
  canonicalJson({ v: CONFLICTS_VERSION, equivocated: remembered.map((one) => [one.key, one.until]) })

/**
 * The record a stored line carries, or `null` when the line is not one.
 *
 * A line that opens like a record and will not read is not a record and not
 * empty either: it goes back to the envelope reader, which refuses it, and the
 * write carries its bytes as it carries any damage.
 */
function conflictsIn(line: string): PublicWithdrawal[] | null {
  /* Every stored line is parsed here before the envelope reader parses it
     again, rather than sniffed for an opening: a test cannot tell a sniff that
     lets everything through from one that lets nothing through except by the
     shape below, which is the thing that actually decides.

     And ONE question decides it. This asked "is it an object" first, then "is
     its version this one" — and nothing that fails the first has a version, so
     the second refused all of it again and no test could hear the first
     (2026-09-15 sweep). `?.` answers `undefined` for a line that is not JSON,
     is `null`, or is anything but an object, and none of those is a record. */
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    /* Not JSON: `parsed` stays `undefined`, which is not a record. */
  }
  const held = parsed as { readonly v?: unknown; readonly equivocated?: unknown } | null | undefined
  if (held?.v !== CONFLICTS_VERSION || !Array.isArray(held.equivocated)) return null
  return held.equivocated
    .filter(
      (row): row is [string, number] =>
        Array.isArray(row) && typeof row[0] === 'string' && Number.isSafeInteger(row[1]),
    )
    .map(([key, until]) => ({ key, until }))
}

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
    if (isMissingFile(cause)) return { file: EMPTY_PUBLIC_FILE, refused: {}, unreadable: [] }
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
  /* ⚠️ **SPLIT AS BYTES, AND IT WAS SPLIT AS ONE DECODED STRING.** The decode
     is lossy — what is not UTF-8 becomes a replacement character, and a mark
     opening the file is eaten — and a line carried back to disk was written as
     that decoding (2026-09-14 verify). Each line keeps its bytes now, and what
     is carried is those bytes. The lossy decode is left to what is READ, where
     it can pass nothing off: a line is drawn only if it verifies. */
  const stored = linesOf(bytes)
  const decoder = new TextDecoder()
  /* ⚠️ **THE RECORD OF WHAT EQUIVOCATED IS READ BACK BEFORE ANYTHING IS FOLDED,
     AND IT OUTLIVES THE ENVELOPES IT IS ABOUT.** See `MAX_CONFLICTS_PER_BOOK`:
     both spellings are evicted together under their bound, and without this the
     next replay of either was drawn as honest. It is this book's own file and
     nothing else reads it, so the record travels nowhere. */
  const decoded = stored.map((line) => decoder.decode(line))
  const records = decoded.map((line) => conflictsIn(line))
  const remembered = records.filter((one): one is PublicWithdrawal[] => one !== null).flat()
  /* Where each envelope line sat in the file, so what is carried back is the
     bytes that were there — see `PublicRead.unreadable`. */
  const storedAt = decoded.map((_, at) => at).filter((at) => records[at] === null)
  const envelopes = storedAt.map((at) => decoded[at]!)
  /* ⚠️ **NO ROOM IS WEIGHED ON THE WAY IN FROM DISK — IT WAS, AND THE RELOAD
     DELETED WHAT THE WRITE HAD KEPT.** This read the stored file through the
     bound a batch ARRIVING meets, which counts every line it takes, while
     `writePublic` bounds only the notes and writes the withdrawals and both
     sides of every equivocation AHEAD of them. So that evidence took the notes'
     room: a stranger's five hundred withdrawals of publications this book never
     held made the next reload hold none of its notes, and the write after it
     erased them all; and an equivocation past the bound lost a side, so the
     other was drawn as an honest note. Reproduced by the 2026-09-14 mutation
     sweep. What this device stored has met its bounds already, on the way in. */
  const taken = await admit(
    EMPTY_PUBLIC_FILE,
    envelopes,
    expectedBook,
    crypto,
    now,
    blocked,
    { breathe: () => breathe(MAX_TASK_MS), live: () => true },
    null,
  )
  /* `admit` answers `null` only for a cancelled load, and nothing cancels
     this one — `live` is a constant. A fallback stood here and could never be
     reached, and what it answered was an EMPTY store: the one answer this file
     exists never to give for bytes it holds. */
  const { lines: verified, refused: refusedReading, unreadableAt } = taken!
  /* ⚠️ **FOLDED AS HELD, BECAUSE IT IS — IT WAS FOLDED AS ARRIVING, AND A
     WITHDRAWN NOTE CAME BACK.** The fold lengthens a withdrawal's life to the
     note it takes back only for a note it already HOLDS, never for one arriving
     beside it (`surviving` says why), and a reload handed it every stored line
     as an arrival. So a withdrawal past its own expiry was forgotten on the
     first reload while its note was valid for months, and drawn; the next write
     then deleted the withdrawal from disk (2026-09-14). */
  const file = foldPublic({ ...EMPTY_PUBLIC_FILE, kept: verified.map(keptOf), equivocated: remembered }, [], now)
  const refused = withForgotten(refusedReading, verified, file)
  /* What is DRAWN is still bounded, by `keepWithin` — the one rule for what a
     book retains — so a store this build did not write cannot show more than a
     book holds. It bites on nothing `writePublic` wrote, and it bounds only the
     drawing: `kept` stays whole, because what the book RETAINS is the write's
     decision, made by the same rule. */
  const drawn = new Set(keepWithin(file.held).map((one) => one.received))
  const held = file.held.filter((one) => drawn.has(one.received))
  const undrawn = file.held.length - held.length
  return {
    file: { ...file, held },
    refused: undrawn > 0 ? addUp(refused, { full: undrawn }) : refused,
    unreadable: unreadableAt.map((at) => stored[storedAt[at]!]!),
  }
}

/** A file's lines as views of its bytes, split at the newline byte, the blank ones dropped. */
function linesOf(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  let start = 0
  /* Ended by the search finding no newline, not by `start < bytes.length`: that
     bound gave a file ending in a newline one more pass that nothing could tell
     from none, so a change to it could not be told apart either (2026-09-14
     mutation sweep). */
  for (;;) {
    const end = bytes.indexOf(0x0a, start)
    const stop = end === -1 ? bytes.length : end
    if (stop > start) out.push(bytes.subarray(start, stop))
    if (end === -1) return out
    start = end + 1
  }
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
  const taken = await admit(held, lines, expectedBook, crypto, now, blocked, pace, hasRoom)
  if (taken === null) return null
  const file = foldPublic(held, taken.lines, now)
  const encoder = new TextEncoder()
  return {
    file,
    refused: withForgotten(taken.refused, taken.lines, file),
    unreadable: taken.unreadableAt.map((at) => encoder.encode(lines[at]!)),
  }
}

/** What `admit` makes of a batch: the lines it took, and its unreadable lines named by POSITION. */
interface Admitted {
  /** Every line that verified and was taken, for the caller to fold. */
  readonly lines: readonly Delivered[]
  readonly refused: Readonly<Partial<Record<PublicRefusal, number>>>
  readonly unreadableAt: readonly number[]
}

/** A verified line as the fold keeps it — every field `KeptEnvelope` names, so one added there fails to compile here. */
const keptOf = ({ envelope, received }: Delivered): KeptEnvelope => ({
  received,
  voice: envelope.voice,
  pub: envelope.pub,
  seq: envelope.seq,
  at: envelope.at,
  expires: envelope.expires,
  op: envelope.op,
})

/**
 * `refused`, with every taken line the fold did not keep counted as `expired`.
 *
 * The fold lets a verified line go for one reason, its time, and only a
 * withdrawal can reach it past its own expiry: the envelope reader refuses such
 * a note itself, and leaves a withdrawal's to the fold — see there. So a late
 * withdrawal that takes back nothing held is reported as it was when the door
 * refused it.
 */
function withForgotten(
  refused: Readonly<Partial<Record<PublicRefusal, number>>>,
  taken: readonly Delivered[],
  file: PublicFile,
): Readonly<Partial<Record<PublicRefusal, number>>> {
  const kept = new Set(file.kept.map((one) => one.received))
  const forgotten = taken.filter((one) => !kept.has(one.received)).length
  return forgotten > 0 ? addUp(refused, { expired: forgotten }) : refused
}

/**
 * `takePublic`'s work, and `readPublic`'s — everything but the fold, which each
 * does its own way. It answers WHERE the unreadable lines were rather than
 * what they said, so each caller answers with the form of the line it holds —
 * `readPublic` the bytes that were stored, which a string cannot carry.
 */
async function admit(
  held: PublicFile,
  lines: readonly string[],
  expectedBook: string,
  crypto: PublicCrypto,
  now: number,
  blocked: (voice: string) => boolean,
  pace: { readonly breathe: () => Promise<void>; readonly live: () => boolean },
  /**
   * What a note must fit to be taken: `hasRoom` for a batch that ARRIVES, and
   * `null` for what this device already STORED — see `readPublic`.
   */
  room: typeof hasRoom | null,
): Promise<Admitted | null> {
  /* ⚠️ **ASKED BEFORE THE FIRST SLICE, NOT ONLY BETWEEN SLICES.** An already-
     cancelled batch of thirty-two lines or fewer was verified in full and
     returned as a success — measured by audit. The check after the last slice
     was missing for the same reason. */
  if (!pace.live()) return null
  let refused: Partial<Record<PublicRefusal, number>> = {}
  /* See `PublicRead.unreadable` for what is collected and what is not. */
  const unreadableAt: number[] = []
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
    // Stryker disable next-line ArithmeticOperator: an overlong last slice is cut by `slice` at the end of `lines`, and `at < lines.length` below stops the loop either way.
    const { take } = sliceFor(lines.length - at, VERIFY_PER_TASK)
    for (const [offset, line] of lines.slice(at, at + take).entries()) {
      const read = readPublicEnvelope(line, crypto, now, blocked)
      if (typeof read === 'string') {
        refused = tally(refused, read)
        if (read !== 'expired' && read !== 'blocked') unreadableAt.push(at + offset)
        continue
      }
      /* ⚠️ **THE BOOK IS CHECKED HERE AND NOWHERE ELSE COULD DO IT.** The
         signature proves who wrote the envelope; `envelope.book` is what says
         which book it is about, and only the caller knows which book's file
         this is. */
      if (read.envelope.book !== expectedBook) {
        refused = tally(refused, 'malformed')
        unreadableAt.push(at + offset)
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
         `bounds.ts`.

         ⚠️ **AND ONLY A NOTE TAKES ROOM — A WITHDRAWAL TOOK IT TOO.** Every line
         taken was added to what the bound weighs, so a withdrawal arriving
         ahead of a note in one batch refused that note from a book with room
         for it: the rule above, *capacity is about live notes*, broken inside
         a single batch (2026-09-14 mutation sweep). */
      if (read.envelope.op === 'note' && room !== null) {
        if (!room(admitted, sizeOf(read.received))) {
          refused = tally(refused, 'full')
          continue
        }
        admitted.push(asWeighed(read))
      }
      seen.add(read.received)
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
  return { lines: arriving, refused, unreadableAt }
}

const asWeighed = (one: Delivered) => ({ received: one.received, at: one.envelope.at })
const asWeighedKept = (one: KeptEnvelope) => ({ received: one.received, at: one.at })

/**
 * Nobody is silenced, for the one read that must not be filtered.
 *
 * Named rather than written inline, because `() => false` at a `blocked`
 * parameter reads as an oversight and this one is the opposite.
 */
// Stryker disable next-line ArrowFunction: its one reader asks `op === 'note' && blocked(voice)`, where `undefined` refuses exactly what `false` does.
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
  /* Assigned by the task below, and by nothing else: `appendShared` either runs
     it or rejects, and a rejection leaves here before this is read. An empty
     answer stood here as the value it started with, and nothing could see it. */
  let outcome!: PublicRead
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
    /* `null` only for a cancelled batch, and nothing cancels this one. The
       fallback that stood here could never be reached, and it would have
       written the store WITHOUT what arrived and answered as if it had. */
    const taken = (await takePublic(standing, arriving, expectedBook, crypto, now, blocked, {
      breathe: () => breathe(MAX_TASK_MS),
      live: () => true,
    }))!
    const file = taken.file
    let refusedHere: Partial<Record<PublicRefusal, number>> = {}
    /* Trimmed at the boundary as well as at the fold: `keepWithin` is the one
       rule for what a book retains, and a writer that skipped it would put a
       file on disk the reader could never load under the bounds.

       ⚠️ **"SUPPRESSION LINES ARE NOT TRIMMED" STOOD HERE, AND EVERY CLASS BELOW
       IS BOUNDED NOW.** Evidence untrimmed was a class one stranger could grow
       until the store refused every write — withdrawals first, then both sides
       of every equivocation, then a note's own withdrawals (2026-09-14). Each
       is trimmed by the rule that keeps what it is FOR, and the bounds below say
       which. */
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
    /* ⚠️ **EVERY SPELLING AT AN EQUIVOCATED SEQUENCE, WHICHEVER OPERATION — A
       WITHDRAWAL THERE WAS TRIMMED AS AN ORPHAN.** The newest orphan goes first,
       so under a full orphan room the withdrawal was let go and the note it
       equivocated with was drawn as honest (2026-09-14). */
    const conflicts = file.kept.filter((one) => equivocating.has(sequenceKeyOf(one)))
    const notes = file.kept.filter(
      (one) => one.op === 'note' && !equivocating.has(sequenceKeyOf(one)) && !onlySaid(one),
    )
    /* ⚠️ **WHAT IS DRAWN TAKES THE NOTE BOUND FIRST, AND IT USED TO SHARE IT WITH
       WHAT IS WITHDRAWN.** Admission weighs the notes a reader SEES — a book of
       withdrawn publications shows nothing, so a new note is taken — and the
       trim weighed every note kept, withdrawn ones included, and let the newest
       go. That was the note just admitted: the write reported it held, the disk
       held nothing, and no refusal named it (2026-09-14). The two weigh the same
       set now, so a note this write takes is a note this write keeps. */
    const drawn = new Set(file.held.map((one) => one.received))
    const live = notes.filter((one) => drawn.has(one.received))
    const written = keepWithin(live.map(asWeighedKept)).map((one) => byLine(live, one))
    /* A note an `unnote` took back is kept for the horizon it lends the
       withdrawal — see `onlySaid` — so it is evidence rather than an annotation,
       and it keeps what room the drawn notes leave rather than room of its own.
       One per publication: the fold takes the LATEST expiry of the notes under a
       key, so a second adds nothing to the horizon. */
    const heldBytes = written.reduce((sum, one) => sum + sizeOf(one.received), 0)
    const longestNote = new Map<string, KeptEnvelope>()
    for (const one of notes) {
      /* Withdrawn is enough: the fold draws no note under a key it has a
         withdrawal for, so asking whether this one is drawn as well asked
         nothing — no test could tell the two apart (2026-09-14 sweep). */
      if (!withdrawn.has(publicationKeyOf(one))) continue
      const standing = longestNote.get(publicationKeyOf(one))
      if (standing === undefined || one.expires > standing.expires) longestNote.set(publicationKeyOf(one), one)
    }
    const suppressed = [...longestNote.values()]
    const keptSuppressed = keepWithin(suppressed.map(asWeighedKept), {
      ...DEFAULT_PUBLIC_BOUNDS,
      heldPerBook: MAX_HELD_PER_BOOK - written.length,
      heldBytesPerBook: MAX_HELD_BYTES_PER_BOOK - heldBytes,
    }).map((one) => byLine(suppressed, one))
    if (keptSuppressed.length < suppressed.length) {
      refusedHere = tally(refusedHere, 'full')
    }
    /* ⚠️ **SUPPRESSION LINES ARE BOUNDED, AND THEY USED TO BE UNBOUNDED.**
       Keeping every withdrawal was right about the DANGER — evicting one lets a
       withdrawn note come back — and wrong about the cost: nothing capped them,
       so twelve thousand valid withdrawals took the file past
       `MAX_STORED_BYTES_PER_BOOK` and every later read refused it WHOLE.
       Reproduced by audit. That trades a bounded loss for a total one: an
       unreadable file loses every real suppression as well as the junk, and it
       never recovers, because a file does not shrink by being refused.

       So the trim is ordered by what a suppression is FOR. One that matches a
       note this write keeps is doing its job and is never dropped — which
       covers every withdrawal a reader makes of their own work, since their
       note is right there. One that matches nothing is guarding against a
       replay of something never seen; those are what an attacker can mint
       without limit, and those are what goes first.

       ⚠️ **AND "A NOTE THIS DEVICE HOLDS" WAS ONE IT HELD BEFORE THE TRIM, AND
       EVERY WITHDRAWAL OF IT WAS KEPT.** A store holding more notes than this
       build retains — another build's — made a withdrawal of each of them
       untrimmable at once; and a voice could sign any number of withdrawals of
       ONE of its own notes at fresh sequences, all untrimmable. Both were
       classes a stranger could grow until every write was refused. So it is a
       note the write KEEPS, and one withdrawal per note: one takes a note back
       as well as any number (2026-09-14). */
    const keeps = new Set([...written, ...keptSuppressed].map((one) => publicationKeyOf(one)))
    /* ⚠️ **AND THE ONE KEPT IS THE ONE THAT FORGETS LAST, NOT THE ONE SEEN
       FIRST.** Which withdrawal survives decides how long the publication stays
       suppressed once the note it took back has expired, so keeping a shorter
       horizon over a longer one let a fresh note under that id be drawn while
       the withdrawal thrown away was still in force (2026-09-14). */
    const longestTakeBack = new Map<string, KeptEnvelope>()
    const orphans: KeptEnvelope[] = []
    for (const one of file.kept) {
      if (one.op !== 'unnote' || equivocating.has(sequenceKeyOf(one))) continue
      const key = publicationKeyOf(one)
      if (!keeps.has(key)) {
        orphans.push(one)
        continue
      }
      const standing = longestTakeBack.get(key)
      if (standing === undefined || one.expires > standing.expires) longestTakeBack.set(key, one)
    }
    const suppressing = [...longestTakeBack.values()]
    /* Oldest first, and the oldest KEPT — the direction `keepWithin` keeps in,
       and for its reason: a flood of new ones is what goes, and what the book
       already had survives. (This said "the ones with least of their horizon
       left go first", which is the opposite of what the line below does.) */
    const roomForOrphans = Math.max(0, MAX_SUPPRESSIONS_PER_BOOK - suppressing.length)
    const keptOrphans = [...orphans].sort((a, b) => a.at - b.at).slice(0, roomForOrphans)
    if (keptOrphans.length < orphans.length) {
      refusedHere = tally(refusedHere, 'full')
    }
    const evidence = evidenceWithin(conflicts)
    if (evidence.length < conflicts.length) {
      refusedHere = tally(refusedHere, 'full')
    }
    const kept = [...suppressing, ...keptOrphans, ...evidence, ...keptSuppressed, ...written]
    /* The sequences this book remembers as equivocated, longest to run kept
       first — see `MAX_CONFLICTS_PER_BOOK` — and written in that order. Two
       devices holding the same conflicts still write the same bytes: the fold
       hands them over in key order, and a sort keeps that order among equals.
       (A second sort by key stood here for that, and no test could hear it.) */
    const remembered = [...file.equivocated].sort((a, b) => b.until - a.until).slice(0, MAX_CONFLICTS_PER_BOOK)
    if (remembered.length < file.equivocated.length) {
      refusedHere = tally(refusedHere, 'full')
    }
    /* ⚠️ **AND THE STORED LINES THIS BUILD COULD NOT READ GO BACK AS THEY WERE —
       THIS WROTE `kept` ALONE, SO IT DELETED THEM.** `current` is a read of this
       device's own file, and every line a write ADDS to it was verified first,
       so one that no longer reads is damage or another build's — a newer
       envelope version, a stricter check, the content hash of an earlier
       edition — or was carried back by an earlier write for that reason, and
       never a stranger's: those are refused on ARRIVAL, in `taken`, and
       nothing here carries them. A file holding
       `broken stored bytes` became an empty one on the reader's next "Look for
       some" (2026-09-13 verify). REFUSING THE WRITE was the other answer, and it
       costs what this does not: a withdrawal arriving for that book could never
       be kept, so a note its author took back would stay on screen. "As they
       were" is their BYTES: `current.unreadable` is what the read found on
       disk, not a decoding of it — see `readPublic`.

       ⚠️ **AND THIS SAID THEY WERE "COUNTED IN THE BYTE BOUND BELOW, SO A STORE
       THEY FILL REFUSES LOUDLY" — AND WHAT IT REFUSED WAS A WITHDRAWAL.** Weighed
       beside `kept`, a file they filled threw at the bound, and the author's
       take-back was lost to bytes this build cannot even read (2026-09-14
       verify). The bound cannot give — the read gate refuses a file over it
       whole and for good — so when the two conflict, what this build READS
       wins: a withdrawal only ever removes what is drawn, an equivocation side
       is what keeps a liar from looking honest, and a line this build cannot
       read changes nothing it draws. They are carried in the room left over,
       each weighed on its own and in stored order — `continue`, never `break`,
       for the admission loop's reason — and one that does not fit is let go
       and counted as `full`. Refusing was not the smaller loss: a file does not
       shrink by being refused, so a store they filled refused every arrival
       for good. */
    const encoder = new TextEncoder()
    /* A READABLE line is written from its envelope, so a byte-order mark that
       stood in front of one is not written back. The envelope was verified with
       the mark stripped, so the mark was never part of what was signed; only a
       line this build could NOT read keeps its bytes exactly — see
       `PublicRead.unreadable`. */
    const lines: Uint8Array[] = [
      ...(remembered.length > 0 ? [encoder.encode(conflictsLine(remembered))] : []),
      ...kept.map((one) => encoder.encode(one.received)),
    ]
    /* ⚠️ **A NEWLINE SEPARATES TWO LINES; THE ONE AT THE END TERMINATES THE FILE,
       AND COUNTING IT AS ANOTHER SEPARATOR EMPTIED A STORE.** A file of exactly
       the bound that ended WITHOUT a newline holds one line this build cannot
       read — weighed with a newline of its own it no longer fitted, so the write
       let it go and the store became nothing (2026-09-14). `linesOf` reads a
       final line with no newline after it, so the terminator is written only
       when there is room for it. */
    const spanOf = (all: readonly Uint8Array[]): number =>
      all.reduce((sum, line) => sum + line.length, 0) + Math.max(0, all.length - 1)
    let size = spanOf(lines)
    /* ⚠️ **WHAT THIS DEVICE WRITES, THIS DEVICE MUST BE ABLE TO READ — AND THE
       GUARD THAT SAID SO HERE COULD NO LONGER BE REACHED.** The read gate refuses
       an oversized file whole and permanently, so a writer that can exceed it is
       a writer that can brick a book, and this threw at the write when `size`
       passed the bound. Every class above is bounded now — notes by
       `keepWithin`, withdrawals by the shared cap, evidence by its own — and
       their widest sum is under the bound whatever the lines hold, so the throw
       was dead, and a dead assertion is one nothing checks. The sum is checked
       where a bound that grows fails at once: `publicStore.test.ts`, "retains no
       more than its own reader accepts" (2026-09-14). The lines carried below
       are fitted into what is left. */
    const carried: Uint8Array[] = []
    for (const line of current.unreadable) {
      const next = size + (lines.length > 0 ? 1 : 0) + line.length
      if (next > MAX_STORED_BYTES_PER_BOOK) {
        refusedHere = tally(refusedHere, 'full')
        continue
      }
      lines.push(line)
      carried.push(line)
      size = next
    }
    const terminated = lines.length > 0 && size + 1 <= MAX_STORED_BYTES_PER_BOOK
    const bytes = new Uint8Array(size + (terminated ? 1 : 0))
    let at = 0
    for (const [index, line] of lines.entries()) {
      if (index > 0) {
        bytes[at] = 0x0a
        at += 1
      }
      bytes.set(line, at)
      at += line.length
    }
    /* The terminator, when the file was sized with room for it; otherwise `at`
       is already the file's length and this writes nothing. Asked as a
       condition, the question was one no test could hear: a byte written past
       a typed array's end is silently dropped. */
    bytes.fill(0x0a, at)
    await atomicWrite(fs, publicPathIn(bookId), bytes)
    /* ⚠️ **SPREADING OVERWROTE MATCHING COUNTS INSTEAD OF ADDING THEM.** One
       malformed line already on disk plus one malformed line arriving reported
       `{ malformed: 1 }` — the later map simply replaced the earlier value, so
       every tally that mattered under-reported exactly when there was most to
       report. Reproduced by audit. */
    /* ⚠️ **AND WHAT IT CARRIED, NOT WHAT IT FOUND.** `unreadable` was the read's
       whole list, the lines let go for room included, so this answer and the file
       disagreed by exactly what did not fit — found by the 2026-09-14 verify. */
    outcome = { file, refused: addUp(current.refused, taken.refused, refusedHere), unreadable: carried }
  })
  return outcome
}

/** The kept envelope a weighed row came from. */
const byLine = (kept: readonly KeptEnvelope[], one: Weighed): KeptEnvelope =>
  kept.find((held) => held.received === one.received)!

/**
 * The equivocation evidence a book keeps: whole sequences, oldest first, while
 * they fit `MAX_EVIDENCE_BYTES_PER_BOOK` — see there for the bound and why a
 * sequence goes whole or not at all.
 *
 * A sequence is as old as its OLDEST spelling. `continue`, never `break`, for
 * `keepWithin`'s reason: a later, smaller sequence can still fit. Ties keep the
 * order the fold sorted `kept` in, which every device agrees on.
 */
function evidenceWithin(conflicts: readonly KeptEnvelope[]): KeptEnvelope[] {
  const bySequence = new Map<string, KeptEnvelope[]>()
  for (const one of conflicts) {
    const key = sequenceKeyOf(one)
    const spellings = bySequence.get(key)
    if (spellings === undefined) bySequence.set(key, [one])
    else spellings.push(one)
  }
  /* A fold, not `Math.min(...spread)`: one voice can sign any number of spellings of one sequence. */
  const oldestOf = (spellings: readonly KeptEnvelope[]): number =>
    spellings.reduce((oldest, one) => Math.min(oldest, one.at), Number.POSITIVE_INFINITY)
  const kept: KeptEnvelope[] = []
  let bytes = 0
  for (const spellings of [...bySequence.values()].sort((a, b) => oldestOf(a) - oldestOf(b))) {
    const size = spellings.reduce((sum, one) => sum + sizeOf(one.received), 0)
    if (bytes + size > MAX_EVIDENCE_BYTES_PER_BOOK) continue
    bytes += size
    kept.push(...spellings)
  }
  return kept
}

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
