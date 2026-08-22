import {
  buildServices,
  createKernelServices,
  grantCovers,
  recordPath,
  type BookRecord,
  type IndexedBook,
  type DevicePort,
  type KernelServices,
  type ServiceContribution,
  type ShelfPort,
  type SizePort,
} from '../../../kernel'
import { fakeFs } from '../../../kernel/testkit'
import { ENVELOPE_ERRORS, ServiceCallError, createClient, createRouter, decodeFrame, type Client } from './envelope'

/**
 * The kernel's service table, served over the REAL router (phase 11).
 *
 * The suites that use this live under `src/capabilities/peer/` on purpose,
 * and the plan's own verify command says so: the property under test is that
 * a service is refused BEFORE its handler sees a byte, and that refusal is
 * the router's to make. Testing the handler alone would prove the handler,
 * and testing the router alone would prove it against `example.ping`.
 * Together they prove the thing that actually ships.
 *
 * Everything the kernel side needs crosses through the kernel's public entry,
 * which is the only kernel module anything outside it may import; nothing
 * here reaches past it.
 */

/** A shelf row with just enough on it to be listed, searched and counted. */
export function seedBook(bookId: string, fields: Partial<BookRecord> & { hasContent?: boolean } = {}): IndexedBook {
  return {
    bookId,
    title: `Title ${bookId}`,
    author: `Author ${bookId}`,
    addedAt: 1_700_000_000_000,
    ...fields,
  }
}

/**
 * A mark row as `marks.json` holds one — every field `isMark` demands.
 *
 * Spelled out rather than defaulted, because `validMarks` FILTERS: a row
 * missing `sectionIndex`, or carrying a kind outside the registry, is dropped
 * silently, and a fixture built that way asserts that two hosts read zero
 * marks identically.
 */
export function markRow(id: string, book: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    bookId: book,
    cfi: `epubcfi(/6/4!/4/2/${id})`,
    sectionIndex: 0,
    text: '',
    note: '',
    kind: 'highlight',
    chapter: '',
    createdAt: 1_700_000_000_000,
    ...fields,
  }
}

export interface ServedShelf {
  readonly services: KernelServices
  /** The store behind the shelf, so a write can be checked where it landed. */
  readonly fs: ReturnType<typeof fakeFs>
  readonly client: Client
  /** Narrow the peer's grants mid-session — the router re-asks on every frame. */
  setGrants(grants: readonly string[]): void
  /** The `req` frames the router has been handed, in order. */
  readonly toRouter: readonly string[]
  /**
   * Every service whose HANDLER was entered, in order.
   *
   * The observation that makes "refused before the handler saw a byte" an
   * assertion rather than a hope: it is recorded by wrapping each built
   * handler, so it is true for every service in the table and not only for
   * the ones that happen to read a store.
   */
  readonly ran: readonly string[]
}

/**
 * A router over the whole service table, a client wired straight into it, and
 * the grants the peer holds — changeable, because revocation taking effect on
 * an open session is a property the router has and this table must not lose.
 */
export function serveTable(options: {
  readonly books?: readonly IndexedBook[]
  readonly files?: Record<string, string>
  readonly grants?: readonly string[]
  /* The three ports the table's outward nouns need. Bound rather than passed
   * into the environment, because that is how they arrive in the app: a
   * capability's `start` binds them AFTER the services were built. */
  readonly devices?: DevicePort
  readonly shelf?: ShelfPort
  readonly sizes?: SizePort
  readonly services?: readonly ServiceContribution[]
  /** Whether the seeded shelf stands for one that was actually read. */
  readonly shelfRead?: boolean
} = {}): ServedShelf {
  const seeded = options.books ?? []
  /* THE RECORDS, NOT ONLY THE INDEX. `initialBooks` primes the in-memory
   * shelf; `book.json` is what the shelf actually IS. Seeding one without the
   * other built a store no real library can be in — a row whose record is
   * missing — and every write service reads the record first, so `book.set`
   * and `tag.add` were being proven against a shape they never meet.
   *
   * A file the caller supplied wins: a suite that wants the two to disagree
   * (a stale row, an unreadable record) says so by writing the path itself. */
  const files: Record<string, string> = { ...(options.files ?? {}) }
  for (const book of seeded) {
    const path = recordPath(book.bookId)
    if (path in files) continue
    /* `hasContent` is DERIVED from the folder and never stored — writing it
     * into the record would seed the exact disagreement the index exists to
     * settle. `bookId` is stored, and is what a rescan reads back. */
    const { hasContent: _derived, ...record } = book
    files[path] = JSON.stringify(record)
  }
  const fs = fakeFs(files)
  const services = createKernelServices({
    fs,
    storage: null,
    initialBooks: seeded,
    ...(options.shelfRead === undefined ? {} : { shelfRead: options.shelfRead }),
  })
  if (options.devices) services.bindDevicePort(options.devices)
  if (options.shelf) services.bindShelfPort(options.shelf)
  if (options.sizes) services.bindSizePort(options.sizes)
  let grants: readonly string[] = options.grants ?? ['book:*', 'mark:*', 'card:*', 'device:*', 'shelf:*']
  const ran: string[] = []
  const built = options.services ?? buildServices({ services })
  const contributions = built.map((one) => ({
    ...one,
    handler: (req: unknown, ctx: Parameters<ServiceContribution['handler']>[1]) => {
      ran.push(one.name)
      return one.handler(req, ctx)
    },
  }))
  const router = createRouter({
    services: contributions,
    /* THE CANONICAL RULE, not a restatement of it. The copy that stood here
     * read `grant.slice(0, grant.indexOf(':'))`, which on a colonless grant
     * slices off the last character instead of refusing — so `admin` asked
     * about `admi:*`, and a table row spelled without a family would have been
     * authorised by a rule the shipping router does not use. A test harness
     * that judges access by its own rule proves its own rule. */
    hasGrant: (_peer, grant) => grantCovers(grants, grant),
    timeoutMs: 5_000,
  })
  const toRouter: string[] = []
  let client!: Client
  const connection = router.connect('peer', (bytes) => client.receive(bytes))
  client = createClient({
    send: (bytes) => {
      const frame = decodeFrame(bytes)
      if (frame.kind === 'req') toRouter.push(frame.service)
      connection.receive(bytes)
    },
    timeoutMs: 5_000,
  })
  return {
    services,
    fs,
    client,
    toRouter,
    ran,
    setGrants: (next) => {
      grants = next
      connection.recheckGrants()
    },
  }
}

/**
 * The `err` code a rejected call carried, or the rejection itself.
 *
 * IT REFUSES A VALUE THAT IS NOT A REJECTION. Every caller spells this
 * `call(...).catch(refusalCode)`, and `catch` does not run when the call
 * SUCCEEDS — the resolved value arrives here instead, gets stringified, and a
 * service that wrongly allowed the request could satisfy an assertion written
 * to prove it was refused. Throwing is the difference between a test that
 * checks a refusal and one that checks a string.
 */
export function refusalCode(error: unknown): string {
  if (error instanceof ServiceCallError) return error.error.code
  if (!(error instanceof Error)) {
    throw new Error(`refusalCode: expected a rejection, got a resolved value: ${JSON.stringify(error) ?? String(error)}`)
  }
  return String(error)
}

export const FORBIDDEN = ENVELOPE_ERRORS.forbidden
