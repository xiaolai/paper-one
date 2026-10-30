/**
 * A reader for the slice of TOML that `src-tauri/Cargo.toml` uses to name
 * its dependencies and features — not a TOML parser.
 *
 * `pnpm compositions:check` needs to know, for a capability's crate, which
 * dependency in the app crate points at it and which platform features
 * compile that dependency; `pnpm capability:remove` needs the same plus the
 * line spans, so it can cut the dependency and its feature forwarding out of
 * the text without reformatting anything around them. Both read the manifest
 * through this module, so the two cannot disagree about what a line means.
 *
 * What is understood — the shapes Cargo documents for these two tables:
 *
 *   [dependencies]                       and [dependencies.<name>] tables
 *   name = "1.0"
 *   name = { path = "crates/x", optional = true, features = ["a"] }
 *   [features]
 *   name = ["dep:x", "x/feat", "other-feature"]   one line or many
 *
 * Anything else — `[target.'cfg(…)'.dependencies]`, `[dev-dependencies]`,
 * multi-line inline tables — is left alone: not read, not edited. A crate
 * declared there is "not found" to the check, which is a finding a human
 * reads, not a silent pass.
 *
 * Every function here is pure over the text it is handed.
 */

/* ------------------------------------------------------------------ lines */

/** `[section]` → `section`; `[a.b]` → `a.b`; a quoted segment keeps its
 *  quotes stripped (`[dependencies."my crate"]` → `dependencies.my crate`). */
const HEADER = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/

/** A key at the start of a line: bare or basic-quoted, then `=`. */
const KEY = /^(\s*)(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)")\s*=\s*/

/**
 * Cut a `#` comment off the end of one line, leaving `#` inside a string
 * alone. Returns `[code, comment]` where `comment` is `''` or the `#…` tail.
 */
export function splitComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote !== null) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '#') return [line.slice(0, i), line.slice(i)]
  }
  return [line, '']
}

/* ----------------------------------------------------------------- values */

/**
 * Parse one TOML value out of `text` starting at `at`: strings (basic and
 * literal), booleans, integers/floats, arrays and inline tables. Returns
 * `{ value, end }` with `end` the index just past the value. Throws a plain
 * Error on anything else — the caller decides whether that is fatal.
 */
export function parseValue(text, at = 0) {
  const p = { text, i: at }
  const value = readValue(p)
  return { value, end: p.i }
}

function skipSpace(p) {
  while (p.i < p.text.length) {
    const c = p.text[p.i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') p.i++
    else if (c === '#') {
      while (p.i < p.text.length && p.text[p.i] !== '\n') p.i++
    } else break
  }
}

function fail(p, what) {
  throw new Error(`cannot read TOML ${what} at offset ${p.i}: ${JSON.stringify(p.text.slice(p.i, p.i + 20))}`)
}

function readValue(p) {
  skipSpace(p)
  const c = p.text[p.i]
  if (c === '"') return readBasicString(p)
  if (c === "'") return readLiteralString(p)
  if (c === '[') return readArray(p)
  if (c === '{') return readInlineTable(p)
  const word = /^(true|false|[+-]?(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/.exec(p.text.slice(p.i))
  if (!word) fail(p, 'value')
  p.i += word[0].length
  if (word[0] === 'true') return true
  if (word[0] === 'false') return false
  return Number(word[0].replace(/_/g, ''))
}

const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

function readBasicString(p) {
  p.i++ // opening quote
  let out = ''
  while (p.i < p.text.length) {
    const c = p.text[p.i]
    if (c === '"') {
      p.i++
      return out
    }
    if (c === '\\') {
      const e = p.text[p.i + 1]
      if (e === 'u' || e === 'U') {
        const width = e === 'u' ? 4 : 8
        const hex = p.text.slice(p.i + 2, p.i + 2 + width)
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== width) fail(p, 'unicode escape')
        out += String.fromCodePoint(parseInt(hex, 16))
        p.i += 2 + width
        continue
      }
      if (!(e in ESCAPES)) fail(p, 'string escape')
      out += ESCAPES[e]
      p.i += 2
      continue
    }
    if (c === '\n') fail(p, 'string (newline inside a basic string)')
    out += c
    p.i++
  }
  return fail(p, 'string (unterminated)')
}

function readLiteralString(p) {
  const close = p.text.indexOf("'", p.i + 1)
  if (close === -1) fail(p, 'literal string (unterminated)')
  const value = p.text.slice(p.i + 1, close)
  if (value.includes('\n')) fail(p, 'literal string (newline inside)')
  p.i = close + 1
  return value
}

function readArray(p) {
  p.i++ // [
  const items = []
  for (;;) {
    skipSpace(p)
    if (p.text[p.i] === ']') {
      p.i++
      return items
    }
    if (p.i >= p.text.length) fail(p, 'array (unterminated)')
    items.push(readValue(p))
    skipSpace(p)
    if (p.i >= p.text.length) fail(p, 'array (unterminated)')
    if (p.text[p.i] === ',') {
      p.i++
      continue
    }
    if (p.text[p.i] === ']') {
      p.i++
      return items
    }
    fail(p, 'array (expected , or ])')
  }
}

function readInlineTable(p) {
  p.i++ // {
  const table = {}
  skipSpace(p)
  if (p.text[p.i] === '}') {
    p.i++
    return table
  }
  for (;;) {
    skipSpace(p)
    const key = /^(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)")\s*=\s*/.exec(p.text.slice(p.i))
    if (!key) fail(p, 'inline table key')
    p.i += key[0].length
    const name = key[1] ?? JSON.parse(`"${key[2]}"`)
    table[name] = readValue(p)
    skipSpace(p)
    if (p.i >= p.text.length) fail(p, 'inline table (unterminated)')
    if (p.text[p.i] === ',') {
      p.i++
      continue
    }
    if (p.text[p.i] === '}') {
      p.i++
      return table
    }
    fail(p, 'inline table (expected , or })')
  }
}

/* --------------------------------------------------------------- manifest */

/**
 * The dependencies and features of a Cargo manifest, with line spans.
 *
 * Returns
 *   {
 *     dependencies: Map<name, { name, spec, optional, path, package, lines: [first, last] }>,
 *     features:     Map<name, { name, items: string[], lines: [first, last] }>,
 *   }
 *
 * `spec` is the parsed value (`"1.0"` → the string; an inline table → an
 * object; a `[dependencies.<name>]` table → an object built from its keys).
 * `path` is the dependency's `path` key or null; `package` its `package` key
 * (a renamed dependency) or null. Lines are 0-based and inclusive; for a
 * `[dependencies.<name>]` table they run from the header to the last key.
 *
 * Throws when a `[dependencies]` value or a `[features]` value cannot be
 * read — a manifest this module cannot understand must not be checked as if
 * it had no dependencies.
 */
export function readCargoManifest(text) {
  const lines = text.split('\n')
  const dependencies = new Map()
  const features = new Map()

  let section = null
  let subtable = null // { name, spec, first } for [dependencies.<name>]

  const flushSubtable = (last) => {
    if (subtable === null) return
    dependencies.set(subtable.name, describeDependency(subtable.name, subtable.spec, [subtable.first, last]))
    subtable = null
  }

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    const header = HEADER.exec(line)
    if (header) {
      flushSubtable(lastNonBlank(lines, n - 1))
      section = header[1].trim()
      const sub = /^dependencies\.(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)")$/.exec(section)
      if (sub) subtable = { name: sub[1] ?? JSON.parse(`"${sub[2]}"`), spec: {}, first: n }
      continue
    }
    const [code] = splitComment(line)
    if (code.trim() === '') continue
    const key = KEY.exec(code)
    if (!key) {
      if (section === 'dependencies' || section === 'features' || subtable !== null) {
        throw new Error(`Cargo.toml line ${n + 1}: expected \`key = value\` in [${section}], got ${JSON.stringify(line.trim())}`)
      }
      continue
    }
    const name = key[2] ?? JSON.parse(`"${key[3]}"`)
    if (subtable !== null) {
      const { value } = parseValue(code, key[0].length)
      subtable.spec[name] = value
      continue
    }
    if (section === 'dependencies') {
      const { value } = parseValue(code, key[0].length)
      dependencies.set(name, describeDependency(name, value, [n, n]))
      continue
    }
    if (section === 'features') {
      // An array may run over several lines: read from this line until the
      // brackets balance, then parse the joined text.
      const first = n
      let joined = code.slice(key[0].length)
      let last = n
      while (!bracketsBalance(joined) && last + 1 < lines.length) {
        last++
        joined += `\n${splitComment(lines[last])[0]}`
      }
      const { value } = parseValue(joined, 0)
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new Error(`Cargo.toml line ${n + 1}: feature ${JSON.stringify(name)} must be an array of strings`)
      }
      features.set(name, { name, items: value, lines: [first, last] })
      n = last
    }
  }
  flushSubtable(lastNonBlank(lines, lines.length - 1))
  return { dependencies, features }
}

function lastNonBlank(lines, from) {
  let n = from
  while (n > 0 && lines[n].trim() === '') n--
  return n
}

function bracketsBalance(text) {
  let depth = 0
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote !== null) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '[') depth++
    else if (c === ']') depth--
  }
  return depth <= 0 && quote === null
}

function describeDependency(name, spec, lines) {
  const table = typeof spec === 'object' && spec !== null && !Array.isArray(spec) ? spec : {}
  return {
    name,
    spec,
    optional: table.optional === true,
    path: typeof table.path === 'string' ? table.path : null,
    package: typeof table.package === 'string' ? table.package : null,
    lines,
  }
}

/* --------------------------------------------------------------- features */

/**
 * The names of the dependencies one feature item turns on, per Cargo's
 * rules: `dep:x` → x; `x/feat` → x (an optional dependency's feature also
 * enables the dependency); `x?/feat` → nothing (the weak form); a bare `x`
 * → x when x is an optional dependency and not a declared feature (the
 * implicit feature), else it names a feature. Returns
 * `{ dependency: string|null, feature: string|null }`.
 */
export function readFeatureItem(item, { dependencies, features }) {
  if (item.startsWith('dep:')) return { dependency: item.slice(4), feature: null }
  const slash = item.indexOf('/')
  if (slash !== -1) {
    const target = item.slice(0, slash)
    if (target.endsWith('?')) return { dependency: null, feature: null }
    return { dependency: target, feature: null }
  }
  if (features.has(item)) return { dependency: null, feature: item }
  const dep = dependencies.get(item)
  if (dep && dep.optional) return { dependency: item, feature: null }
  return { dependency: null, feature: null }
}

/**
 * Every dependency the feature `name` compiles in, transitively through the
 * features it lists. An unknown feature name compiles nothing.
 */
export function dependenciesOfFeature(name, manifest, seen = new Set()) {
  const out = new Set()
  if (seen.has(name)) return out
  seen.add(name)
  const feature = manifest.features.get(name)
  if (!feature) return out
  for (const item of feature.items) {
    const { dependency, feature: next } = readFeatureItem(item, manifest)
    if (dependency !== null) out.add(dependency)
    if (next !== null) for (const d of dependenciesOfFeature(next, manifest, seen)) out.add(d)
  }
  return out
}

/** Does this feature item name the dependency `dep`, in any of the forms
 *  `readFeatureItem` knows (`dep:x`, `x/f`, `x?/f`, bare optional `x`)? */
export function featureItemNames(item, dep, manifest) {
  if (item === `dep:${dep}`) return true
  if (item.startsWith(`${dep}/`) || item.startsWith(`${dep}?/`)) return true
  return item === dep && manifest.dependencies.has(dep) && !manifest.features.has(dep)
}

/** A path key normalised for comparison: `./crates/x/` → `crates/x`. */
export function normalizeCratePath(p) {
  return String(p)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
}

/** The dependency whose `path` points at `crates/<crate>`, or null. */
export function dependencyForCrate(manifest, crate) {
  const want = `crates/${crate}`
  for (const dep of manifest.dependencies.values()) {
    if (dep.path !== null && normalizeCratePath(dep.path) === want) return dep
  }
  return null
}

/** `tauri-plugin-peer` → `tauri_plugin_peer`: the crate as Rust names it. */
export function rustName(depName) {
  return depName.replace(/-/g, '_')
}
