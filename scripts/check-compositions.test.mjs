import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCompositions, formatSummary, listCrates, loadManifest, readAclFiles, readOrNull } from './check-compositions.mjs'

/**
 * `pnpm compositions:check` as a user or CI runs it: the real tree is
 * clean; a fixture tree with a crate exercises every Rust surface end to
 * end; a drift on any surface is one line naming it and exit 1; an invalid
 * manifest or bad usage is exit 2. The rules themselves are proven in
 * `lib/compositions.test.mjs`; these cases prove the shell — reading the
 * tree, the output, the exit code.
 */

const SCRIPT = fileURLToPath(new URL('./check-compositions.mjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 })
  if (result.error) throw result.error
  return { code: result.status, out: result.stdout, err: result.stderr }
}

const roots = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A tree with one crate-backed capability `peer`, consistent on every surface. */
function fixture(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'compositions-check-'))
  roots.push(root)
  const files = {
    'capabilities.manifest.json': JSON.stringify({
      capabilities: [
        { id: 'peer', ts: 'peer', platforms: ['desktop', 'ios', 'android'], crate: 'tauri-plugin-peer', plugin: 'peer', permissions: ['peer:default'] },
        { id: 'mob', ts: 'mob', platforms: ['ios'], crate: 'tauri-plugin-mob', permissions: ['mob:default'] },
      ],
    }),
    'src/capabilities/peer/index.ts': 'export const peer = 1\n',
    'src/capabilities/mob/index.ts': 'export const mob = 1\n',
    'src/app/composition.desktop.ts': "import { peer } from '../capabilities/peer'\nexport const capabilities = [peer]\n",
    'src/app/composition.ios.ts': "import { peer } from '../capabilities/peer'\nimport { mob } from '../capabilities/mob'\nexport const capabilities = [peer, mob]\n",
    'src/app/composition.android.ts': "import { peer } from '../capabilities/peer'\nexport const capabilities = [peer]\n",
    'src-tauri/crates/tauri-plugin-peer/Cargo.toml': '[package]\nname = "tauri-plugin-peer"\n',
    'src-tauri/crates/tauri-plugin-mob/Cargo.toml': '[package]\nname = "tauri-plugin-mob"\n',
    'src-tauri/crates/tauri-plugin-orphan/Cargo.toml': '[package]\nname = "tauri-plugin-orphan"\n',
    'src-tauri/Cargo.toml':
      '[dependencies]\ntauri-plugin-peer = { path = "crates/tauri-plugin-peer" }\ntauri-plugin-mob = { path = "crates/tauri-plugin-mob", optional = true }\n[features]\ndefault = ["desktop"]\ndesktop = []\nios = ["dep:tauri-plugin-mob"]\nandroid = []\n',
    'src-tauri/src/lib.rs': 'pub fn run() {\n    tauri::Builder::default()\n        .plugin(tauri_plugin_peer::init())\n        .plugin(tauri_plugin_mob::init())\n        .run(ctx);\n}\n',
    'src-tauri/capabilities/default.json': JSON.stringify({ permissions: ['core:default', 'peer:default'] }, null, 2),
    'src-tauri/capabilities/mobile/ios.json': JSON.stringify({ platforms: ['iOS'], permissions: [{ identifier: 'mob:default' }] }, null, 2),
    'src-tauri/capabilities/notes.txt': 'not json, not read',
    ...over,
  }
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) continue
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return root
}

describe('the real tree', () => {
  it('is clean: 3 platforms, the manifest\'s capabilities, a note for each unclaimed crate, 0 findings', () => {
    // Computed from the tree, not spelled out: `pnpm verify:without <id>`
    // runs this suite in a copy with `<id>` gone.
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'capabilities.manifest.json'), 'utf8'))
    const claimed = new Set(manifest.capabilities.map((c) => c.crate).filter(Boolean))
    const unclaimed = listCrates(REPO_ROOT).filter((name) => !claimed.has(name))
    const { code, out, err } = run([])
    expect(err).toBe('')
    expect(out).toBe(
      unclaimed.map((name) => `note: src-tauri/crates/${name} is claimed by no manifest entry — its features, registration and grants are not checked\n`).join('') +
        `compositions-check: 3 platforms, ${manifest.capabilities.length} capabilities, ${claimed.size} crates checked, 0 findings\n`,
    )
    expect(code).toBe(0)
  })
})

describe('a tree with crates', () => {
  it('passes when every surface agrees, and notes the unclaimed crate', () => {
    const root = fixture()
    const { code, out } = run(['--root', root])
    expect(out).toBe(
      'note: src-tauri/crates/tauri-plugin-orphan is claimed by no manifest entry — its features, registration and grants are not checked\n' +
        'compositions-check: 3 platforms, 2 capabilities, 2 crates checked, 0 findings\n',
    )
    expect(code).toBe(0)
  })

  it('reports drift on each surface as one line, exit 1', () => {
    const root = fixture({
      // composition drift: android forgets peer; desktop adds mob
      'src/app/composition.android.ts': 'export const capabilities = []\n',
      'src/app/composition.desktop.ts': "import { peer } from '../capabilities/peer'\nimport { mob } from '../capabilities/mob'\nexport const capabilities = [peer, mob]\n",
      // Rust drift: mob forwarded on android too; peer not registered; peer:default not granted
      'src-tauri/Cargo.toml':
        '[dependencies]\ntauri-plugin-peer = { path = "crates/tauri-plugin-peer" }\ntauri-plugin-mob = { path = "crates/tauri-plugin-mob", optional = true }\n[features]\ndefault = ["desktop"]\ndesktop = []\nios = ["dep:tauri-plugin-mob"]\nandroid = ["dep:tauri-plugin-mob"]\n',
      'src-tauri/src/lib.rs': 'pub fn run() {\n    tauri::Builder::default().plugin(tauri_plugin_mob::init()).run(ctx);\n}\n',
      'src-tauri/capabilities/default.json': JSON.stringify({ permissions: ['core:default'] }),
    })
    const { code, out } = run(['--root', root])
    const lines = out.trimEnd().split('\n')
    expect(lines.map((l) => l.split(' ')[0])).toEqual([
      'COMPOSITION_EXTRA',
      'COMPOSITION_MISSING',
      'PLUGIN_UNREGISTERED',
      'PERMISSION_UNGRANTED',
      'PERMISSION_UNGRANTED',
      'PERMISSION_UNGRANTED',
      'CRATE_PLATFORMS_DIFFER',
      'note:',
      'compositions-check:',
    ])
    expect(lines[lines.length - 1]).toBe('compositions-check: 3 platforms, 2 capabilities, 2 crates checked, 7 findings')
    expect(code).toBe(1)
  })

  it('exit 2 for an invalid manifest, a missing manifest, or bad usage', () => {
    const invalid = fixture({ 'capabilities.manifest.json': JSON.stringify({ capabilities: [{ id: 'X' }] }) })
    expect(run(['--root', invalid])).toMatchObject({ code: 2, out: '', err: expect.stringContaining('ID_INVALID') })
    const missing = fixture({ 'capabilities.manifest.json': null })
    expect(run(['--root', missing])).toMatchObject({ code: 2, err: expect.stringContaining('cannot read capabilities.manifest.json') })
    expect(run(['--bogus'])).toMatchObject({ code: 2, err: expect.stringContaining('unknown argument "--bogus"') })
    expect(run(['--root'])).toMatchObject({ code: 2, err: expect.stringContaining('--root needs a directory') })
    expect(run(['--root', 'a', '--root', 'b'])).toMatchObject({ code: 2, err: expect.stringContaining('given twice') })
  })
})

describe('the helpers', () => {
  it('read files or null, ACL json recursively (only .json), crates as sorted directories', () => {
    const root = fixture({ 'src-tauri/crates/not-a-dir': 'file' })
    expect(readOrNull(root, 'nope.txt')).toBeNull()
    expect(readOrNull(root, 'src-tauri/capabilities/notes.txt')).toBe('not json, not read')
    expect(readAclFiles(root).map((f) => f.file)).toEqual(['src-tauri/capabilities/default.json', 'src-tauri/capabilities/mobile/ios.json'])
    expect(readAclFiles(root, 'src-tauri/absent')).toEqual([])
    expect(listCrates(root)).toEqual(['tauri-plugin-mob', 'tauri-plugin-orphan', 'tauri-plugin-peer'])
    expect(listCrates(join(root, 'nowhere'))).toEqual([])
    expect(loadManifest(root).manifest.capabilities).toHaveLength(2)
    expect(loadManifest(join(root, 'nowhere')).error).toContain('cannot read')
    expect(formatSummary(checkCompositions(root).summary)).toBe('compositions-check: 3 platforms, 2 capabilities, 2 crates checked, 0 findings')
    expect(() => checkCompositions(join(root, 'nowhere'))).toThrow(/cannot read/)
    expect(checkCompositions(REPO_ROOT).findings).toEqual([])
  })
})
