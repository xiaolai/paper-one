import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { collapse, createFsProbe, escapeControls, parseManifest, validateManifest } from './lib/architecture.mjs'

/**
 * The CLI, as a user or CI runs it: a child process over a real tree, judged
 * by stdout, stderr and the exit code. The validator itself is proven in
 * `lib/architecture.test.mjs`; these cases prove the thin shell around it —
 * argument handling, the read step, the output format, and that a broken
 * world (missing file, ENOTDIR, ELOOP, control characters) never breaks the
 * one-line-per-finding contract.
 */

const SCRIPT = fileURLToPath(new URL('./architecture-check.mjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST = 'capabilities.manifest.json'
const SUMMARY_SUFFIX = ' (manifest + tree; composition/Cargo/ACL drift is compositions:check)'
const SUMMARY = /^architecture-check: (\d+) capabilities, (\d+) findings \(manifest \+ tree; composition\/Cargo\/ACL drift is compositions:check\)$/

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    ...options,
  })
  if (result.error) throw result.error
  return { code: result.status, out: result.stdout, err: result.stderr }
}

const tmpRoots = []
function tmpRoot() {
  const root = mkdtempSync(join(tmpdir(), 'architecture-check-'))
  tmpRoots.push(root)
  return root
}
afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})

/** A root holding the given manifest text (or none), plus optional tree. */
function fixture(text, { ts = [], crates = [] } = {}) {
  const root = tmpRoot()
  if (text !== null) writeFileSync(join(root, MANIFEST), text)
  for (const name of ts) {
    mkdirSync(join(root, 'src', 'capabilities', name), { recursive: true })
    writeFileSync(join(root, 'src', 'capabilities', name, 'index.ts'), 'export {}\n')
  }
  for (const name of crates) mkdirSync(join(root, 'src-tauri', 'crates', name), { recursive: true })
  return root
}

const complete = JSON.stringify(
  { capabilities: [{ id: 'peer', ts: 'peer', crate: 'tauri-plugin-peer', platforms: ['desktop', 'ios'] }] },
  null,
  2,
)

/** The format the CLI promises, computed independently through the library. */
function expectedOutput(root) {
  let text
  try {
    text = readFileSync(join(root, MANIFEST), 'utf8')
  } catch (cause) {
    const line = `MANIFEST_MISSING (root): ${escapeControls(collapse(`cannot read ${MANIFEST} (${cause.code}): ${cause.message}`))}`
    return { out: `${line}\narchitecture-check: 0 capabilities, 1 findings${SUMMARY_SUFFIX}\n`, code: 1 }
  }
  const { manifest, findings: parseFindings } = parseManifest(text)
  const findings = parseFindings.length ? parseFindings : validateManifest(manifest, createFsProbe(root))
  const count = Array.isArray(manifest?.capabilities) ? manifest.capabilities.length : 0
  const lines = findings.map((f) => `${f.code} ${f.path === '' ? '(root)' : escapeControls(f.path)}: ${f.message}`)
  lines.push(`architecture-check: ${count} capabilities, ${findings.length} findings${SUMMARY_SUFFIX}`)
  return { out: `${lines.join('\n')}\n`, code: findings.length ? 1 : 0 }
}

/** Every path under `root` with its size and mtime, for "the tree is untouched". */
function snapshot(root) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const st = statSync(full)
      out.push(`${relative(root, full)} ${st.isDirectory() ? 'd' : 'f'} ${st.size} ${st.mtimeMs}`)
      if (st.isDirectory()) walk(full)
    }
  }
  walk(root)
  return out.join('\n')
}

const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/

describe('architecture-check', () => {
  it('CLI-1 with no arguments, from a foreign cwd, checks the repository', () => {
    const { code, out, err } = run([], { cwd: tmpdir() })
    expect(err).toBe('')
    // The repository's own manifest, found from a cwd that has none: the count
    // is whatever the tree holds today (one since WI-5.6, none after WI-5.12
    // removes `example`), the findings are the assertion.
    expect(out).toMatch(/^architecture-check: \d+ capabilities, 0 findings \(manifest \+ tree; composition\/Cargo\/ACL drift is compositions:check\)\n$/)
    expect(code).toBe(0)
  })

  it('CLI-2 --root over a complete capability is clean', () => {
    const root = fixture(complete, { ts: ['peer'], crates: ['tauri-plugin-peer'] })
    const { code, out, err } = run(['--root', root])
    expect(err).toBe('')
    expect(out).toBe(`architecture-check: 1 capabilities, 0 findings${SUMMARY_SUFFIX}\n`)
    expect(code).toBe(0)
  })

  it('CLI-3 a missing capability directory is one finding and exit 1', () => {
    const root = fixture(complete, { crates: ['tauri-plugin-peer'] })
    const { code, out, err } = run(['--root', root])
    expect(err).toBe('')
    const lines = out.split('\n')
    expect(lines[0].startsWith('TS_DIR_ABSENT /capabilities/0/ts: ')).toBe(true)
    expect(lines[1]).toBe(`architecture-check: 1 capabilities, 1 findings${SUMMARY_SUFFIX}`)
    expect(lines).toHaveLength(3)
    expect(code).toBe(1)
  })

  it('CLI-4 invalid JSON is MANIFEST_PARSE on one line; a missing manifest is MANIFEST_MISSING', () => {
    const broken = fixture('{\n  "capabilities": [\n    { "id": tru }\n  ]\n}\n')
    let result = run(['--root', broken])
    expect(result.err).toBe('')
    let lines = result.out.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0].startsWith('MANIFEST_PARSE (root): ')).toBe(true)
    expect(lines[1]).toBe(`architecture-check: 0 capabilities, 1 findings${SUMMARY_SUFFIX}`)
    expect(result.code).toBe(1)

    const missing = fixture(null)
    result = run(['--root', missing])
    expect(result.err).toBe('')
    lines = result.out.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0].startsWith('MANIFEST_MISSING (root): ')).toBe(true)
    expect(lines[0]).toContain('ENOENT')
    expect(lines[1]).toBe(`architecture-check: 0 capabilities, 1 findings${SUMMARY_SUFFIX}`)
    expect(result.code).toBe(1)
  })

  it('CLI-5 the text `null` is MANIFEST_SHAPE at the root', () => {
    const root = fixture('null')
    const { code, out, err } = run(['--root', root])
    expect(err).toBe('')
    const lines = out.split('\n')
    expect(lines[0].startsWith('MANIFEST_SHAPE (root): ')).toBe(true)
    expect(lines[1]).toBe(`architecture-check: 0 capabilities, 1 findings${SUMMARY_SUFFIX}`)
    expect(code).toBe(1)
  })

  it('CLI-6 usage errors exit 2 with usage on stderr and nothing on stdout', () => {
    const good = fixture(complete, { ts: ['peer'], crates: ['tauri-plugin-peer'] })
    for (const args of [['--bogus'], ['--root'], ['extra'], ['--root', good, '--bogus'], ['--root', '--bogus'], ['--root=' + good]]) {
      const { code, out, err } = run(args)
      expect(out, args.join(' ')).toBe('')
      expect(err, args.join(' ')).toMatch(/usage: /)
      expect(code, args.join(' ')).toBe(2)
    }
  })

  it('CLI-7 a relative --root resolves against the cwd', () => {
    const root = fixture(complete, { ts: ['peer'], crates: ['tauri-plugin-peer'] })
    const parent = join(root, '..')
    const name = relative(parent, root)
    const { code, out, err } = run(['--root', name], { cwd: parent })
    expect(err).toBe('')
    expect(out).toBe(`architecture-check: 1 capabilities, 0 findings${SUMMARY_SUFFIX}\n`)
    expect(code).toBe(0)
  })

  it('CLI-8 importing the module runs nothing', async () => {
    const written = []
    const originalOut = process.stdout.write
    const originalErr = process.stderr.write
    const originalExit = process.exitCode
    process.stdout.write = (chunk) => {
      written.push(chunk)
      return true
    }
    process.stderr.write = (chunk) => {
      written.push(chunk)
      return true
    }
    try {
      await import('./architecture-check.mjs')
    } finally {
      process.stdout.write = originalOut
      process.stderr.write = originalErr
    }
    expect(written).toEqual([])
    expect(process.exitCode).toBe(originalExit)
  })

  it('CLI-9 the same fixture twice is byte-identical and leaves the tree untouched', () => {
    const root = fixture(complete)
    const before = snapshot(root)
    const first = run(['--root', root])
    const second = run(['--root', root])
    expect(second).toEqual(first)
    expect(first.code).toBe(1)
    expect(snapshot(root)).toBe(before)
  })

  it('CLI-10 package.json binds architecture:check to the script', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts['architecture:check']).toBe('node scripts/architecture-check.mjs')
  })

  it('CLI-11 capabilities of the wrong type counts zero capabilities and one finding', () => {
    const root = fixture('{"capabilities":"abc"}')
    const { code, out, err } = run(['--root', root])
    expect(err).toBe('')
    const lines = out.split('\n')
    expect(lines[0].startsWith('MANIFEST_SHAPE /capabilities: ')).toBe(true)
    expect(lines[1]).toBe(`architecture-check: 0 capabilities, 1 findings${SUMMARY_SUFFIX}`)
    expect(code).toBe(1)
  })

  it('CLI-12 read failures other than ENOENT are still one MANIFEST_MISSING line, no stack', () => {
    const file = join(tmpRoot(), 'a-file')
    writeFileSync(file, '')
    let result = run(['--root', file])
    let lines = result.out.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0].startsWith('MANIFEST_MISSING (root): ')).toBe(true)
    expect(lines[0]).toContain('ENOTDIR')
    expect(lines[1]).toBe(`architecture-check: 0 capabilities, 1 findings${SUMMARY_SUFFIX}`)
    expect(result.err).toBe('')
    expect(result.out).not.toMatch(/^\s+at /m)
    expect(result.code).toBe(1)

    const loop = tmpRoot()
    symlinkSync(join(loop, MANIFEST), join(loop, MANIFEST))
    result = run(['--root', loop])
    lines = result.out.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0].startsWith('MANIFEST_MISSING (root): ')).toBe(true)
    expect(lines[0]).toContain('ELOOP')
    expect(lines[1]).toBe(`architecture-check: 0 capabilities, 1 findings${SUMMARY_SUFFIX}`)
    expect(result.err).toBe('')
    expect(result.out).not.toMatch(/^\s+at /m)
    expect(result.code).toBe(1)
  })

  it('CLI-13 run through a symlink to the script, it still runs and reports', () => {
    const link = join(tmpRoot(), 'architecture-check-link.mjs')
    symlinkSync(SCRIPT, link)
    const result = spawnSync(process.execPath, [link], { encoding: 'utf8', timeout: 30_000, cwd: tmpdir() })
    expect(result.stderr).toBe('')
    expect(result.stdout).toMatch(/^architecture-check: \d+ capabilities, 0 findings \(manifest \+ tree; composition\/Cargo\/ACL drift is compositions:check\)\n$/)
    expect(result.status).toBe(0)
  })

  it('CLI-14 control characters in an unknown key never break one line per finding', () => {
    const root = fixture('{"capabilities":[{"id":"a","ts":"a","platforms":["ios"],"x\\u001by":1,"p\\u2028q\\u000ar":2}]}', { ts: ['a'] })
    const { code, out, err } = run(['--root', root])
    expect(err).toBe('')
    const lines = out.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0].startsWith('UNKNOWN_FIELD /capabilities/0/x\\u001by: ')).toBe(true)
    expect(lines[1].startsWith('UNKNOWN_FIELD /capabilities/0/p\\u2028q\\u000ar: ')).toBe(true)
    expect(lines[2]).toBe(`architecture-check: 1 capabilities, 2 findings${SUMMARY_SUFFIX}`)
    expect(out).not.toMatch(CONTROL)
    expect(code).toBe(1)
  })

  it('CLI-15 an ESC in --root never reaches stdout raw', () => {
    const root = join(tmpRoot(), 'esc\u001bdir')
    mkdirSync(root)
    const { code, out, err } = run(['--root', root])
    expect(err).toBe('')
    const lines = out.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0].startsWith('MANIFEST_MISSING (root): ')).toBe(true)
    expect(lines[0]).toContain('esc\\u001bdir')
    expect(out).not.toMatch(CONTROL)
    expect(code).toBe(1)
  })

  it('CLI-PROP-1 stdout is exactly the library findings, formatted, plus the summary; exit tracks findings', () => {
    const table = [
      { text: null },
      { text: '' },
      { text: 'null' },
      { text: '[]' },
      { text: '{}' },
      { text: '{"capabilities":[]}' },
      { text: '{"$schema":1,"junk":2,"capabilities":{}}' },
      { text: complete },
      { text: complete, ts: ['peer'] },
      { text: complete, ts: ['peer'], crates: ['tauri-plugin-peer'] },
      { text: JSON.stringify({ capabilities: [{ id: 'a', requires: ['b'], ts: 'a', platforms: ['ios'] }, { id: 'b', requires: ['a'], ts: 'b', platforms: ['web', 'ios', 'ios'] }, 5] }), ts: ['a'] },
      { text: JSON.stringify({ capabilities: [{ id: 'Peer', requires: ['Peer', 'ghost'], ts: '../x', crate: 'a/b', plugin: 3, permissions: [1] }] }) },
    ]
    // Seeded generated manifests on top of the table.
    let seed = 0x5eed
    const rng = () => {
      seed = (seed + 0x6d2b79f5) >>> 0
      let t = seed
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pick = (list) => list[Math.floor(rng() * list.length)]
    for (let i = 0; i < 12; i++) {
      const ids = ['a', 'b', 'Bad', 'c']
      const n = 1 + Math.floor(rng() * 4)
      const entries = []
      for (let k = 0; k < n; k++) {
        const entry = { id: pick(ids) }
        if (rng() < 0.7) entry.requires = [pick([...ids, 'ghost'])]
        if (rng() < 0.9) entry.ts = pick(['a', 'b', '..', 'z'])
        if (rng() < 0.9) entry.platforms = pick([['desktop'], ['ios', 'ios'], [], 'x'])
        if (rng() < 0.3) entry.crate = pick(['tauri-plugin-a', 'a/b'])
        if (rng() < 0.2) entry.extra = 1
        entries.push(entry)
      }
      table.push({ text: JSON.stringify({ capabilities: entries }, null, 2), ts: ['a', 'b'], crates: ['tauri-plugin-a'] })
    }

    for (const row of table) {
      const root = fixture(row.text, { ts: row.ts ?? [], crates: row.crates ?? [] })
      const expected = expectedOutput(root)
      const { code, out, err } = run(['--root', root])
      expect(err, row.text ?? '(missing)').toBe('')
      expect(out, row.text ?? '(missing)').toBe(expected.out)
      expect(code, row.text ?? '(missing)').toBe(expected.code)
      expect(SUMMARY.test(out.trimEnd().split('\n').pop())).toBe(true)
    }
  })
})
