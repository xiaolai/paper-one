import { configure } from '@testing-library/dom'

/**
 * ⚠️ **`findBy*` AND `waitFor` GET 5 s, NOT THE LIBRARY'S DEFAULT 1 s.**
 *
 * Testing Library's 1 000 ms is a default chosen for no particular suite. This
 * one has UI that is genuinely asynchronous by design: `SearchPanel` debounces
 * for 250 ms and then consumes an ASYNC GENERATOR, publishing incrementally so
 * the first hits appear immediately. That leaves 750 ms for the generator, the
 * React commit and the assertion — comfortable on an idle machine and not
 * comfortable at all inside a full `pnpm test:coverage`, where eight workers
 * and v8 instrumentation are competing for the same cores.
 *
 * Measured 2026-09-01: `SidePane.test.tsx` §"sends a hit through the host's
 * jump" failed at **2 248 ms** in the full run, and passes in isolation every
 * time — with and without the change that was being verified. A gate that
 * decides on machine load is the worst kind of red, because nobody believes the
 * fourth failure.
 *
 * ⚠️ **THIS IS THE SECOND INSTANCE OF ONE CLASS, which is why it is fixed
 * globally rather than on the one test.** The first was the `scripts` project,
 * where a 15 s `testTimeout` sized for unit tests was killing whole-tree gates
 * that genuinely take 9 s — see the note beside `PROJECTS` in
 * `vitest.config.ts`. Both are a library or framework default applied to work
 * that takes longer than the default assumed. Patching the instance leaves the
 * mechanism, and the mechanism has now produced two failures in two days.
 *
 * A hang is UNBOUNDED, so 5 s still catches one. Nothing about what any test
 * asserts is relaxed: `findBy*` resolves the moment the element appears, so a
 * fast machine pays nothing for this at all — the timeout is a ceiling, never a
 * wait.
 *
 * Configured here rather than per call site because 21 test files use these
 * helpers and a per-call `{ timeout }` is a thing each new one has to remember.
 */
configure({ asyncUtilTimeout: 5_000 })
