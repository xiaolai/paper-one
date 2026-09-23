import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KERNEL_SETTINGS } from '../core/settings'
import { BUNDLED_FACES, faceById } from '../core/typefaces'

/**
 * Every pin in the reader's state that can only be read off SOURCE — and they
 * are here, away from every behavioural case, on purpose.
 *
 * ⚠️ **A TEST THAT READS A SUBJECT'S SOURCE TAKES THE WHOLE FILE OUT OF THAT
 * SUBJECT'S MUTATION RUN.** Stryker rewrites the very file such a test reads,
 * so it would fail the dry run — and `state.test.ts` and
 * `state.persistence.test.tsx` between them hold hundreds of cases about this
 * reducer, every one of which was being left out for the sake of these four.
 * Read the source in a file that asserts nothing else, and the behaviour tests
 * next door keep counting.
 *
 * Every pin here is an answer to "is the thing that is right also the thing
 * that runs": there is no renderer to observe a hook, a missing entry in a
 * literal dependency array is a fact about source and about nothing else, and
 * a `font-family` naming a family with no `@font-face` rule is not an error —
 * CSS simply takes the next entry in the chain.
 *
 * ⚠️ **THE TYPEFACE AND SCROLL-PORT PINS MOVED HERE ON 2026-09-23, AND THE
 * MUTATION GATE IS WHAT MADE THEM.** They read `screens/Reader.tsx`,
 * `main.tsx`, `pane/FacePicker.tsx` and `pane/Settings.tsx` from inside
 * `state.test.ts`, which holds hundreds of behavioural cases — so all four of
 * those subjects were left out of every sweep that file covers. `AGENTS.md`
 * named this pair as a known remaining instance and said *"neither has bitten
 * yet because those subjects sweep clean — the first survivor in any of them
 * refuses the file."* `Settings.tsx` grew a survivor, and the gate answered
 * `reading-changed`: not a pass, not a failure, nothing authorised. This is
 * the documented remedy, and `SidePane.source.test.ts` is its precedent.
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

/**
 * The scroll port's three hooks, checked against the fork that reads them.
 *
 * They are custom property NAMES agreed between two repositories, and a
 * disagreement is silent in both directions: a stylesheet declaration naming a
 * property nobody sets falls back to its default, and a property nobody reads
 * is simply inert. Either way the app renders plausibly and the scrollbar is
 * back in the middle of the page.
 *
 * Read from the INSTALLED module, not from the checkout, because what ships is
 * whatever `package.json` pins — and the pin has been moved without the working
 * copy following it before.
 */
describe('the scroll port hooks match the fork', () => {
  const paginator = readFileSync(
    fileURLToPath(import.meta.resolve('foliate-js/paginator.js')),
    'utf8',
  )
  const reader = readFileSync(
    fileURLToPath(new URL('./screens/Reader.tsx', import.meta.url)),
    'utf8',
  )

  it('sets exactly the properties the installed paginator reads', () => {
    for (const hook of [
      '--paper-scroll-pad-start',
      '--paper-scroll-pad-end',
      '--paper-scrollbar-width',
    ]) {
      expect(paginator, `the fork must read ${hook}`).toContain(`var(${hook},`)
      expect(reader, `Reader must set ${hook}`).toContain(hook)
    }
  })

  /* Inert defaults are what make this a hook rather than a fork of behaviour:
   * a host that sets none of them must get upstream's rendering exactly. */
  it('leaves upstream rendering untouched when the host sets nothing', () => {
    expect(paginator).toContain('var(--paper-scroll-pad-start, 0px)')
    expect(paginator).toContain('var(--paper-scroll-pad-end, 0px)')
    expect(paginator).toContain('var(--paper-scrollbar-width, auto)')
  })

  /* The rule they live in. If a rebase moves these declarations out from under
   * the scrolled-flow selector they would apply in paginated flow too, where
   * padding on the port shifts the page rather than the scrollbar. */
  it('reads them only in scrolled flow', () => {
    const rule = paginator.slice(
      paginator.indexOf(':host([flow="scrolled"]) #container'),
    )
    const end = rule.indexOf('}')
    expect(rule.slice(0, end)).toContain('--paper-scrollbar-width')
  })
})

/**
 * The one failure mode a typeface picker has, and it is silent.
 *
 * A `font-family` naming a family with no `@font-face` rule is not an error.
 * CSS skips it and takes the next entry in the chain, so the book renders in
 * Georgia — or in whatever the platform offers — while every value in the app
 * says otherwise. That is not hypothetical here: `bookCss`'s own header records
 * the month in which every book in Paper was set in Georgia, because
 * `@font-face` does not cross an iframe boundary and nothing reported it.
 *
 * So the registry, the CSS stacks and the imports are checked against each
 * other from SOURCE. Reading the files is the only way — a test that asks the
 * registry about itself agrees with itself, and the three things that must
 * match live in three files.
 */
describe('every offered typeface is a font that exists', () => {
  const read = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
  const main = read('../../main.tsx')

  /* Crimson Pro is still BUNDLED and no longer OFFERED: the interface sets its
   * empty states and note bodies in it, so the webfont must stay, while as a
   * reading choice it duplicated Literata's role and was the face whose small
   * x-height made a size mean two different things. Bundled and offered are
   * separate lists now, and this asserts the relationship rather than an equal
   * count — every offered bundled face must be one main.tsx actually loads. */
  it('bundles a family for every face it offers as bundled', () => {
    const imported = new Set(
      [...main.matchAll(/@fontsource[^'"]*\/([a-z-]+)/g)].map((m) => m[1]),
    )
    const wanted: Record<string, string> = {
      literata: 'literata',
      instrument: 'instrument-sans',
      plex: 'ibm-plex-mono',
    }
    for (const face of BUNDLED_FACES) {
      const pkg = wanted[face.id]
      expect(pkg, `no @fontsource package known for ${face.id}`).toBeDefined()
      expect(imported.has(pkg as string), `main.tsx must import ${pkg}`).toBe(true)
    }
  })

  it('leads every BUNDLED book stack with a family the app actually loads', () => {
    /* Only the bundled ones. A system face's stack leads with a family this app
     * never loads — that is what makes it a system face — so asserting a
     * `@font-face` behind every entry would have failed the moment the reader's
     * own fonts were offered, and asserting it behind none would have stopped
     * catching the bug this test exists for: a bundled face named slightly
     * wrong falls through to Georgia with nothing on screen to say so. */
    const LEADS: Record<string, string> = {
      literata: "'Literata Variable'",
      instrument: "'Instrument Sans Variable'",
      plex: "'IBM Plex Mono'",
    }
    for (const [id, lead] of Object.entries(LEADS)) {
      const face = faceById(id)
      expect(face.id, `${id} is not in the registry`).toBe(id)
      expect(face.stack.startsWith(lead), `${id} must lead with ${lead}`).toBe(true)
    }
  })

  /* THE PREVIEW IS THE BOOK'S OWN STACK. There used to be a second table of
   * preview stacks in the settings panel, so a face could be sampled in one
   * thing and read in another with nothing comparing them. The panel reads
   * `face.stack` now, which is the same string `bookCss` sets the book in —
   * asserted here rather than trusted, because it is one edit from being a
   * copy again. */
  it('samples a face in the same stack the book is set in', () => {
    const picker = read('./pane/FacePicker.tsx')
    expect(picker).toContain('fontFamily: face.stack')
    expect(read('./pane/Settings.tsx')).not.toContain('PREVIEW_STACKS')
  })

  /* The picker corrects each sample by the same x-height scale the book gets,
   * or a list of eight faces at one nominal size is a list of eight sizes —
   * measured on this machine, 8.0px to 9.3px of x-height at a flat 17. */
  it('shows every sample at the same optical size', () => {
    const picker = read('./pane/FacePicker.tsx')
    expect(picker).toContain('opticalScale(face)')
    expect(picker).toContain('--face-scale')
  })
})
