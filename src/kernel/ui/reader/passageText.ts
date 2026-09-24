import { indexText, type TextIndex } from './reanchor'

/**
 * A book's sections as CANONICAL TEXT — the extractor half of library search.
 *
 * ## ⚠️ ONE CANONICAL WALK, NOT A THIRD COPY
 *
 * This is the single most important decision in phase 31, and it is why there is
 * no EPUB parser in `tauri-plugin-passages`. `indexText` turns a parsed section
 * into one canonical string; `reanchorIn` finds a quote in that same canonical
 * form when a hit is landed. **Both ends of library search are therefore the
 * same function**, and a quote that came out of the index is a string the
 * resolver can find by construction.
 *
 * A Rust extractor would have been a SECOND implementation of that walk, and
 * this repository has already measured what an asymmetry between two such walks
 * costs. `reanchor.ts` records it:
 *
 * > ⚠️ **WITHOUT THIS, `<p>done</p><p>Start</p>` INDEXED AS `doneStart`** — two
 * > paragraphs run together into a word that is in neither of them. … **The bug
 * > was in the asymmetry, not in either walk alone.**
 *
 * At library scale that is every quote near a paragraph start failing silently,
 * across 1 959 books.
 *
 * ## What the canonical form does to a paragraph break, and what that costs
 *
 * `indexText` emits a single SPACE at every `BLOCK_TAGS` edge — a break held
 * exactly like a whitespace run, with a zero-width origin. So `<p>done</p>
 * <p>Start</p>` is `done Start`, which is what makes the two walks agree.
 *
 * ⚠️ **THE CONSEQUENCE, STATED RATHER THAN GLOSSED: A PHRASE QUERY CAN CROSS A
 * PARAGRAPH BREAK.** `"done start"` matches there, and in the book those are two
 * paragraphs. It was considered and accepted rather than repaired, and the
 * reason is the paragraph above: every repair on offer — a sentinel character,
 * a position gap, indexing per block — makes the indexed string differ from the
 * string the resolver searches, which is the asymmetry this whole module exists
 * to refuse. The hit is TRUE (those words are there, in that order) and it
 * LANDS, which are the two properties that matter. Precision loses a little;
 * nothing fails silently.
 *
 * ## It is not on the reading path
 *
 * `parseBook.ts` already reaches `makeBook()` without rendering, for the reason
 * its header gives — *"two thousand books are not going to be laid out one at a
 * time"* — and this is the same posture. A cold section is 3.46 ms end to end
 * with 1.76 ms of that in the index, so a forty-section book is ~139 ms of work
 * that must be spent in forty pieces with the main thread handed back between
 * them. `reanchorPass.ts` is the precedent and its `live()`/`breathe()` pair is
 * copied here deliberately: neither has a default that skips, so a caller that
 * supplies neither gets a walk that never yields.
 */

/** One section, extracted. */
export interface ExtractedSection {
  readonly index: number
  readonly text: string
}

/** What a book yielded, and whether the walk finished. */
export interface Extraction {
  readonly sections: readonly ExtractedSection[]
  /** False when `live()` went false — the caller must not record a partial book. */
  readonly complete: boolean
  /** Sections whose document would not parse. Reported, never silently skipped. */
  readonly unreadable: readonly number[]
}

export interface ExtractDeps {
  /** How many spine items the book has. */
  readonly sections: number
  /**
   * The document for one section, or null when there is none to parse.
   *
   * The same contract `reanchorPass.PassDeps` states: a CFI is a PATH, so this
   * does not need the section rendered — `section.createDocument()` parses an
   * unopened one, and `refuseBookScripts` wraps every one of them.
   */
  readonly documentFor: (index: number) => Promise<Node | null>
  /** False the moment this extraction stops being wanted. Asked before every section. */
  readonly live: () => boolean
  /** Hand the main thread back. Awaited between sections. */
  readonly breathe: () => Promise<void>
}

/**
 * The longest a section's canonical text may be.
 *
 * ⚠️ **A BOUND, BECAUSE A BOOK IS SOMEBODY ELSE'S FILE.** A single-file EPUB —
 * they exist, and a few of them are whole novels — is one "section" of several
 * megabytes, which would cross the IPC as one JSON string and sit in the index
 * as one document that every query has to snippet. Truncating loses the tail of
 * one unusual book; not bounding it makes the whole backfill's memory a number
 * a publisher chose.
 *
 * ⚠️ **AND IT IS TRUNCATED, NOT DROPPED, AND THE TRUNCATION IS REPORTED.**
 * A section silently cut is a search that quietly does not cover the end of a
 * book — see `Extraction.unreadable`, which is the same rule one level up.
 */
export const MAX_SECTION_CHARS = 2_000_000

/**
 * Walk a book once and canonicalise every section.
 *
 * ⚠️ **AN INTERRUPTED WALK ANSWERS `complete: false` AND THE CALLER MUST NOT
 * RECORD IT.** `reanchorPass` takes the same posture for the same reason: a
 * partial book written to the index as though it were whole is a book whose
 * later chapters are permanently unsearchable, with the state file saying it is
 * done. The sections found so far are still returned, because a caller that
 * wants to resume wants them; what is forbidden is checkpointing them.
 */
export async function extractSections(deps: ExtractDeps): Promise<Extraction> {
  if (!Number.isInteger(deps.sections) || deps.sections <= 0) {
    return { sections: [], complete: false, unreadable: [] }
  }
  const sections: ExtractedSection[] = []
  const unreadable: number[] = []
  for (let index = 0; index < deps.sections; index += 1) {
    /* ASKED BEFORE THE WORK, not after: checking afterwards still pays for the
     * section nobody is waiting for any more. */
    if (!deps.live()) return { sections, complete: false, unreadable }
    if (index > 0) await deps.breathe()
    if (!deps.live()) return { sections, complete: false, unreadable }

    let doc: Node | null = null
    try {
      doc = await deps.documentFor(index)
    } catch {
      /* ⚠️ **A SECTION THAT WOULD NOT PARSE IS RECORDED, NOT SKIPPED.**
       * `reanchorPass` abandons the whole walk here, and it is right to: a miss
       * there means *"this passage is nowhere in the book"*, which one
       * unreadable section makes unsayable. An INDEX is different — the rest of
       * the book is still worth having — but the gap must be visible, because a
       * chapter missing from search looks exactly like a chapter with no
       * matches. */
      unreadable.push(index)
      continue
    }
    /* ⚠️ **CHECKED AFTER THE AWAIT TOO.** `documentFor` is the slow step, and
     * there is no next iteration to catch a walk abandoned during the last
     * section's parse. */
    if (!deps.live()) return { sections, complete: false, unreadable }
    /* A spine item a backend does not build — an unstyled cover, a nav document
     * — has nothing to index and says so by answering null rather than
     * throwing. That is not an unreadable section. */
    if (!doc) continue

    const text = canonicalTextOf(doc)
    /* AN EMPTY SECTION IS LEFT OUT rather than stored as a document with no
     * words: an empty posting list is a document every `num_docs` counts and no
     * query can ever reach. */
    if (text === '') continue
    sections.push({ index, text })
  }
  return { sections, complete: true, unreadable }
}

/**
 * The node `indexText` should actually be given.
 *
 * ⚠️ **HANDING `indexText` A `Document` ANSWERS THE EMPTY STRING, SILENTLY.**
 * Its walk dispatches on `nodeType` and handles only elements and text nodes; a
 * `Document` is neither (it is 9), so the walk returns before descending and
 * every section comes back with no words in it — an index that builds cleanly,
 * reports success, and can never answer a query.
 *
 * `session.ts` already writes `doc.body ?? doc` at the one existing call site
 * for this reason. Normalising here rather than relying on every caller to
 * remember is the difference between a rule and a convention, and the cost of
 * forgetting it is an entire library that quietly cannot be searched.
 */
export function bodyOf(root: Node): Node {
  const body = (root as Partial<Document>).body
  return body ?? root
}

/**
 * One parsed document as the canonical string the resolver searches.
 *
 * ⚠️ **`indexText(…).text` AND NOTHING ELSE.** Every transform applied here is
 * a transform `reanchorIn` does not know about, and a quote that has been
 * through one is a quote the landing cannot find. The only things this adds are
 * the body resolution above and the bound below — one a correction of what is
 * walked, the other a decision about size. Neither touches the content.
 */
export function canonicalTextOf(root: Node): string {
  const index: TextIndex = indexText(bodyOf(root))
  return index.text.length > MAX_SECTION_CHARS
    ? index.text.slice(0, MAX_SECTION_CHARS)
    : index.text
}
