import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { RemovalRefused } from './lib/removal.mjs'
import { applyPlan, cargoPruneLock, describePlan, gitTracks, parseArgs, planRemoval, runRustfmt } from './capability-remove.mjs'

/**
 * `pnpm capability:remove <id>` over fixture trees shaped like the real
 * one: removing `example` leaves the manifest empty, the three
 * compositions without the import, lib.rs and Cargo.toml untouched (no
 * crate), the directory gone; a second run and an unknown id fail without
 * touching anything; a fixture WITH a crate exercises the Cargo, lib.rs and
 * ACL surfaces; every refusal leaves the tree byte-identical.
 */

const SCRIPT = fileURLToPath(new URL('./capability-remove.mjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/* The fixture's files, SELF-CONTAINED on purpose — modelled on the real
 * tree's shapes (the composition's doc comment and typed array, the
 * commented dependency line, the chained `.plugin()` with a comment above
 * it, the ACL's blank-line groups) but not read from it. `pnpm verify:without
 * <id>` runs this suite in a copy of the tree with `<id>` already gone; a
 * fixture built from the real `src/capabilities/example` would vanish with
 * it. */

const MANIFEST = (entries) => `${JSON.stringify({ $schema: './capabilities.manifest.schema.json', capabilities: entries }, null, 2)}\n`
const EXAMPLE = { id: 'example', requires: [], ts: 'example', platforms: ['desktop', 'ios', 'android'] }
const PEER = { id: 'peer', requires: [], ts: 'peer', platforms: ['desktop', 'ios', 'android'], crate: 'tauri-plugin-peer', plugin: 'peer', permissions: ['peer:default'] }

const composition = (platform, names) =>
  `import type { Capability } from '../kernel'\n${names.map((n) => `import { ${n} } from '../capabilities/${n}'\n`).join('')}\n/**\n * The ${platform} composition — STATIC; \`capability:remove <id>\` edits it.\n */\nexport const capabilities: readonly Capability[] = [${names.join(', ')}]\n`

const CARGO_TOML = [
  '[package]',
  'name = "app"',
  '',
  '[dependencies]',
  'tauri = { version = "2.11.3", features = ["macos-private-api", "image-png"] }',
  '# The peer transport, on every platform (crates/tauri-plugin-peer).',
  'tauri-plugin-peer = { path = "crates/tauri-plugin-peer" }',
  '# Automation bridge for e2e testing.',
  'tauri-plugin-mcp-bridge = { version = "0.12", optional = true }',
  '',
  '[features]',
  'default = ["desktop"]',
  'desktop = [',
  '    "dep:tauri-plugin-mcp-bridge",',
  '    "tauri/tray-icon",',
  ']',
  'ios = ["tauri-plugin-peer/ios"]',
  'android = ["tauri-plugin-peer/android"]',
  '',
].join('\n')

const LIB_RS = [
  '#[cfg_attr(mobile, tauri::mobile_entry_point)]',
  'pub fn run() {',
  '    let mut builder = tauri::Builder::default()',
  '        .plugin(tauri_plugin_fs::init())',
  '        .plugin(tauri_plugin_dialog::init());',
  '',
  '    builder = builder',
  '        // The peer transport, every platform. Its commands are granted by',
  '        // `peer:default` in capabilities/default.json.',
  '        .plugin(tauri_plugin_peer::init())',
  '        .setup(|app| {',
  '            let _ = app;',
  '            Ok(())',
  '        });',
  '',
  '    builder',
  '        .run(tauri::generate_context!())',
  '        .expect("error while running tauri application");',
  '}',
  '',
].join('\n')

const ACL = '{\n  "identifier": "default",\n  "windows": [\n    "main"\n  ],\n  "permissions": [\n    "core:default",\n\n    "dialog:allow-open",\n\n    "peer:default",\n\n    "fs:allow-read-text-file"\n  ]\n}\n'

const roots = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function run(args, cwd = REPO_ROOT) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', timeout: 120_000 })
  if (result.error) throw result.error
  return { code: result.status, out: result.stdout, err: result.stderr }
}

/** Every file under `root` with its bytes — "nothing changed" is an equality. */
function snapshot(root) {
  const out = new Map()
  const walk = (rel) => {
    for (const name of readdirSync(path.join(root, rel)).sort()) {
      const child = rel === '' ? name : `${rel}/${name}`
      if (name === '.git') continue
      if (statSync(path.join(root, child)).isDirectory()) walk(child)
      else out.set(child, readFileSync(path.join(root, child), 'utf8'))
    }
  }
  walk('')
  return out
}

/** A tree with `example` (no crate) on every registration surface, plus the
 *  K.8 peer crate present but unclaimed, as the real tree has it today.
 *  `over` lays files over (null deletes). */
function fixture(over = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'capability-remove-'))
  roots.push(root)
  const files = {
    'capabilities.manifest.json': MANIFEST([EXAMPLE]),
    'src/app/composition.desktop.ts': composition('desktop', ['example']),
    'src/app/composition.ios.ts': composition('ios', ['example']),
    'src/app/composition.android.ts': composition('android', ['example']),
    'src/capabilities/example/index.ts': "export const example = { id: 'example' }\n",
    'src/capabilities/example/ui/ExamplePane.tsx': 'export const ExamplePane = () => null\n',
    'src/kernel/index.ts': 'export type Capability = { id: string }\n',
    'src-tauri/Cargo.toml': CARGO_TOML,
    'src-tauri/src/lib.rs': LIB_RS,
    'src-tauri/capabilities/default.json': ACL,
    'src-tauri/crates/tauri-plugin-peer/Cargo.toml': '[package]\nname = "tauri-plugin-peer"\n',
    ...over,
  }
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) continue
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  return root
}

/** The fixture with `peer` as a second, crate-backed capability composed everywhere. */
function fixtureWithCrate(over = {}) {
  return fixture({
    'capabilities.manifest.json': MANIFEST([EXAMPLE, PEER]),
    'src/capabilities/peer/index.ts': "export const peer = { id: 'peer' }\n",
    'src/app/composition.desktop.ts': composition('desktop', ['example', 'peer']),
    'src/app/composition.ios.ts': composition('ios', ['example', 'peer']),
    'src/app/composition.android.ts': composition('android', ['example', 'peer']),
    ...over,
  })
}

const rustfmtAvailable = spawnSync('rustfmt', ['--version'], { encoding: 'utf8' }).status === 0

describe('removing example (no crate)', () => {
  it('empties the manifest, cuts the import from every composition, deletes the directory, leaves Rust alone', () => {
    const root = fixture()
    const before = snapshot(root)
    const { code, out, err } = run(['example', '--root', root])
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toContain('capability-remove: example\n')
    expect(out).toContain('  edit    capabilities.manifest.json — remove entry "example"')
    expect(out).toContain('  edit    src/app/composition.ios.ts — remove import of ../capabilities/example and "example"')
    expect(out).toContain('  delete  src/capabilities/example/')
    expect(out).toContain('capability-remove: example removed from 4 files, 1 directories deleted')

    expect(readFileSync(path.join(root, 'capabilities.manifest.json'), 'utf8')).toBe('{\n  "$schema": "./capabilities.manifest.schema.json",\n  "capabilities": []\n}\n')
    for (const platform of ['desktop', 'ios', 'android']) {
      const text = readFileSync(path.join(root, `src/app/composition.${platform}.ts`), 'utf8')
      expect(text).not.toContain("from '../capabilities/example'")
      expect(text).toContain('export const capabilities: readonly Capability[] = []\n')
    }
    expect(existsSync(path.join(root, 'src/capabilities/example'))).toBe(false)
    expect(readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8')).toBe(before.get('src-tauri/Cargo.toml'))
    expect(readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8')).toBe(before.get('src-tauri/src/lib.rs'))
    expect(readFileSync(path.join(root, 'src-tauri/capabilities/default.json'), 'utf8')).toBe(before.get('src-tauri/capabilities/default.json'))
    expect(readFileSync(path.join(root, 'src/kernel/index.ts'), 'utf8')).toBe(before.get('src/kernel/index.ts'))
    expect(readdirSync(root).filter((n) => n.endsWith('.tmp'))).toEqual([])

    // A second run: the id is unknown now, exit 1, nothing changes.
    const after = snapshot(root)
    const again = run(['example', '--root', root])
    expect(again).toMatchObject({ code: 1, out: '', err: 'capability-remove: refused — unknown capability "example"; the manifest declares none\n' })
    expect(snapshot(root)).toEqual(after)
  })

  it('--dry-run prints the plan and writes nothing; --keep-files keeps the directory', () => {
    const root = fixture()
    const before = snapshot(root)
    const dry = run(['example', '--root', root, '--dry-run'])
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('capability-remove: dry run, nothing written')
    expect(snapshot(root)).toEqual(before)

    const kept = run(['example', '--root', root, '--keep-files'])
    expect(kept.code).toBe(0)
    expect(kept.out).not.toContain('delete')
    expect(existsSync(path.join(root, 'src/capabilities/example/index.ts'))).toBe(true)
    expect(JSON.parse(readFileSync(path.join(root, 'capabilities.manifest.json'), 'utf8')).capabilities).toEqual([])
  })

  it('an unknown id is exit 1 and names what the manifest declares', () => {
    const root = fixture()
    const before = snapshot(root)
    expect(run(['nope', '--root', root])).toMatchObject({ code: 1, err: 'capability-remove: refused — unknown capability "nope"; the manifest declares "example"\n' })
    expect(snapshot(root)).toEqual(before)
  })

  it('removes a tracked directory through git rm --cached, leaving the index without it', () => {
    const root = fixture()
    const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'test')
    git('add', '.')
    git('commit', '-q', '-m', 'fixture')
    expect(gitTracks(root, 'src/capabilities/example')).toBe(true)
    expect(gitTracks(root, 'src/nowhere')).toBe(false)
    const { code, out } = run(['example', '--root', root])
    expect(code).toBe(0)
    expect(out).toContain('delete  src/capabilities/example/ (tracked: git rm --cached)')
    expect(git('ls-files', 'src/capabilities').stdout).toBe('')
    expect(existsSync(path.join(root, 'src/capabilities/example'))).toBe(false)
  })
})

describe('removing peer (a crate)', () => {
  it('edits Cargo.toml, lib.rs and the ACL, deletes both directories, and leaves example composed', () => {
    const root = fixtureWithCrate()
    const { code, out, err } = run(['peer', '--root', root, '--no-cargo', '--no-rustfmt'])
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toContain('capability-remove: peer (crate tauri-plugin-peer)')
    expect(out).toContain('edit    src-tauri/Cargo.toml — remove dependency tauri-plugin-peer and feature items ios: tauri-plugin-peer/ios, android: tauri-plugin-peer/android')
    expect(out).toContain('edit    src-tauri/src/lib.rs — remove .plugin(tauri_plugin_peer::init())')
    expect(out).toContain('edit    src-tauri/capabilities/default.json — remove grants "peer:default"')
    expect(out).toContain('delete  src/capabilities/peer/')
    expect(out).toContain('delete  src-tauri/crates/tauri-plugin-peer/')
    expect(out).not.toContain('pruned')

    const cargo = readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8')
    expect(cargo).not.toContain('tauri-plugin-peer')
    expect(cargo).toContain('ios = []\nandroid = []\n')
    const lib = readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8')
    expect(lib).not.toContain('tauri_plugin_peer')
    expect(lib).toContain('.plugin(tauri_plugin_dialog::init())')
    const acl = JSON.parse(readFileSync(path.join(root, 'src-tauri/capabilities/default.json'), 'utf8'))
    expect(acl.permissions).not.toContain('peer:default')
    expect(acl.permissions).toContain('dialog:allow-open')
    expect(existsSync(path.join(root, 'src-tauri/crates/tauri-plugin-peer'))).toBe(false)
    expect(existsSync(path.join(root, 'src/capabilities/peer'))).toBe(false)
    expect(existsSync(path.join(root, 'src/capabilities/example/index.ts'))).toBe(true)
    const manifest = JSON.parse(readFileSync(path.join(root, 'capabilities.manifest.json'), 'utf8'))
    expect(manifest.capabilities.map((c) => c.id)).toEqual(['example'])
    for (const platform of ['desktop', 'ios', 'android']) {
      const text = readFileSync(path.join(root, `src/app/composition.${platform}.ts`), 'utf8')
      expect(text).toContain("import { example } from '../capabilities/example'\n")
      expect(text).not.toContain('peer')
      expect(text).toContain('= [example]')
    }
  })

  it('formats the edited lib.rs with rustfmt when it is available, and refuses when it is not', () => {
    const root = fixtureWithCrate()
    if (rustfmtAvailable) {
      const plan = planRemoval(root, 'peer')
      const lib = plan.edits.find((e) => e.file === 'src-tauri/src/lib.rs')
      expect(lib.note).toBe('remove .plugin(tauri_plugin_peer::init()), rustfmt')
      const tmp = path.join(root, 'check.rs')
      writeFileSync(tmp, lib.text)
      const check = spawnSync('rustfmt', ['--edition', '2021', '--check', tmp], { encoding: 'utf8' })
      expect(check.status).toBe(0)
      // rustfmt joined the one-call chain back onto one line, as it writes it.
      expect(lib.text).toContain('builder = builder.setup(|app| {')
      expect(readdirSync(path.join(root, 'src-tauri/src'))).toEqual(['lib.rs'])
    } else {
      expect(() => planRemoval(root, 'peer')).toThrow(/rustfmt is not available/)
    }
  })

  it('runRustfmt refuses text rustfmt cannot parse, and cleans its temporary file up', () => {
    if (!rustfmtAvailable) return expect(() => runRustfmt('fn main() {}', path.join(fixture(), 'src-tauri/src/lib.rs'))).toThrow(/rustfmt is not available/)
    const root = fixture()
    expect(() => runRustfmt('fn broken( {', path.join(root, 'src-tauri/src/lib.rs'))).toThrow(/rustfmt refused/)
    expect(readdirSync(path.join(root, 'src-tauri/src'))).toEqual(['lib.rs'])
    expect(runRustfmt('fn  main( ){ }\n', path.join(root, 'src-tauri/src/lib.rs'))).toBe('fn main() {}\n')
  })

  it('cargoPruneLock fails loudly outside a Cargo project', () => {
    const root = fixture()
    expect(() => cargoPruneLock(root)).toThrow(/cargo (metadata --offline failed|is not available)/)
  })
})

describe('refusals leave the tree untouched', () => {
  const cases = [
    {
      name: 'another entry requires the id',
      over: () => ({
        'capabilities.manifest.json': MANIFEST([EXAMPLE, { id: 'dep', requires: ['example'], ts: 'dep', platforms: ['desktop'] }]),
        'src/capabilities/dep/index.ts': 'export {}\n',
      }),
      id: 'example',
      message: /"dep" require "example"/,
    },
    { name: 'a composition file is missing', over: () => ({ 'src/app/composition.ios.ts': null }), id: 'example', message: /composition\.ios\.ts does not exist/ },
    { name: 'the manifest is invalid', over: () => ({ 'capabilities.manifest.json': '{"capabilities":[{"id":"example"}]}' }), id: 'example', message: /is invalid .*TS_MISSING/s },
    {
      name: 'a composition wires the capability in a way the tool does not understand',
      over: () => ({ 'src/app/composition.android.ts': "import type { Capability } from '../kernel'\nimport { example } from '../capabilities/example'\nconst wrapped = example\nexport const capabilities: readonly Capability[] = [wrapped]\n" }),
      id: 'example',
      message: /still references "example"/,
    },
  ]
  for (const c of cases) {
    it(c.name, () => {
      const root = fixture(c.over())
      const before = snapshot(root)
      const { code, err } = run([c.id, '--root', root])
      expect(code).toBe(1)
      expect(err).toMatch(/^capability-remove: refused — /)
      expect(err).toMatch(c.message)
      expect(snapshot(root)).toEqual(before)
    })
  }

  it('a crate the tree does not depend on, or does not register, is an inconsistent tree', () => {
    const noDep = fixtureWithCrate({ 'src-tauri/Cargo.toml': CARGO_TOML.replace('tauri-plugin-peer = { path = "crates/tauri-plugin-peer" }\n', '') })
    const before = snapshot(noDep)
    expect(run(['peer', '--root', noDep, '--no-cargo', '--no-rustfmt'])).toMatchObject({ code: 1, err: expect.stringContaining('has no [dependencies] entry with path = "crates/tauri-plugin-peer"') })
    expect(snapshot(noDep)).toEqual(before)
    const noReg = fixtureWithCrate({ 'src-tauri/src/lib.rs': LIB_RS.replace('.plugin(tauri_plugin_peer::init())', '') })
    expect(run(['peer', '--root', noReg, '--no-cargo', '--no-rustfmt'])).toMatchObject({ code: 1, err: expect.stringContaining('does not call .plugin(tauri_plugin_peer::init())') })
  })

  it('exit 2 for usage errors, an unreadable manifest and a root that is not a directory', () => {
    expect(run([])).toMatchObject({ code: 2, err: expect.stringContaining('a capability id is required') })
    expect(run(['a', 'b'])).toMatchObject({ code: 2, err: expect.stringContaining('exactly one capability id') })
    expect(run(['a', '--root'])).toMatchObject({ code: 2, err: expect.stringContaining('--root needs a directory') })
    expect(run(['a', '--wat'])).toMatchObject({ code: 2, err: expect.stringContaining('unknown argument "--wat"') })
    expect(run(['a', '--root', path.join(REPO_ROOT, 'package.json')])).toMatchObject({ code: 2, err: expect.stringContaining('is not a directory') })
    const empty = mkdtempSync(path.join(tmpdir(), 'capability-remove-empty-'))
    roots.push(empty)
    expect(run(['a', '--root', empty])).toMatchObject({ code: 2, err: expect.stringContaining('cannot read capabilities.manifest.json') })
  })
})

describe('the pieces', () => {
  it('parseArgs reads every flag', () => {
    expect(parseArgs(['x', '--root', 'r', '--keep-files', '--dry-run', '--no-cargo', '--no-rustfmt'], '/cwd')).toEqual({
      id: 'x',
      root: path.resolve('/cwd', 'r'),
      deleteFiles: false,
      dryRun: true,
      cargo: false,
      rustfmt: false,
    })
    expect(parseArgs(['x'], '/cwd')).toMatchObject({ id: 'x', root: REPO_ROOT, deleteFiles: true, dryRun: false, cargo: true, rustfmt: true })
  })

  it('planRemoval + applyPlan through injected hooks: git rm and the lockfile prune are called as the plan says', () => {
    const root = fixtureWithCrate()
    const calls = []
    const plan = planRemoval(root, 'peer', { rustfmt: false, hooks: { isTracked: (r, rel) => rel === 'src/capabilities/peer' } })
    expect(plan.deletions).toEqual([
      { dir: 'src/capabilities/peer', tracked: true },
      { dir: 'src-tauri/crates/tauri-plugin-peer', tracked: false },
    ])
    expect(describePlan(plan)).toContain('  delete  src/capabilities/peer/ (tracked: git rm --cached)')
    expect(plan.notes).toEqual([])
    const lines = applyPlan(root, plan, { hooks: { gitRm: (r, rel) => calls.push(`rm ${rel}`), cargoPrune: (r) => calls.push(`prune ${r === root}`) } })
    expect(calls).toEqual(['rm src/capabilities/peer', 'prune true'])
    expect(lines.at(-1)).toBe('pruned  src-tauri/Cargo.lock (cargo metadata --offline)')
    expect(lines).toContain('deleted src/capabilities/peer/ (git rm --cached, then removed)')
    // A capability no composition imports is noted, not refused.
    const lonely = fixture({ 'src/app/composition.android.ts': "import type { Capability } from '../kernel'\nexport const capabilities: readonly Capability[] = []\n" })
    const p2 = planRemoval(lonely, 'example', { deleteFiles: false })
    expect(p2.notes).toEqual(['src/app/composition.android.ts: does not import example; nothing to remove'])
    expect(p2.deletions).toEqual([])
    expect(describePlan(p2)).toContain('  keep    src/app/composition.android.ts: does not import example; nothing to remove')
    expect(() => planRemoval(lonely, 'nope')).toThrow(RemovalRefused)
  })
})
