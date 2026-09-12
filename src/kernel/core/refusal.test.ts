import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { refusalOf } from './refusal.testkit'

/**
 * `refusalOf`, and the rule it exists to make keepable.
 *
 * ⚠️ **THIRTY-ONE TESTS ASSERTED `await expect(p).rejects.toThrow()` AND NONE OF
 * THEM ASSERTED ANYTHING USEFUL.** Bare, it says only that something was
 * thrown: not what, not that the refusal named the right cause, not even that
 * there was a message. A refusal test whose subject stops refusing for the
 * stated reason and starts refusing for another passes unchanged — which is the
 * one thing it was written to notice.
 *
 * The pattern form is not the cure either. AGENTS.md carries the measurement:
 * `rejects.toThrow(/anything at all/)` passes when the promise rejects with
 * `undefined`, and when it rejects with `null`. It refuses a wrong string and a
 * wrong `Error`, so it looks like it checks the message; it does not check that
 * there is one.
 *
 * Converting the thirty-one found a live defect on the first run, which is the
 * argument for the whole exercise: `pairConfirm`'s refusal is a plain
 * `{ kind, message }` and not an `Error` at all. That turned out to be correct —
 * it is the peer wire's error channel, what Tauri's `invoke` rejects with — and
 * the bare assertion could not have told the difference between that and a bug.
 */
describe('refusalOf', () => {
  it('hands back the rejection so a caller can assert on it', async () => {
    const thrown = new Error('the clause’s own words')
    expect((await refusalOf(Promise.reject(thrown))).message).toBe('the clause’s own words')
    /* A Node system error's `code` is the better assertion, and is typed. */
    const errno = Object.assign(new Error('no such file'), { code: 'ENOENT' })
    expect((await refusalOf(Promise.reject(errno))).code).toBe('ENOENT')
  })

  it('accepts the wire’s `{ kind, message }`, which is not an Error', async () => {
    /* The peer plugin rejects with the serialised Rust error. Demanding
       `instanceof Error` would make this helper refuse the codebase rather than
       the defect — see the module header. */
    const wire = { kind: 'noPendingPairing', message: 'nothing to confirm' }
    const refusal = await refusalOf(Promise.reject(wire))
    expect(refusal.kind).toBe('noPendingPairing')
    expect(refusal.message).toBe('nothing to confirm')
  })

  it('refuses a promise that resolved, including one resolving to nothing', async () => {
    /* `undefined` is a legitimate resolution, so the marker cannot be a
       falsy check — that is why the implementation uses a symbol. */
    await expect(refusalOf(Promise.resolve(undefined))).rejects.toThrow(/expected the promise to reject/u)
    await expect(refusalOf(Promise.resolve(null))).rejects.toThrow(/expected the promise to reject/u)
    await expect(refusalOf(Promise.resolve(false))).rejects.toThrow(/expected the promise to reject/u)
  })

  it('refuses a rejection with no message — the mutant no pattern can kill', async () => {
    /* This is the whole point. `rejects.toThrow(/x/)` passes on every one of
       these; `refusalOf` names the shape instead. */
    for (const nothing of [undefined, null, 'a bare string', 42, {}]) {
      await expect(refusalOf(Promise.reject(nothing))).rejects.toThrow(/expected a rejection carrying a message/u)
    }
  })

  /**
   * ⚠️ **THE RATCHET, so the thirty-second is a failure rather than a habit.**
   *
   * Written over the tree because the defect is a shape, not a place: any test
   * anywhere may reach for the bare form, and the reason it is tempting is that
   * it reads like an assertion. Comments are stripped first, or the paragraphs
   * above — and every other file that explains the defect — would count as
   * instances of it.
   *
   * `rejects.toThrow(<something>)` is untouched. It is weaker than this helper
   * for the `undefined` case, and tightening every one of the ~340 of those is a
   * different and much larger change; what this refuses is the form that
   * asserts nothing at all.
   */
  /* The title deliberately does not spell the token it refuses: the detector
     strips comments but not strings, and an `it` name containing the literal
     form would report this file. Found by running it. */
  it('is the rule: no test in the tree asserts a refusal without naming it', () => {
    const src = fileURLToPath(new URL('../../', import.meta.url))
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const at = join(dir, entry.name)
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(at)
        return /\.test\.tsx?$/.test(entry.name) ? [at] : []
      })
    const tests = walk(src)
    /* NON-VACUOUS: a walk that matched nothing would pass in silence, which is
       the failure mode this whole file is about. */
    expect(tests.length).toBeGreaterThan(200)

    const offenders = tests
      .filter((file) => {
        const text = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/\/\/[^\n]*/g, ' ')
        return /rejects\s*\.\s*toThrow\s*\(\s*\)/.test(text)
      })
      .map((file) => file.slice(src.length))
    expect(offenders).toEqual([])
  })
})
