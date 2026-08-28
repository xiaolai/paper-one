import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactKey, ARTIFACTS, bsdtar, sha256, VENDOR, VERSION } from './sync-inference-runtime.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('the pinned artifacts', () => {
  /* WI-15.3's finding, as a table: a redistributable native runtime exists for
   * every desktop platform Paper ships to — including Windows, which the plan
   * named as the kill gate. */
  it('covers every desktop platform the gate was run on', () => {
    expect(artifactKey('darwin', 'arm64')).toBe('darwin-arm64')
    expect(artifactKey('linux', 'x64')).toBe('linux-x64')
    expect(artifactKey('win32', 'x64')).toBe('win32-x64')
  })

  /* Absent is a normal state, at build time as much as at run time. A phone,
   * or a platform with no published artifact, must not fail a build. */
  it('answers null for a platform with no runtime rather than throwing', () => {
    expect(artifactKey('darwin', 'x64')).toBeNull()
    expect(artifactKey('android', 'arm64')).toBeNull()
    expect(artifactKey('ios', 'arm64')).toBeNull()
  })

  it('names a real digest for every entry', () => {
    for (const [key, entry] of Object.entries(ARTIFACTS)) {
      expect(entry.sha256, key).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.sha256, key).not.toBe('0'.repeat(64))
      expect(entry.asset, key).toContain(VERSION)
    }
  })

  it('gives each platform its own distinct archive and digest', () => {
    const digests = new Set(Object.values(ARTIFACTS).map((e) => e.sha256))
    const assets = new Set(Object.values(ARTIFACTS).map((e) => e.asset))
    expect(digests.size).toBe(Object.keys(ARTIFACTS).length)
    expect(assets.size).toBe(Object.keys(ARTIFACTS).length)
  })

  /* `paths::runtime_exe_name` in the Rust plugin looks for exactly these. A
   * mismatch is a runtime that stages fine and is never found. */
  it('names the executable the plugin actually looks for', () => {
    expect(ARTIFACTS['win32-x64'].exe).toBe('lemond.exe')
    for (const key of ['darwin-arm64', 'linux-x64', 'linux-arm64']) {
      expect(ARTIFACTS[key].exe, key).toBe('lemond')
    }
  })
})

describe('sha256', () => {
  /* The published NIST vector. A digest function checked only against its own
   * output proves nothing, and this one decides whether an executable runs. */
  it('matches the published vector', () => {
    expect(sha256(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('the bundle wiring', () => {
  /* The staged path and the path Tauri copies from must agree, and neither
   * can name a platform: `tauri.conf.json` cannot interpolate the host, so a
   * per-platform directory here would silently ship nothing off macOS. */
  it('stages where tauri.conf.json copies from, platform-neutrally', () => {
    const conf = JSON.parse(readFileSync(path.join(REPO_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'))
    const resources = conf.bundle?.resources ?? {}
    const from = Object.keys(resources).find((key) => key.includes('inference'))
    expect(from, 'tauri.conf.json must copy the staged runtime').toBeTruthy()
    expect(from).toContain(VENDOR.split(path.sep).join('/'))
    expect(resources[from]).toBe('runtime/')
    for (const key of Object.keys(ARTIFACTS)) {
      expect(from, 'the bundle path must not name a platform').not.toContain(key)
    }
  })

  /* The plugin resolves `resource_dir()/runtime/lemond`; the bundle must put
   * it under `runtime/` for that to be true. */
  it('lands the runtime where the plugin resolves it', () => {
    const conf = JSON.parse(readFileSync(path.join(REPO_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'))
    expect(Object.values(conf.bundle.resources)).toContain('runtime/')
  })

  /* Compiled artifacts are staged, not committed — the `vendor/pdfjs/`
   * precedent. What IS committed is the digest table above. */
  it('keeps the staged binary out of git', () => {
    const ignore = readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8')
    expect(ignore).toContain('vendor/inference/')
  })

  it('is staged by the build, not only by hand', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts.prebuild).toContain('sync-inference-runtime')
    expect(pkg.scripts.predev).toContain('sync-inference-runtime')
    expect(pkg.scripts['build:desktop']).toContain('sync-inference-runtime')
  })
})

/**
 * WHICH `tar` — the one question the Windows build step got wrong.
 *
 * `unpack` reaches for bsdtar on Windows because it reads zip archives. Plain
 * `tar` does not necessarily name it: Git for Windows ships a GNU tar in its
 * `usr\\bin`, and on `windows-latest` that wins the PATH race. GNU tar cannot
 * read a zip, and it fails without naming either problem — it reads
 * `host:path` as a REMOTE archive, so an ordinary `D:\\a\\paper-one\\…`
 * argument came back as `tar: Cannot connect to D: resolve failed`, exit 128,
 * out of a build step with nothing to do with the network.
 *
 * The resolution is platform-independent code, so it is testable from here.
 */
describe('the tar that reads a zip', () => {
  it('is named by absolute path under SystemRoot, never left to PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'paper-systemroot-'))
    mkdirSync(join(root, 'System32'), { recursive: true })
    writeFileSync(join(root, 'System32', 'tar.exe'), '')
    const was = process.env['SystemRoot']
    process.env['SystemRoot'] = root
    try {
      expect(bsdtar()).toBe(join(root, 'System32', 'tar.exe'))
    } finally {
      if (was === undefined) delete process.env['SystemRoot']
      else process.env['SystemRoot'] = was
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses by name when it is not there, rather than falling back to whatever PATH holds', () => {
    /* A silent fallback is how this failed in the first place: something
       called `tar` ran, did the wrong thing, and blamed the network. */
    const root = mkdtempSync(join(tmpdir(), 'paper-systemroot-'))
    const was = process.env['SystemRoot']
    process.env['SystemRoot'] = root
    try {
      expect(() => bsdtar()).toThrow(/System32/)
      expect(() => bsdtar()).toThrow(/GNU tar/)
    } finally {
      if (was === undefined) delete process.env['SystemRoot']
      else process.env['SystemRoot'] = was
      rmSync(root, { recursive: true, force: true })
    }
  })
})
