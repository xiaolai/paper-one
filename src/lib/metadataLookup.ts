/**
 * Ask Open Library about one book, because the reader asked.
 *
 * Decision 1: EXPLICIT, PER BOOK, OFF BY DEFAULT. Never automatic, never on
 * import, never in bulk. This is the only network egress in the library, and a
 * reader who never touches it never emits a packet.
 *
 * That is a posture, not a limitation. Paper is a local reader; a book's title
 * and author are a fair description of what someone reads, and shipping that to
 * a third party to tidy up a shelf is not a trade to make on anyone's behalf.
 * The control exists for the case it is actually good at — a book whose OPF says
 * "Unknown" — and it costs a deliberate click.
 *
 * OPEN LIBRARY rather than Google Books. No key, no quota, and a works-versus-
 * editions model that lines up with `workId` against `bookId` almost exactly:
 * a work is the book, an edition is a printing of it, and Paper already
 * distinguishes those. Google Books caps near a thousand requests a day, which
 * an explicit-only feature would never reach — but it needs a key, and a key
 * would have to ship in the binary.
 */

/** What a lookup can fill in. Every field optional — this is a suggestion. */
export interface LookupResult {
  readonly title?: string
  readonly author?: string
  readonly publisher?: string
  readonly published?: string
  readonly subjects?: readonly string[]
  /** Where it came from, so the reader can see what they are accepting. */
  readonly source: string
}

const ENDPOINT = 'https://openlibrary.org/search.json'

/** Bounded like every other untrusted field — see `readMeta`'s caps. */
const MAX_FIELD = 500
const MAX_SUBJECTS = 12

const cap = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_FIELD) : undefined

/**
 * Look up a book by what Paper already knows about it.
 *
 * Returns null when nothing matched, when the network failed, or when the
 * response was not the shape expected. All three are the same outcome from the
 * reader's side — no suggestion — and distinguishing them in the UI would be
 * noise about somebody else's server.
 */
export async function lookupMetadata(
  { title, author }: { title: string; author?: string },
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<LookupResult | null> {
  const query = [title, author].filter(Boolean).join(' ').trim()
  if (!query) return null

  const url = new URL(ENDPOINT)
  url.searchParams.set('q', query)
  // One result. This is a suggestion for one book, not a picker, and asking for
  // a hundred to show one is somebody else's bandwidth spent on nothing.
  url.searchParams.set('limit', '1')
  /* Named explicitly rather than taking the default document. Open Library
   * returns a large record per result otherwise — the whole edition list among
   * it — and none of it is used. */
  url.searchParams.set('fields', 'title,author_name,publisher,first_publish_year,subject')

  try {
    const response = await fetchImpl(url.toString(), {
      ...(signal ? { signal } : {}),
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    const first = (body as { docs?: unknown[] })?.docs?.[0]
    if (!first || typeof first !== 'object') return null
    const doc = first as Record<string, unknown>

    const result: LookupResult = {
      ...(cap(doc['title']) ? { title: cap(doc['title'])! } : {}),
      ...(cap(firstOf(doc['author_name'])) ? { author: cap(firstOf(doc['author_name']))! } : {}),
      ...(cap(firstOf(doc['publisher'])) ? { publisher: cap(firstOf(doc['publisher']))! } : {}),
      ...(typeof doc['first_publish_year'] === 'number'
        ? { published: String(doc['first_publish_year']) }
        : {}),
      ...(Array.isArray(doc['subject'])
        ? {
            subjects: doc['subject']
              .map(cap)
              .filter((one): one is string => Boolean(one))
              .slice(0, MAX_SUBJECTS),
          }
        : {}),
      source: 'Open Library',
    }
    // A result with nothing but a provenance line is not a result.
    return result.title || result.author ? result : null
  } catch {
    return null
  }
}

function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value
}
