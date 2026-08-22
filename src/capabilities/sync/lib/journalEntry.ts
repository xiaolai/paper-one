import { MUTATION_KINDS, type MutationKind } from '../../../kernel'
import { isHlc } from './clock'
import type { Hlc } from './clock'

/**
 * WHAT A JOURNAL LINE IS, AND WHETHER SOME BYTES ARE ONE.
 *
 * The parser and its vocabulary, lifted out of `journal.ts` — which had grown
 * past a thousand lines with the parser, the durable writes, the in-memory
 * index, recovery, bootstrap and compaction in one closure. This is the
 * TRUST BOUNDARY: `journal.jsonl` is a file on disk that anything could have
 * written, including a half-finished append from a process that died.
 *
 * It has no dependencies inside the journal at all, which is what makes the
 * split real rather than cosmetic — `journalScan.ts` and `journal.ts` both
 * read it, and neither reads the other.
 */

/**
 * The journal on disk contradicts itself — not a crash artefact.
 *
 * A crash leaves a PREFIX of a valid journal, and a prefix satisfies every
 * load-time invariant; `loadLines` handles that case separately and silently.
 * This is the other thing: an epoch that changes mid-file, a rev that
 * regresses, a seq that goes backwards. Its own type because `open` recovers
 * from exactly this and must not swallow an unreadable disk or a newer format
 * along with it.
 */
export class JournalCorruption extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JournalCorruption'
  }
}

export const SYNC_DIR = 'sync'
export const JOURNAL_PATH = 'sync/journal.jsonl'
export const JOURNAL_META_PATH = 'sync/journal.meta.json'
export const JOURNAL_DIRTY_PATH = 'sync/journal.dirty'
export const JOURNAL_FORMAT = 1
/** The one write-queue key every journal mutation is serialised on. */
export const JOURNAL_KEY = 'sync:journal'

export type JournalOrigin = 'local' | 'remote'
export type JournalState = 'building' | 'ready'

export interface JournalEntry {
  readonly seq: number
  readonly kind: 'begin' | 'commit' | 'acked'
  readonly epoch: string
  readonly book: string
  readonly what: MutationKind
  readonly at: Hlc
  /** On commits and acks. */
  readonly rev?: number
  /**
   * On a runtime commit: the `seq` of the begin this commit settles. A
   * commit must clear ONLY its own bracket — brackets on one key can
   * overlap (cards are not serialised by the book queue), and a commit that
   * swept every dangling begin for the key silently un-announced a write
   * still in flight. Absent on baseline/verify commits, which follow no
   * begin; those clear the key whole, the pre-token behaviour.
   */
  readonly begin?: number
  readonly origin: JournalOrigin
  readonly digest?: string
}

export interface JournalMeta {
  readonly epoch: string
  readonly nextSeq: number
  readonly journalFormat: number
  readonly state: JournalState
}

/* Derived from the kernel's own tuple — a kind added there is valid here
 * the same day, not after someone remembers this copy. */
const KNOWN_KINDS: ReadonlySet<string> = new Set(MUTATION_KINDS)

export const keyOf = (book: string, what: MutationKind): string => `${what}\u0000${book}`

/**
 * The book a `(book, what)` is journaled under. Cards are ONE cross-book
 * surface and their canonical book is `''` — the same key the bootstrap
 * baseline uses. The kernel's card writer records under `''` too; this is
 * the belt for any other caller and for lines written before the rule, so
 * one surface can never split into unrelated rev and outbox streams again.
 */
export const canonicalBook = (book: string, what: MutationKind): string => (what === 'cards' ? '' : book)


/**
 * Validate one PARSED line into an entry — the schema half only. The JSON
 * half stays with the loader, because the two failures mean different
 * things: bytes that do not parse can be a torn append (tolerable at the
 * tail), while a COMPLETE line that is not an entry is corruption wherever
 * it sits, the tail included.
 */
export function entryOf(raw: unknown): JournalEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const e = raw as Record<string, unknown>
  /* SAFE INTEGERS, not merely integers.
   *
   * `Number.isInteger(2 ** 53)` is true, and so is `2 ** 53 === 2 ** 53 + 1`.
   * A counter loaded at or beyond that stops advancing when incremented, so
   * `nextSeq++` yields the same number forever — every later append carries a
   * duplicate seq, which the loader reads as corruption and quarantines. The
   * bound is enormous and a real journal will never approach it; a hand-edited
   * or garbled one can name it in a single character. */
  if (typeof e['seq'] !== 'number' || !Number.isSafeInteger(e['seq']) || e['seq'] < 1) return null
  if (e['kind'] !== 'begin' && e['kind'] !== 'commit' && e['kind'] !== 'acked') return null
  if (typeof e['epoch'] !== 'string' || e['epoch'] === '') return null
  if (typeof e['book'] !== 'string') return null
  if (typeof e['what'] !== 'string' || !KNOWN_KINDS.has(e['what'])) return null
  if (!isHlc(e['at'])) return null
  if (e['origin'] !== 'local' && e['origin'] !== 'remote') return null
  const needsRev = e['kind'] === 'commit' || e['kind'] === 'acked'
  if (needsRev && (typeof e['rev'] !== 'number' || !Number.isSafeInteger(e['rev']) || e['rev'] < 1)) return null
  /* AN INVALID OPTIONAL FIELD IS CORRUPTION, NOT A FIELD TO DROP. A `rev` on a
   * begin, or a non-string / non-commit `digest`, means the line was written
   * by something that did not understand the schema — silently discarding it
   * (the old behaviour) let a garbled line load as a valid entry with its
   * telltale field quietly gone. */
  if (!needsRev && e['rev'] !== undefined) return null
  if (e['digest'] !== undefined && (typeof e['digest'] !== 'string' || e['kind'] !== 'commit')) return null
  const beginRef = e['begin']
  if (
    beginRef !== undefined &&
    (e['kind'] !== 'commit' || typeof beginRef !== 'number' || !Number.isSafeInteger(beginRef) || beginRef < 1 || beginRef >= (e['seq'] as number))
  ) {
    return null
  }
  return {
    seq: e['seq'],
    kind: e['kind'],
    epoch: e['epoch'],
    book: canonicalBook(e['book'], e['what'] as MutationKind),
    what: e['what'] as MutationKind,
    at: e['at'],
    ...(needsRev ? { rev: e['rev'] as number } : {}),
    ...(beginRef === undefined ? {} : { begin: beginRef as number }),
    origin: e['origin'],
    ...(typeof e['digest'] === 'string' ? { digest: e['digest'] } : {}),
  }
}

/**
 * Whether `s` is a strict prefix of some syntactically valid JSON text — the
 * exact shape a crash mid-append leaves of a serialised entry. Arbitrary
 * corruption sitting where the last line should be is NOT such a prefix, and
 * tolerating it as a torn tail would silently erase a line the disk holds.
 *
 * A compact hand-scanner over the JSON grammar rather than a dependency:
 * running out of input mid-value is a valid prefix; a structurally impossible
 * byte, or a complete value with trailing junk, is not.
 */
export function isValidJsonPrefix(s: string): boolean {
  const n = s.length
  if (n === 0) return false

  const skipWs = (i: number): number => {
    while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++
    return i
  }
  /* Each scanner returns the index AFTER a complete token, `n` when the input
   * ran out mid-token (a valid prefix), or -1 for a structural violation. */
  const scanString = (i: number): number => {
    i++
    while (i < n) {
      const c = s[i]!
      if (c === '\\') {
        if (i + 1 >= n) return n
        const e = s[i + 1]!
        if ('"\\/bfnrt'.includes(e)) {
          i += 2
          continue
        }
        if (e === 'u') {
          for (let k = 0; k < 4; k++) {
            if (i + 2 + k >= n) return n
            if (!/[0-9a-fA-F]/.test(s[i + 2 + k]!)) return -1
          }
          i += 6
          continue
        }
        return -1
      }
      if (c === '"') return i + 1
      if (c.charCodeAt(0) < 0x20) return -1
      i++
    }
    return n
  }
  const scanLiteral = (i: number, word: string): number => {
    for (let k = 0; k < word.length; k++) {
      if (i + k >= n) return n
      if (s[i + k] !== word[k]) return -1
    }
    return i + word.length
  }
  const digit = (i: number): boolean => i < n && s[i]! >= '0' && s[i]! <= '9'
  /**
   * JSON's number grammar, not "some digits and maybe a dot".
   *
   * `-? (0 | [1-9][0-9]*) ('.' [0-9]+)? ([eE] [+-]? [0-9]+)?` — and the
   * distinction this whole function exists to make is between RAN OUT (a torn
   * tail, which is a valid prefix) and IMPOSSIBLE (corruption, which must be
   * quarantined rather than silently dropped).
   *
   * The loose version accepted `-`, `01`, `1.` and `1e` as COMPLETE numbers,
   * so `[-]`, `[01]`, `[1.]` and `[1e]` — none of them a prefix of any valid
   * JSON — were read as torn tails and discarded without a word. Every one of
   * those is a corrupt last line, which is exactly the case that must be kept
   * and quarantined: it is the reader's last write.
   *
   * Every `return n` below is "the input ended at a point more input could
   * complete", which is the only shape a crash mid-append leaves.
   */
  const scanNumber = (i: number): number => {
    if (s[i] === '-') {
      i++
      if (i >= n) return n
    }
    if (s[i] === '0') {
      i++
    } else if (digit(i)) {
      while (digit(i)) i++
    } else {
      /* A sign with no number after it, in the middle of the input. */
      return -1
    }
    if (i >= n) return n
    if (s[i] === '.') {
      i++
      if (i >= n) return n
      /* A JSON fraction needs at least one digit; `1.` mid-input is not a
       * number and never becomes one. */
      if (!digit(i)) return -1
      while (digit(i)) i++
      if (i >= n) return n
    }
    if (s[i] === 'e' || s[i] === 'E') {
      i++
      if (i >= n) return n
      if (s[i] === '+' || s[i] === '-') {
        i++
        if (i >= n) return n
      }
      if (!digit(i)) return -1
      while (digit(i)) i++
      if (i >= n) return n
    }
    return i
  }
  const scanValue = (i0: number): number => {
    const i = skipWs(i0)
    if (i >= n) return n
    const c = s[i]!
    if (c === '"') return scanString(i)
    if (c === '{') return scanObject(i)
    if (c === '[') return scanArray(i)
    if (c === 't') return scanLiteral(i, 'true')
    if (c === 'f') return scanLiteral(i, 'false')
    if (c === 'n') return scanLiteral(i, 'null')
    if (c === '-' || (c >= '0' && c <= '9')) return scanNumber(i)
    return -1
  }
  function scanObject(i0: number): number {
    let i = skipWs(i0 + 1)
    if (i >= n) return n
    if (s[i] === '}') return i + 1
    for (;;) {
      i = skipWs(i)
      if (i >= n) return n
      if (s[i] !== '"') return -1
      const afterKey = scanString(i)
      if (afterKey === -1 || afterKey >= n) return afterKey
      i = skipWs(afterKey)
      if (i >= n) return n
      if (s[i] !== ':') return -1
      const afterVal = scanValue(i + 1)
      if (afterVal === -1 || afterVal >= n) return afterVal
      i = skipWs(afterVal)
      if (i >= n) return n
      if (s[i] === '}') return i + 1
      if (s[i] !== ',') return -1
      i++
    }
  }
  function scanArray(i0: number): number {
    let i = skipWs(i0 + 1)
    if (i >= n) return n
    if (s[i] === ']') return i + 1
    for (;;) {
      const afterVal = scanValue(i)
      if (afterVal === -1 || afterVal >= n) return afterVal
      i = skipWs(afterVal)
      if (i >= n) return n
      if (s[i] === ']') return i + 1
      if (s[i] !== ',') return -1
      i++
    }
  }

  const end = scanValue(0)
  if (end === -1) return false
  return skipWs(end) >= n
}
