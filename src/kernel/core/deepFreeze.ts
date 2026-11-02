/**
 * Freeze a value and everything it holds, in place, and hand it back.
 *
 * `Object.freeze` is shallow, so this walks every own property, enumerable or
 * not, and freezes each object it reaches on the way back up. A primitive is
 * returned as it came: there is nothing in it to walk, and the guard is what
 * stops the walk — without it a string's indices are strings again, for ever.
 * `null` is a primitive here too, though `typeof null` says `object`.
 *
 * ⚠️ **ITS OWN MODULE, BECAUSE WHERE IT LIVED IT COULD NOT BE MEASURED.** It
 * was declared in `serviceTable.ts`, which calls it at module scope to freeze
 * the service table. A mutant that broke it therefore threw while that module
 * was IMPORTED, a suite that fails to load fails no test, and Stryker's vitest
 * runner reads that as `Survived`: five of its mutants could be neither killed
 * nor told apart from survivors (2026-11-02). Asked from `deepFreeze.test.ts`,
 * which imports nothing that calls it at load, each one fails a test.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}
