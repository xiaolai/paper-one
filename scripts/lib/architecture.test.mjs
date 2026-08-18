import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  DIR_NAME_PATTERN,
  ENTRY_FIELDS,
  FINDING_CODES,
  ID_PATTERN,
  PLATFORMS,
  REQUIRED_FIELDS,
  ROOT_FIELDS,
  collapse,
  createFsProbe,
  escapeControls,
  parseManifest,
  validateManifest,
} from './architecture.mjs'

/**
 * The manifest validator, exercised as a pure library: every finding it can
 * emit, the order it emits them in, and the two places it touches the world
 * (JSON text in, an fs probe out). No mocks — the fs cases run over real
 * temporary trees, and the two probe doubles are plain objects.
 *
 * Case ids (`V-7`, `V-PROP-4`, …) are the names the plan and the doc refer to;
 * `REACHED_BY` at the bottom is the closed list of which case proves which
 * finding code, and C-2 checks it against what actually ran.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCHEMA_PATH = join(REPO_ROOT, 'capabilities.manifest.schema.json')
const MANIFEST_PATH = join(REPO_ROOT, 'capabilities.manifest.json')

/* ------------------------------------------------------------------ probes */

/** Everything exists. The default for cases that are not about the fs. */
const permissive = { isDirectory: () => true, isFile: () => true }

/** Proves guard-before-probe: any call is a failure. */
const throwing = {
  isDirectory(rel) {
    throw new Error(`probe consulted for directory ${JSON.stringify(rel)}`)
  },
  isFile(rel) {
    throw new Error(`probe consulted for file ${JSON.stringify(rel)}`)
  },
}

/** Answers for capability directories, throws for crate directories: the
 *  guard-before-probe case for `crate` on an entry whose `ts` is fine. */
const crateThrowing = {
  isDirectory(rel) {
    if (rel.startsWith('src-tauri/')) throw new Error(`probe consulted for directory ${JSON.stringify(rel)}`)
    return true
  },
  isFile: () => true,
}

/* --------------------------------------------------- code-reach bookkeeping */

/** Codes emitted per case id, filled by `parse` / `validate` below. */
const emitted = new Map()

function caseIdOf(testName) {
  const leaf = String(testName ?? '').split(' > ').pop() ?? ''
  const match = /^([A-Z]+(?:-[A-Z]+)*-\d+)\b/.exec(leaf)
  return match ? match[1] : null
}

function record(findings) {
  const id = caseIdOf(expect.getState().currentTestName)
  if (id === null) return findings
  const set = emitted.get(id) ?? new Set()
  for (const finding of findings) set.add(finding.code)
  emitted.set(id, set)
  return findings
}

const parse = (text) => {
  const result = parseManifest(text)
  record(result.findings)
  return result
}
const validate = (manifest, probe = permissive) => record(validateManifest(manifest, probe))

/* ---------------------------------------------------------------- helpers */

/** A complete, valid entry; override any field. `ts` is fixed so an odd id
 *  never doubles as an odd directory name. */
const cap = (id, extra = {}) => ({ id, ts: 'x', platforms: ['desktop'], ...extra })
const manifestOf = (...entries) => ({ capabilities: entries })
const strip = (findings) => findings.map(({ code, path }) => ({ code, path }))
const codesOf = (findings) => findings.map((f) => f.code)
const NO_LINE_BREAKS = /^[^\n\r]*$/

/** mulberry32 — a small seeded PRNG so the property cases replay exactly. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = (rng, list) => list[Math.floor(rng() * list.length)]
const int = (rng, max) => Math.floor(rng() * max) // 0 .. max-1

/** RFC 6901 unescape, for the comparator that re-derives a finding's rank. */
const unescapePointer = (segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~')

/**
 * The total order the validator promises (decision 6): root findings first
 * (unknown keys in key order, then `$schema`, then `capabilities`); then
 * entries by index; inside an entry, unknown keys in key order, then known
 * fields in ENTRY_FIELDS order; field-level before item-level; item index;
 * FINDING_CODES rank last. Derived from the manifest so it can be checked
 * against generated inputs.
 */
function byRank(manifest) {
  const rootKeys = Object.keys(manifest)
  const rootUnknown = rootKeys.filter((k) => !ROOT_FIELDS.includes(k))
  const rankOf = (finding) => {
    const codeRank = FINDING_CODES.indexOf(finding.code)
    if (finding.path === '') return [0, -1, 0, 0, 0, codeRank]
    const segs = finding.path.slice(1).split('/').map(unescapePointer)
    if (segs.length === 1) {
      const u = rootUnknown.indexOf(segs[0])
      const rank = u >= 0 ? u : 1000 + ROOT_FIELDS.indexOf(segs[0])
      return [0, rank, 0, 0, 0, codeRank]
    }
    const index = Number(segs[1])
    if (segs.length === 2) return [1, index, -1, 0, 0, codeRank]
    const entry = manifest.capabilities[index]
    const unknown = Object.keys(entry).filter((k) => !ENTRY_FIELDS.includes(k))
    const u = unknown.indexOf(segs[2])
    const fieldRank = u >= 0 ? u : 1000 + ENTRY_FIELDS.indexOf(segs[2])
    const itemLevel = segs.length > 3 ? 1 : 0
    const item = segs.length > 3 ? Number(segs[3]) : -1
    return [1, index, fieldRank, itemLevel, item, codeRank]
  }
  return (a, b) => {
    const ra = rankOf(a)
    const rb = rankOf(b)
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]
    return 0
  }
}

/* -------------------------------------------------------------- tmp trees */

const tmpRoots = []
function tmpRoot(prefix = 'architecture-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tmpRoots.push(root)
  return root
}
function tsDir(root, name, { index = true } = {}) {
  const dir = join(root, 'src', 'capabilities', name)
  mkdirSync(dir, { recursive: true })
  if (index) writeFileSync(join(dir, 'index.ts'), 'export {}\n')
  return dir
}
function crateDir(root, name) {
  const dir = join(root, 'src-tauri', 'crates', name)
  mkdirSync(dir, { recursive: true })
  return dir
}
afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})

/* ================================================================= SCHEMA */

describe('schema and repo manifest', () => {
  it('SCH-1 the sidecar schema restates the library constants field for field', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(typeof schema.$id).toBe('string')
    expect(typeof schema.title).toBe('string')
    expect(typeof schema.description).toBe('string')

    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['capabilities'])
    expect(Object.keys(schema.properties)).toEqual([...ROOT_FIELDS])
    expect(schema.properties.$schema.type).toBe('string')
    expect(schema.properties.capabilities.type).toBe('array')

    const entry = schema.properties.capabilities.items
    expect(entry.type).toBe('object')
    expect(entry.additionalProperties).toBe(false)
    expect(entry.required).toEqual([...REQUIRED_FIELDS])
    expect(Object.keys(entry.properties)).toEqual([...ENTRY_FIELDS])
    const p = entry.properties

    expect(p.id.type).toBe('string')
    expect(p.id.pattern).toBe(ID_PATTERN.source)

    expect(p.requires.type).toBe('array')
    expect(p.requires.items.type).toBe('string')
    expect(p.requires.items.pattern).toBe(ID_PATTERN.source)
    expect(p.requires.uniqueItems).toBe(true)
    expect(p.requires).not.toHaveProperty('minItems')

    expect(p.ts.type).toBe('string')
    expect(p.ts.pattern).toBe(DIR_NAME_PATTERN.source)
    expect(p.crate.type).toBe('string')
    expect(p.crate.pattern).toBe(DIR_NAME_PATTERN.source)

    expect(p.platforms.type).toBe('array')
    expect(p.platforms.minItems).toBe(1)
    expect(p.platforms.uniqueItems).toBe(true)
    expect(p.platforms.items.type).toBe('string')
    expect(p.platforms.items.enum).toEqual([...PLATFORMS])

    expect(p.plugin.type).toBe('string')

    expect(p.permissions.type).toBe('array')
    expect(p.permissions.items.type).toBe('string')
    expect(p.permissions).not.toHaveProperty('minItems')
    expect(p.permissions).not.toHaveProperty('uniqueItems')
  })

  it('SCH-2 the repo manifest validates against the repo tree and points at the sidecar', () => {
    const text = readFileSync(MANIFEST_PATH, 'utf8')
    const { manifest, findings } = parse(text)
    expect(findings).toEqual([])
    expect(validate(manifest, createFsProbe(REPO_ROOT))).toEqual([])
    expect(manifest.$schema).toBe('./capabilities.manifest.schema.json')
    expect(statSync(join(dirname(MANIFEST_PATH), manifest.$schema)).isFile()).toBe(true)
    // Exactly the two permitted root keys, in the seed's order — the byte-for-
    // byte pin on the K.1 seed went when WI-5.6 added the first entry.
    expect(Object.keys(manifest)).toEqual(['$schema', 'capabilities'])
    expect(text.endsWith('\n')).toBe(true)
    // Every entry composes on some platform and has its TypeScript where the
    // validator looked for it (an absent directory would be a finding above).
    for (const entry of manifest.capabilities) {
      expect(entry.platforms.length).toBeGreaterThan(0)
      expect(statSync(join(REPO_ROOT, 'src', 'capabilities', entry.ts, 'index.ts')).isFile()).toBe(true)
    }
  })
})

/* ================================================================== PARSE */

describe('parseManifest', () => {
  it('P-1 the empty manifest parses and validates clean', () => {
    const { manifest, findings } = parse('{"capabilities":[]}')
    expect(findings).toEqual([])
    expect(validate(manifest)).toEqual([])
  })

  it('P-2 invalid JSON is one MANIFEST_PARSE at the root, single-line, carrying the parser text', () => {
    const texts = [
      '{\n  "capabilities": [\n    { "id": tru }\n  ]\n}\n',
      '{\r\n  "capabilities":\r\n  [ 1, ]\r\n}\r\n',
      '',
      'not json at all',
    ]
    for (const text of texts) {
      let expected
      try {
        JSON.parse(text)
      } catch (cause) {
        expected = escapeControls(collapse(cause.message))
      }
      expect(expected).toBeDefined()
      const { manifest, findings } = parse(text)
      expect(manifest).toBeNull()
      expect(strip(findings)).toEqual([{ code: 'MANIFEST_PARSE', path: '' }])
      expect(findings[0].message).toMatch(NO_LINE_BREAKS)
      expect(findings[0].message).toContain(expected)
    }
  })

  it('P-3 the JSON text `null` parses; validating null is MANIFEST_SHAPE at the root', () => {
    const { manifest, findings } = parse('null')
    expect(manifest).toBeNull()
    expect(findings).toEqual([])
    expect(strip(validate(manifest))).toEqual([{ code: 'MANIFEST_SHAPE', path: '' }])
  })

  it('P-PROP-1 never throws and never emits a line break, over seeded random text', () => {
    const rng = mulberry32(0x5eed)
    const alphabet = [
      '{', '}', '[', ']', '"', ':', ',', ' ', '\n', '\r', '\t', '\\', 'a', 'z', '0', '9',
      'n', 'u', 'l', 't', 'r', 'e', 'f', 's', '-', '.', '\u001b', '\u2028', '\u0085', 'é',
    ]
    for (let i = 0; i < 200; i++) {
      const length = int(rng, 24)
      let text = ''
      for (let k = 0; k < length; k++) text += pick(rng, alphabet)
      let result
      expect(() => {
        result = parse(text)
      }).not.toThrow()
      for (const finding of result.findings) {
        expect(finding.code).toBe('MANIFEST_PARSE')
        expect(finding.message).toMatch(NO_LINE_BREAKS)
      }
    }
  })
})

/* =============================================================== VALIDATE */

describe('validateManifest — shapes and fields', () => {
  it('V-1 a complete manifest over a real tree is clean', () => {
    const root = tmpRoot()
    tsDir(root, 'peer')
    tsDir(root, 'sync')
    tsDir(root, 'solo')
    crateDir(root, 'tauri-plugin-peer')
    const manifest = manifestOf(
      { id: 'peer', ts: 'peer', crate: 'tauri-plugin-peer', plugin: 'peer', platforms: ['desktop', 'ios', 'android'], permissions: ['peer:default'] },
      { id: 'sync', requires: ['peer'], ts: 'sync', platforms: ['desktop', 'ios'] },
      { id: 'solo', requires: [], ts: 'solo', platforms: ['android'], permissions: [] },
    )
    expect(validate(manifest, createFsProbe(root))).toEqual([])
  })

  it('V-2 root shapes: array, no capabilities, capabilities not an array', () => {
    expect(strip(validate([]))).toEqual([{ code: 'MANIFEST_SHAPE', path: '' }])
    expect(strip(validate('x'))).toEqual([{ code: 'MANIFEST_SHAPE', path: '' }])
    expect(strip(validate(42))).toEqual([{ code: 'MANIFEST_SHAPE', path: '' }])
    expect(strip(validate({}))).toEqual([{ code: 'MANIFEST_SHAPE', path: '/capabilities' }])
    expect(strip(validate({ capabilities: {} }))).toEqual([{ code: 'MANIFEST_SHAPE', path: '/capabilities' }])
    expect(strip(validate({ capabilities: 'abc' }))).toEqual([{ code: 'MANIFEST_SHAPE', path: '/capabilities' }])
  })

  it('V-3 unknown keys at root and entry, with RFC 6901 escaping and prototype names', () => {
    const rootFindings = validate({ 'a/b': 1, 'c~d': 2, capabilities: [] })
    expect(strip(rootFindings)).toEqual([
      { code: 'UNKNOWN_FIELD', path: '/a~1b' },
      { code: 'UNKNOWN_FIELD', path: '/c~0d' },
    ])
    expect(rootFindings[0].message).toContain('"a/b"')

    const entryFindings = validate(manifestOf(cap('a', { 'x/y': 1 })))
    expect(strip(entryFindings)).toEqual([{ code: 'UNKNOWN_FIELD', path: '/capabilities/0/x~1y' }])

    // Prototype-named keys are ordinary unknown fields, never a lookup hit.
    let protoFindings
    expect(() => {
      protoFindings = validate(
        JSON.parse('{"constructor":1,"hasOwnProperty":2,"toString":3,"__proto__":4,"capabilities":[]}'),
      )
    }).not.toThrow()
    expect(strip(protoFindings)).toEqual([
      { code: 'UNKNOWN_FIELD', path: '/constructor' },
      { code: 'UNKNOWN_FIELD', path: '/hasOwnProperty' },
      { code: 'UNKNOWN_FIELD', path: '/toString' },
      { code: 'UNKNOWN_FIELD', path: '/__proto__' },
    ])
    let entryProto
    expect(() => {
      entryProto = validate(
        JSON.parse('{"capabilities":[{"id":"a","ts":"a","platforms":["ios"],"constructor":1,"hasOwnProperty":2,"toString":3}]}'),
      )
    }).not.toThrow()
    expect(strip(entryProto)).toEqual([
      { code: 'UNKNOWN_FIELD', path: '/capabilities/0/constructor' },
      { code: 'UNKNOWN_FIELD', path: '/capabilities/0/hasOwnProperty' },
      { code: 'UNKNOWN_FIELD', path: '/capabilities/0/toString' },
    ])
  })

  it('V-4 an entry that is not an object is ENTRY_SHAPE, and nothing else for that entry', () => {
    expect(strip(validate(manifestOf(1, cap('a'), null, [], 'x')))).toEqual([
      { code: 'ENTRY_SHAPE', path: '/capabilities/0' },
      { code: 'ENTRY_SHAPE', path: '/capabilities/2' },
      { code: 'ENTRY_SHAPE', path: '/capabilities/3' },
      { code: 'ENTRY_SHAPE', path: '/capabilities/4' },
    ])
  })

  it('V-5 ids: missing, null, and the four invalid shapes; `a` is the shortest valid id', () => {
    const missing = { ts: 'x', platforms: ['ios'] }
    expect(strip(validate(manifestOf(missing)))).toEqual([{ code: 'ID_MISSING', path: '/capabilities/0/id' }])
    expect(strip(validate(manifestOf(cap(null))))).toEqual([{ code: 'ID_SHAPE', path: '/capabilities/0/id' }])
    expect(strip(validate(manifestOf(cap(7))))).toEqual([{ code: 'ID_SHAPE', path: '/capabilities/0/id' }])
    for (const bad of ['Peer', '1peer', 'peer_x', '']) {
      const findings = validate(manifestOf(cap(bad)))
      expect(strip(findings)).toEqual([{ code: 'ID_INVALID', path: '/capabilities/0/id' }])
      expect(findings[0].message).toContain(JSON.stringify(bad))
    }
    expect(validate(manifestOf(cap('a')))).toEqual([])
    expect(validate(manifestOf(cap('a-1'), cap('b2')))).toEqual([])
  })

  it('V-6 requires: not an array, unresolved, self, duplicates, and an invalid id still resolves', () => {
    expect(strip(validate(manifestOf(cap('a', { requires: 'b' }))))).toEqual([
      { code: 'REQUIRES_SHAPE', path: '/capabilities/0/requires' },
    ])
    expect(strip(validate(manifestOf(cap('a', { requires: ['ghost'] }))))).toEqual([
      { code: 'REQUIRES_UNRESOLVED', path: '/capabilities/0/requires/0' },
    ])
    expect(strip(validate(manifestOf(cap('a', { requires: ['a'] }))))).toEqual([
      { code: 'REQUIRES_SELF', path: '/capabilities/0/requires/0' },
    ])
    expect(strip(validate(manifestOf(cap('a', { requires: ['b', 'b'] }), cap('b'))))).toEqual([
      { code: 'REQUIRES_DUPLICATE', path: '/capabilities/0/requires/1' },
    ])
    expect(strip(validate(manifestOf(cap('a', { requires: [1, 'b'] }), cap('b'))))).toEqual([
      { code: 'REQUIRES_SHAPE', path: '/capabilities/0/requires/0' },
    ])
    // An entry whose id fails the pattern is still a node others may require.
    expect(strip(validate(manifestOf(cap('a', { requires: ['Bad'] }), cap('Bad'))))).toEqual([
      { code: 'ID_INVALID', path: '/capabilities/1/id' },
    ])
  })

  it('V-7 cycles: every SCC of size two or more, one finding per member, per-SCC message', () => {
    // (a) a triangle
    const tri = validate(manifestOf(cap('a', { requires: ['b'] }), cap('b', { requires: ['c'] }), cap('c', { requires: ['a'] })))
    expect(strip(tri)).toEqual([
      { code: 'REQUIRES_CYCLE', path: '/capabilities/0/requires' },
      { code: 'REQUIRES_CYCLE', path: '/capabilities/1/requires' },
      { code: 'REQUIRES_CYCLE', path: '/capabilities/2/requires' },
    ])
    for (const f of tri) expect(f.message).toBe('requires cycle among: a, b, c')

    // (b) a two-cycle
    const two = validate(manifestOf(cap('a', { requires: ['b'] }), cap('b', { requires: ['a'] })))
    expect(strip(two)).toEqual([
      { code: 'REQUIRES_CYCLE', path: '/capabilities/0/requires' },
      { code: 'REQUIRES_CYCLE', path: '/capabilities/1/requires' },
    ])
    for (const f of two) expect(f.message).toBe('requires cycle among: a, b')

    // (c) a diamond DAG is not a cycle
    expect(
      validate(manifestOf(cap('a', { requires: ['b', 'c'] }), cap('b', { requires: ['d'] }), cap('c', { requires: ['d'] }), cap('d'))),
    ).toEqual([])

    // (d) p→q, q→[p,r], r→q — one SCC of three
    const pqr = validate(manifestOf(cap('p', { requires: ['q'] }), cap('q', { requires: ['p', 'r'] }), cap('r', { requires: ['q'] })))
    expect(strip(pqr)).toEqual([
      { code: 'REQUIRES_CYCLE', path: '/capabilities/0/requires' },
      { code: 'REQUIRES_CYCLE', path: '/capabilities/1/requires' },
      { code: 'REQUIRES_CYCLE', path: '/capabilities/2/requires' },
    ])
    for (const f of pqr) expect(f.message).toBe('requires cycle among: p, q, r')

    // (e) two disjoint SCCs get distinct messages, not the global cyclic set
    const disjoint = validate(
      manifestOf(cap('a', { requires: ['b'] }), cap('b', { requires: ['a'] }), cap('x', { requires: ['y'] }), cap('y', { requires: ['x'] })),
    )
    expect(disjoint.map((f) => [f.path, f.message])).toEqual([
      ['/capabilities/0/requires', 'requires cycle among: a, b'],
      ['/capabilities/1/requires', 'requires cycle among: a, b'],
      ['/capabilities/2/requires', 'requires cycle among: x, y'],
      ['/capabilities/3/requires', 'requires cycle among: x, y'],
    ])

    // (f) cross-edge closure: x→[a,b], a→x, b→a — all three in one SCC
    const cross = validate(manifestOf(cap('x', { requires: ['a', 'b'] }), cap('a', { requires: ['x'] }), cap('b', { requires: ['a'] })))
    expect(strip(cross)).toEqual([
      { code: 'REQUIRES_CYCLE', path: '/capabilities/0/requires' },
      { code: 'REQUIRES_CYCLE', path: '/capabilities/1/requires' },
      { code: 'REQUIRES_CYCLE', path: '/capabilities/2/requires' },
    ])
    for (const f of cross) expect(f.message).toBe('requires cycle among: a, b, x')

    // (g) field-level cycle before item-level unresolved, in path order
    const mixed = validate(manifestOf(cap('a', { requires: ['ghost', 'b'] }), cap('b', { requires: ['a'] })))
    expect(strip(mixed)).toEqual([
      { code: 'REQUIRES_CYCLE', path: '/capabilities/0/requires' },
      { code: 'REQUIRES_UNRESOLVED', path: '/capabilities/0/requires/0' },
      { code: 'REQUIRES_CYCLE', path: '/capabilities/1/requires' },
    ])

    // (h) an invalid id is still a node in the graph
    const bad = validate(manifestOf(cap('Bad', { requires: ['ui'] }), cap('ui', { requires: ['Bad'] })))
    expect(strip(bad)).toEqual([
      { code: 'ID_INVALID', path: '/capabilities/0/id' },
      { code: 'REQUIRES_CYCLE', path: '/capabilities/0/requires' },
      { code: 'REQUIRES_CYCLE', path: '/capabilities/1/requires' },
    ])
    expect(bad[1].message).toBe('requires cycle among: Bad, ui')
    expect(bad[2].message).toBe('requires cycle among: Bad, ui')
  })

  it('V-8 ts and crate: a name failing the pattern never reaches the probe', () => {
    for (const name of ['', 'peer/ui', '.', '..', '../../etc', 'a\\b']) {
      let findings
      expect(() => {
        findings = validate(manifestOf(cap('a', { ts: name })), throwing)
      }).not.toThrow()
      expect(strip(findings)).toEqual([{ code: 'TS_INVALID', path: '/capabilities/0/ts' }])

      // The entry's valid `ts` may be probed; only the crate lookup must not be.
      expect(() => {
        findings = validate(manifestOf(cap('a', { crate: name })), crateThrowing)
      }).not.toThrow()
      expect(strip(findings)).toEqual([{ code: 'CRATE_INVALID', path: '/capabilities/0/crate' }])
    }
    // Positive control: a valid name does reach the probe.
    expect(() => validate(manifestOf(cap('a', { ts: 'peer' })), throwing)).toThrow(/probe consulted/)
    expect(() => validate(manifestOf(cap('a', { crate: 'tauri-plugin-peer' })), crateThrowing)).toThrow(/probe consulted/)
  })

  it('V-9 platforms: empty, unknown, duplicate, not an array; one and all three pass', () => {
    expect(strip(validate(manifestOf(cap('a', { platforms: [] }))))).toEqual([
      { code: 'PLATFORMS_EMPTY', path: '/capabilities/0/platforms' },
    ])
    expect(strip(validate(manifestOf(cap('a', { platforms: ['web'] }))))).toEqual([
      { code: 'PLATFORMS_UNKNOWN', path: '/capabilities/0/platforms/0' },
    ])
    expect(strip(validate(manifestOf(cap('a', { platforms: ['ios', 'ios'] }))))).toEqual([
      { code: 'PLATFORMS_DUPLICATE', path: '/capabilities/0/platforms/1' },
    ])
    expect(strip(validate(manifestOf(cap('a', { platforms: 'ios' }))))).toEqual([
      { code: 'PLATFORMS_SHAPE', path: '/capabilities/0/platforms' },
    ])
    expect(strip(validate(manifestOf(cap('a', { platforms: ['ios', 3] }))))).toEqual([
      { code: 'PLATFORMS_SHAPE', path: '/capabilities/0/platforms/1' },
    ])
    expect(validate(manifestOf(cap('a', { platforms: ['ios'] })))).toEqual([])
    expect(validate(manifestOf(cap('a', { platforms: ['desktop', 'ios', 'android'] })))).toEqual([])
  })

  it('V-10 plugin and permissions shapes; a repeated permission string is clean', () => {
    expect(strip(validate(manifestOf(cap('a', { plugin: 1 }))))).toEqual([
      { code: 'PLUGIN_SHAPE', path: '/capabilities/0/plugin' },
    ])
    expect(strip(validate(manifestOf(cap('a', { permissions: 'x' }))))).toEqual([
      { code: 'PERMISSIONS_SHAPE', path: '/capabilities/0/permissions' },
    ])
    expect(strip(validate(manifestOf(cap('a', { permissions: [1] }))))).toEqual([
      { code: 'PERMISSIONS_SHAPE', path: '/capabilities/0/permissions/0' },
    ])
    expect(strip(validate(manifestOf(cap('a', { permissions: ['x', 1, 'y'] }))))).toEqual([
      { code: 'PERMISSIONS_SHAPE', path: '/capabilities/0/permissions/1' },
    ])
    expect(validate(manifestOf(cap('a', { plugin: 'peer', permissions: ['a:default', 'a:default'] })))).toEqual([])
  })

  it('V-11 a mixed five-defect manifest reports in decision-6 order, identically on two calls', () => {
    const manifest = manifestOf(
      { id: 'a', extra: 1, platforms: ['desktop'] },
      { id: 'b', requires: ['ghost'], ts: 'b' },
      { id: 'Bad', ts: 'bad', platforms: ['ios'] },
    )
    const expected = [
      { code: 'UNKNOWN_FIELD', path: '/capabilities/0/extra' },
      { code: 'TS_MISSING', path: '/capabilities/0/ts' },
      { code: 'REQUIRES_UNRESOLVED', path: '/capabilities/1/requires/0' },
      { code: 'PLATFORMS_MISSING', path: '/capabilities/1/platforms' },
      { code: 'ID_INVALID', path: '/capabilities/2/id' },
    ]
    const first = validate(manifest)
    const second = validate(manifest)
    expect(strip(first)).toEqual(expected)
    expect(second).toEqual(first)
  })

  it('V-12 null on a known field is present-but-wrong: _SHAPE, never _MISSING', () => {
    expect(strip(validate(manifestOf(cap('a', { requires: null, crate: null, plugin: null, permissions: null }))))).toEqual([
      { code: 'REQUIRES_SHAPE', path: '/capabilities/0/requires' },
      { code: 'CRATE_SHAPE', path: '/capabilities/0/crate' },
      { code: 'PLUGIN_SHAPE', path: '/capabilities/0/plugin' },
      { code: 'PERMISSIONS_SHAPE', path: '/capabilities/0/permissions' },
    ])
    expect(strip(validate(manifestOf({ id: null, ts: null, platforms: null })))).toEqual([
      { code: 'ID_SHAPE', path: '/capabilities/0/id' },
      { code: 'TS_SHAPE', path: '/capabilities/0/ts' },
      { code: 'PLATFORMS_SHAPE', path: '/capabilities/0/platforms' },
    ])
    expect(strip(validate({ $schema: null, capabilities: [] }))).toEqual([
      { code: 'MANIFEST_SHAPE', path: '/$schema' },
    ])
    expect(strip(validate(manifestOf({ id: undefined, ts: 'x', platforms: ['ios'] })))).toEqual([
      { code: 'ID_SHAPE', path: '/capabilities/0/id' },
    ])
  })

  it('V-13 root ordering: unknown keys first, then $schema, then capabilities, whatever the key order', () => {
    const expected = [
      { code: 'UNKNOWN_FIELD', path: '/extra' },
      { code: 'MANIFEST_SHAPE', path: '/$schema' },
      { code: 'MANIFEST_SHAPE', path: '/capabilities' },
    ]
    expect(strip(validate({ extra: 1, $schema: 1, capabilities: {} }))).toEqual(expected)
    expect(strip(validate({ capabilities: {}, $schema: 1, extra: 1 }))).toEqual(expected)
  })

  it('V-14 duplicates: first occurrence owns the id; later ones are ID_DUPLICATE and never graph nodes', () => {
    expect(strip(validate(manifestOf(cap('a', { requires: ['b'] }), cap('b', { requires: ['a'] }), cap('b'))))).toEqual([
      { code: 'REQUIRES_CYCLE', path: '/capabilities/0/requires' },
      { code: 'REQUIRES_CYCLE', path: '/capabilities/1/requires' },
      { code: 'ID_DUPLICATE', path: '/capabilities/2/id' },
    ])
    expect(strip(validate(manifestOf(cap('a', { requires: ['b'] }), cap('b'), cap('b', { requires: ['a'] }))))).toEqual([
      { code: 'ID_DUPLICATE', path: '/capabilities/2/id' },
    ])
    expect(strip(validate(manifestOf(cap('b'), cap('b', { requires: ['b'] }))))).toEqual([
      { code: 'ID_DUPLICATE', path: '/capabilities/1/id' },
      { code: 'REQUIRES_SELF', path: '/capabilities/1/requires/0' },
    ])
  })

  it('V-15 prototype names as ids and requires items are ordinary strings', () => {
    let findings
    expect(() => {
      findings = validate(
        manifestOf(cap('constructor', { requires: ['hasOwnProperty', '__proto__', 'valueOf'] }), cap('a', { requires: ['constructor'] })),
      )
    }).not.toThrow()
    expect(strip(findings)).toEqual([
      { code: 'REQUIRES_UNRESOLVED', path: '/capabilities/0/requires/0' },
      { code: 'REQUIRES_UNRESOLVED', path: '/capabilities/0/requires/1' },
      { code: 'REQUIRES_UNRESOLVED', path: '/capabilities/0/requires/2' },
    ])
    expect(ID_PATTERN.test('constructor')).toBe(true)
  })

  it('V-16 co-occurring findings on one path come in FINDING_CODES order', () => {
    expect(strip(validate(manifestOf(cap('Peer'), cap('Peer'))))).toEqual([
      { code: 'ID_INVALID', path: '/capabilities/0/id' },
      { code: 'ID_INVALID', path: '/capabilities/1/id' },
      { code: 'ID_DUPLICATE', path: '/capabilities/1/id' },
    ])
    expect(strip(validate(manifestOf(cap('s', { requires: ['ghost', 'ghost', 's', 's'] }))))).toEqual([
      { code: 'REQUIRES_UNRESOLVED', path: '/capabilities/0/requires/0' },
      { code: 'REQUIRES_UNRESOLVED', path: '/capabilities/0/requires/1' },
      { code: 'REQUIRES_DUPLICATE', path: '/capabilities/0/requires/1' },
      { code: 'REQUIRES_SELF', path: '/capabilities/0/requires/2' },
      { code: 'REQUIRES_SELF', path: '/capabilities/0/requires/3' },
      { code: 'REQUIRES_DUPLICATE', path: '/capabilities/0/requires/3' },
    ])
  })

  it('V-17 a 50 000-deep chain neither throws nor cycles; a 3 000-ring reports every member', () => {
    const chain = []
    for (let i = 0; i < 50_000; i++) chain.push(cap(`n${i}`, { requires: i + 1 < 50_000 ? [`n${i + 1}`] : [] }))
    let findings
    expect(() => {
      findings = validate(manifestOf(...chain))
    }).not.toThrow()
    expect(findings).toEqual([])

    const ring = []
    for (let i = 0; i < 3000; i++) ring.push(cap(`r${i}`, { requires: [`r${(i + 1) % 3000}`] }))
    expect(() => {
      findings = validate(manifestOf(...ring))
    }).not.toThrow()
    expect(findings).toHaveLength(3000)
    expect(new Set(codesOf(findings))).toEqual(new Set(['REQUIRES_CYCLE']))
    expect(new Set(findings.map((f) => f.message)).size).toBe(1)
  })

  it('V-18 control characters in an unknown key never reach a message raw; the path keeps the raw key', () => {
    const manifest = JSON.parse('{"capabilities":[{"id":"a","ts":"a","platforms":["ios"],"x\\u001by":1,"p\\u2028q":2}]}')
    const findings = validate(manifest)
    expect(strip(findings)).toEqual([
      { code: 'UNKNOWN_FIELD', path: '/capabilities/0/x\u001by' },
      { code: 'UNKNOWN_FIELD', path: '/capabilities/0/p\u2028q' },
    ])
    for (const f of findings) {
      expect(f.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/)
      expect(f.message).toMatch(NO_LINE_BREAKS)
    }
    expect(findings[0].message).toContain('x\\u001by')
    expect(findings[1].message).toContain('"p q"')
  })
})

/* ============================================================ VALIDATE: FS */

describe('validateManifest — the fs probe', () => {
  it('V-FS-1 ts: directory absent, index.ts absent, and a file where the directory should be', () => {
    const root = tmpRoot()
    tsDir(root, 'present')
    tsDir(root, 'noindex', { index: false })
    mkdirSync(join(root, 'src', 'capabilities'), { recursive: true })
    writeFileSync(join(root, 'src', 'capabilities', 'imafile'), '')
    const probe = createFsProbe(root)

    expect(validate(manifestOf(cap('a', { ts: 'present' })), probe)).toEqual([])
    expect(strip(validate(manifestOf(cap('a', { ts: 'absent' })), probe))).toEqual([
      { code: 'TS_DIR_ABSENT', path: '/capabilities/0/ts' },
    ])
    expect(strip(validate(manifestOf(cap('a', { ts: 'noindex' })), probe))).toEqual([
      { code: 'TS_INDEX_ABSENT', path: '/capabilities/0/ts' },
    ])
    expect(strip(validate(manifestOf(cap('a', { ts: 'imafile' })), probe))).toEqual([
      { code: 'TS_DIR_ABSENT', path: '/capabilities/0/ts' },
    ])
  })

  it('V-FS-2 crate: absent, present, wrong type, traversal', () => {
    const root = tmpRoot()
    tsDir(root, 'x')
    crateDir(root, 'tauri-plugin-x')
    const probe = createFsProbe(root)

    expect(strip(validate(manifestOf(cap('a', { crate: 'tauri-plugin-y' })), probe))).toEqual([
      { code: 'CRATE_ABSENT', path: '/capabilities/0/crate' },
    ])
    expect(validate(manifestOf(cap('a', { crate: 'tauri-plugin-x' })), probe)).toEqual([])
    expect(strip(validate(manifestOf(cap('a', { crate: 3 })), probe))).toEqual([
      { code: 'CRATE_SHAPE', path: '/capabilities/0/crate' },
    ])
    expect(strip(validate(manifestOf(cap('a', { crate: 'a/b' })), probe))).toEqual([
      { code: 'CRATE_INVALID', path: '/capabilities/0/crate' },
    ])
  })

  it('V-FS-3 the same manifest against two roots gives different findings', () => {
    const withDir = tmpRoot()
    const without = tmpRoot()
    tsDir(withDir, 'x')
    const manifest = manifestOf(cap('a', { ts: 'x' }))
    expect(validate(manifest, createFsProbe(withDir))).toEqual([])
    expect(strip(validate(manifest, createFsProbe(without)))).toEqual([
      { code: 'TS_DIR_ABSENT', path: '/capabilities/0/ts' },
    ])
  })
})

/* ============================================================== PROPERTIES */

describe('validateManifest — properties', () => {
  it('V-PROP-1 ID_INVALID iff the id fails ID_PATTERN, over generated ids', () => {
    const rng = mulberry32(0x5eed)
    const alphabet = ['a', 'z', 'A', 'Z', '0', '9', '-', '_', '.', ' ']
    for (let i = 0; i < 300; i++) {
      const length = int(rng, 6)
      let id = ''
      for (let k = 0; k < length; k++) id += pick(rng, alphabet)
      const findings = validate(manifestOf(cap(id)))
      const invalid = !ID_PATTERN.test(id)
      expect(strip(findings), JSON.stringify(id)).toEqual(invalid ? [{ code: 'ID_INVALID', path: '/capabilities/0/id' }] : [])
    }
  })

  it('V-PROP-2 TS_INVALID iff the name fails DIR_NAME_PATTERN, and only then is the probe skipped', () => {
    const rng = mulberry32(0x5eed)
    const alphabet = ['a', 'b', '.', '/', '\\', '-', ' ']
    for (let i = 0; i < 300; i++) {
      const length = int(rng, 5)
      let name = ''
      for (let k = 0; k < length; k++) name += pick(rng, alphabet)
      const invalid = !DIR_NAME_PATTERN.test(name)
      if (invalid) {
        let findings
        expect(() => {
          findings = validate(manifestOf(cap('a', { ts: name })), throwing)
        }, JSON.stringify(name)).not.toThrow()
        expect(strip(findings), JSON.stringify(name)).toEqual([{ code: 'TS_INVALID', path: '/capabilities/0/ts' }])
      } else {
        expect(validate(manifestOf(cap('a', { ts: name })), permissive), JSON.stringify(name)).toEqual([])
        expect(() => validate(manifestOf(cap('a', { ts: name })), throwing), JSON.stringify(name)).toThrow(/probe consulted/)
      }
    }
  })

  it('V-PROP-3 platform findings follow the list exactly, over generated lists', () => {
    const rng = mulberry32(0x5eed)
    const pool = ['desktop', 'ios', 'android', 'web', '', 1, null]
    for (let i = 0; i < 300; i++) {
      const length = int(rng, 6)
      const platforms = []
      for (let k = 0; k < length; k++) platforms.push(pick(rng, pool))
      const findings = strip(validate(manifestOf(cap('a', { platforms }))))
      const expected = []
      if (platforms.length === 0) expected.push({ code: 'PLATFORMS_EMPTY', path: '/capabilities/0/platforms' })
      const seen = new Set()
      platforms.forEach((p, k) => {
        const path = `/capabilities/0/platforms/${k}`
        if (typeof p !== 'string') {
          expected.push({ code: 'PLATFORMS_SHAPE', path })
          return
        }
        if (!PLATFORMS.includes(p)) expected.push({ code: 'PLATFORMS_UNKNOWN', path })
        if (seen.has(p)) expected.push({ code: 'PLATFORMS_DUPLICATE', path })
        seen.add(p)
      })
      expect(findings, JSON.stringify(platforms)).toEqual(expected)
    }
  })

  /** A generator of deliberately messy manifests for the ordering laws. */
  function genManifest(rng, { uniqueIds = false } = {}) {
    const ids = ['a', 'b', 'c', 'Bad', 'd-1', 'e']
    const count = 1 + int(rng, 5)
    const entries = []
    const used = new Set()
    for (let i = 0; i < count; i++) {
      let id = pick(rng, ids)
      if (uniqueIds) {
        if (used.has(id)) continue
        used.add(id)
      }
      const entry = {}
      if (rng() < 0.15) entry.zzz = 1
      if (rng() < 0.9) entry.id = rng() < 0.05 ? null : id
      if (rng() < 0.6) {
        const n = int(rng, 4)
        entry.requires = []
        for (let k = 0; k < n; k++) entry.requires.push(rng() < 0.1 ? 7 : rng() < 0.15 ? 'ghost' : pick(rng, ids))
      } else if (rng() < 0.1) entry.requires = 'x'
      if (rng() < 0.9) entry.ts = pick(rng, ['x', 'y', '..', 'a/b', 3])
      if (rng() < 0.9) entry.platforms = pick(rng, [['desktop'], ['ios', 'ios'], ['web'], [], 'ios', ['desktop', 'android']])
      if (rng() < 0.2) entry.crate = pick(rng, ['tauri-plugin-x', 'a/b', 4])
      if (rng() < 0.2) entry.plugin = pick(rng, ['p', 5])
      if (rng() < 0.2) entry.permissions = pick(rng, [['x:y'], 'x', [1, 'z']])
      if (rng() < 0.15) entry['w/q'] = true
      entries.push(entry)
    }
    const manifest = {}
    if (rng() < 0.15) manifest.junk = 1
    if (rng() < 0.3) manifest.$schema = rng() < 0.2 ? 5 : './capabilities.manifest.schema.json'
    manifest.capabilities = entries
    return manifest
  }

  it('V-PROP-4 findings are deterministic, sorted by the decision-6 order, and single-line', () => {
    const rng = mulberry32(0x5eed)
    for (let i = 0; i < 300; i++) {
      const manifest = genManifest(rng)
      const findings = validate(manifest)
      expect(validate(manifest)).toEqual(findings)
      expect(findings, JSON.stringify(manifest)).toEqual([...findings].sort(byRank(manifest)))
      for (const f of findings) {
        expect(f.message).toMatch(NO_LINE_BREAKS)
        expect(FINDING_CODES).toContain(f.code)
      }
    }
  })

  it('V-PROP-5 permuting entries with unique ids permutes the findings’ entry indices', () => {
    const rng = mulberry32(0x5eed)
    for (let i = 0; i < 200; i++) {
      const manifest = genManifest(rng, { uniqueIds: true })
      const n = manifest.capabilities.length
      const order = [...Array(n).keys()]
      for (let k = n - 1; k > 0; k--) {
        const j = int(rng, k + 1)
        ;[order[k], order[j]] = [order[j], order[k]]
      }
      const permuted = { ...manifest, capabilities: order.map((k) => manifest.capabilities[k]) }
      const remap = (path) =>
        path.replace(/^\/capabilities\/(\d+)/, (_, idx) => `/capabilities/${order.indexOf(Number(idx))}`)
      // Codes and paths: messages name the entry index too, and so move with it.
      const expected = strip(validate(manifest))
        .map((f) => ({ ...f, path: remap(f.path) }))
        .sort(byRank(permuted))
      expect(strip(validate(permuted)), JSON.stringify(manifest)).toEqual(expected)
    }
  })

  it('V-PROP-6 REQUIRES_CYCLE agrees with a Floyd–Warshall oracle, message per SCC', () => {
    const rng = mulberry32(0x5eed)
    for (let iter = 0; iter < 150; iter++) {
      const n = 1 + int(rng, 7)
      const ids = [...Array(n).keys()].map((k) => `n${k}`)
      const edges = ids.map(() => [])
      const entries = ids.map((id, i) => {
        const requires = []
        const m = int(rng, 4)
        for (let k = 0; k < m; k++) {
          const t = int(rng, n)
          requires.push(ids[t])
          if (t !== i && !edges[i].includes(t)) edges[i].push(t)
        }
        if (rng() < 0.15) requires.push('ghost')
        return cap(id, { requires })
      })
      // Oracle: reachability by Floyd–Warshall; i is cyclic iff i reaches some
      // j ≠ i that reaches i back; its SCC is every such j plus itself.
      const reach = ids.map((_, i) => ids.map((_, j) => edges[i].includes(j)))
      for (let k = 0; k < n; k++)
        for (let i = 0; i < n; i++)
          for (let j = 0; j < n; j++) if (reach[i][k] && reach[k][j]) reach[i][j] = true
      const expected = []
      ids.forEach((id, i) => {
        const scc = ids.filter((_, j) => j === i || (reach[i][j] && reach[j][i]))
        if (scc.length >= 2) {
          expected.push({ path: `/capabilities/${i}/requires`, message: `requires cycle among: ${[...scc].sort().join(', ')}` })
        }
      })
      const actual = validate(manifestOf(...entries))
        .filter((f) => f.code === 'REQUIRES_CYCLE')
        .map(({ path, message }) => ({ path, message }))
      expect(actual, JSON.stringify(entries)).toEqual(expected)
    }
  })
})

/* ================================================================== PROBE */

describe('createFsProbe', () => {
  it('PR-1 answers for an existing directory and file, and false for the other kind', () => {
    const root = tmpRoot()
    mkdirSync(join(root, 'dir'))
    writeFileSync(join(root, 'file'), '')
    const p = createFsProbe(root)
    expect(p.isDirectory('dir')).toBe(true)
    expect(p.isFile('dir')).toBe(false)
    expect(p.isFile('file')).toBe(true)
    expect(p.isDirectory('file')).toBe(false)
    expect(p.isDirectory('nope')).toBe(false)
    expect(p.isFile('nope')).toBe(false)
  })

  it('PR-2 `..` inside a relative path is a plain join — the probe is not the sandbox, the validator is', () => {
    const root = tmpRoot()
    mkdirSync(join(root, 'sub'))
    const p = createFsProbe(root)
    expect(p.isDirectory('sub/..')).toBe(true)
    expect(p.isDirectory('sub/../sub')).toBe(true)
  })

  it('PR-3 an absolute rel is joined under the root, not taken as-is', () => {
    const root = tmpRoot()
    const p = createFsProbe(root)
    expect(p.isDirectory(root)).toBe(false)
    expect(p.isDirectory('/')).toBe(true) // join(root, '/') is root itself
  })

  it('PR-4 a NUL byte, an over-long name, and a non-string never throw', () => {
    const root = tmpRoot()
    const p = createFsProbe(root)
    expect(() => p.isDirectory('a\u0000b')).not.toThrow()
    expect(p.isDirectory('a\u0000b')).toBe(false)
    expect(p.isFile('a\u0000b')).toBe(false)
    const long = 'x'.repeat(5000)
    expect(p.isDirectory(long)).toBe(false)
    expect(p.isFile(long)).toBe(false)
    expect(p.isDirectory(undefined)).toBe(false)
    expect(p.isFile(3)).toBe(false)
  })
})

/* ============================================================== CONSTANTS */

/** Which case proves which finding code. C-2 checks both directions. */
const REACHED_BY = {
  'P-2': ['MANIFEST_PARSE'],
  'P-3': ['MANIFEST_SHAPE'],
  'V-2': ['MANIFEST_SHAPE'],
  'V-3': ['UNKNOWN_FIELD'],
  'V-4': ['ENTRY_SHAPE'],
  'V-5': ['ID_MISSING', 'ID_SHAPE', 'ID_INVALID'],
  'V-6': ['REQUIRES_SHAPE', 'REQUIRES_UNRESOLVED', 'REQUIRES_SELF', 'REQUIRES_DUPLICATE', 'ID_INVALID'],
  'V-7': ['REQUIRES_CYCLE', 'REQUIRES_UNRESOLVED', 'ID_INVALID'],
  'V-8': ['TS_INVALID', 'CRATE_INVALID'],
  'V-9': ['PLATFORMS_EMPTY', 'PLATFORMS_UNKNOWN', 'PLATFORMS_DUPLICATE', 'PLATFORMS_SHAPE'],
  'V-10': ['PLUGIN_SHAPE', 'PERMISSIONS_SHAPE'],
  'V-11': ['UNKNOWN_FIELD', 'TS_MISSING', 'REQUIRES_UNRESOLVED', 'PLATFORMS_MISSING', 'ID_INVALID'],
  'V-12': ['REQUIRES_SHAPE', 'CRATE_SHAPE', 'PLUGIN_SHAPE', 'PERMISSIONS_SHAPE', 'ID_SHAPE', 'TS_SHAPE', 'PLATFORMS_SHAPE', 'MANIFEST_SHAPE'],
  'V-13': ['UNKNOWN_FIELD', 'MANIFEST_SHAPE'],
  'V-14': ['REQUIRES_CYCLE', 'ID_DUPLICATE', 'REQUIRES_SELF'],
  'V-15': ['REQUIRES_UNRESOLVED'],
  'V-16': ['ID_INVALID', 'ID_DUPLICATE', 'REQUIRES_UNRESOLVED', 'REQUIRES_DUPLICATE', 'REQUIRES_SELF'],
  'V-17': ['REQUIRES_CYCLE'],
  'V-18': ['UNKNOWN_FIELD'],
  'V-FS-1': ['TS_DIR_ABSENT', 'TS_INDEX_ABSENT'],
  'V-FS-2': ['CRATE_ABSENT', 'CRATE_SHAPE', 'CRATE_INVALID'],
  'V-FS-3': ['TS_DIR_ABSENT'],
}

afterEach(() => {
  const id = caseIdOf(expect.getState().currentTestName)
  if (id === null || !(id in REACHED_BY)) return
  const got = emitted.get(id) ?? new Set()
  for (const code of REACHED_BY[id]) {
    expect(got.has(code), `${id} claims to reach ${code} but did not emit it`).toBe(true)
  }
})

describe('constants', () => {
  it('C-1 the exported constants are frozen and the patterns carry no flags', () => {
    for (const list of [PLATFORMS, REQUIRED_FIELDS, ROOT_FIELDS, ENTRY_FIELDS, FINDING_CODES]) {
      expect(Object.isFrozen(list)).toBe(true)
    }
    expect(ID_PATTERN.flags).toBe('')
    expect(DIR_NAME_PATTERN.flags).toBe('')
    expect(PLATFORMS).toEqual(['desktop', 'ios', 'android'])
    expect(REQUIRED_FIELDS).toEqual(['id', 'ts', 'platforms'])
    expect(ROOT_FIELDS).toEqual(['$schema', 'capabilities'])
    expect(ENTRY_FIELDS).toEqual(['id', 'requires', 'ts', 'platforms', 'crate', 'plugin', 'permissions'])
    expect(FINDING_CODES).toEqual([
      'MANIFEST_MISSING', 'MANIFEST_PARSE', 'MANIFEST_SHAPE', 'UNKNOWN_FIELD', 'ENTRY_SHAPE',
      'ID_MISSING', 'ID_SHAPE', 'ID_INVALID', 'ID_DUPLICATE',
      'REQUIRES_SHAPE', 'REQUIRES_UNRESOLVED', 'REQUIRES_SELF', 'REQUIRES_DUPLICATE', 'REQUIRES_CYCLE',
      'TS_MISSING', 'TS_SHAPE', 'TS_INVALID', 'TS_DIR_ABSENT', 'TS_INDEX_ABSENT',
      'PLATFORMS_MISSING', 'PLATFORMS_SHAPE', 'PLATFORMS_EMPTY', 'PLATFORMS_UNKNOWN', 'PLATFORMS_DUPLICATE',
      'CRATE_SHAPE', 'CRATE_INVALID', 'CRATE_ABSENT',
      'PLUGIN_SHAPE', 'PERMISSIONS_SHAPE',
    ])
    expect(new Set(FINDING_CODES).size).toBe(FINDING_CODES.length)
    expect(collapse('  a\r\n b\n\nc\rd\te ')).toBe('a b c d e')
    expect(escapeControls('a\u001bb\u0085c\u2028d\u2029e')).toBe('a\\u001bb\\u0085c\\u2028d\\u2029e')
  })

  it('C-2 every finding code but MANIFEST_MISSING is claimed by a case, and every claim was honoured', () => {
    // MANIFEST_MISSING is the CLI's own code (the file could not be read); the
    // library never emits it — architecture-check.test.mjs covers it.
    const claimed = new Set(Object.values(REACHED_BY).flat())
    for (const code of FINDING_CODES) {
      if (code === 'MANIFEST_MISSING') continue
      expect(claimed.has(code), `${code} is not claimed by any case in REACHED_BY`).toBe(true)
    }
    for (const code of claimed) expect(FINDING_CODES).toContain(code)
    // Every case named in the table exists in this file (a typo here would be a
    // claim nobody checks) — the afterEach above only fires for cases that ran.
    for (const id of Object.keys(REACHED_BY)) {
      expect(emitted.has(id), `${id} is claimed in REACHED_BY but no such case ran before C-2`).toBe(true)
    }
  })
})
