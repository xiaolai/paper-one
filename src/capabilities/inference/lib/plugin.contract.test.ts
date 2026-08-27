import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { cancelRequest } from './plugin'

/**
 * FOUR SURFACES NAME THE SAME COMMANDS, THE SAME WAY.
 *
 * A command has to appear in the crate's `build.rs` (scaffolding), in
 * `generate_handler!` (reachable), in `permissions/default.toml` (granted),
 * and in `plugin.ts` (called) — with the plugin prefix. Any one of them
 * missing or misspelled fails only in a running app, while every compiler and
 * every unit test that hands the plugin in as a fake stays green. That is not
 * hypothetical: the whole capability's IPC was once dead because the calls
 * omitted the prefix, and the reader was told only "Something went wrong"
 * while the daemon answered normally the entire time. `plugin.ts`'s header
 * carries that story; it is not repeated here.
 *
 * READ FROM THE SOURCES, all four, rather than from a list kept here — a fifth
 * copy would be the very thing this is checking for.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PLUGIN_TS = readFileSync(`${HERE}plugin.ts`, 'utf8')
const CRATE = new URL('../../../../src-tauri/crates/tauri-plugin-inference/', import.meta.url)
const rust = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, CRATE)), 'utf8')
/**
 * Rust with its comments removed.
 *
 * ⚠️ COMMENTS ARE NOT CODE, and these files are heavily commented. A doc
 * comment naming a command, or one commented out during a refactor, was
 * counted as a declaration — so a command could be "registered" by a sentence
 * about it. `plugin.ts` was already stripped for exactly this reason; the Rust
 * side was not.
 */
const bare = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const BUILD_RS = bare(rust('build.rs'))
const LIB_RS = bare(rust('src/lib.rs'))
const PERMISSIONS_TOML = bare(rust('permissions/default.toml'))

/** The names `COMMANDS` declares, in the crate that registers them. */
function crateCommands(): readonly string[] {
  const block = /const COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/.exec(BUILD_RS)
  expect(block, 'COMMANDS is not in build.rs in the shape this reads').not.toBeNull()
  return [...(block?.[1] ?? '').matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string)
}

/**
 * The commands `generate_handler!` actually registers — what is REACHABLE.
 *
 * `build.rs` only generates the permission scaffolding. A command can be in
 * `COMMANDS` and in `plugin.ts` and still be uncallable if it never reaches
 * this macro — the same shape as the defect that made every command in this
 * file unreachable while `cargo check` and `tsc` were both green.
 */
function registeredCommands(): readonly string[] {
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(LIB_RS)
  expect(block, 'generate_handler! is not in lib.rs in the shape this reads').not.toBeNull()
  return [...(block?.[1] ?? '').matchAll(/commands::([a-z_]+)/g)].map((m) => m[1] as string)
}

/** The commands the webview is GRANTED, as `allow-<kebab-name>` entries. */
function permittedCommands(): readonly string[] {
  const block = /permissions\s*=\s*\[([\s\S]*?)\]/.exec(PERMISSIONS_TOML)
  expect(block, 'permissions is not in default.toml in the shape this reads').not.toBeNull()
  return [...(block?.[1] ?? '').matchAll(/"allow-([a-z-]+)"/g)].map((m) =>
    (m[1] as string).replace(/-/g, '_'),
  )
}

/**
 * Every command `plugin.ts` invokes, and whether it went through the prefix.
 *
 * Matches both shapes on purpose — `command('x')` and a bare `'x'` — because
 * the bare one is exactly what this file exists to catch, and a pattern that
 * only recognised the correct shape would report an empty list and pass.
 */
/**
 * The names `InferenceCommand` admits — the TypeScript side's own closed set.
 *
 * `command()` takes this union rather than `string`, so a name outside it does
 * not compile. Comparing it against the crate is what makes the union itself
 * checkable, rather than a fourth place to keep in step by hand.
 */
function declaredInTypeScript(): readonly string[] {
  const block = /export type InferenceCommand =([\s\S]*?)\n\n/.exec(PLUGIN_TS)
  expect(block, 'InferenceCommand is not in plugin.ts in the shape this reads').not.toBeNull()
  return [...(block?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string)
}

function invoked(): readonly { readonly name: string; readonly prefixed: boolean }[] {
  const pattern = /invoke(?:<[^>]*>)?\(\s*(?:command\('([a-z_]+)'\)|'([a-z_]+)')/g
  /* COMMENTS ARE NOT CODE. This file's own prose names commands and shows the
     bare spelling it exists to forbid; counting either would make the crate
     comparison fail on a sentence, or let a commented-out call stand in for a
     live one. */
  const code = PLUGIN_TS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  return [...code.matchAll(pattern)].map((m) => ({
    name: (m[1] ?? m[2]) as string,
    prefixed: m[1] !== undefined,
  }))
}

describe('the plugin command surface', () => {
  /* EVERY PARSER READ SOMETHING. Each of these regexes depends on one textual
     shape holding in a file this test does not own, and a reformat that broke
     one would leave it matching nothing — at which point every equality below
     compares two empty lists and passes. Non-emptiness is the guard; a
     threshold like `> 10` is not, because it also fails the day the surface
     legitimately shrinks to ten. */
  it('reads a non-empty set from each of the four surfaces', () => {
    for (const [where, names] of [
      ['build.rs COMMANDS', crateCommands()],
      ['generate_handler!', registeredCommands()],
      ['permissions/default.toml', permittedCommands()],
      ['InferenceCommand', declaredInTypeScript()],
      ['plugin.ts invoke() calls', invoked().map((one) => one.name)],
    ] as const) {
      expect(names, `${where} parsed as empty — the shape this test reads has moved`).not.toEqual([])
    }
  })

  it('names every command the crate registers, and no others', () => {
    const declared = [...crateCommands()].sort()
    const used = [...invoked().map((one) => one.name)].sort()
    expect(used).toEqual(declared)
    /* AND THE UNION `command()` ACCEPTS IS THE SAME SET — so a name that is
       legal to the compiler but unknown to the crate cannot exist. */
    expect([...declaredInTypeScript()].sort(), 'InferenceCommand disagrees with build.rs').toEqual(declared)
  })

  /* Each name once, in each place. A duplicate in the union or in the
     permissions list would keep every sorted comparison above happy while
     hiding a name that was dropped. */
  it('names each command exactly once in each surface', () => {
    for (const [where, names] of [
      ['build.rs COMMANDS', crateCommands()],
      ['generate_handler!', registeredCommands()],
      ['permissions/default.toml', permittedCommands()],
      ['InferenceCommand', declaredInTypeScript()],
    ] as const) {
      expect(new Set(names).size, `${where} names something twice`).toBe(names.length)
    }
  })

  /**
   * THE REGRESSION. Not "does the name exist" — it did — but "is it reachable".
   *
   * A bare name compiles, typechecks, passes every unit test that hands the
   * plugin in as a fake, and fails only in a running app, as one sentence that
   * names nothing.
   */
  it('routes every command through the plugin prefix, never bare', () => {
    const bare = invoked().filter((one) => !one.prefixed).map((one) => one.name)
    expect(bare, `these reach invoke() without the plugin prefix — ${bare.join(', ')}`).toEqual([])
  })

  /**
   * ALL THREE RUST SURFACES, not just the one that was easy to read.
   *
   * A command has to appear in `build.rs` (scaffolding), in
   * `generate_handler!` (reachable), and in `permissions/default.toml`
   * (granted). Any one of them missing makes the call fail at runtime while
   * every compiler and every other test here stays green. Checking only
   * `build.rs` — which is what this file did when it was written — answers a
   * narrower question than its name suggests, and that is exactly the mistake
   * it was created to stop.
   */
  it('registers, permits and declares the same set of commands', () => {
    const declared = [...crateCommands()].sort()
    expect([...registeredCommands()].sort(), 'generate_handler! disagrees with build.rs').toEqual(declared)
    expect([...permittedCommands()].sort(), 'permissions/default.toml disagrees with build.rs').toEqual(declared)
  })

  it('builds the prefix the crate actually registers under', () => {
    /* `Builder::new("inference")` in the crate's lib.rs is the other half of
       the string; a rename there and not here is the same defect wearing a
       different name. */
    const registered = /Builder::new\("([a-z_]+)"\)/.exec(LIB_RS)?.[1]
    expect(registered, 'Builder::new is not in lib.rs in the shape this reads').toBe('inference')

    /* ⚠️ THE HELPER'S OWN TEMPLATE, not `toContain`. Searching the whole file
       for `plugin:inference|` was satisfied by a stale comment or an unused
       string — the file is full of prose about this very prefix — while
       `command()` returned something else entirely. This reads the one line
       that builds the string every call goes through. */
    const template = /const command = \(name: InferenceCommand\) => `([^`$]*)\$\{name\}`/.exec(PLUGIN_TS)
    expect(template, 'the command helper is not in plugin.ts in the shape this reads').not.toBeNull()
    expect(template?.[1]).toBe(`plugin:${registered}|`)
  })
})

/**
 * ⚠️ **ONE CANCEL PATH, BECAUSE THERE USED TO BE TWO AND ONLY ONE GOT FIXED.**
 *
 * `glossProvider` and `inferencePort`'s `withCancel` each wired the reader's
 * abort to `plugin.cancel` and each swallowed every failure with
 * `.catch(() => {})`. An audit found the swallow; fixing it in one copy left
 * the other exactly as it was. Two call sites of one shape are a class, so the
 * behaviour lives in one function and is asserted here rather than once per
 * caller.
 */
describe('cancelRequest', () => {
  it('says nothing when the cancel lost the ordinary race', async () => {
    const report = vi.fn()
    const cancel = vi.fn().mockRejectedValue({ kind: 'requestUnknown', message: 'already done' })
    cancelRequest({ cancel } as never, 'gloss-1', report)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancel).toHaveBeenCalledWith('gloss-1')
    expect(report).not.toHaveBeenCalled()
  })

  /* Anything else means the daemon is still generating for a reader who has
     gone — a GPU and a model held for an answer nobody will read. */
  it('reports any other failure, naming the request', async () => {
    const report = vi.fn()
    const cancel = vi.fn().mockRejectedValue({ kind: 'runtimeExited', message: 'gone' })
    cancelRequest({ cancel } as never, 'ask-7', report)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(report).toHaveBeenCalledWith(
      'inference.cancel-failed',
      expect.objectContaining({ requestId: 'ask-7', kind: 'runtimeExited' }),
    )
  })

  /* It runs from an `abort` listener, where there is nobody to catch — so a
     rejection must never escape, with or without a reporter. */
  it('never rethrows, even with no reporter bound', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('boom'))
    expect(() => cancelRequest({ cancel } as never, 'x-1')).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
