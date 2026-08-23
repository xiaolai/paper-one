/**
 * The world the `createKernelServices` suites are driven in.
 *
 * Extracted because the three suites that split out of `services.test.ts` all
 * need the same recorder spy, the same one-book shelf and the same way of
 * holding an operation open — and each copy of a held-open promise had grown
 * its own spelling, one of which TypeScript narrows to `never` unless it is
 * written exactly the way `deferred` writes it.
 *
 * A `.testkit.ts`, not a `.test.ts`: `check-test-projects.mjs` requires a
 * `.test.` segment to enrol a file as a suite, so this one is imported rather
 * than run.
 */

import type { IndexedBook } from './bookIndex'
import { fakeFs } from './fakeFs.testkit'
import type { MutationKind, MutationRecorder, MutationToken } from './ports'
import { createKernelServices } from './services'

export const BOOK: IndexedBook = { bookId: 'book_x', title: 'X', author: '', openedAt: 1 }
export const CONTENT = 'books/book_x/content.epub'

export interface SpyRecorder {
  recorder: MutationRecorder
  kinds: MutationKind[]
  commits: MutationToken[]
}

/** Records both halves of every bracket, so a dropped commit is visible. */
export function spyRecorder(): SpyRecorder {
  const kinds: MutationKind[] = []
  const commits: MutationToken[] = []
  return {
    kinds,
    commits,
    recorder: {
      begin: async (book: string, what: MutationKind): Promise<MutationToken> => {
        kinds.push(what)
        return { book, what }
      },
      commit: async (token: MutationToken) => {
        commits.push(token)
      },
    },
  }
}

/**
 * A promise the test opens when it wants the operation under test to proceed.
 *
 * The initialiser assignment is what makes this type-check: a `let open` left
 * unassigned is narrowed to `never` at the point the promise executor writes
 * it, and every hand-rolled copy of this had worked around that differently.
 */
export function deferred(): { readonly promise: Promise<void>; open(): void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open: () => open() }
}

export interface GatedRecorder extends SpyRecorder {
  /** Resolves once `begin` has been entered — the bracket is now open. */
  began: Promise<void>
  /** Lets that `begin` return, closing the window. */
  release: () => void
}

/** A recorder whose `begin` waits inside the bracket until the test lets go. */
export function gatedRecorder(): GatedRecorder {
  const spy = spyRecorder()
  const entered = deferred()
  const held = deferred()
  return {
    ...spy,
    began: entered.promise,
    release: () => held.open(),
    recorder: {
      begin: async (book: string, what: MutationKind): Promise<MutationToken> => {
        spy.kinds.push(what)
        entered.open()
        await held.promise
        return { book, what }
      },
      commit: spy.recorder.commit,
    },
  }
}

/** A one-book shelf on a fake filesystem, with `defaultRecorder` in the slot. */
export function servicesWith(defaultRecorder: MutationRecorder) {
  const fs = fakeFs({ 'books/book_x/book.json': JSON.stringify({ bookId: 'book_x', title: 'X' }) })
  return createKernelServices({ fs, storage: null, initialBooks: [BOOK], recorder: defaultRecorder })
}

/** The same shelf, but with the two blobs `removeBlob` is allowed to take. */
export function blobWorld() {
  const spy = spyRecorder()
  const fs = fakeFs({
    'books/book_x/book.json': JSON.stringify({ bookId: 'book_x', title: 'X' }),
    [CONTENT]: 'bytes',
    'books/book_x/cover.jpg': 'jacket',
  })
  const services = createKernelServices({ fs, storage: null, initialBooks: [BOOK], recorder: spy.recorder })
  return { fs, services, spy }
}
