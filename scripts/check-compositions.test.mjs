import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCompositions, formatSummary, isPluginCrate, listCrates, loadManifest, readAclFiles, readOrNull } from './check-compositions.mjs'

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
    /* `web` composes nothing — a browser can compose no Tauri-bound
       capability — but the FILE must exist: every platform has a static
       composition, and its absence is COMPOSITION_ABSENT. */
    'src/app/composition.web.ts': 'export const capabilities = []\n',
    'src-tauri/crates/tauri-plugin-peer/Cargo.toml': '[package]\nname = "tauri-plugin-peer"\n',
    'src-tauri/crates/tauri-plugin-mob/Cargo.toml': '[package]\nname = "tauri-plugin-mob"\n',
    /* AN UNCLAIMED PLUGIN, and it has to LOOK like one or the check is right to
       ignore it: a plugin crate is recognised by its `build.rs` and its
       `permissions/`, which is what it means to have commands and an ACL for a
       manifest entry to describe. Without those two this fixture was asserting
       a note for something that is not a plugin at all. */
    'src-tauri/crates/tauri-plugin-orphan/Cargo.toml': '[package]\nname = "tauri-plugin-orphan"\n',
    /* `tauri_plugin::Builder` is what makes a crate a plugin — the line that
       generates its command permissions. See `isPluginCrate`. */
    'src-tauri/crates/tauri-plugin-orphan/build.rs':
      'const COMMANDS: &[&str] = &[];\nfn main() { tauri_plugin::Builder::new(COMMANDS).build(); }\n',
    'src-tauri/crates/tauri-plugin-orphan/permissions/default.toml': '[default]\npermissions = []\n',
    /* A PLAIN LIBRARY beside it. No `build.rs`, no `permissions/` — it has no
       features, registration or grants, so there is nothing for a manifest
       entry to check and no note to print. `paper-webauth` and `paper-webhost`
       are the real ones. */
    'src-tauri/crates/paper-plainlib/Cargo.toml': '[package]\nname = "paper-plainlib"\n',
    'src-tauri/crates/paper-plainlib/src/lib.rs': 'pub fn nothing() {}\n',
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
  it('is clean: 4 platforms, the manifest\'s capabilities, a note for each unclaimed crate, 0 findings', () => {
    // Computed from the tree, not spelled out: `pnpm verify:without <id>`
    // runs this suite in a copy with `<id>` gone.
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'capabilities.manifest.json'), 'utf8'))
    const claimed = new Set(manifest.capabilities.map((c) => c.crate).filter(Boolean))
    /* PLUGIN CRATES ONLY, as the check itself filters. A library crate has no
       features, registration or grants, so noting that they are unchecked says
       nothing — and a note that always prints is one nobody reads. */
    const unclaimed = listCrates(REPO_ROOT).filter((name) => !claimed.has(name) && isPluginCrate(REPO_ROOT, name))
    const { code, out, err } = run([])
    expect(err).toBe('')
    expect(out).toBe(
      unclaimed.map((name) => `note: src-tauri/crates/${name} is claimed by no manifest entry — its features, registration and grants are not checked\n`).join('') +
        `compositions-check: 4 platforms, ${manifest.capabilities.length} capabilities, ${claimed.size} crates checked, 0 findings\n`,
    )
    expect(code).toBe(0)
  })
})

describe('a tree with crates', () => {
  /**
   * ⚠️ **AN UNCLAIMED PLUGIN CRATE IS A FINDING, AND IT USED TO BE A NOTE.**
   *
   * The command printed the line and exited 0 — so the crate's Cargo features,
   * its `.plugin(…::init())` registration and every ACL grant it declares were
   * checked by nobody, while the gate reported success. That is the exact state
   * this check exists to make impossible, reached by adding a crate and
   * forgetting one manifest entry. The note was a description of the hole.
   */
  it('refuses an unclaimed plugin crate rather than noting it', () => {
    const root = fixture()
    const { code, out } = run(['--root', root])
    expect(out).toContain('CRATE_UNCLAIMED')
    expect(out).toContain('src-tauri/crates/tauri-plugin-orphan')
    expect(code).toBe(1)
  })

  it('passes, and says so, once every crate is claimed', () => {
    /* The same tree with the orphan removed — so the refusal above is about the
       unclaimed crate and not about the fixture being broken some other way. */
    const root = fixture({
      'src-tauri/crates/tauri-plugin-orphan/build.rs': null,
      'src-tauri/crates/tauri-plugin-orphan/permissions/default.toml': null,
      'src-tauri/crates/tauri-plugin-orphan/Cargo.toml': null,
    })
    const { code, out } = run(['--root', root])
    expect(out).toContain('0 findings')
    expect(code).toBe(0)
  })

  /**
   * A LIBRARY CRATE IS NOT AN UNCHECKED PLUGIN, and the difference is asked of
   * the directory rather than kept as a list here.
   *
   * `paper-webauth` and `paper-webhost` are the real ones: pure logic behind
   * `tauri-plugin-webhost`, which the manifest does claim. They printed a note
   * on every run saying their "features, registration and grants are not
   * checked" — true only in the sense that they have none. A note that always
   * prints is a note nobody reads, and the day a real plugin crate goes
   * unclaimed it would have arrived in the middle of them.
   *
   * Both halves are asserted, because silencing the note is the easy half and
   * the worthless one on its own.
   */
  it('reports an unclaimed PLUGIN crate and says nothing about a library beside it', () => {
    const root = fixture()
    expect(isPluginCrate(root, 'tauri-plugin-orphan')).toBe(true)
    expect(isPluginCrate(root, 'paper-plainlib')).toBe(false)

    const { out } = run(['--root', root])
    expect(out).toContain('src-tauri/crates/tauri-plugin-orphan')
    expect(out).not.toContain('paper-plainlib')
  })

  /**
   * ⚠️ **A PLUGIN WITH NO `permissions/` IS STILL A PLUGIN**, and requiring the
   * directory made this blind to the case most worth finding.
   *
   * The test used to demand BOTH `build.rs` and `permissions/`, so a Tauri
   * plugin whose ACL directory was MISSING — a plugin declaring commands that
   * nothing grants — was classified as a library crate: no note, no finding,
   * no check of any kind. The absence of the evidence was read as the absence
   * of the thing.
   *
   * `tauri_plugin::Builder` in `build.rs` is the marker instead. It is the line
   * that generates the command permissions, and a library crate has no reason
   * to hold it.
   */
  it('calls a crate a plugin on its build script, not on its ACL directory', () => {
    const noAcl = fixture({ 'src-tauri/crates/tauri-plugin-orphan/permissions/default.toml': null })
    expect(
      isPluginCrate(noAcl, 'tauri-plugin-orphan'),
      'a plugin missing its permissions/ is the case that most needs finding',
    ).toBe(true)

    const noBuild = fixture({ 'src-tauri/crates/tauri-plugin-orphan/build.rs': null })
    expect(isPluginCrate(noBuild, 'tauri-plugin-orphan')).toBe(false)

    /* A build script that is not a plugin's is not a plugin's. */
    const plainBuild = fixture({
      'src-tauri/crates/tauri-plugin-orphan/build.rs': 'fn main() { println!("cargo:rerun-if-changed=x"); }\n',
    })
    expect(isPluginCrate(plainBuild, 'tauri-plugin-orphan')).toBe(false)
  })

  it('reports drift on each surface as one line, exit 1', () => {
    const root = fixture({
      // composition drift: android forgets peer; desktop adds mob
      'src/app/composition.android.ts': 'export const capabilities = []\n',
      'src/app/composition.web.ts': 'export const capabilities = []\n',
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
      // Permissions report first now: the ACL pass covers every entry that
      // lists permissions, crate or not, so it runs before the Cargo pass.
      'PERMISSION_UNGRANTED',
      'PERMISSION_UNGRANTED',
      'PERMISSION_UNGRANTED',
      'PLUGIN_UNREGISTERED',
      'CRATE_PLATFORMS_DIFFER',
      'CRATE_UNCLAIMED',
      'compositions-check:',
    ])
    expect(lines[lines.length - 1]).toBe('compositions-check: 4 platforms, 2 capabilities, 2 crates checked, 8 findings')
    expect(code).toBe(1)
  })

  /**
   * THE iOS BUILD, IN ONE LINE. `mob` composes on iOS alone; granting it from
   * the platform-less `default.json` is what `inference:default` did to the
   * real tree, and tauri-build refuses that file on every other target. The
   * forward rule is satisfied — the grant exists — so this is the inverse
   * rule's finding and nobody else's.
   */
  it('reports a manifest plugin granted where it is not compiled, naming the file and the platforms, exit 1', () => {
    const root = fixture({
      'src-tauri/capabilities/default.json': JSON.stringify({ permissions: ['core:default', 'peer:default', 'mob:default'] }, null, 2),
    })
    const { code, out } = run(['--root', root])
    const lines = out.trimEnd().split('\n')
    expect(lines.map((l) => l.split(' ')[0])).toEqual(['GRANT_UNCOMPILED', 'CRATE_UNCLAIMED', 'compositions-check:'])
    expect(lines[0]).toContain('src-tauri/capabilities/default.json')
    expect(lines[0]).toContain('"mob:default"')
    expect(lines[0]).toContain('on macOS, windows, linux, android')
    expect(lines[0]).toContain('[ios]')
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
    expect(listCrates(root)).toEqual(['paper-plainlib', 'tauri-plugin-mob', 'tauri-plugin-orphan', 'tauri-plugin-peer'])
    expect(listCrates(join(root, 'nowhere'))).toEqual([])
    expect(loadManifest(root).manifest.capabilities).toHaveLength(2)
    expect(loadManifest(join(root, 'nowhere')).error).toContain('cannot read')
    /* One finding: the fixture's unclaimed plugin crate, which is a finding
       now rather than a note — see `refuses an unclaimed plugin crate`. */
    expect(formatSummary(checkCompositions(root).summary)).toBe('compositions-check: 4 platforms, 2 capabilities, 2 crates checked, 1 findings')
    expect(() => checkCompositions(join(root, 'nowhere'))).toThrow(/cannot read/)
    expect(checkCompositions(REPO_ROOT).findings).toEqual([])
  })
})
