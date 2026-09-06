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
 * A hang is UNBOUNDED, so this still catches one. Nothing about what any test
 * asserts is relaxed: `findBy*` resolves the moment the element appears, so a
 * fast machine pays nothing for this at all — the timeout is a ceiling, never a
 * wait.
 *
 * Configured here rather than per call site because 21 test files use these
 * helpers and a per-call `{ timeout }` is a thing each new one has to remember.
 *
 * ── 5 s → 10 s, 2026-09-06. THE THIRD INSTANCE, AND THE NUMBER WAS THE BUG ──
 *
 * `src/app/web/Reader.test.tsx` §"gives a measured PDF a range transport"
 * failed `pnpm verify` at **5 100 ms** against this 5 000 ms ceiling — 26 of 26
 * passing standalone at load average 29 immediately afterwards.
 *
 * ⚠️ **AND RAISING `testTimeout` TO 60 s FOR THE `app` PROJECT DID NOT HELP,
 * WHICH IS THE PART WORTH KEEPING.** That landed hours earlier for exactly this
 * class of failure. It cannot help a test that waits through `waitFor`: the two
 * bounds are TWELVE TIMES APART and the smaller one fires first, so every
 * screen-mounting test that waits for an element was still deciding on machine
 * load with a 60 s budget it could never reach.
 *
 * The mechanism, which the paragraphs above got right in words and wrong in
 * arithmetic: this is a HANG CEILING and asserts nothing about speed, so
 * deriving it from an observed run makes it a throughput assertion. 5 000 was
 * chosen as roughly twice a measured 2 248 ms — while `vitest.config.ts`, next
 * door, records a **seven-fold** inflation under load on this same machine.
 * Two documents in one repository budgeting 2x and measuring 7x.
 *
 * So it is not a multiple of anything observed. The only hard constraint is the
 * CEILING: it must stay below the smallest `testTimeout` it can run under —
 * the root's 15 s — or the test is killed before `waitFor` can report the
 * specific element it was waiting for, which is the whole value of the error.
 * 10 s sits under that with room, and a hang is still bounded.
 *
 * ⚠️ **AND IT DID NOT FIX THE FAILURE IT WAS RAISED FOR. SAYING SO HERE BECAUSE
 * A CHANGE THAT KEEPS A FALSE REASON IS WORSE THAN THE BUG.** `Reader.test.tsx`
 * §"gives a measured PDF a range transport" failed again at 10 045 ms — the new
 * ceiling exactly, as it had failed at the old one exactly. Measured
 * afterwards: that case passes in **79–101 ms** across ten runs and has never
 * once finished anywhere in between. Bimodal like that is a HANG, not
 * slowness, and no ceiling fixes a hang; a bigger one only makes the failure
 * slower to arrive.
 *
 * The raise is KEPT anyway, on its own merits and not on that one: the 2 248 ms
 * SidePane measurement above is real, 5 000 was about twice it, and the file
 * next door records a sevenfold inflation under load. 10 s is honest headroom
 * for a wait that is genuinely slow and progressing. It is not, and was never,
 * a fix for a wait that is not progressing at all.
 *
 * The real defect is tracked in `dev-docs/NEXT.md` under known open items, and
 * the assertion in `Reader.test.tsx` now names which of the two failures it hit.
 */
configure({ asyncUtilTimeout: 10_000 })
