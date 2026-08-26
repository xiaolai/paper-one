/**
 * THE KERNEL'S TEST-ONLY ENTRY.
 *
 * `fakeFs` is a deliberately behaviour-divergent stand-in for a real
 * filesystem — its `readDir` decides a name is a directory by whether it
 * contains a dot, its `exists` is a prefix match, and neither is what a disk
 * does. It belongs in tests and nowhere else.
 *
 * It used to be re-exported from `src/kernel/index.ts`, the PRODUCTION public
 * entry, which put it in the supported API and in the generated declarations
 * beside `createKernelServices`. Tree-shaking meant it cost a build nothing,
 * which is a fact about bundle size and not about whether somebody can import
 * it — and the boundary rules could not tell the difference, because it came
 * through the one door everything is allowed to use.
 *
 * A second entry makes the difference nameable: `kernel-testkit-in-tests-only`
 * in `.dependency-cruiser.cjs` refuses an edge to this file from anything that
 * is not a test or another testkit, so importing it in production code is a
 * gate failure rather than an oversight.
 */

export { fakeFs } from './core/indexFsFake.testkit'
/* The size port's conformance fixture — one library, asked of every host. See
   that module's header for the two-walks-one-contract defect it exists for. */
export { BOOKS_ONLY_BYTES, LIBRARY_FIXTURE, LIBRARY_FIXTURE_BYTES } from './core/librarySizes.testkit'
