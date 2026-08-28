import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE COMMAND LIST IS HAND-COPIED FROM RUST, and `wire.ts` says in its own
 * words that nothing verified it. Drift produced a runtime-only failure: an
 * `invoke` naming a command the plugin does not build is a rejected promise on
 * the first click, past a green `tsc`. The inference capability holds its
 * plugin to the same contract (`plugin.contract.test.ts`); this is that gate
 * for webhost.
 */
const HERE = new URL('./', import.meta.url)
const WIRE_TS = readFileSync(fileURLToPath(new URL('wire.ts', HERE)), 'utf8')
const BUILD_RS = readFileSync(
  fileURLToPath(new URL('../../../../src-tauri/crates/tauri-plugin-webhost/build.rs', HERE)),
  'utf8',
)

const invoked = (): readonly string[] =>
  [...WIRE_TS.matchAll(/plugin:webhost\|(webhost_[a-z_]+)/g)].map((m) => m[1]!).sort()
const built = (): readonly string[] => [...BUILD_RS.matchAll(/"(webhost_[a-z_]+)"/g)].map((m) => m[1]!).sort()

describe('the webhost wire and the plugin name the same commands', () => {
  it('finds both lists, so the comparison is not vacuous', () => {
    expect(invoked().length).toBeGreaterThan(5)
    expect(built().length).toBeGreaterThan(5)
  })
  it('every command the wire invokes is one the plugin builds, and the plugin builds nothing the wire never calls', () => {
    expect([...new Set(invoked())]).toEqual([...new Set(built())])
  })
})
