import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { featureItemNames, readCargoManifest, rustName } from './cargo.mjs'
import { registersPlugin, stripComments } from './compositions.mjs'
import {
  RemovalRefused,
  findJsonArray,
  removeAclGrants,
  removeCargoDependency,
  removeFromComposition,
  removeJsonElements,
  removeManifestEntry,
  removePluginRegistration,
} from './removal.mjs'

/**
 * The edits behind `capability:remove`, each over text handed in: what
 * they cut, what they keep byte for byte around the cut, and what they
 * refuse. The real files are run through them at the end so the shapes
 * the tree actually uses are the shapes proven here.
 */

const REAL = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')

/* --------------------------------------------------------- composition.ts */

describe('removeFromComposition', () => {
  it('cuts the import and the array element, single-line array', () => {
    const src = "import type { Capability } from '../kernel'\nimport { alpha } from '../capabilities/alpha'\nimport { beta } from '../capabilities/beta'\n\nexport const capabilities: readonly Capability[] = [alpha, beta]\n"
    const r = removeFromComposition(src, 'alpha')
    expect(r).toEqual({
      text: "import type { Capability } from '../kernel'\nimport { beta } from '../capabilities/beta'\n\nexport const capabilities: readonly Capability[] = [beta]\n",
      changed: true,
      names: ['alpha'],
    })
    expect(removeFromComposition(r.text, 'beta').text).toBe("import type { Capability } from '../kernel'\n\nexport const capabilities: readonly Capability[] = []\n")
  })

  it('keeps a multi-line array multi-line, and empties it when nothing is left', () => {
    const src = "import { a } from '../capabilities/a/index'\nimport { b } from '../capabilities/b'\nexport const capabilities = [\n  a,\n  b,\n]\n"
    expect(removeFromComposition(src, 'a').text).toBe("import { b } from '../capabilities/b'\nexport const capabilities = [\n  b,\n]\n")
    expect(removeFromComposition(removeFromComposition(src, 'a').text, 'b').text).toBe('export const capabilities = []\n')
  })

  it('follows an alias, a default import and a namespace import', () => {
    const src = "import { a as first } from '../capabilities/a'\nimport dflt from '../capabilities/d'\nimport * as ns from '../capabilities/n'\nexport const capabilities = [first, dflt, ns]\n"
    expect(removeFromComposition(src, 'a')).toMatchObject({ names: ['first'], text: expect.stringContaining('[dflt, ns]') })
    expect(removeFromComposition(src, 'd')).toMatchObject({ names: ['dflt'], text: expect.stringContaining('[first, ns]') })
    expect(removeFromComposition(src, 'n')).toMatchObject({ names: ['ns'], text: expect.stringContaining('[first, dflt]') })
    const mixed = "import dflt, { type T, x as y } from '../capabilities/m'\nexport const capabilities = [dflt, y]\n"
    expect(removeFromComposition(mixed, 'm')).toMatchObject({ names: ['T', 'y', 'dflt'], text: 'export const capabilities = []\n' })
  })

  it('is a no-op when the capability is not imported', () => {
    const src = "import { b } from '../capabilities/b'\nexport const capabilities = [b]\n"
    expect(removeFromComposition(src, 'a')).toEqual({ text: src, changed: false, names: [] })
  })

  it('refuses a re-export, a missing array, a commented array and a residual reference', () => {
    expect(() => removeFromComposition("export { a } from '../capabilities/a'\nexport const capabilities = []\n", 'a')).toThrow(RemovalRefused)
    expect(() => removeFromComposition("import { a } from '../capabilities/a'\nexport const list = [a]\n", 'a')).toThrow(/no `export const capabilities/)
    expect(() => removeFromComposition("import { a } from '../capabilities/a'\nexport const capabilities = [\n  a, // first\n]\n", 'a')).toThrow(/contains a comment/)
    expect(() => removeFromComposition("import { a } from '../capabilities/a'\nconst wrapped = wrap(a)\nexport const capabilities = [wrapped]\n", 'a')).toThrow(/still references "a"/)
  })

})

/* ------------------------------------------------------------------- JSON */

describe('findJsonArray / removeJsonElements', () => {
  const text = '{\n  "$schema": "x",\n  "capabilities": [\n    { "id": "a", "requires": [] },\n    { "id": "b:]", "n": [1, {"k": "]"}] },\n    "c"\n  ],\n  "nested": { "capabilities": [9] }\n}\n'

  it('finds the array under a key at depth 1 and the spans of its elements', () => {
    const array = findJsonArray(text, 'capabilities')
    expect(array.elements.map((e) => text.slice(e.start, e.end))).toEqual(['{ "id": "a", "requires": [] }', '{ "id": "b:]", "n": [1, {"k": "]"}] }', '"c"'])
    expect(text[array.open]).toBe('[')
    expect(text[array.close]).toBe(']')
    expect(findJsonArray(text, 'missing')).toBeNull()
    expect(findJsonArray(text, 'capabilities', 2).elements.map((e) => text.slice(e.start, e.end))).toEqual(['9'])
    expect(findJsonArray('{"a": []}', 'a').elements).toEqual([])
  })

  it('removes a middle, a last and an only element with the formatting kept', () => {
    const array = findJsonArray(text, 'capabilities')
    const middle = removeJsonElements(text, array, [1])
    expect(JSON.parse(middle).capabilities).toEqual([{ id: 'a', requires: [] }, 'c'])
    expect(middle).toContain('    { "id": "a", "requires": [] },\n    "c"\n  ]')
    const last = removeJsonElements(text, array, [2])
    expect(last).toContain('{ "id": "b:]", "n": [1, {"k": "]"}] }\n  ],')
    const twoTail = removeJsonElements(text, array, [1, 2])
    expect(JSON.parse(twoTail).capabilities).toEqual([{ id: 'a', requires: [] }])
    const all = removeJsonElements(text, array, [0, 1, 2])
    expect(all).toContain('"capabilities": [],')
    const only = '{"p": [ "x" ]}'
    expect(removeJsonElements(only, findJsonArray(only, 'p'), [0])).toBe('{"p": []}')
  })

  it('refuses malformed text rather than guessing', () => {
    expect(() => findJsonArray('{"a": "open', 'a')).toThrow(/unterminated string/)
    expect(() => findJsonArray('{"a": [1, 2', 'a')).toThrow(/unterminated array/)
  })
})

describe('removeManifestEntry', () => {
  const text = JSON.stringify({ $schema: './s.json', capabilities: [{ id: 'a', requires: [], ts: 'a', platforms: ['desktop'] }, { id: 'b', ts: 'b', platforms: ['ios'] }] }, null, 2)

  it('cuts one entry and returns it, the rest byte-identical', () => {
    const r = removeManifestEntry(text, 'a')
    expect(r.entry.id).toBe('a')
    expect(JSON.parse(r.text)).toEqual({ $schema: './s.json', capabilities: [{ id: 'b', ts: 'b', platforms: ['ios'] }] })
    expect(r.text.startsWith('{\n  "$schema": "./s.json",\n  "capabilities": [\n    {\n      "id": "b"')).toBe(true)
  })

  it('refuses an unknown id and an id another entry requires', () => {
    expect(() => removeManifestEntry(text, 'zzz')).toThrow(/no capability "zzz"/)
    const dependent = JSON.stringify({ capabilities: [{ id: 'a' }, { id: 'b', requires: ['a'] }, { id: 'c', requires: ['a'] }] })
    expect(() => removeManifestEntry(dependent, 'a')).toThrow(/"b", "c" require "a"/)
  })

})

describe('removeAclGrants', () => {
  const text = '{\n  "identifier": "default",\n  "permissions": [\n    "core:default",\n\n    "peer:default",\n    { "identifier": "peer:allow-x", "allow": [] },\n\n    "fs:allow-read"\n  ]\n}\n'

  it('cuts every grant under the namespace, string or object, keeping the layout', () => {
    const r = removeAclGrants(text, 'peer')
    expect(r.removed).toEqual(['peer:default', 'peer:allow-x'])
    expect(r.text).toBe('{\n  "identifier": "default",\n  "permissions": [\n    "core:default",\n\n    "fs:allow-read"\n  ]\n}\n')
  })

  it('is a no-op without a permissions array or without a matching grant', () => {
    expect(removeAclGrants('{"identifier": "x"}', 'peer')).toEqual({ text: '{"identifier": "x"}', changed: false, removed: [] })
    expect(removeAclGrants(text, 'ghost').changed).toBe(false)
    expect(removeAclGrants('{"permissions": ["peerless:x", 7, {"k": 1}]}', 'peer').changed).toBe(false)
  })

})

/* ------------------------------------------------------------- Cargo.toml */

describe('removeCargoDependency', () => {
  const text = [
    '[dependencies]',
    'serde = "1"',
    '# The peer transport.',
    '# Two lines of it.',
    'tauri-plugin-peer = { path = "crates/tauri-plugin-peer" }',
    'tauri-plugin-mob = { path = "crates/tauri-plugin-mob", optional = true }',
    '',
    '[dependencies.tabled]',
    'path = "crates/tabled"',
    'optional = true',
    '',
    '[features]',
    'default = ["desktop"]',
    'desktop = [',
    '    "dep:tauri-plugin-mob",',
    '    "tabled", # implicit',
    '    "tauri/tray-icon",',
    ']',
    'ios = ["tauri-plugin-peer/ios", "tauri-plugin-mob/ios"]',
    'android = ["tauri-plugin-peer/android"]',
    'both = ["dep:tauri-plugin-mob", "tabled?/x", "serde/derive"]',
    '',
  ].join('\n')

  it('cuts a single-line dependency with its comment run and every feature item naming it', () => {
    const r = removeCargoDependency(text, 'tauri-plugin-peer')
    expect(r.changed).toBe(true)
    expect(r.removedFeatureItems).toEqual(['ios: tauri-plugin-peer/ios', 'android: tauri-plugin-peer/android'])
    expect(r.text).not.toContain('peer')
    expect(r.text).toContain('serde = "1"\ntauri-plugin-mob = ')
    expect(r.text).toContain('ios = ["tauri-plugin-mob/ios"]\nandroid = []\n')
  })

  it('cuts an optional dependency out of a multi-line array line by line', () => {
    const r = removeCargoDependency(text, 'tauri-plugin-mob')
    expect(r.text).toContain('desktop = [\n    "tabled", # implicit\n    "tauri/tray-icon",\n]\n')
    expect(r.text).toContain('ios = ["tauri-plugin-peer/ios"]\n')
    expect(r.text).toContain('both = ["tabled?/x", "serde/derive"]\n')
    expect(r.removedFeatureItems).toEqual(['desktop: dep:tauri-plugin-mob', 'ios: tauri-plugin-mob/ios', 'both: dep:tauri-plugin-mob'])
  })

  it('cuts a [dependencies.<name>] table, the weak and bare items that name it, and collapses the blank lines', () => {
    const r = removeCargoDependency(text, 'tabled')
    expect(r.text).not.toContain('tabled')
    expect(r.text).toContain('optional = true }\n\n[features]')
    expect(r.text).toContain('desktop = [\n    "dep:tauri-plugin-mob",\n    "tauri/tray-icon",\n]\n')
    expect(r.text).toContain('both = ["dep:tauri-plugin-mob", "serde/derive"]\n')
  })

  it('leaves a manifest without the dependency alone, and a line whose items all survive', () => {
    expect(removeCargoDependency(text, 'nope')).toEqual({ text, changed: false, removedFeatureItems: [] })
    const two = '[dependencies]\na = { path = "crates/a", optional = true }\n[features]\nf = [\n    "dep:a", "x/y",\n]\n'
    expect(removeCargoDependency(two, 'a').text).toBe('[dependencies]\n[features]\nf = [\n    "x/y",\n]\n')
    const trailing = '[dependencies]\na = { path = "crates/a", optional = true }\n[features]\nf = ["x/y", "dep:a"]\ng = ["dep:a"] # only\n'
    expect(removeCargoDependency(trailing, 'a').text).toBe('[dependencies]\n[features]\nf = ["x/y"]\ng = [] # only\n')
    const commented = '[dependencies]\na = { path = "crates/a", optional = true }\n[features]\nf = [\n    "dep:a", # gone with it\n]\n'
    expect(removeCargoDependency(commented, 'a').text).toBe('[dependencies]\n[features]\nf = [\n]\n')
  })

})

/* ----------------------------------------------------------------- lib.rs */

describe('removePluginRegistration', () => {
  it('cuts a chained line, with its comment run, from the middle of a chain', () => {
    const src = 'fn run() {\n    tauri::Builder::default()\n        .plugin(a::init())\n        // The peer transport.\n        .plugin(tauri_plugin_peer::init())\n        .setup(|_| Ok(()))\n        .run(ctx);\n}\n'
    expect(removePluginRegistration(src, 'tauri_plugin_peer').text).toBe('fn run() {\n    tauri::Builder::default()\n        .plugin(a::init())\n        .setup(|_| Ok(()))\n        .run(ctx);\n}\n')
  })

  it('moves the semicolon up when the cut line ended the chain', () => {
    const src = 'fn run() {\n    builder = builder\n        .plugin(a::init())\n        .plugin(x::init());\n    go(builder);\n}\n'
    expect(removePluginRegistration(src, 'x').text).toBe('fn run() {\n    builder = builder\n        .plugin(a::init());\n    go(builder);\n}\n')
  })

  it('removes the whole statement when the cut leaves `builder = builder;`', () => {
    const chain = 'fn run() {\n    // about x\n    builder = builder\n        .plugin(x::init());\n    go(builder);\n}\n'
    expect(removePluginRegistration(chain, 'x').text).toBe('fn run() {\n    go(builder);\n}\n')
    const inline = 'fn run() {\n    let mut builder = tauri::Builder::default().plugin(a::init());\n    builder = builder.plugin(x::init());\n    go(builder);\n}\n'
    expect(removePluginRegistration(inline, 'x').text).toBe('fn run() {\n    let mut builder = tauri::Builder::default().plugin(a::init());\n    go(builder);\n}\n')
  })

  it('cuts an inline call out of a longer statement', () => {
    const src = 'fn run() {\n    let b = tauri::Builder::default().plugin(x::init()).plugin(a::init());\n}\n'
    expect(removePluginRegistration(src, 'x').text).toBe('fn run() {\n    let b = tauri::Builder::default().plugin(a::init());\n}\n')
  })

  it('takes an emptied bare block with its cfg attributes and comments', () => {
    const src = 'fn run() {\n    let mut builder = b();\n\n    // Desktop only.\n    #[cfg(feature = "desktop")]\n    {\n        builder = builder.plugin(x::init());\n    }\n\n    builder.run();\n}\n'
    expect(removePluginRegistration(src, 'x').text).toBe('fn run() {\n    let mut builder = b();\n\n    builder.run();\n}\n')
  })

  it('refuses a conditional block it would leave empty, a residual reference, and a call with nothing before it', () => {
    const cond = 'fn run() {\n    if flag {\n        builder = builder.plugin(x::init());\n    }\n}\n'
    expect(() => removePluginRegistration(cond, 'x')).toThrow(/leaves the block opened by "if flag \{" empty/)
    const used = 'use x::Thing;\nfn run() {\n    b().plugin(x::init());\n}\n'
    expect(() => removePluginRegistration(used, 'x')).toThrow(/still references x/)
    expect(() => removePluginRegistration('.plugin(x::init());\n', 'x')).toThrow(/nothing before it/)
  })

  it('is a no-op when the crate is not registered, and ignores a commented-out call', () => {
    const src = 'fn run() {\n    // .plugin(x::init())\n    b().run();\n}\n'
    expect(removePluginRegistration(src, 'x')).toEqual({ text: src, changed: false })
  })

})

/* -------------------------------------------------------- the real tree */

/**
 * The real files, data-driven from what they contain — never naming a
 * capability, so this suite stays true inside `pnpm verify:without <id>`,
 * which runs it in a copy with `<id>` already gone. Vacuous only when the
 * tree has no capability at all, and then the shapes are proven above.
 */
describe('the real tree', () => {
  const manifest = JSON.parse(REAL('capabilities.manifest.json'))
  const platforms = ['desktop', 'ios', 'android']

  it('every manifest entry can be cut from every composition that names it, and no other', () => {
    for (const entry of manifest.capabilities) {
      for (const platform of platforms) {
        const source = REAL(`src/app/composition.${platform}.ts`)
        const r = removeFromComposition(source, entry.ts)
        expect(r.changed).toBe(entry.platforms.includes(platform))
        if (!r.changed) continue
        expect(r.text).not.toContain(`/capabilities/${entry.ts}'`)
        expect(r.text).toContain("import type { Capability } from '../kernel'")
        expect(r.text).toMatch(/export const capabilities: readonly Capability\[\] = \[[^\]]*\]\n/)
        for (const other of manifest.capabilities) {
          if (other !== entry && other.platforms.includes(platform)) expect(r.text).toContain(`/capabilities/${other.ts}'`)
        }
      }
    }
  })

  it('every manifest entry can be cut from the manifest, or is refused because another requires it', () => {
    const text = REAL('capabilities.manifest.json')
    for (const entry of manifest.capabilities) {
      const dependents = manifest.capabilities.filter((e) => (e.requires ?? []).includes(entry.id))
      if (dependents.length > 0) {
        expect(() => removeManifestEntry(text, entry.id)).toThrow(RemovalRefused)
        continue
      }
      const r = removeManifestEntry(text, entry.id)
      expect(JSON.parse(r.text)).toEqual({ ...manifest, capabilities: manifest.capabilities.filter((e) => e !== entry) })
      expect(r.text.endsWith('\n')).toBe(true)
    }
    if (manifest.capabilities.length === 1) {
      expect(removeManifestEntry(text, manifest.capabilities[0].id).text).toBe('{\n  "$schema": "./capabilities.manifest.schema.json",\n  "capabilities": []\n}\n')
    }
  })

  it('every namespace granted in the real ACL can be cut on its own', () => {
    const real = REAL('src-tauri/capabilities/default.json')
    const grants = JSON.parse(real).permissions.map((p) => (typeof p === 'string' ? p : p.identifier))
    const namespaces = [...new Set(grants.map((g) => g.split(':')[0]))]
    expect(namespaces.length).toBeGreaterThan(0)
    for (const namespace of namespaces) {
      const r = removeAclGrants(real, namespace)
      expect(r.changed).toBe(true)
      expect(r.removed).toEqual(grants.filter((g) => g.startsWith(`${namespace}:`)))
      const left = JSON.parse(r.text).permissions.map((p) => (typeof p === 'string' ? p : p.identifier))
      expect(left).toEqual(grants.filter((g) => !g.startsWith(`${namespace}:`)))
    }
  })

  it('every crate the app depends on by path can be cut from Cargo.toml with its feature items, and its registration from lib.rs', () => {
    const cargoText = REAL('src-tauri/Cargo.toml')
    const libText = REAL('src-tauri/src/lib.rs')
    const cargo = readCargoManifest(cargoText)
    const crates = [...cargo.dependencies.values()].filter((d) => d.path !== null && /^(\.\/)?crates\//.test(d.path))
    for (const dep of crates) {
      const r = removeCargoDependency(cargoText, dep.name)
      expect(r.changed).toBe(true)
      expect(r.text).not.toContain(dep.name)
      const after = readCargoManifest(r.text)
      expect(after.dependencies.has(dep.name)).toBe(false)
      for (const feature of after.features.values()) {
        for (const item of feature.items) expect(featureItemNames(item, dep.name, cargo)).toBe(false)
      }
      const snake = rustName(dep.name)
      if (!registersPlugin(libText, snake)) continue
      const lib = removePluginRegistration(libText, snake)
      expect(lib.changed).toBe(true)
      expect(stripComments(lib.text)).not.toMatch(new RegExp(`\\b${snake}\\b`))
    }
  })
})
