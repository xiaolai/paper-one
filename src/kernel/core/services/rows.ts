import type { IndexedBook } from '../bookIndex'
import type { Card } from '../cards'
import type { Mark } from '../marks'
import type { TrashedBook } from '../bookTrash'

/**
 * The shapes that cross the wire (phase 11, WI-11.3).
 *
 * PROJECTIONS, not the stored records handed out. Two reasons, and only one
 * of them is tidiness.
 *
 * The first is DEVICE-LOCAL FIELDS. `origin` is where a book was imported
 * from on THIS machine and `ext` is how this copy happens to be stored;
 * `DEVICE_LOCAL_FIELDS` names them, and everything that replicates a book
 * already strips them. A row served to a peer must strip them too — a macOS
 * path is meaningless on a phone and is the reader's filesystem, and `format`
 * is the field that carries the same meaning across devices. A caller that
 * wants to know about THIS device's copy asks `content.locate`, which is the
 * noun for it.
 *
 * The second is that a published shape must be able to stay still while the
 * stored one moves. `IndexedBook` gains a field whenever the shelf needs one;
 * a wire row gains one when a caller is promised it.
 */

/* ------------------------------------------- the closed domains, published
 *
 * A field whose values are a fixed vocabulary is DECLARED as that vocabulary
 * here, not widened to `string`.
 *
 * These were `string`, which made every invalid value look legal to a
 * consumer: a CLI switching on `mark.kind` had no compiler telling it a case
 * was missing, and a value that drifted apart from the domain's spelling could
 * not be caught anywhere but at runtime, on a peer's machine.
 *
 * SPELLED OUT rather than aliased to the internal union, because a published
 * shape must be able to stay still while the stored one moves — the whole
 * reason this file exists. The PROJECTORS below are what keep the two honest,
 * and they do it without a separate assertion: `markRow` reads a `MarkKind`
 * and writes a `MarkRowKind`, so a kind added to the domain and not published
 * here fails to compile on that line — at the point where the decision to
 * publish it belongs, rather than widening away silently. Retiring a published
 * value stays possible without touching the domain.
 *
 * Not applied to the stamps. `positionAt` and `finishedAt` are `Hlc` inside,
 * which is a BRANDED string minted only by a validator; a decoded payload has
 * not been through one, so publishing the brand would promise a check that the
 * wire never performed. `string` there is the honest type.
 */

/** What a mark IS. */
export type MarkRowKind = 'highlight' | 'companion' | 'bookmark'
/** A highlight's colour. */
export type MarkRowTint = 'yellow' | 'green' | 'purple'
/** How a highlight is drawn. */
export type MarkRowStyle = 'fill' | 'underline' | 'wave'
/** What a card IS. */
export type CardRowKind = 'Idea' | 'Claim' | 'Recall' | 'Synthesis' | 'Excerpt'
/** What a book's bytes ARE — the value that travels, unlike `ext`. */
export type BookRowFormat = 'epub' | 'pdf' | 'mobi' | 'azw3' | 'cbz' | 'fb2' | 'fbz' | 'bin'

/** A book, as `book.list` / `book.get` / `book.search` answer. */
export interface BookRow {
  readonly bookId: string
  readonly title: string
  readonly author: string
  readonly series: string | null
  readonly seriesIndex: number | null
  readonly publisher: string | null
  readonly published: string | null
  readonly languages: readonly string[]
  /** The publisher's own subjects. */
  readonly subjects: readonly string[]
  /** The reader's tags. */
  readonly tags: readonly string[]
  readonly position: string | null
  readonly progress: number
  readonly finished: boolean
  readonly addedAt: number | null
  readonly openedAt: number | null
  /** What the bytes ARE — the value that travels, unlike `ext`. */
  readonly format: BookRowFormat | null
  readonly contentHash: string | null
  /** Whether this device holds the bytes. Derived from the folder. */
  /**
   * Whether the bytes are on this device — or `null` when nothing has looked.
   *
   * Three states, because the storage model has three: present, absent, and
   * not yet measured. `hasContent === true` collapsed the third into "absent",
   * which reads as a definite answer and is not one. A satchel deciding
   * whether to offer Download cares about the difference.
   */
  readonly hasContent: boolean | null
}

export function bookRow(book: IndexedBook): BookRow {
  return {
    bookId: book.bookId,
    title: book.title,
    author: book.author,
    series: book.series ?? null,
    seriesIndex: book.seriesIndex ?? null,
    publisher: book.publisher ?? null,
    published: book.published ?? null,
    /* COPIED, not handed out by reference. These are the store's own arrays:
     * a caller that sorted or pushed to what it was given would be editing the
     * shelf in place, past every write queue and every journal bracket, and
     * the change would be invisible until the next write persisted it. */
    languages: [...(book.languages ?? [])],
    subjects: [...(book.subjects ?? [])],
    tags: [...(book.tags ?? [])],
    position: book.position ?? null,
    progress: book.progress ?? 0,
    finished: book.finished === true,
    addedAt: book.addedAt ?? null,
    openedAt: book.openedAt ?? null,
    format: book.format ?? null,
    contentHash: book.contentHash ?? null,
    /* THREE STATES, NOT TWO. `undefined` means the folder has not been
     * looked at — the storage model's documented "unknown" — and collapsing
     * it into `false` told a caller the bytes are definitely absent when
     * nothing had checked. A satchel deciding whether to offer Download reads
     * this, and "not here" and "nobody looked" call for different offers. */
    hasContent: book.hasContent ?? null,
  }
}

/**
 * One book in FULL — the shape `book.get` promises when the plan says "one
 * record by id, WITH ITS REGISTERS".
 *
 * The registers are the ledger's stamps: when the position last moved, when
 * `finished` was last decided, and the per-tag clock that makes two replicas'
 * tag lists mergeable. They are what a caller reconciling two devices needs
 * and what a caller listing a shelf does not — a tag clock is one entry per
 * tag the book has ever carried, so putting it on `BookRow` would pay for it
 * on every row of a 2 000-book listing to serve the one caller that asked for
 * one book.
 *
 * Absent on a phase-4 record, which has no clocked writer behind it; `null`
 * rather than missing, so a caller can tell "never stamped" from "not sent".
 */
export interface BookDetail extends BookRow {
  readonly positionAt: string | null
  readonly finishedAt: string | null
  readonly tagClock: Readonly<Record<string, { readonly on: boolean; readonly at: string; readonly spelling: string }>> | null
}

/** What `book.position` answers: the register it just wrote. */
export interface PositionSetRow {
  readonly bookId: string
  readonly position: string
  readonly progress: number
  /** The stamp the shelf gave the write — what another device compares against its own. */
  readonly positionAt: string | null
}

export function positionSet(book: IndexedBook): PositionSetRow {
  return {
    bookId: book.bookId,
    position: book.position ?? '',
    progress: book.progress ?? 0,
    positionAt: book.positionAt ?? null,
  }
}

export function bookDetail(book: IndexedBook): BookDetail {
  return {
    ...bookRow(book),
    positionAt: book.positionAt ?? null,
    finishedAt: book.finishedAt ?? null,
    /* ⚠️ **COPIED, NOT HANDED OVER.** This returned the store's own object by
     * reference, so an in-process caller — the CLI and every local handler go
     * through these projectors without an envelope in between — could mutate
     * the live clock outside the write queue. Every other field here is a
     * primitive and could not; this one is a map, which is the only reason it
     * was different, and being the only one is what made it easy to miss.
     *
     * ONE LEVEL DEEPER THAN THE MAP. Each entry is a record — `{ on, at,
     * spelling }` — so copying only the outer object hands the caller the same
     * entry objects and the mutation simply moves down a level. Every field
     * inside one is a primitive, so this is as deep as it needs to go. */
    tagClock: book.tagClock
      ? Object.fromEntries(Object.entries(book.tagClock).map(([tag, stamp]) => [tag, { ...stamp }]))
      : null,
  }
}

/**
 * A mark, as `mark.*` answer.
 *
 * The stored row is nearly the wire row — sync pushes whole marks — so this
 * pins the fields a caller is promised and drops TWO:
 *
 *   - `deletedAt` and `updatedAt` are the ledger's stamps. A read model never
 *     shows a tombstone, and a caller reconciling two devices asks sync, not
 *     `mark.list`.
 *
 * ⚠️ **`prefix` AND `suffix` ARE PUBLISHED, and this said they were dropped.**
 * The argument for withholding them — "a repair input, not a display field …
 * publishing them would roughly triple a mark row to serve nobody currently
 * asking" — stopped being true in phase 19, when the browser client became a
 * caller that CAN re-find a mark whose CFI no longer resolves and has no other
 * way to get the context. They are in the interface below and the projector
 * copies them; only this paragraph still said otherwise, which is the account
 * a reader of the wire contract would have trusted.
 */
export interface MarkRow {
  readonly id: string
  readonly bookId: string
  readonly cfi: string
  readonly sectionIndex: number
  readonly text: string
  /** The words either side of `text` — the mark's recovery context. Empty
   *  when the mark was made by a caller that did not know them. */
  readonly prefix: string
  readonly suffix: string
  readonly note: string
  readonly kind: MarkRowKind
  readonly tint: MarkRowTint
  readonly style: MarkRowStyle
  readonly chapter: string
  readonly createdAt: number
}

export function markRow(mark: Mark): MarkRow {
  return {
    id: mark.id,
    bookId: mark.bookId,
    cfi: mark.cfi,
    sectionIndex: mark.sectionIndex,
    text: mark.text,
    prefix: mark.prefix,
    suffix: mark.suffix,
    note: mark.note,
    kind: mark.kind,
    tint: mark.tint,
    style: mark.style,
    chapter: mark.chapter,
    createdAt: mark.createdAt,
  }
}

/** A card, as `card.*` answer. */
export interface CardRow {
  readonly id: string
  /**
   * The book this card came from, or `null` when it came from none.
   *
   * The STORE uses `''` for "no book"; the wire uses `null`, like every other
   * absent reference in this file. Publishing the sentinel made a caller learn
   * one field's private convention, and an empty string reads as "a book whose
   * id is empty" rather than "no book".
   */
  readonly bookId: string | null
  readonly kind: CardRowKind
  readonly body: string
  readonly answer: string
  readonly source: string
  readonly cfi: string | null
  readonly createdAt: number
}

export function cardRow(card: Card): CardRow {
  return {
    id: card.id,
    /* NULL, not the storage sentinel. The store uses `''` for a card that
     * belongs to no book, and every other absent reference on the wire is
     * `null` — so a caller had to know one field's private convention, and an
     * empty string reads as "a book whose id is empty" rather than "no
     * book". */
    bookId: card.bookId === '' ? null : card.bookId,
    kind: card.kind,
    body: card.body,
    answer: card.answer,
    source: card.source,
    cfi: card.cfi,
    createdAt: card.createdAt,
  }
}

/** A removed book, as `trash.list` answers. */
export interface TrashRow {
  readonly bookId: string
  readonly title: string
  readonly author: string
  readonly removedAt: number | null
  readonly expiresAt: number | null
}

export function trashRow(one: TrashedBook): TrashRow {
  return {
    bookId: one.bookId,
    title: one.title,
    author: one.author,
    removedAt: one.removedAt,
    expiresAt: one.expiresAt,
  }
}

/** Where a book's bytes are, as `content.locate` / `content.evict` answer. */
/**
 * A slice of a book's bytes (phase 18).
 *
 * **Base64, not a byte array.** The envelope's body is JSON, and a `Uint8Array`
 * through `JSON.stringify` becomes `{"0":80,"1":75,…}` — roughly eleven bytes
 * on the wire per byte of book. Base64 costs four bytes per three and is one
 * `atob` to undo.
 *
 * `offset` is echoed rather than inferred. A caller assembling a file from a
 * stream must be able to place a chunk without counting, because a stream that
 * ends early has to be detectable as short rather than silently truncating the
 * book.
 */
export interface ContentChunk {
  readonly bookId: string
  /** Where this slice starts in the file. */
  readonly offset: number
  /** The slice, base64. */
  readonly bytes: string
}

export interface ContentLocation {
  readonly bookId: string
  /** Whether THIS device holds the bytes. */
  readonly here: boolean
  /** How this copy is stored — device-local, and the one place it is told. */
  readonly ext: string | null
  readonly format: string | null
  /** BLAKE3, hex, when a hasher has run over it. */
  readonly contentHash: string | null
  /** Bytes, when the host can measure. Null is "nobody can say", not zero. */
  readonly size: number | null
}

/** A tag with how many books carry it, and whether any carries it as the
 *  reader's OWN tag rather than only as a publisher's subject. */
export interface TagCountRow {
  readonly tag: string
  readonly count: number
  readonly mine: boolean
}

/** What a write answered: what changed, and how much of it. */
export interface TagChange {
  readonly tag: string
  readonly books: number
}

/** What a removal answered. `bookId`/`id` names the thing, `removed` says
 *  whether there was one to remove — a removal of what is absent is done, not
 *  an error, and the caller is told which it was. */
export interface RemovedRow {
  readonly id: string
  readonly removed: boolean
}

/**
 * What `book.restore` answered.
 *
 * `restored` was the whole answer, and it could not tell a caller which of
 * three things happened: the trash held nothing, the book came back whole, or
 * it came back with part of itself still in the trash. `held` names what
 * stayed — empty on a complete restore — so "your book is back" is never said
 * over half a book. An I/O fault is not a row at all; it is a refusal.
 */
export interface RestoredRow {
  readonly bookId: string
  readonly restored: boolean
  /** File names still in the trash, because a live one already owns them. */
  readonly held: readonly string[]
}

/** What `trash.empty` destroyed. */
export interface EmptiedRow {
  readonly emptied: number
  readonly bookIds: readonly string[]
}

/** This device, as `shelf.status` answers. Every field a port would have
 *  filled is `null` when no port is bound, never zero. */
export interface ShelfStatus {
  readonly role: string | null
  readonly endpointId: string | null
  /**
   * How many books are on the shelf — or `null` when the shelf could not be
   * READ.
   *
   * This was a plain number, and a library whose index would not load reported
   * `books: 0`: the app converts a failed `loadShelf` into an empty snapshot
   * so the window can still open, and the kernel was never told. So the one
   * answer that means "everything is gone" and the one that means "nobody
   * could look" were the same answer, on the service a caller uses to decide
   * whether this device is healthy — and a satchel reading zero has every
   * reason to think the shelf was emptied.
   */
  readonly books: number | null
  readonly journalSeq: number | null
  readonly epoch: string | null
  readonly bytes: number | null
}
/* NO CARD COUNT, and this one is an authorization boundary rather than a cost.
 * `shelf.status` is granted by `shelf:read`; card metadata is protected by the
 * independent `card:read`. Reporting the count here handed a peer trusted only
 * with the shelf's health a number about a surface it was deliberately not
 * granted — and told it how that number moves, which is the reader's study
 * habits. The table's own summary never claimed it. A caller that wants the
 * count and holds the grant streams `card.list`. */
/* NO MARK COUNT, and the omission is deliberate. Marks live in book folders,
 * so counting them is one read per book — two thousand round trips on the
 * library WI-8.6 measured — which is not what a status call should cost. The
 * alternative, reporting what happens to be loaded, cannot tell "nothing has
 * read them yet" from "there are none": the snapshot has a `ready` flag for
 * the OPEN book only. `paper mark list --json | wc -l` is the honest answer,
 * and it is honest precisely because the caller chose to pay for it. */
