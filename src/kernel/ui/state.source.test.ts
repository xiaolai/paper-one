import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KERNEL_SETTINGS } from '../core/settings'

/**
 * The two things about `state.ts` that can only be read off its SOURCE — and
 * they are here, away from every behavioural case, on purpose.
 *
 * ⚠️ **A TEST THAT READS A SUBJECT'S SOURCE TAKES THE WHOLE FILE OUT OF THAT
 * SUBJECT'S MUTATION RUN.** Stryker rewrites the very file such a test reads,
 * so it would fail the dry run — and `state.test.ts` and
 * `state.persistence.test.tsx` between them hold hundreds of cases about this
 * reducer, every one of which was being left out for the sake of these four.
 * Read the source in a file that asserts nothing else, and the behaviour tests
 * next door keep counting.
 *
 * Both pins are answers to "is the thing that is right also the thing that
 * runs": there is no renderer here to observe a hook, and a missing entry in a
 * literal dependency array is a fact about source and about nothing else.
 */

/**
 * That `useAppState` actually USES `bootState`.
 *
 * Testing the function proves it is right, not that it is reached — that suite
 * passed with the hook still assembling its own state inline, which is exactly
 * the bug. There is no renderer here to observe a hook, so the source is read
 * instead, the same way the palette's combos are checked against the key
 * handler in `commands.test.ts`.
 */
describe('the hook starts from bootState', () => {
  it('does not assemble its own initial state', () => {
    const source = readFileSync(resolve('src/kernel/ui/state.ts'), 'utf8')
    const hook = source.slice(source.indexOf('export function useAppState'))
    /* The reducer is wrapped (it closes over the contributed panes, WI-5.6),
     * so the pin is two facts rather than one spelling: the wrapper delegates
     * to `reducer`, and the initial state is `bootState(`. */
    expect(hook).toMatch(/const reduce = useCallback\(\(state: AppState, action: Action\) => reducer\(state, action, contributed\)/)
    /* LAZILY: the store is the initializer's argument, so the preferences are
       read once and not on every render (2026-09-13 audit). */
    expect(hook).toMatch(/useReducer\(\s*reduce,\s*settings,\s*\(store\) =>\s*bootState\(/)
  })

  /* And it reads the settings store into that call — the whole point of the
   * store is that a launch starts from what was remembered. */
  it('hands the remembered preferences to bootState', () => {
    const source = readFileSync(resolve('src/kernel/ui/state.ts'), 'utf8')
    const hook = source.slice(source.indexOf('export function useAppState'))
    expect(hook).toMatch(/bootState\([^)]*readKernelPreferences\(store\)/)
    expect(hook).toMatch(/writeKernelPreferences\(settings, prefs\)/)
  })
})

/**
 * ⚠️ **THE CLASS, NOT THE INSTANCE.** Two settings were forgotten in this list
 * on two separate occasions, and each time the fix was to add the missing name.
 * This derives the expectation from `KERNEL_SETTINGS` instead, so the NEXT
 * setting added without a dependency fails here rather than shipping as a
 * preference that silently does not save.
 *
 * A source scan, deliberately, and the one place one is right: the defect is a
 * missing entry in a literal array, which is a fact about the source and about
 * nothing else. What makes it different from the scans it sits beside is that
 * the expected set is COMPUTED — it cannot fall behind the thing it checks.
 */
/**
 * The dependency array of the write effect, as source.
 *
 * ⚠️ **THE CLOSING BRACKET IS FOUND AFTER THE OPENING ONE, AND IT WAS NOT.**
 * The first version searched the whole hook for `])` from index zero, which
 * matched an earlier callback's — so `end` came before `start`, `slice`
 * returned the empty string, and every `includes` was false. It reported all
 * eighteen settings missing, which happened to look like a finding. The
 * non-vacuity case below is what said otherwise: a detector that finds nothing
 * and one that finds everything are the same bug wearing different faces.
 */
/** The settings a HAND-WRITTEN dependency list does not name. */
function missingFrom(deps: string): string[] {
  return Object.keys(KERNEL_SETTINGS).filter((name) => {
    /* `textSize` is `stepIdx` in state and `spacing` is listed field by field
       — both are named in the array, which is all this asks. */
    if (name === 'spacing') return !deps.includes('prefs.spacing.')
    return !deps.includes(`prefs.${name}`)
  })
}

function writeEffectDeps(source: string): string {
  const hook = source.slice(source.indexOf('export function useAppState'))
  const start = hook.indexOf('}, [')
  const end = hook.indexOf('])', start)
  return start === -1 || end === -1 ? '' : hook.slice(start, end)
}

describe('the write effect names every preference', () => {
  it('lists a dependency for each of them', () => {
    /* From the repository root, not `import.meta.url`: this file opts into
       jsdom for the hook, and there `import.meta.url` is an http URL that
       `fileURLToPath` refuses — the trap `useGloss.test.ts` already records.
       `readFileSync` throws if the path is wrong, so a moved file fails loudly
       rather than scanning nothing. */
    const source = readFileSync(resolve('src/kernel/ui/state.ts'), 'utf8')
    const deps = writeEffectDeps(source)

    /* ⚠️ **THE LIST IS DERIVED NOW, WHICH COVERS EVERY SETTING BY
       CONSTRUCTION.** `...Object.values(prefs)` is `preferencesOf`'s values,
       and `preferencesOf` returns every `KernelPreferences` field — so nothing a
       reader can save can be left out of it. This case still exists for the day
       somebody turns it back into a hand-written list: then the per-name check
       below runs again, and a missing name fails here exactly as before. */
    if (deps.includes('...Object.values(prefs)')) return

    expect(missingFrom(deps), 'settings a reader can change and never save').toEqual([])
  })

  /* NON-VACUITY: the scan must be able to fail. A name no setting has must not
     be found, or the check above passes over an empty comparison. */
  it('can actually tell a missing one', () => {
    /* From the repository root, not `import.meta.url`: this file opts into
       jsdom for the hook, and there `import.meta.url` is an http URL that
       `fileURLToPath` refuses — the trap `useGloss.test.ts` already records.
       `readFileSync` throws if the path is wrong, so a moved file fails loudly
       rather than scanning nothing. */
    const source = readFileSync(resolve('src/kernel/ui/state.ts'), 'utf8')
    const deps = writeEffectDeps(source)

    expect(deps).not.toContain('prefs.somethingNoSettingHas')
    /* The derived spread is what proves the parse found the REAL array — the
       first version of this parser returned an empty slice and reported every
       setting missing, which looked like a finding. */
    expect(deps, 'the parse found the dependency array at all').toContain('...Object.values(prefs)')
  })

  /* AND THE FALLBACK CAN STILL FAIL. The real source is derived, so the per-name
     check above never runs against it — which would leave it unproven for the
     day somebody writes the list out by hand again. A hand-written list missing
     one setting must be caught, and a complete one must not. */
  it('would catch a hand-written list that forgot a setting', () => {
    const complete = Object.keys(KERNEL_SETTINGS)
      .map((name) => (name === 'spacing' ? 'prefs.spacing.letter' : `prefs.${name}`))
      .join(', ')
    expect(missingFrom(complete), 'a complete hand list').toEqual([])
    const forgot = complete.replace('prefs.readingNotesAloud', '')
    expect(missingFrom(forgot), 'one setting left out').toEqual(['readingNotesAloud'])
  })
})
