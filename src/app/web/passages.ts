import type { PassageHit } from '../../kernel'

/**
 * Searching the whole shelf, from a browser — WI-31.6's other half.
 *
 * ⚠️ **THE BROWSER CLIENT NEEDS CODE, NOT JUST A ROW**, and the plan says so:
 * *"`Reader.tsx` mounts `SearchPanel` with its current-book adapter only, and a
 * desktop-only capability binds nothing in a browser."* The `passages`
 * capability is `platforms: ['desktop']`, so nothing here has an index — what a
 * browser has is the SHELF, over the same envelope everything else here goes
 * over.
 *
 * ⚠️ **AND THE ROW IS SERVED TO THIS SESSION AND NOT TO A PAIRED DEVICE.**
 * `passage.search` declares `audience: 'this-shelf'`, which is the app and the
 * reader's own authenticated browser session — theirs, not somebody else's. A
 * peer holding `blob:read` to RECEIVE a library is refused, because reading a
 * book's bytes and interrogating the whole library are not the same capability.
 * `servableToAnotherDevice` is what enforces it, in the peer host.
 *
 * ## What this file is NOT
 *
 * It is not a fallback. Absent — no shelf, an old shelf that does not declare
 * the row — the panel is handed no `searchLibrary` at all, draws no scope
 * switch, and is exactly what it was before phase 31. A stub answering an empty
 * list would tell a reader *"nothing in your library says that"*, which is a
 * wrong answer rather than a missing one.
 */

/** The half of the shelf channel this needs. */
export interface PassageChannel {
  stream(service: string, body: unknown): AsyncIterable<unknown>
}

/**
 * Read one hit, refusing one that is not the shape it claims.
 *
 * ⚠️ **CHECKED HERE TOO, AND THAT IS NOT A SECOND COPY OF `rows.ts`.** That file
 * reads what the PLUGIN answers, over Tauri, in the app. This reads what a
 * SHELF answers, over a WebSocket, to a browser — a different wire, a different
 * trust boundary, and the only thing they share is the shape's name. A browser
 * that trusted the frames it was handed would render a hit with no quote as an
 * empty clickable row, and one with a `sectionIndex` of `"3"` would land the
 * reader in no chapter at all.
 */
export function hitOf(raw: unknown): PassageHit | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  if (typeof row.bookId !== 'string' || row.bookId === '') return null
  if (!counted(row.sectionIndex) || !counted(row.offset)) return null
  if (typeof row.quote !== 'string' || row.quote === '') return null
  if (typeof row.prefix !== 'string' || typeof row.suffix !== 'string') return null
  if (!Number.isFinite(row.score)) return null
  return {
    bookId: row.bookId,
    sectionIndex: row.sectionIndex,
    offset: row.offset,
    quote: row.quote,
    prefix: row.prefix,
    suffix: row.suffix,
    score: row.score as number,
  }
}

/** A count: whole, and not negative. No narrowing test in front — see `rows.ts`. */
function counted(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

/**
 * Search the shelf's index over the envelope.
 *
 * ⚠️ **`passage.search` IS A `stream`, NOT A CALL**, and `books.ts` records what
 * asking the wrong question costs: *"the shelf was answering correctly the whole
 * time and saying no; the client was asking the wrong question"*. A page may
 * arrive as one row or as an array of them, so both are flattened — the same
 * shape `book.list` is read with, two files up.
 *
 * ⚠️ **A REFUSAL IS RE-THROWN, NOT SWALLOWED.** The panel tells a query the
 * reader can fix from an index that will not open, and it can only do that if
 * the refusal reaches it — `rejectedByQuery` reads the `malformed` code the
 * handler sets. Caught here and answered as an empty list, every refused query
 * would read as *"nothing in your library says that"*.
 */
export function searchPassages(channel: PassageChannel) {
  return async (query: string, limit?: number): Promise<readonly PassageHit[]> => {
    /* ANSWERED HERE RATHER THAN SENT. The panel asks on every keystroke and is
     * simply between questions; the shelf refuses an empty query by name, which
     * is right for a caller that meant something and wrong for a debounce. */
    if (query.trim() === '') return []
    const hits: PassageHit[] = []
    const body = limit === undefined ? { query } : { query, limit }
    for await (const page of channel.stream('passage.search', body)) {
      const rows = Array.isArray(page) ? page : [page]
      for (const raw of rows) {
        const hit = hitOf(raw)
        /* A row this build cannot read is LEFT OUT rather than drawn half
         * built. One bad row is dropped alone — the other half of the rule
         * that refuses a reply which is not a list. */
        if (hit) hits.push(hit)
      }
    }
    return hits
  }
}
