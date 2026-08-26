import { folderOf } from './bookFolder'

/**
 * ONE LIBRARY, MEASURED BY EVERY HOST — the fixture behind the size port's
 * conformance tests.
 *
 * ## The defect this exists for
 *
 * `SizePort.libraryBytes` promises "bytes the whole library occupies", and
 * there were TWO implementations of it: the kernel's walk, which started at
 * `books/`, and the Node host's own copy, which started at the data root. So
 * `shelf.status.bytes` depended on which host answered — the desktop's number
 * silently omitted `index.json`, the flat store, the sync metadata and
 * everything in the trash. It was the number a reader saw when deciding what
 * to delete, and the gap grew with exactly the things they could not see.
 *
 * Two copies of one contract is how they came to disagree, and a test of each
 * copy on its own could never have caught it: both were internally consistent.
 * There is one walk now, and the way to keep it one is for every binding to be
 * asked the SAME question and held to the SAME answer.
 *
 * ## Why it is a testkit rather than a shared test file
 *
 * The boundaries do not let one module see both bindings, and they are right
 * not to: nothing under `src/kernel/` may import a host, and a host may import
 * only the kernel's public entry. This entry is the designed way through —
 * `kernel-testkit-in-tests-only` refuses an edge to it from anything that is
 * not a test — so the fixture is shared without either binding learning the
 * other exists.
 */

/**
 * `path → bytes`, relative to the data root.
 *
 * ⚠️ **DELIBERATELY NOT ALL UNDER `books/`.** Everything outside it is what the
 * `books/`-only walk missed, and a fixture that lived entirely inside `books/`
 * would pass against the defect.
 */
export const LIBRARY_FIXTURE: Readonly<Record<string, number>> = {
  [`${folderOf('bk1')}/content.epub`]: 100,
  [`${folderOf('bk1')}/cover.jpg`]: 20,
  [`${folderOf('bk1')}/marks.json`]: 5,
  [`${folderOf('bk2')}/content.pdf`]: 300,
  /* ---- outside `books/` ---- */
  'index.json': 7,
  'store.json': 3,
  'trash/bk3/content.epub': 40,
  'sync/peers.json': 2,
}

/** What every host must answer for `libraryBytes` over that fixture. */
export const LIBRARY_FIXTURE_BYTES = Object.values(LIBRARY_FIXTURE).reduce((sum, n) => sum + n, 0)

/**
 * What the `books/`-only walk would have answered.
 *
 * Named so an assertion cannot pass by accident: a host answering THIS has
 * regressed to the defect, and saying so is more useful than "expected 477,
 * got 425".
 */
export const BOOKS_ONLY_BYTES = Object.entries(LIBRARY_FIXTURE)
  .filter(([path]) => path.startsWith('books/'))
  .reduce((sum, [, n]) => sum + n, 0)
