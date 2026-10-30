/**
 * The error a promise actually rejected with, for tests that mean to assert
 * something about it.
 *
 * ⚠️ **`await expect(p).rejects.toThrow()` ASSERTS ALMOST NOTHING, AND THERE
 * WERE THIRTY-ONE OF THEM.** Bare, it says "something was thrown" — not what,
 * not that it named the right refusal, not even that it was an `Error`. A test
 * written that way passes when the code starts refusing for a completely
 * different reason, which is the one thing a refusal test exists to notice.
 *
 * And the pattern form is not the cure: AGENTS.md records the measurement that
 * `rejects.toThrow(/anything at all/)` PASSES when the promise rejects with
 * `undefined`, and when it rejects with `null`, whatever the pattern says. It
 * refuses a wrong string and a wrong `Error`, so it looks like it is checking
 * the message; it is not checking that there is one. `store.ts`'s `readNames`
 * took its refusal as a thunk and `throw refuse()` with `() => undefined` was a
 * surviving mutant no pattern could kill.
 *
 * So this returns the value instead, after refusing the two things a bare
 * `toThrow` cannot see:
 *
 *   - the promise RESOLVED — nothing was thrown at all;
 *   - it rejected with something carrying no `message` — `undefined`, `null`, a
 *     number, a bare object — so there is nothing for the caller to assert on.
 *
 * Both are thrown from here with a sentence saying which, so the failure names
 * the shape rather than the assertion that came after it.
 *
 * ⚠️ **A `message`, NOT AN `Error`, AND THAT IS NOT A COMPROMISE.** The first
 * version of this insisted on `instanceof Error` and immediately caught a real
 * one: `pairConfirm`'s refusal is a plain `{ kind, message }`. That shape is
 * deliberate and is the peer wire's whole error channel — Tauri's `invoke`
 * rejects with the serialised Rust `Error`, never with an `Error` instance, and
 * `messageOf` exists to read exactly that. Demanding a class the production
 * path does not produce would have made this helper refuse the codebase rather
 * than the defect. What matters is that a refusal SAYS something; `undefined`
 * says nothing, and that is the mutant `rejects.toThrow(/…/)` cannot kill.
 *
 * ```ts
 * expect((await refusalOf(fs.remove('gone.json'))).code).toBe('ENOENT')
 * expect((await refusalOf(port.setMuted('nobody', true))).message).toMatch(/not in your circle/u)
 * ```
 *
 * `code` is typed because most of what this is used on is a Node system error,
 * where the code is a far better assertion than the message: `ENOENT` is a
 * contract and "no such file or directory, open '/var/folders/…'" is a string
 * with a temp path in it.
 */
export async function refusalOf(
  promise: PromiseLike<unknown>,
): Promise<{ readonly message: string; readonly code?: string; readonly kind?: string }> {
  /* A unique marker rather than a boolean flag: the promise may legitimately
     resolve to `undefined`, `null` or `false`, and every one of those has to be
     distinguishable from a rejection. */
  const RESOLVED = Symbol('resolved')
  const outcome = await Promise.resolve(promise).then(
    () => RESOLVED as unknown,
    (thrown: unknown) => thrown,
  )
  if (outcome === RESOLVED) {
    throw new Error('refusalOf: expected the promise to reject, and it resolved')
  }
  const message = (outcome as { message?: unknown } | null)?.message
  if (typeof message !== 'string') {
    throw new Error(
      `refusalOf: expected a rejection carrying a message, got ${outcome === null ? 'null' : typeof outcome}: ${String(outcome)}`,
    )
  }
  return outcome as { readonly message: string; readonly code?: string; readonly kind?: string }
}
