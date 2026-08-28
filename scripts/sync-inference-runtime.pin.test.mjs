import { describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ARTIFACTS,
  BACKENDS,
  LLAMACPP_TAG,
  MANIFEST_FILE,
  MANIFEST_VERSION,
  VERSION,
  backendDir,
  buildManifest,
  dereferenceLinks,
  isStaged,
  promote,
  stampFor,
  sweepStale,
} from './sync-inference-runtime.mjs'

/* WI-20.24: the backend is pinned. `lemond` used to fetch llama.cpp from
 * GitHub inside the first gloss with no hash Paper controlled; now the
 * staging script carries the whole backend directory under a per-file
 * manifest the plugin verifies before every spawn. These are the script's
 * half of that promise. */

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sync-runtime-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('the pinned backends', () => {
  /* A runtime without its backend is a runtime that cannot answer once
   * fetching is forbidden, so every platform that gets `lemond` gets a
   * backend, and no platform gets a backend without a `lemond`. */
  it('cover exactly the platforms the runtime does', () => {
    expect(Object.keys(BACKENDS).sort()).toEqual(Object.keys(ARTIFACTS).sort())
  })

  it('name a real, distinct digest each, computed from fetched bytes', () => {
    const digests = new Set()
    for (const [key, entry] of Object.entries(BACKENDS)) {
      expect(entry.sha256, key).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.asset, key).toContain(LLAMACPP_TAG)
      digests.add(entry.sha256)
    }
    expect(digests.size).toBe(Object.keys(BACKENDS).length)
  })

  /* The tag is `lemond`'s own pin for the metal and cpu backends
   * (`resources/backend_versions.json` in the staged runtime), so the
   * bundled backend is the one the daemon would have fetched — not a
   * different version that happened to be current. */
  it('pin the llama.cpp build lemond itself pins', () => {
    expect(LLAMACPP_TAG).toMatch(/^b\d{4,6}$/)
  })

  /* `llamacpp.<backend>_bin` takes the EXECUTABLE'S path and lemond execs it
   * directly, so the server's name has to be the platform's spelling. */
  it('name the server executable the plugin will point lemond at', () => {
    expect(BACKENDS['win32-x64'].server).toBe('llama-server.exe')
    for (const key of ['darwin-arm64', 'linux-x64', 'linux-arm64']) {
      expect(BACKENDS[key].server, key).toBe('llama-server')
    }
    expect(BACKENDS['darwin-arm64'].backend).toBe('metal')
    expect(backendDir('metal').split(path.sep).join('/')).toBe('backend/llamacpp/metal')
  })
})

describe('the stamp', () => {
  /* A tree staged before the backend was part of it carries a stamp in the
   * old shape; it must read as NOT staged, so `predev` re-stages rather
   * than shipping a runtime with no backend under `no_fetch_executables`. */
  it('names the backend pin, so an older stage is re-staged', () => {
    const { dir, done } = scratch()
    try {
      writeFileSync(path.join(dir, '.version'), `${VERSION} darwin-arm64\n`)
      expect(isStaged(dir, 'darwin-arm64')).toBe(false)
      writeFileSync(path.join(dir, '.version'), `${stampFor('darwin-arm64')}\n`)
      expect(isStaged(dir, 'darwin-arm64')).toBe(true)
      expect(stampFor('darwin-arm64')).toContain(LLAMACPP_TAG)
      expect(stampFor('darwin-arm64')).toContain('metal')
    } finally {
      done()
    }
  })
})

describe('buildManifest', () => {
  it('records every file by size and digest, sorted, and nothing else', () => {
    const { dir, done } = scratch()
    try {
      const backend = path.join(dir, 'backend', 'llamacpp', 'metal')
      mkdirSync(backend, { recursive: true })
      mkdirSync(path.join(dir, 'resources'))
      writeFileSync(path.join(dir, 'lemond'), 'abc')
      writeFileSync(path.join(dir, 'resources', 'defaults.json'), '{}')
      writeFileSync(path.join(backend, 'llama-server'), 'server')
      writeFileSync(path.join(backend, 'libggml.0.dylib'), 'lib')
      /* Neither the stamp nor the manifest's own slot nor the Finder's
       * droppings are part of what the plugin verifies. */
      writeFileSync(path.join(dir, '.version'), 'stamp')
      writeFileSync(path.join(dir, MANIFEST_FILE), '{}')
      writeFileSync(path.join(dir, '.DS_Store'), 'finder')

      const manifest = buildManifest(dir, {
        platform: 'darwin-arm64',
        lemonade: VERSION,
        llamacpp: { tag: LLAMACPP_TAG, backend: 'metal', server: 'backend/llamacpp/metal/llama-server' },
      })

      expect(manifest.version).toBe(MANIFEST_VERSION)
      expect(manifest.platform).toBe('darwin-arm64')
      expect(manifest.llamacpp).toEqual({
        tag: LLAMACPP_TAG,
        backend: 'metal',
        server: 'backend/llamacpp/metal/llama-server',
      })
      expect(manifest.files.map((f) => f.path)).toEqual([
        'backend/llamacpp/metal/libggml.0.dylib',
        'backend/llamacpp/metal/llama-server',
        'lemond',
        'resources/defaults.json',
      ])
      expect(manifest.files.find((f) => f.path === 'lemond')).toEqual({
        path: 'lemond',
        bytes: 3,
        // The NIST vector for "abc": the digest is what decides whether an
        // executable runs, so it is checked against a published value.
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      })
    } finally {
      done()
    }
  })

  /* The archives ship bare-name symlinks beside the versioned libraries, and
   * `tauri-build` copies resources with `fs::copy`, which dereferences — so
   * the staged tree must already be what the copy will make of it. A link
   * becomes the file it named; a link that reaches the manifest is refused,
   * as the plugin would refuse it. */
  it('refuses a symbolic link, which dereferenceLinks turns into the file it named', () => {
    const { dir, done } = scratch()
    try {
      const backend = path.join(dir, 'backend', 'llamacpp', 'metal')
      mkdirSync(backend, { recursive: true })
      writeFileSync(path.join(backend, 'llama-server'), 'server')
      writeFileSync(path.join(backend, 'libggml.0.dylib'), 'lib')
      symlinkSync('libggml.0.dylib', path.join(backend, 'libggml.dylib'))
      const meta = {
        platform: 'darwin-arm64',
        lemonade: VERSION,
        llamacpp: { tag: LLAMACPP_TAG, backend: 'metal', server: 'backend/llamacpp/metal/llama-server' },
      }
      expect(() => buildManifest(dir, meta)).toThrow(/symbolic link/)

      dereferenceLinks(dir)

      expect(lstatSync(path.join(backend, 'libggml.dylib')).isSymbolicLink()).toBe(false)
      expect(readFileSync(path.join(backend, 'libggml.dylib'), 'utf8')).toBe('lib')
      const manifest = buildManifest(dir, meta)
      const bare = manifest.files.find((f) => f.path === 'backend/llamacpp/metal/libggml.dylib')
      const versioned = manifest.files.find((f) => f.path === 'backend/llamacpp/metal/libggml.0.dylib')
      expect(bare.sha256).toBe(versioned.sha256)
      expect(bare.bytes).toBe(3)
    } finally {
      done()
    }
  })

  it('refuses a link that leaves the tree rather than copying what it finds there', () => {
    const { dir, done } = scratch()
    try {
      const outside = path.join(dir, '..', `outside-${path.basename(dir)}`)
      writeFileSync(outside, 'secret')
      try {
        symlinkSync(outside, path.join(dir, 'planted'))
        expect(() => dereferenceLinks(dir)).toThrow(/outside the staged tree/)
        expect(existsSync(path.join(dir, 'planted'))).toBe(true)
      } finally {
        rmSync(outside, { force: true })
      }
    } finally {
      done()
    }
  })

  it('refuses a tree whose server is not in it', () => {
    const { dir, done } = scratch()
    try {
      writeFileSync(path.join(dir, 'lemond'), 'abc')
      expect(() =>
        buildManifest(dir, {
          platform: 'darwin-arm64',
          lemonade: VERSION,
          llamacpp: { tag: LLAMACPP_TAG, backend: 'metal', server: 'backend/llamacpp/metal/llama-server' },
        }),
      ).toThrow(/llama-server/)
    } finally {
      done()
    }
  })
})

describe('promote', () => {
  /* Files are replaced by RENAME, never in place: macOS caches a Mach-O's
   * signature in the kernel by inode and does not flush it when the bytes
   * change, so overwriting a staged binary is how a "killed: 9" appears
   * after a re-stage. The new tree lands whole beside the old one, the old
   * one is moved aside, the new one takes its name, and only then is the
   * old one removed. */
  it('replaces the staged tree by rename and removes what it displaced', () => {
    const { dir, done } = scratch()
    try {
      const current = path.join(dir, 'current')
      const staging = `${current}.staging`
      mkdirSync(current)
      writeFileSync(path.join(current, 'lemond'), 'old')
      mkdirSync(staging)
      writeFileSync(path.join(staging, 'lemond'), 'new')

      promote(staging, current)

      expect(readFileSync(path.join(current, 'lemond'), 'utf8')).toBe('new')
      expect(existsSync(staging)).toBe(false)
      expect(existsSync(`${current}.previous`)).toBe(false)
    } finally {
      done()
    }
  })

  it('promotes into an empty slot the same way', () => {
    const { dir, done } = scratch()
    try {
      const current = path.join(dir, 'current')
      const staging = `${current}.staging`
      mkdirSync(staging)
      writeFileSync(path.join(staging, 'lemond'), 'new')
      promote(staging, current)
      expect(readFileSync(path.join(current, 'lemond'), 'utf8')).toBe('new')
      expect(existsSync(`${current}.previous`)).toBe(false)
    } finally {
      done()
    }
  })

  /* An interrupted run leaves `.staging` half-unpacked or `.previous`
   * displaced and never removed. With a LIVE tree standing, both are swept
   * before anything is staged, so a stale `.previous` cannot outlive the run
   * that made it. */
  it('sweeps a stale .staging and .previous left by an interrupted run', () => {
    const { dir, done } = scratch()
    try {
      const current = path.join(dir, 'current')
      mkdirSync(current)
      writeFileSync(path.join(current, 'lemond'), 'live')
      mkdirSync(`${current}.staging`)
      writeFileSync(path.join(`${current}.staging`, 'half'), '')
      mkdirSync(`${current}.previous`)
      writeFileSync(path.join(`${current}.previous`, 'lemond'), 'stale')

      sweepStale(current)

      expect(existsSync(`${current}.staging`)).toBe(false)
      expect(existsSync(`${current}.previous`)).toBe(false)
      expect(readFileSync(path.join(current, 'lemond'), 'utf8')).toBe('live')
    } finally {
      done()
    }
  })

  /* The one window `promote` documents — a kill between its two renames —
   * leaves `.previous` as the ONLY complete runtime and the live name empty.
   * The sweep used to delete it there and bet on the network to replace it;
   * it is restored by rename instead, and the stamp check then says staged. */
  it('restores a .previous whose live tree a mid-promotion kill emptied, rather than deleting it', () => {
    const { dir, done } = scratch()
    try {
      const current = path.join(dir, 'current')
      mkdirSync(`${current}.previous`)
      writeFileSync(path.join(`${current}.previous`, 'lemond'), 'displaced')
      mkdirSync(`${current}.staging`)
      writeFileSync(path.join(`${current}.staging`, 'half'), '')

      sweepStale(current)

      expect(readFileSync(path.join(current, 'lemond'), 'utf8')).toBe('displaced')
      expect(existsSync(`${current}.previous`)).toBe(false)
      expect(existsSync(`${current}.staging`)).toBe(false)
    } finally {
      done()
    }
  })
})
