import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { inlineModules } from './inline-ts.mjs'

/**
 * The three refusals `inline-ts.mjs` makes, and nothing else.
 *
 * WHY THESE AND NOT THE HAPPY PATH: the happy path is exercised on every run
 * of `word-snap-parity.mjs`, `sentence-parity.mjs` and `word-snap-live.mjs`,
 * which is how this file sat at 90% while every line that MATTERS when
 * something is wrong — all three `throw`s — had never run.
 *
 * They matter because of where the failure lands otherwise. The whole reason
 * this generator refuses loudly is that its output is handed to
 * `webview_execute_js`, where an unresolved import fails with no message
 * pointing anywhere near the cause. A refusal that has never been executed is
 * a refusal nobody has checked names the file and the specifier — which is the
 * entire value of making it throw here rather than there.
 *
 * The gaps were not introduced by removing anything; they predate it. They
 * became visible when two fully-covered files left `scripts/lib/`, which
 * stopped diluting the ratio and put the directory under its 99% threshold.
 */

/** A throwaway module directory, as the `file:` URL `inlineModules` wants.
 *  Fresh per case on purpose: `inlineModules` caches on the directory and the
 *  file list, so two cases sharing a directory would have the second reading
 *  the first's answer instead of its own. */
function moduleDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'inline-ts-'))
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source, 'utf8')
  return pathToFileURL(join(dir, 'x')).href.replace(/x$/, '')
}

describe('inlineModules refuses what a webview could not resolve', () => {
  /* The generator finds a module's exports by pattern, not by parsing. A file
     whose exports it cannot see would be inlined into an object literal with
     nothing in it, and the snippet would fail on a missing binding rather than
     here, where the message can name the file. */
  it('refuses a module it can see no exports in', () => {
    const dir = moduleDir({ 'quiet.ts': 'const hidden = 1\n' })

    expect(() => inlineModules(dir, ['quiet.ts'])).toThrow(/quiet\.ts exports nothing this generator can inline/)
  })

  /* The case the message is longest about: the import is dropped from the
     body, so an unlisted one would leave a name bound to nothing and the
     snippet would fail inside the webview with a bare ReferenceError. */
  it('refuses an import outside the inlinable set, and names both', () => {
    const dir = moduleDir({
      'uses.ts': "import { helper } from './elsewhere'\nexport const value = helper\n",
    })

    expect(() => inlineModules(dir, ['uses.ts'])).toThrow(
      /uses\.ts imports \.\/elsewhere, which is outside the inlinable set \(uses\.ts\)/,
    )
  })

  /* The backstop for everything the other two do not model, and the reason it
     cannot be written as "an export the stripper missed": a fixture with an
     indented `export` never reaches this check, because `stripTypeScriptTypes`
     rejects it first with "'import', and 'export' cannot be used outside of
     module code".

     So the case that does reach it is an import the PATTERN does not match
     while the parser accepts it — here, a trailing comment after the
     specifier, which puts the line outside `IMPORT_STATEMENT`'s `[ \t]*$`. The
     statement is therefore never captured, never dropped, and survives into
     the body. That is precisely the shape this guard exists for: the generator
     did not understand the file, so it must not emit a snippet whose import
     would fail silently in a webview. */
  it('refuses a module still holding module syntax after inlining', () => {
    const dir = moduleDir({
      'commented.ts': "import { helper } from './fine' // why this one is here\nexport const value = 1\n",
    })

    expect(() => inlineModules(dir, ['commented.ts'])).toThrow(
      /commented\.ts still holds module syntax after inlining/,
    )
  })

  /* Not a fourth refusal — the guard on the three above. Each asserts a throw,
     and a helper that produced modules this generator rejected for some
     unrelated reason would make all three pass while testing nothing. */
  it('still inlines a module the generator does understand', () => {
    const dir = moduleDir({ 'fine.ts': 'export const answer: number = 42\n' })

    const out = inlineModules(dir, ['fine.ts'])

    expect(out).toContain('fine.ts')
    expect(out).toContain('return { answer };')
    expect(out).not.toMatch(/^[ \t]*(?:import|export)\b/m)
  })
})
