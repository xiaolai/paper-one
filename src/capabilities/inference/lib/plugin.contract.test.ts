import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE TYPESCRIPT SURFACE AND THE CRATE NAME THE SAME COMMANDS, THE SAME WAY.
 *
 * `plugin.ts`'s own header has always said the set of names in it "should
 * equal `COMMANDS` in the crate's `build.rs`, and a command that appears in
 * one and not the other is a mistake somebody can see". Nothing checked it,
 * and the mistake that actually happened was one nobody saw: every command was
 * invoked BARE.
 *
 * Tauri 2 registers a plugin's commands as `plugin:<name>|<command>`. A bare
 * name resolves against the app's own commands, finds nothing, and rejects
 * with the string `Command inference_status not found` — a string, so it
 * carries no `kind`, so `detailFor` maps it to its default: **Something went
 * wrong**. The whole capability's IPC was dead, the Runtime row said that one
 * uninformative sentence, Memory and Models folder read `—`, and `lemond` was
 * running and answering the entire time. `tauri-plugin-peer` has had the
 * prefix helper since phase 7; this file did not.
 *
 * READ FROM THE SOURCES, both of them, rather than from a list kept here — a
 * third copy would be the very thing this is checking for.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PLUGIN_TS = readFileSync(`${HERE}plugin.ts`, 'utf8')
const BUILD_RS = readFileSync(
  fileURLToPath(new URL('../../../../src-tauri/crates/tauri-plugin-inference/build.rs', import.meta.url)),
  'utf8',
)

/** The names `COMMANDS` declares, in the crate that registers them. */
function crateCommands(): readonly string[] {
  const block = /const COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/.exec(BUILD_RS)
  expect(block, 'COMMANDS is not in build.rs in the shape this reads').not.toBeNull()
  return [...(block?.[1] ?? '').matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string)
}

/**
 * Every command `plugin.ts` invokes, and whether it went through the prefix.
 *
 * Matches both shapes on purpose — `command('x')` and a bare `'x'` — because
 * the bare one is exactly what this file exists to catch, and a pattern that
 * only recognised the correct shape would report an empty list and pass.
 */
function invoked(): readonly { readonly name: string; readonly prefixed: boolean }[] {
  const pattern = /invoke(?:<[^>]*>)?\(\s*(?:command\('([a-z_]+)'\)|'([a-z_]+)')/g
  return [...PLUGIN_TS.matchAll(pattern)].map((m) => ({
    name: (m[1] ?? m[2]) as string,
    prefixed: m[1] !== undefined,
  }))
}

describe('the plugin command surface', () => {
  it('names every command the crate registers, and no others', () => {
    const declared = crateCommands()
    expect(declared.length).toBeGreaterThan(10)
    const used = invoked().map((one) => one.name)
    /* Every name matched, so the pattern above is reading something — an
       empty list would satisfy neither this nor the prefix case below. */
    expect(used.length).toBe(declared.length)
    expect([...used].sort()).toEqual([...declared].sort())
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

  it('builds the prefix the crate actually registers under', () => {
    /* `Builder::new("inference")` in the crate's lib.rs is the other half of
       the string; a rename there and not here is the same defect wearing a
       different name. */
    const lib = readFileSync(
      fileURLToPath(new URL('../../../../src-tauri/crates/tauri-plugin-inference/src/lib.rs', import.meta.url)),
      'utf8',
    )
    const registered = /Builder::new\("([a-z_]+)"\)/.exec(lib)?.[1]
    expect(registered).toBe('inference')
    expect(PLUGIN_TS).toContain(`plugin:${registered}|`)
  })
})
