import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactKey, ARTIFACTS, bsdtar, isStaged, leaveEmpty, sha256, VENDOR, VERSION } from './sync-inference-runtime.mjs'
import { existsSync } from 'node:fs'

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
  /* ⚠️ **THE RUNTIME IS A DESKTOP RESOURCE, and it moved out of the base
   * config.** It used to sit in `tauri.conf.json`, which every platform merges
   * — so an Android build copied 70 MB of macOS `.dylib`s into the APK, for a
   * platform that cannot load them and does not compose the capability that
   * would use them. It is declared in `tauri.{macos,windows,linux}.conf.json`
   * now; `scripts/check-bundle-resources.test.mjs` is where that arrangement is
   * held together, including the measured fact that Tauri MERGES `resources`
   * and so a mobile config cannot subtract an entry the base declares.
   *
   * The path still cannot name a platform: `tauri.conf.json` cannot interpolate
   * the host, so a per-platform directory would silently ship nothing off
   * macOS. That rule is unchanged and applies to each of the three files. */
  const DESKTOP_CONFS = ['tauri.macos.conf.json', 'tauri.windows.conf.json', 'tauri.linux.conf.json']

  it.each(DESKTOP_CONFS)('%s stages where the script copies to, platform-neutrally', (name) => {
    const conf = JSON.parse(readFileSync(path.join(REPO_ROOT, 'src-tauri', name), 'utf8'))
    const resources = conf.bundle?.resources ?? {}
    const from = Object.keys(resources).find((key) => key.includes('inference'))
    expect(from, `${name} must copy the staged runtime`).toBeTruthy()
    expect(from).toContain(VENDOR.split(path.sep).join('/'))
    /* The plugin resolves `resource_dir()/runtime/lemond`, so the bundle has to
       put it under `runtime/` for that to be true. */
    expect(resources[from]).toBe('runtime/')
    for (const key of Object.keys(ARTIFACTS)) {
      expect(from, 'the bundle path must not name a platform').not.toContain(key)
    }
  })

  /* AND NOT IN THE BASE, which is the half that was wrong. Stated here as well
     as in `check-bundle-resources.test.mjs` because this file is where somebody
     changing the staging will look. */
  it('is not in the base config, which a phone also merges', () => {
    const conf = JSON.parse(readFileSync(path.join(REPO_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'))
    const resources = conf.bundle?.resources ?? {}
    expect(Object.keys(resources).find((key) => key.includes('inference'))).toBeUndefined()
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

/**
 * ⚠️ **THE BUNDLE REQUIRES THIS DIRECTORY, AND THE SCRIPT USED NOT TO MAKE IT.**
 *
 * `tauri.conf.json` maps `../vendor/inference/current/` into the bundle as
 * `runtime/`, and Tauri refuses to build when a declared resource is missing.
 * Three of this script's exits returned without creating it while printing that
 * "the companion's local route will report Absent" — so on any host where the
 * runtime cannot be staged, the app did not degrade, it failed to build:
 *
 *     resource path `..\vendor\inference\current` doesn't exist
 *
 * Found on 2026-08-30, the first time this repository was ever bundled for
 * Windows. It had survived because the Windows CI leg is `cargo check`, which
 * never bundles, and because the macOS fetch had always succeeded.
 *
 * The first case below is the CLASS: it reads the resource list out of
 * `tauri.conf.json` rather than naming the path, so a second declared resource
 * that nothing guarantees fails here rather than in a bundler on a machine
 * nobody has run yet.
 */
describe('the directory the bundle declares', () => {
  /* EVERY CONFIG, not just the base. Tauri merges `tauri.<platform>.conf.json`
     into `tauri.conf.json`, and the inference runtime moved into the three
     DESKTOP ones so a phone would stop carrying it — so the set of declared
     resources is now the union, and a check reading only the base would have
     gone quiet about the very entry it exists for. Read as a list rather than
     named, which is the property the header calls the CLASS. */
  const CONFIGS = [
    'tauri.conf.json',
    'tauri.macos.conf.json',
    'tauri.windows.conf.json',
    'tauri.linux.conf.json',
    'tauri.ios.conf.json',
    'tauri.android.conf.json',
  ]
  const config = {
    bundle: {
      resources: Object.assign(
        {},
        ...CONFIGS.map(
          (name) => JSON.parse(readFileSync(join(REPO_ROOT, 'src-tauri', name), 'utf8')).bundle?.resources ?? {},
        ),
      ),
    },
  }

  /* TRAILING SEPARATORS STRIPPED ON BOTH SIDES. `tauri.conf.json` writes the
     directory resource with a trailing slash — that is how Tauri tells a
     directory from a file — and `path.normalize` keeps it, so a bare compare
     against `VENDOR` missed. */
  const tidy = (one) => path.normalize(one).replace(/[\\/]+$/, '')
  /** Every `bundle.resources` key, as a repo-relative path. */
  const declared = Object.keys(config.bundle?.resources ?? {}).map((one) =>
    tidy(path.join('src-tauri', one)),
  )

  it('is declared by tauri.conf.json, so this test is not vacuous', () => {
    expect(declared.length).toBeGreaterThan(0)
    expect(declared).toContain(tidy(VENDOR))
  })

  /* The other declared resource is a checked-in file; the vendor tree is the
     one nothing checks in, which is why it needs a guarantee rather than a
     hope. */
  it('names a path that exists, or one this script promises to create', () => {
    for (const one of declared) {
      const guaranteed = tidy(one) === tidy(VENDOR)
      expect(
        existsSync(join(REPO_ROOT, one)) || guaranteed,
        `${one} is bundled but nothing guarantees it exists`,
      ).toBe(true)
    }
  })

  it('is created, with a reason, when there is nothing to stage', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'paper-vendor-')), 'current')
    try {
      leaveEmpty(dir, 'A reason a reader can act on.')

      expect(existsSync(dir), 'the bundler needs the directory itself').toBe(true)
      const marker = readFileSync(join(dir, 'RUNTIME-ABSENT.txt'), 'utf8')
      expect(marker).toContain('A reason a reader can act on.')
      expect(marker, 'it must say the app still runs').toMatch(/runs normally/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /* ⚠️ AND IT MUST NOT LOOK STAGED. `isStaged` reads a `.version` stamp; a
     marker mistaken for one would claim a runtime that is not there, which is
     the failure this whole path exists to avoid, inverted. */
  it('does not make an empty tree look like a staged one', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'paper-vendor-')), 'current')
    try {
      leaveEmpty(dir, 'nothing staged')
      expect(isStaged(dir, 'darwin-arm64')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
