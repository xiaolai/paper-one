import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readCargoManifest, rustName } from './cargo.mjs'
import {
  BUNDLE_CODES,
  FINDING_CODES,
  bundleSummary,
  checkCompositionFiles,
  checkRustSurfaces,
  compositionFile,
  decideBundle,
  entriesByDir,
  formatFinding,
  manifestSet,
  parseCompositionImports,
  platformFromTauriEnv,
  registersPlugin,
  stripComments,
} from './compositions.mjs'

/**
 * The composition rules, one by one, over sources and manifests handed in:
 * the platform choice from Tauri's environment, what counts as a
 * capability import, each finding of the static check, each finding of the
 * bundle assertion, and — at the end — that the real tree's composition
 * files pass the same rules against the real manifest.
 */

const manifest = (capabilities) => ({ capabilities })
const cap = (id, platforms, over = {}) => ({ id, ts: id, platforms, ...over })
const codes = (findings) => findings.map((f) => f.code)

/* --------------------------------------------------------------- platform */

describe('platformFromTauriEnv', () => {
  it('maps the OS component of the target triple, and everything else to desktop', () => {
    expect(platformFromTauriEnv('ios')).toBe('ios')
    expect(platformFromTauriEnv('android')).toBe('android')
    expect(platformFromTauriEnv('androideabi')).toBe('android')
    for (const value of ['darwin', 'windows', 'linux', 'freebsd', '', undefined, 'IOS']) {
      expect(platformFromTauriEnv(value)).toBe('desktop')
    }
  })

  it('names the composition file for a platform', () => {
    expect(compositionFile('ios')).toBe('src/app/composition.ios.ts')
  })
})

/* ------------------------------------------------------------ composition */

describe('parseCompositionImports', () => {
  it('reads every static form that names a capability, once per directory', () => {
    const source = [
      "import type { Capability } from '../kernel'",
      "import { a } from '../capabilities/alpha'",
      "import beta, { type B } from '../capabilities/beta/index'",
      "import * as gamma from '../capabilities/gamma/index.ts'",
      "export { d } from '../capabilities/delta/index.tsx'",
      "import '../capabilities/side-effect'",
      "import { a as again } from '../capabilities/alpha'",
      "import { deep } from '../capabilities/epsilon/lib/deep'",
      "import { App } from '../kernel/ui'",
      'export const capabilities = [a, beta, gamma]',
    ].join('\n')
    const { imports, dynamic } = parseCompositionImports(source)
    expect(imports).toEqual([
      { specifier: '../capabilities/alpha', dir: 'alpha', deep: false },
      { specifier: '../capabilities/beta/index', dir: 'beta', deep: false },
      { specifier: '../capabilities/gamma/index.ts', dir: 'gamma', deep: false },
      { specifier: '../capabilities/delta/index.tsx', dir: 'delta', deep: false },
      { specifier: '../capabilities/side-effect', dir: 'side-effect', deep: false },
      { specifier: '../capabilities/epsilon/lib/deep', dir: 'epsilon', deep: true },
    ])
    expect(dynamic).toEqual([])
  })

  it('reports a dynamic import of a capability, and ignores specifiers in comments and strings', () => {
    const source = [
      "// import { x } from '../capabilities/commented'",
      '/* import { y } from "../capabilities/blocked" */',
      "const label = 'see ../capabilities/in-a-string'",
      "export const load = () => import('../capabilities/lazy')",
      "export const other = () => import( \"../capabilities/lazy2/index\" )",
    ].join('\n')
    const { imports, dynamic } = parseCompositionImports(source)
    expect(imports).toEqual([])
    expect(dynamic).toEqual([
      { specifier: '../capabilities/lazy', dir: 'lazy' },
      { specifier: '../capabilities/lazy2/index', dir: 'lazy2' },
    ])
  })

  it("reads the real compositions: each imports exactly its platform's manifest directories, statically", () => {
    const real = JSON.parse(readFileSync(new URL('../../capabilities.manifest.json', import.meta.url), 'utf8'))
    for (const platform of ['desktop', 'ios', 'android']) {
      const source = readFileSync(new URL(`../../${compositionFile(platform)}`, import.meta.url), 'utf8')
      const { imports, dynamic } = parseCompositionImports(source)
      expect(imports.map((i) => i.dir).sort()).toEqual(real.capabilities.filter((c) => c.platforms.includes(platform)).map((c) => c.ts).sort())
      expect(imports.every((i) => !i.deep && i.specifier === `../capabilities/${i.dir}`)).toBe(true)
      expect(dynamic).toEqual([])
    }
  })
})

describe('stripComments', () => {
  it('removes line and block comments, keeps strings and newline count', () => {
    const source = "const a = '// not' // gone\n/* multi\nline */ const b = `/* tpl */`\nconst c = \"x\\\"y // z\"\n"
    const out = stripComments(source)
    expect(out).toBe("const a = '// not' \n\n const b = `/* tpl */`\nconst c = \"x\\\"y // z\"\n")
    expect(out.split('\n').length).toBe(source.split('\n').length)
  })

  it('survives an unterminated block comment and a trailing line comment', () => {
    expect(stripComments('a /* open')).toBe('a ')
    expect(stripComments('a // end')).toBe('a ')
    expect(stripComments("'\\")).toBe("'\\")
  })
})

/* --------------------------------------------------------------- manifest */

describe('manifestSet / entriesByDir', () => {
  const m = manifest([cap('a', ['desktop', 'ios']), cap('b', ['ios'], { ts: 'b-dir' }), cap('c', ['android'])])
  it('lists ids per platform in manifest order and maps ts dirs to entries', () => {
    expect(manifestSet(m, 'ios')).toEqual(['a', 'b'])
    expect(manifestSet(m, 'desktop')).toEqual(['a'])
    expect(manifestSet(m, 'android')).toEqual(['c'])
    expect(entriesByDir(m).get('b-dir').id).toBe('b')
    expect(entriesByDir(m).has('b')).toBe(false)
  })
})

/* ------------------------------------------------------ composition files */

describe('checkCompositionFiles', () => {
  const files = (over) => {
    const base = {
      'src/app/composition.desktop.ts': "import { a } from '../capabilities/a'\nexport const capabilities = [a]\n",
      'src/app/composition.ios.ts': "import { a } from '../capabilities/a'\nimport { b } from '../capabilities/b'\nexport const capabilities = [a, b]\n",
      'src/app/composition.android.ts': 'export const capabilities = []\n',
      ...over,
    }
    return (rel) => base[rel] ?? null
  }
  const m = manifest([cap('a', ['desktop', 'ios']), cap('b', ['ios'])])

  it('is clean when every composition imports exactly its manifest set', () => {
    expect(checkCompositionFiles(m, files())).toEqual([])
  })

  it('COMPOSITION_ABSENT when a platform has no file', () => {
    const findings = checkCompositionFiles(m, files({ 'src/app/composition.android.ts': null }))
    expect(findings).toEqual([{ code: 'COMPOSITION_ABSENT', where: 'src/app/composition.android.ts', message: expect.stringContaining('does not exist') }])
  })

  it('COMPOSITION_MISSING when a manifest capability is not imported', () => {
    const findings = checkCompositionFiles(m, files({ 'src/app/composition.ios.ts': "import { a } from '../capabilities/a'\nexport const capabilities = [a]\n" }))
    expect(codes(findings)).toEqual(['COMPOSITION_MISSING'])
    expect(findings[0].message).toContain('"b"')
    expect(findings[0].where).toBe('src/app/composition.ios.ts')
  })

  it('COMPOSITION_EXTRA when a composition imports a capability not composed on its platform', () => {
    const findings = checkCompositionFiles(m, files({ 'src/app/composition.android.ts': "import { b } from '../capabilities/b'\nexport const capabilities = [b]\n" }))
    expect(codes(findings)).toEqual(['COMPOSITION_EXTRA'])
    expect(findings[0].message).toContain('[ios]')
  })

  it('COMPOSITION_UNKNOWN when it imports a directory with no manifest entry', () => {
    const findings = checkCompositionFiles(m, files({ 'src/app/composition.android.ts': "import { z } from '../capabilities/zeta'\nexport const capabilities = [z]\n" }))
    expect(codes(findings)).toEqual(['COMPOSITION_UNKNOWN'])
    expect(findings[0].message).toContain('src/capabilities/zeta')
  })

  it('COMPOSITION_DEEP and COMPOSITION_DYNAMIC name the specifier', () => {
    const findings = checkCompositionFiles(
      m,
      files({
        'src/app/composition.android.ts': "import { h } from '../capabilities/a/lib/helper'\nexport const load = () => import('../capabilities/b')\nexport const capabilities = []\n",
      }),
    )
    expect(codes(findings)).toEqual(['COMPOSITION_DEEP', 'COMPOSITION_DYNAMIC'])
    expect(findings[0].message).toContain('"../capabilities/a/lib/helper"')
    expect(findings[1].message).toContain('import("../capabilities/b")')
  })

  it('the real compositions pass against the real manifest', () => {
    const real = JSON.parse(readFileSync(new URL('../../capabilities.manifest.json', import.meta.url), 'utf8'))
    const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
    expect(checkCompositionFiles(real, read)).toEqual([])
  })
})

/* ---------------------------------------------------------- Rust surfaces */

describe('checkRustSurfaces', () => {
  const cargo = [
    '[dependencies]',
    'tauri = "2"',
    'tauri-plugin-peer = { path = "crates/tauri-plugin-peer" }',
    'tauri-plugin-mob = { path = "crates/tauri-plugin-mob", optional = true }',
    '[features]',
    'default = ["desktop"]',
    'desktop = []',
    'ios = ["dep:tauri-plugin-mob"]',
    'android = ["mobile-shared"]',
    'mobile-shared = ["tauri-plugin-mob/x"]',
  ].join('\n')
  const lib = 'pub fn run() {\n  tauri::Builder::default()\n    .plugin(tauri_plugin_peer::init())\n    // .plugin(tauri_plugin_ghost::init())\n    .plugin( tauri_plugin_mob::init() )\n    .run()\n}\n'
  const acl = [
    { file: 'src-tauri/capabilities/default.json', text: JSON.stringify({ permissions: ['core:default', 'peer:default', { identifier: 'mob:allow-x' }, 7, { nope: 1 }] }) },
    { file: 'src-tauri/capabilities/ios.json', text: JSON.stringify({ platforms: ['iOS'], permissions: ['mob:ios-only'] }) },
    { file: 'src-tauri/capabilities/desk.json', text: JSON.stringify({ platforms: ['macOS'], permissions: ['peer:desk'] }) },
  ]
  const peer = cap('peer', ['desktop', 'ios', 'android'], { crate: 'tauri-plugin-peer', plugin: 'peer', permissions: ['peer:default'] })
  const mob = cap('mob', ['ios', 'android'], { crate: 'tauri-plugin-mob', permissions: ['mob:allow-x'] })
  const files = (over = {}) => ({ cargoToml: cargo, libRs: lib, acl, ...over })

  it('applies no Rust rule when no entry has a crate', () => {
    expect(checkRustSurfaces(manifest([cap('a', ['desktop'])]), files({ cargoToml: null, libRs: null, acl: [] }))).toEqual({ findings: [], crates: 0 })
  })

  it('is clean for an unconditional crate on every platform and an optional one forwarded exactly where composed', () => {
    const { findings, crates } = checkRustSurfaces(manifest([peer, mob]), files())
    expect(findings).toEqual([])
    expect(crates).toBe(2)
  })

  it('CARGO_UNREADABLE when Cargo.toml is absent or cannot be read', () => {
    expect(codes(checkRustSurfaces(manifest([peer]), files({ cargoToml: null })).findings)).toEqual(['CARGO_UNREADABLE'])
    const bad = checkRustSurfaces(manifest([peer]), files({ cargoToml: '[dependencies]\njunk\n' })).findings
    expect(codes(bad)).toEqual(['CARGO_UNREADABLE'])
    expect(bad[0].message).toContain('line 2')
  })

  it('CRATE_DEP_ABSENT when nothing depends on the crate by path', () => {
    const findings = checkRustSurfaces(manifest([cap('x', ['desktop'], { crate: 'tauri-plugin-x' })]), files()).findings
    expect(codes(findings)).toEqual(['CRATE_DEP_ABSENT'])
    expect(findings[0].where).toBe('capabilities/x')
    expect(findings[0].message).toContain('path = "crates/tauri-plugin-x"')
  })

  it('CRATE_PLATFORMS_DIFFER for an unconditional crate the manifest composes on fewer platforms', () => {
    const findings = checkRustSurfaces(manifest([{ ...peer, platforms: ['ios'] }]), files()).findings
    expect(codes(findings)).toEqual(['CRATE_PLATFORMS_DIFFER'])
    expect(findings[0].message).toContain('unconditional')
    expect(findings[0].message).toContain('[ios]')
  })

  it('CRATE_PLATFORMS_DIFFER for an optional crate whose features forward it elsewhere', () => {
    const findings = checkRustSurfaces(manifest([{ ...mob, platforms: ['desktop', 'ios'] }]), files()).findings
    expect(codes(findings)).toEqual(['CRATE_PLATFORMS_DIFFER'])
    expect(findings[0].message).toContain('forward it on [ios, android]')
    expect(findings[0].message).toContain('dep:tauri-plugin-mob')
  })

  it('PLUGIN_UNREGISTERED when lib.rs is absent or does not call .plugin(<crate>::init()) outside a comment', () => {
    expect(codes(checkRustSurfaces(manifest([peer]), files({ libRs: null })).findings)).toEqual(['PLUGIN_UNREGISTERED'])
    const ghost = cap('ghost', ['desktop', 'ios', 'android'], { crate: 'tauri-plugin-ghost' })
    const findings = checkRustSurfaces(manifest([ghost]), files({ cargoToml: `[dependencies]\ntauri-plugin-ghost = { path = "crates/tauri-plugin-ghost" }\n` })).findings
    expect(codes(findings)).toEqual(['PLUGIN_UNREGISTERED'])
    expect(findings[0].message).toContain('.plugin(tauri_plugin_ghost::init())')
  })

  it('PERMISSION_UNGRANTED per platform: a grant scoped to one Tauri platform does not cover another', () => {
    const scoped = cap('mob', ['ios', 'android'], { crate: 'tauri-plugin-mob', permissions: ['mob:ios-only'] })
    const findings = checkRustSurfaces(manifest([scoped]), files()).findings
    expect(codes(findings)).toEqual(['PERMISSION_UNGRANTED'])
    expect(findings[0].message).toContain('"mob:ios-only"')
    expect(findings[0].message).toContain('for android')
    const desk = { ...peer, permissions: ['peer:desk'] }
    expect(codes(checkRustSurfaces(manifest([desk]), files()).findings)).toEqual(['PERMISSION_UNGRANTED', 'PERMISSION_UNGRANTED'])
    // Scoped to macOS: granted for desktop (and, the crate being unconditional, only the platform set differs).
    expect(codes(checkRustSurfaces(manifest([{ ...desk, platforms: ['desktop'] }]), files()).findings)).toEqual(['CRATE_PLATFORMS_DIFFER'])
  })

  it('ACL_UNREADABLE for a capability file that is not JSON or not an object, and goes on', () => {
    const findings = checkRustSurfaces(
      manifest([peer]),
      files({ acl: [{ file: 'src-tauri/capabilities/bad.json', text: '{' }, { file: 'src-tauri/capabilities/arr.json', text: '[]' }, ...acl] }),
    ).findings
    expect(codes(findings)).toEqual(['ACL_UNREADABLE', 'ACL_UNREADABLE'])
    expect(findings[0].where).toBe('src-tauri/capabilities/bad.json')
    expect(findings[1].message).toContain('not a JSON object')
  })

  it('registersPlugin is whitespace-tolerant and comment-blind', () => {
    expect(registersPlugin(lib, 'tauri_plugin_peer')).toBe(true)
    expect(registersPlugin(lib, 'tauri_plugin_mob')).toBe(true)
    expect(registersPlugin(lib, 'tauri_plugin_ghost')).toBe(false)
    expect(registersPlugin('', 'tauri_plugin_peer')).toBe(false)
  })

  it('the real lib.rs registers every crate the real Cargo.toml depends on by path', () => {
    const cargo = readCargoManifest(readFileSync(new URL('../../src-tauri/Cargo.toml', import.meta.url), 'utf8'))
    const libRs = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8')
    for (const dep of cargo.dependencies.values()) {
      if (dep.path !== null && dep.path.includes('crates/')) expect(registersPlugin(libRs, rustName(dep.name))).toBe(true)
    }
    expect(registersPlugin(libRs, 'tauri_plugin_fs')).toBe(true)
  })
})

/* ----------------------------------------------------------------- bundle */

describe('decideBundle', () => {
  const root = '/repo'
  const m = manifest([cap('example', ['desktop', 'ios', 'android']), cap('desk', ['desktop'], { ts: 'desk-dir' })])
  const ids = (...rel) => rel.map((r) => `${root}/${r}`)
  const legalIos = ids('src/main.tsx', 'src/app/composition.ios.ts', 'src/capabilities/example/index.ts', 'src/capabilities/example/ui/Pane.tsx', 'src/kernel/index.ts', 'node_modules/react/index.js')

  it('passes a legal set and reports what it saw', () => {
    const d = decideBundle('ios', [...legalIos, '\0virtual', `${root}/src/capabilities/example/index.ts?used`, `${root}/src/kernel/ui/x.css?inline`], m, [root])
    expect(d).toEqual({ ok: true, findings: [], capabilities: ['example'], modules: 3 })
    expect(bundleSummary('ios', d)).toBe('assert-bundle: ios: 3 capability modules from {example}')
  })

  it('passes a desktop bundle that holds both desktop capabilities', () => {
    const d = decideBundle('desktop', ids('src/app/composition.desktop.ts', 'src/capabilities/example/index.ts', 'src/capabilities/desk-dir/index.ts'), m, [root])
    expect(d.ok).toBe(true)
    expect(d.capabilities).toEqual(['example', 'desk'])
  })

  it('BUNDLE_FOREIGN_CAPABILITY names the module and the platforms it is composed on', () => {
    const d = decideBundle('ios', [...legalIos, `${root}/src/capabilities/desk-dir/lib/thing.ts`], m, [root])
    expect(d.ok).toBe(false)
    expect(d.findings).toEqual([
      {
        code: 'BUNDLE_FOREIGN_CAPABILITY',
        where: 'src/capabilities/desk-dir/lib/thing.ts',
        message: 'src/capabilities/desk-dir/lib/thing.ts is in the ios bundle but capability "desk" is composed on [desktop] only',
      },
    ])
  })

  it('BUNDLE_UNKNOWN_CAPABILITY for a module under a directory with no manifest entry', () => {
    const d = decideBundle('ios', [...legalIos, `${root}/src/capabilities/peer/lib/envelope.ts`], m, [root])
    expect(codes(d.findings)).toEqual(['BUNDLE_UNKNOWN_CAPABILITY'])
    expect(d.findings[0].message).toContain('src/capabilities/peer has no manifest entry')
  })

  it("BUNDLE_FOREIGN_COMPOSITION for another platform's composition file", () => {
    const d = decideBundle('ios', [...legalIos, `${root}/src/app/composition.android.ts`], m, [root])
    expect(codes(d.findings)).toEqual(['BUNDLE_FOREIGN_COMPOSITION'])
    expect(d.findings[0].where).toBe('src/app/composition.android.ts')
  })

  it("BUNDLE_COMPOSITION_ABSENT when the platform's own composition is missing", () => {
    const d = decideBundle('ios', ids('src/main.tsx', 'src/capabilities/example/index.ts'), m, [root])
    expect(codes(d.findings)).toEqual(['BUNDLE_COMPOSITION_ABSENT'])
    expect(d.findings[0].message).toContain('did not resolve')
  })

  it('BUNDLE_CAPABILITY_ABSENT when a composed capability has no module in the bundle', () => {
    const d = decideBundle('desktop', ids('src/app/composition.desktop.ts', 'src/capabilities/example/index.ts'), m, [root])
    expect(codes(d.findings)).toEqual(['BUNDLE_CAPABILITY_ABSENT'])
    expect(d.findings[0].message).toContain('"desk"')
    expect(d.capabilities).toEqual(['example'])
  })

  it('an empty manifest set is a legal empty bundle', () => {
    const d = decideBundle('android', ids('src/app/composition.android.ts', 'src/main.tsx'), manifest([]), [root])
    expect(d).toEqual({ ok: true, findings: [], capabilities: [], modules: 0 })
    expect(bundleSummary('android', d)).toBe('assert-bundle: android: 0 capability modules from {}')
  })

  it('accepts modules under any of the roots given, with backslashes and trailing slashes normalised', () => {
    const d = decideBundle('ios', ['/private/repo/src/app/composition.ios.ts', 'C:\\other\\src\\capabilities\\example\\index.ts'], m, ['/repo/', '/private/repo', 'C:/other/'])
    expect(d.ok).toBe(true)
    expect(d.capabilities).toEqual(['example'])
    expect(decideBundle('ios', [42, null], m, [root]).findings.map((f) => f.code)).toEqual(['BUNDLE_COMPOSITION_ABSENT', 'BUNDLE_CAPABILITY_ABSENT'])
  })

  it('formats a finding as one line', () => {
    expect(formatFinding({ code: 'X', where: 'w', message: 'm' })).toBe('X w: m')
  })
})

describe('the finding codes', () => {
  it('list every code the module emits, bundle codes included, without repeats', () => {
    expect(new Set(FINDING_CODES).size).toBe(FINDING_CODES.length)
    for (const code of BUNDLE_CODES) expect(FINDING_CODES).toContain(code)
    const source = readFileSync(new URL('./compositions.mjs', import.meta.url), 'utf8')
    const emitted = new Set([...source.matchAll(/finding\(\s*'([A-Z_]+)'/g)].map((m) => m[1]))
    expect([...emitted].sort()).toEqual([...FINDING_CODES].sort())
  })
})
