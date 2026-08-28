import { statSync } from 'node:fs'
import path from 'node:path'

/**
 * The capabilities manifest, as a pure library: what a manifest may contain,
 * and every way one can be wrong.
 *
 * `capabilities.manifest.json` is the one place that lists Paper's first-party
 * capabilities — their ids, what they require, where their TypeScript and Rust
 * live, which platforms compose them, and the Tauri plugin and permissions
 * they bring. The meaning of each field is the ADR's (`dev-docs/adr/0001-…`); this
 * module is the enforcement, and `capabilities.manifest.schema.json` is the
 * same rules restated for editors (SCH-1 in the tests keeps the two aligned).
 *
 * Everything here is deterministic and depends on the world only through the
 * `fsProbe` handed to `validateManifest`, so the whole rule set is testable
 * without a filesystem and the CLI stays a thin shell.
 *
 * Findings are `{ code, path, message }`: `code` from FINDING_CODES, `path` a
 * JSON pointer (RFC 6901) into the manifest, `message` a single line with no
 * control characters in it — the CLI prints one finding per line, and a key
 * or id containing a newline must not be able to break that.
 */

/* --------------------------------------------------------------- constants */

export const PLATFORMS = Object.freeze(['desktop', 'ios', 'android', 'web'])

/**
 * The platforms that compile Rust.
 *
 * `web` is a platform of this application in every sense the manifest cares
 * about — it has a composition, it composes capabilities, and the bundle
 * assertion holds it to the manifest. It is NOT a Tauri target: the browser
 * client is served to somebody else's browser and has no `src-tauri` in it at
 * all.
 *
 * So anything asking "which Cargo feature compiles this platform" must iterate
 * THIS list rather than `PLATFORMS`. There is no `web` feature in
 * `src-tauri/Cargo.toml` and there must not be one — a feature that compiles
 * nothing is a feature somebody will later try to use.
 */
export const NATIVE_PLATFORMS = Object.freeze(['desktop', 'ios', 'android'])

/** A capability id: lowercase, starts with a letter, then letters/digits/hyphens. */
export const ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** Ids the runtime registry refuses (`registry.ts`): the kernel is not a
 *  capability. The validator refuses them too, so the manifest and the
 *  registry agree rather than a `kernel` entry passing here and failing only
 *  when the composition boots. */
export const RESERVED_IDS = Object.freeze(['kernel'])

/** A single directory name: no separators, and not `.` or `..`. Anything a
 *  manifest could use to walk out of `src/capabilities/` fails this before
 *  the filesystem is ever asked. */
export const DIR_NAME_PATTERN = /^(?!\.\.?$)[^/\\]+$/

export const REQUIRED_FIELDS = Object.freeze(['id', 'ts', 'platforms'])
export const ROOT_FIELDS = Object.freeze(['$schema', 'capabilities'])
export const ENTRY_FIELDS = Object.freeze(['id', 'requires', 'ts', 'platforms', 'crate', 'plugin', 'permissions'])

/** The closed list of finding codes, in report order for one path. The order
 *  is load-bearing: two findings on the same path come out in this order. */
export const FINDING_CODES = Object.freeze([
  'MANIFEST_MISSING',
  'MANIFEST_PARSE',
  'MANIFEST_SHAPE',
  'UNKNOWN_FIELD',
  'ENTRY_SHAPE',
  'ID_MISSING',
  'ID_SHAPE',
  'ID_INVALID',
  'ID_RESERVED',
  'ID_DUPLICATE',
  'REQUIRES_SHAPE',
  'REQUIRES_UNRESOLVED',
  'REQUIRES_SELF',
  'REQUIRES_DUPLICATE',
  'REQUIRES_CYCLE',
  'TS_MISSING',
  'TS_SHAPE',
  'TS_INVALID',
  'TS_DIR_ABSENT',
  'TS_INDEX_ABSENT',
  'PLATFORMS_MISSING',
  'PLATFORMS_SHAPE',
  'PLATFORMS_EMPTY',
  'PLATFORMS_UNKNOWN',
  'PLATFORMS_DUPLICATE',
  'CRATE_SHAPE',
  'CRATE_INVALID',
  'CRATE_ABSENT',
  'PLUGIN_SHAPE',
  'PERMISSIONS_SHAPE',
  'PERMISSIONS_NAMESPACE',
])

const ROOT_FIELD_SET = new Set(ROOT_FIELDS)
const ENTRY_FIELD_SET = new Set(ENTRY_FIELDS)
const PLATFORM_SET = new Set(PLATFORMS)

/* ------------------------------------------------------------------- text */

/** Whitespace runs (LF, CRLF, CR, tabs, U+2028/9, …) become one space; trimmed. */
export function collapse(s) {
  return String(s).replace(/\s+/g, ' ').trim()
}

/** Whatever control characters `collapse` left (they were not whitespace)
 *  become `\uXXXX`, so a message can never carry a raw ESC, NUL, or line
 *  separator into a terminal or a log line. C0, DEL, C1, U+2028, U+2029. */
export function escapeControls(s) {
  return String(s).replace(
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/** One line, no control characters: the only form a message takes. */
const line = (s) => escapeControls(collapse(s))

/** User text quoted for a message. JSON.stringify escapes what collapse did
 *  not turn into a space, so a key or id is shown exactly and harmlessly. */
const show = (s) => JSON.stringify(collapse(String(s)))

const typeName = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)

/* --------------------------------------------------------------- pointers */

/** RFC 6901: `~` first, then `/`. */
const escapeSegment = (segment) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1')
const pointer = (...segments) => segments.map((s) => `/${escapeSegment(s)}`).join('')

/* ---------------------------------------------------------------- finding */

function finding(code, pathOrSegments, message) {
  if (!FINDING_CODES.includes(code)) throw new Error(`unknown finding code ${code}`)
  const p = Array.isArray(pathOrSegments) ? pointer(...pathOrSegments) : pathOrSegments
  return { code, path: p, message: line(message) }
}

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/* ------------------------------------------------------------------ parse */

/**
 * JSON text → manifest. Never throws: invalid JSON is one MANIFEST_PARSE
 * finding whose message carries the parser's own words (V8 quotes a slice of
 * the source, newlines and all, which is why `line` is applied).
 */
export function parseManifest(text) {
  try {
    return { manifest: JSON.parse(text), findings: [] }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return {
      manifest: null,
      findings: [finding('MANIFEST_PARSE', '', `capabilities.manifest.json is not valid JSON: ${detail}`)],
    }
  }
}

/* --------------------------------------------------------------- validate */

/**
 * The rules, in the order the findings come out. `fsProbe` is
 * `{ isDirectory(rel), isFile(rel) }` over the repository root — see
 * `createFsProbe` — and is consulted only after a name has passed
 * DIR_NAME_PATTERN, so a traversal string in the manifest never reaches it.
 */
export function validateManifest(manifest, fsProbe) {
  if (!isPlainObject(manifest)) {
    return [finding('MANIFEST_SHAPE', '', `manifest must be a JSON object, got ${typeName(manifest)}`)]
  }
  const findings = []

  for (const key of Object.keys(manifest)) {
    if (!ROOT_FIELD_SET.has(key)) findings.push(finding('UNKNOWN_FIELD', [key], `unknown field ${show(key)} at the manifest root`))
  }
  if (has(manifest, '$schema') && typeof manifest.$schema !== 'string') {
    findings.push(finding('MANIFEST_SHAPE', ['$schema'], `$schema must be a string, got ${typeName(manifest.$schema)}`))
  }
  if (!has(manifest, 'capabilities') || !Array.isArray(manifest.capabilities)) {
    const got = has(manifest, 'capabilities') ? `got ${typeName(manifest.capabilities)}` : 'it is missing'
    findings.push(finding('MANIFEST_SHAPE', ['capabilities'], `capabilities must be an array; ${got}`))
    return findings
  }

  const entries = manifest.capabilities
  const ids = idTable(entries)
  const cycles = cycleTable(entries, ids)
  entries.forEach((entry, index) => {
    /* Appended by iteration: `push(...huge)` is a call whose ARGUMENT COUNT
     * is the array length, and a malformed manifest with a hundred-thousand
     * findings would overflow the call stack inside the validator. */
    for (const one of validateEntry(entry, index, { ids, cycles, fsProbe })) findings.push(one)
  })
  return findings
}

/** id → index of its FIRST occurrence, over every string id (valid or not).
 *  A Map, so `constructor` and `__proto__` are ids like any other. */
function idTable(entries) {
  const table = new Map()
  entries.forEach((entry, index) => {
    if (isPlainObject(entry) && typeof entry.id === 'string' && !table.has(entry.id)) table.set(entry.id, index)
  })
  return table
}

/**
 * id → its cycle message, for every id in a strongly connected component of
 * size ≥ 2. Nodes are the first-occurrence string ids; edges are the
 * resolving, non-self string items of a first-occurrence entry's `requires`.
 */
function cycleTable(entries, ids) {
  const edges = new Map()
  for (const [id, index] of ids) {
    const requires = entries[index].requires
    const targets = []
    if (Array.isArray(requires)) {
      for (const item of requires) {
        if (typeof item === 'string' && item !== id && ids.has(item)) targets.push(item)
      }
    }
    edges.set(id, targets)
  }
  const messages = new Map()
  for (const component of stronglyConnectedComponents([...ids.keys()], edges)) {
    if (component.length < 2) continue
    const message = `requires cycle among: ${[...component].sort().join(', ')}`
    for (const id of component) messages.set(id, message)
  }
  return messages
}

/**
 * Tarjan's algorithm, iterative. Recursion would overflow the stack on a
 * long `requires` chain (V-17 runs a 50 000-deep one), and a validator that
 * crashes on a legal manifest is worse than one with a bug.
 */
function stronglyConnectedComponents(nodes, edges) {
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const components = []
  let counter = 0

  const visit = (node) => {
    index.set(node, counter)
    low.set(node, counter)
    counter++
    stack.push(node)
    onStack.add(node)
  }

  for (const root of nodes) {
    if (index.has(root)) continue
    visit(root)
    const work = [{ node: root, next: 0 }]
    while (work.length > 0) {
      const frame = work[work.length - 1]
      const successors = edges.get(frame.node) ?? []
      if (frame.next < successors.length) {
        const next = successors[frame.next++]
        if (!index.has(next)) {
          visit(next)
          work.push({ node: next, next: 0 })
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(next)))
        }
        continue
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = []
        let member
        do {
          member = stack.pop()
          onStack.delete(member)
          component.push(member)
        } while (member !== frame.node)
        components.push(component)
      }
      work.pop()
      if (work.length > 0) {
        const parent = work[work.length - 1].node
        low.set(parent, Math.min(low.get(parent), low.get(frame.node)))
      }
    }
  }
  return components
}

/* ------------------------------------------------------------------ entry */

/** The ordering only: unknown keys first, then the known fields in
 *  ENTRY_FIELDS order. Each field's rules live in its own validator. */
function validateEntry(entry, index, context) {
  const at = ['capabilities', index]
  if (!isPlainObject(entry)) {
    return [finding('ENTRY_SHAPE', at, `capability #${index} must be an object, got ${typeName(entry)}`)]
  }
  const findings = []
  for (const key of Object.keys(entry)) {
    if (!ENTRY_FIELD_SET.has(key)) findings.push(finding('UNKNOWN_FIELD', [...at, key], `unknown field ${show(key)} in capability #${index}`))
  }
  /* Appended by iteration — `push(...list)`'s argument count is the list
   * length, and a pathological entry (a hundred-thousand-element
   * `requires`) would overflow the call stack. */
  for (const list of [
    validateId(entry, index, at, context),
    validateRequires(entry, index, at, context),
    validateDirField(entry, at, context, TS_FIELD),
    validatePlatforms(entry, at),
    validateDirField(entry, at, context, CRATE_FIELD),
    validatePlugin(entry, at),
    validatePermissions(entry, at),
  ]) {
    for (const one of list) findings.push(one)
  }
  return findings
}

function validateId(entry, index, at, { ids }) {
  const p = [...at, 'id']
  if (!has(entry, 'id')) return [finding('ID_MISSING', p, `capability #${index} has no id`)]
  const id = entry.id
  if (typeof id !== 'string') return [finding('ID_SHAPE', p, `id must be a string, got ${typeName(id)}`)]
  const findings = []
  if (!ID_PATTERN.test(id)) {
    findings.push(finding('ID_INVALID', p, `id ${show(id)} must match ${ID_PATTERN.source}`))
  }
  if (RESERVED_IDS.includes(id)) {
    findings.push(finding('ID_RESERVED', p, `id ${show(id)} is reserved for the kernel and cannot name a capability`))
  }
  const first = ids.get(id)
  if (first !== index) {
    findings.push(finding('ID_DUPLICATE', p, `id ${show(id)} is already declared by capability #${first}`))
  }
  return findings
}

function validateRequires(entry, index, at, { ids, cycles }) {
  const p = [...at, 'requires']
  if (!has(entry, 'requires')) return []
  const requires = entry.requires
  if (!Array.isArray(requires)) return [finding('REQUIRES_SHAPE', p, `requires must be an array, got ${typeName(requires)}`)]
  const findings = []
  const ownId = typeof entry.id === 'string' ? entry.id : undefined
  // Field-level first: only a first-occurrence entry is a node in the graph.
  if (ownId !== undefined && ids.get(ownId) === index && cycles.has(ownId)) {
    findings.push(finding('REQUIRES_CYCLE', p, cycles.get(ownId)))
  }
  const seen = new Set()
  requires.forEach((item, k) => {
    const q = [...p, k]
    if (typeof item !== 'string') {
      findings.push(finding('REQUIRES_SHAPE', q, `requires item must be a string, got ${typeName(item)}`))
      return
    }
    if (item === ownId) {
      findings.push(finding('REQUIRES_SELF', q, `capability ${show(item)} requires itself`))
    } else if (!ids.has(item)) {
      findings.push(finding('REQUIRES_UNRESOLVED', q, `requires ${show(item)}, which no capability declares`))
    }
    if (seen.has(item)) findings.push(finding('REQUIRES_DUPLICATE', q, `requires ${show(item)} more than once`))
    seen.add(item)
  })
  return findings
}

/** ts and crate share one shape: an optional-or-required directory name,
 *  guarded by DIR_NAME_PATTERN before the probe, then looked up. */
const TS_FIELD = Object.freeze({
  field: 'ts',
  required: true,
  codes: { missing: 'TS_MISSING', shape: 'TS_SHAPE', invalid: 'TS_INVALID', absent: 'TS_DIR_ABSENT', indexAbsent: 'TS_INDEX_ABSENT' },
  dirOf: (name) => `src/capabilities/${name}`,
  fileOf: (name) => `src/capabilities/${name}/index.ts`,
})
const CRATE_FIELD = Object.freeze({
  field: 'crate',
  required: false,
  codes: { shape: 'CRATE_SHAPE', invalid: 'CRATE_INVALID', absent: 'CRATE_ABSENT' },
  dirOf: (name) => `src-tauri/crates/${name}`,
  fileOf: null,
})

function validateDirField(entry, at, { fsProbe }, spec) {
  const { field, codes } = spec
  const p = [...at, field]
  if (!has(entry, field)) {
    return spec.required ? [finding(codes.missing, p, `${field} is required`)] : []
  }
  const name = entry[field]
  if (typeof name !== 'string') return [finding(codes.shape, p, `${field} must be a string, got ${typeName(name)}`)]
  if (!DIR_NAME_PATTERN.test(name)) {
    return [finding(codes.invalid, p, `${field} ${show(name)} must be a single directory name (no separators, not . or ..)`)]
  }
  const dir = spec.dirOf(name)
  if (!fsProbe.isDirectory(dir)) return [finding(codes.absent, p, `${field} ${show(name)}: ${dir} is not a directory`)]
  if (spec.fileOf !== null) {
    const file = spec.fileOf(name)
    if (!fsProbe.isFile(file)) return [finding(codes.indexAbsent, p, `${field} ${show(name)}: ${file} is not a file`)]
  }
  return []
}

function validatePlatforms(entry, at) {
  const p = [...at, 'platforms']
  if (!has(entry, 'platforms')) return [finding('PLATFORMS_MISSING', p, 'platforms is required')]
  const platforms = entry.platforms
  if (!Array.isArray(platforms)) return [finding('PLATFORMS_SHAPE', p, `platforms must be an array, got ${typeName(platforms)}`)]
  if (platforms.length === 0) return [finding('PLATFORMS_EMPTY', p, 'platforms must name at least one platform')]
  const findings = []
  const seen = new Set()
  platforms.forEach((item, k) => {
    const q = [...p, k]
    if (typeof item !== 'string') {
      findings.push(finding('PLATFORMS_SHAPE', q, `platform must be a string, got ${typeName(item)}`))
      return
    }
    if (!PLATFORM_SET.has(item)) {
      findings.push(finding('PLATFORMS_UNKNOWN', q, `unknown platform ${show(item)}; known: ${PLATFORMS.join(', ')}`))
    }
    if (seen.has(item)) findings.push(finding('PLATFORMS_DUPLICATE', q, `platform ${show(item)} listed more than once`))
    seen.add(item)
  })
  return findings
}

function validatePlugin(entry, at) {
  if (!has(entry, 'plugin')) return []
  const plugin = entry.plugin
  if (typeof plugin !== 'string') {
    return [finding('PLUGIN_SHAPE', [...at, 'plugin'], `plugin must be a string, got ${typeName(plugin)}`)]
  }
  /* The STRING must also normalise to a real ACL namespace: `""` and
   * `"tauri-plugin-"` both normalise to the empty namespace, which would
   * make every permission check below vacuously prefix-match `":"`. */
  const ns = normalizePluginNamespace(plugin)
  if (!NAMESPACE_PATTERN.test(ns)) {
    return [finding('PLUGIN_SHAPE', [...at, 'plugin'], `plugin ${show(plugin)} must normalise to a namespace matching ${NAMESPACE_PATTERN.source}, got ${show(ns)}`)]
  }
  return []
}

/** The ACL namespace a `plugin` crate name maps to: Tauri strips the crate
 *  prefix. ONE copy — the plugin validator, the permission check and the
 *  compositions checker's grant rule all read it, so they cannot drift. */
export function normalizePluginNamespace(plugin) {
  return plugin.replace(/^tauri-plugin-/, '')
}

/** The ACL namespace of a manifest entry: its `plugin`, normalised, else its
 *  `id` — the same fallback `validatePermissions` applies to the entry's own
 *  grants, so a grant in a capability file is matched to an entry by exactly
 *  the rule the manifest was validated under. */
export function namespaceOf(entry) {
  return typeof entry.plugin === 'string' ? normalizePluginNamespace(entry.plugin) : typeof entry.id === 'string' ? entry.id : null
}

/** Hyphen-separated lower-alphanumeric words — no leading, trailing or
 *  doubled hyphen, which `[a-z0-9-]*` accepted. */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

function validatePermissions(entry, at) {
  const p = [...at, 'permissions']
  if (!has(entry, 'permissions')) return []
  const permissions = entry.permissions
  if (!Array.isArray(permissions)) return [finding('PERMISSIONS_SHAPE', p, `permissions must be an array, got ${typeName(permissions)}`)]
  const findings = []
  /* The ACL namespace is the plugin name (Tauri strips its `tauri-plugin-`
   * crate prefix), falling back to the id. Every grant must live under it, so
   * `capability:remove` can find them and a wrong `plugin` cannot hide one.
   * `namespaceOf` IS this rule — restated inline here it had already drifted
   * once in spirit, which is what the single source exists to stop. */
  const ns = namespaceOf(entry)
  permissions.forEach((item, k) => {
    if (typeof item !== 'string') {
      findings.push(finding('PERMISSIONS_SHAPE', [...p, k], `permission must be a string, got ${typeName(item)}`))
      return
    }
    const suffix = ns !== null && item.startsWith(`${ns}:`) ? item.slice(ns.length + 1) : null
    if (ns !== null && (suffix === null || !/^[a-zA-Z][a-zA-Z0-9]*(-[a-zA-Z0-9]+)*$/.test(suffix))) {
      findings.push(finding('PERMISSIONS_NAMESPACE', [...p, k], `permission ${show(item)} must be ${show(`${ns}:`)} followed by a permission name`))
    }
  })
  return findings
}

/* ------------------------------------------------------------------ probe */

/**
 * The one adapter to the filesystem. Paths are joined under `rootDir` and
 * looked up with `statSync`; anything that throws — ENOENT, ENOTDIR,
 * ENAMETOOLONG, a NUL byte, a non-string — is simply "not there". It is a
 * plain join, not a sandbox: what keeps `../..` out is DIR_NAME_PATTERN in
 * the validator, which runs before this is ever asked.
 */
export function createFsProbe(rootDir) {
  const root = String(rootDir)
  const stat = (rel) => {
    try {
      return statSync(path.join(root, rel))
    } catch {
      return null
    }
  }
  return {
    isDirectory: (rel) => stat(rel)?.isDirectory() === true,
    isFile: (rel) => stat(rel)?.isFile() === true,
  }
}
