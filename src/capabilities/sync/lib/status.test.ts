import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ServiceCallError, serviceError } from '../../../kernel'
import { REFUSAL_KINDS, describeRefusal, describeSession, refusalKind, type RefusalKind } from './status'

/**
 * WI-20.25 — the words. Every way a session can be refused used to reach the
 * reader as one sentence, "Paper on your Mac isn't reachable", which was
 * wrong for a revoked device, a version skew and a full disk alike, and
 * "Mac" was a guess about hardware the reader may not own. One sentence per
 * kind, and the shelf's own name in it.
 */
describe('one sentence per refusal kind', () => {
  const names = { shelf: 'Study iMac', title: () => 'Moby-Dick' }

  it.each(REFUSAL_KINDS)('%s has its own sentence', (kind) => {
    const sentence = describeRefusal({ kind, book: 'book:a', message: 'raw detail' }, names)
    expect(sentence.length).toBeGreaterThan(10)
    const others = REFUSAL_KINDS.filter((other) => other !== kind).map((other) =>
      describeRefusal({ kind: other, book: 'book:a', message: 'raw detail' }, names),
    )
    expect(others).not.toContain(sentence)
  })

  it('names the shelf where the sentence is about the shelf, and the book where it is about a book', () => {
    expect(describeRefusal({ kind: 'unreachable', message: '' }, names)).toBe('Paper on Study iMac isn’t reachable')
    expect(describeRefusal({ kind: 'unreachable', message: '' }, { shelf: null, title: () => null })).toBe(
      'Your library isn’t reachable',
    )
    expect(describeRefusal({ kind: 'conflict', book: 'book:a', message: '' }, names)).toContain('“Moby-Dick”')
    expect(describeRefusal({ kind: 'conflict', book: 'book:a', message: '' }, names)).toContain('Study iMac')
    // A book whose title is not known is named by its id rather than left out.
    expect(describeRefusal({ kind: 'conflict', book: 'book:a', message: '' }, { shelf: null, title: () => null })).toContain(
      'book:a',
    )
  })

  it('never says Mac', () => {
    for (const kind of REFUSAL_KINDS) {
      expect(describeRefusal({ kind, book: 'book:a', message: 'x' }, names)).not.toMatch(/\bMac\b/)
    }
  })
})

describe('classifying what a session threw', () => {
  const remote = (code: string, retryable = false) => new ServiceCallError('sync.push', serviceError(code, 'm', retryable))
  const cases: readonly [unknown, RefusalKind][] = [
    [remote('disconnected'), 'unreachable'],
    [remote('timeout'), 'unreachable'],
    [remote('forbidden'), 'revoked'],
    [remote('unsupported'), 'unsupported'],
    [remote('not-ready', true), 'not-ready'],
    [remote('conflict'), 'conflict'],
    [remote('unreadable', true), 'unreadable'],
    [remote('content-unavailable', true), 'content'],
    [remote('unverifiable', true), 'content'],
    [remote('malformed'), 'broken-peer'],
    [remote('protocol'), 'broken-peer'],
    [remote('internal'), 'broken-peer'],
    // The ledger's own local refusals are plain `{code, retryable, message}` objects.
    [{ code: 'unreadable', retryable: true, message: 'book.json is there but could not be read' }, 'unreadable'],
    [{ code: 'unsupported', retryable: false, message: 'the shelf speaks sync [2, 2]' }, 'unsupported'],
    // The peer plugin's errors are `{kind, message}`; a refused session names its reason in the message.
    [{ kind: 'sessionRefused', message: 'session refused: revoked' }, 'revoked'],
    [{ kind: 'sessionRefused', message: 'session refused: unknown-peer' }, 'revoked'],
    [{ kind: 'sessionRefused', message: 'session refused: role-mismatch' }, 'role-mismatch'],
    [{ kind: 'sessionRefused', message: 'session refused: not-ready' }, 'not-ready'],
    [{ kind: 'roleMismatch', message: 'expected shelf, got satchel' }, 'role-mismatch'],
    [{ kind: 'peerUnknown', message: 'no peer x' }, 'unpaired'],
    [{ kind: 'iroh', message: 'peer unreachable' }, 'unreachable'],
    [{ kind: 'connect', message: 'no route' }, 'unreachable'],
    [{ kind: 'timeout', message: 'dial timed out' }, 'unreachable'],
    [{ kind: 'blobRefused', message: 'ungranted' }, 'revoked'],
    [{ kind: 'blobHashMismatch', message: 'digest differs' }, 'content'],
    [{ kind: 'blobInterrupted', message: 'short read' }, 'content'],
    [new Error('not paired with a shelf'), 'unpaired'],
    [new Error('No space left on device (os error 28)'), 'disk-full'],
    [new DOMException('the quota has been exceeded', 'QuotaExceededError'), 'disk-full'],
    [new Error('sync.push answered an ack that does not match the pushed group'), 'broken-peer'],
    [new Error('something else entirely'), 'unknown'],
    ['a string', 'unknown'],
    [null, 'unknown'],
  ]
  it.each(cases)('%o → %s', (thrown, kind) => {
    expect(refusalKind(thrown)).toBe(kind)
  })
})

describe('the status line after a session', () => {
  const names = { shelf: 'Study iMac', title: (book: string) => (book === 'book:z' ? 'Zeta' : null) }
  const none = { held: 0, dropped: 0, repaired: 0 }

  it('is nothing when nothing was refused', () => {
    expect(describeSession({ refused: [], quarantine: none }, names)).toBeNull()
  })

  it('names the refused book, and counts the rest', () => {
    const one = describeSession({ refused: [{ book: 'book:z', kind: 'conflict', message: '' }], quarantine: none }, names)
    expect(one).toContain('“Zeta”')
    const three = describeSession(
      {
        refused: [
          { book: 'book:z', kind: 'conflict', message: '' },
          { book: 'book:y', kind: 'broken-peer', message: '' },
          { book: 'book:x', kind: 'conflict', message: '' },
        ],
        quarantine: none,
      },
      names,
    )
    expect(three).toContain('“Zeta”')
    expect(three).toMatch(/2 more/)
  })

  it('says how many books’ highlights were set aside, and how many more were dropped unread', () => {
    const line = describeSession({ refused: [], quarantine: { held: 64, dropped: 6, repaired: 0 } }, names)
    expect(line).toMatch(/64 books/)
    expect(line).toContain('Study iMac')
    expect(line).toMatch(/6 more/)
    // Repaired ones are not a complaint.
    expect(describeSession({ refused: [], quarantine: { held: 0, dropped: 0, repaired: 3 } }, names)).toBeNull()
  })
})

/**
 * THE SOURCE GUARD. "Mac" was hard-coded in four strings across the two
 * capabilities — a guess about the reader's hardware, and wrong on a phone
 * paired to a Linux desktop. The device's own name goes where the sentence is
 * about a device. Comments are not strings and are not the reader's; they are
 * stripped before the search.
 */
describe('no string under peer/ or sync/ says Mac', () => {
  const ROOT = fileURLToPath(new URL('../..', import.meta.url))
  const sources = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) out.push(...sources(path))
      else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|testkit)\.tsx?$/.test(entry)) out.push(path)
    }
    return out
  }
  /* Block comments keep their newlines so the reported line numbers are the
   * file's own; a `//` preceded by `:` is a URL inside a string, not a comment. */
  const withoutComments = (text: string): string =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
      .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')

  it('finds nothing', () => {
    const offenders: string[] = []
    for (const dir of ['peer', 'sync']) {
      for (const file of sources(join(ROOT, dir))) {
        const lines = withoutComments(readFileSync(file, 'utf8')).split('\n')
        lines.forEach((line, i) => {
          if (/\bMac\b/.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`)
        })
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('audit-fix round 1 — what the classifier got wrong', () => {
  const names = { shelf: 'Study iMac', title: () => null }
  it('an unknown code falls through to the disk-full tell instead of answering unknown first', () => {
    expect(refusalKind({ code: 'ENOSPC', message: 'no space left on device' })).toBe('disk-full')
  })
  it('a refusal reason this build does not know is unknown — the peer was reached', () => {
    expect(refusalKind({ kind: 'sessionRefused', message: 'some-new-reason' })).toBe('unknown')
  })
  it('the raw message never becomes the sentence', () => {
    expect(describeRefusal({ kind: 'unknown', message: '/Users/x/Library/…/journal: EACCES' }, names)).toBe('Sync failed')
  })
  it('one dropped book is set aside in the singular', () => {
    const line = describeSession({ refused: [], quarantine: { held: 1, dropped: 1, repaired: 0 } }, names)
    expect(line).toMatch(/1 more was set aside unread/)
  })
  it('the tuple is the type: every kind in the list has a sentence, and the list is the whole type', () => {
    for (const kind of REFUSAL_KINDS) expect(describeRefusal({ kind, message: '' }, names)).not.toBe('')
  })
})
