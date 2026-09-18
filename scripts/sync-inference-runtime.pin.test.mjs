import { describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BACKENDS,
  KEEP_RULE,
  LLAMACPP_TAG,
  MANIFEST_FILE,
  MANIFEST_VERSION,
  backendDir,
  buildManifest,
  dereferenceLinks,
  discardStale,
  isStaged,
  promote,
  stampFor,
  sweepStale,
  takeStagingLock,
  trimToServer,
} from './sync-inference-runtime.mjs'

/* WI-20.24: the runtime is pinned. `lemond` used to fetch llama.cpp from
 * GitHub inside the first gloss with no hash Paper controlled; the staging
 * script then carried the whole backend directory under a per-file manifest
 * the plugin verifies before every spawn — and since 2026-09-18, when the
 * plugin started launching `llama-server` directly, that directory is the
 * whole runtime. These are the script's half of that promise. */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** A pin as `stage` passes it: the tag, the backend, the server's path. */
const METAL = Object.freeze({ tag: LLAMACPP_TAG, backend: 'metal', server: 'backend/llamacpp/metal/llama-server' })

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sync-runtime-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('the pinned backends', () => {
  /* THE FOUR DESKTOP PLATFORMS, by name. This used to be derived — "exactly
   * the platforms `lemond` is pinned for" — and with that table gone a derived
   * answer would compare the table with itself. A platform added or dropped
   * is a decision about what ships, so it fails here and is made on purpose. */
  it('cover the four desktop platforms, and nothing else', () => {
    expect(Object.keys(BACKENDS).sort()).toEqual(['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64'])
  })

  it('name a real, distinct digest each, computed from fetched bytes', () => {
    const digests = new Set()
    const assets = new Set()
    for (const [key, entry] of Object.entries(BACKENDS)) {
      expect(entry.sha256, key).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.sha256, `${key} carries a placeholder, not a digest`).not.toBe('0'.repeat(64))
      expect(entry.asset, key).toContain(LLAMACPP_TAG)
      digests.add(entry.sha256)
      assets.add(entry.asset)
    }
    expect(digests.size).toBe(Object.keys(BACKENDS).length)
    expect(assets.size, 'two platforms would unpack one archive').toBe(Object.keys(BACKENDS).length)
  })

  /* The tag is Paper's own pin now — it began as `lemond`'s — and the asset
   * names and the release URL are both built from it, so it has to be in the
   * shape llama.cpp tags its releases with. */
  it('pin a llama.cpp build by its release tag', () => {
    expect(LLAMACPP_TAG).toMatch(/^b\d{4,6}$/)
  })

  /* The manifest's `llamacpp.server` is the path the plugin EXECS, so the
   * server's name has to be the platform's spelling. */
  it('name the server executable the plugin launches', () => {
    expect(BACKENDS['win32-x64'].server).toBe('llama-server.exe')
    for (const key of ['darwin-arm64', 'linux-x64', 'linux-arm64']) {
      expect(BACKENDS[key].server, key).toBe('llama-server')
    }
    expect(BACKENDS['darwin-arm64'].backend).toBe('metal')
    expect(backendDir('metal').split(path.sep).join('/')).toBe('backend/llamacpp/metal')
  })
})

describe('the stamp', () => {
  /* A tree staged before the backend was part of it carries a stamp in an
   * older shape — Lemonade's version and the key, `11.7.0 darwin-arm64` — and
   * must read as NOT staged, so `predev` re-stages it. */
  it('names the backend pin, so an older stage is re-staged', () => {
    const { dir, done } = scratch()
    try {
      writeFileSync(path.join(dir, '.version'), '11.7.0 darwin-arm64\n')
      expect(isStaged(dir, 'darwin-arm64')).toBe(false)
      writeFileSync(path.join(dir, '.version'), `${stampFor('darwin-arm64')}\n`)
      expect(isStaged(dir, 'darwin-arm64')).toBe(true)
      expect(stampFor('darwin-arm64')).toContain(LLAMACPP_TAG)
      expect(stampFor('darwin-arm64')).toContain('metal')
    } finally {
      done()
    }
  })

  /* ⚠️ A LEMOND-ERA TREE MUST RE-STAGE EVEN WHEN ITS LLAMA.CPP PIN IS TODAY'S.
   * Its stamp names the same tag and backend this one does; what differs is
   * the daemon it carries and a version-1 manifest `runtime.rs` refuses, so
   * keeping it would fail every launch at verification. The stamp's shape
   * changed on 2026-09-18 for exactly this, and this is what holds it. */
  it("reads a lemond-era stamp as not staged, even one naming today's llama.cpp pin", () => {
    const { dir, done } = scratch()
    try {
      for (const [key, { backend }] of Object.entries(BACKENDS)) {
        writeFileSync(path.join(dir, '.version'), `11.7.0 ${key} llamacpp-${LLAMACPP_TAG} ${backend}\n`)
        expect(isStaged(dir, key), key).toBe(false)
      }
      expect(stampFor('darwin-arm64')).toBe(`llamacpp-${LLAMACPP_TAG} darwin-arm64 metal ${KEEP_RULE}`)
    } finally {
      done()
    }
  })

  /* ⚠️ AND A TREE STAGED WHOLE MUST RE-STAGE, though pin and backend match.
   * Before `trimToServer` the tree held every tool llama.cpp ships and every
   * library three times, under a manifest that describes all of it, so the
   * plugin's check passes it. Only the stamp can tell it apart. */
  it('reads a stamp written before the trim as not staged', () => {
    const { dir, done } = scratch()
    try {
      for (const [key, { backend }] of Object.entries(BACKENDS)) {
        writeFileSync(path.join(dir, '.version'), `llamacpp-${LLAMACPP_TAG} ${key} ${backend}\n`)
        expect(isStaged(dir, key), key).toBe(false)
        writeFileSync(path.join(dir, '.version'), `${stampFor(key)}\n`)
        expect(isStaged(dir, key), key).toBe(true)
      }
      expect(stampFor('darwin-arm64').split(' ').at(-1)).toBe(KEEP_RULE)
    } finally {
      done()
    }
  })
})

/** Mach-O, ELF and PE, by their first bytes. */
const MACHO = [0xcf, 0xfa, 0xed, 0xfe]
const ELF = [0x7f, 0x45, 0x4c, 0x46]
const PE = [0x4d, 0x5a]

/**
 * A binary in miniature: its magic, then every name it records — a
 * dependency, or its own name — NUL-terminated, the way all three formats
 * store one.
 */
function binary(magic, ...records) {
  return Buffer.concat([Buffer.from(magic), ...records.map((name) => Buffer.from(`${name}\0`))])
}

/** Write `files` — name to bytes, or to `{ link }` — into `dir`. */
function release(dir, files) {
  for (const [name, bytes] of Object.entries(files)) {
    if (typeof bytes === 'object' && 'link' in bytes) symlinkSync(bytes.link, path.join(dir, name))
    else writeFileSync(path.join(dir, name), bytes)
  }
}

/**
 * THE RULE, on each platform's spelling of the same release. What it must
 * drop is every program but the server — `ggml-rpc-server` among them,
 * which is a network server — and every other tool's `-impl` library; what
 * it must keep is the server, its own `-impl`, every other library, and what
 * cannot run.
 */
describe('trimToServer', () => {
  const PLATFORMS = [
    {
      platform: 'macOS',
      server: 'llama-server',
      files: {
        'llama-server': binary(MACHO, 'libllama-server-impl.dylib'),
        'libllama-server-impl.dylib': binary(MACHO, 'libggml-rpc.0.dylib'),
        'libggml-rpc.0.dylib': binary(MACHO),
        'llama-cli': binary(MACHO, 'libllama-cli-impl.dylib'),
        'libllama-cli-impl.dylib': binary(MACHO),
        'ggml-rpc-server': binary(MACHO, 'libggml-rpc.0.dylib'),
        llama: binary(MACHO, 'libllama-cli-impl.dylib', 'libllama-server-impl.dylib'),
        LICENSE: 'MIT',
      },
      kept: ['LICENSE', 'libggml-rpc.0.dylib', 'libllama-server-impl.dylib', 'llama-server'],
    },
    {
      platform: 'Linux',
      server: 'llama-server',
      files: {
        'llama-server': binary(ELF, 'libllama-server-impl.so'),
        'libllama-server-impl.so': binary(ELF, 'libggml-base.so.0'),
        'libggml-base.so.0.19.0': binary(ELF, 'libggml-base.so.0'),
        'libggml-cpu-haswell.so': binary(ELF),
        'llama-quantize': binary(ELF, 'libllama-quantize-impl.so'),
        'libllama-quantize-impl.so': binary(ELF),
        LICENSE: 'MIT',
      },
      kept: ['LICENSE', 'libggml-base.so.0.19.0', 'libggml-cpu-haswell.so', 'libllama-server-impl.so', 'llama-server'],
    },
    {
      platform: 'Windows',
      server: 'llama-server.exe',
      files: {
        'llama-server.exe': binary(PE, 'llama-server-impl.dll'),
        'llama-server-impl.dll': binary(PE, 'ggml.dll'),
        'ggml.dll': binary(PE, 'libomp140.x86_64.dll'),
        'libomp140.x86_64.dll': binary(PE),
        'ggml-cpu-haswell.dll': binary(PE),
        'llama-tts.exe': binary(PE),
        'llama-cli-impl.dll': binary(PE),
      },
      kept: ['ggml-cpu-haswell.dll', 'ggml.dll', 'libomp140.x86_64.dll', 'llama-server-impl.dll', 'llama-server.exe'],
    },
  ]

  it.each(PLATFORMS)('keeps only the server, its libraries and what cannot run, as $platform spells them', ({ server, files, kept }) => {
    const { dir, done } = scratch()
    try {
      release(dir, files)

      const result = trimToServer(dir, server)

      expect(result.kept).toEqual(kept)
      expect(result.dropped).toEqual(Object.keys(files).filter((name) => !kept.includes(name)).sort())
      expect(readdirSync(dir).sort(), 'what it reports is what is on disk').toEqual(kept)
      for (const name of kept) {
        expect(readFileSync(path.join(dir, name)), name).toEqual(Buffer.from(files[name]))
      }
    } finally {
      done()
    }
  })

  /* The stamp names the rule so that a tree staged under another one is
   * replaced; it only does that if the name moves when the rule does. Here
   * the two sit in ONE assertion, so whoever changes what the rule keeps is
   * looking at `KEEP_RULE` when they update the expectation. */
  it('is the rule the stamp names', () => {
    const { dir, done } = scratch()
    try {
      const { files, server } = PLATFORMS[0]
      release(dir, files)
      expect({ rule: KEEP_RULE, kept: trimToServer(dir, server).kept }).toEqual({
        rule: 'server-only-1',
        kept: ['LICENSE', 'libggml-rpc.0.dylib', 'libllama-server-impl.dylib', 'llama-server'],
      })
    } finally {
      done()
    }
  })

  /* A PROGRAM IS WHATEVER THE KERNEL WILL RUN, not whatever lacks an
   * extension. A script with an interpreter line goes, in each Mach-O
   * shape; a data file the server might read — Metal's shader library once
   * shipped beside it — stays. */
  it('drops a script and every Mach-O shape, and keeps a file nothing can run', () => {
    const { dir, done } = scratch()
    try {
      release(dir, {
        'llama-server': binary(MACHO),
        'convert.py': '#!/usr/bin/env python3\n',
        'llama-bench-32': binary([0xce, 0xfa, 0xed, 0xfe]),
        'llama-bench-be64': binary([0xfe, 0xed, 0xfa, 0xcf]),
        'llama-bench-be32': binary([0xfe, 0xed, 0xfa, 0xce]),
        'llama-bench-universal': binary([0xca, 0xfe, 0xba, 0xbe]),
        'default.metallib': 'MTLB',
      })

      expect(trimToServer(dir, 'llama-server')).toEqual({
        kept: ['default.metallib', 'llama-server'],
        dropped: [
          'convert.py',
          'llama-bench-32',
          'llama-bench-be32',
          'llama-bench-be64',
          'llama-bench-universal',
        ],
      })
    } finally {
      done()
    }
  })

  /* ONE NAME PER LIBRARY, the one the loader is asked for. The real archive
   * carries `libggml.so.0.19.0` with `libggml.so.0` and `libggml.so` linked
   * to it; the binaries record `libggml.so.0`. Keeping the name `libggml.so`
   * too would be a substring match — it is the start of `libggml.so.0` —
   * which the NUL after the name rules out. */
  it('keeps the one name a kept binary records, as a regular file with the library’s bytes', () => {
    const { dir, done } = scratch()
    try {
      const library = binary(ELF, 'libggml.so.0')
      release(dir, {
        'llama-server': binary(ELF, 'libggml.so.0'),
        'libggml.so.0.19.0': library,
        'libggml.so.0': { link: 'libggml.so.0.19.0' },
        'libggml.so': { link: 'libggml.so.0' },
      })

      const result = trimToServer(dir, 'llama-server')

      expect(result).toEqual({
        kept: ['libggml.so.0', 'llama-server'],
        dropped: ['libggml.so', 'libggml.so.0.19.0'],
      })
      expect(lstatSync(path.join(dir, 'libggml.so.0')).isSymbolicLink()).toBe(false)
      expect(readFileSync(path.join(dir, 'libggml.so.0'))).toEqual(library)
      expect(readdirSync(dir).sort()).toEqual(['libggml.so.0', 'llama-server'])
    } finally {
      done()
    }
  })

  /* A LIBRARY NOTHING NAMES KEEPS EVERY NAME. A backend ggml's registry
   * finds by scanning is named by no dependency list, so nothing in the
   * bytes says which name the scan will look for — and a library's record of
   * its own name (`DT_SONAME`) is not somebody asking for it. Nor is a
   * DROPPED tool's load command. */
  it('keeps every name of a library that only it, or a dropped tool, records', () => {
    const { dir, done } = scratch()
    try {
      release(dir, {
        'llama-server': binary(ELF),
        'libggml-cpu.so.0': binary(ELF, 'libggml-cpu.so.0'),
        'libggml-cpu.so': { link: 'libggml-cpu.so.0' },
        'llama-cli': binary(ELF, 'libggml-cpu.so'),
      })

      expect(trimToServer(dir, 'llama-server')).toEqual({
        kept: ['libggml-cpu.so', 'libggml-cpu.so.0', 'llama-server'],
        dropped: ['llama-cli'],
      })
      expect(lstatSync(path.join(dir, 'libggml-cpu.so')).isSymbolicLink()).toBe(false)
    } finally {
      done()
    }
  })

  /* A NEW SHAPE IS A NEW DECISION. llama.cpp's releases are flat; a
   * directory in one is something the rule has never been asked about, and
   * it is refused before anything is removed. */
  it('refuses a release that is not flat, and removes nothing', () => {
    const { dir, done } = scratch()
    try {
      release(dir, { 'llama-server': binary(MACHO), 'llama-cli': binary(MACHO) })
      mkdirSync(path.join(dir, 'kernels'))

      expect(() => trimToServer(dir, 'llama-server')).toThrow(/kernels is not a file; the keep rule was written for a flat release/)
      expect(readdirSync(dir).sort()).toEqual(['kernels', 'llama-cli', 'llama-server'])
    } finally {
      done()
    }
  })

  it('refuses a link to nothing, by name', () => {
    const { dir, done } = scratch()
    try {
      release(dir, { 'llama-server': binary(MACHO), 'libggml.dylib': { link: 'libggml.0.dylib' } })

      expect(() => trimToServer(dir, 'llama-server')).toThrow(/libggml\.dylib links to nothing \(libggml\.0\.dylib\)/)
      expect(existsSync(path.join(dir, 'llama-server'))).toBe(true)
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
      writeFileSync(path.join(backend, 'LICENSE'), 'abc')
      writeFileSync(path.join(backend, 'llama-server'), 'server')
      writeFileSync(path.join(backend, 'libggml.0.dylib'), 'lib')
      /* Neither the stamp nor the manifest's own slot nor the Finder's
       * droppings are part of what the plugin verifies. */
      writeFileSync(path.join(dir, '.version'), 'stamp')
      writeFileSync(path.join(dir, MANIFEST_FILE), '{}')
      writeFileSync(path.join(dir, '.DS_Store'), 'finder')

      const manifest = buildManifest(dir, { platform: 'darwin-arm64', llamacpp: METAL })

      expect(manifest.version).toBe(MANIFEST_VERSION)
      expect(manifest.platform).toBe('darwin-arm64')
      expect(manifest.llamacpp).toEqual({
        tag: LLAMACPP_TAG,
        backend: 'metal',
        server: 'backend/llamacpp/metal/llama-server',
      })
      expect(manifest.files.map((f) => f.path)).toEqual([
        'backend/llamacpp/metal/LICENSE',
        'backend/llamacpp/metal/libggml.0.dylib',
        'backend/llamacpp/metal/llama-server',
      ])
      expect(manifest.files.find((f) => f.path === 'backend/llamacpp/metal/LICENSE')).toEqual({
        path: 'backend/llamacpp/metal/LICENSE',
        bytes: 3,
        // The NIST vector for "abc": the digest is what decides whether an
        // executable runs, so it is checked against a published value.
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      })
    } finally {
      done()
    }
  })

  /* `runtime.rs` reads the manifest with `deny_unknown_fields`, at the top
   * level and in every entry, so one stray key — the old `lemonade`, say —
   * refuses every spawn. `buildManifest` builds its result from named fields
   * rather than spreading the caller's, and this is what holds it to that. */
  it('writes exactly the fields runtime.rs reads, whatever else the caller passes', () => {
    const { dir, done } = scratch()
    try {
      const backend = path.join(dir, 'backend', 'llamacpp', 'metal')
      mkdirSync(backend, { recursive: true })
      writeFileSync(path.join(backend, 'llama-server'), 'server')

      const manifest = buildManifest(dir, {
        platform: 'darwin-arm64',
        lemonade: '11.7.0',
        llamacpp: { ...METAL, bin: 'backend/llamacpp/metal/llama-cli' },
      })

      expect(Object.keys(manifest)).toEqual(['version', 'platform', 'llamacpp', 'files'])
      expect(manifest.llamacpp).toEqual(METAL)
      expect(Object.keys(manifest.files[0])).toEqual(['path', 'bytes', 'sha256'])
    } finally {
      done()
    }
  })

  /* And the version is the one `runtime.rs` reads, which refuses every other.
   * Read out of the Rust source rather than restated, so bumping either side
   * alone fails here; the Rust half of the same pin is
   * `the_manifest_the_script_writes_parses`. */
  it('carries the manifest version runtime.rs reads', () => {
    const rust = readFileSync(
      path.join(REPO_ROOT, 'src-tauri', 'crates', 'tauri-plugin-inference', 'src', 'runtime.rs'),
      'utf8',
    )
    const declared = /pub const RUNTIME_MANIFEST_VERSION: u32 = (\d+);/.exec(rust)
    expect(declared, 'runtime.rs no longer declares RUNTIME_MANIFEST_VERSION where this looks').not.toBeNull()
    expect(MANIFEST_VERSION).toBe(Number(declared[1]))
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
      const meta = { platform: 'darwin-arm64', llamacpp: METAL }
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

  /* llama.cpp's other tools ship in the same archive, and none of them is the
   * server: a tree holding them and not it is a runtime that cannot answer. */
  it('refuses a tree whose server is not in it', () => {
    const { dir, done } = scratch()
    try {
      const backend = path.join(dir, 'backend', 'llamacpp', 'metal')
      mkdirSync(backend, { recursive: true })
      writeFileSync(path.join(backend, 'llama-cli'), 'cli')
      expect(() => buildManifest(dir, { platform: 'darwin-arm64', llamacpp: METAL })).toThrow(/llama-server/)
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
      writeFileSync(path.join(current, 'llama-server'), 'old')
      mkdirSync(staging)
      writeFileSync(path.join(staging, 'llama-server'), 'new')

      promote(staging, current)

      expect(readFileSync(path.join(current, 'llama-server'), 'utf8')).toBe('new')
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
      writeFileSync(path.join(staging, 'llama-server'), 'new')
      promote(staging, current)
      expect(readFileSync(path.join(current, 'llama-server'), 'utf8')).toBe('new')
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
      writeFileSync(path.join(current, 'llama-server'), 'live')
      mkdirSync(`${current}.staging`)
      writeFileSync(path.join(`${current}.staging`, 'half'), '')
      mkdirSync(`${current}.previous`)
      writeFileSync(path.join(`${current}.previous`, 'llama-server'), 'stale')

      sweepStale(current)

      expect(existsSync(`${current}.staging`)).toBe(false)
      expect(existsSync(`${current}.previous`)).toBe(false)
      expect(readFileSync(path.join(current, 'llama-server'), 'utf8')).toBe('live')
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
      writeFileSync(path.join(`${current}.previous`, 'llama-server'), 'displaced')
      mkdirSync(`${current}.staging`)
      writeFileSync(path.join(`${current}.staging`, 'half'), '')

      sweepStale(current)

      expect(readFileSync(path.join(current, 'llama-server'), 'utf8')).toBe('displaced')
      expect(existsSync(`${current}.previous`)).toBe(false)
      expect(existsSync(`${current}.staging`)).toBe(false)
    } finally {
      done()
    }
  })
})

/**
 * A TREE THE PIN NO LONGER DESCRIBES MUST NOT SURVIVE A FAILED FETCH.
 *
 * The header promises the stamp makes a platform switch or a version bump
 * re-stage "rather than shipping the wrong binary", and that held only while
 * the download worked. Offline, with the pin bumped, the stamp said "not
 * staged", both fetches answered null, and the run returned having touched
 * nothing — so the bundle took the PREVIOUS pin's executable, and every check
 * downstream agreed with it, because the old tree's manifest describes the
 * old tree perfectly.
 */
describe('discardStale', () => {
  const key = 'darwin-arm64'

  it('removes a tree staged for another pin, and says there was one', () => {
    const { dir, done } = scratch()
    try {
      const current = path.join(dir, 'current')
      mkdirSync(current)
      writeFileSync(path.join(current, 'llama-server'), 'an older pin')
      writeFileSync(path.join(current, '.version'), 'llamacpp-b0 darwin-arm64 cpu\n')

      expect(discardStale(current, key)).toBe(true)
      expect(existsSync(current)).toBe(false)
    } finally {
      done()
    }
  })

  it('leaves a tree that matches the pin, and answers false for one that is not there', () => {
    const { dir, done } = scratch()
    try {
      const current = path.join(dir, 'current')
      mkdirSync(current)
      writeFileSync(path.join(current, 'llama-server'), 'this pin')
      writeFileSync(path.join(current, '.version'), `${stampFor(key)}\n`)

      expect(isStaged(current, key)).toBe(true)
      expect(discardStale(current, key)).toBe(false)
      expect(readFileSync(path.join(current, 'llama-server'), 'utf8')).toBe('this pin')
      expect(discardStale(path.join(dir, 'nothing-here'), key)).toBe(false)
    } finally {
      done()
    }
  })

  /* A HOST WITH NO PUBLISHED ARTIFACT MAKES EVERY TREE STALE. `VENDOR` cannot
     name a platform — `tauri.conf.json` has no way to interpolate one — so a
     tree staged on another machine is one this build would copy into its
     bundle whatever it holds. `artifactKey` answers null there, and a stamp
     cannot even be computed for comparison. */
  it('discards any tree at all when no artifact exists for this host', () => {
    const { dir, done } = scratch()
    try {
      const current = path.join(dir, 'current')
      mkdirSync(current)
      writeFileSync(path.join(current, '.version'), `${stampFor(key)}\n`)
      expect(discardStale(current, null)).toBe(true)
      expect(existsSync(current)).toBe(false)
      expect(discardStale(current, null)).toBe(false)
    } finally {
      done()
    }
  })
})

/**
 * ONE SYNC AT A TIME. `.staging` and `.previous` are named for the live tree
 * and shared by every run, and `sweepStale` deletes both before it begins —
 * so `predev` in one terminal and `prebuild` in another delete each other's
 * work, and the loser promotes a tree missing half its files under a manifest
 * that describes it perfectly.
 */
describe('takeStagingLock', () => {
  it('is taken once, refused while it is held, and free again after release', () => {
    const { dir, done } = scratch()
    try {
      const current = path.join(dir, 'current')
      const release = takeStagingLock(current)
      expect(release).not.toBeNull()
      expect(existsSync(`${current}.lock`)).toBe(true)
      /* A DIFFERENT live process — this one, seen from another pid's point of
         view — must be refused. `process.pid` is the pid this test knows is
         running, which is what makes the refusal a real answer rather than a
         guess about a number. */
      expect(takeStagingLock(current, process.pid + 1)).toBeNull()
      release()
      expect(existsSync(`${current}.lock`)).toBe(false)
      const again = takeStagingLock(current)
      expect(again).not.toBeNull()
      again()
    } finally {
      done()
    }
  })

  /* A LOCK NOBODY HOLDS MUST NOT BLOCK EVERY LATER RUN. A hard kill leaves
     the directory behind; a sync that refused forever after one `ctrl-c`
     would be worse than the race it prevents. */
  it('reclaims a lock whose holder is gone, and one that never recorded a holder', () => {
    const { dir, done } = scratch()
    try {
      const current = path.join(dir, 'current')
      /* Pid 2^22 + 1 is above every system's `pid_max`, so it names no
         process on any machine this runs on. */
      mkdirSync(`${current}.lock`, { recursive: true })
      writeFileSync(path.join(`${current}.lock`, 'pid'), '4194305\n')
      const release = takeStagingLock(current)
      expect(release).not.toBeNull()
      expect(readFileSync(path.join(`${current}.lock`, 'pid'), 'utf8').trim()).toBe(String(process.pid))
      release()

      /* Killed between the mkdir and the write: a lock with no pid inside. */
      mkdirSync(`${current}.lock`, { recursive: true })
      const second = takeStagingLock(current)
      expect(second).not.toBeNull()
      second()

      /* And our OWN pid is not somebody else — a run that found its own
         abandoned lock would otherwise refuse to do anything, forever. */
      mkdirSync(`${current}.lock`, { recursive: true })
      writeFileSync(path.join(`${current}.lock`, 'pid'), `${process.pid}\n`)
      const third = takeStagingLock(current)
      expect(third).not.toBeNull()
      third()
    } finally {
      done()
    }
  })
})
