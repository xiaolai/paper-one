import path from 'node:path'
import { NATIVE_PLATFORMS, PLATFORMS, namespaceOf } from './architecture.mjs'
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
  /* `web` IS NOT A TAURI TARGET, so the Tauri CLI never sets this to it. The
   * browser-client build sets it by hand — `pnpm build:web` — exactly as
   * `build:ios` does, and the value is honoured here rather than being made a
   * special case in the plugin. Everything else, including unset, is a desktop
   * build; that default is load-bearing for `pnpm dev`. */
  if (value === 'web') return 'web'
  return 'desktop'
}

/** The composition root for a platform, repository-relative, posix. */
export function compositionFile(platform) {
  return `src/app/composition.${platform}.ts`
}

const COMPOSITION_FILE = new RegExp(`^src/app/composition\\.(${PLATFORMS.join('|')})\\.ts$`)
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
 * own comments say `../capabilities/<id>`) is not an import. Template
 * literals are blanked for the same reason — see `maskTemplates` — and
 * type-only imports do not count: `import type` puts nothing in the bundle,
 * so a composition wired only in types is a composition wired to nothing.
 */
/**
 * Blank a template literal's contents, keeping the backticks and every
 * newline. The scanners below read code with REGEXES, and a template is the
 * one string that spans lines — so an `export const capabilities = […]` or a
 * whole fake composition QUOTED in one read as the real thing. The ordinary
 * quoted strings stay: import specifiers live in them, and being
 * line-bounded they cannot host the multi-line shapes the anchored regexes
 * match. (An `${…}` holding a nested backtick would end the blanking early —
 * none of the composition files has one, and the failure direction is a
 * loud false finding, not a silent pass.)
 */
export function maskTemplates(code) {
  return code.replace(/`(?:[^`\\]|\\[\s\S])*`/g, (tpl) => tpl.replace(/[^\n`]/g, ' '))
}

export function parseCompositionImports(source) {
  const code = maskTemplates(stripComments(source))
  const imports = []
  const dynamic = []
  const seen = new Set()
  const STATIC = /(?:^|\n)\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
  for (const m of code.matchAll(STATIC)) {
    if (/^\s*(?:import|export)\s+type\b/.test(m[0].replace(/^\n/, ''))) continue
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

/**
 * The local binding each capability index is imported under, by ts directory:
 * `import { sync } from '../capabilities/sync'` → `sync → 'sync'`, and
 * `import { peer as p } from '…/peer'` → `peer → 'p'`. Only non-deep capability
 * imports; comments stripped first. This is what the exported `capabilities`
 * array must list, so a name renamed at import is still matched by its binding.
 */
export function capabilityBindings(source) {
  const code = maskTemplates(stripComments(source))
  const byDir = new Map()
  const RE = /\bimport\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
  for (const m of code.matchAll(RE)) {
    /* `import type { sync }` binds a TYPE: nothing reaches the bundle, so it
     * must not satisfy the wiring check a runtime import exists for. */
    if (m[1] !== undefined) continue
    const cap = capabilityDirOf(m[3])
    if (cap === null || cap.deep) continue
    /* EVERY binding, not the last: `import { capability, helper }` bound the
     * directory to `helper`, and the order check then demanded the wrong
     * identifier in the array. */
    const names = byDir.get(cap.dir) ?? new Set()
    for (const raw of m[2].split(',')) {
      const name = raw.trim()
      if (name === '') continue
      const as = /^[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(name)
      const bare = /^([A-Za-z_$][\w$]*)$/.exec(name)
      if (as) names.add(as[1])
      else if (bare) names.add(bare[1])
    }
    if (names.size > 0) byDir.set(cap.dir, names)
  }
  return byDir
}

/**
 * The exported `capabilities` list, PARSED — a static composition is an array
 * LITERAL of bare capability identifiers, never a computed expression. Returns
 * `{ literal, ids, reason? }`: `all.filter(...)`, `[...base, x]`, a conditional
 * or a function call are `literal: false` with a reason. Comments stripped, so
 * a bracket in prose is not the array. The type annotation's `Capability[]`
 * carries no `=`, so anchoring on `= [` skips it.
 */
export function parseCompositionExport(source) {
  const code = maskTemplates(stripComments(source))
  const m = /export\s+const\s+capabilities\b[^=]*=\s*\[([^\]]*)\]/.exec(code)
  if (!m) {
    return { literal: false, ids: [], reason: '`export const capabilities` is not an array literal — a composition is a static list, not a computed one' }
  }
  const rest = code.slice(m.index + m[0].length)
  const trailing = (/^[^\n;]*/.exec(rest)?.[0] ?? '').trim()
  if (trailing !== '') {
    return { literal: false, ids: [], reason: `the capabilities array is followed by ${JSON.stringify(trailing)} — it must be a plain array literal, not a computed expression` }
  }
  /* Across LINES too: `[a, b]\n  .reverse()` put the continuation past the
   * old same-line check, and the registration order silently stopped being
   * the literal's. Anything that can continue the expression refuses. */
  const continuation = /^\s*(\?\.|!\.|&&|\|\||\?\?|===|!==|==|!=|<=|>=|(?:as|satisfies|in|instanceof)\b|[.([\`+\-*/&|?=<>%^])/.exec(rest)
  if (continuation) {
    return { literal: false, ids: [], reason: `the capabilities array is continued by ${JSON.stringify(continuation[1])} on a following line — it must be a plain array literal, not a computed expression` }
  }
  const ids = []
  for (const raw of m[1].split(',')) {
    const part = raw.trim()
    if (part === '') continue
    if (!/^[A-Za-z_$][\w$]*$/.test(part)) {
      return { literal: false, ids: [], reason: `the capabilities array contains ${JSON.stringify(part)}, not a bare capability identifier — no spreads, calls or computed members` }
    }
    ids.push(part)
  }
  return { literal: true, ids }
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
  'COMPOSITION_EXPORT',
  'CARGO_UNREADABLE',
  'CRATE_DEP_ABSENT',
  'CRATE_PLATFORMS_DIFFER',
  'PLUGIN_UNREGISTERED',
  'ACL_UNREADABLE',
  'PERMISSION_UNGRANTED',
  'GRANT_UNCOMPILED',
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
    const before = findings.length
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
    /* The exported list itself must be a static array literal of exactly the
     * imported capabilities, in manifest order — matching the imports is not
     * enough if the export is `all.filter(...)` or a reordered/computed list,
     * which the module graph and the bundle still see as all modules. The
     * order comparison runs only when the imports for this file were clean, so
     * a bad import is reported once, not echoed here. Literal-ness is always
     * checked, since it is independent of the imports. */
    const exp = parseCompositionExport(source)
    if (!exp.literal) {
      findings.push(finding('COMPOSITION_EXPORT', file, exp.reason))
    } else if (findings.length === before) {
      const bindings = capabilityBindings(source)
      const ordered = manifest.capabilities.filter((entry) => imported.has(entry.id))
      /* Each position must hold ONE OF the directory's bindings — an import
       * clause may bind several names (`{ capability, helper }`), and any of
       * them can be the value the array lists. */
      const matches =
        exp.ids.length === ordered.length && exp.ids.every((id, k) => bindings.get(ordered[k].ts)?.has(id) === true)
      if (!matches) {
        const want = ordered.map((entry) => [...(bindings.get(entry.ts) ?? [])].join('|') || '?')
        findings.push(
          finding(
            'COMPOSITION_EXPORT',
            file,
            `the capabilities array is [${exp.ids.join(', ')}] but must be [${want.join(', ')}] — the imported capabilities, in manifest order`,
          ),
        )
      }
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
  const withPermissions = manifest.capabilities.filter((entry) => (entry.permissions ?? []).length > 0)

  /* The ACL half runs for EVERY entry that lists permissions — a capability
   * whose plugin comes from a registry (no local `crate`) still needs its
   * grants, and the old crate-only loop skipped it entirely.
   *
   * AND THE FILES ARE READ WHETHER OR NOT ANY ENTRY LISTS PERMISSIONS. The
   * inverse rule below is about grants the ACL makes, not grants the manifest
   * asks for: an entry with `permissions: []` and a stray `inf:allow-x` in a
   * platform-less file is still a build tauri-build refuses on the phones.
   * Gating the read on `withPermissions` skipped that case entirely — the
   * test that spells the grant differently found it. */
  const acl = readAcl(files.acl, findings)
  for (const entry of withPermissions) {
    const where = `capabilities/${entry.id}`
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
  findings.push(...uncompiledGrants(manifest, acl.grantList))
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

  for (const entry of withCrate) {
    const where = `capabilities/${entry.id}`
    if (cargo !== null) {
      const dep = dependencyForCrate(cargo, entry.crate)
      if (dep === null) {
        findings.push(
          finding('CRATE_DEP_ABSENT', where, `src-tauri/Cargo.toml has no [dependencies] entry with path = "crates/${entry.crate}"`),
        )
      } else {
        /* NATIVE platforms only, on both sides of the comparison.
         *
         * A crate is compiled by a Cargo feature, and `web` has none because
         * the browser client compiles no Rust at all. Comparing against every
         * platform made an UNCONDITIONAL dependency look wrong the moment
         * `web` was added — `tauri-plugin-peer` is compiled for every target
         * that has targets, and the checker read that as "every platform
         * including the one with no compiler". */
        const compiled = dep.optional
          ? NATIVE_PLATFORMS.filter((p) => dependenciesOfFeature(p, cargo).has(dep.name))
          : [...NATIVE_PLATFORMS]
        const want = NATIVE_PLATFORMS.filter((p) => entry.platforms.includes(p))
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
  }
  return { findings, crates: withCrate.length }
}

/** Whether `c` can appear inside a Rust identifier. */
const isIdentChar = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c)

/**
 * A raw string starting at `i`, or null. `r"…"`, `r#"…"#`, `br#"…"#`, `cr"…"`.
 *
 * ⚠️ **The `r` must STAND ALONE** (a `b` or `c` prefix aside). Without the
 * boundary, ANY identifier ending in `r` before a quote opened a phantom raw
 * string — `"Quit Paper"` in the tray menu matched at `…r"`, and the mask
 * blanked everything to the next quote, 250 lines of real registrations
 * included. A masker that eats the code it was meant to protect is the defect
 * this whole function exists against, one layer down.
 */
function rawStringAt(source, i) {
  if (source[i] !== 'r') return null
  const before = source[i - 1]
  if (isIdentChar(before) && !((before === 'b' || before === 'c') && !isIdentChar(source[i - 2]))) return null
  let j = i + 1
  let hashes = 0
  while (source[j] === '#') {
    hashes++
    j++
  }
  /* `r#type` is a RAW IDENTIFIER, not a string, and there are several in any
   * Tauri codebase. No quote, no raw string. */
  if (source[j] !== '"') return null
  const close = `"${'#'.repeat(hashes)}`
  const at = source.indexOf(close, j + 1)
  return at === -1
    ? { contentFrom: j + 1, contentTo: source.length, end: source.length }
    : { contentFrom: j + 1, contentTo: at, end: at + close.length }
}

/**
 * Rust with its COMMENTS and its STRING CONTENTS blanked to spaces.
 *
 * ⚠️ **`stripComments` IS A JAVASCRIPT LEXER AND RUST IS NOT JAVASCRIPT.** It
 * treats `'` as a quote, so the first LIFETIME in a file — `'a`, `'static`,
 * `'outer:` — opened a string that never closed, and from there to the next
 * apostrophe nothing was recognised as a comment. A commented-out
 * `.plugin(x::init())` in that span read as a live registration, and a plugin
 * the app never registers passed the gate below. That is the third masker in
 * this file to eat what it was written to protect, so this one is a lexer for
 * the language it is pointed at rather than a stack of regular expressions:
 *
 *   - `//` to end of line, and `/* *\/` NESTED, which Rust's are and C's are not.
 *   - `"…"` with backslash escapes, and `r"…"` / `r#"…"#` / `br#"…"#` without.
 *   - `'x'`, `'\n'`, `'\''` and `b'x'` are CHAR LITERALS; anything else after
 *     an apostrophe is a lifetime or a loop label, and changes no state at all.
 *
 * LENGTH-PRESERVING — every blanked character becomes a space and every
 * newline stays — so a caller may match against the mask and edit the raw
 * text by the match's own indexes, and so line numbers still mean what they
 * meant.
 *
 * The one thing it gets wrong is a char literal holding a NON-BMP character
 * (`'😀'`): two UTF-16 code units, so the closing quote is not where a char
 * literal's would be and both quotes read as lifetimes. That leaves the
 * character visible rather than blanked, which is the harmless direction —
 * unlike the old behaviour, an unpaired apostrophe can no longer swallow the
 * rest of the file.
 */
export function maskRustCode(source) {
  const out = [...source]
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  /* The terminator of a `"…"` or a `'…'`, honouring backslash escapes. */
  const closingAt = (from, quote) => {
    let j = from
    while (j < source.length) {
      if (source[j] === '\\') {
        j += 2
        continue
      }
      if (source[j] === quote) return j
      j++
    }
    return source.length
  }
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i)
      const to = end === -1 ? source.length : end
      blank(i, to)
      i = to
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      /* NESTED, because Rust's block comments nest and C's do not: an inner
       * opener needs an inner closer, so a scanner that stopped at the first
       * close would read the rest of the outer comment as code. An
       * unterminated one runs to the end of the file. */
      let depth = 1
      let j = i + 2
      while (j < source.length && depth > 0) {
        if (source[j] === '/' && source[j + 1] === '*') {
          depth++
          j += 2
        } else if (source[j] === '*' && source[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      blank(i, j)
      i = j
      continue
    }
    const raw = rawStringAt(source, i)
    if (raw !== null) {
      blank(raw.contentFrom, raw.contentTo)
      i = raw.end
      continue
    }
    if (c === '"') {
      const at = closingAt(i + 1, '"')
      blank(i + 1, at)
      i = at + 1
      continue
    }
    if (c === "'") {
      /* `'\n'` and `'\''` — an escape can only be a char literal. */
      if (source[i + 1] === '\\') {
        const at = closingAt(i + 1, "'")
        blank(i + 1, at)
        i = at + 1
        continue
      }
      /* `'x'` — one character then the closing quote. Anything else is a
       * LIFETIME or a loop label, which is not a literal and opens nothing. */
      if (source[i + 2] === "'") {
        blank(i + 1, i + 2)
        i += 3
        continue
      }
      i++
      continue
    }
    i++
  }
  return out.join('')
}

/** `.plugin(<name>::init())`, whitespace-tolerant, outside comments AND
 *  outside string literals of every shape — a log line quoting the call is
 *  not the call. See `maskRustCode` for what a JavaScript lexer got wrong
 *  here. */
export function registersPlugin(libRs, name) {
  const code = maskRustCode(libRs)
  /* Two registration shapes, both real. `NAME::init()` is what a generated
   * plugin exports and what every crate in this workspace uses;
   * `NAME::Builder::…` is the OFFICIAL plugins' documented form —
   * `single_instance::Builder::new(cb)` and `window_state::Builder::default()`
   * (WI-20.32) register that way, and matching only `init()` read both as
   * unregistered. The builder chain spans lines and takes arguments, so the
   * match is the OPENING of the call, not its close. */
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\.plugin\\(\\s*${escaped}::(?:init\\(\\)\\s*\\)|Builder\\b)`).test(code)
}

/**
 * Tauri capability files name platforms as `macOS`, `windows`, `linux`,
 * `iOS`, `android`; a file without the key applies everywhere. Our closed set
 * folds the three desktop OSes into `desktop`.
 *
 * ⚠️ **`desktop` MEANS ALL THREE, AND THIS USED TO MEAN ANY.** The check was
 * `TAURI_PLATFORMS[platform].some(…)`, so a permission scoped to `["macOS"]`
 * satisfied the manifest's `desktop` — and the Windows and Linux builds, which
 * this repository ships (`bundle.targets` is `all`), had no such grant. The
 * command would be refused at runtime on two of the three operating systems
 * the entry claims, and the gate said it was covered.
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
    /* Present-but-invalid must not fail OPEN: a malformed `platforms`
     * read as null meant "all platforms", and a malformed `permissions`
     * read as none silently erased a file's grants from the check. */
    if ('platforms' in json && !Array.isArray(json.platforms)) {
      findings.push(finding('ACL_UNREADABLE', file, `${file} has a platforms field that is not an array`))
      continue
    }
    if ('permissions' in json && !Array.isArray(json.permissions)) {
      findings.push(finding('ACL_UNREADABLE', file, `${file} has a permissions field that is not an array`))
      continue
    }
    const platforms = Array.isArray(json.platforms) ? new Set(json.platforms.map(String)) : null
    for (const item of Array.isArray(json.permissions) ? json.permissions : []) {
      const identifier = typeof item === 'string' ? item : item && typeof item.identifier === 'string' ? item.identifier : null
      if (identifier !== null) grants.push({ identifier, platforms, file })
    }
  }
  return {
    /** Every grant read, with the file it came from — what the inverse rule walks. */
    grantList: grants,
    /**
     * Whether `identifier` is granted on every OS `platform` stands for.
     *
     * `web` IS NOT A TAURI PLATFORM and has no ACL to consult — it is a
     * manifest platform with no Cargo feature and no `src-tauri` (see
     * `NATIVE_PLATFORMS` in `architecture.mjs`). A Tauri permission cannot be
     * granted there, and asking used to index `TAURI_PLATFORMS['web']`,
     * yielding `undefined` and throwing on `.some`. Answering `false` is both
     * true and the safe direction: a web entry needing a Tauri permission is a
     * finding, not a crash.
     */
    grants: (identifier, platform) => {
      const names = TAURI_PLATFORMS[platform]
      if (names === undefined) return false
      /* EVERY, not some — see the note on `TAURI_PLATFORMS`. An ungated file
         (`platforms === null`) applies everywhere, so it covers all of them. */
      return names.every((name) =>
        grants.some(
          (g) => g.identifier === identifier && (g.platforms === null || g.platforms.has(name)),
        ),
      )
    },
  }
}

/** Every Tauri platform name a capability file can be scoped to. */
const TAURI_PLATFORM_NAMES = Object.freeze(Object.values(TAURI_PLATFORMS).flat())

/**
 * THE INVERSE OF `PERMISSION_UNGRANTED`, and the half that was missing.
 *
 * The forward rule asks "is every permission the manifest lists granted on
 * every platform the entry composes?" — and is satisfied by a grant in a file
 * with no `platforms`, which applies EVERYWHERE. Nothing asked the other
 * question: "does every grant of a manifest plugin sit on a platform that
 * COMPILES that plugin?" tauri-build asks it at build time, per target, and
 * refuses the whole capability — `Permission inference:default not found` —
 * because a plugin that is not compiled for the target contributes no
 * permission manifest to check against. `inference:default` and
 * `webhost:default` sat in the platform-less `default.json` for a phase, both
 * plugins are desktop-only, and the iOS and Android compositions did not
 * compile. `pnpm verify` runs only default-feature cargo, and the weekly
 * mobile workflow had never fired, so the first thing to notice was a hand
 * run of the iOS `cargo check`.
 *
 * SCOPED TO MANIFEST PLUGINS, deliberately. A grant's namespace is the text
 * before its first `:`; only namespaces that belong to a manifest entry are
 * this rule's business. `core:*`, `dialog:*`, `fs:*`, `log:*` are Tauri's own
 * and its first-party plugins, compiled on every target that has one, and a
 * rule that named them would report every capability file in the tree. The
 * exemption cannot hide the regression above: `inference` IS a manifest
 * entry, so its grants are checked wherever they are spelled —
 * `inference:default` and `inference:allow-x` alike.
 *
 * One finding per (file, grant), naming the platforms the file applies to
 * that the entry does not compose — so a reader knows which file to scope
 * and with what.
 */
function uncompiledGrants(manifest, grantList) {
  const findings = []
  const composed = new Map() // namespace -> { entry, names: Set<TauriPlatformName> }
  for (const entry of manifest.capabilities) {
    const ns = namespaceOf(entry)
    if (ns === null) continue
    const names = new Set(entry.platforms.flatMap((p) => TAURI_PLATFORMS[p] ?? []))
    composed.set(ns, { entry, names })
  }
  for (const grant of grantList) {
    const colon = grant.identifier.indexOf(':')
    if (colon <= 0) continue
    const target = composed.get(grant.identifier.slice(0, colon))
    if (target === undefined) continue
    const applies = grant.platforms === null ? TAURI_PLATFORM_NAMES : TAURI_PLATFORM_NAMES.filter((n) => grant.platforms.has(n))
    const missing = applies.filter((n) => !target.names.has(n))
    if (missing.length === 0) continue
    findings.push(
      finding(
        'GRANT_UNCOMPILED',
        grant.file,
        `${grant.file} grants ${JSON.stringify(grant.identifier)} on ${missing.join(', ')}, where the manifest does not compose ${target.entry.id} (platforms: [${target.entry.platforms.join(', ')}]); tauri-build refuses a permission whose plugin is not compiled for the target — scope the file with "platforms", or move the grant to one that is`,
      ),
    )
  }
  return findings
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
      } else if (/^src\/capabilities\/[^/]+\/index\.tsx?$/.test(rel)) {
        /* PRESENT is the capability's root module. A bundle holding only
         * `<dir>/lib/helper.ts` — the index tree-shaken or mis-resolved —
         * is not a composed capability and must fail the absence check. */
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
