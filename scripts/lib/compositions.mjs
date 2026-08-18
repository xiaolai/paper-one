import path from 'node:path'
import { PLATFORMS } from './architecture.mjs'
import { dependenciesOfFeature, dependencyForCrate, readCargoManifest, rustName } from './cargo.mjs'

/**
 * The per-platform compositions, as a pure library: which capabilities each
 * platform's composition root imports, whether that agrees with the manifest,
 * whether the Rust side (Cargo features, `.plugin()` registration, the ACL)
 * agrees too, and — for the build — whether a bundle contains exactly the
 * modules its platform's manifest set allows.
 *
 * Three consumers, one rule set:
 *
 *   scripts/check-compositions.mjs   `pnpm compositions:check`, the static gate
 *   scripts/vite/assert-bundle.mjs    the Rollup `generateBundle` assertion
 *   scripts/capability-remove.mjs     reads the same shapes before it edits them
 *
 * Everything here depends on the world only through what it is handed —
 * source text, a manifest object, a list of module ids — so the rules are
 * testable without a tree and the CLI stays a thin shell (the pattern of
 * `architecture.mjs`). Findings are `{ code, where, message }`, one line each.
 */

/* --------------------------------------------------------------- platform */

/**
 * The Vite build's platform, from what the Tauri CLI puts in the
 * environment. `TAURI_ENV_PLATFORM` is the OS component of the target
 * triple (crates/tauri-cli/src/interface/rust.rs, `fn env`): `darwin`,
 * `windows`, `linux` for a desktop build, `ios` for `aarch64-apple-ios` and
 * `-ios-sim`, `android` for `aarch64-linux-android` — and `androideabi` for
 * the 32-bit `armv7-linux-androideabi`, which is still Android. Anything
 * else, including unset (a plain `vite build`), is a desktop build: that is
 * the default composition and the only one that runs without Tauri.
 */
export function platformFromTauriEnv(value) {
  if (value === 'ios') return 'ios'
  if (value === 'android' || value === 'androideabi') return 'android'
  return 'desktop'
}

/** The composition root for a platform, repository-relative, posix. */
export function compositionFile(platform) {
  return `src/app/composition.${platform}.ts`
}

const COMPOSITION_FILE = /^src\/app\/composition\.(desktop|ios|android)\.ts$/
const CAPABILITY_MODULE = /^src\/capabilities\/([^/]+)(?:\/|$)/

/* ------------------------------------------------------------ composition */

/**
 * The capability directories a composition source imports, from its static
 * `import`/`export … from` statements: `../capabilities/<dir>` with or
 * without `/index(.ts)`. Anything deeper (`../capabilities/x/lib/y`) is
 * reported with `deep: true` — the boundary check refuses it too, but a
 * composition that reaches past an index is worth naming here.
 *
 * Also returns `dynamic`: every specifier under `capabilities/` reached
 * through `import(...)`. A composition is STATIC (rule 3 of the plan): a
 * dynamic import of a capability is how runtime filtering starts, so it is
 * a finding, not a style.
 *
 * Comments are stripped first, so a specifier quoted in prose (this file's
 * own comments say `../capabilities/<id>`) is not an import.
 */
export function parseCompositionImports(source) {
  const code = stripComments(source)
  const imports = []
  const dynamic = []
  const seen = new Set()
  const STATIC = /(?:^|\n)\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
  for (const m of code.matchAll(STATIC)) {
    const specifier = m[1] ?? m[2]
    const cap = capabilityDirOf(specifier)
    if (cap === null) continue
    const key = `${cap.dir}|${cap.deep}`
    if (seen.has(key)) continue
    seen.add(key)
    imports.push({ specifier, dir: cap.dir, deep: cap.deep })
  }
  const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const m of code.matchAll(DYNAMIC)) {
    const cap = capabilityDirOf(m[1])
    if (cap !== null) dynamic.push({ specifier: m[1], dir: cap.dir })
  }
  return { imports, dynamic }
}

/** `../capabilities/x`, `../capabilities/x/index`, `../capabilities/x/index.ts`
 *  → `{ dir: 'x', deep: false }`; `../capabilities/x/lib/y` → deep. Anything
 *  not under a `capabilities/` segment → null. */
function capabilityDirOf(specifier) {
  const m = /(?:^|\/)capabilities\/([^/]+)(?:\/(.*))?$/.exec(specifier)
  if (!m) return null
  const rest = m[2] ?? ''
  const deep = !(rest === '' || rest === 'index' || rest === 'index.ts' || rest === 'index.tsx')
  return { dir: m[1], deep }
}

/** Source without `//` and `/* *\/` comments (string contents kept). */
export function stripComments(source) {
  let out = ''
  let i = 0
  let quote = null
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (quote !== null) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      i = end === -1 ? source.length : end
      continue
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      // Newlines inside the comment are kept, so line-anchored patterns and
      // line numbers downstream still mean what they meant.
      const body = end === -1 ? source.slice(i) : source.slice(i, end + 2)
      out += body.replace(/[^\n]/g, '')
      i = end === -1 ? source.length : end + 2
      continue
    }
    out += c
    i++
  }
  return out
}

/* --------------------------------------------------------------- manifest */

/** The manifest's capability ids for a platform, in manifest order. */
export function manifestSet(manifest, platform) {
  return manifest.capabilities.filter((entry) => entry.platforms.includes(platform)).map((entry) => entry.id)
}

/** ts directory → manifest entry. */
export function entriesByDir(manifest) {
  const byDir = new Map()
  for (const entry of manifest.capabilities) byDir.set(entry.ts, entry)
  return byDir
}

/* ------------------------------------------------------------------ check */

export const BUNDLE_CODES = Object.freeze([
  'BUNDLE_UNKNOWN_CAPABILITY',
  'BUNDLE_FOREIGN_CAPABILITY',
  'BUNDLE_FOREIGN_COMPOSITION',
  'BUNDLE_COMPOSITION_ABSENT',
  'BUNDLE_CAPABILITY_ABSENT',
])

/** Every code this module emits: the static check's, then the bundle's. */
export const FINDING_CODES = Object.freeze([
  'COMPOSITION_ABSENT',
  'COMPOSITION_MISSING',
  'COMPOSITION_EXTRA',
  'COMPOSITION_UNKNOWN',
  'COMPOSITION_DEEP',
  'COMPOSITION_DYNAMIC',
  'CARGO_UNREADABLE',
  'CRATE_DEP_ABSENT',
  'CRATE_PLATFORMS_DIFFER',
  'PLUGIN_UNREGISTERED',
  'ACL_UNREADABLE',
  'PERMISSION_UNGRANTED',
  ...BUNDLE_CODES,
])

/** One finding, its message one line. Every code emitted below is listed
 *  in FINDING_CODES; the test suite asserts that by emitting each. */
const finding = (code, where, message) => ({ code, where, message: String(message).replace(/\s+/g, ' ').trim() })

/**
 * The composition side: for each platform, the set of capability ids the
 * composition file imports must equal the manifest's set for that platform.
 * `read(rel)` returns a file's text or null when it does not exist.
 */
export function checkCompositionFiles(manifest, read) {
  const findings = []
  const byDir = entriesByDir(manifest)
  for (const platform of PLATFORMS) {
    const file = compositionFile(platform)
    const source = read(file)
    if (source === null) {
      findings.push(finding('COMPOSITION_ABSENT', file, `${file} does not exist; every platform has a static composition`))
      continue
    }
    const { imports, dynamic } = parseCompositionImports(source)
    const expected = manifestSet(manifest, platform)
    const imported = new Set()
    for (const item of imports) {
      if (item.deep) {
        findings.push(finding('COMPOSITION_DEEP', file, `imports ${JSON.stringify(item.specifier)}: a composition imports a capability's index only`))
        continue
      }
      const entry = byDir.get(item.dir)
      if (!entry) {
        findings.push(finding('COMPOSITION_UNKNOWN', file, `imports src/capabilities/${item.dir}, which has no manifest entry`))
        continue
      }
      imported.add(entry.id)
      if (!entry.platforms.includes(platform)) {
        findings.push(
          finding(
            'COMPOSITION_EXTRA',
            file,
            `imports ${JSON.stringify(entry.id)}, whose manifest platforms are [${entry.platforms.join(', ')}] — not ${platform}`,
          ),
        )
      }
    }
    for (const id of expected) {
      if (!imported.has(id)) {
        findings.push(finding('COMPOSITION_MISSING', file, `does not import ${JSON.stringify(id)}, which the manifest composes on ${platform}`))
      }
    }
    for (const item of dynamic) {
      findings.push(finding('COMPOSITION_DYNAMIC', file, `import(${JSON.stringify(item.specifier)}): a composition is static, never a runtime choice`))
    }
  }
  return findings
}

/**
 * The Rust side, for every manifest entry that names a `crate`: the app
 * crate depends on it by path; the platforms whose features compile that
 * dependency (or every platform, for an unconditional one) equal the entry's
 * `platforms`; `lib.rs` registers `.plugin(<crate>::init())`; and every
 * permission the entry lists is granted by some ACL capability file that
 * applies to each of the entry's platforms.
 *
 * `files` is `{ cargoToml, libRs, acl: [{ file, text }] }`, each text or
 * null when absent. Returns `{ findings, crates }` — `crates` the number of
 * entries the Rust rules were applied to, so the summary can say so.
 */
export function checkRustSurfaces(manifest, files) {
  const findings = []
  const withCrate = manifest.capabilities.filter((entry) => typeof entry.crate === 'string')
  if (withCrate.length === 0) return { findings, crates: 0 }

  let cargo = null
  if (files.cargoToml === null) {
    findings.push(finding('CARGO_UNREADABLE', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.toml does not exist'))
  } else {
    try {
      cargo = readCargoManifest(files.cargoToml)
    } catch (cause) {
      findings.push(finding('CARGO_UNREADABLE', 'src-tauri/Cargo.toml', cause.message))
    }
  }
  const acl = readAcl(files.acl, findings)

  for (const entry of withCrate) {
    const where = `capabilities/${entry.id}`
    if (cargo !== null) {
      const dep = dependencyForCrate(cargo, entry.crate)
      if (dep === null) {
        findings.push(
          finding('CRATE_DEP_ABSENT', where, `src-tauri/Cargo.toml has no [dependencies] entry with path = "crates/${entry.crate}"`),
        )
      } else {
        const compiled = dep.optional
          ? PLATFORMS.filter((p) => dependenciesOfFeature(p, cargo).has(dep.name))
          : [...PLATFORMS]
        const want = PLATFORMS.filter((p) => entry.platforms.includes(p))
        if (compiled.join(',') !== want.join(',')) {
          const how = dep.optional ? `the [features] forward it on [${compiled.join(', ')}]` : 'it is unconditional, so every platform compiles it'
          findings.push(
            finding(
              'CRATE_PLATFORMS_DIFFER',
              where,
              `manifest platforms are [${want.join(', ')}] but ${how}; a platform's feature must enable dep:${dep.name} exactly when the manifest composes the capability there`,
            ),
          )
        }
        if (files.libRs === null) {
          findings.push(finding('PLUGIN_UNREGISTERED', where, 'src-tauri/src/lib.rs does not exist'))
        } else if (!registersPlugin(files.libRs, rustName(dep.name))) {
          findings.push(finding('PLUGIN_UNREGISTERED', where, `src-tauri/src/lib.rs does not call .plugin(${rustName(dep.name)}::init())`))
        }
      }
    }
    for (const permission of entry.permissions ?? []) {
      for (const platform of entry.platforms) {
        if (!acl.grants(permission, platform)) {
          findings.push(
            finding('PERMISSION_UNGRANTED', where, `permission ${JSON.stringify(permission)} is not granted for ${platform} by any src-tauri/capabilities/*.json`),
          )
        }
      }
    }
  }
  return { findings, crates: withCrate.length }
}

/** `.plugin(<name>::init())`, whitespace-tolerant, outside comments. */
export function registersPlugin(libRs, name) {
  const code = stripComments(libRs)
  return new RegExp(`\\.plugin\\(\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}::init\\(\\)\\s*\\)`).test(code)
}

/**
 * Tauri capability files name platforms as `macOS`, `windows`, `linux`,
 * `iOS`, `android`; a file without the key applies everywhere. Our closed
 * set folds the three desktop OSes into `desktop`: a file that names any of
 * them grants for desktop. Finer than that this check does not go.
 */
const TAURI_PLATFORMS = { desktop: ['macOS', 'windows', 'linux'], ios: ['iOS'], android: ['android'] }

function readAcl(files, findings) {
  const grants = [] // { identifier, platforms: null | Set }
  for (const { file, text } of files) {
    let json
    try {
      json = JSON.parse(text)
    } catch (cause) {
      findings.push(finding('ACL_UNREADABLE', file, `${file} is not valid JSON: ${cause.message}`))
      continue
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      findings.push(finding('ACL_UNREADABLE', file, `${file} is not a JSON object`))
      continue
    }
    const platforms = Array.isArray(json.platforms) ? new Set(json.platforms.map(String)) : null
    for (const item of Array.isArray(json.permissions) ? json.permissions : []) {
      const identifier = typeof item === 'string' ? item : item && typeof item.identifier === 'string' ? item.identifier : null
      if (identifier !== null) grants.push({ identifier, platforms })
    }
  }
  return {
    grants: (identifier, platform) =>
      grants.some(
        (g) => g.identifier === identifier && (g.platforms === null || TAURI_PLATFORMS[platform].some((name) => g.platforms.has(name))),
      ),
  }
}

/* ----------------------------------------------------------------- bundle */

/**
 * The bundle assertion: over the module ids of every chunk a build emitted,
 * decide whether the bundle is exactly its platform's.
 *
 *   platform   'desktop' | 'ios' | 'android' — the build's
 *   moduleIds  every id from every chunk's `moduleIds` (Rollup absolute ids;
 *              `\0`-prefixed virtual ids and `?query` suffixes are handled)
 *   manifest   the parsed, validated manifest
 *   roots      the build root(s), absolute — usually one, or two when the
 *              configured root and its realpath differ (a symlinked tmpdir)
 *
 * Returns `{ ok, findings, capabilities, modules }`: `capabilities` the ids
 * of the manifest entries whose modules are in the bundle (manifest order),
 * `modules` how many modules under `src/capabilities/` were seen. A finding
 * for: a module under `src/capabilities/<dir>` with no manifest entry; one
 * whose entry does not list this platform; another platform's composition
 * file; this platform's composition file absent (the build resolved the
 * wrong thing, so nothing else here would mean anything); and a capability
 * the manifest composes on this platform with no module in the bundle.
 */
export function decideBundle(platform, moduleIds, manifest, roots) {
  const findings = []
  const byDir = entriesByDir(manifest)
  const present = new Set()
  let modules = 0
  let compositionSeen = false
  const prefixes = [...new Set(roots.map((r) => `${path.posix.normalize(toPosix(r)).replace(/\/+$/, '')}/`))]

  for (const raw of moduleIds) {
    if (typeof raw !== 'string' || raw.startsWith('\0')) continue
    const id = toPosix(raw).replace(/[?#].*$/, '')
    const prefix = prefixes.find((p) => id.startsWith(p))
    if (prefix === undefined) continue
    const rel = id.slice(prefix.length)
    const cap = CAPABILITY_MODULE.exec(rel)
    if (cap) {
      modules++
      const entry = byDir.get(cap[1])
      if (!entry) {
        findings.push(finding('BUNDLE_UNKNOWN_CAPABILITY', rel, `${rel} is in the ${platform} bundle but src/capabilities/${cap[1]} has no manifest entry`))
      } else if (!entry.platforms.includes(platform)) {
        findings.push(
          finding(
            'BUNDLE_FOREIGN_CAPABILITY',
            rel,
            `${rel} is in the ${platform} bundle but capability ${JSON.stringify(entry.id)} is composed on [${entry.platforms.join(', ')}] only`,
          ),
        )
      } else {
        present.add(entry.id)
      }
      continue
    }
    const comp = COMPOSITION_FILE.exec(rel)
    if (comp) {
      if (comp[1] === platform) compositionSeen = true
      else findings.push(finding('BUNDLE_FOREIGN_COMPOSITION', rel, `${rel} is in the ${platform} bundle; only ${compositionFile(platform)} may be`))
    }
  }
  if (!compositionSeen) {
    findings.push(
      finding('BUNDLE_COMPOSITION_ABSENT', compositionFile(platform), `${compositionFile(platform)} is not in the ${platform} bundle — the build did not resolve this platform's composition`),
    )
  }
  const capabilities = []
  for (const id of manifestSet(manifest, platform)) {
    if (present.has(id)) capabilities.push(id)
    else findings.push(finding('BUNDLE_CAPABILITY_ABSENT', `capabilities/${id}`, `capability ${JSON.stringify(id)} is composed on ${platform} by the manifest but no module of it is in the bundle`))
  }
  return { ok: findings.length === 0, findings, capabilities, modules }
}

/** The one-line summary a green build prints. */
export function bundleSummary(platform, decision) {
  return `assert-bundle: ${platform}: ${decision.modules} capability modules from {${decision.capabilities.join(', ')}}`
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/')
}

export function formatFinding(f) {
  return `${f.code} ${f.where}: ${f.message}`
}
