import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  dependenciesOfFeature,
  dependencyForCrate,
  featureItemNames,
  normalizeCratePath,
  parseValue,
  readCargoManifest,
  readFeatureItem,
  rustName,
  splitComment,
} from './cargo.mjs'

/**
 * The Cargo.toml reader: the shapes Cargo documents for `[dependencies]`
 * and `[features]`, the ways a line can be commented, and the feature rules
 * (`dep:`, `x/f`, `x?/f`, the implicit feature of an optional dependency)
 * that decide which platforms compile a crate. The real manifest is read at
 * the end, so the reader is proven against the file it exists for.
 */

const REAL = new URL('../../src-tauri/Cargo.toml', import.meta.url)

describe('splitComment', () => {
  it('cuts a trailing # comment and leaves # inside strings alone', () => {
    expect(splitComment('a = "x # y" # real')).toEqual(['a = "x # y" ', '# real'])
    expect(splitComment("a = 'x # y'")).toEqual(["a = 'x # y'", ''])
    expect(splitComment('a = "esc \\" # q" # c')).toEqual(['a = "esc \\" # q" ', '# c'])
    expect(splitComment('# whole line')).toEqual(['', '# whole line'])
    expect(splitComment('plain')).toEqual(['plain', ''])
  })
})

describe('parseValue', () => {
  it('reads strings, booleans, numbers, arrays and inline tables', () => {
    expect(parseValue('"1.0"').value).toBe('1.0')
    expect(parseValue("'lit'").value).toBe('lit')
    expect(parseValue('true').value).toBe(true)
    expect(parseValue('false').value).toBe(false)
    expect(parseValue('42').value).toBe(42)
    expect(parseValue('1_000.5').value).toBe(1000.5)
    expect(parseValue('-3e2').value).toBe(-300)
    expect(parseValue('["a", "b"]').value).toEqual(['a', 'b'])
    expect(parseValue('[ ]').value).toEqual([])
    expect(parseValue('["a",]').value).toEqual(['a'])
    expect(parseValue('{ path = "crates/x", optional = true, features = ["a"] }').value).toEqual({
      path: 'crates/x',
      optional: true,
      features: ['a'],
    })
    expect(parseValue('{}').value).toEqual({})
    expect(parseValue('{ "quoted key" = 1 }').value).toEqual({ 'quoted key': 1 })
    expect(parseValue('[\n  "a", # c\n  "b"\n]').value).toEqual(['a', 'b'])
    expect(parseValue('"\\u0041\\U0001F600 \\n\\t\\b\\f\\r\\\\"').value).toBe('A😀 \n\t\b\f\r\\')
    expect(parseValue('  "x"  ').end).toBe(5)
  })

  it('refuses what it does not understand, naming the offset', () => {
    expect(() => parseValue('@')).toThrow(/cannot read TOML value at offset 0/)
    expect(() => parseValue('"open')).toThrow(/unterminated/)
    expect(() => parseValue('"line\nbreak"')).toThrow(/newline/)
    expect(() => parseValue("'open")).toThrow(/unterminated/)
    expect(() => parseValue("'a\nb'")).toThrow(/newline/)
    expect(() => parseValue('"\\q"')).toThrow(/escape/)
    expect(() => parseValue('"\\u12"')).toThrow(/unicode/)
    expect(() => parseValue('["a" "b"]')).toThrow(/expected , or \]/)
    expect(() => parseValue('["a"')).toThrow(/unterminated/)
    expect(() => parseValue('{ a = 1 b = 2 }')).toThrow(/expected , or \}/)
    expect(() => parseValue('{ = 1 }')).toThrow(/inline table key/)
    expect(() => parseValue('{ a = 1')).toThrow(/unterminated/)
  })
})

describe('readCargoManifest', () => {
  const text = `
[package]
name = "app"

[dependencies]
serde = "1.0"
# about peer
tauri-plugin-peer = { path = "crates/tauri-plugin-peer" }
opt = { version = "1", optional = true }
renamed = { package = "real-name", path = "./crates/real/", optional = true }
"quoted-dep" = "2"

[dependencies.tabled]
path = "crates/tabled"
optional = true

[features]
default = ["desktop"]
desktop = [
    "dep:opt",
    "shared", # a feature
]
shared = ["renamed/x", "tabled"]
ios = ["tauri-plugin-peer/ios", "opt?/weak"]
android = []
loop-a = ["loop-b"]
loop-b = ["loop-a", "dep:opt"]

[dev-dependencies]
ignored = "1"
`
  const m = readCargoManifest(text)

  it('reads every dependency form with its span, path, optional and package', () => {
    expect([...m.dependencies.keys()]).toEqual(['serde', 'tauri-plugin-peer', 'opt', 'renamed', 'quoted-dep', 'tabled'])
    expect(m.dependencies.get('serde')).toMatchObject({ spec: '1.0', optional: false, path: null, package: null, lines: [5, 5] })
    expect(m.dependencies.get('tauri-plugin-peer')).toMatchObject({ path: 'crates/tauri-plugin-peer', optional: false, lines: [7, 7] })
    expect(m.dependencies.get('opt')).toMatchObject({ optional: true, path: null })
    expect(m.dependencies.get('renamed')).toMatchObject({ package: 'real-name', path: './crates/real/', optional: true })
    expect(m.dependencies.get('quoted-dep')).toMatchObject({ spec: '2' })
    expect(m.dependencies.get('tabled')).toMatchObject({ path: 'crates/tabled', optional: true, lines: [12, 14] })
  })

  it('reads features, one line or many, with comments inside', () => {
    expect(m.features.get('desktop')).toEqual({ name: 'desktop', items: ['dep:opt', 'shared'], lines: [18, 21] })
    expect(m.features.get('ios')).toEqual({ name: 'ios', items: ['tauri-plugin-peer/ios', 'opt?/weak'], lines: [23, 23] })
    expect(m.features.get('android').items).toEqual([])
    expect(m.features.has('ignored')).toBe(false)
  })

  it('reads a [dependencies.<name>] table that ends the file', () => {
    const tail = readCargoManifest('[dependencies.last]\npath = "crates/last"\n\n')
    expect(tail.dependencies.get('last')).toMatchObject({ path: 'crates/last', lines: [0, 1] })
    const quoted = readCargoManifest('[dependencies."q-x"]\nversion = "1"\n')
    expect(quoted.dependencies.get('q-x')).toMatchObject({ spec: { version: '1' } })
  })

  it('refuses a line it cannot read in the tables it owns, and ignores others', () => {
    expect(() => readCargoManifest('[dependencies]\njunk line\n')).toThrow(/line 2: expected `key = value`/)
    expect(() => readCargoManifest('[features]\nx = "not an array"\n')).toThrow(/must be an array of strings/)
    expect(() => readCargoManifest('[features]\nx = [1]\n')).toThrow(/must be an array of strings/)
    expect(() => readCargoManifest('[dependencies.t]\nnonsense\n')).toThrow(/expected `key = value`/)
    expect(readCargoManifest('[package]\nweird line without equals\n').dependencies.size).toBe(0)
  })

  it('reads the real manifest: the three platform features, the desktop-only plugins, and every crate by its directory', () => {
    const real = readCargoManifest(readFileSync(REAL, 'utf8'))
    expect(real.features.get('default').items).toEqual(['desktop'])
    /* NATIVE platforms only. `web` is a platform of the application and not a
       Tauri target — the browser client compiles no Rust — so it has no Cargo
       feature and must not grow one. */
    for (const platform of ['desktop', 'ios', 'android']) expect(real.features.has(platform)).toBe(true)
    expect(real.features.has('web'), 'a web Cargo feature would compile nothing').toBe(false)
    /* The desktop-only set. `tauri-plugin-inference` joined it in phase 15:
       `lemond` ships for macOS, Windows and Linux and has no mobile build, so
       gating the DEPENDENCY (not just the `.plugin()` call) is what keeps its
       rustls provider off the iOS and Android targets entirely.

       `axum` joined it in phase 18 for the same reason in a different shape:
       it serves the browser client, a phone is never a shelf, and a dependency
       gated only at the call site is still compiled. `tauri-plugin-webhost`
       joined on the same reasoning when the host became a capability. This set
       is a LEDGER — it fails when the desktop-only set changes, which is
       exactly the point, and it has now caught three deliberate changes: the
       third was WI-20.32's `single-instance` and `window-state`, both
       `#![cfg(not(mobile))]` upstream and desktop-only here for the same
       reason `lemond` started the list. The fourth deliberate change was the
       audit-fix round REMOVING the app's vestigial direct `axum`: app code
       never referenced it, and the server crate under the webhost plugin
       declares it with the identical feature set. */
    expect(dependenciesOfFeature('desktop', real)).toEqual(
      new Set([
        'tauri-plugin-inference',
        'tauri-plugin-mcp-bridge',
        'tauri-plugin-persisted-scope',
        'tauri-plugin-single-instance',
        'tauri-plugin-webhost',
        'tauri-plugin-window-state',
        'tauri',
      ]),
    )
    // Data-driven over whatever crates the tree has: each path dependency is found by its directory name.
    for (const dep of real.dependencies.values()) {
      if (dep.path === null) continue
      const dir = normalizeCratePath(dep.path).replace(/^crates\//, '')
      expect(dependencyForCrate(real, dir)).toBe(dep)
    }
  })

  describe('feature rules', () => {
    it('reads each item form', () => {
      expect(readFeatureItem('dep:opt', m)).toEqual({ dependency: 'opt', feature: null })
      expect(readFeatureItem('renamed/x', m)).toEqual({ dependency: 'renamed', feature: null })
      expect(readFeatureItem('opt?/weak', m)).toEqual({ dependency: null, feature: null })
      expect(readFeatureItem('shared', m)).toEqual({ dependency: null, feature: 'shared' })
      expect(readFeatureItem('tabled', m)).toEqual({ dependency: 'tabled', feature: null })
      expect(readFeatureItem('serde', m)).toEqual({ dependency: null, feature: null })
      expect(readFeatureItem('nothing', m)).toEqual({ dependency: null, feature: null })
    })

    it('resolves a feature transitively, and a cycle terminates', () => {
      expect(dependenciesOfFeature('desktop', m)).toEqual(new Set(['opt', 'renamed', 'tabled']))
      expect(dependenciesOfFeature('ios', m)).toEqual(new Set(['tauri-plugin-peer']))
      expect(dependenciesOfFeature('android', m)).toEqual(new Set())
      expect(dependenciesOfFeature('unknown', m)).toEqual(new Set())
      expect(dependenciesOfFeature('loop-a', m)).toEqual(new Set(['opt']))
    })

    it('knows which items name a dependency', () => {
      expect(featureItemNames('dep:opt', 'opt', m)).toBe(true)
      expect(featureItemNames('renamed/x', 'renamed', m)).toBe(true)
      expect(featureItemNames('opt?/weak', 'opt', m)).toBe(true)
      expect(featureItemNames('tabled', 'tabled', m)).toBe(true)
      expect(featureItemNames('shared', 'shared', m)).toBe(false)
      expect(featureItemNames('dep:opt', 'renamed', m)).toBe(false)
      expect(featureItemNames('nothing', 'nothing', m)).toBe(false)
    })
  })

  it('finds a dependency by crate path however the path is spelled, and none otherwise', () => {
    expect(dependencyForCrate(m, 'tauri-plugin-peer')?.name).toBe('tauri-plugin-peer')
    expect(dependencyForCrate(m, 'real')?.name).toBe('renamed')
    expect(dependencyForCrate(m, 'tabled')?.name).toBe('tabled')
    expect(dependencyForCrate(m, 'nope')).toBeNull()
    expect(normalizeCratePath('.\\crates\\x\\')).toBe('crates/x')
  })

  it('names a crate as Rust does', () => {
    expect(rustName('tauri-plugin-peer')).toBe('tauri_plugin_peer')
    expect(rustName('serde')).toBe('serde')
  })
})
