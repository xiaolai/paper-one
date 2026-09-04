import { MAX_RECORD_FIELD, MAX_RECORD_POSITION, MAX_REVIEW } from './bookFolder'
import { CONTENT_EXTENSIONS } from './bookVault'
import { CARD_KINDS, MAX_CARD_TEXT } from './cards'
import { MARK_KINDS, MARK_TINTS, MAX_MARK_NOTE, MAX_MARK_TEXT } from './marks'
import { TAG_MAX } from './tags'
import type { DeviceRow } from './ports'
import type {
  BookDetail,
  BookRow,
  CardRow,
  ContentChunk,
  ContentLocation,
  EmptiedRow,
  MarkRow,
  RemovedRow,
  RestoredRow,
  ShelfStatus,
  TagChange,
  TagCountRow,
  TrashRow,
  PositionSetRow,
} from './services/rows'
import type { ClientContribution } from './capability'
import { READING_STATES } from './circle/log'

/**
 * THE SERVICE TABLE — one literal, from which the router registration, the
 * client stubs, the CLI's command list and the reference documentation are
 * all derived (phase 11, WI-11.1).
 *
 * The rule this file exists to enforce is not architectural taste. The peer
 * plugin's `commands.rs` opens with the lesson it learned the hard way:
 * "Adding a command means four edits: here, `generate_handler!` in `lib.rs`,
 * `COMMANDS` in `build.rs`, and `permissions/default.toml`. Miss the handler
 * or the build list and the command is unreachable; miss the ACL and it is
 * refused." Three lists that must agree by hand, and a comment explaining
 * what breaks when they do not. This phase publishes ten more services and
 * must not add a fourth list.
 *
 * So: a service is DECLARED here, once. `services/handlers.ts` maps each
 * declared name to its behaviour and the type system refuses a name with no
 * handler; `serviceClients()` derives the satchel-side stubs; `src/cli`
 * derives its commands. A generated `service-table.md` and the check that
 * refused a drifted copy of it both left the repository with `dev-docs/`, so these
 * rows are no longer mirrored into a document anything verifies.
 * Nothing below is written twice anywhere.
 *
 * WHAT IS NOT HERE, deliberately:
 *
 *   - `sync.*` — replication is a different protocol that happens to share
 *     the envelope. Its names are ledger-shaped (`sync.marks` names WHAT is
 *     replicated); everything here is `<singular noun>.<verb>` and names what
 *     is OPERATED ON. The two spellings mark the two protocols apart on
 *     sight, and fusing them is the standard failure of self-hosted media
 *     servers.
 *   - the byte stream. A book's content rides the peer plugin's blob path,
 *     gated by `blob:read` and verified by BLAKE3 with resume. `content.locate`
 *     says where the bytes are and whether this shelf holds them; it does not
 *     carry them. A second byte path would be a second set of the tests that
 *     one is already held to — a flipped byte, a resumed interruption, a
 *     folder trashed mid-transfer — or, worse, none.
 *
 *     ⚠️ `content.read` (phase 18) IS BYTES, and is the deliberate exception.
 *     It is a READ, not a TRANSFER, and the difference is what makes it safe
 *     to add: no resume, no partial-file state on disk, no second hash to keep
 *     honest — integrity comes from the TLS the browser client already
 *     requires. A browser cannot take the blob path at all (it has no iroh),
 *     and the alternative was an HTTP byte endpoint, which would exist on one
 *     transport and not the other. One path, both transports, the properties
 *     the blob path was tested for either absent or supplied elsewhere.
 *   - `device.pair`. Pairing is a human act with a SAS both people read
 *     aloud, and WI-8.6 recorded what driving it by command costs: `grants`
 *     is optional on the wire, the harness omitted it, an empty grant list
 *     was stored, and the run drew a wrong conclusion about the app from its
 *     own harness. Pairing stays in the Devices pane.
 */

/* ------------------------------------------------------------------ grants */

/**
 * The grant families this table names. A family is the part before the colon,
 * which is what `grantCovers` wildcards on: holding `book:*` covers
 * `book:read` and `book:write` and nothing else.
 *
 * ⚠️ `blob` IS THE TRANSPORT'S FAMILY AND THIS TABLE NOW NAMES IT TOO, for
 * `content.read`. It used to say "beside the transport's existing `sync:*` and
 * `blob:*`", which was true while nothing here carried bytes and stopped being
 * true when `content.read` did. See that row.
 */
/* FROZEN, every registry here: `readonly` is a compile-time claim, and a
 * consumer could mutate grant derivation or command discovery at runtime in a
 * module whose whole point is that the table cannot be. */
export const GRANT_FAMILIES = Object.freeze(['book', 'blob', 'mark', 'card', 'device', 'shelf', 'position'] as const)
export type GrantFamily = (typeof GRANT_FAMILIES)[number]

/**
 * Every grant a service in this table may name — the API surface and the
 * permission surface as ONE list, which is the property worth protecting
 * when the table grows. A phone gets `book:read`, `mark:*`; a laptop gets
 * `book:*`, `mark:*`, `card:*`, `shelf:read`; a shared device gets
 * `book:read` and nothing else.
 */
export const SERVICE_GRANTS = Object.freeze([
  'book:read',
  'book:write',
  /* THE BYTES OF A BOOK, and the one grant a reader is shown by name.
   * `devicesModel.describeGrants` renders `blob:read` as "book files"; see
   * `content.read` for why that sentence has to be true. */
  'blob:read',
  'mark:read',
  'mark:write',
  'card:read',
  'card:write',
  'device:read',
  'device:manage',
  'shelf:read',
  'shelf:admin',
  /* WHERE THE READER IS, and nothing else (WI-20.30, D7). Its own family so
   * that `book:*` does not include it and it does not include `book.set` —
   * the one write a browser session is admitted to, and the browser shares
   * its origin with the book it is reading. */
  'position:write',
] as const)
export type ServiceGrant = (typeof SERVICE_GRANTS)[number]

/**
 * A grant that only reads. Derived from the spelling rather than declared as
 * a field, so the two can never disagree: `device:manage` and `shelf:admin`
 * are writes because they do not end in `:read`, which is exactly what a
 * reader of the grant list would conclude.
 */
export const readingGrant = (grant: string): boolean => grant.endsWith(':read')

/**
 * THE GRANT RULE, ONCE — and this is now its home, beside the grants it
 * governs.
 *
 * A grant is covered by its exact spelling, or by `<prefix>:*` where the
 * prefix is everything before the first colon. A bare `*` covers nothing, and
 * `book:*` does not cover a grant with no colon in it: a wildcard names a
 * FAMILY, not a word.
 *
 * It lived in the peer capability, shared by the port's cached check and the
 * fake wire and matching the plugin's `peers.rs`. Phase 11 gave it a third
 * consumer — the CLI's in-process caller, which is grant-checked precisely so
 * that a command behaves the same whether it went over the envelope or not —
 * and a third copy of a rule this load-bearing is a third chance to disagree
 * with the Rust. The peer's own module re-exports this one.
 */
export function grantCovers(grants: readonly string[], grant: string): boolean {
  if (grants.includes(grant)) return true
  const colon = grant.indexOf(':')
  if (colon <= 0) return false
  return grants.includes(`${grant.slice(0, colon)}:*`)
}

/* ------------------------------------------------------------- the shapes */

/**
 * The nouns. Taken from the model, not invented: the namespace IS the noun
 * the service operates on, singular, and it is the same word the CLI uses.
 *
 * Two words are NOT nouns here and must never become them. `library` is the
 * collection in prose and the store's class name; `shelf` is the
 * authoritative-device ROLE. `book.list` lists books; `shelf.status` reports
 * the role.
 *
 * `cover` is its own noun and not a verb on `content` (WI-19.8). The three
 * `content.*` services are about the bytes a book IS; a jacket is a different
 * file with a different lifecycle — absent for most books, and never a reason
 * the book cannot be opened. "Cover" is also not a verb, and `content.cover`
 * would have been the first row in this table whose second word was not one.
 */
export const SERVICE_NOUNS = Object.freeze(['book', 'mark', 'card', 'tag', 'content', 'cover', 'device', 'shelf', 'trash'] as const)
export type ServiceNoun = (typeof SERVICE_NOUNS)[number]

/**
 * The verbs. Six regular ones hold every noun — the stores' own `add ·
 * addMany · update · remove · restore · updateNote · apply · stored ·
 * getSnapshot · subscribe · rekey · mergeRemote · open · forBook · loadAll`
 * is right for an in-process API and far too many shapes for a published one
 * — plus the irregulars that are genuinely domain rather than CRUD.
 *
 * `evict` is on this list and `remove` is not a synonym for it. `remove`'s
 * contract here is RECOVERABLE; deleting this device's copy of some bytes is
 * a different act, the cover cache already calls it eviction, and the book
 * menu's label says `Evict` too, where it used to say "Remove download".
 * One concept, one word,
 * in the service, the CLI and the UI alike.
 */
export const SERVICE_VERBS = Object.freeze([
  'list',
  'get',
  'add',
  'set',
  'remove',
  'restore',
  'search',
  'rename',
  'locate',
  'evict',
  /* `position` is `book.position` (phase 20) — the reader's place, as its own
     verb under its own grant. `set` carries it too, under `book:write`; this
     is the narrow door. */
  'position',
  /* `read` is `content.read` (phase 18) — a slice of a book's bytes. The one
     verb in this table that carries CONTENT rather than a description of it;
     the note at the head of the file says why that exception is safe. */
  'read',
  'grant',
  'forget',
  'status',
  'sync',
  'verify',
  'empty',
] as const)
export type ServiceVerb = (typeof SERVICE_VERBS)[number]

/** The response shape: one answer, or many sent as `stream` frames then `end`. */
export type ServiceKind = 'req' | 'stream'

/** What an input field may hold. Small on purpose — this is a request body,
 *  not a document format, and every type here has an obvious CLI spelling. */
export type FieldType = 'string' | 'number' | 'boolean' | 'string[]'

/**
 * One field of a service's request body.
 *
 * `positional` is the CLI's half of the declaration: a field with one is
 * taken from `paper <noun> <verb> <a> <b>` at that index, and every other
 * field is a `--flag`. It lives here rather than in the CLI so that the
 * command and the service body are one description, which is what stops the
 * two spellings of one argument the CLI would otherwise invent.
 */
/**
 * Bounds this table owns, because no record defines them — everything that
 * reaches a stored field quotes the RECORD's bound instead (`MAX_RECORD_FIELD`,
 * `MAX_MARK_TEXT`, `MAX_CARD_TEXT`), so the two can never drift.
 *
 * `MAX_QUERY` is a search box, not a document: the text is re-read against
 * every book on the shelf, so an unbounded one turned a single request into
 * billions of character comparisons on the main thread.
 *
 * `MAX_WORD` is for a field whose whole vocabulary is a handful of words — a
 * colour, a mark kind, a grant. Anything longer is not a near miss.
 *
 * `MAX_BATCH` and `MAX_GRANTS` bound the COUNT. `maxLength` bounds an entry
 * and says nothing about how many, so a list of short strings was unbounded
 * in total.
 */
const MAX_QUERY = 200
const MAX_WORD = 64
const MAX_BATCH = 1_000
const MAX_GRANTS = 64

export interface ServiceField {
  readonly name: string
  readonly type: FieldType
  /** Absent means optional. A missing required field is `malformed`. */
  readonly required?: boolean
  readonly doc: string
  /** 0-based position on the command line; absent means `--name value`. */
  readonly positional?: number
  /**
   * A `string` that may not be empty.
   *
   * Not cosmetic. An id reaches `folderOf`, which turns it into ONE path
   * segment — and an empty one is not a book's folder, it is the library's.
   * The path helper refuses it too (`bookFolder.ts`); this is the boundary
   * where the caller gets a message naming the field instead of a throw
   * naming a helper.
   */
  readonly nonEmpty?: boolean
  /** A `number` that must be a whole one. */
  readonly integer?: boolean
  /** Inclusive bounds on a `number`. A value outside them is `malformed`
   *  rather than clamped: silently clamping answers a question the caller did
   *  not ask, and they have no way to find out it happened. */
  readonly min?: number
  readonly max?: number
  /**
   * The longest a `string` may be — and every one that reaches a record
   * carries the bound the RECORD enforces, not a number chosen here.
   *
   * `parseRecord` slices a prose field at `MAX_RECORD_FIELD` and DROPS a
   * position past `MAX_RECORD_POSITION`. That is right for a file somebody
   * may have hand-edited and wrong for a published API: a `book.set` past the
   * bound answered with the title the caller sent and stored a shorter one,
   * and the disagreement only surfaced on the next read. Refused here
   * instead, against the same constant, so the two cannot drift.
   */
  readonly maxLength?: number
  /**
   * The most entries a `string[]` may carry.
   *
   * `maxLength` bounds each ENTRY and says nothing about how many there are,
   * so `device.grant` accepted an unbounded list of short strings — a request
   * that is small per item and arbitrarily large in total, persisted to the
   * peer record and read back on every session. A bound on the item without a
   * bound on the count is not a bound.
   */
  readonly maxItems?: number
  /**
   * A CLOSED SET of values, when the field has one.
   *
   * A mark's kind, a highlight's colour, a card's kind: every one of them is a
   * fixed vocabulary that the HANDLER enforced and the table did not say. So
   * the generated reference showed `--colour <string>` and `paper mark set
   * --help` said the same, while the service refused everything but three
   * words. A caller learned the vocabulary by being refused.
   *
   * Declared here, `readInput` enforces it and `dev-docs/service-table.md` prints
   * it — one statement, checked and published, instead of a rule in a handler
   * and a sentence in a doc string that nothing holds to it.
   */
  readonly choices?: readonly string[]
  /**
   * A `string` that must match this pattern, when a vocabulary is open but
   * a SHAPE is not — a hex digest, say. Declared here so the refusal is the
   * table's and the reference can print it; a handler that checked the
   * shape itself left `--help` promising `<string>` for a field that took
   * exactly sixty-four hex digits.
   */
  readonly pattern?: RegExp
  /**
   * The fewest entries a `string[]` may carry. `required` says the field
   * must be present; it says nothing about an empty list, which `tag.add`
   * refused in its handler while the schema and the reference said nothing.
   */
  readonly minItems?: number
}

/**
 * EVERY SHAPE A SERVICE MAY ANSWER WITH, by the name the table uses.
 *
 * `of` was a plain `string`, so it named a type nothing could check: a typo, a
 * shape that had been renamed, or a name for something that does not exist all
 * type-checked and reached the generated reference, where a reader is told to
 * expect a `BookRwo`. Mapping the names to the actual types closes that and
 * buys the `columns` check below, which is the one that mattered.
 */
export interface WireShapes {
  BookRow: BookRow
  BookDetail: BookDetail
  MarkRow: MarkRow
  CardRow: CardRow
  TrashRow: TrashRow
  TagCount: TagCountRow
  TagChange: TagChange
  ContentChunk: ContentChunk
  ContentLocation: ContentLocation
  PositionSet: PositionSetRow
  ShelfStatus: ShelfStatus
  DeviceRow: DeviceRow
  Removed: RemovedRow
  Restored: RestoredRow
  Emptied: EmptiedRow
  ShelfSync: { readonly started: boolean; readonly detail: string | null }
  ShelfVerify: { readonly ok: boolean; readonly findings: readonly string[]; readonly notes: readonly string[] }
}

/** The name of a shape, as the table spells it. */
export type WireShape = keyof WireShapes

/**
 * What a service answers with: many rows or one, and what a row is called.
 *
 * A DISTRIBUTED union over the shapes, so `columns` is checked against the
 * shape `of` names. It used to be `readonly string[]` beside a `string` — two
 * unrelated strings — and a column naming a field the row does not have
 * type-checked, reached the generated reference, and rendered as an empty
 * table cell. `book.list` promising a `finishedAt` it never carries is a
 * documentation error the compiler can catch and could not.
 */
export type ServiceOutput = {
  [Name in WireShape]: {
    /**
     * Whether one answer carries MANY rows of `of`.
     *
     * IT USED TO RESTATE `kind`, and its only assertion anywhere was that it
     * equalled `kind === 'stream'` — a second field saying what the first
     * said, and a test proving they could never differ. Meanwhile the ONE
     * service that is a `req` whose single answer is a whole list —
     * `device.list` — had nowhere to say so, and said it by writing the
     * plural into the type NAME: `of: 'DeviceRow[]'`, a shape that does not
     * exist and that the generated reference published.
     *
     * So it means what that hack meant. Every `stream` is many; a `req` may
     * be, and `device.list` is. `of` always names the ROW, which is what
     * `columns` are keys of.
     */
    readonly many: boolean
    /** The row/answer shape's name, for the generated reference. */
    readonly of: Name
    /**
     * The fields a HUMAN reading a terminal is shown, in order.
     *
     * Part of the output schema rather than a table inside the CLI, and the
     * distinction matters: a book row carries eighteen fields and a terminal
     * can show four of them usefully, so SOMETHING has to choose. A list in
     * the CLI would be a second description of every service's output, kept
     * in step by hand — precisely the drift this whole file exists to remove.
     *
     * Absent means "show every scalar field", which is right for the small
     * answers (a location, a status) and wrong for a shelf row.
     *
     * `--json` is unaffected and always carries the WHOLE row. This chooses
     * what is readable, never what is available.
     */
    readonly columns?: readonly (keyof WireShapes[Name] & string)[]
  }
}[WireShape]

export interface ServiceDescriptor {
  /** `<noun>.<verb>` — the template type is the same one `ServiceContribution`
   *  pins, so a descriptor is directly usable as a contribution's name. */
  readonly name: `${ServiceNoun}.${ServiceVerb}`
  readonly noun: ServiceNoun
  readonly verb: ServiceVerb
  readonly grant: ServiceGrant
  readonly kind: ServiceKind
  readonly summary: string
  readonly input: readonly ServiceField[]
  readonly output: ServiceOutput
  /**
   * An IRREVERSIBLE verb, which the CLI refuses to run without a confirming
   * count. One entry carries it — `trash.empty` — and it says so rather than
   * the CLI carrying a list of dangerous names beside this one.
   */
  readonly irreversible?: boolean
  /**
   * Fields of which at least one must be given.
   *
   * A CROSS-FIELD rule, which nothing in the schema could express — so
   * `mark.set` (note or colour) and `book.set` (any of five) enforced it in
   * their handlers, and the reference presented `paper mark set <mark>` as a
   * complete call. It is not one: it is refused. Declared here, `readInput`
   * refuses it in the same place every other malformed body is refused, and
   * the reference says so.
   */
  readonly atLeastOne?: readonly string[]
  /**
   * Fields this service once took and now REFUSES BY NAME, each with the
   * reason.
   *
   * Dropping a field from `input` alone turns a caller's `--title` into
   * "book.set has no field title — did you mean …?", which is the answer to
   * a misspelling, not to an edit that was withdrawn on purpose. Declared
   * here, `readInput` and the CLI refuse it with the reason in the message,
   * and `--help` and the reference print it beside the fields that are
   * taken — one statement, enforced and published, like `atLeastOne`.
   *
   * The first entry is `book.set`'s `title` and `author` (WI-20.7): the
   * edit went through `patch` with no stamp, the next parse or enrichment
   * let the file's metadata win in `mergeParsed`, and sync's metadata group
   * is taken whole by `parsedAt`, which `patch` never moved. Nothing in the
   * app called it. An edit the kernel cannot keep is not offered.
   */
  readonly withdrawn?: readonly WithdrawnField[]
}

/** A field a service refuses by name, and the sentence it refuses it with. */
export interface WithdrawnField {
  readonly name: string
  readonly why: string
}

/* -------------------------------------------------------------- the table */

const BOOK_ID: ServiceField = { name: 'book', type: 'string', required: true, nonEmpty: true, maxLength: MAX_RECORD_FIELD, doc: 'The book id.', positional: 0 }

/** A BLAKE3 digest, hex, as `contentHash` carries it — 32 bytes, 64 characters. */
const MAX_CONTENT_HASH = 64

/**
 * The table. Ordered by noun as the phase document lists them, and within a
 * noun by the six regular verbs then the irregulars, so this file and the
 * generated reference read in the same order as the plan that specified them.
 */
const TABLE = [
  /* ---- book ---- */
  {
    name: 'book.list',
    noun: 'book',
    verb: 'list',
    grant: 'book:read',
    kind: 'stream',
    summary: 'Pages of index rows. `since` makes it a delta rather than a re-read.',
    input: [
      { name: 'tag', type: 'string', maxLength: TAG_MAX, doc: 'Only books carrying this tag.' },
      { name: 'author', type: 'string', maxLength: MAX_RECORD_FIELD, doc: 'Only books whose author contains this text.' },
      { name: 'finished', type: 'boolean', doc: 'Only books the reader has finished.' },
      { name: 'downloaded', type: 'boolean', doc: 'Only books whose bytes are on this device.' },
      { name: 'since', type: 'number', integer: true, min: 0, doc: 'Only books whose addedAt or openedAt is AT OR AFTER this epoch millisecond. Inclusive on purpose — it is a delta, not a cursor, so a row exactly on the boundary is returned again rather than skipped. It does NOT see a title, author, tag, progress or finished change, which move no timestamp: use sync for a full feed.' },
      { name: 'limit', type: 'number', integer: true, min: 0, doc: 'Stop after this many rows.' },
    ],
    output: { many: true, of: 'BookRow', columns: ['bookId', 'title', 'author', 'progress', 'hasContent'] },
  },
  {
    name: 'book.get',
    noun: 'book',
    verb: 'get',
    grant: 'book:read',
    kind: 'req',
    summary: 'One record by id, with its ledger registers — the position and finished stamps and the tag clock, which a shelf listing does not carry. (A listing carries the opinion stamps.)',
    input: [BOOK_ID],
    output: { many: false, of: 'BookDetail', columns: ['bookId', 'title', 'author', 'tags', 'progress', 'finished', 'status', 'rating', 'review', 'hasContent'] },
  },
  {
    name: 'book.add',
    noun: 'book',
    verb: 'add',
    grant: 'book:write',
    kind: 'req',
    summary: 'Create a record. Metadata only — bytes ride the blob path.',
    input: [
      BOOK_ID,
      { name: 'title', type: 'string', required: true, nonEmpty: true, maxLength: MAX_RECORD_FIELD, doc: 'The title.', positional: 1 },
      { name: 'author', type: 'string', maxLength: MAX_RECORD_FIELD, doc: 'The author.', positional: 2 },
      { name: 'ext', type: 'string', choices: [...CONTENT_EXTENSIONS], doc: "The content file's extension, when this device holds bytes — one the blob layer stores." },
    ],
    output: { many: false, of: 'BookDetail', columns: ['bookId', 'title', 'author', 'tags', 'progress', 'finished', 'status', 'rating', 'review', 'hasContent'] },
  },
  {
    name: 'book.set',
    noun: 'book',
    verb: 'set',
    grant: 'book:write',
    kind: 'req',
    summary: 'Change fields on one record: finished, position, status, rating, review.',
    input: [
      BOOK_ID,
      { name: 'finished', type: 'boolean', doc: 'Whether the reader is done with it. Moves `status` with it.' },
      { name: 'position', type: 'string', maxLength: MAX_RECORD_POSITION, doc: 'Where the reader is, as a CFI.' },
      { name: 'progress', type: 'number', min: 0, max: 1, doc: 'How far through, in [0, 1]. Needs `position`.' },
      /* The reader's own opinion of the book (WI-23.B3). Their copy, on the
       * record; publishing it to the circle is a separate act on a separate
       * surface, which is what keeps sync and the circle apart. */
      { name: 'status', type: 'string', choices: [...READING_STATES], doc: 'Where the reader is with it: `want`, `reading` or `finished`. Moves `finished` with it.' },
      { name: 'rating', type: 'number', integer: true, min: 1, max: 5, doc: 'One to five stars.' },
      { name: 'review', type: 'string', maxLength: MAX_REVIEW, doc: 'The reader’s words about the whole book. An empty string takes a review back.' },
    ],
    atLeastOne: ['finished', 'position', 'progress', 'status', 'rating', 'review'],
    /* Refused by name, not dropped — see `withdrawn` on the descriptor. */
    withdrawn: [
      { name: 'title', why: 'a rename is not offered — an edit with no stamp loses to the next parse of the file' },
      { name: 'author', why: 'a rename is not offered — an edit with no stamp loses to the next parse of the file' },
    ],
    output: { many: false, of: 'BookDetail', columns: ['bookId', 'title', 'author', 'tags', 'progress', 'finished', 'status', 'rating', 'review', 'hasContent'] },
  },
  {
    name: 'book.position',
    noun: 'book',
    verb: 'position',
    /**
     * THE NARROW DOOR (WI-20.30, D7). A phone's position never reached the
     * shelf: the browser client holds `readingGrant`, every write is refused,
     * and the position lived in `localStorage`. `book.set` carries a position
     * — under `book:write`, beside `finished` and every other field, which
     * is everything a hostile book's script could reach through the cookie
     * the browser attaches to any socket the page opens. So the position has
     * its own row under its own family, which covers nothing else; the
     * webhost pump binds it further, to the book the client opened.
     */
    grant: 'position:write',
    kind: 'req',
    summary: 'Where the reader is in one book — the one write a reading device is granted.',
    input: [
      BOOK_ID,
      { name: 'position', type: 'string', required: true, nonEmpty: true, maxLength: MAX_RECORD_POSITION, doc: 'Where the reader is, as a CFI.', positional: 1 },
      { name: 'progress', type: 'number', min: 0, max: 1, doc: 'How far through, in [0, 1]. Absent keeps what the record has.' },
    ],
    output: { many: false, of: 'PositionSet' },
  },
  {
    name: 'book.remove',
    noun: 'book',
    verb: 'remove',
    grant: 'book:write',
    kind: 'req',
    summary: 'Folder to the trash. Not away.',
    input: [BOOK_ID],
    output: { many: false, of: 'Removed' },
  },
  {
    name: 'book.restore',
    noun: 'book',
    verb: 'restore',
    grant: 'book:write',
    kind: 'req',
    summary: 'Back from the trash, row and all.',
    input: [BOOK_ID],
    output: { many: false, of: 'Restored' },
  },
  {
    name: 'book.search',
    noun: 'book',
    verb: 'search',
    grant: 'book:read',
    kind: 'stream',
    summary: 'The index query the shelf search field already parses — `tag:`, `-tag:`, `is:`, text.',
    input: [
      { name: 'query', type: 'string', required: true, nonEmpty: true, maxLength: MAX_QUERY, doc: 'The query, as typed into the shelf.', positional: 0 },
      { name: 'limit', type: 'number', integer: true, min: 0, doc: 'Stop after this many rows.' },
    ],
    output: { many: true, of: 'BookRow', columns: ['bookId', 'title', 'author', 'progress', 'hasContent'] },
  },

  /* ---- mark ---- */
  {
    name: 'mark.list',
    noun: 'mark',
    verb: 'list',
    grant: 'mark:read',
    kind: 'stream',
    summary: 'By book, or every mark on the shelf.',
    input: [
      { name: 'book', type: 'string', maxLength: MAX_RECORD_FIELD, doc: 'One book, or every book when absent.', positional: 0 },
      { name: 'limit', type: 'number', integer: true, min: 0, doc: 'Stop after this many rows.' },
    ],
    output: { many: true, of: 'MarkRow', columns: ['id', 'bookId', 'kind', 'text', 'note'] },
  },
  {
    name: 'mark.add',
    noun: 'mark',
    verb: 'add',
    grant: 'mark:write',
    kind: 'req',
    summary: 'Anchor a highlight, note or bookmark in a book.',
    input: [
      BOOK_ID,
      { name: 'cfi', type: 'string', required: true, nonEmpty: true, maxLength: MAX_RECORD_POSITION, doc: 'The anchor.', positional: 1 },
      { name: 'text', type: 'string', maxLength: MAX_MARK_TEXT, doc: 'The marked text.', positional: 2 },
      { name: 'kind', type: 'string', maxLength: MAX_WORD, choices: [...MARK_KINDS], doc: 'What the mark is. Default highlight.' },
      { name: 'colour', type: 'string', maxLength: MAX_WORD, choices: [...MARK_TINTS], doc: 'The highlight colour. Default yellow.' },
      { name: 'note', type: 'string', maxLength: MAX_MARK_NOTE, doc: "The reader's note." },
      /* THE RECOVERY CONTEXT, which this row did not carry (phase 19). `Mark.prefix`
       * and `.suffix` are the words either side of the marked text, captured at
       * creation because — their own docstring — "recovering it later means
       * re-opening the book and resolving the CFI, which is the operation that
       * has already failed". Without them a mark made over this wire was born
       * less durable than one made on the desktop, and the browser client is
       * the first real producer of marks over it. Optional, so the CLI and an
       * older client still write; a reader that knows says so. */
      { name: 'prefix', type: 'string', maxLength: MAX_MARK_TEXT, doc: 'The words just before the marked text, for re-anchoring.' },
      { name: 'suffix', type: 'string', maxLength: MAX_MARK_TEXT, doc: 'The words just after the marked text, for re-anchoring.' },
      { name: 'chapter', type: 'string', maxLength: MAX_RECORD_FIELD, doc: 'The chapter label the mark was made in, as shown in Notes.' },
      {
        name: 'section',
        type: 'number',
        integer: true,
        min: 0,
        doc: 'Which spine item the anchor is in. Defaults to 0, which is right only for a one-document book.',
      },
    ],
    output: { many: false, of: 'MarkRow', columns: ['id', 'bookId', 'kind', 'text', 'note'] },
  },
  {
    name: 'mark.set',
    noun: 'mark',
    verb: 'set',
    grant: 'mark:write',
    kind: 'req',
    summary: 'Note text, colour.',
    input: [
      { name: 'mark', type: 'string', required: true, nonEmpty: true, maxLength: MAX_RECORD_FIELD, doc: 'The mark id.', positional: 0 },
      { name: 'book', type: 'string', maxLength: MAX_RECORD_FIELD, doc: 'The book it belongs to, when known.' },
      { name: 'note', type: 'string', maxLength: MAX_MARK_NOTE, doc: 'Replacement note text.' },
      { name: 'colour', type: 'string', maxLength: MAX_WORD, choices: [...MARK_TINTS], doc: 'Replacement colour.' },
    ],
    atLeastOne: ['note', 'colour'],
    output: { many: false, of: 'MarkRow', columns: ['id', 'bookId', 'kind', 'text', 'note'] },
  },
  {
    name: 'mark.remove',
    noun: 'mark',
    verb: 'remove',
    grant: 'mark:write',
    kind: 'req',
    summary: 'Tombstoned, so the removal replicates.',
    input: [
      { name: 'mark', type: 'string', required: true, nonEmpty: true, maxLength: MAX_RECORD_FIELD, doc: 'The mark id.', positional: 0 },
      { name: 'book', type: 'string', maxLength: MAX_RECORD_FIELD, doc: 'The book it belongs to, when known.' },
    ],
    output: { many: false, of: 'Removed' },
  },

  /* ---- card ---- */
  {
    name: 'card.list',
    noun: 'card',
    verb: 'list',
    grant: 'card:read',
    kind: 'stream',
    summary: 'Every live card, newest first. Cross-book, in no folder.',
    input: [{ name: 'limit', type: 'number', integer: true, min: 0, doc: 'Stop after this many rows.' }],
    output: { many: true, of: 'CardRow', columns: ['id', 'kind', 'body', 'bookId'] },
  },
  {
    name: 'card.add',
    noun: 'card',
    verb: 'add',
    grant: 'card:write',
    kind: 'req',
    summary: 'Make a card.',
    input: [
      { name: 'text', type: 'string', required: true, nonEmpty: true, maxLength: MAX_CARD_TEXT, doc: 'The card body.', positional: 0 },
      { name: 'kind', type: 'string', maxLength: MAX_WORD, choices: [...CARD_KINDS], doc: 'The card kind. Default Idea.' },
      { name: 'book', type: 'string', maxLength: MAX_RECORD_FIELD, doc: 'The book it came from, when it came from one.' },
    ],
    output: { many: false, of: 'CardRow', columns: ['id', 'kind', 'body', 'bookId'] },
  },
  {
    name: 'card.remove',
    noun: 'card',
    verb: 'remove',
    grant: 'card:write',
    kind: 'req',
    summary: 'Tombstoned, so the removal replicates.',
    input: [{ name: 'card', type: 'string', required: true, nonEmpty: true, maxLength: MAX_RECORD_FIELD, doc: 'The card id.', positional: 0 }],
    output: { many: false, of: 'Removed' },
  },

  /* ---- tag ----
   * Tags live ON A BOOK, so they carry the book's grants. A `tag:write` that
   * could rewrite `book.json` without `book:write` would be a grant that lies. */
  {
    name: 'tag.list',
    noun: 'tag',
    verb: 'list',
    grant: 'book:read',
    /* A STREAM, and it was `req` on the assumption that a shelf has few tags.
     *
     * The RECORD permits 4 096 tags per book at up to `TAG_MAX` characters
     * each, so a library only needs a handful of heavily tagged books before
     * one unpaged answer passes the envelope's 4 MiB payload limit — and a
     * `req` that outgrows a frame fails as a wire error with nothing to page
     * through. The assumption is true of every ordinary shelf and is not a
     * bound, and the difference only shows on the shelf that breaks it. */
    kind: 'stream',
    summary: 'Every tag with its count, in pages. A shelf usually has few, but a record permits thousands.',
    input: [{ name: 'limit', type: 'number', integer: true, min: 0, doc: 'Stop after this many rows.' }],
    output: { many: true, of: 'TagCount', columns: ['tag', 'count', 'mine'] },
  },
  {
    name: 'tag.add',
    noun: 'tag',
    verb: 'add',
    grant: 'book:write',
    kind: 'req',
    summary: 'Apply one or many tags to one or many books.',
    input: [
      { name: 'tag', type: 'string', required: true, nonEmpty: true, maxLength: TAG_MAX, doc: 'The tag to apply.', positional: 0 },
      { name: 'book', type: 'string[]', required: true, minItems: 1, maxLength: MAX_RECORD_FIELD, maxItems: MAX_BATCH, doc: 'The books to apply it to.' },
    ],
    output: { many: false, of: 'TagChange' },
  },
  {
    name: 'tag.remove',
    noun: 'tag',
    verb: 'remove',
    grant: 'book:write',
    kind: 'req',
    summary: 'Take a tag off named books, or off the whole shelf when none are named.',
    input: [
      { name: 'tag', type: 'string', required: true, nonEmpty: true, maxLength: TAG_MAX, doc: 'The tag to take off.', positional: 0 },
      { name: 'book', type: 'string[]', maxLength: MAX_RECORD_FIELD, maxItems: MAX_BATCH, doc: 'The books to take it off; every book carrying it when absent.' },
    ],
    output: { many: false, of: 'TagChange' },
  },
  {
    name: 'tag.rename',
    noun: 'tag',
    verb: 'rename',
    grant: 'book:write',
    kind: 'req',
    summary: 'Everywhere at once. Renaming onto an existing name merges, because tags fold by key.',
    input: [
      { name: 'from', type: 'string', required: true, nonEmpty: true, maxLength: TAG_MAX, doc: 'The tag as it is spelled now.', positional: 0 },
      { name: 'to', type: 'string', required: true, nonEmpty: true, maxLength: TAG_MAX, doc: 'The new spelling.', positional: 1 },
    ],
    output: { many: false, of: 'TagChange' },
  },

  /* ---- content ---- */
  {
    name: 'content.locate',
    noun: 'content',
    verb: 'locate',
    grant: 'book:read',
    kind: 'req',
    summary: 'Hash, size, and whether this shelf holds the bytes — what a caller needs BEFORE opening a blob stream.',
    input: [BOOK_ID],
    output: { many: false, of: 'ContentLocation' },
  },
  {
    name: 'content.read',
    noun: 'content',
    verb: 'read',
    /**
     * ⚠️ `blob:read`, NOT `book:read`, and the difference is a promise the
     * Devices pane makes.
     *
     * `describeGrants` renders `blob:read` as "book files" and renders
     * `book:read` without it as "Books, highlights, reading position". So a
     * peer deliberately given the second and denied the first is TOLD it cannot
     * have the files — and, gated on `book:read`, could stream every byte of
     * every book anyway. The sentence in the pane was the security boundary a
     * reader was reading, and the table did not implement it.
     *
     * The note at the top of this file explains why `content.read` may carry
     * bytes at all when the blob path exists. That argument is about the SHAPE
     * of the transfer — a read, not a resumable transfer — and says nothing
     * about who may ask. Both can be true: this is the bytes on the envelope's
     * terms, behind the bytes' own permission.
     *
     * A browser client is unaffected: its single grant is `readingGrant`, which
     * is a `:read` suffix test, so it covers `blob:read` exactly as it covered
     * `book:read`. `cover.read` deliberately stays on `book:read` — a jacket is
     * artwork the shelf derived, not the file the reader imported.
     */
    grant: 'blob:read',
    kind: 'stream',
    summary: "A slice of a book's bytes, base64, in chunks — what a browser reads a book through.",
    input: [
      BOOK_ID,
      { name: 'offset', type: 'number', integer: true, min: 0, max: Number.MAX_SAFE_INTEGER, doc: 'Where to start, in bytes. Default 0.' },
      {
        name: 'length',
        type: 'number',
        integer: true,
        min: 0,
        /* SAFE INTEGERS, refused as malformed here rather than as an internal
         * failure at the filesystem: a JSON number past 2^53 loses precision
         * on the way in and reads a different range than it named. */
        max: Number.MAX_SAFE_INTEGER,
        doc: 'How many bytes at most. Absent means to the end of the file.',
      },
      /* THE HASH THE CALLER WAS TOLD (WI-20.30). A browser that lost its
         socket mid-read asks for the whole read again on a fresh one, and
         nothing else can tell it the book changed in between — a re-import,
         an enrichment that rewrote the file. `content.locate` answers
         `contentHash`; this hands it back, and the read is REFUSED rather
         than served when the bytes are no longer the ones described. */
      {
        name: 'expect',
        type: 'string',
        nonEmpty: true,
        maxLength: MAX_CONTENT_HASH,
        /* A BLAKE3 digest is sixty-four hex digits; anything else reached
         * the handler and was reported as a content CONFLICT, which is the
         * wrong word for a caller who sent a typo. */
        pattern: new RegExp(`^[0-9a-f]{${MAX_CONTENT_HASH}}$`),
        doc: "The `contentHash` `content.locate` answered. Refused with `conflict` when this shelf's bytes are no longer the ones that hash describes, or when it cannot say.",
      },
    ],
    output: { many: true, of: 'ContentChunk', columns: ['bookId', 'offset', 'bytes'] },
  },
  {
    name: 'content.evict',
    noun: 'content',
    verb: 'evict',
    grant: 'book:write',
    kind: 'req',
    summary: "Delete this device's copy of the bytes. Replicates nothing, by construction.",
    input: [BOOK_ID],
    output: { many: false, of: 'ContentLocation' },
  },
  /* `cover` FOLLOWS `content` AND DOES NOT INTERLEAVE WITH IT. The CLI builds
   * its command list by walking `SERVICE_NOUNS` and taking each noun's rows,
   * so a table whose nouns are not contiguous produces a command order that
   * disagrees with the table order — which `run.test.ts` asserts they do not.
   * Found by putting this row between `content.read` and `content.evict`. */
  {
    name: 'cover.read',
    noun: 'cover',
    verb: 'read',
    grant: 'book:read',
    kind: 'stream',
    summary: "A book's jacket, base64, in chunks — what a browser draws a shelf with.",
    /* NO `offset`/`length`, unlike `content.read`. A cover is tens of kilobytes
     * and is drawn whole or not at all; a reader asking for the middle of a
     * JPEG has nothing to do with the answer. The chunking is the envelope's
     * frame limit, not a range request. */
    input: [BOOK_ID],
    output: { many: true, of: 'ContentChunk', columns: ['bookId', 'offset', 'bytes'] },
  },

  /* ---- device ---- */
  {
    name: 'device.list',
    noun: 'device',
    verb: 'list',
    grant: 'device:read',
    kind: 'req',
    summary: 'Paired peers with role, grants and last seen.',
    input: [],
    output: { many: true, of: 'DeviceRow', columns: ['id', 'name', 'platform', 'role', 'grants'] },
  },
  {
    name: 'device.grant',
    noun: 'device',
    verb: 'grant',
    grant: 'device:manage',
    kind: 'req',
    summary: "Set a peer's grants, replacing the list it had.",
    input: [
      { name: 'device', type: 'string', required: true, nonEmpty: true, maxLength: MAX_RECORD_FIELD, doc: 'The peer id.', positional: 0 },
      { name: 'grants', type: 'string[]', required: true, maxLength: MAX_WORD, maxItems: MAX_GRANTS, doc: 'The grants it should hold from now on.' },
    ],
    output: { many: false, of: 'DeviceRow', columns: ['id', 'name', 'platform', 'role', 'grants'] },
  },
  {
    name: 'device.forget',
    noun: 'device',
    verb: 'forget',
    grant: 'device:manage',
    kind: 'req',
    summary: 'Revoke a pairing. Closes any open session.',
    input: [{ name: 'device', type: 'string', required: true, nonEmpty: true, maxLength: MAX_RECORD_FIELD, doc: 'The peer id.', positional: 0 }],
    output: { many: false, of: 'Removed' },
  },

  /* ---- shelf ---- */
  {
    name: 'shelf.status',
    noun: 'shelf',
    verb: 'status',
    grant: 'shelf:read',
    kind: 'req',
    summary: 'Role, endpoint id, book count, journal seq, epoch, bytes on disk.',
    input: [],
    output: { many: false, of: 'ShelfStatus' },
  },
  {
    name: 'shelf.sync',
    noun: 'shelf',
    verb: 'sync',
    grant: 'shelf:admin',
    kind: 'req',
    summary:
      'Sync now, on a SATCHEL. A shelf answers satchels and does not dial them, so on one this answers started: false with the reason — it is not a no-op dressed as a success.',
    input: [],
    output: { many: false, of: 'ShelfSync' },
  },
  {
    name: 'shelf.verify',
    noun: 'shelf',
    verb: 'verify',
    grant: 'shelf:admin',
    kind: 'req',
    summary: 'Integrity pass over the index and the journal.',
    input: [],
    output: { many: false, of: 'ShelfVerify', columns: ['ok', 'findings', 'notes'] },
  },

  /* ---- trash ---- */
  {
    name: 'trash.list',
    noun: 'trash',
    verb: 'list',
    grant: 'book:read',
    kind: 'stream',
    summary: 'Removed books, with how long is left before they age out.',
    input: [{ name: 'limit', type: 'number', integer: true, min: 0, doc: 'Stop after this many rows.' }],
    output: { many: true, of: 'TrashRow', columns: ['bookId', 'title', 'author', 'expiresAt'] },
  },
  {
    name: 'trash.empty',
    noun: 'trash',
    verb: 'empty',
    /* `shelf:admin`, NOT `book:write`. Everything else under `book:write` is
     * recoverable — `book.remove` puts a book in the trash and `book.restore`
     * takes it out again — and this is the one verb that ends a book. A peer
     * trusted to edit a shelf is not thereby trusted to empty its trash, and
     * under the old grant every such peer could, which put the recovery
     * boundary inside the same permission as ordinary editing. */
    grant: 'shelf:admin',
    kind: 'req',
    summary: 'The one irreversible verb in the table. Takes the count it expects to delete, and refuses any other.',
    input: [
      { name: 'count', type: 'number', required: true, integer: true, min: 0, doc: 'How many books the caller believes are in the trash.', positional: 0 },
      /* A COUNT IS NOT A CONFIRMATION TOKEN, which is what this field is for.
       *
       * Cardinality cannot see membership change: if the caller reviewed `[A]`,
       * then A is restored and B trashed, the count still says one and B — never
       * looked at — is destroyed. Naming the ids closes it, because the check
       * becomes "the trash holds exactly what you saw" rather than "it holds as
       * many things as you saw".
       *
       * Optional so the existing one-argument form keeps working, and the
       * reference says plainly what omitting it costs. A caller that can name
       * what it reviewed should. */
      { name: 'books', type: 'string[]', maxLength: MAX_RECORD_FIELD, maxItems: MAX_BATCH, doc: 'The exact book ids the caller reviewed. When given, the trash must hold precisely these.' },
    ],
    output: { many: false, of: 'Emptied' },
    irreversible: true,
  },
] as const satisfies readonly ServiceDescriptor[]

/**
 * Every declared service name, as a union — the key the handler map is closed
 * over, so a table row with no handler is a type error and a handler for a
 * name the table does not hold is another.
 *
 * Read off the `as const` literal, which is why `TABLE` is private and
 * `SERVICE_TABLE` below is the widened view: the literal's rows each have
 * only the optional fields they actually spell, so a consumer reading
 * `one.irreversible` off the narrow type would not compile.
 */
export type ServiceName = (typeof TABLE)[number]['name']

/** The table, as every consumer reads it. */
/**
 * DEEP-FROZEN BEFORE PUBLICATION, not merely `readonly`.
 *
 * `readonly` is a TypeScript fact and disappears at runtime. This table is
 * the authorization record — every service's grant is read from it — and it
 * is exported from the kernel's public entry, so any module loaded before
 * `buildServices()` could have rewritten a destructive service's grant to a
 * reading one, or renamed a service, and nothing would have noticed: the
 * derived `SERVICE_NAMES` and `BY_NAME` are built from the same objects and
 * would have agreed with the tampered version.
 *
 * Freezing is shallow by default, so this walks: descriptors, their `input`
 * arrays and each field, and `output`. Frozen in place rather than copied,
 * so `BY_NAME` and the row identities stay the same objects the handlers are
 * typed against.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

export const SERVICE_TABLE: readonly ServiceDescriptor[] = deepFreeze(TABLE)

/** Names, in table order. */
export const SERVICE_NAMES: readonly ServiceName[] = Object.freeze(TABLE.map((one) => one.name))

const BY_NAME: ReadonlyMap<string, ServiceDescriptor> = new Map(SERVICE_TABLE.map((one) => [one.name, one]))

/** The descriptor for a name, or null — the router's `unknown-service` and the
 *  CLI's "did you mean" both start here. */
export function serviceDescriptor(name: string): ServiceDescriptor | null {
  return BY_NAME.get(name) ?? null
}

/** Every service on a noun, in table order. The CLI's per-noun help. */
export function servicesOn(noun: ServiceNoun): readonly ServiceDescriptor[] {
  return SERVICE_TABLE.filter((one) => one.noun === noun)
}

/**
 * The services that only READ — the half WI-11.3 landed first, because they
 * carry no concurrency question. Derived from the grant, never declared.
 */
export const readServices = (): readonly ServiceDescriptor[] => SERVICE_TABLE.filter((one) => readingGrant(one.grant))

/** The rest: everything that changes something. */
export const writeServices = (): readonly ServiceDescriptor[] => SERVICE_TABLE.filter((one) => !readingGrant(one.grant))

/**
 * The satchel-side client stubs, derived rather than written — this is
 * `ClientContribution` finally having a consumer (WI-11.6). A capability
 * contributing these declares WHAT IT CALLS; the list is the table's, so a
 * client cannot name a service that does not exist.
 */
export function serviceClients(): readonly ClientContribution[] {
  return SERVICE_TABLE.map((one) => ({ name: one.name }))
}

/** The positional fields of a service, in command-line order. */
export function positionalFields(descriptor: ServiceDescriptor): readonly ServiceField[] {
  return descriptor.input
    .filter((field) => field.positional !== undefined)
    .slice()
    .sort((a, b) => (a.positional ?? 0) - (b.positional ?? 0))
}

/** The fields a caller spells as `--name`. */
export function flagFields(descriptor: ServiceDescriptor): readonly ServiceField[] {
  return descriptor.input.filter((field) => field.positional === undefined)
}
