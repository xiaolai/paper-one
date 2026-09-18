import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { cancelRequest, mintRequestId, reasonOf } from './plugin'

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

  /**
   * ⚠️ **THE ARGUMENTS, NOT ONLY THE NAMES.** Tauri matches an invoke's keys to
   * the command's Rust parameters BY NAME — `secondLanguage` to
   * `second_language` — so a key that matches nothing, or a parameter no key
   * fills, is a command that fails in a running app while every compiler and
   * every test stays green: `plugin.test.ts` asserts what TypeScript SENDS, the
   * crate's tests call Rust directly, and neither sees the seam between them.
   * It is the prefix defect above, one field along.
   *
   * Written when `inference_gloss` gained `language` and `second_language`
   * (2026-09-18) — and over EVERY command, because the seam is the same for all
   * of them and fixing one instance leaves the class. `AppHandle` and `State`
   * are Tauri's to inject and are not arguments.
   */
  it('sends every command exactly the arguments its Rust signature takes', () => {
    const takes = rustArguments()
    const sends = sentArguments()
    /* A KNOWN POSITIVE, so a parser that read nothing cannot pass by
       comparing two empty maps. */
    expect(takes.get('inference_gloss'), 'commands.rs did not parse in the shape this reads').toContain('secondLanguage')
    expect(sends.get('inference_gloss'), 'plugin.ts did not parse in the shape this reads').toContain('secondLanguage')

    expect([...sends.keys()].sort()).toEqual([...takes.keys()].sort())
    for (const [name, parameters] of takes) {
      expect([...(sends.get(name) ?? [])].sort(), `${name}: plugin.ts sends these, commands.rs takes others`).toEqual(
        [...parameters].sort(),
      )
    }
  })
})

/** `a, b<c, d>, e(f, g)` split on its top-level commas only. */
function topLevel(list: string): readonly string[] {
  const parts: string[] = []
  let depth = 0
  let part = ''
  for (const character of list) {
    if ('<({['.includes(character)) depth += 1
    if ('>)}]'.includes(character)) depth -= 1
    if (character === ',' && depth === 0) {
      parts.push(part)
      part = ''
    } else {
      part += character
    }
  }
  parts.push(part)
  return parts.map((one) => one.trim()).filter((one) => one !== '')
}

/**
 * Each command's IPC arguments, as the webview must name them: the Rust
 * parameters Tauri does not inject, camel-cased the way Tauri maps them.
 */
function rustArguments(): ReadonlyMap<string, readonly string[]> {
  const commands = bare(rust('src/commands.rs'))
  const found = new Map<string, readonly string[]>()
  for (const m of commands.matchAll(/#\[tauri::command\]\s*pub (?:async )?fn ([a-z_]+)(?:<[^>]*>)?\(([\s\S]*?)\)\s*->/g)) {
    const parameters = topLevel(m[2] as string)
      .map((parameter) => parameter.split(':').map((side) => side.trim()))
      .filter(([, kind]) => !/^(AppHandle|State)</.test(kind ?? ''))
      .map(([field]) => (field as string).replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase()))
    found.set(m[1] as string, parameters)
  }
  return found
}

/** Each command's argument keys, as `plugin.ts` actually sends them. */
function sentArguments(): ReadonlyMap<string, readonly string[]> {
  const code = PLUGIN_TS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const found = new Map<string, readonly string[]>()
  for (const m of code.matchAll(/command\('([a-z_]+)'\)\s*(,\s*\{)?/g)) {
    if (m[2] === undefined) {
      found.set(m[1] as string, [])
      continue
    }
    /* The object literal, by its own braces — a value can hold a call or an
       index (`streamTo(onChunk)`, `languages[1] ?? null`). */
    const open = (m.index ?? 0) + m[0].length - 1
    let depth = 0
    let close = open
    for (; close < code.length; close += 1) {
      if (code[close] === '{') depth += 1
      if (code[close] === '}') depth -= 1
      if (depth === 0) break
    }
    const keys = topLevel(code.slice(open + 1, close)).map((entry) => (entry.split(':')[0] as string).trim())
    found.set(m[1] as string, keys)
  }
  return found
}

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

  /**
   * ⚠️ **AND THE REPORTER IS PART OF "NEVER RETHROWS", WHICH IT WAS NOT.**
   *
   * The guard above covers the cancel; the reporter ran unguarded inside the
   * same handler, on a promise nothing awaits, so a sink that threw left as an
   * unhandled rejection. `controller.ts` and `glossProvider.ts` each wrap their
   * own reporter before handing it here and so could not see it — `index.ts`
   * hands `api.diagnostics.warn` in raw, which is the caller that could. One
   * guard here covers all three, which is the argument for this function
   * existing at all (2026-09-13 audit, round 2).
   */
  it('lets no reporter failure escape as an unhandled rejection', async () => {
    const escaped: unknown[] = []
    const onUnhandled = (reason: unknown): void => void escaped.push(reason)
    process.on('unhandledRejection', onUnhandled)
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const cancel = vi.fn().mockRejectedValue({ kind: 'runtimeExited', message: 'gone' })
      cancelRequest({ cancel } as never, 'ask-9', () => {
        throw new Error('the reporter is broken')
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(cancel, 'no cancel went out, so this measures nothing').toHaveBeenCalled()
      expect(escaped, 'a reporter failure escaped the cancel as an unhandled rejection').toEqual([])
      expect(said, 'the reporter’s own failure was swallowed rather than said').toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
      said.mockRestore()
    }
  })
})

describe('audit-fix round 1 — reasons and request ids', () => {
  it('reads only a reason this build knows, whichever serde shape carries it', () => {
    const route = (reason: unknown) => ({ id: 'x', kind: 'local', unusable: 'no', reason, installed: false }) as never
    expect(reasonOf(route('notInstalled'))).toBe('notInstalled')
    expect(reasonOf(route({ versionUnsupported: { found: '1.0' } }))).toBe('versionUnsupported')
    expect(reasonOf(route('somethingNewer'))).toBeNull()
    expect(reasonOf(route({ somethingNewer: {} }))).toBeNull()
    expect(reasonOf(route(undefined))).toBeNull()
  })
  it('mints request ids with a non-empty session component', () => {
    const [prefix, session, counter] = mintRequestId('ask').split('-')
    expect(prefix).toBe('ask')
    expect(session!.length).toBeGreaterThan(0)
    expect(Number(counter)).toBeGreaterThan(0)
  })
})
