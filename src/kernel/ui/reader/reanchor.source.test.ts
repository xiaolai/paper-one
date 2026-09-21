import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * WI-22.A1's falsifier, run as a test rather than left as an `rg` in a plan
 * nobody re-runs — and kept in a file of its own.
 *
 * ⚠️ **A TEST THAT READS A SUBJECT'S SOURCE TAKES THE WHOLE FILE OUT OF THAT
 * SUBJECT'S MUTATION RUN**, because Stryker rewrites the very file such a test
 * reads and the dry run then fails. Beside these scans sat the spike's own
 * evidence — the corpus walk, the cost measurement, every case about what
 * `reanchor` DOES — and all of it was left out for the sake of a source grep.
 * The one case in this group that MINTS a CFI stayed next door, where the
 * behaviour tests are; what is here asserts nothing but source.
 */

describe('ResolvedCfi, the painter\'s door', () => {
  /* ⚠️ **WI-22.A1's FALSIFIER, RUN AS A TEST rather than left as a `rg` in a
     plan nobody re-runs.** The plan states it as *"`rg` for the brand cast
     across `src/` returns any hit outside the resolver — if a second minting
     site exists, the type is decoration"*, and a falsifier that lives in a
     document fires once, on the day somebody remembers it.

     It names a WHOLE SET rather than a count, which is the plan's own stated
     preference: a count passes when one mint is added and another deleted in
     the same change, and the set says which file. */

  /* `process.cwd()` is the repo root under vitest — the config lives there and
     vitest does not change directory. Not `import.meta.url`: this suite runs in
     the jsdom environment, where it is not a `file:` URL and `readFileSync`
     refuses it. */
  const REPO_ROOT = process.cwd()

  /* ⚠️ **ASSEMBLED, NOT WRITTEN OUT, and the first version was written out.**
     A test that searches the tree for a string is in the tree, so spelling the
     needle literally made this file match itself — the walk returned three
     paths and the failure looked like a real second mint. Any check of this
     shape has the same trap; joining the halves is the whole fix, and it is
     why no path is excluded from the walk below. Excluding this file would
     have hidden a genuine mint added to it later. */
  const NEEDLE = ['as', 'ResolvedCfi'].join(' ')

  /**
   * The OTHER spelling of the same cast, and it is the one that got past.
   *
   * ⚠️ **`x as never` MINTS A `ResolvedCfi` JUST AS WELL AS `x as ResolvedCfi`,
   * and an audit found one in production while this test was green.** The
   * circle capability widened the resolver's answer with `fresh.cfi as never`
   * — so any string reaching that seam reached the painter, and the falsifier
   * that exists to make that impossible could not see it.
   *
   * `never` is assignable to every type, which is exactly what makes it a
   * universal cast and exactly why a brand check must look for it. The real
   * fix was to type the seam so no cast is needed at all; this is what stops
   * the next one being invisible.
   */
  const ANY_CAST = ['as', 'never'].join(' ')

  /**
   * The file with its comments removed.
   *
   * ⚠️ **PROSE ABOUT A CAST IS NOT A CAST, and the second thing this check did
   * was report three files that describe the rule.** `core/resolvedCfi.ts`
   * explains where the one cast lives, and this suite explains what the grep
   * can and cannot see — both by writing the cast out. Deleting the sentences
   * would have worked and would have been the wrong fix: the check would go on
   * failing for the next person who explains the rule, and the pressure would
   * be to stop explaining it.
   *
   * `check-browser-safe.mjs` learned the identical lesson and AGENTS.md records
   * it — it counted `@tauri-apps` inside doc comments, because `bookVault.ts`
   * names the package three times to say it does NOT import it.
   *
   * Deliberately crude: block and line comments, no string-literal awareness. A
   * cast inside a string is not a cast either, and this suite's `NEEDLE` is
   * itself assembled from halves precisely so it is not one.
   */
  const code = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/[^\n]*/gu, ' ')

  /* ⚠️ **THE CAST IS NOT THE ONLY WAY A `ResolvedCfi` COMES INTO BEING, and a
     grep for the cast cannot see the other one.** `isPlaced` in `core/marks.ts`
     is a TYPE PREDICATE — no cast, so it is invisible to the set below — and it
     narrows to `Placed<T>`, whose `cfi` is branded. That is deliberate and it is
     the weaker of the two mints: it establishes that no foreign path was carried
     across an import and that a path exists, not that the path was re-derived
     this session.

     Named here so the plan's falsifier is not read as saying more than it can.
     `rg 'as ResolvedCfi'` answers "where is the brand asserted without a check";
     it does not answer "where does a branded value come from". */
  const CHECKED_MINT = 'src/kernel/core/marks.ts'

  const MINTS = new Set([
    /* The production mint. Sound because of its ARGUMENT — a live `Range` is
       the evidence the document is here and has the structure the path is
       derived from. */
    'src/kernel/ui/reader/reanchor.ts',
    /* The test mint, reachable only through `src/kernel/testkit.ts`, which
       `kernel-testkit-in-tests-only` refuses to production code. That rule is
       what makes this entry not a hole; see the module's own header. */
    'src/kernel/core/resolvedCfi.testkit.ts',
  ])

  it('is minted in exactly two files, one of which tests cannot escape', async () => {
    const { readdirSync } = await import('node:fs')

    /* A REAL WALK OF `src/`, not `git grep`. The first version used git, and
       git reads the INDEX — so the testkit above was invisible to it until it
       was staged, and the test passed over the very file it exists to account
       for. That failure mode points the wrong way: an UNTRACKED file carrying
       a mint is exactly the case worth failing on, because it is what an
       experiment left behind looks like the moment before it is committed. */
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const at = `${dir}/${entry.name}`
        if (entry.isDirectory()) return walk(at)
        return /\.tsx?$/u.test(entry.name) ? [at] : []
      })

    const found = walk(`${REPO_ROOT}/src`)
      .filter((at) => code(readFileSync(at, 'utf8')).includes(NEEDLE))
      .map((at) => at.slice(REPO_ROOT.length + 1))

    /* NOT `toHaveLength(2)`. A count passes when one mint is added and another
       deleted in the same change; the set says which file, which is the thing
       a reader of a failure needs. */
    expect(new Set(found)).toEqual(MINTS)
  })

  it('has exactly one CHECKED mint, which no cast-grep can see', async () => {
    /* The predicate that narrows to `Placed<T>` without a cast. One, and it is
       `isPlaced` — a second would be a second unaudited way for a bare string
       to acquire the brand, and nothing above would notice. */
    const { readdirSync } = await import('node:fs')
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const at = `${dir}/${entry.name}`
        if (entry.isDirectory()) return walk(at)
        return /\.tsx?$/u.test(entry.name) ? [at] : []
      })
    /* ⚠️ **`is Placed<`, NOT `mark is Placed<`, and the narrower spelling could
       barely fire.** The first version named the parameter, so a predicate
       written `(m: Mark): m is Placed<Mark>` — which is what a second one would
       plausibly look like — slipped straight past. Verified by planting exactly
       that: it went unreported until the needle stopped assuming the argument's
       name. A detector that finds nothing looks exactly like a clean result. */
    const needle = [' is', 'Placed<'].join(' ')
    const found = walk(`${REPO_ROOT}/src`)
      .filter((at) => code(readFileSync(at, 'utf8')).includes(needle))
      .map((at) => at.slice(REPO_ROOT.length + 1))
    expect(found).toEqual([CHECKED_MINT])
  })

  it('has no universal cast in the modules that carry the brand', async () => {
    /* ⚠️ Scoped to the files that HANDLE a `ResolvedCfi`, not the whole tree:
       `as never` is a legitimate idiom for a fake context in a test, and a
       repo-wide ban would be noise nobody keeps. What must not contain one is
       any module through which a cfi travels — because there it is a silent
       mint. */
    const { readdirSync } = await import('node:fs')
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const at = `${dir}/${entry.name}`
        if (entry.isDirectory()) return walk(at)
        return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [at] : []
      })

    const carriers = walk(`${REPO_ROOT}/src`).filter((at) => {
      const source = code(readFileSync(at, 'utf8'))
      return source.includes('ResolvedCfi') || source.includes('ForeignAnnotation')
    })
    expect(carriers.length, 'no carrier modules found — the filter is wrong').toBeGreaterThan(3)

    const offenders = carriers
      .filter((at) => code(readFileSync(at, 'utf8')).includes(ANY_CAST))
      .map((at) => at.slice(REPO_ROOT.length + 1))
    expect(offenders).toEqual([])
  })

  it('finds the mint it is looking for, which is what makes the walk evidence', async () => {
    /* ⚠️ **THE KNOWN POSITIVE.** `check-browser-safe.mjs` shipped two confident
       wrong answers before it worked, and AGENTS.md draws the rule from it: a
       detector that finds nothing looks exactly like a clean result. The test
       above asserts a SET, so a walk that read no files and a walk that found
       the two real mints are told apart only by this — that the needle really
       does match the resolver's own source. */
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(`${REPO_ROOT}/src`).length).toBeGreaterThan(0)
    expect(readFileSync(`${REPO_ROOT}/src/kernel/ui/reader/reanchor.ts`, 'utf8')).toContain(NEEDLE)
  })

  it('cannot be spelled by a module that does not import it', () => {
    /* The brand is a `declare const` symbol that is never exported, so
       `ResolvedCfi` has no structural spelling anywhere else — this is what
       makes it nominal rather than a naming convention. The check is that the
       source declares it that way, because a later edit to
       `{ readonly __brand: 'resolved' }` would compile, would keep every test
       above green, and would silently make the type forgeable. */
    const src = readFileSync(`${REPO_ROOT}/src/kernel/core/resolvedCfi.ts`, 'utf8')
    expect(src).toContain('declare const RESOLVED: unique symbol')
    expect(src).toContain('export type ResolvedCfi = string & { readonly [RESOLVED]: true }')
    /* ⚠️ The brand lives in `core/`, not here. It was declared in this module,
       which made `core/marks.ts` import from `ui/` in order to name it —
       backwards, and flagged by review. The MINT stayed here; only the
       vocabulary moved. */
    expect(code(readFileSync(`${REPO_ROOT}/src/kernel/ui/reader/reanchor.ts`, 'utf8'))).not.toContain(
      'declare const RESOLVED',
    )
  })
})
