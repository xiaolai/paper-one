/**
 * What holding strangers' annotations may cost a reading machine — WI-26.7.
 *
 * ⚠️ **TRAFFIC LIMITS ARE NOT STORAGE LIMITS**, and phase 25's machine-wide
 * byte allowance is a traffic limit. It bounds what this device SERVES; it says
 * nothing about what this device KEEPS, how much work a load costs the main
 * thread, or how long the reader waits for their own note to save.
 *
 * ## The adversary, stated
 *
 * ⚠️ **THE FIRST DRAFT SAID "A LEGITIMATE VOICE IS NOT STARVED", WHICH HAS NO
 * MEANING.** An unbound legitimate voice and an unbound attacker voice carry
 * IDENTICAL evidence — that is what "unbound" means — so no rule can prefer
 * one. Arrival-order eviction is displaced continuously by fresh arrivals, so
 * "keep the newest" is "keep the attacker's".
 *
 * The adversary this file is written against: **an attacker with unlimited
 * keys, unlimited publication ids and a fast uplink, who wants the reader's own
 * writing to become slow or to fail.** What is defended is the READER'S work —
 * opening a book, editing a private note, cancelling a load — and what is
 * conceded is that a flood can fill the public quota with its own annotations.
 * There is no version of this where it cannot; a bulletin board anybody may
 * write to is one anybody may fill.
 *
 * So the bounds below cap RETAINED bytes and files, PENDING work, and the
 * longest single task — and every one of them is a number a test can be inside.
 *
 * ## A byte budget is counted in BYTES
 *
 * ⚠️ **`string.length` IS UTF-16 CODE UNITS AND IS NOT A BYTE COUNT.** Every
 * bound in this file whose name ends in `Bytes` is compared against
 * {@link byteLengthOf}, never against `.length`. The two agree exactly on
 * ASCII, which is why the mistake survives every test written in English: a
 * Chinese character is one unit and THREE bytes, so a store admitted as inside
 * 4 MiB can be three times that on disk. `publicStore`'s read gate measures
 * UTF-8, so the next read then refuses the whole file as oversized — and
 * refuses it permanently, because the file never gets smaller by being read.
 *
 * `AGENTS.md` records the same confusion from the other direction: a Chinese
 * passage refused as unsendable because a size in bytes was checked against a
 * limit counted in characters. One rule, both ways: measure the unit you named.
 */
import { byteLengthOf } from './envelope'

/** The most public annotations one book retains on this device. */
export const MAX_HELD_PER_BOOK = 512

/** The most bytes one book's public annotations occupy on this device. */
export const MAX_HELD_BYTES_PER_BOOK = 2 * 1024 * 1024

/**
 * The most books that hold public annotations at all.
 *
 * ⚠️ **DECLARED AND NEVER READ, WHICH IS A LIMIT THAT DOES NOT EXIST.** Found
 * by audit: nothing consulted `booksWithPublic`, so the claimed device-wide
 * storage bound was a constant. `admitsAnotherBook` is what a caller asks, and
 * `publicPort` asks it before a book acquires public storage for the first
 * time — the one moment at which refusing costs nothing already stored.
 */
export const MAX_BOOKS_WITH_PUBLIC = 2_000

/**
 * The most envelopes verified in one pass before yielding.
 *
 * ⚠️ **SIGNATURE VERIFICATION IS NEW MAIN-THREAD WORK BEFORE ANCHORING EVEN
 * STARTS**, and it is synchronous by design — `checkPage`'s cheap-first
 * ordering only exists because the whole check is one function. A load of a
 * thousand envelopes is a thousand Ed25519 verifications in one task, which is
 * a frame the reader loses.
 */
export const VERIFY_PER_TASK = 32

/**
 * The most marks re-anchored before yielding.
 *
 * ⚠️ **THE RE-ANCHOR PASS YIELDS BETWEEN SECTIONS AND ITS INNER MARK LOOP DOES
 * NOT.** With the circle's handful of friends that was a short loop; with
 * public annotations the same loop is however many a flood published, in one
 * uninterruptible task, per section.
 */
export const ANCHOR_PER_TASK = 64

/**
 * The longest a single public task may hold the main thread, in ms.
 *
 * Handed to the kernel's `breathe`, which is what `publicStore` yields with
 * between slices — so this is a budget something spends, not a number written
 * down beside one.
 */
export const MAX_TASK_MS = 16

/* ⚠️ **`MAX_CANCEL_MS = 100` STOOD HERE AND NOTHING COULD ENFORCE IT.** It
   claimed a cancelled public load stops doing work within 100 ms; nothing read
   it, no test measured it, and no test could — a millisecond bound on an
   unknown machine measures the machine. What IS enforced is stronger and
   cheaper to state: a cancelled load stops after AT MOST ONE SLICE, because
   `live()` is checked immediately after every `breathe()` and a slice is
   `VERIFY_PER_TASK` envelopes bounded by {@link MAX_TASK_MS}.
   `load.test.ts`'s *"a cancelled public load stops within one slice"* counts
   the slices rather than timing them, and says so in as many words. A constant
   nobody reads is a guarantee nobody keeps. Found by audit. */

/** Everything above, together, so a caller states them all or takes them all. */
export interface PublicBounds {
  readonly heldPerBook: number
  readonly heldBytesPerBook: number
  readonly booksWithPublic: number
  readonly verifyPerTask: number
  readonly anchorPerTask: number
}

export const DEFAULT_PUBLIC_BOUNDS: PublicBounds = {
  heldPerBook: MAX_HELD_PER_BOOK,
  heldBytesPerBook: MAX_HELD_BYTES_PER_BOOK,
  booksWithPublic: MAX_BOOKS_WITH_PUBLIC,
  verifyPerTask: VERIFY_PER_TASK,
  anchorPerTask: ANCHOR_PER_TASK,
}

/**
 * Refuse a bounds record that is not one, before anything is compared to it.
 *
 * ⚠️ **A `NaN` LIMIT DISABLES THE CHECK IT NAMES, SILENTLY AND IN THE UNSAFE
 * DIRECTION.** `bytes + size > NaN` is `false` and `kept.length >= NaN` is
 * `false`, so a bounds record with one bad number does not trim at all — the
 * trimmer runs, reports success, and keeps everything. Every other count in
 * this file is refused when it is not a count (`sliceFor`, `hasRoom`,
 * `admitsAnotherBook`), and the record those functions take was the one thing
 * nobody checked. Found by audit.
 *
 * Callers pass `DEFAULT_PUBLIC_BOUNDS` in production; a bad record can only
 * come from a test or a future caller building one, which is exactly who a
 * throw is for.
 */
function checked(bounds: PublicBounds): PublicBounds {
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`public: ${name} is not a bound: ${String(value)}`)
    }
  }
  return bounds
}

/** What a batch may do before it has to yield or stop. */
export interface Allowance {
  /** How many of `count` may be taken now. */
  readonly take: number
  /** Whether there is more after that. */
  readonly more: boolean
}

/**
 * How much of a batch one task may do.
 *
 * A function rather than a constant at each call site, so the two loops that
 * need slicing — verification and re-anchoring — cannot drift about what a
 * batch means.
 */
export function sliceFor(count: number, perTask: number): Allowance {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`public: not a count: ${count}`)
  if (!Number.isSafeInteger(perTask) || perTask < 1) throw new RangeError(`public: not a batch size: ${perTask}`)
  const take = Math.min(count, perTask)
  return { take, more: count > take }
}

/** One held annotation, as the trimmer weighs it. */
export interface Weighed {
  readonly received: string
  /** When the voice said it published — the only ordering there is. */
  readonly at: number
}

/**
 * Which of a book's public annotations to keep.
 *
 * ⚠️ **THE OLDEST-FIRST ORDER IS DELIBERATE AND IT IS NOT "FAIR".** With free
 * keys nothing can be fair, so the choice is between two unfair rules and the
 * question is which failure the reader prefers. Keeping the NEWEST means a
 * flood evicts everything a reader has been reading, continuously, which is
 * the attacker's goal handed to them. Keeping the OLDEST means a flood is
 * mostly refused on arrival and what the reader already had survives — and the
 * cost, stated, is that a genuinely new annotation on a full book is dropped
 * until something expires.
 *
 * Expiry is what makes that survivable: every envelope has a signed lifetime
 * (WI-26.3), so a full book empties on its own rather than needing a policy.
 */
export function keepWithin(held: readonly Weighed[], bounds: PublicBounds = DEFAULT_PUBLIC_BOUNDS): readonly Weighed[] {
  checked(bounds)
  /* ⚠️ **THE TIE-BREAK IS CODE UNITS, NOT A COLLATION.** This was
     `localeCompare`, which makes what a device RETAINS depend on the device's
     locale — two readers holding the same envelopes evict different ones — and
     which reports `0` for strings a collation considers equivalent but that
     are not equal, leaving those two in input order and so in whatever order
     an attacker delivered them. `<` on a JSON string is a total order that is
     the same everywhere. Found by audit. */
  const oldest = [...held].sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at
    if (a.received === b.received) return 0
    return a.received < b.received ? -1 : 1
  })
  const kept: Weighed[] = []
  let bytes = 0
  for (const one of oldest) {
    if (kept.length >= bounds.heldPerBook) break
    const size = sizeOf(one.received)
    /* ⚠️ **`continue`, NOT `break` — ONE FAT ENVELOPE STOPPED THE TRIM DEAD.**
       The first annotation that did not fit ended the scan, so everything
       older-but-smaller after it was discarded too: a single near-limit
       envelope early in the order threw away a book's worth of notes that
       would each have fitted. The count bound above IS a `break`, and
       correctly — nothing later can fit under a count that is already full,
       whereas something later can always fit under a byte budget. `publicStore`
       had this same keyword wrong on the admission path; this is the trimming
       half of one defect. Found by audit. */
    if (bytes + size > bounds.heldBytesPerBook) continue
    bytes += size
    kept.push(one)
  }
  return kept
}

/**
 * Whether this device may start holding public annotations for another book.
 *
 * ⚠️ **ASKED WHERE A BOOK FIRST ACQUIRES PUBLIC STORAGE, NOT PER ANNOTATION.**
 * A per-annotation check would refuse the five-hundredth note in a book that is
 * already counted, which is the wrong bound in the wrong place; what this
 * bounds is how many book folders end up with a `public.jsonl` at all.
 */
export function admitsAnotherBook(booksHeld: number, bounds: PublicBounds = DEFAULT_PUBLIC_BOUNDS): boolean {
  /* ⚠️ **A COUNT THAT IS NOT A COUNT THROWS, AND ANSWERING `false` WOULD HAVE
     BEEN THE SAFE DIRECTION AND STILL WRONG.** `admitsAnotherBook(undefined)`
     is `undefined < 2000`, which is `false` — a refusal, so nothing unsafe
     happens, and a test asserting the refusal PASSES while measuring nothing.
     That is exactly how the missing barrel export for `MAX_BOOKS_WITH_PUBLIC`
     survived its own probe. `sliceFor` above refuses a bad count for the same
     reason; the pair of them is the rule. */
  if (!Number.isSafeInteger(booksHeld) || booksHeld < 0) throw new RangeError(`public: not a count: ${booksHeld}`)
  return booksHeld < checked(bounds).booksWithPublic
}

/**
 * Whether one more annotation would take this book past its bounds.
 *
 * ⚠️ **`incoming` IS UTF-8 BYTES, AND CALLERS MUST MEASURE IT AS SUCH.** It is
 * a bare number, so nothing in the type system stops a caller passing
 * `received.length`; {@link sizeOf} is the measure to hand it, and a
 * non-integer throws here rather than silently comparing `NaN`.
 */
export function hasRoom(held: readonly Weighed[], incoming: number, bounds: PublicBounds = DEFAULT_PUBLIC_BOUNDS): boolean {
  if (!Number.isSafeInteger(incoming) || incoming < 0) throw new RangeError(`public: not a byte count: ${incoming}`)
  checked(bounds)
  /* ⚠️ **THE COUNT IS ASKED FIRST, AND THAT IS WHAT BOUNDS THE COST.** The sum
     below re-encodes every held envelope, and this is called once per arriving
     line — so a full book asked about twenty thousand arrivals used to pay
     512 encodings each time. Once the file bound is reached the answer is `no`
     without touching the bytes, which is what lets the caller keep scanning
     for withdrawals instead of abandoning the batch. */
  if (held.length >= bounds.heldPerBook) return false
  /* ⚠️ **`sizeOf`, NOT `byteLengthOf` — THE SEPARATOR HAS TO BE ON BOTH SIDES
     OR THIS IS A SECOND MEASURE.** `keepWithin` counts a held line as its
     envelope plus its newline; this counted the envelope alone, so a book the
     trimmer considered full still had room here. One measure, which is what
     `sizeOf`'s own comment says it is for. */
  const bytes = held.reduce((total, one) => total + sizeOf(one.received), 0)
  return bytes + incoming <= bounds.heldBytesPerBook
}

/**
 * What one received envelope costs this book's store, in the unit the bounds
 * are named in.
 *
 * ⚠️ **THE ONE MEASURE, SO THERE CANNOT BE A SECOND.** `hasRoom` takes a bare
 * number and `keepWithin` computes its own; before this they disagreed with
 * each other and with `publicStore`'s read gate, which is how a store could be
 * admitted at one size and refused at another. Callers ask this rather than
 * reaching for `.length`.
 */
export function sizeOf(received: string): number {
  /* ⚠️ **PLUS THE SEPARATOR, BECAUSE THE FILE IS JSONL AND THE LINE COSTS ONE
     MORE BYTE THAN THE ENVELOPE DOES.** `publicStore` writes `lines.join('\n')`
     with a trailing newline, so a book at exactly `heldBytesPerBook` by the
     old measure was `heldPerBook` bytes larger on disk. The read gate is twice
     the retention bound and absorbed it, which is why nothing ever failed —
     and a bound that is quietly wrong by a bounded amount is still a bound
     measuring something other than what it is named for. Found by audit. */
  return byteLengthOf(received) + 1
}
