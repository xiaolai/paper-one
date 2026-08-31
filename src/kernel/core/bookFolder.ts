/**
 * A book is a folder.
 *
 * ```
 * $APPDATA/books/<bookId>/
 *   content.<ext>   the bytes
 *   book.json       everything the shelf needs
 *   cover.jpg       omitted when the book has no jacket (`cover.webp` in
 *                   libraries written before the name was made honest)
 *   marks.json      the reader's own writing
 * ```
 *
 * WHY, given phase 3 already worked. Because phase 3 spread one book across
 * three places that could disagree — a row in a flat store, bytes under
 * `books/`, a jacket under `covers/` — and its audit charged four bugs to
 * exactly that split: a copy written with no row referring to it, a book in the
 * vault whose row was gone and which stayed invisible because every later import
 * called it a duplicate, a cover left behind after removal, and a removal that
 * touched three places any of which could fail alone.
 *
 * None of those are expressible here. Not less likely — absent, because there is
 * nothing left for an index to disagree with. Removal is one rename. A duplicate
 * import has nowhere to go, because the folder name IS the content hash. And a
 * book is one directory to back up, replicate to a phone, or hand to somebody.
 *
 * The cost is that a shelf of 2,000 books cannot read 2,000 files to draw
 * itself, which is what `bookIndex` is for — and it is a CACHE. The folders are
 * the truth.
 */

import type { SyncLevel, VaultFs } from './bookVault'
import { extensionFor } from './bookVault'
import { isFormat, type Format, type NamedSource } from './formats'
import { compareHlc, hlcOf, isHlc, type Hlc } from './hlc'
import { TAG_MAX, normalizeTag, tagKey } from './tags'

export const BOOKS_DIR = 'books'
export const TRASH_DIR = 'trash'

/**
 * Which fields a parse writes into a record — bumped when that set GROWS.
 *
 * ⚠️ **THE BACKFILL MARKER, AND WITHOUT IT A NEW METADATA FIELD NEVER REACHES
 * AN EXISTING LIBRARY.** `needsEnrichment` is *"`parsedAt` absent is the whole
 * condition"*, so every book already parsed is skipped for ever. Adding
 * `identifier` to `recordFromMeta` therefore changed nothing at all for any
 * shelf that already existed — the pass had no reason to come back.
 *
 * A NUMBER, NOT A FLAG. The next field added to a parse has the same problem,
 * and a boolean can only be spent once. Bump this in the same change that adds
 * the field, and every record below the new number is re-parsed exactly once.
 *
 * | Schema | What a parse writes |
 * |---|---|
 * | 0 | Everything up to WI-21.3 — absent on a record written before this. |
 * | 1 | Adds `identifier` (`dc:identifier`), for WI-21.3. |
 */
export const META_SCHEMA = 1

/**
 * One tag's register in a record's tag clock: whether the tag is ON the book,
 * when that was last decided, and how the reader spells it. Keyed by
 * `tagKey(spelling)`, so two spellings of one tag are one register — which is
 * what lets an `off` written on a phone beat an `on` written earlier here.
 */
export interface TagClockEntry {
  readonly at: Hlc
  readonly on: boolean
  readonly spelling: string
}
export type TagClock = Readonly<Record<string, TagClockEntry>>

/**
 * The fields of a record that describe THIS DEVICE'S copy rather than the
 * book: where it was imported from, how the copy is named, whether the bytes
 * are here. A row that travels to another device must not carry them —
 * `toWire` (sync) strips exactly this list, and keeping the list beside the
 * record is what stops the two drifting apart. (`keepContent` and
 * `hasContent` are not stored in `book.json` today; they are here because a
 * serialised shelf row can carry them, and a wire row must not.)
 */
export const DEVICE_LOCAL_FIELDS = ['origin', 'ext', 'keepContent', 'hasContent'] as const

/**
 * The reader's tags, derived from a tag clock: the spellings of the registers
 * that are ON, in key order — deterministic, so two replicas that agree on
 * the clock agree on the list byte for byte.
 */
export function tagsFromClock(clock: TagClock): readonly string[] {
  return Object.keys(clock)
    .sort()
    .filter((key) => clock[key]!.on)
    .map((key) => clock[key]!.spelling)
}

/**
 * A record's tag REGISTERS: its clock when it has one, else its plain tags
 * synthesised at `hlcOf(addedAt)` — the documented legacy stamp, identical on
 * every replica for one record, which is what lets two phase-4 replicas union
 * their tags. One body for the sync merge (which imports this through the
 * public entry) and for the writers below; two copies of this derivation
 * would disagree the first time one was edited alone.
 */
export function tagRegisters(record: BookRecord): TagClock | undefined {
  if (record.tagClock) return record.tagClock
  if (!record.tags || record.tags.length === 0) return undefined
  const at = hlcOf(record.addedAt)
  /* Null prototype, `readTagClock`'s own rule: `__proto__` is a legal tag,
   * and on a plain `{}` it hits the prototype setter (losing the register)
   * while `key in clock` answers true for every inherited name. */
  const clock: Record<string, TagClockEntry> = Object.create(null) as Record<string, TagClockEntry>
  for (const spelling of record.tags) {
    const key = tagKey(spelling)
    if (key && !(key in clock)) clock[key] = { at, on: true, spelling }
  }
  return clock
}

/**
 * One tag decided, as a register write: the record with `spelling`'s register
 * set to `on` at `at`, its `tags` re-derived from the resulting clock. This
 * is how the Library's tag writers stamp (WI-C, "wire the composed clock"):
 * a plain-list edit would be invisible to the merge's LWW, so every tag
 * decision goes through the clock once a clocked writer exists. A record
 * with no clock has one synthesised first (`tagRegisters`), so the other
 * tags keep their legacy stamps and this one alone carries the new one.
 */
export function setTag(record: BookRecord, spelling: string, on: boolean, at: Hlc): BookRecord {
  const key = tagKey(spelling)
  if (!key) return record
  const held = tagRegisters(record) ?? {}
  /* THE SAME CAP THE READER APPLIES. `parseRecord` keeps `MAX_TAGS`
   * registers and drops the rest on the next read — so a write that grew
   * the clock past it succeeded, and the register silently vanished later.
   * A capacity error at the write is a failure the reader is shown. */
  if (!(key in held) && Object.keys(held).length >= MAX_TAGS) {
    throw new Error(`a record can carry at most ${MAX_TAGS} tag registers`)
  }
  const clock: Record<string, TagClockEntry> = { ...held, [key]: { at, on, spelling } }
  const tags = tagsFromClock(clock)
  const { tags: _replaced, ...rest } = record
  return { ...rest, tagClock: clock, ...(tags.length ? { tags } : {}) }
}

/** What `book.json` holds. Every field optional except the two a shelf needs. */
export interface BookRecord {
  /**
   * The book's canonical id, stored rather than inferred.
   *
   * A folder is named `safeId(bookId)`, which replaces every character outside
   * `[a-zA-Z0-9]` — so `book:abc` becomes `book_abc` and the mapping is NOT
   * reversible. Reading the id back off the directory name therefore renamed
   * every book on any rescan, and marks are keyed by it.
   *
   * Optional only because records written before this existed do not have it;
   * `scanBooks` falls back to the folder name for those, which is the same
   * wrong answer it always gave and no worse.
   */
  readonly bookId?: string
  readonly title: string
  readonly author: string
  /**
   * The WORK's own identifier, as the book declares it — `dc:identifier` in an
   * EPUB's OPF, usually a UUID or an ISBN (WI-21.3). Absent when the book
   * declares none, never empty.
   *
   * DISTINCT FROM `bookId`, AND BOTH ARE NEEDED. `bookId` is derived from the
   * bytes and says *this exact file*; this says *this book, whoever's copy*.
   * Anything that has to recognise a work across two downloads of it has to
   * key on the second, because two readers almost never hold byte-identical
   * files — and foliate has been parsing this all along while `recordFromMeta`
   * dropped it on the floor.
   *
   * `workKey.ts` is what turns it into something comparable. Read that before
   * comparing two of these directly: one build declares an ISBN-10 and another
   * the ISBN-13 for the same work, and as strings they do not match.
   */
  readonly identifier?: string
  readonly sortAs?: string
  readonly series?: string
  readonly seriesIndex?: number | null
  readonly publisher?: string
  readonly published?: string
  readonly languages?: readonly string[]
  /** The publisher's own subjects. Replaced whenever the book is re-parsed. */
  readonly subjects?: readonly string[]
  /** The reader's tags. NEVER replaced by a parse — see `writeBook`. */
  readonly tags?: readonly string[]
  readonly position?: string | null
  readonly progress?: number
  readonly finished?: boolean
  readonly addedAt?: number
  readonly openedAt?: number
  /**
   * When the PARSER last ran on this book — not when the parse succeeded.
   *
   * A book arrives on the shelf as a placeholder: an import writes a row from
   * the filename, because parsing three hundred books to learn three hundred
   * titles would make importing a folder as slow as reading one. Something has
   * to come back for the rest, and this is how it knows what it has already
   * been back for. Absent means never parsed.
   *
   * SET EVEN WHEN THE PARSE FAILS, which is the part worth stating plainly. A
   * file the parser cannot read will fail identically on every launch, and a
   * library holding five hundred of them would spend every launch failing on
   * all five hundred. Marking the attempt is what makes the pass converge.
   * Opening the book parses it again through the reader's own path, so a book
   * wrongly given up on is one click from being read properly — that is the
   * escape hatch, and it is why this may be a one-way door without being a
   * trap.
   */
  readonly parsedAt?: number
  /**
   * Which metadata schema the last parse wrote — see `META_SCHEMA`.
   *
   * ⚠️ **`parsedAt` CANNOT ANSWER THIS, AND THAT IS WHY THIS EXISTS.** It
   * records that the parser RAN, and `needsEnrichment` reads its absence as the
   * whole condition — so a library parsed before `identifier` was carried is
   * indistinguishable from a library whose books declare none, and no existing
   * shelf would ever acquire one. A number rather than a flag, because the next
   * field added to a parse has exactly this problem again.
   *
   * Absent means "parsed before this existed", which is schema 0.
   */
  readonly metaSchema?: number
  /**
   * Where this book was imported from, for provenance only.
   *
   * DEVICE-LOCAL — see `DEVICE_LOCAL_FIELDS`. A macOS path replicated onto
   * a phone is meaningless, so anything that syncs a book must strip it.
   */
  readonly origin?: string | null
  /** The content file's extension, so the reader can be handed a real name.
   *  DEVICE-LOCAL: how THIS copy is stored. What travels is `format`. */
  readonly ext?: string
  /* ---- The ledger's registers (phase 6). Optional, absent until a clocked
   * writer stamps them; a record without them is a phase-4 record and loads
   * exactly as it always did. Each is validated by `parseRecord` and dropped
   * — individually — when malformed. ---- */
  /** When `position`/`progress` were last moved. The position group's stamp. */
  readonly positionAt?: Hlc
  /** When `finished` was last decided. */
  readonly finishedAt?: Hlc
  /**
   * The reader's tags as LWW registers — see `TagClockEntry`. When this is
   * present it is AUTHORITATIVE and `tags` is derived from it on parse; the
   * `tags` field stays in the file so legacy builds and outside readers keep
   * seeing a plain list. Only a clocked writer (sync) creates one, so a
   * record a phase-4 build wrote never has it and never loses a tag to it.
   */
  readonly tagClock?: TagClock
  /**
   * BLAKE3 of the content file, full and hex — computed by the peer plugin,
   * PARSED AND KEPT here, never computed in TypeScript. It is the content
   * identity guard: two devices holding bytes for one `bookId` with two
   * different hashes is a conflict, never a merge.
   */
  readonly contentHash?: string
  /** What the bytes ARE — the value that travels, unlike `ext`. */
  readonly format?: Format
}

/**
 * A `bookId` reduced to a safe single path segment.
 *
 * `bookIdFor` produces `book:` followed by hex, so in practice this changes
 * nothing. It is here because "in practice" is not a guarantee: an id also comes
 * back off a stored record, and a path segment built from one must not be able
 * to contain a slash whatever it says.
 *
 * Not exported — the two builders below are the only callers, and a path helper
 * that anything can reach is a path helper somebody will use to build a path
 * this file did not sanction.
 */
function safeId(bookId: string): string {
  const safe = bookId.replace(/[^a-zA-Z0-9]/g, '_')
  /* AN EMPTY SEGMENT IS NOT A BOOK'S FOLDER, IT IS THE LIBRARY'S.
   *
   * `folderOf('')` was `books/`, and `trashOf('')` was `trash/` — so
   * `trashBook(fs, '')` renamed the WHOLE `books` directory into the trash.
   * Reaching it needed a record whose id was empty, which nothing the app
   * writes produces; the published service table changed that, because
   * `book.add` takes an id from a caller. The refusal belongs here rather
   * than at that one caller: this is the function that promises a path is one
   * safe segment, and "one segment" was true of a slash and false of nothing.
   *
   * The same reasoning as the character class beside it, and the same place. */
  if (safe === '') throw new Error('bookFolder: a book id must have at least one alphanumeric character')
  return safe
}

export const folderOf = (bookId: string): string => `${BOOKS_DIR}/${safeId(bookId)}`
export const trashOf = (bookId: string): string => `${TRASH_DIR}/${safeId(bookId)}`
export const recordPath = (bookId: string): string => `${folderOf(bookId)}/book.json`
/**
 * Where a jacket is written, and the name it is written under.
 *
 * `.jpg`, BECAUSE THAT IS WHAT THE BYTES ARE. It was `cover.webp` and the bytes
 * were never WebP: first JPEG, then — once that was "fixed" — PNG, because
 * WebKit's `convertToBlob` silently substitutes PNG for a format it cannot
 * encode and the canvas spec allows it to. Two different lies under one name,
 * neither of which broke anything, because every decoder sniffs the bytes and
 * ignores the extension. See `coverArt.ts` for the measurement.
 *
 * A book's folder is meant to be a directory somebody can hand to somebody
 * else, and a file whose name misdescribes its contents is a poor thing to hand
 * over. JPEG is what this WebView actually produces when asked, so the name and
 * the bytes now agree by construction rather than by intention.
 */
export const coverPathIn = (bookId: string): string => `${folderOf(bookId)}/cover.jpg`

/**
 * The jacket written before the name was made honest.
 *
 * Read-only, and read only as a fallback — see `coverUrl`. Nothing writes here
 * any more. It exists because a reader's existing library is full of these and
 * they are perfectly good images; refusing to look would blank every cover on
 * the shelf to fix a filename.
 */
export const legacyCoverPathIn = (bookId: string): string => `${folderOf(bookId)}/cover.webp`
export const marksPathIn = (bookId: string): string => `${folderOf(bookId)}/marks.json`
export const contentPathIn = (bookId: string, name: string): string =>
  `${folderOf(bookId)}/content.${extensionFor(name)}`

/**
 * The bound on a record's prose fields, EXPORTED since phase 11.
 *
 * `parseRecord` SLICES at it, which is right for a file that may have been
 * hand-edited: a title one character too long is still a title. It is wrong
 * for a published API, where slicing means answering a caller with the title
 * they sent and storing a different one — the write reports success, the read
 * a fortnight later disagrees, and nothing in between said so. The service
 * table refuses past this bound instead, and it refuses against THIS number
 * rather than a copy of it.
 */
export const MAX_RECORD_FIELD = 500
const MAX_FIELD = MAX_RECORD_FIELD
/* There is no `MAX_LONG` any more. It was the shared 4000-character bound for
 * the two fields that are not prose — a reading position and an address — and
 * `text` SLICES at its bound. Both of them mean nothing shortened, and both were
 * being destroyed by being read: the cut value survived the next merge and was
 * written back over the whole one. They have their own bounds now, and past them
 * the field is DROPPED rather than cut. */
/**
 * The bound for a reading position, which is DROPPED past it rather than cut.
 *
 * A CFI is a path through a document and truncating one does not produce a
 * shorter position, it produces a broken string that parses as nothing. Worse,
 * the truncated value survived the next merge and was written back over the
 * complete one, so a position long enough to trip this was destroyed by being
 * read. Generous enough that no real CFI reaches it, and a bound rather than
 * none because this parses a file a reader can edit.
 */
/** The bound on a reading position, exported for the same reason as
 *  `MAX_RECORD_FIELD` — and this one is DROPPED past rather than cut, so a
 *  caller who exceeds it would otherwise be told the position was saved and
 *  find the book opening at the beginning. */
export const MAX_RECORD_POSITION = 64_000
const MAX_POSITION = MAX_RECORD_POSITION
/**
 * The bound for a book's origin, DROPPED past it rather than cut — for the same
 * reason as a position, and it took the same bug to notice. Slicing a URL does
 * not produce a shorter address, it produces one that fetches nothing, and
 * `canOpen` would go on offering the row because an origin was present.
 */
const MAX_ORIGIN = 8_000
/**
 * The bound for a list the BOOK declares — subjects, languages.
 *
 * Sliced, and that is right for these: they come from a file Paper did not
 * write, a book listing three hundred subjects is describing nothing, and
 * dropping the field entirely over a long tail would lose the useful head of it.
 */
const MAX_LIST = 64
/**
 * The bound for the reader's OWN tags, which is not the same question.
 *
 * These share a parser with the declared lists, and that parser SLICES — so a
 * reader with sixty-five tags on a book lost the sixty-fifth silently, and lost
 * it permanently on the next write. Nothing in the UI stops them adding it. A
 * bound still exists, because this parses a file a reader can edit by hand, but
 * it is far past where anyone will meet it.
 */
const MAX_TAGS = 4096

const text = (v: unknown, limit = MAX_FIELD): string | undefined =>
  typeof v === 'string' && v ? v.slice(0, limit) : undefined
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const list = (v: unknown, limit = MAX_LIST): readonly string[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const clean = v
    .filter((one): one is string => typeof one === 'string' && one !== '')
    .slice(0, limit)
    .map((one) => one.slice(0, MAX_FIELD))
  return clean.length ? clean : undefined
}

/**
 * The reader's tags, read back as a writer would have written them.
 *
 * The general list reader TRUNCATES each entry at `MAX_FIELD`, which is the
 * record-field cap and eight times what a tag may be: every write goes through
 * `normalizeTag`, so a five-hundred-character tag is a state nothing in the app
 * can produce. Reading one back kept it alive on the next write, published it
 * on every `book.list` row, and — with 4 096 of them — put the row past what a
 * frame can carry.
 *
 * Normalised rather than sliced, because slicing at a different length than the
 * writer uses is how two spellings of one tag come to exist. Deduplicated by
 * key afterwards, since two distinct over-long spellings can normalise to one.
 */
function readTags(raw: unknown, limit: number): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const one of raw) {
    if (typeof one !== 'string') continue
    const tag = normalizeTag(one)
    const key = tagKey(tag)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= limit) break
  }
  return out.length ? out : undefined
}

/** A BLAKE3 hash as `contentHash` stores it: 64 lowercase hex digits. */
const CONTENT_HASH = /^[0-9a-f]{64}$/

/**
 * Read a tag clock back, dropping malformed ENTRIES individually — one entry
 * somebody hand-edited must not cost the register beside it. An entry is kept
 * when its key is `tagKey` of its spelling (that identity is what makes it a
 * register rather than a second list), its stamp is a stamp and its `on` is a
 * boolean. `undefined` when the value is not an object at all — then the
 * field is dropped whole and the stored `tags` list stands.
 *
 * Built with a null prototype and own keys only, the manifest validator's
 * rule: `constructor` is a legal tag.
 */
function readTagClock(raw: unknown): TagClock | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const clock: Record<string, TagClockEntry> = Object.create(null) as Record<string, TagClockEntry>
  /* VALIDATED FIRST, CAPPED SECOND. Capping the raw keys let alphabetically
   * earlier junk consume the slots and push valid registers out — tag loss
   * on the next write. The cap counts registers that are registers. */
  const keys = Object.keys(raw).sort()
  let kept = 0
  for (const key of keys) {
    if (kept >= MAX_TAGS) break
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const spelling = entry['spelling']
    /* A SPELLING NO WRITER CAN PRODUCE IS NOT A SPELLING.
     *
     * This bounded the field at `MAX_FIELD` — the general record-field cap —
     * while every write goes through `normalizeTag`, which cuts at `TAG_MAX`
     * code points. So the parser admitted entries eight times longer than any
     * writer creates, and `book.get` publishes the WHOLE clock in one
     * unpaged `req`: 4 096 entries at the old bound put a single response
     * past the envelope's 4 MiB payload cap, where it fails as a wire error
     * naming nothing. Counted in CODE POINTS for the same reason
     * `normalizeTag` cuts in them — sixty emoji are a hundred and twenty
     * UTF-16 units and are still sixty characters. */
    if (typeof spelling !== 'string' || spelling === '' || [...spelling].length > TAG_MAX) continue
    if (tagKey(spelling) !== key) continue
    if (!isHlc(entry['at'])) continue
    if (typeof entry['on'] !== 'boolean') continue
    clock[key] = { at: entry['at'], on: entry['on'], spelling }
    kept += 1
  }
  return clock
}

/**
 * Read a `book.json` back, dropping anything malformed.
 *
 * The same trust boundary the flat store had, and for the same reason: this is a
 * file on disk that anything could have written. A `subjects` that is a number
 * rather than an array of strings crashes the shelf the moment it renders.
 *
 * Built from KNOWN FIELDS rather than spread, so an unknown key never reaches
 * memory — the correction phase 3's audit forced, kept.
 */
export function parseRecord(raw: string | null): BookRecord | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const r = parsed as Record<string, unknown>
  // A book with no title at all is still a book — the filename stands in — so
  // this is the one field that falls back rather than failing the record.
  const title = text(r['title']) ?? ''
  /* The tag clock, if the record carries one — and when it does, the clock is
   * the truth about the reader's tags and `tags` is DERIVED from it, because
   * a list cannot say "removed" and the register can. The stored list still
   * stands for every record without a clock, which is every record a phase-4
   * build wrote. */
  const clock = readTagClock(r['tagClock'])
  const derivedTags = clock ? tagsFromClock(clock) : undefined
  return {
    /* NEVER CUT: an id sliced to five hundred characters is a different
     * identity, and everything after it would target a different folder. */
    ...(typeof r['bookId'] === 'string' && r['bookId'] !== '' && r['bookId'].length <= MAX_FIELD ? { bookId: r['bookId'] } : {}),
    title,
    author: text(r['author']) ?? '',
    /* ⚠️ **NEVER CUT, for `bookId`'s reason one field down**: an identity
     * sliced to five hundred characters is a DIFFERENT identity, and two long
     * identifiers sharing a prefix would compare equal after a write/read
     * cycle — `recordFromMeta` writes the whole value, so the truncation would
     * appear only on reload. Over the bound the field is dropped, which reads
     * as "this book declares none" and is recoverable by a re-parse.
     * Trimmed-empty is absent too: the field's contract is absent-never-empty,
     * and a record of three spaces would otherwise satisfy `identifier ?`. */
    ...(typeof r['identifier'] === 'string' &&
    r['identifier'].trim() !== '' &&
    r['identifier'].length <= MAX_FIELD
      ? { identifier: r['identifier'] }
      : {}),
    ...(text(r['sortAs']) ? { sortAs: text(r['sortAs'])! } : {}),
    ...(text(r['series']) ? { series: text(r['series'])! } : {}),
    ...(num(r['seriesIndex']) === undefined ? {} : { seriesIndex: num(r['seriesIndex'])! }),
    ...(text(r['publisher']) ? { publisher: text(r['publisher'])! } : {}),
    ...(text(r['published']) ? { published: text(r['published'])! } : {}),
    ...(list(r['languages']) ? { languages: list(r['languages'])! } : {}),
    ...(list(r['subjects']) ? { subjects: list(r['subjects'])! } : {}),
    ...(clock
      ? { tagClock: clock, ...(derivedTags!.length ? { tags: derivedTags! } : {}) }
      : readTags(r['tags'], MAX_TAGS)
        ? { tags: readTags(r['tags'], MAX_TAGS)! }
        : {}),
    /* NOT `text`, which SLICES. See `MAX_POSITION`: a shortened CFI is not a
     * rougher position, it is a broken one, and it used to overwrite the good
     * value on the next merge. Over the bound the field is dropped, so the book
     * opens at the beginning — recoverable — instead of at a corrupted anchor. */
    ...(typeof r['position'] === 'string' &&
    r['position'] !== '' &&
    r['position'].length <= MAX_POSITION
      ? { position: r['position'] }
      : {}),
    // Clamped, not merely checked finite: a hand-edited `progress: 4` would draw
    // a bar four times the width of its track.
    ...(num(r['progress']) === undefined
      ? {}
      : { progress: Math.min(1, Math.max(0, num(r['progress'])!)) }),
    ...(typeof r['finished'] === 'boolean' ? { finished: r['finished'] } : {}),
    ...(num(r['addedAt']) === undefined ? {} : { addedAt: num(r['addedAt'])! }),
    ...(num(r['openedAt']) === undefined ? {} : { openedAt: num(r['openedAt'])! }),
    /* A timestamp, so BOUNDED: non-negative and finite, or dropped — the
     * merge orders the metadata group by this number, and a hand-edited
     * negative "parse time" would outrank... nothing, but claim a parse
     * that never happened. Dropped, the record reads "never parsed", which
     * is the honest floor. */
    ...(num(r['parsedAt']) === undefined || num(r['parsedAt'])! < 0 ? {} : { parsedAt: num(r['parsedAt'])! }),
    /* Bounded the same way and for a sharper reason: a hand-edited schema
       ABOVE `META_SCHEMA` would tell the pass this record is newer than the
       code, and the book would never be re-parsed again by any future
       backfill. Clamped to what this build can actually have written. */
    ...(num(r['metaSchema']) === undefined || num(r['metaSchema'])! < 0
      ? {}
      : { metaSchema: Math.min(META_SCHEMA, Math.floor(num(r['metaSchema'])!)) }),
    /* NOT `text`, which SLICES — see `MAX_ORIGIN`. A shortened path or URL is
     * not a rougher way back, it is a broken one, and it survived the next merge
     * to be written over the good value. */
    ...(typeof r['origin'] === 'string' && r['origin'] && r['origin'].length <= MAX_ORIGIN
      ? { origin: r['origin'] }
      : {}),
    ...(text(r['ext'], 8) ? { ext: text(r['ext'], 8)! } : {}),
    /* The ledger's registers. Each is dropped ALONE when malformed — a stamp
     * somebody edited must not cost the record its position, and a record
     * from before the ledger simply has none of these. */
    ...(isHlc(r['positionAt']) ? { positionAt: r['positionAt'] } : {}),
    ...(isHlc(r['finishedAt']) ? { finishedAt: r['finishedAt'] } : {}),
    ...(typeof r['contentHash'] === 'string' && CONTENT_HASH.test(r['contentHash'])
      ? { contentHash: r['contentHash'] }
      : {}),
    ...(isFormat(r['format']) ? { format: r['format'] } : {}),
  }
}

export async function readBook(fs: VaultFs, bookId: string): Promise<BookRecord | null> {
  try {
    const bytes = await fs.readFile(recordPath(bookId))
    return parseRecord(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

/**
 * Write a book's record, whole and atomically.
 *
 * Temp neighbour then rename, the property `ownBook` already has: an interrupted
 * write must not leave a truncated `book.json`, because that file IS the book as
 * far as the shelf is concerned, and a half-written one would lose the reader's
 * tags and position with no error anywhere.
 *
 * ONE BOOK'S FILE, which is the other half of the point. The flat store
 * serialised the entire shelf on every position save; a page turn now writes a
 * few hundred bytes.
 */
export async function writeBook(
  fs: VaultFs,
  bookId: string,
  record: BookRecord,
  level: SyncLevel = 'full',
): Promise<void> {
  // Stamped on every write, so the record always knows its own id even if the
  // caller passed one that was not in it.
  const stamped: BookRecord = { ...record, bookId }
  await atomicWrite(
    fs,
    recordPath(bookId),
    new TextEncoder().encode(JSON.stringify(stamped, null, 2)),
    level,
  )
}

/**
 * Write a file so that a crash cannot leave half of one — and, where the
 * filesystem can, so that a power cut cannot either.
 *
 * A temporary neighbour, then a rename — atomic within a filesystem, so readers
 * see the old bytes or the new bytes and never a truncated file. That matters
 * here more than usual: `exists` is what decides a book HAS content, so a
 * half-written `content.epub` would be counted as the book forever.
 *
 * ONE COPY OF THIS. It was written out four times — the record, the marks, a
 * folder import, and the reader's own copy on open — and four copies of an
 * invariant is three chances for one of them to drift out of it.
 *
 * SYNCED WHERE IT CAN BE (phase 20, D3). A filesystem with `writeAtomic` does
 * the whole thing itself — write, sync the file at `level`, rename, sync the
 * directory — in one call; the app's is one Rust command, the CLI's is
 * `node:fs`. Without it, the temp-and-rename below: what the vault had for
 * its whole life, which survives a crash and not a power loss, and is what a
 * fake filesystem offers.
 *
 * The fallback's temporary path is derived from the destination, so two
 * writers racing for ONE file still collide. That is deliberate and is why
 * both stores serialise their writes per book; see `writeQueue`.
 */
export async function atomicWrite(
  fs: VaultFs,
  path: string,
  bytes: Uint8Array,
  level: SyncLevel = 'full',
): Promise<void> {
  if (fs.writeAtomic) {
    await fs.writeAtomic(path, bytes, level)
    return
  }
  const writing = `${path}.writing`
  /* ONLY WHEN THERE IS ONE. `index.json` sits at the root of the data directory
   * and has no slash in it, so `slice(0, lastIndexOf('/'))` returns `index.jso`
   * — and this would have created a directory named after most of a filename,
   * every time the shelf was saved. A path with no separator has no parent to
   * make. */
  const cut = path.lastIndexOf('/')
  if (cut > 0) await fs.mkdir(path.slice(0, cut))
  try {
    await fs.writeFile(writing, bytes)
    await fs.rename(writing, path)
  } catch (cause) {
    await fs.remove(writing).catch(() => {})
    throw cause
  }
}

/**
 * Change part of a book's record, reading and writing under one call.
 *
 * The replacement for seven near-duplicate mutators. `rememberPosition`,
 * `rememberVault`, `rememberCover`, `markFinished`, `tagBook`, `untagBook` and
 * `applyLookup` were seven ways to write one field to one book, each with its
 * own identity check and its own persistence path.
 *
 * Returns false when the book is not there, which is not an error: a write
 * racing a removal should do nothing rather than recreate the folder.
 */
/**
 * @returns The record now on disk, or null when there was no book to change —
 * gone, or undone because a removal raced the write. THE RECORD, not a
 * boolean, because the caller's in-memory row may be behind the disk (the
 * index it came from can be one write stale), and only what was actually
 * written can put the row right. A boolean said "it worked" while the shelf
 * kept showing the stale copy.
 */
export async function updateBook(
  fs: VaultFs,
  bookId: string,
  change: (record: BookRecord) => BookRecord,
  level: SyncLevel = 'full',
): Promise<BookRecord | null> {
  /* THE CHANGE IS APPLIED TO WHAT IS ON DISK, which is the point of taking a
   * function rather than a value. A caller holding an in-memory copy may be
   * behind — the index it came from can be one write stale after a crash — and
   * writing that copy back would undo whatever landed in between. */
  /* WHETHER A REMOVED COPY WAS ALREADY WAITING, read before anything is
   * written. It is the discriminator for the check below: a trash entry that
   * appears while this call is running is a removal that happened in between. */
  const trashedBefore = await fs.exists(trashOf(bookId))
  const current = await readBook(fs, bookId)
  if (!current) {
    /* PRESENT BUT UNREADABLE IS NOT ABSENT. `readBook` answers both with null,
     * and returning false here reported "the book is gone, nothing to do" — so
     * the tag the reader had just typed was dropped with no error anywhere and
     * nothing to replay it. Gone is false; broken throws, and the caller says
     * it could not save. */
    if (await fs.exists(recordPath(bookId))) {
      throw new Error(`book.json for ${bookId} is there but could not be read`)
    }
    return null
  }
  const next = change(current)
  if (next === current) return current
  await writeBook(fs, bookId, next, level)
  /* CHECKED AFTER THE WRITE, because a removal can rename the folder between
   * the read above and the write — and `writeBook` calls `mkdir`, so it happily
   * recreates the folder containing nothing but this record. That is a book
   * resurrected as an empty shell, which is worse than the write being lost.
   *
   * TESTING `exists(folder)` HERE PROVED NOTHING: `writeBook` had just created
   * it, so the answer was always yes and the guard could not fire. The removal
   * is what leaves a trace — the folder it renamed away — so that is what is
   * looked for, and only when it was not already there. */
  if (!trashedBefore && (await fs.exists(trashOf(bookId)))) {
    // Undone rather than left: the shell this call created is removed, and the
    // removal keeps the book it moved.
    await fs.removeDir(folderOf(bookId)).catch(() => {})
    return null
  }
  return next
}

/**
 * Reconcile TWO records that are both the reader's, for one book.
 *
 * Not the same problem as `mergeParsed`, which folds what a book says about
 * itself into what the reader owns and has a clear winner for every field. Here
 * both sides are the reader's own work — a record stranded in the trash by a
 * restore that could not finish, and the live one that has been in use since —
 * so taking either side whole loses the other's.
 *
 * Tags UNION, because a tag is an addition and neither list is more correct.
 * Position and progress come from the LIVE record when it has them, because
 * reading moves forwards and the live one is where the reading happened.
 * `finished` is true if either says so; `addedAt` is the earlier, since that is
 * when the book actually arrived.
 */
export function mergeStranded(stranded: BookRecord, live: BookRecord): BookRecord {
  /* THE CLOCKS, NOT THE LISTS. This used to union `tags` and spread `live`
   * — which carried `live.tagClock` through untouched. `parseRecord` treats
   * a clock as the authority and re-derives `tags` from it, so the union
   * lasted exactly until the record was read back: in memory `["Sea",
   * "Mine"]`, on the next launch `["Mine"]`. Every record tagged since the
   * clock existed has one, so that was the ordinary case, not the legacy
   * one. Merging the REGISTERS — last writer per tag, a legacy list
   * synthesised at its documented stamp by `tagRegisters` — and deriving
   * the list from the result is the only shape a read cannot undo. */
  const { tags: _tags, tagClock: _clock, ...rest } = live
  const clock = mergeTagClocks(tagRegisters(stranded), tagRegisters(live))
  const tags = clock ? tagsFromClock(clock) : []
  const addedAt =
    stranded.addedAt === undefined
      ? live.addedAt
      : live.addedAt === undefined
        ? stranded.addedAt
        : Math.min(stranded.addedAt, live.addedAt)
  return {
    ...rest,
    ...(clock ? { tagClock: clock } : {}),
    ...(tags.length ? { tags } : {}),
    ...(live.position ?? stranded.position ? { position: live.position ?? stranded.position! } : {}),
    ...((live.progress ?? stranded.progress) === undefined
      ? {}
      : { progress: live.progress ?? stranded.progress! }),
    ...(stranded.finished || live.finished ? { finished: true } : {}),
    ...(addedAt === undefined ? {} : { addedAt }),
  }
}

/**
 * Two tag clocks as one: every register from either, and where both hold a
 * key, the LATER stamp — a tie going to the second, which `mergeStranded`
 * passes the live record as. The same rule the sync merge applies to the
 * same registers, so a rescue and a replica cannot disagree about a tag.
 */
function mergeTagClocks(a: TagClock | undefined, b: TagClock | undefined): TagClock | undefined {
  if (!a) return b
  if (!b) return a
  const merged: Record<string, TagClockEntry> = Object.create(null) as Record<string, TagClockEntry>
  for (const clock of [a, b]) {
    for (const key of Object.keys(clock)) {
      const entry = clock[key]!
      const held = merged[key]
      if (held === undefined || compareHlc(entry.at, held.at) >= 0) merged[key] = entry
    }
  }
  /* ROUND-TRIP STABLE: two full clocks merge to twice `MAX_TAGS`, and the
   * next read would keep the first `MAX_TAGS` by key and drop the rest
   * silently. The same deterministic rule is applied here, so what is
   * written is what will be read. */
  const keys = Object.keys(merged).sort()
  if (keys.length <= MAX_TAGS) return merged
  const capped: Record<string, TagClockEntry> = Object.create(null) as Record<string, TagClockEntry>
  for (const key of keys.slice(0, MAX_TAGS)) capped[key] = merged[key]!
  return capped
}

/**
 * What a PARSE knows about a book, as a record.
 *
 * ONE PROJECTION, called from both places a parse can happen: the reader, when
 * a book is opened, and the enrichment pass, when one is parsed in the
 * background. Written out twice they would drift, and the drift would be
 * invisible — a book would simply hold different fields depending on which
 * route had reached it first, and nothing would ever compare the two.
 *
 * Every field is omitted when the book declares nothing, rather than written
 * empty: `mergeParsed` treats what it is given as the book's own account of
 * itself, so an empty string here is the book SAYING it has no publisher, and
 * that would overwrite one the reader's record already had.
 *
 * It deliberately does NOT carry `title` and `author` conditionally — those two
 * are `BookRecord`'s only required fields and a parse always has an answer for
 * them, even if the answer is empty.
 *
 * `source` is the file the parser was handed, when there was one. It is the
 * evidence `titleAsParsed` needs to tell a title from a file name, and every
 * caller that has the file should pass it — the reader opening a book and the
 * enrichment pass both do — so that the two routes keep agreeing about what a
 * comic is called.
 */
export function recordFromMeta(
  meta: {
    readonly title: string
    readonly author: string
    readonly identifier?: string
    readonly sortAs?: string
    readonly series?: string
    readonly seriesIndex?: number | null
    readonly subjects?: readonly string[]
    readonly publisher?: string
    readonly published?: string
    readonly languages?: readonly string[]
  },
  source?: NamedSource,
): BookRecord {
  return {
    title: titleAsParsed(meta.title, source),
    author: meta.author,
    /* THE SCHEMA THE PARSE WROTE, stamped by every route that parses. See
     * `META_SCHEMA`: `parsedAt` alone cannot say WHICH fields a parse knew
     * about, so a library parsed before `identifier` existed is
     * indistinguishable from one whose books declare none — and `enrich`
     * skips every record that has a `parsedAt`, so without this no existing
     * library would ever acquire an identifier. */
    metaSchema: META_SCHEMA,
    /* Bounded HERE TOO, and to the same number. `parseRecord` drops an
     * over-long identifier rather than truncating it, so a parse that wrote one
     * would produce a record whose identifier vanished on the next load —
     * present in memory, absent on disk, with nothing reporting the
     * difference. */
    ...(meta.identifier && meta.identifier.trim() !== '' && meta.identifier.length <= MAX_FIELD
      ? { identifier: meta.identifier }
      : {}),
    ...(meta.sortAs ? { sortAs: meta.sortAs } : {}),
    ...(meta.series ? { series: meta.series } : {}),
    ...(meta.seriesIndex === null || meta.seriesIndex === undefined
      ? {}
      : { seriesIndex: meta.seriesIndex }),
    ...(meta.subjects?.length ? { subjects: meta.subjects } : {}),
    ...(meta.publisher ? { publisher: meta.publisher } : {}),
    ...(meta.published ? { published: meta.published } : {}),
    ...(meta.languages?.length ? { languages: meta.languages } : {}),
  }
}

/**
 * The formats whose parser NAMES THE BOOK AFTER ITS FILE.
 *
 * A comic archive carries no metadata, so foliate's `comic-book.js` sets
 * `metadata.title = file.name` — extension included — and that is the whole
 * of what a parse knows about its title. Typed over `Format` so that a second
 * comic format (`cbr`, which Paper does not yet accept — see `FORMATS` and
 * `ACCEPT_FORMATS`, and foliate routes only `.cbz` to that parser) has to be
 * admitted there before it can be listed here.
 */
const FILE_NAMED_FORMATS: readonly Format[] = ['cbz']

/**
 * A parsed title, with a file-naming parser's extension taken back off.
 *
 * "Batman.cbz" → "Batman.cbz.cbz" → "Batman.cbz.cbz.cbz", one step per open
 * and per enrichment pass. `comic-book.js` titles a comic after the file it is
 * given; the vault hands it back named `storedBookName(entry)`, which is
 * `${title}.${ext}`; and `mergeParsed` lets the parse's title replace the
 * record's. So each open handed the parser a name one extension longer than
 * the last, and wrote it back as the title.
 *
 * The rule is as narrow as the defect. It fires only when the file's own
 * extension belongs to a parser that names the file, AND the title IS that
 * file name — the evidence that it was never a title at all. An EPUB whose
 * declared title happens to be "Batman.cbz" was opened from `Batman.cbz.epub`
 * and is left alone; so is an EPUB whose title equals its own file name,
 * because its parser does not invent titles; so is a comic whose title has
 * since been corrected, since a corrected title no longer equals the name.
 *
 * EVERY trailing repeat of the extension comes off, not just one. A record
 * this defect already wrote as "Batman.cbz.cbz" reaches the parser as
 * "Batman.cbz.cbz.cbz", and stripping once would hand back exactly the damaged
 * title it started with — stable, and still wrong. A name that is nothing but
 * its extension is kept, which is what the parser said.
 */
function titleAsParsed(title: string, source: NamedSource | undefined): string {
  if (!source || title !== source.name) return title
  const dot = source.name.lastIndexOf('.')
  if (dot <= 0) return title
  const ext = source.name.slice(dot + 1).toLowerCase()
  if (!isFormat(ext) || !FILE_NAMED_FORMATS.includes(ext)) return title
  const suffix = `.${ext}`
  let stem = title
  while (stem.length > suffix.length && stem.slice(-suffix.length).toLowerCase() === suffix) {
    stem = stem.slice(0, -suffix.length)
  }
  return stem
}

/**
 * Fold what a parse learned into what the reader owns.
 *
 * The book is the authority on its own metadata; the reader is the authority on
 * their tags, their place in it, and whether they are done. Phase 3 got this
 * wrong in `recordOpen` and erased a reader's tags on every reopen, so the rule
 * is stated as a function rather than left to a spread.
 */
export function mergeParsed(previous: BookRecord | null, parsed: BookRecord): BookRecord {
  if (!previous) return parsed
  return {
    ...parsed,
    /* TAGS AND THEIR CLOCK TOGETHER: they are one register in two forms, and
     * keeping the reader's list beside a parse's clock made the returned
     * record show one set of tags while a reread derived another. */
    ...(previous.tags ? { tags: previous.tags } : {}),
    ...(previous.tagClock ? { tagClock: previous.tagClock } : {}),
    ...(previous.position ? { position: previous.position } : {}),
    ...(previous.progress === undefined ? {} : { progress: previous.progress }),
    ...(previous.finished === undefined ? {} : { finished: previous.finished }),
    ...(previous.addedAt === undefined ? {} : { addedAt: previous.addedAt }),
    /* THE ORIGIN IS KEPT unless the open supplies a new one.
     *
     * It is not something a book says about itself — it is where this copy came
     * from — so it belongs on this side of the line with the tags and the
     * position. It was not here, and the routes that open a book WITHOUT a path
     * therefore erased it: drop an already-shelved book onto the open reader and
     * its way back was gone, which for a book Paper has no copy of is the whole
     * of it. A fresh one still wins, because that is the reader telling us where
     * the book is now. */
    ...(parsed.origin ? {} : previous.origin ? { origin: previous.origin } : {}),
    /* AND THE SAME FOR THE OTHER THREE THAT ARE NOT THE BOOK'S TO SAY.
     *
     * `origin` was found and fixed alone, and it was never alone: `ext`,
     * `openedAt` and `bookId` sit on exactly the same side of the line and were
     * all being dropped by the same spread. It went unnoticed because the only
     * caller was the reader opening a book, which happens to supply an
     * `openedAt` and an `ext` every time — so `parsed` always had them and
     * `previous` never had to be consulted.
     *
     * The enrichment pass is a second caller that supplies NONE of the three,
     * because it knows nothing about this copy — only about the book. Left as
     * it was, parsing a book in the background would have set its title and
     * taken away the extension that says which file to open: `openStored`
     * defaults a record with no `ext` to `.epub`, so every enriched PDF on the
     * shelf would have become a book that opens nothing. A pass meant to fill
     * the shelf in would have broken every book on it.
     *
     * The rule, stated once so the next field added has to be classified: what
     * the BOOK declares about itself, a parse may replace; what is true of the
     * READER or of THIS COPY, a parse may not. `parsedAt` is neither — it is the
     * parse's own provenance — and belongs to the parse, so it is left to the
     * spread above. */
    ...(parsed.ext ? {} : previous.ext ? { ext: previous.ext } : {}),
    ...(parsed.bookId ? {} : previous.bookId ? { bookId: previous.bookId } : {}),
    /* AND THE LEDGER'S REGISTERS, classified by the same rule. The stamps on
     * the reader's position, their "finished" and their tags are the reader's
     * (or the ledger's) and never a parse's to erase; the content hash and
     * the sniffed format describe THIS COPY's bytes, which a parse of those
     * same bytes may re-supply and an enrichment pass never does. */
    ...(parsed.positionAt ? {} : previous.positionAt ? { positionAt: previous.positionAt } : {}),
    ...(parsed.finishedAt ? {} : previous.finishedAt ? { finishedAt: previous.finishedAt } : {}),
    ...(parsed.tagClock ? {} : previous.tagClock ? { tagClock: previous.tagClock } : {}),
    ...(parsed.contentHash ? {} : previous.contentHash ? { contentHash: previous.contentHash } : {}),
    ...(parsed.format ? {} : previous.format ? { format: previous.format } : {}),
    /* `openedAt` is kept the same way rather than unconditionally: it means
       "when the reader last opened this", so an open MUST be able to move it
       forward, and only a parse that is not an open leaves it alone. */
    ...(parsed.openedAt === undefined
      ? previous.openedAt === undefined
        ? {}
        : { openedAt: previous.openedAt }
      : {}),
  }
}


/**
 * The reader's marks in a book, read from that book's folder.
 *
 * Decision 1: they are what the reader WROTE about this book, so they belong
 * with it. It also makes a book genuinely self-contained — one directory to back
 * up, replicate to a phone, or hand to somebody — and it means removing a book
 * takes its annotations with it in one rename, rather than leaving them in a
 * shared file keyed by an id nothing refers to any more.
 *
 * Returns an empty list for a book with none, and THROWS for one whose file is
 * there and will not read. The two are different answers and were the same for
 * a while, which is how a momentary read failure came to look like a book with
 * no marks — and the next highlight wrote over everything the reader had.
 */
export async function readMarks(fs: VaultFs, bookId: string): Promise<unknown[]> {
  /* ABSENT AND UNREADABLE ARE NOT THE SAME ANSWER, and collapsing them into
   * `[]` was the most destructive line in this file. A book with no marks yet
   * and a book whose marks file could not be read look identical to the caller
   * — so a momentary read failure loaded an empty list, and the next highlight
   * wrote a snapshot of exactly that one mark over everything the reader had.
   *
   * Absent is an empty list, which is the truth. Anything else THROWS, and the
   * store surfaces it as "not saving" rather than quietly starting again. */
  if (!(await fs.exists(marksPathIn(bookId)))) return []
  const bytes = await fs.readFile(marksPathIn(bookId))
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  /* A file holding something that is not a list is not a marks file. Treated as
   * empty it would be overwritten on the next edit; thrown, it is left alone. */
  if (!Array.isArray(parsed)) throw new Error(`marks.json for ${bookId} is not a list`)
  return parsed
}

/** Write a book's marks, whole and atomically — see `writeBook`. */
export async function writeMarks(
  fs: VaultFs,
  bookId: string,
  marks: readonly unknown[],
): Promise<void> {
  await atomicWrite(fs, marksPathIn(bookId), new TextEncoder().encode(JSON.stringify(marks)))
}
